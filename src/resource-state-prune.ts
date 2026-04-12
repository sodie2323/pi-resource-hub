import { canExposeResource } from "./resource-capabilities.js";
import { normalizeConfigPath, type ExposedResourceEntry, type ResourceCenterSettings } from "./settings-shared.js";
import type { ResourceIndex } from "./types.js";

export function prunePinnedResourceIds(settings: ResourceCenterSettings, resources: ResourceIndex): ResourceCenterSettings {
	const current = settings.pinned ?? [];
	if (current.length === 0) return settings;
	const validIds = new Set(Object.values(resources.categories).flat().map((item) => item.id));
	const nextPinned = current.filter((id) => validIds.has(id));
	if (nextPinned.length === current.length) return settings;
	return { ...settings, pinned: nextPinned };
}

export function pruneExposedResourceEntries(entries: ExposedResourceEntry[] | undefined, resources: ResourceIndex): ExposedResourceEntry[] | undefined {
	if (!entries?.length) return undefined;
	const nextEntries = entries.filter((entry) =>
		resources.categories[entry.category].some(
			(item) =>
				canExposeResource(item) &&
				item.scope === entry.scope &&
				item.packageSource === entry.package &&
				normalizeConfigPath(item.packageRelativePath ?? "") === normalizeConfigPath(entry.path),
		),
	);
	return nextEntries.length ? nextEntries : undefined;
}
