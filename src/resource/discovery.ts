/**
 * 发现并构建资源索引，包括 package、extensions、skills、prompts 和 themes。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import {
	DefaultPackageManager,
	SettingsManager,
	parseFrontmatter,
	type PathMetadata,
	type ResolvedPaths,
	type ResolvedResource,
} from "@mariozechner/pi-coding-agent";
import {
	getExposedResources,
	isPackageSourceEnabled,
	getPathResourceEnabledState,
	getUserSettingsPath,
	readResourceCenterSettings,
	readSettingsFile,
	resolveHomePath,
	syncPrunedExposedResources,
	type ExternalSkillSourceSetting,
	type PackageSource,
	type SettingsFile,
	USER_AGENT_DIR,
} from "../settings.js";
import { getPackageKey, getPackageResourceId } from "./identity.js";
import type {
	FileResourceItem,
	PackageEnabledSummary,
	PackageResourceCounts,
	ResourceCategory,
	ResourceIndex,
	ResourceItem,
	ResourceScope,
	ThemeResourceItem,
} from "../types.js";
import { isRemotePackageSource } from "../types.js";

const RESOURCE_CATEGORIES: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];

type DiscoveryCaches = {
	mtimeByPath: Map<string, number | undefined>;
	packageDescriptionByPath: Map<string, string | undefined>;
	skillDescriptionByPath: Map<string, string | undefined>;
};

export async function discoverResources(cwd: string): Promise<ResourceIndex> {
	const caches: DiscoveryCaches = {
		mtimeByPath: new Map(),
		packageDescriptionByPath: new Map(),
		skillDescriptionByPath: new Map(),
	};
	const settingsManager = SettingsManager.create(cwd, USER_AGENT_DIR);
	const packageManager = new DefaultPackageManager({ cwd, agentDir: USER_AGENT_DIR, settingsManager });
	const resolvedPaths = await packageManager.resolve();
	const projectSettings = settingsManager.getProjectSettings();
	const userSettings = settingsManager.getGlobalSettings();
	const selectedTheme = projectSettings.theme ?? userSettings.theme;
	const packageCounts = buildPackageCountMap(resolvedPaths);
	const packageEnabledCounts = buildPackageEnabledSummaryMap(resolvedPaths, selectedTheme);
	const packageDescriptions = await buildPackageDescriptionMap(resolvedPaths, caches);
	const packageInstallPaths = buildPackageInstallPathMap(resolvedPaths);
	const exposedResources = await getExposedResources(cwd);
	const resourceCenterSettings = await readResourceCenterSettings();
	const userSettingsFile = await readSettingsFile(getUserSettingsPath());
	const [projectPackages, userPackages] = await Promise.all([
		buildPackageItems(
			(projectSettings.packages ?? []) as PackageSource[],
			"project",
			packageCounts,
			packageEnabledCounts,
			packageDescriptions,
			packageInstallPaths,
			caches,
		),
		buildPackageItems(
			(userSettings.packages ?? []) as PackageSource[],
			"user",
			packageCounts,
			packageEnabledCounts,
			packageDescriptions,
			packageInstallPaths,
			caches,
		),
	]);

	const resolvedSkillItems = await mapResolvedResources("skills", resolvedPaths.skills, exposedResources, caches);
	const externalSkillItems = await discoverExternalSkillResources(resourceCenterSettings.externalSkillSources, userSettingsFile, caches, resolvedSkillItems);

	const categories: ResourceIndex["categories"] = {
		packages: sortItems([...projectPackages, ...userPackages]),
		skills: sortItems([...resolvedSkillItems, ...externalSkillItems]),
		extensions: await mapResolvedResources("extensions", resolvedPaths.extensions, exposedResources, caches),
		prompts: await mapResolvedResources("prompts", resolvedPaths.prompts, exposedResources, caches),
		themes: await buildThemeItems(resolvedPaths.themes, selectedTheme, caches),
	};

	const index = { categories };
	await syncPrunedExposedResources(index);
	return index;
}

async function buildPackageItems(
	packages: PackageSource[],
	scope: ResourceScope,
	counts: Map<string, PackageResourceCounts>,
	enabledSummaries: Map<string, PackageEnabledSummary>,
	packageDescriptions: Map<string, string>,
	packageInstallPaths: Map<string, string>,
	caches: DiscoveryCaches,
): Promise<ResourceItem[]> {
	const items = await Promise.all(
		packages.map(async (source) => {
			const spec = typeof source === "string" ? source : source.source;
			const packageKey = getPackageKey(scope, spec);
			const packageCounts = counts.get(packageKey);
			const enabledSummary = enabledSummaries.get(packageKey);
			const packageDescription = packageDescriptions.get(packageKey);
			const installPath = packageInstallPaths.get(packageKey);
			return {
				category: "packages" as const,
				id: getPackageResourceId(scope, spec),
				name: spec,
				scope,
				source: spec,
				description:
					packageDescription ??
					"No package description found. Add a `description` field to this package's package.json.",
				enabled: isPackageSourceEnabled(source),
				updatedAt: await inferUpdatedAtFromPackage(spec, installPath, caches),
				counts: packageCounts,
				enabledSummary,
				installPath,
			};
		}),
	);
	return sortItems(items);
}

async function mapResolvedResources<TCategory extends Exclude<ResourceCategory, "packages" | "themes">>(
	category: TCategory,
	resources: ResolvedResource[],
	exposedResources: Array<{ scope: ResourceScope; category: Exclude<ResourceCategory, "packages" | "themes">; package: string; path: string }>,
	caches: DiscoveryCaches,
): Promise<FileResourceItem[]> {
	const items = await Promise.all(
		resources
			.filter((resource) => isSupportedScope(resource.metadata.scope))
			.map((resource) => createFileItem(category, resource, exposedResources, caches)),
	);
	return sortItems(items);
}

async function buildThemeItems(resources: ResolvedResource[], selectedTheme: string | undefined, caches: DiscoveryCaches): Promise<ThemeResourceItem[]> {
	const items = await Promise.all(
		resources
			.filter((resource) => isSupportedScope(resource.metadata.scope))
			.map((resource) => createThemeItem(resource, selectedTheme, caches)),
	);

	for (const name of ["dark", "light"] as const) {
		items.push({
			category: "themes",
			id: `themes:user:builtin:${name}`,
			name,
			scope: "user",
			source: "builtin",
			description: `Built-in Pi theme: ${name}`,
			enabled: name === selectedTheme,
			builtin: true,
			updatedAt: 0,
		});
	}

	return sortItems(items);
}

async function createFileItem(
	category: Exclude<ResourceCategory, "packages" | "themes">,
	resource: ResolvedResource,
	exposedResources: Array<{ scope: ResourceScope; category: Exclude<ResourceCategory, "packages" | "themes">; package: string; path: string }>,
	caches: DiscoveryCaches,
): Promise<FileResourceItem> {
	const scope = resource.metadata.scope;
	if (!isSupportedScope(scope)) {
		throw new Error(`Unsupported resource scope: ${scope}`);
	}

	const packageSource = resource.metadata.origin === "package" ? resource.metadata.source : undefined;
	const packageRelativePath = getRelativeResourcePath(resource);
	return {
		category,
		id: `${category}:${scope}:${resource.metadata.origin}:${resource.metadata.source}:${resource.path}`,
		name: inferName(category, resource.path),
		scope,
		path: resource.path,
		source: normalizeSource(resource.metadata),
		description: category === "skills"
			? await readSkillDescription(resource.path, caches) ?? buildResourceDescription(category, scope, resource.metadata, resource.path)
			: buildResourceDescription(category, scope, resource.metadata, resource.path),
		enabled: resource.enabled,
		updatedAt: await safeMtimeMs(resource.path, caches),
		packageSource,
		packageRelativePath,
		exposed: Boolean(
			packageSource &&
			packageRelativePath &&
			exposedResources.some(
				(entry) =>
					entry.scope === scope &&
					entry.category === category &&
					entry.package === packageSource &&
					normalizeConfigPath(entry.path) === normalizeConfigPath(packageRelativePath),
			),
		),
	};
}

async function createThemeItem(resource: ResolvedResource, selectedTheme: string | undefined, caches: DiscoveryCaches): Promise<ThemeResourceItem> {
	const scope = resource.metadata.scope;
	if (!isSupportedScope(scope)) {
		throw new Error(`Unsupported resource scope: ${scope}`);
	}

	const name = basename(resource.path, extname(resource.path));
	return {
		category: "themes" as const,
		id: `themes:${scope}:${resource.metadata.origin}:${resource.metadata.source}:${resource.path}`,
		name,
		scope,
		source: normalizeSource(resource.metadata),
		description: buildResourceDescription("themes", scope, resource.metadata, resource.path),
		enabled: name === selectedTheme,
		updatedAt: await safeMtimeMs(resource.path, caches),
		path: resource.path,
		packageSource: resource.metadata.origin === "package" ? resource.metadata.source : undefined,
		packageRelativePath: getRelativeResourcePath(resource),
	};
}

async function discoverExternalSkillResources(
	sources: ExternalSkillSourceSetting[],
	userSettings: SettingsFile | undefined,
	caches: DiscoveryCaches,
	existingItems: FileResourceItem[],
): Promise<FileResourceItem[]> {
	const existingPaths = new Set(existingItems.map((item) => normalizeConfigPath(item.path)));
	const items: FileResourceItem[] = [];
	for (const source of sources) {
		if (!source.enabled) continue;
		const rootPath = resolveHomePath(source.path);
		const skillPaths = await collectSkillPaths(rootPath);
		for (const skillPath of skillPaths) {
			const normalizedSkillPath = normalizeConfigPath(skillPath);
			if (existingPaths.has(normalizedSkillPath)) continue;
			existingPaths.add(normalizedSkillPath);
			items.push({
				category: "skills" as const,
				id: `skills:user:plugin:${source.id}:${skillPath}`,
				name: inferName("skills", skillPath),
				scope: "user",
				path: skillPath,
				source: "plugin",
				sourceLabel: source.label,
				description: await readSkillDescription(skillPath, caches) ?? `Skill resource in user scope, provided by external source ${source.label}. Path: ${skillPath}`,
				enabled: getPathResourceEnabledState(userSettings, "skills", skillPath) ?? true,
				updatedAt: await safeMtimeMs(skillPath, caches),
				managedByPluginSettings: true,
				externalSourceId: source.id,
			});
		}
	}
	return items;
}

async function collectSkillPaths(path: string): Promise<string[]> {
	try {
		const info = await stat(path);
		if (info.isFile()) {
			return extname(path).toLowerCase() === ".md" ? [path] : [];
		}
		if (!info.isDirectory()) return [];
		const found = new Set<string>();
		await walkSkillDirectory(path, found);
		return Array.from(found);
	} catch {
		return [];
	}
}

async function walkSkillDirectory(dir: string, found: Set<string>): Promise<void> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryPath = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			await walkSkillDirectory(entryPath, found);
			continue;
		}
		if (!entry.isFile()) continue;
		if (entry.name === "SKILL.md") {
			found.add(entryPath);
		}
	}
}

function buildPackageCountMap(resolvedPaths: ResolvedPaths): Map<string, PackageResourceCounts> {
	const counts = new Map<string, PackageResourceCounts>();
	for (const category of RESOURCE_CATEGORIES) {
		if (category === "packages") continue;
		for (const resource of resolvedPaths[category]) {
			if (resource.metadata.origin !== "package" || !isSupportedScope(resource.metadata.scope)) continue;
			const key = getPackageKey(resource.metadata.scope, resource.metadata.source);
			const current = counts.get(key) ?? { extensions: 0, skills: 0, prompts: 0, themes: 0 };
			current[category] += 1;
			counts.set(key, current);
		}
	}
	return counts;
}

function buildPackageEnabledSummaryMap(
	resolvedPaths: ResolvedPaths,
	selectedTheme: string | undefined,
): Map<string, PackageEnabledSummary> {
	const summaries = new Map<string, PackageEnabledSummary>();
	for (const category of RESOURCE_CATEGORIES) {
		if (category === "packages") continue;
		for (const resource of resolvedPaths[category]) {
			if (resource.metadata.origin !== "package" || !isSupportedScope(resource.metadata.scope)) continue;
			const key = getPackageKey(resource.metadata.scope, resource.metadata.source);
			const current = summaries.get(key) ?? { enabledCount: 0, totalCount: 0 };
			current.totalCount += 1;
			const isEnabled = category === "themes"
				? basename(resource.path, extname(resource.path)) === selectedTheme
				: resource.enabled;
			if (isEnabled) {
				current.enabledCount += 1;
			}
			summaries.set(key, current);
		}
	}
	return summaries;
}

function buildPackageInstallPathMap(resolvedPaths: ResolvedPaths): Map<string, string> {
	const installPaths = new Map<string, string>();
	for (const category of RESOURCE_CATEGORIES) {
		if (category === "packages") continue;
		for (const resource of resolvedPaths[category]) {
			if (resource.metadata.origin !== "package" || !isSupportedScope(resource.metadata.scope) || !resource.metadata.baseDir) continue;
			installPaths.set(getPackageKey(resource.metadata.scope, resource.metadata.source), resource.metadata.baseDir);
		}
	}
	return installPaths;
}

async function buildPackageDescriptionMap(resolvedPaths: ResolvedPaths, caches: DiscoveryCaches): Promise<Map<string, string>> {
	const packageDirs = new Map<string, string>();
	for (const category of RESOURCE_CATEGORIES) {
		if (category === "packages") continue;
		for (const resource of resolvedPaths[category]) {
			if (resource.metadata.origin !== "package" || !isSupportedScope(resource.metadata.scope) || !resource.metadata.baseDir) continue;
			packageDirs.set(getPackageKey(resource.metadata.scope, resource.metadata.source), resource.metadata.baseDir);
		}
	}

	const descriptions = new Map<string, string>();
	await Promise.all(
		Array.from(packageDirs.entries()).map(async ([key, baseDir]) => {
			const description = await readPackageDescription(resolve(baseDir, "package.json"), caches);
			if (description) descriptions.set(key, description);
		}),
	);
	return descriptions;
}

async function readPackageDescription(packageJsonPath: string, caches: DiscoveryCaches): Promise<string | undefined> {
	if (caches.packageDescriptionByPath.has(packageJsonPath)) {
		return caches.packageDescriptionByPath.get(packageJsonPath);
	}
	try {
		const raw = await readFile(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { description?: unknown };
		const description = typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : undefined;
		caches.packageDescriptionByPath.set(packageJsonPath, description);
		return description;
	} catch {
		caches.packageDescriptionByPath.set(packageJsonPath, undefined);
		return undefined;
	}
}

function getRelativeResourcePath(resource: ResolvedResource): string | undefined {
	const baseDir = resource.metadata.baseDir;
	return baseDir ? relative(baseDir, resource.path).replace(/\\/g, "/") : undefined;
}

function normalizeConfigPath(value: string): string {
	return value.replace(/^[+\-!]/, "").replace(/\\/g, "/");
}

function normalizeSource(metadata: PathMetadata): string {
	if (metadata.origin === "package") return metadata.source;
	return metadata.source === "auto" ? "convention" : "settings";
}

function isSupportedScope(scope: PathMetadata["scope"]): scope is ResourceScope {
	return scope === "project" || scope === "user";
}

function inferName(category: Exclude<ResourceCategory, "packages" | "themes">, path: string): string {
	if (category === "skills" && basename(path) === "SKILL.md") {
		return basename(dirname(path));
	}
	if (category === "extensions") {
		const fileName = basename(path);
		const parentFolder = basename(dirname(path));
		if (parentFolder !== "extensions" && (fileName === "index.ts" || fileName === "index.js")) {
			return `${parentFolder}/${fileName}`;
		}
	}
	return basename(path);
}

async function readSkillDescription(path: string, caches: DiscoveryCaches): Promise<string | undefined> {
	if (caches.skillDescriptionByPath.has(path)) {
		return caches.skillDescriptionByPath.get(path);
	}
	try {
		const raw = await readFile(path, "utf8");
		const { frontmatter } = parseFrontmatter<{ description?: string }>(raw);
		const description = typeof frontmatter.description === "string" && frontmatter.description.trim() ? frontmatter.description.trim() : undefined;
		caches.skillDescriptionByPath.set(path, description);
		return description;
	} catch {
		caches.skillDescriptionByPath.set(path, undefined);
		return undefined;
	}
}

function buildResourceDescription(
	category: Exclude<ResourceCategory, "packages">,
	scope: ResourceScope,
	metadata: PathMetadata,
	path: string,
): string {
	const categoryText =
		category === "extensions"
			? "Extension resource"
			: category === "skills"
				? "Skill resource"
				: category === "prompts"
					? "Prompt resource"
					: "Theme resource";
	const location = scope === "project" ? "project" : "user";
	const origin = metadata.origin === "package" ? `provided by package ${metadata.source}` : `${normalizeSource(metadata)} path`;
	return `${categoryText} in ${location} scope, ${origin}. Path: ${path}`;
}

async function safeMtimeMs(path: string | undefined, caches: DiscoveryCaches): Promise<number | undefined> {
	if (!path) return undefined;
	if (caches.mtimeByPath.has(path)) {
		return caches.mtimeByPath.get(path);
	}
	try {
		const info = await stat(path);
		caches.mtimeByPath.set(path, info.mtimeMs);
		return info.mtimeMs;
	} catch {
		caches.mtimeByPath.set(path, undefined);
		return undefined;
	}
}

async function inferUpdatedAtFromPackage(spec: string, installPath: string | undefined, caches: DiscoveryCaches): Promise<number | undefined> {
	// Prefer installed package's package.json mtime, then the directory mtime.
	if (installPath) {
		const pkgJsonTime = await safeMtimeMs(resolve(installPath, "package.json"), caches);
		if (pkgJsonTime !== undefined) return pkgJsonTime;
		const dirTime = await safeMtimeMs(installPath, caches);
		if (dirTime !== undefined) return dirTime;
	}

	// If the spec is a local path, try to stat it directly.
	if (!isRemotePackageSource(spec)) {
		const normalized = spec.replace(/[\\/]+$/, "");
		const pkgJsonTime = await safeMtimeMs(resolve(normalized, "package.json"), caches);
		if (pkgJsonTime !== undefined) return pkgJsonTime;
		const dirTime = await safeMtimeMs(normalized, caches);
		if (dirTime !== undefined) return dirTime;
	}

	return undefined;
}

function sortItems<T extends ResourceItem>(items: T[]): T[] {
	return items.sort((a, b) => {
		if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}
