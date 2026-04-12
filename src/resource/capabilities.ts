/**
 * 统一描述不同资源具备哪些能力，例如 expose、remove、update 等。
 */
import { isRemotePackageSource, type PackageResourceItem, type ResourceItem, type ThemeResourceItem } from "../types.js";

export function isPackageItem(item: ResourceItem): item is PackageResourceItem {
	return item.category === "packages";
}

export function isThemeItem(item: ResourceItem): item is ThemeResourceItem {
	return item.category === "themes";
}

export function isContainedResource(item: ResourceItem): boolean {
	return Boolean(item.packageSource);
}

export function canManagePackageContents(item: ResourceItem): boolean {
	return isPackageItem(item);
}

export function canExposeResource(item: ResourceItem): boolean {
	return isContainedResource(item) && !isPackageItem(item) && !isThemeItem(item);
}

export function isBuiltinTheme(item: ResourceItem): boolean {
	return isThemeItem(item) && !("path" in item);
}

export function canRemoveResourceIndividually(item: ResourceItem): boolean {
	return !isContainedResource(item) && !isBuiltinTheme(item);
}

export function supportsPackageUpdate(item: ResourceItem): boolean {
	return isPackageItem(item) && isRemotePackageSource(item.source);
}
