import { getSettingsListTheme, type Theme } from "@mariozechner/pi-coding-agent";
import type { ResourceCenterSettings } from "./settings.js";
import {
	type Component,
	type Focusable,
	Input,
	fuzzyFilter,
	SettingsList,
	type SettingItem,
} from "@mariozechner/pi-tui";
import {
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	PACKAGE_CONTENT_CATEGORIES,
	SETTINGS_SECTION_ORDER,
	SORT_MODE_LABELS,
	SORT_MODE_VALUES,
	sortModeFromLabel,
	type BrowserCallbacks,
	type BrowserMode,
	type DetailAction,
	type PackageContentCategory,
	type PackageGroupEntry,
	type SettingsSection,
} from "./browser-shared.js";
import {
	buildPackageGroupEntries,
	getFilteredPackageContainedItems as filterPackageContainedItems,
	getPackageContainedItems as selectPackageContainedItems,
	getVisibleCategoryItems as selectVisibleCategoryItems,
} from "./browser-selectors.js";
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
} from "./browser-render.js";
import { getDetailActionHint, getDetailActionLabel, getDetailActions } from "./browser-actions.js";
import {
	handleDetailInput as handleDetailInputMode,
	handleListInput,
	handlePackageGroupsInput as handlePackageGroupsInputMode,
	handlePackageItemsInput as handlePackageItemsInputMode,
	handleSettingsInput as handleSettingsInputMode,
} from "./browser-input.js";
import { getDetailFooterText, getEmptyPackageCategoryMessage, getHeaderTitle, getListFooterText, getPackageFooterText, moveSelection } from "./browser-navigation.js";
import { isContainedResource, isPackageItem, isThemeItem } from "./resource-capabilities.js";
import { getPackageResourceId, isSameResource } from "./resource-identity.js";
import { prunePinnedResourceIds } from "./resource-state-prune.js";
import type { ResourceCategory, ResourceIndex, ResourceItem } from "./types.js";

