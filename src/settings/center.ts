/**
 * 资源中心自身设置的读写与维护逻辑。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canExposeResource } from "../resource/capabilities.js";
import { pruneExposedResourceEntries, prunePinnedResourceIds } from "../resource/state-prune.js";
import type { ResourceIndex, ResourceItem } from "../types.js";
import {
	DEFAULT_RESOURCE_CENTER_SETTINGS,
	getResourceCenterSettingsPath,
	inferPackageRelativePath,
	isFileNotFoundError,
	normalizeConfigPath,
	toErrorMessage,
	type ExposedResourceEntry,
	type ResourceCenterSettings,
	type ResourceCenterSettingsFile,
} from "./shared.js";

async function readResourceCenterSettingsFile(): Promise<ResourceCenterSettingsFile> {
	const path = getResourceCenterSettingsPath();
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<ResourceCenterSettingsFile>;
		return { ...DEFAULT_RESOURCE_CENTER_SETTINGS, ...parsed, exposedResources: parsed.exposedResources };
	} catch (error: unknown) {
		if (isFileNotFoundError(error)) return { ...DEFAULT_RESOURCE_CENTER_SETTINGS };
		if (error instanceof SyntaxError) throw new Error(`Failed to parse resource center settings ${path}: ${error.message}`);
		throw new Error(`Failed to read resource center settings ${path}: ${toErrorMessage(error)}`);
	}
}

async function saveResourceCenterSettingsFile(file: ResourceCenterSettingsFile): Promise<string> {
	const path = getResourceCenterSettingsPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	return path;
}

export async function readResourceCenterSettings(): Promise<ResourceCenterSettings> {
	const file = await readResourceCenterSettingsFile();
	const { exposedResources: _exposed, ...settings } = file;
	return settings;
}

export async function saveResourceCenterSettings(settings: ResourceCenterSettings, resources?: ResourceIndex): Promise<string> {
	let file: ResourceCenterSettingsFile;
	try {
		file = await readResourceCenterSettingsFile();
	} catch {
		file = { ...DEFAULT_RESOURCE_CENTER_SETTINGS };
	}

	const prunedSettings = resources ? prunePinnedResourceIds(settings, resources) : settings;
	const exposedResources = resources ? pruneExposedResourceEntries(file.exposedResources, resources) : file.exposedResources;
	return saveResourceCenterSettingsFile({ ...file, ...prunedSettings, exposedResources });
}

export async function getExposedResources(_cwd: string): Promise<ExposedResourceEntry[]> {
	try {
		const file = await readResourceCenterSettingsFile();
		return file.exposedResources ?? [];
	} catch (error: unknown) {
		throw new Error(`Failed to read exposed resources: ${toErrorMessage(error)}`);
	}
}

export async function syncPrunedExposedResources(resources: ResourceIndex): Promise<void> {
	const file = await readResourceCenterSettingsFile();
	const nextEntries = pruneExposedResourceEntries(file.exposedResources, resources);
	if (areExposedEntriesEqual(file.exposedResources, nextEntries)) return;
	await saveResourceCenterSettingsFile({ ...file, exposedResources: nextEntries });
}

function areExposedEntriesEqual(left: ExposedResourceEntry[] | undefined, right: ExposedResourceEntry[] | undefined): boolean {
	if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
	return (left ?? []).every((entry, index) => {
		const other = right?.[index];
		return Boolean(
			other &&
			entry.scope === other.scope &&
			entry.category === other.category &&
			entry.package === other.package &&
			entry.path === other.path,
		);
	});
}

export async function setResourceExposed(cwd: string, item: ResourceItem, exposed: boolean): Promise<string> {
	if (!canExposeResource(item)) {
		throw new Error("Only package-contained extensions, skills, and prompts can be exposed");
	}
	const entryPath = item.packageRelativePath ?? inferPackageRelativePath(item);
	const settingsPath = getResourceCenterSettingsPath();
	try {
		const file = await readResourceCenterSettingsFile();
		const entries = [...(file.exposedResources ?? [])];
		const normalizedPath = normalizeConfigPath(entryPath);
		const nextEntries = entries.filter(
			(entry) => !(entry.scope === item.scope && entry.category === item.category && entry.package === item.packageSource && normalizeConfigPath(entry.path) === normalizedPath),
		);
		if (exposed) nextEntries.push({ scope: item.scope, category: item.category, package: item.packageSource, path: entryPath });
		await saveResourceCenterSettingsFile({ ...file, exposedResources: nextEntries.length ? nextEntries : undefined });
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to ${exposed ? "expose" : "hide"} ${item.name} in ${item.scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}
