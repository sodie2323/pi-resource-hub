/**
 * 对 Pi settings 中资源配置进行增删改切换的逻辑。
 */
import { lstat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { FileResourceItem, ResourceCategory, ResourceItem } from "../types.js";
import {
	USER_AGENT_DIR,
	getProjectSettingsPath,
	getUserSettingsPath,
	readSettingsFile,
	saveSettingsFile,
	type PackageSource,
	describeResource,
	inferPackageRelativePath,
	normalizeConfigPath,
	normalizeFsPath,
	toErrorMessage,
	toSettingsPath,
} from "./shared.js";

export async function toggleResourceInSettings(cwd: string, item: ResourceItem): Promise<string> {
	const settingsPath = item.scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = SettingsManager.create(cwd, USER_AGENT_DIR);
	try {
		if (item.category === "packages") {
			togglePackage(settingsManager, item.scope, item.source, item.enabled);
		} else if (item.packageSource) {
			togglePackageResource(settingsManager, item, item.enabled);
		} else {
			if (item.category === "themes" || !("path" in item)) throw new Error(`Resource ${item.name} cannot be toggled via path settings`);
			togglePathResource(settingsManager, item.scope, item.category, item, dirname(settingsPath));
		}
		await settingsManager.flush();
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to toggle ${describeResource(item)} in ${item.scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function removeResourceFromSettings(cwd: string, item: ResourceItem): Promise<string> {
	const settingsPath = item.scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = SettingsManager.create(cwd, USER_AGENT_DIR);
	try {
		if (item.category === "packages") {
			const settings = item.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
			const packages = [...(settings.packages ?? [])] as PackageSource[];
			const filtered = packages.filter((entry) => (typeof entry === "string" ? entry : entry.source) !== item.source);
			if (filtered.length === packages.length) throw new Error(`Package source not found in ${item.scope} settings: ${item.source}`);
			setPackagesForScope(settingsManager, item.scope, filtered);
		} else {
			if (item.packageSource) throw new Error("Package resources cannot be removed individually");
			if (item.category === "themes" || !("path" in item)) throw new Error(`Resource ${item.name} cannot be removed via path settings`);
			const settings = item.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
			const current = [...(settings[item.category] ?? [])];
			const normalizedItemPath = normalizeFsPath(resolve(item.path));
			const filtered = current.filter((entry) => normalizeFsPath(resolve(dirname(settingsPath), normalizeConfigPath(entry))) !== normalizedItemPath);
			if (filtered.length === current.length) throw new Error(`Resource path is not configured in ${item.scope} settings: ${item.path}`);
			setPathEntriesForScope(settingsManager, item.scope, item.category, filtered);
		}
		await settingsManager.flush();
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to remove ${describeResource(item)} from ${item.scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function removeConventionResource(item: ResourceItem): Promise<string> {
	if (item.category === "packages") throw new Error("Packages are not file resources and can't be removed from disk this way");
	if (item.packageSource) throw new Error("Package resources can't be removed individually from disk");
	if (!("path" in item) || !item.path) throw new Error(`Resource ${item.name} has no file path`);
	const filePath = resolve(item.path);
	try {
		const stats = await lstat(filePath);
		if (stats.isDirectory()) throw new Error(`Expected a file but got directory: ${filePath}`);
		await unlink(filePath);
		return filePath;
	} catch (error: unknown) {
		throw new Error(`Failed to remove file for ${describeResource(item)} at ${filePath}: ${toErrorMessage(error)}`);
	}
}

export async function setActiveTheme(cwd: string, themeName: string, scope: "project" | "user" = "project"): Promise<string> {
	const settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	try {
		const settingsFile = (await readSettingsFile(settingsPath)) ?? { path: settingsPath, dir: dirname(settingsPath), settings: {} };
		settingsFile.settings.theme = themeName;
		await saveSettingsFile(settingsPath, settingsFile.settings);
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to set active theme ${themeName} in ${scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function addPackageToSettings(cwd: string, source: string, scope: "project" | "user" = "project"): Promise<string> {
	const settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getUserSettingsPath();
	const settingsManager = SettingsManager.create(cwd, USER_AGENT_DIR);
	try {
		const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
		const packages = [...(settings.packages ?? [])] as PackageSource[];
		const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
		if (index === -1) packages.push(source); else packages[index] = source;
		setPackagesForScope(settingsManager, scope, packages);
		await settingsManager.flush();
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to add package source ${source} to ${scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

function togglePackage(settingsManager: SettingsManager, scope: "project" | "user", source: string, enabled: boolean): void {
	const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])] as PackageSource[];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === source);
	if (enabled) {
		if (index === -1) packages.push(source); else packages[index] = source;
	} else {
		const disabledEntry = { source, extensions: [], skills: [], prompts: [], themes: [] };
		if (index === -1) packages.push(disabledEntry); else packages[index] = disabledEntry;
	}
	setPackagesForScope(settingsManager, scope, packages.length > 0 ? packages : []);
}

function togglePathResource(settingsManager: SettingsManager, scope: "project" | "user", category: Exclude<ResourceCategory, "packages" | "themes">, item: FileResourceItem, settingsDir: string): void {
	const settings = scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const current = [...(settings[category] ?? [])];
	const normalizedPath = normalizeFsPath(resolve(settingsDir, normalizeConfigPath(item.path)));
	const filtered = current.filter((entry) => normalizeFsPath(resolve(settingsDir, normalizeConfigPath(entry))) !== normalizedPath);
	const relativePath = toSettingsPath(item.path, settingsDir);
	filtered.push(item.enabled ? `+${relativePath}` : `-${relativePath}`);
	setPathEntriesForScope(settingsManager, scope, category, filtered);
}

function togglePackageResource(settingsManager: SettingsManager, item: Exclude<ResourceItem, { category: "packages" }>, enabled: boolean): void {
	if (!item.packageSource) throw new Error(`Resource ${item.name} is not backed by a package`);
	const settings = item.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])] as PackageSource[];
	const index = packages.findIndex((entry) => (typeof entry === "string" ? entry : entry.source) === item.packageSource);
	if (index === -1) throw new Error(`Package source not found in settings: ${item.packageSource}`);
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
	const hasFilters = ["extensions", "skills", "prompts", "themes"].some((key) => (pkg as unknown as Record<string, unknown>)[key] !== undefined);
	if (!hasFilters) packages[index] = pkg.source;
	setPackagesForScope(settingsManager, item.scope, packages.length > 0 ? packages : []);
}

function setPackagesForScope(settingsManager: SettingsManager, scope: "project" | "user", packages: PackageSource[]): void {
	if (scope === "project") settingsManager.setProjectPackages(packages); else settingsManager.setPackages(packages);
}

function setPathEntriesForScope(settingsManager: SettingsManager, scope: "project" | "user", category: Exclude<ResourceCategory, "packages" | "themes">, paths: string[]): void {
	if (scope === "project") {
		if (category === "extensions") settingsManager.setProjectExtensionPaths(paths);
		else if (category === "skills") settingsManager.setProjectSkillPaths(paths);
		else settingsManager.setProjectPromptTemplatePaths(paths);
		return;
	}
	if (category === "extensions") settingsManager.setExtensionPaths(paths);
	else if (category === "skills") settingsManager.setSkillPaths(paths);
	else settingsManager.setPromptTemplatePaths(paths);
}
