import { access, readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { PackageSource, SettingsFile } from "./settings.js";
import {
	getPackageSources,
	getProjectSettingsPath,
	getSelectedTheme,
	getSettingPaths,
	getUserSettingsPath,
	isPackageSourceEnabled,
	PROJECT_AGENT_DIR,
	readSettingsFile,
	USER_AGENT_DIR,
} from "./settings.js";
import {
	isRemotePackageSource,
	type FileResourceItem,
	type ResourceCategory,
	type ResourceIndex,
	type ResourceItem,
	type ResourceScope,
	type ThemeResourceItem,
} from "./types.js";

interface DiscoveryContext {
	cwd: string;
	projectSettings: SettingsFile | undefined;
	userSettings: SettingsFile | undefined;
}

const RESOURCE_CATEGORIES: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];

export async function discoverResources(cwd: string): Promise<ResourceIndex> {
	const projectSettings = await readSettingsFile(getProjectSettingsPath(cwd));
	const userSettings = await readSettingsFile(getUserSettingsPath());
	const context: DiscoveryContext = { cwd, projectSettings, userSettings };

	const categories: ResourceIndex["categories"] = {
		packages: [],
		skills: [],
		extensions: [],
		prompts: [],
		themes: [],
	};

	const discovered = await Promise.all(RESOURCE_CATEGORIES.map(async (category) => [category, await discoverCategory(category, context)] as const));
	for (const [category, items] of discovered) {
		categories[category] = items;
	}

	return { categories };
}

async function discoverCategory(category: ResourceCategory, context: DiscoveryContext): Promise<ResourceItem[]> {
	if (category === "packages") {
		return discoverPackages(context);
	}
	if (category === "themes") {
		return discoverThemes(context);
	}

	const items = new Map<string, FileResourceItem>();
	const projectBase = resolve(context.cwd, PROJECT_AGENT_DIR, category);
	const userBase = resolve(USER_AGENT_DIR, category);

	const [projectItems, userItems] = await Promise.all([
		discoverConventionalResources(category, projectBase, "project", "convention"),
		discoverConventionalResources(category, userBase, "user", "convention"),
	]);
	for (const item of projectItems) {
		items.set(item.id, item);
	}
	for (const item of userItems) {
		items.set(item.id, item);
	}
	for (const path of getSettingPaths(context.projectSettings, category)) {
		const item = createFileItem(category, path, "project", "settings");
		items.set(item.id, item);
	}
	for (const path of getSettingPaths(context.userSettings, category)) {
		const item = createFileItem(category, path, "user", "settings");
		items.set(item.id, item);
	}

	return sortItems(Array.from(items.values()));
}

async function discoverThemes(context: DiscoveryContext): Promise<ResourceItem[]> {
	const selectedTheme = getSelectedTheme(context.projectSettings, context.userSettings);
	const items = new Map<string, ThemeResourceItem>();
	const projectBase = resolve(context.cwd, PROJECT_AGENT_DIR, "themes");
	const userBase = resolve(USER_AGENT_DIR, "themes");

	for (const themeName of ["dark", "light"] as const) {
		const item = createBuiltinThemeItem(themeName, selectedTheme);
		items.set(item.id, item);
	}

	const [projectItems, userItems] = await Promise.all([
		discoverThemeFiles(projectBase, "project", "convention", selectedTheme),
		discoverThemeFiles(userBase, "user", "convention", selectedTheme),
	]);
	for (const item of projectItems) {
		items.set(item.id, item);
	}
	for (const item of userItems) {
		items.set(item.id, item);
	}
	for (const path of getSettingPaths(context.projectSettings, "themes")) {
		const item = createThemeItem(path, "project", "settings", selectedTheme);
		items.set(item.id, item);
	}
	for (const path of getSettingPaths(context.userSettings, "themes")) {
		const item = createThemeItem(path, "user", "settings", selectedTheme);
		items.set(item.id, item);
	}

	return sortItems(Array.from(items.values()));
}

