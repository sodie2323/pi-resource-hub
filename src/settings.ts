import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { FileResourceItem, ResourceCategory, ResourceItem } from "./types.js";

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

export const PROJECT_AGENT_DIR = ".pi";
export const USER_AGENT_DIR = resolve(homedir(), ".pi", "agent");

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

export function getSettingPaths(settingsFile: SettingsFile | undefined, category: ResourceCategory): string[] {
	if (!settingsFile || category === "packages") return [];
	const values = settingsFile.settings[category] ?? [];
	return values
		.filter((value) => typeof value === "string")
		.map((value) => resolve(settingsFile.dir, normalizeConfigPath(value)));
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
	const settingsFile = (await readSettingsFile(settingsPath)) ?? {
		path: settingsPath,
		dir: dirname(settingsPath),
		settings: {} as SettingsShape,
	};

	if (item.category === "packages") {
		togglePackage(settingsFile.settings, item.source, item.enabled);
	} else {
		if (item.category === "themes" || !("path" in item)) {
			throw new Error(`Resource ${item.name} cannot be toggled via path settings`);
		}
		togglePathResource(settingsFile.settings, item.category, item, settingsFile.dir);
	}

	await saveSettingsFile(settingsPath, settingsFile.settings);
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
	const settingsFile = (await readSettingsFile(settingsPath)) ?? {
		path: settingsPath,
		dir: dirname(settingsPath),
		settings: {} as SettingsShape,
	};

	const packages = [...(settingsFile.settings.packages ?? [])];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
	if (index === -1) {
		packages.push(source);
	} else {
		packages[index] = source;
	}
	settingsFile.settings.packages = packages;

	await saveSettingsFile(settingsPath, settingsFile.settings);
	return settingsPath;
}

function togglePackage(settings: SettingsShape, source: string, enabled: boolean): void {
	const packages = [...(settings.packages ?? [])];
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

	settings.packages = packages.length > 0 ? packages : undefined;
}

function togglePathResource(
	settings: SettingsShape,
	category: Exclude<ResourceCategory, "packages" | "themes">,
	item: FileResourceItem,
	settingsDir: string,
): void {
	setPathResourceEnabled(settings, category, item.path, settingsDir, item.enabled);
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
	setPathResourceEnabled(settings, category, item.path, settingsDir, false);
}

function setPathResourceEnabled(
	settings: SettingsShape,
	category: Exclude<ResourceCategory, "packages" | "themes">,
	path: string,
	settingsDir: string,
	enabled: boolean,
): void {
	const current = [...(settings[category] ?? [])];
	const normalizedPath = resolve(settingsDir, normalizeConfigPath(path));
	const filtered = current.filter((entry) => resolve(settingsDir, normalizeConfigPath(entry)) !== normalizedPath);
	if (enabled) {
		filtered.push(path);
	}
	settings[category] = filtered.length > 0 ? filtered : undefined;
}

async function saveSettingsFile(settingsPath: string, settings: SettingsShape): Promise<void> {
	await mkdir(dirname(settingsPath), { recursive: true });
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function isExplicitlyDisabled(value: string[] | undefined): boolean {
	return Array.isArray(value) && value.length === 0;
}

function normalizeConfigPath(value: string): string {
	if (value.startsWith("+") || value.startsWith("-") || value.startsWith("!")) {
		return value.slice(1);
	}
	return value;
}
