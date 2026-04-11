export type ResourceCategory = "packages" | "skills" | "extensions" | "prompts" | "themes";

export type ResourceScope = "project" | "user";

export interface PackageResourceCounts {
	extensions: number;
	skills: number;
	prompts: number;
	themes: number;
}

export interface PackageEnabledSummary {
	enabledCount: number;
	totalCount: number;
}

export interface PackageResourceItem {
	category: "packages";
	id: string;
	name: string;
	scope: ResourceScope;
	source: string;
	description: string;
	enabled: boolean;
	counts?: PackageResourceCounts;
	enabledSummary?: PackageEnabledSummary;
	installPath?: string;
	packageSource?: string;
	packageRelativePath?: string;
	exposed?: boolean;
}

export interface FileResourceItem {
	category: Exclude<ResourceCategory, "packages" | "themes">;
	id: string;
	name: string;
	scope: ResourceScope;
	path: string;
	source: string;
	description: string;
	enabled: boolean;
	packageSource?: string;
	packageRelativePath?: string;
	exposed?: boolean;
}

export interface ThemeResourceItem {
	category: "themes";
	id: string;
	name: string;
	scope: ResourceScope;
	source: string;
	description: string;
	enabled: boolean;
	path?: string;
	builtin?: boolean;
	packageSource?: string;
	packageRelativePath?: string;
	exposed?: boolean;
}

export type ResourceItem = PackageResourceItem | FileResourceItem | ThemeResourceItem;

export interface ResourceIndex {
	categories: Record<ResourceCategory, ResourceItem[]>;
}

export const REMOTE_PACKAGE_PREFIXES = ["npm:", "git:", "http://", "https://"] as const;

export function isRemotePackageSource(source: string): boolean {
	return REMOTE_PACKAGE_PREFIXES.some((prefix) => source.startsWith(prefix));
}
