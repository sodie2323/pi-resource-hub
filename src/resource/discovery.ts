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
	syncExternalSkillSourcesToPiSettings,
	resolveHomePath,
	DEFAULT_EXTERNAL_SKILL_SOURCES,
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
	promptMetadataByPath: Map<string, { description?: string; argumentHint?: string }>;
};

type ExternalPluginOwner = {
	externalSourceId: string;
	externalPluginId: string;
	externalPluginName: string;
	skillsRoot: string;
};

export async function discoverResources(cwd: string): Promise<ResourceIndex> {
	const caches: DiscoveryCaches = {
		mtimeByPath: new Map(),
		packageDescriptionByPath: new Map(),
		skillDescriptionByPath: new Map(),
		promptMetadataByPath: new Map(),
	};
	const resourceCenterSettings = await readResourceCenterSettings();
	await syncExternalSkillSourcesToPiSettings(resourceCenterSettings.externalSkillSources, resourceCenterSettings.externalSkillSources);
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
	const packageVersions = await buildPackageVersionMap(resolvedPaths, packageInstallPaths, caches);
	const exposedResources = await getExposedResources(cwd);
	const userSettingsFile = await readSettingsFile(getUserSettingsPath());
	const externalPluginOwners = await collectExternalPluginOwners(resourceCenterSettings.externalSkillSources);
	const [projectPackages, userPackages] = await Promise.all([
		buildPackageItems(
			(projectSettings.packages ?? []) as PackageSource[],
			"project",
			packageCounts,
			packageEnabledCounts,
			packageDescriptions,
			packageInstallPaths,
			packageVersions,
			caches,
		),
		buildPackageItems(
			(userSettings.packages ?? []) as PackageSource[],
			"user",
			packageCounts,
			packageEnabledCounts,
			packageDescriptions,
			packageInstallPaths,
			packageVersions,
			caches,
		),
	]);

	const resolvedSkillItems = await mapResolvedResources("skills", resolvedPaths.skills, exposedResources, caches, resourceCenterSettings.externalSkillSources, externalPluginOwners);
	const externalSkillItems = await discoverExternalSkillResources(resourceCenterSettings.externalSkillSources, userSettingsFile, caches, resolvedSkillItems);

	const categories: ResourceIndex["categories"] = {
		packages: sortItems([...projectPackages, ...userPackages]),
		skills: sortItems([...resolvedSkillItems, ...externalSkillItems]),
		extensions: await mapResolvedResources("extensions", resolvedPaths.extensions, exposedResources, caches, resourceCenterSettings.externalSkillSources, externalPluginOwners),
		prompts: await mapResolvedResources("prompts", resolvedPaths.prompts, exposedResources, caches, resourceCenterSettings.externalSkillSources, externalPluginOwners),
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
	packageVersions: Map<string, string>,
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
			const version = packageVersions.get(packageKey);
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
				version,
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
	configuredSources: ExternalSkillSourceSetting[],
	externalPluginOwners: ExternalPluginOwner[],
): Promise<FileResourceItem[]> {
	const items = await Promise.all(
		resources
			.filter((resource) => isSupportedScope(resource.metadata.scope))
			.map((resource) => createFileItem(category, resource, exposedResources, caches, configuredSources, externalPluginOwners)),
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
	configuredSources: ExternalSkillSourceSetting[],
	externalPluginOwners: ExternalPluginOwner[],
): Promise<FileResourceItem> {
	const scope = resource.metadata.scope;
	if (!isSupportedScope(scope)) {
		throw new Error(`Unsupported resource scope: ${scope}`);
	}

	const packageSource = resource.metadata.origin === "package" ? resource.metadata.source : undefined;
	const packageRelativePath = getRelativeResourcePath(resource);
	const promptMetadata = category === "prompts" ? await readPromptMetadata(resource.path, caches) : undefined;
	const pluginOwner = category === "skills" ? inferExternalPluginOwner(resource.path, externalPluginOwners) : undefined;
	const sourceLabel = pluginOwner
		? `codex:${pluginOwner.externalPluginName}`
		: (!packageSource ? inferConfiguredSourceLabel(resource.path, configuredSources) : undefined);
	return {
		category,
		id: `${category}:${scope}:${resource.metadata.origin}:${resource.metadata.source}:${resource.path}`,
		name: inferName(category, resource.path),
		scope,
		path: resource.path,
		source: normalizeSource(resource.metadata),
		sourceLabel,
		description: category === "skills"
			? await readSkillDescription(resource.path, caches) ?? buildResourceDescription(category, scope, resource.metadata, resource.path)
			: category === "prompts"
				? promptMetadata?.description ?? buildResourceDescription(category, scope, resource.metadata, resource.path)
				: buildResourceDescription(category, scope, resource.metadata, resource.path),
		argumentHint: category === "prompts" ? promptMetadata?.argumentHint : undefined,
		enabled: resource.enabled,
		updatedAt: await safeMtimeMs(resource.path, caches),
		managedByPluginSettings: Boolean(pluginOwner),
		externalSourceId: pluginOwner?.externalSourceId,
		externalPluginId: pluginOwner?.externalPluginId,
		externalPluginName: pluginOwner?.externalPluginName,
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

async function collectExternalPluginOwners(sources: ExternalSkillSourceSetting[]): Promise<ExternalPluginOwner[]> {
	const owners: ExternalPluginOwner[] = [];
	for (const source of sources) {
		if (!source.enabled) continue;
		if (source.integration !== "codex-plugin-cache" && source.id !== "codex-plugins") continue;
		const pluginJsonPaths = await collectCodexPluginManifests(resolveHomePath(source.path));
		for (const pluginJsonPath of pluginJsonPaths) {
			const plugin = await readCodexPluginManifest(pluginJsonPath);
			if (!plugin || plugin.hasApps) continue;
			const pluginRoot = dirname(dirname(pluginJsonPath));
			const skillsRoot = resolve(pluginRoot, plugin.skillsPath ?? "skills");
			const skillPaths = await collectSkillPaths(skillsRoot);
			if (skillPaths.length === 0) continue;
			owners.push({
				externalSourceId: source.id,
				externalPluginId: pluginRoot,
				externalPluginName: (plugin.name || plugin.displayName || basename(pluginRoot)).toLowerCase(),
				skillsRoot,
			});
		}
	}
	return owners;
}

function inferExternalPluginOwner(path: string, owners: ExternalPluginOwner[]): ExternalPluginOwner | undefined {
	const normalizedPath = normalizeConfigPath(path).toLowerCase();
	return owners.find((owner) => {
		const rootPath = normalizeConfigPath(owner.skillsRoot).toLowerCase();
		return normalizedPath === rootPath || normalizedPath.startsWith(`${rootPath}/`);
	});
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
		const discoveredSkills = await discoverExternalSkillSourceSkills(source);
		for (const discoveredSkill of discoveredSkills) {
			const skillPath = discoveredSkill.path;
			const normalizedSkillPath = normalizeConfigPath(skillPath);
			if (existingPaths.has(normalizedSkillPath)) continue;
			existingPaths.add(normalizedSkillPath);
			const sourceLabel = discoveredSkill.sourceLabel ?? source.label;
			items.push({
				category: "skills" as const,
				id: `skills:user:plugin:${source.id}:${skillPath}`,
				name: inferName("skills", skillPath),
				scope: "user",
				path: skillPath,
				source: "plugin",
				sourceLabel,
				description: await readSkillDescription(skillPath, caches) ?? discoveredSkill.description ?? `Skill resource in user scope, provided by external source ${sourceLabel}. Path: ${skillPath}`,
				enabled: getPathResourceEnabledState(userSettings, "skills", skillPath) ?? true,
				updatedAt: await safeMtimeMs(skillPath, caches),
				managedByPluginSettings: true,
				externalSourceId: source.id,
				externalPluginId: discoveredSkill.externalPluginId,
				externalPluginName: discoveredSkill.externalPluginName,
			});
		}
	}
	return items;
}

async function discoverExternalSkillSourceSkills(source: ExternalSkillSourceSetting): Promise<Array<{
	path: string;
	sourceLabel?: string;
	description?: string;
	externalPluginId?: string;
	externalPluginName?: string;
}>> {
	if (source.integration !== "codex-plugin-cache" && source.id !== "codex-plugins") {
		return (await collectSkillPaths(resolveHomePath(source.path))).map((path) => ({ path }));
	}
	return discoverCodexPluginSkills(resolveHomePath(source.path), source.label);
}

async function discoverCodexPluginSkills(cacheRoot: string, _sourceLabel: string): Promise<Array<{
	path: string;
	sourceLabel?: string;
	description?: string;
	externalPluginId?: string;
	externalPluginName?: string;
}>> {
	const pluginJsonPaths = await collectCodexPluginManifests(cacheRoot);
	const skills: Array<{
		path: string;
		sourceLabel?: string;
		description?: string;
		externalPluginId?: string;
		externalPluginName?: string;
	}> = [];
	for (const pluginJsonPath of pluginJsonPaths) {
		const plugin = await readCodexPluginManifest(pluginJsonPath);
		if (!plugin || plugin.hasApps) continue;
		const pluginRoot = dirname(dirname(pluginJsonPath));
		const skillsRoot = resolve(pluginRoot, plugin.skillsPath ?? "skills");
		const pluginLabel = plugin.displayName || plugin.name || basename(pluginRoot);
		const pluginSourceName = (plugin.name || plugin.displayName || basename(pluginRoot)).toLowerCase();
		for (const path of await collectSkillPaths(skillsRoot)) {
			skills.push({
				path,
				sourceLabel: `codex:${pluginSourceName}`,
				externalPluginId: pluginRoot,
				externalPluginName: pluginLabel,
				description: plugin.shortDescription || plugin.description
					? `Codex plugin skill from ${pluginLabel}. ${plugin.shortDescription ?? plugin.description}`
					: `Codex plugin skill from ${pluginLabel}.`,
			});
		}
	}
	return skills;
}

async function collectCodexPluginManifests(root: string): Promise<string[]> {
	const manifests: string[] = [];
	await walkDirectory(root, async (path, isDirectory) => {
		if (!isDirectory) return false;
		if (!path.endsWith(".codex-plugin")) return undefined;
		const pluginJsonPath = resolve(path, "plugin.json");
		try {
			const info = await stat(pluginJsonPath);
			if (info.isFile()) manifests.push(pluginJsonPath);
		} catch {
			// ignore malformed plugin folders
		}
		return false;
	});
	return manifests;
}

async function walkDirectory(root: string, visit: (path: string, isDirectory: boolean) => Promise<boolean | void>): Promise<void> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const entryPath = resolve(root, entry.name);
		const shouldContinue = await visit(entryPath, entry.isDirectory());
		if (entry.isDirectory() && shouldContinue !== false) await walkDirectory(entryPath, visit);
	}
}

async function readCodexPluginManifest(path: string): Promise<{
	name?: string;
	displayName?: string;
	description?: string;
	shortDescription?: string;
	skillsPath?: string;
	hasApps: boolean;
} | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as {
			name?: unknown;
			description?: unknown;
			skills?: unknown;
			apps?: unknown;
			interface?: { displayName?: unknown; shortDescription?: unknown };
		};
		return {
			name: typeof parsed.name === "string" ? parsed.name : undefined,
			displayName: typeof parsed.interface?.displayName === "string" ? parsed.interface.displayName : undefined,
			description: typeof parsed.description === "string" ? parsed.description : undefined,
			shortDescription: typeof parsed.interface?.shortDescription === "string" ? parsed.interface.shortDescription : undefined,
			skillsPath: typeof parsed.skills === "string" && parsed.skills.trim() ? parsed.skills : undefined,
			hasApps: parsed.apps !== undefined,
		};
	} catch {
		return undefined;
	}
}