export class ResourceBrowser implements Component, Focusable {
	private readonly theme: Theme;
	private readonly callbacks: BrowserCallbacks;
	private readonly mainSearchInput: Input;
	private readonly packageSearchInput: Input;
	private readonly settingsSearchInput: Input;
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
	}

	constructor(theme: Theme, resources: ResourceIndex, category: ResourceCategory, settings: ResourceCenterSettings, callbacks: BrowserCallbacks) {
		this.theme = theme;
		this.resources = resources;
		this.settings = prunePinnedResourceIds(settings, resources);
		this.category = category;
		this.callbacks = callbacks;
		this.mainSearchInput = new Input();
		this.packageSearchInput = new Input();
		this.settingsSearchInput = new Input();
		this.mainSearchInput.setValue("");
		this.packageSearchInput.setValue("");
		this.settingsSearchInput.setValue("");
		this.rebuildPinnedRank();
		this.rebuildSearchTextCache();
		this.persistPrunedSettings(settings);
		this.applyFilter();
	}

	invalidate(): void {
		this.mainSearchInput.invalidate();
		this.packageSearchInput.invalidate();
		this.settingsSearchInput.invalidate();
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
			searchInput: this.mainSearchInput,
			onApplyFilter: () => this.applyFilter(),
		});
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		lines.push(this.renderTopRule(width));
		lines.push(...this.wrapBlock(this.renderHeader(innerWidth), width));
		if (this.mode === "detail") {
			lines.push("");
			lines.push(...this.wrapBlock(this.renderDetailPage(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock([this.renderDetailFooter(innerWidth)], width));
			return lines;
		}
		if (this.mode === "settings") {
			lines.push(...this.wrapBlock(this.renderSettingsTabs(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock(this.renderSettingsSearch(innerWidth), width));
			lines.push("");
			const list = this.ensureSettingsList();
			lines.push(...this.wrapBlock(list.render(innerWidth), width));
			return lines;
		}
		if (this.mode === "packageGroups") {
			lines.push("");
			lines.push(...this.wrapBlock(this.renderSearch(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock(this.renderPackageGroupsPage(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock([this.renderPackageFooter(innerWidth)], width));
			return lines;
		}
		if (this.mode === "packageItems") {
			lines.push("");
			lines.push(...this.wrapBlock(this.renderSearch(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock(this.renderPackageItemsPage(innerWidth), width));
			lines.push("");
			lines.push(...this.wrapBlock([this.renderPackageFooter(innerWidth)], width));
			return lines;
		}
		lines.push(...this.wrapBlock(this.renderTabs(innerWidth), width));
		lines.push("");
		lines.push(...this.wrapBlock(this.renderSearch(innerWidth), width));
		lines.push("");
		lines.push(...this.wrapBlock(this.renderList(innerWidth), width));
		lines.push("");
		lines.push(...this.wrapBlock([this.renderFooter(innerWidth)], width));
		return lines;
	}

	private renderHeader(width: number): string[] {
		const count =
			this.mode === "settings"
				? this.getFilteredSettingsItems(this.settingsSection).length
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

	private renderDetailFooter(width: number): string {
		return this.renderFooterWithSettingsHint(width, getDetailFooterText());
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
			searchInput: this.packageSearchInput,
			getSearchQuery: () => this.getSearchQuery(),
			onInvalidatePackageViewCaches: (packageId) => this.invalidatePackageViewCaches(packageId),
			onGetEntriesLength: () => this.getPackageGroupEntries().length,
		});
	}

	private handleSettingsInput(data: string): void {
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
			return this.theme.fg("accent", `${frame} ${this.loadingText ?? "Working..."}`);
		}
		if (!this.actionMessage || this.actionMessage.action !== action) return undefined;
		const color =
			this.actionMessage.type === "error"
				? "error"
				: this.actionMessage.type === "warning"
					? "warning"
					: "accent";
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

	private clearTransientActionMessage(): void {
		if (!this.loadingAction) {
			this.actionMessage = undefined;
		}
	}

	public advanceLoadingFrame(): void {
		if (!this.loadingAction) return;
		this.loadingFrame += 1;
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
		this.stopActionLoading();
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

	private openSettings(): void {
		if (this.mode === "settings") return;
		this.settingsReturnMode = this.mode;
		this.settingsSection = "all";
		this.settingsSearchInput.setValue("");
		this.settingsList = undefined;
		this.settingsListSection = undefined;
		this.settingsListQuery = undefined;
		this.mode = "settings";
	}

	private ensureSettingsList(): SettingsList {
		const query = this.getSettingsQuery();
		if (!this.settingsList || this.settingsListSection !== this.settingsSection || this.settingsListQuery !== query) {
			const items = this.getFilteredSettingsItems(this.settingsSection);
			const baseTheme = getSettingsListTheme();
			// We render SettingsList inside wrapBlock() (like /resource content blocks). SettingsList already
			// prefixes some hint lines with two spaces, which would indent too far. Trim those.
			const adjustedTheme = {
				...baseTheme,
				hint: (text: string) => baseTheme.hint(text.replace(/^  /, "")),
			};
			this.settingsList = new SettingsList(
				items,
				10,
				adjustedTheme,
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

	private buildSettingsItems(section: SettingsSection): SettingItem[] {
		const display: SettingItem[] = [
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

		switch (section) {
			case "all":
				return [...display, ...packages, ...search];
			case "display":
				return display;
			case "packages":
				return packages;
			case "search":
				return search;
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
		const next = { ...this.settings };
		switch (id) {
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
				return;
		}
		this.settings = next;
		this.rebuildPinnedRank();
		this.callbacks.onSettingsChange?.(this.settings);
		this.invalidatePackageCaches();
		this.applyFilter();
	}

	private moveSettingsSection(delta: -1 | 1): void {
		const index = SETTINGS_SECTION_ORDER.indexOf(this.settingsSection);
		this.settingsSection = SETTINGS_SECTION_ORDER[(index + delta + SETTINGS_SECTION_ORDER.length) % SETTINGS_SECTION_ORDER.length]!;
		this.settingsList = undefined;
		this.settingsListSection = undefined;
	}
}
