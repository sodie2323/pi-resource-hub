import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { FileResourceItem, ResourceCategory, ResourceItem, ResourceScope } from "./types.js";

interface PackageSourceFilter {
	source: string;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type PackageSource = string | PackageSourceFilter;

export interface SettingsShape {
	theme?: string;
	packages?: PackageSource[];
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export interface SettingsFile {
	path: string;
	dir: string;
	settings: SettingsShape;
}

export interface ExposedResourceEntry {
	scope: ResourceScope;
	category: Exclude<ResourceCategory, "packages" | "themes">;
	package: string;
	path: string;
}

interface ResourceHubState {
	exposedResources?: ExposedResourceEntry[];
}

export const PROJECT_AGENT_DIR = ".pi";
export const USER_AGENT_DIR = resolve(homedir(), ".pi", "agent");
const RESOURCE_HUB_STATE_FILE = "resource-hub.json";

export async function readSettingsFile(path: string): Promise<SettingsFile | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as SettingsShape;
		return { path, dir: dirname(path), settings: parsed };
	} catch {
		return undefined;
	}
}

export function getProjectSettingsPath(cwd: string): string {
	return resolve(cwd, PROJECT_AGENT_DIR, "settings.json");
}

export function getUserSettingsPath(): string {
	return resolve(USER_AGENT_DIR, "settings.json");
}

export function getResourceHubStatePath(scope: ResourceScope, cwd: string): string {
	return scope === "project"
		? resolve(cwd, PROJECT_AGENT_DIR, RESOURCE_HUB_STATE_FILE)
		: resolve(USER_AGENT_DIR, RESOURCE_HUB_STATE_FILE);
}

export function getSettingPaths(settingsFile: SettingsFile | undefined, category: ResourceCategory): string[] {
	return getSettingPathEntries(settingsFile, category)
		.filter((entry) => entry.enabled)
		.map((entry) => entry.path);
}

export function getSettingPathEntries(
	settingsFile: SettingsFile | undefined,
	category: ResourceCategory,
): Array<{ path: string; enabled: boolean }> {
	if (!settingsFile || category === "packages") return [];
	const values = settingsFile.settings[category] ?? [];
	return values
		.filter((value): value is string => typeof value === "string")
		.map((value) => ({
			path: resolve(settingsFile.dir, normalizeConfigPath(value)),
			enabled: !isDisabledConfigPath(value),
		}));
}

export function getPathResourceEnabledState(
	settingsFile: SettingsFile | undefined,
	category: Exclude<ResourceCategory, "packages">,
	path: string,
): boolean | undefined {
	if (!settingsFile) return undefined;
	const normalizedPath = resolve(settingsFile.dir, path);
	let explicitState: boolean | undefined;
	for (const value of settingsFile.settings[category] ?? []) {
		if (typeof value !== "string") continue;
		const entryPath = resolve(settingsFile.dir, normalizeConfigPath(value));
		if (entryPath !== normalizedPath) continue;
		explicitState = !isDisabledConfigPath(value);
	}
	return explicitState;
}

export function getPackageSources(settingsFile: SettingsFile | undefined): PackageSource[] {
	return settingsFile?.settings.packages ?? [];
}

export function getSelectedTheme(
	projectSettings: SettingsFile | undefined,
	userSettings: SettingsFile | undefined,
): string | undefined {
	return projectSettings?.settings.theme ?? userSettings?.settings.theme;
}

export function isPackageSourceEnabled(source: PackageSource): boolean {
	if (typeof source === "string") return true;
	return !(
		isExplicitlyDisabled(source.extensions) &&
		isExplicitlyDisabled(source.skills) &&
		isExplicitlyDisabled(source.prompts) &&
		isExplicitlyDisabled(source.themes)
	);
}

export async function toggleResourceInSettings(cwd: string, item: ResourceItem): Promise<string> {
	const settingsPath = item.scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = SettingsManager.create(cwd, USER_AGENT_DIR);

	if (item.category === "packages") {
		togglePackage(settingsManager, item.scope, item.source, item.enabled);
	} else if (item.packageSource) {
		togglePackageResource(settingsManager, item, item.enabled);
	} else {
		if (item.category === "themes" || !("path" in item)) {
			throw new Error(`Resource ${item.name} cannot be toggled via path settings`);
		}
		togglePathResource(settingsManager, item.scope, item.category, item, dirname(settingsPath));
	}

	await settingsManager.flush();
	return settingsPath;
}

