/**
 * settings 子模块共享的类型、路径、通用 helper 与默认值。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import type { ResourceCategory, ResourceItem, ResourceScope } from "../types.js";

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

export type ResourceSortMode = "updated" | "default" | "name" | "enabled" | "scope";

export interface ResourceCenterSettings {
	showSource: boolean;
	showPath: boolean;
	showPathInPackage: boolean;
	sortMode: ResourceSortMode;
	pinned: string[];
	packagePreviewLimit: 3 | 5 | 8;
	searchIncludeDescription: boolean;
	searchIncludePath: boolean;
}

export interface ResourceCenterSettingsFile extends ResourceCenterSettings {
	exposedResources?: ExposedResourceEntry[];
}

export const DEFAULT_RESOURCE_CENTER_SETTINGS: ResourceCenterSettings = {
	showSource: true,
	showPath: true,
	showPathInPackage: true,
	sortMode: "updated",
	pinned: [],
	packagePreviewLimit: 5,
	searchIncludeDescription: true,
	searchIncludePath: true,
};

export const PROJECT_AGENT_DIR = ".pi";
export const USER_AGENT_DIR = resolve(homedir(), ".pi", "agent");
export const RESOURCE_CENTER_SETTINGS_FILE = "pi-resource-center-settings.json";

export async function readSettingsFile(path: string): Promise<SettingsFile | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as SettingsShape;
		return { path, dir: dirname(path), settings: parsed };
	} catch (error: unknown) {
		if (isFileNotFoundError(error)) return undefined;
		if (error instanceof SyntaxError) throw new Error(`Failed to parse settings file ${path}: ${error.message}`);
		throw new Error(`Failed to read settings file ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function getProjectSettingsPath(cwd: string): string {
	return resolve(cwd, PROJECT_AGENT_DIR, "settings.json");
}

export function getUserSettingsPath(): string {
	return resolve(USER_AGENT_DIR, "settings.json");
}

export function getResourceCenterSettingsPath(): string {
	return resolve(USER_AGENT_DIR, RESOURCE_CENTER_SETTINGS_FILE);
}

export function getSettingPaths(settingsFile: SettingsFile | undefined, category: ResourceCategory): string[] {
	return getSettingPathEntries(settingsFile, category).filter((entry) => entry.enabled).map((entry) => entry.path);
}

export function getSettingPathEntries(settingsFile: SettingsFile | undefined, category: ResourceCategory): Array<{ path: string; enabled: boolean }> {
	if (!settingsFile || category === "packages") return [];
	const values = settingsFile.settings[category] ?? [];
	return values
		.filter((value): value is string => typeof value === "string")
		.map((value) => ({ path: resolve(settingsFile.dir, normalizeConfigPath(value)), enabled: !isDisabledConfigPath(value) }));
}

export function getPathResourceEnabledState(settingsFile: SettingsFile | undefined, category: Exclude<ResourceCategory, "packages">, path: string): boolean | undefined {
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

export function getSelectedTheme(projectSettings: SettingsFile | undefined, userSettings: SettingsFile | undefined): string | undefined {
	return projectSettings?.settings.theme ?? userSettings?.settings.theme;
}

export function isPackageSourceEnabled(source: PackageSource): boolean {
	if (typeof source === "string") return true;
	return !(isExplicitlyDisabled(source.extensions) && isExplicitlyDisabled(source.skills) && isExplicitlyDisabled(source.prompts) && isExplicitlyDisabled(source.themes));
}

export async function saveSettingsFile(settingsPath: string, settings: SettingsShape): Promise<void> {
	await mkdir(dirname(settingsPath), { recursive: true });
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function isFileNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function describeResource(item: ResourceItem): string {
	if (item.category === "packages") return `package ${item.source}`;
	if (item.packageSource) return `${item.category.slice(0, -1)} ${item.name} from package ${item.packageSource}`;
	if ("path" in item && item.path) return `${item.category.slice(0, -1)} ${item.name} (${item.path})`;
	return `${item.category.slice(0, -1)} ${item.name}`;
}

export function isExplicitlyDisabled(value: string[] | undefined): boolean {
	return Array.isArray(value) && value.length === 0;
}

export function isDisabledConfigPath(value: string): boolean {
	return value.startsWith("-") || value.startsWith("!");
}

export function inferPackageRelativePath(item: Exclude<ResourceItem, { category: "packages" }>): string {
	if (item.packageRelativePath) return item.packageRelativePath;
	if ("path" in item && item.path) {
		if (item.category === "themes") return basename(item.path);
		if (item.category === "skills" && basename(item.path) === "SKILL.md") return basename(dirname(item.path));
		return basename(item.path);
	}
	throw new Error(`Could not infer package-relative path for ${item.name}`);
}

export function normalizeConfigPath(value: string): string {
	if (value.startsWith("+") || value.startsWith("-") || value.startsWith("!")) return value.slice(1).replace(/\\/g, "/");
	return value.replace(/\\/g, "/");
}

export function normalizeFsPath(value: string): string {
	return value.replace(/\\/g, "/").toLowerCase();
}

export function toSettingsPath(path: string, settingsDir: string): string {
	const resolvedPath = resolve(path);
	const relativePath = relative(settingsDir, resolvedPath);
	const settingsPath = relativePath && !relativePath.startsWith("..") ? relativePath : resolvedPath;
	return settingsPath.replace(/\\/g, "/");
}
