/**
 * 资源浏览器核心状态容器：负责协调 UI 状态、渲染适配、缓存与回调。
 */
import { access, readdir } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { getSettingsListTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { DEFAULT_EXTERNAL_SKILL_SOURCES, type ResourceCenterSettings } from "../settings.js";
import {
	type Component,
	type Focusable,
	Input,
	fuzzyFilter,
	getKeybindings,
	SettingsList,
	type SettingItem,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import {
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	PACKAGE_CONTENT_CATEGORIES,
	RELOAD_BEHAVIOR_LABELS,
	RELOAD_BEHAVIOR_VALUES,
	SETTINGS_SECTION_ORDER,
	SORT_MODE_LABELS,
	SORT_MODE_VALUES,
	reloadBehaviorFromLabel,
	sortModeFromLabel,
	type BrowserCallbacks,
	type BrowserMode,
	type DetailAction,
	type PackageContentCategory,
	type PackageGroupEntry,
	type SettingsSection,
} from "./shared.js";
import {
	buildPackageGroupEntries,
	getFilteredPackageContainedItems as filterPackageContainedItems,
	getPackageContainedItems as selectPackageContainedItems,
	getVisibleCategoryItems as selectVisibleCategoryItems,
} from "./selectors.js";
import {
	renderDescriptionBlock as renderDescriptionBlockView,
	renderDetailPage as renderDetailPageView,
	renderFooterWithSettingsHint as renderFooterWithSettingsHintView,
	renderHeader as renderHeaderView,
	renderListPage as renderListPageView,
	renderPackageGroupsPage as renderPackageGroupsPageView,
	renderPackageItemsPage as renderPackageItemsPageView,
	renderSearch as renderSearchView,
	renderSettingsSearch as renderSettingsSearchView,
	renderSettingsTabs as renderSettingsTabsView,
	renderTabs as renderTabsView,
	renderTopRule as renderTopRuleView,
	wrapBlock as wrapBlockView,
} from "./render.js";
import { getDetailActionHint, getDetailActionLabel, getDetailActions } from "./actions.js";
import {
	handleDetailInput as handleDetailInputMode,
	handleListInput,
	handlePackageGroupsInput as handlePackageGroupsInputMode,
	handlePackageItemsInput as handlePackageItemsInputMode,
	handleSettingsInput as handleSettingsInputMode,
} from "./input.js";
import { getAddFooterText, getDetailFooterText, getEmptyPackageCategoryMessage, getHeaderTitle, getListFooterText, getPackageFooterText, moveSelection } from "./navigation.js";
import { isContainedResource, isPackageItem, isThemeItem } from "../resource/capabilities.js";
import { getPackageResourceId, isSameResource } from "../resource/identity.js";
import { prunePinnedResourceIds } from "../resource/state-prune.js";
import { detectAddTargetSync, type AddPathCategory, type AddTarget } from "../resource/add-detect.js";
import type { ResourceCategory, ResourceIndex, ResourceItem } from "../types.js";

const ADD_SOURCE_SUGGESTIONS = [
	{ value: "npm:", description: "Install a package from npm" },
	{ value: "git:", description: "Install a package from a git URL" },
	{ value: "https://", description: "Install a package from a remote HTTPS URL" },
	{ value: "http://", description: "Install a package from a remote HTTP URL" },
	{ value: "./", description: "Install a package from a local path relative to the current project" },
	{ value: "../", description: "Install a package from a sibling or parent directory" },
	{ value: "/", description: "Install a package from an absolute path" },
	{ value: "E:/", description: "Install a package from an absolute Windows path" },
	{ value: "C:/", description: "Install a package from an absolute Windows path" },
] as const;
const NOISY_DIRECTORY_NAMES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

type AddSuggestion = { value: string; label: string; description?: string };

export class ResourceBrowser implements Component, Focusable {
	private readonly theme: Theme;
	private readonly callbacks: BrowserCallbacks;
	private readonly cwd: string;
	private readonly mainSearchInput: Input;
	private readonly packageSearchInput: Input;
	private readonly settingsSearchInput: Input;
	private readonly addInput: Input;
	private readonly resources: ResourceIndex;
	private settings: ResourceCenterSettings;
	private category: ResourceCategory;
	private filteredItems: ResourceItem[] = [];
	private selectedIndex = 0;
	private maxVisible = 8;
	private mode: BrowserMode = "list";
	private settingsReturnMode: Exclude<BrowserMode, "settings"> = "list";
	private detailItem: ResourceItem | undefined;
	private detailSelectedIndex = 0;
	private detailReturnMode: Exclude<BrowserMode, "detail"> = "list";
	private packageItem: ResourceItem | undefined;
	private packageGroupSelectionIndex = 0;
	private packageContentsCategory: PackageContentCategory = "extensions";
	private packageContentsItems: ResourceItem[] = [];
	private packageContentsSelectedIndex = 0;
	private settingsSection: SettingsSection = "all";
	private settingsList: SettingsList | undefined;
	private settingsListSection: SettingsSection | undefined;
	private settingsListQuery: string | undefined;
	private settingsInlineEditItemId: string | undefined;
	private settingsInlineEditInput: Input | undefined;
	private settingsInlineEditOriginalValue: string | undefined;
	private addScope: "project" | "user" = "project";
	private addDetection: AddTarget = { kind: "invalid", reason: "Enter a package source or local path." };
	private addSelectedCandidateIndex = 0;
	private addSuggestions: AddSuggestion[] = [];
	private addSelectedSuggestionIndex = 0;
	private addLoading = false;
	private addLoadingText: string | undefined;
	private addMessage: { type: "info" | "warning" | "error"; text: string } | undefined;
	private globalStatus: { type: "info" | "warning" | "error" | "loading"; text: string } | undefined;
	private addRequestId = 0;
	private addReturnMode: Exclude<BrowserMode, "add"> = "list";
	private visibleCategoryItemsCache = new Map<ResourceCategory, ResourceItem[]>();
	private searchTextCache = new Map<string, { base: string; withDescription: string; withPath: string; withDescriptionAndPath: string }>();
	private containedItemsCache = new Map<string, ResourceItem[]>();
	private filteredPackageItemsCache = new Map<string, ResourceItem[]>();
	private pinnedRank = new Map<string, number>();
	private packageGroupEntriesCache:
		| {
				packageId: string;
				query: string;
				entries: PackageGroupEntry[];
		  }
		| undefined;
	private confirmingRemove = false;
	private actionMessage: { action: DetailAction; type: "info" | "warning" | "error"; text: string } | undefined;
	private loadingAction: DetailAction | undefined;
	private loadingText: string | undefined;
	private loadingFrame = 0;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.mainSearchInput.focused = value;
		this.packageSearchInput.focused = value;
		this.settingsSearchInput.focused = value;
		this.addInput.focused = value;
	}

	constructor(theme: Theme, resources: ResourceIndex, category: ResourceCategory, settings: ResourceCenterSettings, callbacks: BrowserCallbacks, cwd: string) {
		this.theme = theme;
		this.resources = resources;
		this.settings = prunePinnedResourceIds(settings, resources);
		this.category = category;
		this.callbacks = callbacks;
		this.cwd = cwd;
		this.mainSearchInput = new Input();
		this.packageSearchInput = new Input();
		this.settingsSearchInput = new Input();
		this.addInput = new Input();
		this.mainSearchInput.setValue("");
		this.packageSearchInput.setValue("");
		this.settingsSearchInput.setValue("");
		this.addInput.setValue("");
		this.rebuildPinnedRank();
		this.rebuildSearchTextCache();
		this.persistPrunedSettings(settings);
		this.applyFilter();
	}

	invalidate(): void {
		this.mainSearchInput.invalidate();
		this.packageSearchInput.invalidate();
		this.settingsSearchInput.invalidate();
		this.addInput.invalidate();
		this.settingsList?.invalidate();
	}

	private invalidatePackageCaches(): void {
		this.visibleCategoryItemsCache.clear();
		this.containedItemsCache.clear();
		this.filteredPackageItemsCache.clear();
		this.packageGroupEntriesCache = undefined;
	}

	private invalidateVisibleCategoryCache(category: ResourceCategory): void {
		this.visibleCategoryItemsCache.delete(category);
	}

	private invalidatePackageViewCaches(packageId?: string, category?: PackageContentCategory): void {
		if (!packageId) {
			this.containedItemsCache.clear();
			this.filteredPackageItemsCache.clear();
			this.packageGroupEntriesCache = undefined;
			return;
		}

		const containedPrefix = category ? `${packageId}:${category}` : `${packageId}:`;
		for (const key of [...this.containedItemsCache.keys()]) {
			if (key.startsWith(containedPrefix)) this.containedItemsCache.delete(key);
		}
		for (const key of [...this.filteredPackageItemsCache.keys()]) {
			if (key.startsWith(containedPrefix)) this.filteredPackageItemsCache.delete(key);
		}
		if (!this.packageGroupEntriesCache || this.packageGroupEntriesCache.packageId !== packageId) return;
		this.packageGroupEntriesCache = undefined;
	}

	private invalidateItemCaches(item: ResourceItem): void {
		this.invalidateVisibleCategoryCache(item.category);
		if (isPackageItem(item)) {
			this.invalidatePackageViewCaches(item.id);
			return;
		}
		if (!isContainedResource(item)) return;
		this.invalidatePackageViewCaches(getPackageResourceId(item.scope, item.packageSource), item.category);
	}

	handleInput(data: string): void {
		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		if (this.mode === "packageGroups") {
			this.handlePackageGroupsInput(data);
			return;
		}
		if (this.mode === "packageItems") {
			this.handlePackageItemsInput(data);
			return;
		}
		if (this.mode === "settings") {
			this.handleSettingsInput(data);
			return;
		}
		if (this.mode === "add") {
			this.handleAddInput(data);
			return;
		}

		handleListInput(data, {
			selectedItem: this.filteredItems[this.selectedIndex],
			maxVisible: this.maxVisible,
			onOpenSettings: () => this.openSettings(),
			onClose: () => this.callbacks.onClose(),
			onMoveCategory: (direction) => this.moveCategory(direction),
			onMoveSelection: (delta) => this.moveListSelection(delta),
			onOpenSelectedItem: () => this.openSelectedItem(),
			onTogglePinned: (item) => this.togglePinned(item),
			onToggleItem: (item) => this.toggleItem(item),
			onAddResource: () => this.openAddMode(),
			searchInput: this.mainSearchInput,
			onApplyFilter: () => this.applyFilter(),
		});
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		const globalStatus = this.renderGlobalStatus(width);
		if (globalStatus) lines.push(globalStatus);
		lines.push(this.renderTopRule(width));
		lines.push(...this.wrapBlock(this.renderHeader(innerWidth), width));
		if (this.mode === "detail") {
			lines.push("");
			lines.push(...this.wrapBlock(this.renderDetailPage(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock([this.renderDetailFooter(innerWidth)], width));
			lines.push(this.renderTopRule(width));
			return lines;
		}
		if (this.mode === "settings") {
			lines.push(...this.wrapBlock(this.renderSettingsTabs(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock(this.renderSettingsSearch(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock(this.renderSettingsList(innerWidth), width));
			return lines;
		}
		if (this.mode === "add") {
			lines.push("");
			lines.push(...this.wrapBlock(this.renderAddPage(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock([this.renderAddFooter(innerWidth)], width));
			lines.push(this.renderTopRule(width));
			return lines;
		}
		if (this.mode === "packageGroups") {
			lines.push("");
			lines.push(...this.wrapBlock(this.renderSearch(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock(this.renderPackageGroupsPage(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock([this.renderPackageFooter(innerWidth)], width));
			lines.push(this.renderTopRule(width));
			return lines;
		}
		if (this.mode === "packageItems") {
			lines.push("");
			lines.push(...this.wrapBlock(this.renderSearch(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock(this.renderPackageItemsPage(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock([this.renderPackageFooter(innerWidth)], width));
			lines.push(this.renderTopRule(width));
			return lines;
		}
		lines.push(...this.wrapBlock(this.renderTabs(innerWidth), width));
		lines.push("");
		lines.push(...this.wrapBlock(this.renderSearch(innerWidth), width));
		lines.push("");
		lines.push(...this.wrapBlock(this.renderList(innerWidth), width));
		lines.push("");
		lines.push(...this.wrapBlock([this.renderFooter(innerWidth)], width));
		lines.push(this.renderTopRule(width));
		return lines;
	}

	private renderHeader(width: number): string[] {
		const count =
			this.mode === "settings"
				? this.getFilteredSettingsItems(this.settingsSection).length
				: this.mode === "add"
					? 1
					: this.mode === "packageItems"
					? this.packageContentsItems.length
					: this.mode === "packageGroups"
						? this.getPackageGroupEntries().length
						: this.filteredItems.length;
		return renderHeaderView(this.theme, width, this.getHeaderTitle(), count);
	}

	private renderTabs(width: number): string[] {
		return renderTabsView(this.theme, width, this.category);
	}

	private renderSearch(width: number): string[] {
		const mode = this.mode === "packageGroups" ? "packageGroups" : this.mode === "packageItems" ? "packageItems" : "list";
		const label = mode === "packageGroups"
			? "Search in package:"
			: mode === "packageItems"
				? `Search in ${CATEGORY_LABELS[this.packageContentsCategory].toLowerCase()}:`
				: "Search:";
		const inputWidth = Math.max(1, width - label.length - 1);
		const inputLines = this.getActiveSearchInput().render(inputWidth);
		return renderSearchView(this.theme, width, mode, this.packageContentsCategory, inputLines[0] ?? "");
	}

	private renderList(width: number): string[] {
		return renderListPageView({
			theme: this.theme,
			width,
			items: this.filteredItems,
			selectedIndex: this.selectedIndex,
			maxVisible: this.maxVisible,
			isPinned: (item) => this.isPinned(item),
			formatPackageToggleState: (item) => this.formatPackageToggleState(item),
			formatBinaryToggle: (enabled, bold) => this.formatBinaryToggle(enabled, bold),
		});
	}

	private renderDetailPage(width: number): string[] {
		return renderDetailPageView({
			theme: this.theme,
			width,
			item: this.detailItem,
			settings: this.settings,
			isPinned: (item) => this.isPinned(item),
			detailSelectedIndex: this.detailSelectedIndex,
			getDetailActions: (item) => getDetailActions(item),
			getDetailActionLabel: (action, item, selected) => getDetailActionLabel(this.theme, action, item, { isPinned: this.isPinned(item), selected }),
			getPersistedActionHint: (action) => this.getPersistedActionHint(action),
			getDetailActionHint: (action, item) => getDetailActionHint(this.theme, action, item, { isPinned: this.isPinned(item), confirmingRemove: this.confirmingRemove }),
			formatPackageEnabledStateText: (item) => this.formatPackageEnabledStateText(item),
			formatPackageEnabledSummary: (item) => this.formatPackageEnabledSummary(item),
			formatPackageCounts: (item, detailed, dimmed) => this.formatPackageCounts(item, detailed, dimmed),
		});
	}

	private renderPackageGroupsPage(width: number): string[] {
		return renderPackageGroupsPageView({
			theme: this.theme,
			width,
			pkg: this.packageItem,
			entries: this.getPackageGroupEntries(),
			selectedIndex: this.packageGroupSelectionIndex,
			isPinned: (item) => this.isPinned(item),
			getItemsForCategory: (category) => this.packageItem ? this.getPackageContainedItems(this.packageItem, category) : [],
			formatBinaryToggle: (enabled, bold) => this.formatBinaryToggle(enabled, bold),
		});
	}

	private renderPackageItemsPage(width: number): string[] {
		return renderPackageItemsPageView({
			theme: this.theme,
			width,
			pkg: this.packageItem,
			items: this.packageContentsItems,
			selectedIndex: this.packageContentsSelectedIndex,
			isPinned: (item) => this.isPinned(item),
			emptyMessage: this.getEmptyPackageCategoryMessage(this.packageContentsCategory),
			formatBinaryToggle: (enabled, bold) => this.formatBinaryToggle(enabled, bold),
		});
	}

	private renderFooter(width: number): string {
		const selectedCategory = this.filteredItems[this.selectedIndex]?.category ?? this.category;
		return this.renderFooterWithSettingsHint(width, getListFooterText(selectedCategory));
	}

	private renderAddPage(width: number): string[] {
		const scopeLabel = this.addScope === "project"
			? this.theme.fg("success", "project")
			: this.theme.fg("warning", "user");
		const lines = [
			truncateToWidth(`Scope: ${scopeLabel}  ${this.theme.fg("dim", "(Tab to switch)")}`, width, "…"),
			truncateToWidth(`Source: ${this.addInput.render(Math.max(1, width - 8))[0] ?? ""}`, width, "…"),
		];
		if (this.addInput.getValue().trim() && this.addSuggestions.length > 0 && !this.addLoading) {
			lines.push("");
			for (const [index, suggestion] of this.addSuggestions.entries()) {
				const isSelected = index === this.addSelectedSuggestionIndex;
				const prefix = isSelected ? this.theme.fg("accent", "> ") : "  ";
				const label = isSelected ? this.theme.fg("accent", suggestion.label) : suggestion.label;
				const description = suggestion.description ? this.theme.fg("dim", `  ${suggestion.description}`) : "";
				lines.push(truncateToWidth(`${prefix}${label}${description}`, width, "…"));
			}
		}
		lines.push("");
		if (this.addDetection.kind === "package") {
			lines.push(truncateToWidth(this.theme.fg("success", `Detected: package · ${this.addDetection.description}`), width, "…"));
		} else if (this.addDetection.kind === "path") {
			lines.push(truncateToWidth(this.theme.fg("success", `Detected: ${this.formatAddCategoryLabel(this.addDetection.category)} · ${this.addDetection.description}`), width, "…"));
		} else if (this.addDetection.kind === "ambiguous") {
			lines.push(truncateToWidth(this.theme.fg("warning", this.addDetection.description), width, "…"));
			lines.push("");
			for (const [index, candidate] of this.addDetection.candidates.entries()) {
				const prefix = index === this.addSelectedCandidateIndex ? this.theme.fg("accent", "> ") : "  ";
				lines.push(truncateToWidth(`${prefix}${this.formatAddCategoryLabel(candidate)}`, width, "…"));
			}
		} else {
			lines.push(truncateToWidth(this.theme.fg("warning", this.addDetection.reason), width, "…"));
		}
		return lines;
	}

	private renderGlobalStatus(width: number): string | undefined {
		if (!this.globalStatus) return undefined;
		const hasInlineDetailStatus = this.mode === "detail" && (Boolean(this.loadingAction) || Boolean(this.actionMessage));
		if (hasInlineDetailStatus) return undefined;
		if (this.globalStatus.type === "loading") {
			const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
			const frame = frames[this.loadingFrame % frames.length]!;
			return truncateToWidth(`${this.theme.fg("accent", frame)} ${this.theme.fg("dim", this.globalStatus.text)}`, width, "…");
		}
		const color = this.globalStatus.type === "error" ? "error" : this.globalStatus.type === "warning" ? "warning" : "dim";
		return truncateToWidth(this.theme.fg(color, this.globalStatus.text), width, "…");
	}

	private renderDetailFooter(width: number): string {
		return this.renderFooterWithSettingsHint(width, getDetailFooterText());
	}

	private renderAddFooter(width: number): string {
		return this.renderFooterWithSettingsHint(width, getAddFooterText(this.addLoading));
	}

	private renderPackageFooter(width: number): string {
		const selected = this.getPackageGroupEntries()[this.packageGroupSelectionIndex];
		return this.renderFooterWithSettingsHint(width, getPackageFooterText(this.mode, selected));
	}

	private renderFooterWithSettingsHint(width: number, text: string): string {
		return renderFooterWithSettingsHintView(this.theme, width, text);
	}

	private renderSettingsTabs(width: number): string[] {
		return renderSettingsTabsView(this.theme, width, this.settingsSection);
	}

	private renderSettingsSearch(width: number): string[] {
		const input = this.settingsSearchInput.render(Math.max(1, width - 8))[0] ?? "";
		return renderSettingsSearchView(this.theme, width, input);
	}

	private renderDescriptionBlock(text: string, width: number): string[] {
		return renderDescriptionBlockView(this.theme, text, width);
	}

	private renderTopRule(width: number): string {
		return renderTopRuleView(this.theme, width);
	}

	private wrapBlock(lines: string[], width: number): string[] {
		return wrapBlockView(lines, width);
	}

	private formatBinaryToggle(enabled: boolean, bold = false): string {
		const label = enabled ? "[x]" : "[ ]";
		const text = bold ? this.theme.bold(label) : label;
		return enabled ? this.theme.fg("success", text) : this.theme.fg("dim", text);
	}

	private formatPackageCounts(item: ResourceItem, detailed = false, dimmed = false): string | undefined {
		if (item.category !== "packages" || !item.counts) return undefined;
		const labelColor = dimmed ? "dim" : undefined;
		const valueColor = dimmed ? "dim" : "muted";
		const counts = [
			`${labelColor ? this.theme.fg(labelColor, "ext") : this.theme.fg("accent", "ext")} ${this.theme.fg(valueColor, String(item.counts.extensions))}`,
			`${labelColor ? this.theme.fg(labelColor, "skills") : this.theme.fg("success", "skills")} ${this.theme.fg(valueColor, String(item.counts.skills))}`,
			`${labelColor ? this.theme.fg(labelColor, "prompts") : this.theme.fg("warning", "prompts")} ${this.theme.fg(valueColor, String(item.counts.prompts))}`,
			`${labelColor ? this.theme.fg(labelColor, "themes") : this.theme.fg("text", "themes")} ${this.theme.fg(valueColor, String(item.counts.themes))}`,
		];
		return detailed ? counts.join(this.theme.fg("dim", ", ")) : counts.join(this.theme.fg("dim", "  ·  "));
	}

	private formatPackageEnabledSummary(item: ResourceItem): string | undefined {
		const state = this.getPackageEnabledState(item);
		if (!state) return undefined;
		const summary = `${state.enabledCount}/${state.totalCount}`;
		if (state.enabledCount === 0) return this.theme.fg("dim", summary);
		if (state.enabledCount === state.totalCount) return this.theme.fg("success", summary);
		return this.theme.fg("warning", summary);
	}

	private formatPackageToggleState(item: ResourceItem): string {
		const state = this.getPackageEnabledState(item);
		if (!state) return this.theme.fg("dim", this.theme.bold("[0/0]"));
		const label = `[${state.enabledCount}/${state.totalCount}]`;
		if (state.enabledCount === 0) return this.theme.fg("dim", this.theme.bold(label));
		if (state.enabledCount === state.totalCount) return this.theme.fg("success", this.theme.bold(label));
		return this.theme.fg("warning", this.theme.bold(label));
	}

	private formatPackageEnabledStateText(item: ResourceItem): string {
		const state = this.getPackageEnabledState(item);
		if (!state || state.enabledCount === 0) return this.theme.fg("dim", "off");
		if (state.enabledCount === state.totalCount) return this.theme.fg("success", "on");
		return this.theme.fg("warning", "partial");
	}

	private getPackageEnabledState(item: ResourceItem): { enabledCount: number; totalCount: number } | undefined {
		if (item.category !== "packages") return undefined;
		if (item.enabledSummary) return item.enabledSummary;
		const containedItems = this.getPackageCategories().flatMap((category) => this.getPackageContainedItems(item, category));
		return { enabledCount: containedItems.filter((resource) => resource.enabled).length, totalCount: containedItems.length };
	}

	private handleDetailInput(data: string): void {
		handleDetailInputMode(data, {
			detailItem: this.detailItem,
			confirmingRemove: this.confirmingRemove,
			setConfirmingRemove: (value) => {
				this.confirmingRemove = value;
			},
			clearActionMessage: () => {
				this.actionMessage = undefined;
				this.clearTransientActionMessage();
			},
			detailSelectedIndex: this.detailSelectedIndex,
			setDetailSelectedIndex: (value) => {
				this.detailSelectedIndex = value;
			},
			loadingAction: this.loadingAction,
			onOpenSettings: () => this.openSettings(),
			onExitDetailMode: () => this.exitDetailMode(),
			onTogglePinned: (item) => this.togglePinned(item),
			onOpenPackageGroups: (item) => this.openPackageGroups(item),
			onToggleItem: (item) => this.toggleItem(item),
			onToggleExpose: (item) => this.toggleExpose(item),
			onUpdateItem: (item) => this.callbacks.onUpdate?.(item),
			onRemoveItem: (item) => this.callbacks.onRemove?.(item),
			onAddResource: () => this.openAddMode(),
		});
	}

	private handlePackageGroupsInput(data: string): void {
		handlePackageGroupsInputMode(data, {
			packageItem: this.packageItem,
			entries: this.getPackageGroupEntries(),
			selectedIndex: this.packageGroupSelectionIndex,
			setSelectedIndex: (value) => {
				this.packageGroupSelectionIndex = value;
			},
			onOpenSettings: () => this.openSettings(),
			onOpenDetailItem: (item) => this.openDetailItem(item, "packageGroups"),
			onOpenParentPackage: (item) => this.openDetailItem(item, "list"),
			onSetMode: (mode) => {
				this.mode = mode;
			},
			onSetPackageContentsCategory: (category) => {
				this.packageContentsCategory = category;
				this.packageContentsSelectedIndex = 0;
			},
			onRefreshPackageContents: () => this.refreshPackageContentsItems(),
			onTogglePinned: (item) => this.togglePinned(item),
			onToggleItem: (item) => this.toggleItem(item),
			onAddResource: () => this.openAddMode(),
			searchInput: this.packageSearchInput,
			getSearchQuery: () => this.getSearchQuery(),
			onInvalidatePackageViewCaches: (packageId) => this.invalidatePackageViewCaches(packageId),
			onGetEntriesLength: () => this.getPackageGroupEntries().length,
		});
	}

	private handleSettingsInput(data: string): void {
		const kb = getKeybindings();
		if (this.settingsInlineEditItemId && this.settingsInlineEditInput) {
			if (kb.matches(data, "tui.select.confirm")) {
				this.stopInlineSettingsEdit(true);
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.stopInlineSettingsEdit(false);
				return;
			}
			this.settingsInlineEditInput.handleInput(data);
			return;
		}

		const selectedItem = this.getSelectedSettingsItem();
		if (selectedItem?.id.startsWith("externalSkillSourceRow:")) {
			if (kb.matches(data, "tui.select.confirm")) {
				this.startInlineSettingsEdit(selectedItem);
				return;
			}
			if (data === " ") {
				const sourceId = selectedItem.id.slice("externalSkillSourceRow:".length);
				const nextExternalSkillSources = this.settings.externalSkillSources.map((entry) => entry.id === sourceId ? { ...entry, enabled: !entry.enabled } : entry);
				this.settings = { ...this.settings, externalSkillSources: nextExternalSkillSources };
				const updated = nextExternalSkillSources.find((entry) => entry.id === sourceId);
				if (updated) {
					this.ensureSettingsList().updateValue(selectedItem.id, `${updated.enabled ? "on " : "off"}  ${updated.path}`);
				}
				this.callbacks.onSettingsChange?.(this.settings);
				this.invalidatePackageCaches();
				this.applyFilter();
				return;
			}
			if (data === "r" || data === "R") {
				const sourceId = selectedItem.id.slice("externalSkillSourceRow:".length);
				if (this.isCustomExternalSkillSource(sourceId)) {
					this.applySettingsChange(`externalSkillSourceRemove:${sourceId}`, "remove");
					this.settingsList = undefined;
					this.settingsListSection = undefined;
					this.settingsListQuery = undefined;
				}
				return;
			}
		}
		if ((data === "a" || data === "A") && this.settingsSection === "integrations") {
			this.applySettingsChange("externalSkillSourceAdd", "add");
			this.settingsList = undefined;
			this.settingsListSection = undefined;
			this.settingsListQuery = undefined;
			return;
		}

		handleSettingsInputMode(data, {
			settingsReturnMode: this.settingsReturnMode,
			onSetMode: (mode) => {
				this.mode = mode;
			},
			onMoveSettingsSection: (delta) => this.moveSettingsSection(delta),
			settingsList: () => this.ensureSettingsList(),
			searchInput: this.settingsSearchInput,
			onResetSettingsListCache: () => {
				this.settingsList = undefined;
				this.settingsListSection = undefined;
				this.settingsListQuery = undefined;
			},
		});
	}

	private handlePackageItemsInput(data: string): void {
		handlePackageItemsInputMode(data, {
			selectedItem: this.packageContentsItems[this.packageContentsSelectedIndex],
			itemsLength: this.packageContentsItems.length,
			selectedIndex: this.packageContentsSelectedIndex,
			setSelectedIndex: (value) => {
				this.packageContentsSelectedIndex = value;
			},
			packageItem: this.packageItem,
			packageContentsCategory: this.packageContentsCategory,
			onOpenSettings: () => this.openSettings(),
			onSetMode: (mode) => {
				this.mode = mode;
			},
			onOpenDetailItem: (item) => this.openDetailItem(item, "packageItems"),
			onTogglePinned: (item) => this.togglePinned(item),
			onToggleItem: (item) => this.toggleItem(item),
			onAddResource: () => this.openAddMode(),
			searchInput: this.packageSearchInput,
			getSearchQuery: () => this.getSearchQuery(),
			onInvalidatePackageViewCaches: (packageId, category) => this.invalidatePackageViewCaches(packageId, category),
			onRefreshPackageContents: () => this.refreshPackageContentsItems(),
		});
	}

	private getPersistedActionHint(action: DetailAction): string | undefined {
		if (this.loadingAction === action) {
			const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
			const frame = frames[this.loadingFrame % frames.length]!;
			return `${this.theme.fg("accent", frame)} ${this.theme.fg("dim", this.loadingText ?? "Working...")}`;
		}
		if (!this.actionMessage || this.actionMessage.action !== action) return undefined;
		const color =
			this.actionMessage.type === "error"
				? "error"
				: this.actionMessage.type === "warning"
					? "warning"
					: "dim";
		return this.theme.fg(color, this.actionMessage.text);
	}

	public setActionMessage(action: DetailAction, type: "info" | "warning" | "error", text: string | undefined): void {
		if (!text) {
			this.actionMessage = undefined;
			return;
		}
		if (this.loadingAction === action) {
			this.loadingAction = undefined;
			this.loadingText = undefined;
		}
		const normalized = text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.join(" · ")
			.replace(/\s+/g, " ")
			.trim();
		this.actionMessage = normalized ? { action, type, text: normalized } : undefined;
	}

	public startActionLoading(action: DetailAction, text: string): void {
		this.loadingAction = action;
		this.loadingText = text;
		this.loadingFrame = 0;
		this.globalStatus = { type: "loading", text };
		if (this.actionMessage?.action === action) {
			this.actionMessage = undefined;
		}
	}

	public stopActionLoading(action?: DetailAction): void {
		if (!action || this.loadingAction === action) {
			this.loadingAction = undefined;
			this.loadingText = undefined;
		}
	}

	public setGlobalStatus(type: "info" | "warning" | "error" | "loading", text: string | undefined): void {
		if (!text) {
			this.globalStatus = undefined;
			return;
		}
		const normalized = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
		this.globalStatus = normalized ? { type, text: normalized } : undefined;
	}

	private clearTransientActionMessage(): void {
		if (!this.loadingAction) {
			this.actionMessage = undefined;
		}
	}

	public advanceLoadingFrame(): void {
		if (!this.loadingAction && !this.addLoading) return;
		this.loadingFrame += 1;
	}

	public hasLoadingState(): boolean {
		return Boolean(this.loadingAction || this.addLoading);
	}

	public setResources(resources: ResourceIndex): void {
		for (const category of CATEGORY_ORDER) {
			this.resources.categories[category] = resources.categories[category];
		}
		this.rebuildSearchTextCache();
		this.pruneSettingsState();
		this.invalidatePackageCaches();
		if (this.detailItem) {
			this.detailItem = this.resources.categories[this.detailItem.category].find((item) => isSameResource(item, this.detailItem));
			if (!this.detailItem) {
				this.exitDetailMode();
			}
		}
		if (this.packageItem?.category === "packages") {
			this.packageItem = this.resources.categories.packages.find((item) => isSameResource(item, this.packageItem));
			if (!this.packageItem) {
				this.mode = "list";
			}
		}
		if (this.mode === "packageGroups") {
			this.packageGroupSelectionIndex = Math.max(
				0,
				Math.min(this.packageGroupSelectionIndex, Math.max(0, this.getPackageGroupEntries().length - 1)),
			);
		}
		if (this.mode === "packageItems" && this.packageItem?.category === "packages") {
			this.refreshPackageContentsItems();
		}
		this.applyFilter();
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filteredItems.length - 1));
	}

	public removeItem(item: ResourceItem): void {
		for (const category of CATEGORY_ORDER) {
			this.resources.categories[category] = this.resources.categories[category].filter((candidate) => candidate.id !== item.id);
		}
		this.searchTextCache.delete(item.id);
		this.pruneSettingsState();
		this.invalidateItemCaches(item);
		this.exitDetailMode();
		this.applyFilter();
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filteredItems.length - 1));
	}

	private exitDetailMode(): void {
		this.mode = this.detailReturnMode;
		this.detailItem = undefined;
		this.detailSelectedIndex = 0;
		this.confirmingRemove = false;
		this.actionMessage = undefined;
	}

	private moveListSelection(delta: number): void {
		this.selectedIndex = moveSelection(this.selectedIndex, this.filteredItems.length, delta);
	}

	private openSelectedItem(): void {
		const selected = this.filteredItems[this.selectedIndex];
		if (!selected) return;
		this.openDetailItem(selected, "list");
	}

	private openDetailItem(item: ResourceItem, returnMode: Exclude<BrowserMode, "detail">): void {
		this.detailItem = item;
		this.detailReturnMode = returnMode;
		this.detailSelectedIndex = 0;
		this.confirmingRemove = false;
		this.actionMessage = undefined;
		this.mode = "detail";
		this.callbacks.onInspect?.(item);
	}

	private openPackageGroups(item: ResourceItem): void {
		if (item.category !== "packages") return;
		this.packageItem = item;
		this.packageGroupSelectionIndex = 0;
		this.packageSearchInput.setValue("");
		this.invalidatePackageViewCaches(item.id);
		this.mode = "packageGroups";
	}


	private moveCategory(direction: 1 | -1): void {
		const index = CATEGORY_ORDER.indexOf(this.category);
		const next = (index + direction + CATEGORY_ORDER.length) % CATEGORY_ORDER.length;
		this.category = CATEGORY_ORDER[next]!;
		this.mainSearchInput.setValue("");
		this.applyFilter();
	}

	private applyFilter(): void {
		const query = this.mainSearchInput.getValue().trim().toLowerCase();
		const items = this.getVisibleCategoryItems(this.category);
		this.filteredItems = items.filter((item) => this.matchesResourceQuery(item, query));
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
	}

	private rebuildPinnedRank(): void {
		this.pinnedRank = new Map((this.settings.pinned ?? []).map((id, index) => [id, index]));
	}

	private persistPrunedSettings(previousSettings: ResourceCenterSettings): void {
		if (previousSettings.pinned.length === this.settings.pinned.length) return;
		void this.callbacks.onSettingsChange?.(this.settings);
	}

	private pruneSettingsState(): void {
		const previousSettings = this.settings;
		this.settings = prunePinnedResourceIds(this.settings, this.resources);
		if (this.settings === previousSettings) return;
		this.rebuildPinnedRank();
		this.persistPrunedSettings(previousSettings);
	}

	private rebuildSearchTextCache(): void {
		this.searchTextCache.clear();
		for (const category of CATEGORY_ORDER) {
			for (const item of this.resources.categories[category]) {
				const base = [item.name, item.source, item.packageSource ?? "", item.packageRelativePath ?? ""]
					.join(" ")
					.toLowerCase();
				const pathText = "path" in item && item.path ? item.path.toLowerCase() : "";
				const descriptionText = item.description.toLowerCase();
				this.searchTextCache.set(item.id, {
					base,
					withDescription: descriptionText ? `${base} ${descriptionText}` : base,
					withPath: pathText ? `${base} ${pathText}` : base,
					withDescriptionAndPath: [base, descriptionText, pathText].filter(Boolean).join(" "),
				});
			}
		}
	}

	private getSearchText(item: ResourceItem): string {
		const cached = this.searchTextCache.get(item.id);
		if (!cached) return `${item.name} ${item.source}`.toLowerCase();
		if (this.settings.searchIncludeDescription && this.settings.searchIncludePath) return cached.withDescriptionAndPath;
		if (this.settings.searchIncludeDescription) return cached.withDescription;
		if (this.settings.searchIncludePath) return cached.withPath;
		return cached.base;
	}

	private matchesResourceQuery(item: ResourceItem, query: string): boolean {
		if (!query) return true;
		return this.getSearchText(item).includes(query);
	}

	private isPinned(item: ResourceItem): boolean {
		return this.pinnedRank.has(item.id);
	}

	private getPinnedRank(item: ResourceItem): number {
		return this.pinnedRank.get(item.id) ?? Number.MAX_SAFE_INTEGER;
	}

	private toggleItem(item: ResourceItem): void {
		if (!isThemeItem(item)) {
			item.enabled = !item.enabled;
		}
		this.invalidateItemCaches(item);
		this.callbacks.onToggle?.(item);
	}

	private toggleExpose(item: ResourceItem): void {
		item.exposed = !item.exposed;
		this.invalidateItemCaches(item);
		this.callbacks.onExpose?.(item);
	}

	private togglePinned(item: ResourceItem): void {
		const current = this.settings.pinned ?? [];
		const exists = current.includes(item.id);
		const nextPinned = exists ? current.filter((id) => id !== item.id) : [item.id, ...current];
		this.settings = { ...this.settings, pinned: nextPinned };
		this.rebuildPinnedRank();
		this.callbacks.onSettingsChange?.(this.settings);

		// Rebuild sorted/filtered views and keep selection on the toggled item.
		this.invalidateItemCaches(item);
		if (this.mode === "packageItems" && this.packageItem?.category === "packages") {
			this.packageContentsItems = this.getFilteredPackageContainedItems(this.packageItem, this.packageContentsCategory);
			const nextIndex = this.packageContentsItems.findIndex((candidate) => candidate.id === item.id);
			if (nextIndex !== -1) this.packageContentsSelectedIndex = nextIndex;

			// Keep the main list consistent for when the user returns.
			this.applyFilter();
			const listIndex = this.filteredItems.findIndex((candidate) => candidate.id === item.id);
			if (listIndex !== -1) this.selectedIndex = listIndex;
			return;
		}

		this.applyFilter();
		const nextIndex = this.filteredItems.findIndex((candidate) => candidate.id === item.id);
		if (nextIndex !== -1) this.selectedIndex = nextIndex;
	}

	private getVisibleCategoryItems(category: ResourceCategory): ResourceItem[] {
		const cached = this.visibleCategoryItemsCache.get(category);
		if (cached) return cached;
		const items = selectVisibleCategoryItems(this.resources, category, this.settings, (item) => this.isPinned(item), (item) => this.getPinnedRank(item));
		this.visibleCategoryItemsCache.set(category, items);
		return items;
	}

	private getHeaderTitle(): string {
		return getHeaderTitle({
			mode: this.mode,
			category: this.category,
			detailItem: this.detailItem,
			packageItem: this.packageItem,
			packageContentsCategory: this.packageContentsCategory,
		});
	}

	private getEmptyPackageCategoryMessage(category: PackageContentCategory): string {
		return getEmptyPackageCategoryMessage(category, Boolean(this.getSearchQuery()));
	}

	private getPackageCategories(): PackageContentCategory[] {
		return PACKAGE_CONTENT_CATEGORIES;
	}

	private getActiveSearchInput(): Input {
		return this.mode === "packageGroups" || this.mode === "packageItems" ? this.packageSearchInput : this.mainSearchInput;
	}

	private getSearchQuery(): string {
		return this.packageSearchInput.getValue().trim().toLowerCase();
	}

	private getFilteredPackageContainedItems(pkg: ResourceItem, category: PackageContentCategory): ResourceItem[] {
		const query = this.getSearchQuery();
		const cacheKey = `${pkg.id}:${category}:${query}`;
		const cached = this.filteredPackageItemsCache.get(cacheKey);
		if (cached) return cached;
		const items = this.getPackageContainedItems(pkg, category);
		const filtered = filterPackageContainedItems(items, category, query, (item, itemQuery) => this.matchesResourceQuery(item, itemQuery));
		this.filteredPackageItemsCache.set(cacheKey, filtered);
		return filtered;
	}

	private refreshPackageContentsItems(): void {
		if (!this.packageItem || this.packageItem.category !== "packages") return;
		this.packageContentsItems = this.getFilteredPackageContainedItems(this.packageItem, this.packageContentsCategory);
		this.packageContentsSelectedIndex = Math.max(
			0,
			Math.min(this.packageContentsSelectedIndex, Math.max(0, this.packageContentsItems.length - 1)),
		);
	}

	private getPackageGroupEntries(): PackageGroupEntry[] {
		const pkg = this.packageItem;
		if (!pkg || pkg.category !== "packages") return [];
		const query = this.getSearchQuery();
		if (this.packageGroupEntriesCache?.packageId === pkg.id && this.packageGroupEntriesCache.query === query) {
			return this.packageGroupEntriesCache.entries;
		}
		const entries = buildPackageGroupEntries(
			this.getPackageCategories(),
			query,
			this.settings.packagePreviewLimit,
			(category) => this.getFilteredPackageContainedItems(pkg, category),
		);
		this.packageGroupEntriesCache = { packageId: pkg.id, query, entries };
		return entries;
	}

	private getPackageContainedItems(pkg: ResourceItem, category: PackageContentCategory): ResourceItem[] {
		if (pkg.category !== "packages") return [];
		const cacheKey = `${pkg.id}:${category}`;
		const cached = this.containedItemsCache.get(cacheKey);
		if (cached) return cached;
		const items = selectPackageContainedItems(this.resources, pkg, category, this.settings, (item) => this.isPinned(item), (item) => this.getPinnedRank(item));
		this.containedItemsCache.set(cacheKey, items);
		return items;
	}

	private getCurrentAddScopeContext(): "project" | "user" {
		if (this.mode === "detail" && this.detailItem) return this.detailItem.scope;
		if ((this.mode === "packageGroups" || this.mode === "packageItems") && this.packageItem?.category === "packages") return this.packageItem.scope;
		const selectedItem = this.filteredItems[this.selectedIndex];
		return selectedItem?.scope ?? "project";
	}

	private openAddMode(): void {
		if (this.mode === "add") return;
		this.addReturnMode = this.mode;
		this.addInput.setValue("");
		this.addScope = this.getCurrentAddScopeContext();
		this.addDetection = { kind: "invalid", reason: "Enter a package source or local path." };
		this.addSelectedCandidateIndex = 0;
		this.addSuggestions = [];
		this.addSelectedSuggestionIndex = 0;
		this.mode = "add";
		this.refreshAddDetection();
		void this.refreshAddSuggestions();
	}

	private closeAddMode(): void {
		this.mode = this.addReturnMode;
		if (!this.addLoading) {
			this.addLoadingText = undefined;
			this.addMessage = undefined;
		}
	}

	private handleAddInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.closeAddMode();
			return;
		}
		if (data === "S") {
			this.openSettings();
			return;
		}
		if (this.addLoading) return;
		if (kb.matches(data, "tui.input.tab")) {
			this.addScope = this.addScope === "project" ? "user" : "project";
			return;
		}
		if (this.addSuggestions.length > 0) {
			if (kb.matches(data, "tui.select.up")) {
				this.addSelectedSuggestionIndex = moveSelection(this.addSelectedSuggestionIndex, this.addSuggestions.length, -1);
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				this.addSelectedSuggestionIndex = moveSelection(this.addSelectedSuggestionIndex, this.addSuggestions.length, 1);
				return;
			}
		} else if (this.addDetection.kind === "ambiguous") {
			if (kb.matches(data, "tui.select.up")) {
				this.addSelectedCandidateIndex = moveSelection(this.addSelectedCandidateIndex, this.addDetection.candidates.length, -1);
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				this.addSelectedCandidateIndex = moveSelection(this.addSelectedCandidateIndex, this.addDetection.candidates.length, 1);
				return;
			}
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const request = this.addInput.getValue().trim();
			const selectedSuggestion = this.addSuggestions[this.addSelectedSuggestionIndex];
			if (selectedSuggestion && selectedSuggestion.value !== request) {
				this.acceptAddSuggestion();
				return;
			}
			if (!request) return;
			if (this.addDetection.kind === "package" || this.addDetection.kind === "path") {
				void this.submitAddRequest({ input: request, scope: this.addScope });
				return;
			}
			if (this.addDetection.kind === "ambiguous") {
				void this.submitAddRequest({ input: request, scope: this.addScope, preferredCategory: this.addDetection.candidates[this.addSelectedCandidateIndex] });
			}
			return;
		}
		this.addInput.handleInput(data);
		this.refreshAddDetection();
		void this.refreshAddSuggestions();
	}

	private refreshAddDetection(): void {
		const result = detectAddTargetSync(this.addInput.getValue(), this.cwd);
		this.addDetection = result;
		if (result.kind === "ambiguous") {
			this.addSelectedCandidateIndex = Math.max(0, Math.min(this.addSelectedCandidateIndex, result.candidates.length - 1));
		} else {
			this.addSelectedCandidateIndex = 0;
		}
	}

	private acceptAddSuggestion(): void {
		const suggestion = this.addSuggestions[this.addSelectedSuggestionIndex];
		if (!suggestion) return;
		this.addInput.setValue(suggestion.value);
		(this.addInput as Input & { cursor?: number }).cursor = suggestion.value.length;
		this.refreshAddDetection();
		void this.refreshAddSuggestions();
	}

	private async submitAddRequest(request: { input: string; scope: "project" | "user"; preferredCategory?: AddPathCategory }): Promise<void> {
		this.addLoading = true;
		this.addLoadingText = `Adding ${request.input}`;
		this.addMessage = undefined;
		this.globalStatus = { type: "loading", text: `Adding ${request.input}` };
		this.loadingFrame = 0;
		this.callbacks.onRequestRender?.();
		try {
			await this.callbacks.onAdd?.(request);
			this.addLoading = false;
			this.addLoadingText = undefined;
			this.addMessage = undefined;
			this.globalStatus = undefined;
			if (this.mode === "add") this.closeAddMode();
			this.callbacks.onRequestRender?.();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			const normalized = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" · ");
			this.addLoading = false;
			this.addLoadingText = undefined;
			this.addMessage = { type: "error", text: normalized };
			this.globalStatus = undefined;
			this.callbacks.onRequestRender?.();
		}
	}

	private async refreshAddSuggestions(): Promise<void> {
		const requestId = ++this.addRequestId;
		const suggestions = await this.getAddSuggestions(this.addInput.getValue());
		if (requestId !== this.addRequestId || this.mode !== "add") return;
		this.addSuggestions = suggestions.slice(0, 6);
		this.addSelectedSuggestionIndex = Math.max(0, Math.min(this.addSelectedSuggestionIndex, this.addSuggestions.length - 1));
	}

	private async getAddSuggestions(input: string): Promise<AddSuggestion[]> {
		const value = input.trim();
		if (!value) return [];
		if (isLikelyLocalPathInput(value)) {
			const pathSuggestions = await this.getLocalAddPathSuggestions(value);
			if (pathSuggestions.length > 0) return pathSuggestions;
		}
		return ADD_SOURCE_SUGGESTIONS
			.filter((item) => item.value.toLowerCase().startsWith(value.toLowerCase()))
			.map((item) => ({ value: item.value, label: item.value, description: item.description }));
	}

	private async getLocalAddPathSuggestions(input: string): Promise<AddSuggestion[]> {
		const normalizedInput = input.replace(/\\/g, "/");
		const hasTrailingSlash = normalizedInput.endsWith("/");
		const baseInput = hasTrailingSlash ? normalizedInput.slice(0, -1) : normalizedInput;
		const searchDirInput = hasTrailingSlash ? normalizedInput : dirname(baseInput).replace(/\\/g, "/");
		const fragment = hasTrailingSlash ? "" : basename(baseInput);
		const resolvedSearchDir = this.resolveLocalAddCompletionDir(searchDirInput);
		if (!resolvedSearchDir) return [];
		try {
			const entries = await readdir(resolvedSearchDir, { withFileTypes: true });
			const candidates = entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.filter((name) => name.toLowerCase().startsWith(fragment.toLowerCase()));
			const scored = await Promise.all(candidates.map(async (name) => ({ name, score: await scoreLocalPackageDirectory(resolvedSearchDir, name) })));
			return scored
				.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
				.map(({ name, score }) => ({
					value: joinCompletionPath(searchDirInput, name),
					label: `${name}/`,
					description: describeLocalPackageDirectory(name, score),
				}));
		} catch {
			return [];
		}
	}

	private resolveLocalAddCompletionDir(searchDirInput: string): string | undefined {
		if (!searchDirInput || searchDirInput === ".") return this.cwd;
		if (searchDirInput === "/") return sep;
		if (/^[A-Za-z]:\/$/.test(searchDirInput)) return searchDirInput;
		if (/^[A-Za-z]:\//.test(searchDirInput)) return resolve(searchDirInput);
		if (searchDirInput.startsWith("/")) return resolve(searchDirInput);
		return resolve(this.cwd, searchDirInput);
	}

	private formatAddCategoryLabel(category: AddPathCategory): string {
		return category.slice(0, 1).toUpperCase() + category.slice(1);
	}

	private openSettings(): void {
		if (this.mode === "settings") return;
		this.settingsReturnMode = this.mode;
		this.settingsSection = "all";
		this.settingsSearchInput.setValue("");
		this.settingsList = undefined;
		this.settingsListSection = undefined;
		this.settingsListQuery = undefined;
		this.stopInlineSettingsEdit(false);
		this.mode = "settings";
	}

	private ensureSettingsList(): SettingsList {
		const query = this.getSettingsQuery();
		if (!this.settingsList || this.settingsListSection !== this.settingsSection || this.settingsListQuery !== query) {
			const items = this.getFilteredSettingsItems(this.settingsSection);
			this.settingsList = new SettingsList(
				items,
				10,
				this.getAdjustedSettingsTheme(),
				(id, newValue) => this.applySettingsChange(id, newValue),
				() => {
					this.mode = this.settingsReturnMode;
				},
			);
			this.settingsListSection = this.settingsSection;
			this.settingsListQuery = query;
		}
		return this.settingsList;
	}

	private getAdjustedSettingsTheme() {
		const baseTheme = getSettingsListTheme();
		return {
			...baseTheme,
			hint: (text: string) => baseTheme.hint(text.replace(/^  /, "")),
		};
	}

	private renderSettingsList(width: number): string[] {
		const items = this.getFilteredSettingsItems(this.settingsSection);
		const theme = this.getAdjustedSettingsTheme();
		const listState = this.ensureSettingsList() as SettingsList & { selectedIndex?: number };
		const selectedIndex = Math.max(0, Math.min(listState.selectedIndex ?? 0, Math.max(0, items.length - 1)));
		const lines: string[] = [];
		if (items.length === 0) {
			lines.push(theme.hint("No settings available"));
			return lines;
		}
		const maxVisible = 10;
		const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, items.length);
		const maxLabelWidth = Math.min(30, Math.max(...items.map((item) => visibleWidth(item.label))));
		for (let i = startIndex; i < endIndex; i++) {
			const item = items[i]!;
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = theme.label(labelPadded, isSelected);
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = Math.max(1, width - usedWidth - 2);
			const valueText = item.id === this.settingsInlineEditItemId && this.settingsInlineEditInput
				? this.renderInlineSettingsValue(item, valueMaxWidth, isSelected)
				: theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);
			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}
		if (startIndex > 0 || endIndex < items.length) {
			lines.push(theme.hint(truncateToWidth(`(${selectedIndex + 1}/${items.length})`, width - 2, "")));
		}
		const selectedItem = items[selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			for (const line of wrapTextWithAnsi(selectedItem.description, Math.max(1, width - 2))) {
				lines.push(theme.description(line));
			}
		}
		lines.push("");
		lines.push(truncateToWidth(theme.hint(this.getSettingsHint(selectedItem)), width));
		return lines;
	}

	private getSettingsHint(item: SettingItem | undefined): string {
		if (this.settingsInlineEditItemId) return "Type to edit · Enter save · Esc cancel";
		if (!item) return "Enter change · Esc back";
		if (item.id.startsWith("externalSkillSourceRow:")) return this.isCustomExternalSkillSource(item.id.slice("externalSkillSourceRow:".length))
			? "Enter edit · Space toggle · A add · R remove · Esc back"
			: "Enter edit · Space toggle · A add · Esc back";
		return "Enter change · Esc back";
	}

	private getSelectedSettingsItem(): SettingItem | undefined {
		const items = this.getFilteredSettingsItems(this.settingsSection);
		const listState = this.ensureSettingsList() as SettingsList & { selectedIndex?: number };
		const selectedIndex = listState.selectedIndex ?? 0;
		return items[selectedIndex];
	}

	private startInlineSettingsEdit(item: SettingItem): void {
		this.settingsInlineEditItemId = item.id;
		this.settingsInlineEditOriginalValue = item.currentValue;
		this.settingsInlineEditInput = new Input();
		this.settingsInlineEditInput.focused = true;
		if (item.id.startsWith("externalSkillSourceRow:")) {
			const sourceId = item.id.slice("externalSkillSourceRow:".length);
			const source = this.settings.externalSkillSources.find((entry) => entry.id === sourceId);
			this.settingsInlineEditInput.setValue(source?.path ?? item.currentValue);
			return;
		}
		this.settingsInlineEditInput.setValue(item.currentValue);
	}

	private renderInlineSettingsValue(item: SettingItem, valueMaxWidth: number, isSelected: boolean): string {
		if (!item.id.startsWith("externalSkillSourceRow:")) {
			return (this.settingsInlineEditInput?.render(valueMaxWidth + 2)[0] ?? "> ").slice(2);
		}
		const sourceId = item.id.slice("externalSkillSourceRow:".length);
		const source = this.settings.externalSkillSources.find((entry) => entry.id === sourceId);
		const statePrefix = `${source?.enabled ? "on " : "off"}  `;
		const stateText = this.getAdjustedSettingsTheme().value(statePrefix, isSelected);
		const inputWidth = Math.max(1, valueMaxWidth - visibleWidth(statePrefix));
		const inputText = (this.settingsInlineEditInput?.render(inputWidth + 2)[0] ?? "> ").slice(2);
		return truncateToWidth(`${stateText}${inputText}`, valueMaxWidth, "");
	}

	private stopInlineSettingsEdit(save: boolean): void {
		const itemId = this.settingsInlineEditItemId;
		const input = this.settingsInlineEditInput;
		const originalValue = this.settingsInlineEditOriginalValue;
		this.settingsInlineEditItemId = undefined;
		this.settingsInlineEditInput = undefined;
		this.settingsInlineEditOriginalValue = undefined;
		if (!itemId) return;
		if (!save) {
			if (originalValue !== undefined) this.ensureSettingsList().updateValue(itemId, originalValue);
			return;
		}
		if (!input) return;
		this.applySettingsChange(itemId, input.getValue());
		if (itemId.startsWith("externalSkillSourceRow:")) {
			const sourceId = itemId.slice("externalSkillSourceRow:".length);
			const source = this.settings.externalSkillSources.find((entry) => entry.id === sourceId);
			if (source) this.ensureSettingsList().updateValue(itemId, `${source.enabled ? "on " : "off"}  ${source.path}`);
		}
	}

	private buildSettingsItems(section: SettingsSection): SettingItem[] {
		const display: SettingItem[] = [
			{
				id: "reloadBehavior",
				label: "Reload behavior",
				description: "Choose what happens after resource settings change: only show a /reload hint, ask first, or reload immediately.",
				currentValue: RELOAD_BEHAVIOR_LABELS[this.settings.reloadBehavior],
				values: RELOAD_BEHAVIOR_VALUES,
			},
			{
				id: "showSource",
				label: "Show source",
				description: "Show source values in detail pages.",
				currentValue: this.settings.showSource ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "showPath",
				label: "Show path",
				description: "Show file paths in detail pages.",
				currentValue: this.settings.showPath ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "showPathInPackage",
				label: "Show path in package",
				description: "Show package-relative paths for package resources.",
				currentValue: this.settings.showPathInPackage ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "sortMode",
				label: "Sort order",
				description:
					"Controls list ordering. Recently updated uses file/package modified time. As discovered keeps the current discovery order. Name sorts A→Z. Enabled first puts enabled items on top. Scope puts project items before user.",
				currentValue: SORT_MODE_LABELS[this.settings.sortMode],
				values: SORT_MODE_VALUES,
			},
		];

		const packages: SettingItem[] = [
			{
				id: "packagePreviewLimit",
				label: "Package preview size",
				description: "How many items to show per category in grouped package view.",
				currentValue: String(this.settings.packagePreviewLimit),
				values: ["3", "5", "8"],
			},
		];

		const search: SettingItem[] = [
			{
				id: "searchIncludeDescription",
				label: "Search descriptions",
				description: "Include descriptions when filtering resources.",
				currentValue: this.settings.searchIncludeDescription ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "searchIncludePath",
				label: "Search paths",
				description: "Include full file paths when filtering resources.",
				currentValue: this.settings.searchIncludePath ? "true" : "false",
				values: ["true", "false"],
			},
		];

		const integrations: SettingItem[] = this.settings.externalSkillSources.map((source) => ({
			id: `externalSkillSourceRow:${source.id}`,
			label: `${source.label} skills`,
			description: `${source.enabled ? "Enabled" : "Disabled"}. Press Enter to edit path inline, Space to toggle on/off.`,
			currentValue: `${source.enabled ? "on " : "off"}  ${source.path}`,
		}));

		switch (section) {
			case "all":
				return [...display, ...packages, ...search, ...integrations];
			case "display":
				return display;
			case "packages":
				return packages;
			case "search":
				return search;
			case "integrations":
				return integrations;
		}
	}

	private getSettingsQuery(): string {
		return this.settingsSearchInput.getValue().trim();
	}

	private getFilteredSettingsItems(section: SettingsSection): SettingItem[] {
		const items = this.buildSettingsItems(section);
		const query = this.getSettingsQuery();
		if (!query) return items;
		return fuzzyFilter(items, query, (item) => `${item.label} ${item.description ?? ""}`);
	}

	private applySettingsChange(id: string, newValue: string): void {
		const next = { ...this.settings, externalSkillSources: [...this.settings.externalSkillSources] };
		switch (id) {
			case "reloadBehavior":
				next.reloadBehavior = reloadBehaviorFromLabel(newValue);
				break;
			case "showSource":
				next.showSource = newValue === "true";
				break;
			case "showPath":
				next.showPath = newValue === "true";
				break;
			case "showPathInPackage":
				next.showPathInPackage = newValue === "true";
				break;
			case "sortMode":
				next.sortMode = sortModeFromLabel(newValue);
				break;
			case "packagePreviewLimit":
				next.packagePreviewLimit = Number(newValue) as ResourceCenterSettings["packagePreviewLimit"];
				break;
			case "searchIncludeDescription":
				next.searchIncludeDescription = newValue === "true";
				break;
			case "searchIncludePath":
				next.searchIncludePath = newValue === "true";
				break;
			default:
				if (id === "externalSkillSourceAdd") {
					next.externalSkillSources = [...this.settings.externalSkillSources, this.createCustomExternalSkillSource()];
					break;
				}
				if (id.startsWith("externalSkillSourceRemove:")) {
					const sourceId = id.slice("externalSkillSourceRemove:".length);
					next.externalSkillSources = this.settings.externalSkillSources.filter((source) => source.id !== sourceId);
					break;
				}
				if (id.startsWith("externalSkillSourceRow:")) {
					const sourceId = id.slice("externalSkillSourceRow:".length);
					next.externalSkillSources = this.settings.externalSkillSources.map((source) => source.id === sourceId
						? { ...source, path: newValue.trim() || source.path }
						: source);
					break;
				}
				return;
		}
		this.settings = next;
		this.rebuildPinnedRank();
		this.callbacks.onSettingsChange?.(this.settings);
		this.invalidatePackageCaches();
		this.applyFilter();
	}

	private isCustomExternalSkillSource(sourceId: string): boolean {
		return !DEFAULT_EXTERNAL_SKILL_SOURCES.some((source) => source.id === sourceId);
	}

	private createCustomExternalSkillSource(): ResourceCenterSettings["externalSkillSources"][number] {
		const customIds = this.settings.externalSkillSources
			.filter((source) => this.isCustomExternalSkillSource(source.id))
			.map((source) => source.id);
		let index = 1;
		while (customIds.includes(`custom-${index}`)) index += 1;
		return {
			id: `custom-${index}`,
			label: `Custom ${index}`,
			path: `~/.pi/agent/custom-skills-${index}`,
			enabled: true,
		};
	}

	private moveSettingsSection(delta: -1 | 1): void {
		const index = SETTINGS_SECTION_ORDER.indexOf(this.settingsSection);
		this.settingsSection = SETTINGS_SECTION_ORDER[(index + delta + SETTINGS_SECTION_ORDER.length) % SETTINGS_SECTION_ORDER.length]!;
		this.settingsList = undefined;
		this.settingsListSection = undefined;
	}
}

function isLikelyLocalPathInput(value: string): boolean {
	return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

async function scoreLocalPackageDirectory(parentDir: string, name: string): Promise<number> {
	const dirPath = resolve(parentDir, name);
	let score = 0;
	if (NOISY_DIRECTORY_NAMES.has(name)) score -= 100;
	if (await pathExists(resolve(dirPath, "package.json"))) score += 100;
	if (name.startsWith("pi-")) score += 25;
	if (await pathExists(resolve(dirPath, "extensions"))) score += 15;
	if (await pathExists(resolve(dirPath, "skills"))) score += 10;
	if (await pathExists(resolve(dirPath, ".pi"))) score += 10;
	return score;
}

function describeLocalPackageDirectory(name: string, score: number): string {
	if (NOISY_DIRECTORY_NAMES.has(name)) return "Common build/tooling directory";
	if (score >= 100) return "Local package directory (contains package.json)";
	if (score >= 25) return "Likely local package directory";
	return "Local directory";
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function joinCompletionPath(baseInput: string, name: string): string {
	const normalizedBase = baseInput.replace(/\\/g, "/");
	if (!normalizedBase || normalizedBase === ".") return `./${name}/`;
	if (normalizedBase === "/") return `/${name}/`;
	if (/^[A-Za-z]:\/$/.test(normalizedBase)) return `${normalizedBase}${name}/`;
	if (normalizedBase.endsWith("/")) return `${normalizedBase}${name}/`;
	return `${normalizedBase}/${name}/`;
}
