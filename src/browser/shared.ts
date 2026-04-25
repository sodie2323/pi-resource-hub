/**
 * browser 子模块共享的常量、类型和辅助函数。
 */
import { basename } from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AddPathCategory } from "../resource/add-detect.js";
import type { ResourceCenterSettings } from "../settings.js";
import type { ResourceCategory, ResourceItem, ResourceScope } from "../types.js";

export const CATEGORY_ORDER: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];

export const CATEGORY_LABELS: Record<ResourceCategory, string> = {
	packages: "Packages",
	skills: "Skills",
	extensions: "Extensions",
	prompts: "Prompts",
	themes: "Themes",
};

export type BrowserMode = "list" | "detail" | "packageGroups" | "packageItems" | "settings" | "add";
export type DetailAction = "manage" | "toggle" | "pin" | "expose" | "update" | "remove" | "back";
export type PackageContentCategory = Exclude<ResourceCategory, "packages">;
export const PACKAGE_CONTENT_CATEGORIES: PackageContentCategory[] = ["extensions", "skills", "prompts", "themes"];

export type SettingsSection = "all" | "display" | "packages" | "search" | "integrations";
export const SETTINGS_SECTION_ORDER: SettingsSection[] = ["all", "display", "packages", "search", "integrations"];
export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
	all: "All",
	display: "Display",
	packages: "Packages",
	search: "Search",
	integrations: "Integrations",
};

export const SORT_MODE_LABELS: Record<ResourceCenterSettings["sortMode"], string> = {
	updated: "Recently updated (newest first)",
	default: "As discovered (no re-sorting)",
	name: "Name (A → Z)",
	enabled: "Enabled first",
	scope: "Scope: Project → User",
};

export const SORT_MODE_VALUES = Object.values(SORT_MODE_LABELS);
export const RELOAD_BEHAVIOR_LABELS: Record<ResourceCenterSettings["reloadBehavior"], string> = {
	notice: "Only show /reload hint",
	prompt: "Ask before reload",
	auto: "Reload automatically",
};
export const RELOAD_BEHAVIOR_VALUES = Object.values(RELOAD_BEHAVIOR_LABELS);

export function sortModeFromLabel(label: string): ResourceCenterSettings["sortMode"] {
	const entry = (Object.entries(SORT_MODE_LABELS) as Array<[ResourceCenterSettings["sortMode"], string]>).find(([, value]) => value === label);
	return entry?.[0] ?? "updated";
}

export function reloadBehaviorFromLabel(label: string): ResourceCenterSettings["reloadBehavior"] {
	const entry = (Object.entries(RELOAD_BEHAVIOR_LABELS) as Array<[ResourceCenterSettings["reloadBehavior"], string]>).find(([, value]) => value === label);
	return entry?.[0] ?? "notice";
}

export function formatPackageLabel(source: string): string {
	if (source.startsWith("npm:")) return source;
	if (source.startsWith("git:")) return source;
	if (source.startsWith("http://") || source.startsWith("https://")) return source;
	return `local:${basename(source.replace(/[\\/]+$/, "")) || source}`;
}

export function formatResourceSourceLabel(item: ResourceItem): string {
	if (item.packageSource) return formatPackageLabel(item.packageSource);
	if (item.category === "packages") return formatPackageLabel(item.source);
	return item.sourceLabel ?? item.source;
}

export type PackageGroupEntry =
	| { kind: "category"; category: PackageContentCategory }
	| { kind: "item"; category: PackageContentCategory; item: ResourceItem }
	| { kind: "more"; category: PackageContentCategory; remaining: number };

export type BrowserListEntry =
	| { kind: "resource"; item: ResourceItem }
	| {
			kind: "plugin-group";
			pluginId: string;
			pluginName: string;
			scope: ResourceScope;
			sourceLabel: string;
			items: ResourceItem[];
			enabledCount: number;
			totalCount: number;
			expanded: boolean;
			updatedAt?: number;
	  }
	| { kind: "plugin-child"; pluginId: string; item: ResourceItem };

export interface AddResourceRequest {
	input: string;
	scope: "project" | "user";
	preferredCategory?: AddPathCategory;
}

export interface BrowserCallbacks {
	onClose: () => void | Promise<void>;
	onInspect?: (item: ResourceItem) => void;
	onToggle?: (item: ResourceItem) => void;
	onToggleGroup?: (items: ResourceItem[], enabled: boolean, label: string) => void | Promise<void>;
	onExpose?: (item: ResourceItem) => void;
	onUpdate?: (item: ResourceItem) => void;
	onRemove?: (item: ResourceItem) => void;
	onAdd?: (request: AddResourceRequest) => void | Promise<void>;
	onSettingsChange?: (settings: ResourceCenterSettings) => void | Promise<void>;
	onRequestRender?: () => void;
}

export type ActionMessage = { action: DetailAction; type: "info" | "warning" | "error"; text: string };

export type BrowserTheme = Theme;
