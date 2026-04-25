/**
 * 浏览器中的资源筛选、排序与 package 内容选择逻辑。
 */
import type { ResourceCenterSettings } from "../settings.js";
import { CATEGORY_LABELS, type BrowserListEntry, type PackageContentCategory, type PackageGroupEntry } from "./shared.js";
import { belongsToPackage } from "../resource/identity.js";
import type { ResourceCategory, ResourceIndex, ResourceItem } from "../types.js";

export function sortResourceItems(
	items: ResourceItem[],
	settings: ResourceCenterSettings,
	isPinned: (item: ResourceItem) => boolean,
	getPinnedRank: (item: ResourceItem) => number,
): ResourceItem[] {
	const mode = settings.sortMode ?? "updated";
	const sorted = [...items];
	sorted.sort((a, b) => {
		const aPinned = isPinned(a);
		const bPinned = isPinned(b);
		const pinnedDiff = Number(bPinned) - Number(aPinned);
		if (pinnedDiff !== 0) return pinnedDiff;
		if (aPinned && bPinned) {
			const aIndex = getPinnedRank(a);
			const bIndex = getPinnedRank(b);
			if (aIndex !== bIndex) return aIndex - bIndex;
		}

		if (mode === "default") return 0;
		if (mode === "updated") {
			const aTime = a.updatedAt ?? -1;
			const bTime = b.updatedAt ?? -1;
			const timeDiff = bTime - aTime;
			if (timeDiff !== 0) return timeDiff;
		}
		if (mode === "enabled") {
			const enabledDiff = Number(b.enabled) - Number(a.enabled);
			if (enabledDiff !== 0) return enabledDiff;
		}
		if (mode === "scope") {
			const rank = (scope: ResourceItem["scope"]) => (scope === "project" ? 0 : 1);
			const scopeDiff = rank(a.scope) - rank(b.scope);
			if (scopeDiff !== 0) return scopeDiff;
		}

		const nameDiff = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		if (nameDiff !== 0) return nameDiff;
		return a.source.localeCompare(b.source, undefined, { sensitivity: "base" });
	});
	return sorted;
}

export function getVisibleCategoryItems(
	resources: ResourceIndex,
	category: ResourceCategory,
	settings: ResourceCenterSettings,
	isPinned: (item: ResourceItem) => boolean,
	getPinnedRank: (item: ResourceItem) => number,
): ResourceItem[] {
	const items = resources.categories[category];
	const visible = category === "packages" || category === "themes" ? items : items.filter((item) => !item.packageSource || item.exposed);
	return sortResourceItems(visible, settings, isPinned, getPinnedRank);
}

export function getPackageContainedItems(
	resources: ResourceIndex,
	pkg: ResourceItem,
	category: PackageContentCategory,
	settings: ResourceCenterSettings,
	isPinned: (item: ResourceItem) => boolean,
	getPinnedRank: (item: ResourceItem) => number,
): ResourceItem[] {
	if (pkg.category !== "packages") return [];
	const items = resources.categories[category].filter((item) => belongsToPackage(item, pkg));
	return sortResourceItems(items, settings, isPinned, getPinnedRank);
}

export function getFilteredPackageContainedItems(
	items: ResourceItem[],
	category: PackageContentCategory,
	query: string,
	matchesQuery: (item: ResourceItem, query: string) => boolean,
): ResourceItem[] {
	if (!query || CATEGORY_LABELS[category].toLowerCase().includes(query)) return items;
	return items.filter((item) => matchesQuery(item, query));
}

export function buildPackageGroupEntries(
	categories: PackageContentCategory[],
	query: string,
	previewLimit: ResourceCenterSettings["packagePreviewLimit"],
	getItems: (category: PackageContentCategory) => ResourceItem[],
): PackageGroupEntry[] {
	const entries: PackageGroupEntry[] = [];
	for (const category of categories) {
		const categoryMatches = !query || CATEGORY_LABELS[category].toLowerCase().includes(query);
		const items = getItems(category);
		if (!categoryMatches && items.length === 0) continue;
		entries.push({ kind: "category", category });
		for (const item of items.slice(0, previewLimit)) {
			entries.push({ kind: "item", category, item });
		}
		if (items.length > previewLimit) {
			entries.push({ kind: "more", category, remaining: items.length - previewLimit });
		}
	}
	return entries;
}

export function buildBrowserListEntries(
	category: ResourceCategory,
	items: ResourceItem[],
	expandedPluginGroupIds: Set<string>,
	allItems: ResourceItem[] = items,
): BrowserListEntry[] {
	if (category !== "skills") {
		return items.map((item) => ({ kind: "resource", item }));
	}

	const pluginItemsById = new Map<string, ResourceItem[]>();
	for (const item of allItems) {
		const pluginId = "externalPluginId" in item ? item.externalPluginId : undefined;
		const pluginName = "externalPluginName" in item ? item.externalPluginName : undefined;
		if (!pluginId || !pluginName) continue;
		const current = pluginItemsById.get(pluginId) ?? [];
		current.push(item);
		pluginItemsById.set(pluginId, current);
	}
	const visiblePluginItemsById = new Map<string, ResourceItem[]>();
	for (const item of items) {
		const pluginId = "externalPluginId" in item ? item.externalPluginId : undefined;
		const pluginName = "externalPluginName" in item ? item.externalPluginName : undefined;
		if (!pluginId || !pluginName) continue;
		const current = visiblePluginItemsById.get(pluginId) ?? [];
		current.push(item);
		visiblePluginItemsById.set(pluginId, current);
	}

	const emittedPluginGroups = new Set<string>();
	const entries: BrowserListEntry[] = [];
	for (const item of items) {
		const pluginId = "externalPluginId" in item ? item.externalPluginId : undefined;
		const pluginName = "externalPluginName" in item ? item.externalPluginName : undefined;
		const pluginItems = pluginId ? pluginItemsById.get(pluginId) : undefined;
		const visiblePluginItems = pluginId ? visiblePluginItemsById.get(pluginId) : undefined;
		if (!pluginId || !pluginName || !pluginItems || !visiblePluginItems || pluginItems.length <= 1) {
			entries.push({ kind: "resource", item });
			continue;
		}
		if (emittedPluginGroups.has(pluginId)) continue;
		emittedPluginGroups.add(pluginId);
		const expanded = expandedPluginGroupIds.has(pluginId);
		entries.push({
			kind: "plugin-group",
			pluginId,
			pluginName,
			scope: item.scope,
			sourceLabel: `codex:${pluginName}`,
			items: pluginItems,
			enabledCount: pluginItems.filter((entry) => entry.enabled).length,
			totalCount: pluginItems.length,
			expanded,
			updatedAt: pluginItems.reduce<number | undefined>((latest, entry) => {
				if (entry.updatedAt === undefined) return latest;
				return latest === undefined ? entry.updatedAt : Math.max(latest, entry.updatedAt);
			}, undefined),
		});
		if (!expanded) continue;
		for (const pluginItem of visiblePluginItems) {
			entries.push({ kind: "plugin-child", pluginId, item: pluginItem });
		}
	}
	return entries;
}
