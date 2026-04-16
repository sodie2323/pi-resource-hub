/**
 * 浏览器导航相关的纯函数，包括标题、footer、空态文案和选择移动。
 */
import { CATEGORY_LABELS, type BrowserMode, type PackageContentCategory, type PackageGroupEntry } from "./shared.js";
import { formatPackageLabel } from "./shared.js";
import { isContainedResource, isPackageItem } from "../resource/capabilities.js";
import type { ResourceCategory, ResourceItem } from "../types.js";

export function moveSelection(current: number, length: number, delta: number): number {
	if (length <= 0) return 0;
	return (current + delta % length + length) % length;
}

export function getHeaderTitle(args: {
	mode: BrowserMode;
	category: ResourceCategory;
	detailItem?: ResourceItem;
	packageItem?: ResourceItem;
	packageContentsCategory: PackageContentCategory;
}): string {
	const { mode, category, detailItem, packageItem, packageContentsCategory } = args;
	if (mode === "detail" && detailItem) return getDetailTitle(detailItem);
	if (mode === "settings") return "Resources / Settings";
	if (mode === "packageGroups" && packageItem && isPackageItem(packageItem)) {
		return `Packages / ${formatPackageLabel(packageItem.source)} / Contents`;
	}
	if (mode === "packageItems" && packageItem && isPackageItem(packageItem)) {
		return `Packages / ${formatPackageLabel(packageItem.source)} / ${CATEGORY_LABELS[packageContentsCategory]}`;
	}
	return `Resources / ${CATEGORY_LABELS[category]}`;
}

export function getDetailTitle(item: ResourceItem): string {
	if (isPackageItem(item)) return `Packages / ${formatPackageLabel(item.source)}`;
	if (isContainedResource(item)) return `Packages / ${formatPackageLabel(item.packageSource!)} / ${CATEGORY_LABELS[item.category]} / ${item.name}`;
	return `Resources / ${CATEGORY_LABELS[item.category]} / ${item.name}`;
}

export function getListFooterText(selectedCategory: ResourceCategory): string {
	return selectedCategory === "packages"
		? "Tab switch · ↑↓ move · Space enable/disable all contents · P pin/unpin · Enter details · Esc close"
		: "Tab switch · ↑↓ move · Space toggle · P pin/unpin · Enter details · Esc close";
}

export function getDetailFooterText(): string {
	return "↑↓ move · Enter confirm · P pin/unpin · Esc back";
}

export function getPackageFooterText(mode: BrowserMode, selectedEntry?: PackageGroupEntry): string {
	if (mode === "packageGroups") {
		return selectedEntry?.kind === "item"
			? "Type to search · ↑↓ move · Space toggle · P pin/unpin · Enter details · Esc back"
			: "Type to search · ↑↓ move · Enter open full list · Esc back";
	}
	return "Type to search · ↑↓ move · Enter details · Space toggle · P pin/unpin · Esc back";
}

export function getEmptyPackageCategoryMessage(category: PackageContentCategory, hasSearchQuery: boolean): string {
	if (hasSearchQuery) {
		return `No ${CATEGORY_LABELS[category].toLowerCase()} match the current search`;
	}
	switch (category) {
		case "extensions":
			return "This package doesn't provide any extensions";
		case "skills":
			return "This package doesn't provide any skills";
		case "prompts":
			return "This package doesn't provide any prompts";
		case "themes":
			return "This package doesn't provide any themes";
	}
}