export async function removeResourceFromSettings(cwd: string, item: ResourceItem): Promise<string> {
	const settingsPath = item.scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsFile = (await readSettingsFile(settingsPath)) ?? {
		path: settingsPath,
		dir: dirname(settingsPath),
		settings: {} as SettingsShape,
	};

	if (item.category === "packages") {
		removePackage(settingsFile.settings, item.source);
	} else {
		if (item.packageSource) {
			throw new Error(`Package resources cannot be removed individually`);
		}
		if (item.category === "themes" || !("path" in item)) {
			throw new Error(`Resource ${item.name} cannot be removed via path settings`);
		}
		removePathResource(settingsFile.settings, item.category, item, settingsFile.dir);
	}

	await saveSettingsFile(settingsPath, settingsFile.settings);
	return settingsPath;
}

export async function setActiveTheme(
	cwd: string,
	themeName: string,
	scope: "project" | "user" = "project",
): Promise<string> {
	const settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsFile = (await readSettingsFile(settingsPath)) ?? {
		path: settingsPath,
		dir: dirname(settingsPath),
		settings: {} as SettingsShape,
	};

	settingsFile.settings.theme = themeName;
	await saveSettingsFile(settingsPath, settingsFile.settings);
	return settingsPath;
}

export async function addPackageToSettings(
	cwd: string,
	source: string,
	scope: "project" | "user" = "project",
): Promise<string> {
	const settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = SettingsManager.create(cwd, USER_AGENT_DIR);
	const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])] as PackageSource[];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
	if (index === -1) {
		packages.push(source);
	} else {
		packages[index] = source;
	}
	setPackagesForScope(settingsManager, scope, packages);
	await settingsManager.flush();
	return settingsPath;
}

export async function getExposedResources(cwd: string): Promise<ExposedResourceEntry[]> {
	const [projectState, userState] = await Promise.all([
		readResourceHubState(getResourceHubStatePath("project", cwd)),
		readResourceHubState(getResourceHubStatePath("user", cwd)),
	]);
	return [...(projectState.exposedResources ?? []), ...(userState.exposedResources ?? [])];
}

export async function setResourceExposed(cwd: string, item: ResourceItem, exposed: boolean): Promise<string> {
	if (!item.packageSource || item.category === "packages" || item.category === "themes") {
		throw new Error(`Only package-contained extensions, skills, and prompts can be exposed`);
	}
	const path = item.packageRelativePath ?? inferPackageRelativePath(item);
	const statePath = getResourceHubStatePath(item.scope, cwd);
	const state = await readResourceHubState(statePath);
	const entries = [...(state.exposedResources ?? [])];
	const nextEntries = entries.filter(
		(entry) => !(entry.category === item.category && entry.package === item.packageSource && normalizeConfigPath(entry.path) === normalizeConfigPath(path)),
	);
	if (exposed) {
		nextEntries.push({ scope: item.scope, category: item.category, package: item.packageSource, path });
	}
	await saveResourceHubState(statePath, { exposedResources: nextEntries.length > 0 ? nextEntries : undefined });
	return statePath;
}

function togglePackage(
	settingsManager: SettingsManager,
	scope: "project" | "user",
	source: string,
	enabled: boolean,
): void {
	const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])] as PackageSource[];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);

	if (enabled) {
		if (index === -1) {
			packages.push(source);
		} else {
			packages[index] = source;
		}
	} else {
		const disabledEntry: PackageSourceFilter = {
			source,
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		};
		if (index === -1) {
			packages.push(disabledEntry);
		} else {
			packages[index] = disabledEntry;
		}
	}

	setPackagesForScope(settingsManager, scope, packages.length > 0 ? packages : []);
}

function togglePathResource(
	settingsManager: SettingsManager,
	scope: "project" | "user",
	category: Exclude<ResourceCategory, "packages" | "themes">,
	item: FileResourceItem,
	settingsDir: string,
): void {
	const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const current = [...(settings[category] ?? [])];
	const normalizedPath = resolve(settingsDir, normalizeConfigPath(item.path));
	const filtered = current.filter((entry) => resolve(settingsDir, normalizeConfigPath(entry)) !== normalizedPath);
	const relativePath = toSettingsPath(item.path, settingsDir);
	filtered.push(item.enabled ? `+${relativePath}` : `-${relativePath}`);
	setPathEntriesForScope(settingsManager, scope, category, filtered);
}