async function discoverPackages(context: DiscoveryContext): Promise<ResourceItem[]> {
	const items = await Promise.all([
		...getPackageSources(context.projectSettings).map((source) => createPackageItem(source, "project", context)),
		...getPackageSources(context.userSettings).map((source) => createPackageItem(source, "user", context)),
	]);
	return sortItems(items);
}

async function createPackageItem(
	source: PackageSource,
	scope: ResourceScope,
	context: DiscoveryContext,
): Promise<ResourceItem> {
	const spec = typeof source === "string" ? source : source.source;
	const packageDir = resolvePackageDir(spec, scope, context);
	const counts = packageDir ? await discoverPackageCounts(packageDir) : undefined;
	const sourceKind = spec.startsWith("npm:") ? "npm package" : isRemotePackageSource(spec) ? "git package" : "local package";
	const countText = counts
		? ` Contains ${counts.extensions} extensions, ${counts.skills} skills, ${counts.prompts} prompts, and ${counts.themes} themes.`
		: "";
	return {
		category: "packages",
		id: `packages:${scope}:${spec}`,
		name: spec,
		scope,
		source: spec,
		description: `${scope === "project" ? "Project" : "User"} ${sourceKind}.${countText}`,
		enabled: isPackageSourceEnabled(source),
		counts,
	};
}

function resolvePackageDir(spec: string, scope: ResourceScope, context: DiscoveryContext): string | undefined {
	if (isRemotePackageSource(spec)) {
		return undefined;
	}
	if (isAbsolute(spec)) return spec;
	const baseDir = scope === "project" ? context.cwd : USER_AGENT_DIR;
	return resolve(baseDir, spec);
}

async function discoverPackageCounts(packageDir: string) {
	const [extensions, skills, prompts, themes] = await Promise.all([
		discoverConventionalResources("extensions", resolve(packageDir, "extensions"), "project", "package"),
		discoverConventionalResources("skills", resolve(packageDir, "skills"), "project", "package"),
		discoverFlatFiles(resolve(packageDir, "prompts"), "project", "package", "prompts", ".md"),
		discoverThemeFiles(resolve(packageDir, "themes"), "project", "package", undefined),
	]);

	return {
		extensions: extensions.length,
		skills: skills.length,
		prompts: prompts.length,
		themes: themes.length,
	};
}

async function discoverConventionalResources(
	category: Exclude<ResourceCategory, "packages" | "themes">,
	baseDir: string,
	scope: ResourceScope,
	source: string,
): Promise<FileResourceItem[]> {
	try {
		if (category === "extensions") return await discoverExtensions(baseDir, scope, source);
		if (category === "skills") return await discoverSkills(baseDir, scope, source);
		return await discoverFlatFiles(baseDir, scope, source, category, ".md");
	} catch {
		return [];
	}
}

async function discoverThemeFiles(
	baseDir: string,
	scope: ResourceScope,
	source: string,
	selectedTheme: string | undefined,
): Promise<ThemeResourceItem[]> {
	try {
		const entries = await readdir(baseDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && extname(entry.name) === ".json")
			.map((entry) => createThemeItem(resolve(baseDir, entry.name), scope, source, selectedTheme));
	} catch {
		return [];
	}
}

async function discoverExtensions(baseDir: string, scope: ResourceScope, source: string): Promise<FileResourceItem[]> {
	const entries = await readdir(baseDir, { withFileTypes: true });
	const items: FileResourceItem[] = [];
	for (const entry of entries) {
		const path = resolve(baseDir, entry.name);
		if (entry.isFile() && [".ts", ".js"].includes(extname(entry.name))) {
			items.push(createFileItem("extensions", path, scope, source));
		}
		if (entry.isDirectory()) {
			const indexTs = resolve(path, "index.ts");
			const indexJs = resolve(path, "index.js");
			if (await pathExists(indexTs)) {
				items.push(createFileItem("extensions", indexTs, scope, source, `${entry.name}/index.ts`));
			}
			if (await pathExists(indexJs)) {
				items.push(createFileItem("extensions", indexJs, scope, source, `${entry.name}/index.js`));
			}
		}
	}
	return items;
}