async function collectSkillPaths(path: string): Promise<string[]> {
	try {
		const info = await stat(path);
		if (info.isFile()) {
			return extname(path).toLowerCase() === ".md" ? [path] : [];
		}
		if (!info.isDirectory()) return [];
		const found = new Set<string>();
		await walkSkillDirectory(path, found, true);
		return Array.from(found);
	} catch {
		return [];
	}
}

async function walkSkillDirectory(dir: string, found: Set<string>, includeRootFiles: boolean): Promise<void> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (entry.name === "SKILL.md") {
			const entryPath = resolve(dir, entry.name);
			if (entry.isFile()) found.add(entryPath);
			return;
		}
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.name === "node_modules") continue;
		const entryPath = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			await walkSkillDirectory(entryPath, found, false);
			continue;
		}
		if (!entry.isFile()) continue;
		if (includeRootFiles && entry.name.endsWith(".md")) found.add(entryPath);
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

async function buildPackageVersionMap(
	resolvedPaths: ResolvedPaths,
	packageInstallPaths: Map<string, string>,
	caches: DiscoveryCaches,
): Promise<Map<string, string>> {
	const versions = new Map<string, string>();
	await Promise.all(
		Array.from(packageInstallPaths.entries()).map(async ([key, installPath]) => {
			const version = await readPackageVersion(resolve(installPath, "package.json"), caches);
			if (version) versions.set(key, version);
		}),
	);
	return versions;
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

async function readPackageVersion(packageJsonPath: string, caches: DiscoveryCaches): Promise<string | undefined> {
	try {
		const raw = await readFile(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : undefined;
	} catch {
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

function inferConfiguredSourceLabel(path: string, configuredSources: ExternalSkillSourceSetting[]): string | undefined {
	const normalizedPath = normalizeConfigPath(path).toLowerCase();
	for (const source of configuredSources) {
		const rootPath = normalizeConfigPath(resolveHomePath(source.path)).toLowerCase();
		if (normalizedPath === rootPath || normalizedPath.startsWith(`${rootPath}/`)) return formatExternalSourceLabel(source);
	}
	for (const source of DEFAULT_EXTERNAL_SKILL_SOURCES) {
		const rootPath = normalizeConfigPath(resolveHomePath(source.path)).toLowerCase();
		if (normalizedPath === rootPath || normalizedPath.startsWith(`${rootPath}/`)) return formatExternalSourceLabel(source);
	}
	return undefined;
}

function formatExternalSourceLabel(source: ExternalSkillSourceSetting): string {
	if (source.id === "codex") return "codex:skills";
	return source.label;
}

function normalizeSource(metadata: PathMetadata): string {
	if (metadata.origin === "package") return metadata.source;
	return metadata.source === "auto" ? "convention" : "manual";
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

async function readPromptMetadata(path: string, caches: DiscoveryCaches): Promise<{ description?: string; argumentHint?: string } | undefined> {
	if (caches.promptMetadataByPath.has(path)) {
		return caches.promptMetadataByPath.get(path);
	}
	try {
		const raw = await readFile(path, "utf8");
		const { frontmatter } = parseFrontmatter<{ description?: string; "argument-hint"?: string }>(raw);
		const metadata = {
			description: typeof frontmatter.description === "string" && frontmatter.description.trim() ? frontmatter.description.trim() : undefined,
			argumentHint: typeof frontmatter["argument-hint"] === "string" && frontmatter["argument-hint"].trim()
				? frontmatter["argument-hint"].trim()
				: undefined,
		};
		caches.promptMetadataByPath.set(path, metadata);
		return metadata;
	} catch {
		caches.promptMetadataByPath.set(path, {});
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