function togglePackageResource(
	settingsManager: SettingsManager,
	item: Exclude<ResourceItem, { category: "packages" }>,
	enabled: boolean,
): void {
	if (!item.packageSource) {
		throw new Error(`Resource ${item.name} is not backed by a package`);
	}
	const settings = item.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])] as PackageSource[];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === item.packageSource);
	if (index === -1) {
		throw new Error(`Package source not found in settings: ${item.packageSource}`);
	}

	let pkg = packages[index]!;
	if (typeof pkg === "string") {
		pkg = { source: pkg };
		packages[index] = pkg;
	}

	const category = item.category;
	const current = [...(pkg[category] ?? [])];
	const pattern = item.packageRelativePath ?? inferPackageRelativePath(item);
	const updated = current.filter((entry) => normalizeConfigPath(entry) !== normalizeConfigPath(pattern));
	updated.push(enabled ? `+${pattern}` : `-${pattern}`);
	pkg[category] = updated.length > 0 ? updated : undefined;

	const hasFilters = ["extensions", "skills", "prompts", "themes"].some(
		(key) => (pkg as Record<string, unknown>)[key] !== undefined,
	);
	if (!hasFilters) {
		packages[index] = pkg.source;
	}
	setPackagesForScope(settingsManager, item.scope, packages.length > 0 ? packages : []);
}

function removePackage(settings: SettingsShape, source: string): void {
	const packages = [...(settings.packages ?? [])].filter(
		(entry) => (typeof entry === "string" ? entry : entry.source) !== source,
	);
	settings.packages = packages.length > 0 ? packages : undefined;
}

function removePathResource(
	settings: SettingsShape,
	category: Exclude<ResourceCategory, "packages" | "themes">,
	item: FileResourceItem,
	settingsDir: string,
): void {
	const current = [...(settings[category] ?? [])];
	const normalizedPath = resolve(settingsDir, normalizeConfigPath(item.path));
	const filtered = current.filter((entry) => resolve(settingsDir, normalizeConfigPath(entry)) !== normalizedPath);
	settings[category] = filtered.length > 0 ? filtered : undefined;
}

async function saveSettingsFile(settingsPath: string, settings: SettingsShape): Promise<void> {
	await mkdir(dirname(settingsPath), { recursive: true });
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function readResourceHubState(path: string): Promise<ResourceHubState> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as ResourceHubState;
	} catch {
		return {};
	}
}

async function saveResourceHubState(path: string, state: ResourceHubState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function setPackagesForScope(settingsManager: SettingsManager, scope: "project" | "user", packages: PackageSource[]): void {
	if (scope === "project") {
		settingsManager.setProjectPackages(packages);
	} else {
		settingsManager.setPackages(packages);
	}
}

function setPathEntriesForScope(
	settingsManager: SettingsManager,
	scope: "project" | "user",
	category: Exclude<ResourceCategory, "packages" | "themes">,
	paths: string[],
): void {
	if (scope === "project") {
		if (category === "extensions") {
			settingsManager.setProjectExtensionPaths(paths);
		} else if (category === "skills") {
			settingsManager.setProjectSkillPaths(paths);
		} else {
			settingsManager.setProjectPromptTemplatePaths(paths);
		}
		return;
	}

	if (category === "extensions") {
		settingsManager.setExtensionPaths(paths);
	} else if (category === "skills") {
		settingsManager.setSkillPaths(paths);
	} else {
		settingsManager.setPromptTemplatePaths(paths);
	}
}

function isExplicitlyDisabled(value: string[] | undefined): boolean {
	return Array.isArray(value) && value.length === 0;
}

function isDisabledConfigPath(value: string): boolean {
	return value.startsWith("-") || value.startsWith("!");
}

function inferPackageRelativePath(item: Exclude<ResourceItem, { category: "packages" }>): string {
	if (item.packageRelativePath) return item.packageRelativePath;
	if ("path" in item && item.path) {
		if (item.category === "themes") return basename(item.path);
		if (item.category === "skills" && basename(item.path) === "SKILL.md") {
			return basename(dirname(item.path));
		}
		return basename(item.path);
	}
	throw new Error(`Could not infer package-relative path for ${item.name}`);
}

function normalizeConfigPath(value: string): string {
	if (value.startsWith("+") || value.startsWith("-") || value.startsWith("!")) {
		return value.slice(1).replace(/\\/g, "/");
	}
	return value.replace(/\\/g, "/");
}

function toSettingsPath(path: string, settingsDir: string): string {
	const resolvedPath = resolve(path);
	const relativePath = relative(settingsDir, resolvedPath);
	const settingsPath = relativePath && !relativePath.startsWith("..") ? relativePath : resolvedPath;
	return settingsPath.replace(/\\/g, "/");
}
