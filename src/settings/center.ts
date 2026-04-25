/**
 * 资源中心自身设置的读写与维护逻辑。
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canExposeResource } from "../resource/capabilities.js";
import { pruneExposedResourceEntries, prunePinnedResourceIds } from "../resource/state-prune.js";
import type { ResourceIndex, ResourceItem } from "../types.js";
import {
	DEFAULT_EXTERNAL_SKILL_SOURCES,
	DEFAULT_RESOURCE_CENTER_SETTINGS,
	getResourceCenterSettingsPath,
	getUserSettingsPath,
	inferPackageRelativePath,
	isFileNotFoundError,
	normalizeConfigPath,
	readSettingsFile,
	resolveHomePath,
	saveSettingsFile,
	toErrorMessage,
	type ExposedResourceEntry,
	type ExternalSkillSourceSetting,
	type ResourceCenterSettings,
	type ResourceCenterSettingsFile,
} from "./shared.js";

async function readResourceCenterSettingsFile(): Promise<ResourceCenterSettingsFile> {
	const path = getResourceCenterSettingsPath();
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<ResourceCenterSettingsFile>;
		return {
			...DEFAULT_RESOURCE_CENTER_SETTINGS,
			...parsed,
			externalSkillSources: mergeExternalSkillSourcesWithDefaults(parsed.externalSkillSources),
			exposedResources: parsed.exposedResources,
		};
	} catch (error: unknown) {
		if (isFileNotFoundError(error)) {
			return {
				...DEFAULT_RESOURCE_CENTER_SETTINGS,
				externalSkillSources: DEFAULT_EXTERNAL_SKILL_SOURCES.map((source) => ({ ...source })),
			};
		}
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
		file = {
			...DEFAULT_RESOURCE_CENTER_SETTINGS,
			externalSkillSources: DEFAULT_EXTERNAL_SKILL_SOURCES.map((source) => ({ ...source })),
		};
	}

	const previousExternalSkillSources = file.externalSkillSources ?? DEFAULT_EXTERNAL_SKILL_SOURCES;
	const prunedSettings = resources ? prunePinnedResourceIds(settings, resources) : settings;
	const exposedResources = resources ? pruneExposedResourceEntries(file.exposedResources, resources) : file.exposedResources;
	const nextFile = { ...file, ...prunedSettings, exposedResources };
	const savedPath = await saveResourceCenterSettingsFile(nextFile);
	await syncExternalSkillSourcesToPiSettings(previousExternalSkillSources, nextFile.externalSkillSources);
	return savedPath;
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
	const exposureItem = item;
	const entryPath = exposureItem.packageRelativePath ?? inferPackageRelativePath(exposureItem);
	const settingsPath = getResourceCenterSettingsPath();
	try {
		const file = await readResourceCenterSettingsFile();
		const entries = [...(file.exposedResources ?? [])];
		const normalizedPath = normalizeConfigPath(entryPath);
		const nextEntries = entries.filter(
			(entry) => !(entry.scope === exposureItem.scope && entry.category === exposureItem.category && entry.package === exposureItem.packageSource && normalizeConfigPath(entry.path) === normalizedPath),
		);
		if (exposed) nextEntries.push({ scope: exposureItem.scope, category: exposureItem.category, package: exposureItem.packageSource, path: entryPath });
		await saveResourceCenterSettingsFile({ ...file, exposedResources: nextEntries.length ? nextEntries : undefined });
		return settingsPath;
	} catch (error: unknown) {
		throw new Error(`Failed to ${exposed ? "expose" : "hide"} ${exposureItem.name} in ${exposureItem.scope} scope via ${settingsPath}: ${toErrorMessage(error)}`);
	}
}

export async function syncExternalSkillSourcesToPiSettings(
	previousSources: ExternalSkillSourceSetting[],
	nextSources: ExternalSkillSourceSetting[],
): Promise<string> {
	const settingsPath = getUserSettingsPath();
	const settingsFile = (await readSettingsFile(settingsPath)) ?? { path: settingsPath, dir: dirname(settingsPath), settings: {} };
	const nextSkills = [...(settingsFile.settings.skills ?? [])];
	const previousById = new Map(previousSources.map((source) => [source.id, source]));
	const nextById = new Map(nextSources.map((source) => [source.id, source]));
	const sourceIds = new Set([...previousById.keys(), ...nextById.keys()]);

	for (const sourceId of sourceIds) {
		const previous = previousById.get(sourceId);
		const next = nextById.get(sourceId);
		const previousResolvedPath = previous ? resolveHomePath(previous.path) : undefined;
		const nextResolvedPath = next ? resolveHomePath(next.path) : undefined;

		if (previousResolvedPath && (!next || !next.enabled || previousResolvedPath !== nextResolvedPath)) {
			// When an external root is turned off (or repointed), the integration should stop
			// contributing *any* skill entries from that subtree. This includes plain descendant
			// paths such as ~/.codex/skills/pdf/SKILL.md that may have been written earlier by
			// per-skill toggles while the root was enabled.
			for (const cleanupPath of await getExternalSkillSourceCleanupPaths(previous)) {
				removeManagedExternalSkillSourceEntries(nextSkills, settingsFile.dir, cleanupPath, true);
			}
		}

		// Codex Plugins is a generated integration: the user-facing source path is
		// ~/.codex/plugins, while Pi settings contain discovered plugin skill roots under
		// cache/runtime directories. Reconcile it on every sync so disabled state and
		// Codex cache version changes cannot leave stale Pi skill entries behind.
		if (next && isCodexPluginSource(next)) {
			for (const cleanupPath of await getExternalSkillSourceCleanupPaths(next)) {
				removeManagedExternalSkillSourceEntries(nextSkills, settingsFile.dir, cleanupPath, true, true);
			}
		}

		if (next?.enabled) {
			for (const syncPath of await getExternalSkillSourceSyncPaths(next)) {
				upsertExternalSkillSourceRoot(nextSkills, settingsFile.dir, syncPath);
			}
		}
	}

	settingsFile.settings.skills = nextSkills.length > 0 ? nextSkills : undefined;
	await saveSettingsFile(settingsPath, settingsFile.settings);
	return settingsPath;
}

function mergeExternalSkillSourcesWithDefaults(sources: ExternalSkillSourceSetting[] | undefined): ExternalSkillSourceSetting[] {
	const defaultsById = new Map(DEFAULT_EXTERNAL_SKILL_SOURCES.map((source) => [source.id, source]));
	const merged = new Map<string, ExternalSkillSourceSetting>();
	for (const source of DEFAULT_EXTERNAL_SKILL_SOURCES) {
		merged.set(source.id, { ...source });
	}
	for (const source of sources ?? []) {
		const defaultSource = defaultsById.get(source.id);
		const mergedSource = defaultSource ? { ...defaultSource, ...source } : { ...source };
		if (mergedSource.id === "codex-plugins" && mergedSource.path === "~/.codex/plugins/cache") {
			mergedSource.path = "~/.codex/plugins";
		}
		merged.set(source.id, mergedSource);
	}
	return Array.from(merged.values());
}

async function getExternalSkillSourceSyncPaths(source: ExternalSkillSourceSetting): Promise<string[]> {
	if (!isCodexPluginSource(source)) return [source.path];
	return collectCodexPluginSkillRoots(resolveHomePath(source.path));
}

async function getExternalSkillSourceCleanupPaths(source: ExternalSkillSourceSetting | undefined): Promise<string[]> {
	if (!source) return [];
	if (!isCodexPluginSource(source)) return [resolveHomePath(source.path)];
	return uniquePaths([
		resolveHomePath(source.path),
		resolveHomePath("~/.codex/plugins"),
		resolveHomePath("~/.codex/plugins/cache"),
		resolveHomePath("~/.cache/codex-runtimes"),
	]);
}

function isCodexPluginSource(source: ExternalSkillSourceSetting): boolean {
	return source.integration === "codex-plugin-cache" || source.id === "codex-plugins";
}

function uniquePaths(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		const key = normalizeAbsolutePath(path);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(path);
	}
	return result;
}

async function collectCodexPluginSkillRoots(cacheRoot: string): Promise<string[]> {
	const pluginJsonPaths = await collectCodexPluginManifests(cacheRoot);
	const skillRoots = new Set<string>();
	for (const pluginJsonPath of pluginJsonPaths) {
		const plugin = await readCodexPluginManifest(pluginJsonPath);
		if (!plugin || plugin.hasApps) continue;
		const pluginRoot = dirname(dirname(pluginJsonPath));
		const skillsRoot = resolve(pluginRoot, plugin.skillsPath ?? "skills");
		if ((await collectSkillPaths(skillsRoot)).length > 0) skillRoots.add(skillsRoot);
	}
	return Array.from(skillRoots).sort();
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

async function readCodexPluginManifest(path: string): Promise<{ skillsPath?: string; hasApps: boolean } | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as { skills?: unknown; apps?: unknown };
		return {
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
		if (info.isFile()) return path.endsWith(".md") ? [path] : [];
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
		if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md")) found.add(entryPath);
	}
}

function upsertExternalSkillSourceRoot(entries: string[], settingsDir: string, sourcePath: string): void {
	const resolvedSourcePath = resolveHomePath(sourcePath);
	const nextEntries = entries.filter((entry) => {
		if (entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!")) return true;
		return resolveSettingsEntryPath(settingsDir, entry) !== resolvedSourcePath;
	});
	nextEntries.push(sourcePath.replace(/\\/g, "/"));
	entries.splice(0, entries.length, ...nextEntries);
}

function removeManagedExternalSkillSourceEntries(
	entries: string[],
	settingsDir: string,
	resolvedSourcePath: string,
	removePlainDescendants = false,
	preserveExplicitOverrides = false,
): void {
	const normalizedRoot = normalizeAbsolutePath(resolvedSourcePath);
	const nextEntries = entries.filter((entry) => {
		const resolvedEntryPath = resolveSettingsEntryPath(settingsDir, entry);
		if (!resolvedEntryPath) return true;
		const normalizedEntryPath = normalizeAbsolutePath(resolvedEntryPath);
		if (!(normalizedEntryPath === normalizedRoot || normalizedEntryPath.startsWith(`${normalizedRoot}/`))) return true;
		const isExplicitOverride = entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!");
		if (isExplicitOverride && preserveExplicitOverrides) return true;
		const isRootEntry = normalizedEntryPath === normalizedRoot;
		const isPlainDescendant = normalizedEntryPath.startsWith(`${normalizedRoot}/`) && !isExplicitOverride;
		return !(isExplicitOverride || isRootEntry || (removePlainDescendants && isPlainDescendant));
	});
	entries.splice(0, entries.length, ...nextEntries);
}

function resolveSettingsEntryPath(settingsDir: string, entry: string): string | undefined {
	const normalizedEntry = normalizeConfigPath(entry);
	if (!normalizedEntry) return undefined;
	if (normalizedEntry === "~" || normalizedEntry.startsWith("~/") || normalizedEntry.startsWith("~\\")) {
		return resolveHomePath(normalizedEntry);
	}
	return resolve(settingsDir, normalizedEntry);
}

function normalizeAbsolutePath(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}
