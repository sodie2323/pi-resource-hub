import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import {
	DefaultPackageManager,
	SettingsManager,
	type PathMetadata,
	type ResolvedPaths,
	type ResolvedResource,
} from "@mariozechner/pi-coding-agent";
import { getExposedResources, isPackageSourceEnabled, type PackageSource, USER_AGENT_DIR } from "./settings.js";
import type {
	FileResourceItem,
	PackageEnabledSummary,
	PackageResourceCounts,
	ResourceCategory,
	ResourceIndex,
	ResourceItem,
	ResourceScope,
	ThemeResourceItem,
} from "./types.js";

const RESOURCE_CATEGORIES: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];

export async function discoverResources(cwd: string): Promise<ResourceIndex> {
	const settingsManager = SettingsManager.create(cwd, USER_AGENT_DIR);
	const packageManager = new DefaultPackageManager({ cwd, agentDir: USER_AGENT_DIR, settingsManager });
	const resolvedPaths = await packageManager.resolve();
	const projectSettings = settingsManager.getProjectSettings();
	const userSettings = settingsManager.getGlobalSettings();
	const selectedTheme = projectSettings.theme ?? userSettings.theme;
	const packageCounts = buildPackageCountMap(resolvedPaths);
	const packageEnabledCounts = buildPackageEnabledSummaryMap(resolvedPaths, selectedTheme);
	const packageDescriptions = await buildPackageDescriptionMap(resolvedPaths);
	const packageInstallPaths = buildPackageInstallPathMap(resolvedPaths);
	const exposedResources = await getExposedResources(cwd);
	const [projectPackages, userPackages] = await Promise.all([
		buildPackageItems(
			(projectSettings.packages ?? []) as PackageSource[],
			"project",
			packageCounts,
			packageEnabledCounts,
			packageDescriptions,
			packageInstallPaths,
		),
		buildPackageItems(
			(userSettings.packages ?? []) as PackageSource[],
			"user",
			packageCounts,
			packageEnabledCounts,
			packageDescriptions,
			packageInstallPaths,
		),
	]);

	const categories: ResourceIndex["categories"] = {
		packages: sortItems([...projectPackages, ...userPackages]),
		skills: mapResolvedResources("skills", resolvedPaths.skills, exposedResources),
		extensions: mapResolvedResources("extensions", resolvedPaths.extensions, exposedResources),
		prompts: mapResolvedResources("prompts", resolvedPaths.prompts, exposedResources),
		themes: buildThemeItems(resolvedPaths.themes, selectedTheme),
	};

	return { categories };
}

async function buildPackageItems(
	packages: PackageSource[],
	scope: ResourceScope,
	counts: Map<string, PackageResourceCounts>,
	enabledSummaries: Map<string, PackageEnabledSummary>,
	packageDescriptions: Map<string, string>,
	packageInstallPaths: Map<string, string>,
): Promise<ResourceItem[]> {
	return sortItems(
		packages.map((source) => {
			const spec = typeof source === "string" ? source : source.source;
			const packageCounts = counts.get(toPackageKey(scope, spec));
			const enabledSummary = enabledSummaries.get(toPackageKey(scope, spec));
			const packageDescription = packageDescriptions.get(toPackageKey(scope, spec));
			const installPath = packageInstallPaths.get(toPackageKey(scope, spec));
			return {
				category: "packages",
				id: `packages:${scope}:${spec}`,
				name: spec,
				scope,
				source: spec,
				description:
					packageDescription ??
					"No package description found. Add a `description` field to this package's package.json.",
				enabled: isPackageSourceEnabled(source),
				counts: packageCounts,
				enabledSummary,
				installPath,
			};
		}),
	);
}

function mapResolvedResources<TCategory extends Exclude<ResourceCategory, "packages" | "themes">>(
	category: TCategory,
	resources: ResolvedResource[],
	exposedResources: Array<{ scope: ResourceScope; category: Exclude<ResourceCategory, "packages" | "themes">; package: string; path: string }>,
): FileResourceItem[] {
	return sortItems(
		resources
			.filter((resource) => isSupportedScope(resource.metadata.scope))
			.map((resource) => createFileItem(category, resource, exposedResources)),
	);
}

