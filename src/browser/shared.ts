/**
 * browser 子模块共享的常量、类型和辅助函数。
 */
import { basename } from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { ResourceCenterSettings } from "../settings.js";
import type { ResourceCategory, ResourceItem } from "../types.js";

export const CATEGORY_ORDER: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];

export const CATEGORY_LABELS: Record<ResourceCategory, string> = {
	packages: "Packages",
	skills: "Skills",
	extensions: "Extensions",
	prompts: "Prompts",
	themes: "Themes",
};

export type BrowserMode = "list" | "detail" | "packageGroups" | "packageItems" | "settings";
export type DetailAction = "manage" | "toggle" | "pin" | "expose" | "update" | "remove" | "back";
export type PackageContentCategory = Exclude<ResourceCategory, "packages">;
export const PACKAGE_CONTENT_CATEGORIES: PackageContentCategory[] = ["extensions", "skills", "prompts", "themes"];

export type SettingsSection = "all" | "display" | "packages" | "search";
export const SETTINGS_SECTION_ORDER: SettingsSection[] = ["all", "display", "packages", "search"];
export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
	all: "All",
	display: "Display",
	packages: "Packages",
	search: "Search",
};

export const SORT_MODE_LABELS: Record<ResourceCenterSettings["sortMode"], string> = {
	updated: "Recently updated (newest first)",
	default: "As discovered (no re-sorting)",
	name: "Name (A → Z)",
	enabled: "Enabled first",
	scope: "Scope: Project → User",
};

export const SORT_MODE_VALUES = Object.values(SORT_MODE_LABELS);

export function sortModeFromLabel(label: string): ResourceCenterSettings["sortMode"] {
	const entry = (Object.entries(SORT_MODE_LABELS) as Array<[ResourceCenterSettings["sortMode"], string]>).find(([, value]) => value === label);
	return entry?.[0] ?? "updated";
}

export function formatPackageLabel(source: string): string {
	if (source.startsWith("npm:")) return source;
	if (source.startsWith("git:")) return source;
	if (source.startsWith("http://") || source.startsWith("https://")) return source;
	return `local:${basename(source.replace(/[\\/]+$/, "")) || source}`;
}

export type PackageGroupEntry =
	| { kind: "category"; category: PackageContentCategory }
	| { kind: "item"; category: PackageContentCategory; item: ResourceItem }
	| { kind: "more"; category: PackageContentCategory; remaining: number };

export interface BrowserCallbacks {
	onClose: () => void | Promise<void>;
	onInspect?: (item: ResourceItem) => void;
	onToggle?: (item: ResourceItem) => void;
	onExpose?: (item: ResourceItem) => void;
	onUpdate?: (item: ResourceItem) => void;
	onRemove?: (item: ResourceItem) => void;
	onSettingsChange?: (settings: ResourceCenterSettings) => void | Promise<void>;
}

export type ActionMessage = { action: DetailAction; type: "info" | "warning" | "error"; text: string };

export type BrowserTheme = Theme;