async function discoverSkills(baseDir: string, scope: ResourceScope, source: string): Promise<FileResourceItem[]> {
	const items: FileResourceItem[] = [];
	const entries = await readdir(baseDir, { withFileTypes: true });
	for (const entry of entries) {
		const path = resolve(baseDir, entry.name);
		if (entry.isFile() && extname(entry.name) === ".md") {
			items.push(createFileItem("skills", path, scope, source));
			continue;
		}
		if (!entry.isDirectory()) continue;
		items.push(...(await discoverSkillDirectories(path, scope, source)));
	}
	return items;
}

async function discoverSkillDirectories(
	baseDir: string,
	scope: ResourceScope,
	source: string,
): Promise<FileResourceItem[]> {
	const entries = await readdir(baseDir, { withFileTypes: true });
	const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
	if (skillFile) {
		return [createFileItem("skills", resolve(baseDir, "SKILL.md"), scope, source)];
	}

	const items: FileResourceItem[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		items.push(...(await discoverSkillDirectories(resolve(baseDir, entry.name), scope, source)));
	}
	return items;
}

async function discoverFlatFiles(
	baseDir: string,
	scope: ResourceScope,
	source: string,
	category: "prompts",
	extension: string,
): Promise<FileResourceItem[]> {
	try {
		const entries = await readdir(baseDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && extname(entry.name) === extension)
			.map((entry) => createFileItem(category, resolve(baseDir, entry.name), scope, source));
	} catch {
		return [];
	}
}

function createFileItem(
	category: Exclude<ResourceCategory, "packages" | "themes">,
	path: string,
	scope: ResourceScope,
	source: string,
	nameOverride?: string,
): FileResourceItem {
	const name = nameOverride ?? inferName(category, path);
	return {
		category,
		id: `${category}:${scope}:${path}`,
		name,
		path,
		scope,
		source,
		description: buildResourceDescription(category, scope, source, path),
		enabled: true,
	};
}

function createThemeItem(
	path: string,
	scope: ResourceScope,
	source: string,
	selectedTheme: string | undefined,
): ThemeResourceItem {
	const name = inferName("themes", path);
	return {
		category: "themes",
		id: `themes:${scope}:${path}`,
		name,
		path,
		scope,
		source,
		description: buildResourceDescription("themes", scope, source, path),
		enabled: name === selectedTheme,
	};
}

function createBuiltinThemeItem(name: string, selectedTheme: string | undefined): ThemeResourceItem {
	return {
		category: "themes",
		id: `themes:user:builtin:${name}`,
		name,
		scope: "user",
		source: "builtin",
		description: `Built-in Pi theme: ${name}`,
		enabled: name === selectedTheme,
		builtin: true,
	};
}

function inferName(category: Exclude<ResourceCategory, "packages">, path: string): string {
	if (category === "skills" && basename(path) === "SKILL.md") {
		return basename(dirname(path));
	}
	if (category === "themes") {
		return basename(path, extname(path));
	}
	return basename(path);
}

function buildResourceDescription(
	category: Exclude<ResourceCategory, "packages">,
	scope: ResourceScope,
	source: string,
	path: string,
): string {
	const location = scope === "project" ? "project" : "user";
	const origin = source === "settings" ? "configured in settings" : "discovered from standard locations";
	const categoryText =
		category === "extensions"
			? "Extension resource"
			: category === "skills"
				? "Skill resource"
				: category === "prompts"
					? "Prompt resource"
					: "Theme resource";
	return `${categoryText} in ${location} scope, ${origin}. Path: ${path}`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function sortItems<T extends ResourceItem>(items: T[]): T[] {
	return items.sort((a, b) => {
		if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}