function buildThemeItems(resources: ResolvedResource[], selectedTheme: string | undefined): ThemeResourceItem[] {
	const items = resources
		.filter((resource) => isSupportedScope(resource.metadata.scope))
		.map((resource) => createThemeItem(resource, selectedTheme));

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
		});
	}

	return sortItems(items);
}

function createFileItem(
	category: Exclude<ResourceCategory, "packages" | "themes">,
	resource: ResolvedResource,
	exposedResources: Array<{ scope: ResourceScope; category: Exclude<ResourceCategory, "packages" | "themes">; package: string; path: string }>,
): FileResourceItem {
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
		description: buildResourceDescription(category, scope, resource.metadata, resource.path),
		enabled: resource.enabled,
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

function createThemeItem(resource: ResolvedResource, selectedTheme: string | undefined): ThemeResourceItem {
	const scope = resource.metadata.scope;
	if (!isSupportedScope(scope)) {
		throw new Error(`Unsupported resource scope: ${scope}`);
	}

	const name = basename(resource.path, extname(resource.path));
	return {
		category: "themes",
		id: `themes:${scope}:${resource.metadata.origin}:${resource.metadata.source}:${resource.path}`,
		name,
		scope,
		source: normalizeSource(resource.metadata),
		description: buildResourceDescription("themes", scope, resource.metadata, resource.path),
		enabled: name === selectedTheme,
		path: resource.path,
		packageSource: resource.metadata.origin === "package" ? resource.metadata.source : undefined,
		packageRelativePath: getRelativeResourcePath(resource),
	};
}

function buildPackageCountMap(resolvedPaths: ResolvedPaths): Map<string, PackageResourceCounts> {
	const counts = new Map<string, PackageResourceCounts>();
	for (const category of RESOURCE_CATEGORIES) {
		if (category === "packages") continue;
		for (const resource of resolvedPaths[category]) {
			if (resource.metadata.origin !== "package" || !isSupportedScope(resource.metadata.scope)) continue;
			const key = toPackageKey(resource.metadata.scope, resource.metadata.source);
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
			const key = toPackageKey(resource.metadata.scope, resource.metadata.source);
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
			installPaths.set(toPackageKey(resource.metadata.scope, resource.metadata.source), resource.metadata.baseDir);
		}
	}
	return installPaths;
}

async function buildPackageDescriptionMap(resolvedPaths: ResolvedPaths): Promise<Map<string, string>> {
	const packageDirs = new Map<string, string>();
	for (const category of RESOURCE_CATEGORIES) {
		if (category === "packages") continue;
		for (const resource of resolvedPaths[category]) {
			if (resource.metadata.origin !== "package" || !isSupportedScope(resource.metadata.scope) || !resource.metadata.baseDir) continue;
			packageDirs.set(toPackageKey(resource.metadata.scope, resource.metadata.source), resource.metadata.baseDir);
		}
	}

	const descriptions = new Map<string, string>();
	await Promise.all(
		Array.from(packageDirs.entries()).map(async ([key, baseDir]) => {
			const description = await readPackageDescription(resolve(baseDir, "package.json"));
			if (description) descriptions.set(key, description);
		}),
	);
	return descriptions;
}

async function readPackageDescription(packageJsonPath: string): Promise<string | undefined> {
	try {
		const raw = await readFile(packageJsonPath, "utf8");
		const parsed = JSON.parse(raw) as { description?: unknown };
		return typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : undefined;
	} catch {
		return undefined;
	}
}

function getRelativeResourcePath(resource: ResolvedResource): string | undefined {
	const baseDir = resource.metadata.baseDir;
	return baseDir ? relative(baseDir, resource.path).replace(/\\/g, "/") : undefined;
}

function toPackageKey(scope: ResourceScope, source: string): string {
	return `${scope}:${source}`;
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

function sortItems<T extends ResourceItem>(items: T[]): T[] {
	return items.sort((a, b) => {
		if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}
