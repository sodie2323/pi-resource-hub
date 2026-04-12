/**
 * 统一资源身份与归属判断规则，例如 resource id、package id 与匹配字段。
 */
import { type ResourceItem, type ResourceScope } from "../types.js";

export function getPackageKey(scope: ResourceScope, source: string): string {
	return `${scope}:${source}`;
}

export function getPackageResourceId(scope: ResourceScope, source: string): string {
	return `packages:${getPackageKey(scope, source)}`;
}

export function getResourceId(item: Pick<ResourceItem, "id">): string {
	return item.id;
}

export function isSameResource(a: Pick<ResourceItem, "id"> | undefined, b: Pick<ResourceItem, "id"> | undefined): boolean {
	return Boolean(a && b && a.id === b.id);
}

export function belongsToPackage(item: ResourceItem, pkg: Pick<ResourceItem, "category" | "scope" | "source">): boolean {
	return pkg.category === "packages" && item.packageSource === pkg.source && item.scope === pkg.scope;
}

export function getResourceSearchCandidates(item: ResourceItem): string[] {
	const candidates = [item.id, item.name, item.source, item.description];
	if (item.packageRelativePath) candidates.push(item.packageRelativePath);
	if ("path" in item && item.path) candidates.push(item.path);
	return candidates;
}
