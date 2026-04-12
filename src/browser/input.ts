/**
 * 按浏览器 mode 处理键盘输入，负责把输入映射为导航和动作调用。
 */
import { getKeybindings, type Input, type SettingsList } from "@mariozechner/pi-tui";
import { getDetailActions } from "./actions.js";
import { moveSelection } from "./navigation.js";
import { canExposeResource, canManagePackageContents, isPackageItem, supportsPackageUpdate } from "../resource/capabilities.js";
import { getPackageResourceId } from "../resource/identity.js";
import type { BrowserMode, PackageContentCategory, PackageGroupEntry } from "./shared.js";
import type { ResourceItem } from "../types.js";

export function handleListInput(data: string, args: {
	selectedItem?: ResourceItem;
	maxVisible: number;
	onOpenSettings: () => void;
	onClose: () => void | Promise<void>;
	onMoveCategory: (direction: 1 | -1) => void;
	onMoveSelection: (delta: number) => void;
	onOpenSelectedItem: () => void;
	onTogglePinned: (item: ResourceItem) => void;
	onToggleItem: (item: ResourceItem) => void;
	searchInput: Input;
	onApplyFilter: () => void;
}): void {
	const kb = getKeybindings();
	if (data === "S") return args.onOpenSettings();
	if (kb.matches(data, "tui.select.cancel")) return void args.onClose();
	if (kb.matches(data, "tui.editor.cursorLeft")) return args.onMoveCategory(-1);
	if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.input.tab")) return args.onMoveCategory(1);
	if (kb.matches(data, "tui.select.up")) return args.onMoveSelection(-1);
	if (kb.matches(data, "tui.select.down")) return args.onMoveSelection(1);
	if (kb.matches(data, "tui.select.pageUp")) return args.onMoveSelection(-args.maxVisible);
	if (kb.matches(data, "tui.select.pageDown")) return args.onMoveSelection(args.maxVisible);
	if (kb.matches(data, "tui.select.confirm")) return args.onOpenSelectedItem();
	if (data === "P") {
		if (args.selectedItem) args.onTogglePinned(args.selectedItem);
		return;
	}
	if (data === " ") {
		if (args.selectedItem) args.onToggleItem(args.selectedItem);
		return;
	}
	args.searchInput.handleInput(data);
	args.onApplyFilter();
}

export function handleDetailInput(data: string, args: {
	detailItem?: ResourceItem;
	confirmingRemove: boolean;
	setConfirmingRemove: (value: boolean) => void;
	clearActionMessage: () => void;
	detailSelectedIndex: number;
	setDetailSelectedIndex: (value: number) => void;
	loadingAction?: string;
	onOpenSettings: () => void;
	onExitDetailMode: () => void;
	onTogglePinned: (item: ResourceItem) => void;
	onOpenPackageGroups: (item: ResourceItem) => void;
	onToggleItem: (item: ResourceItem) => void;
	onToggleExpose: (item: ResourceItem) => void;
	onUpdateItem: (item: ResourceItem) => void;
	onRemoveItem: (item: ResourceItem) => void;
}): void {
	const kb = getKeybindings();
	if (data === "S") return args.onOpenSettings();
	if (data === "P") {
		if (args.detailItem) args.onTogglePinned(args.detailItem);
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		if (args.confirmingRemove) {
			args.setConfirmingRemove(false);
			args.clearActionMessage();
			return;
		}
		return args.onExitDetailMode();
	}
	const actions = args.detailItem ? getDetailActions(args.detailItem) : [];
	if (kb.matches(data, "tui.select.up")) {
		if (args.confirmingRemove) {
			args.setConfirmingRemove(false);
			args.clearActionMessage();
		}
		args.setDetailSelectedIndex(moveSelection(args.detailSelectedIndex, actions.length, -1));
		return;
	}
	if (kb.matches(data, "tui.select.down")) {
		if (args.confirmingRemove) {
			args.setConfirmingRemove(false);
			args.clearActionMessage();
		}
		args.setDetailSelectedIndex(moveSelection(args.detailSelectedIndex, actions.length, 1));
		return;
	}
	if (!kb.matches(data, "tui.select.confirm") || !args.detailItem) return;
	const action = actions[args.detailSelectedIndex]!;
	if (args.loadingAction === action) return;
	if (action === "remove") {
		if (!args.confirmingRemove) {
			args.setConfirmingRemove(true);
			args.clearActionMessage();
			return;
		}
		args.setConfirmingRemove(false);
		return args.onRemoveItem(args.detailItem);
	}
	if (action === "update" && isPackageItem(args.detailItem) && !supportsPackageUpdate(args.detailItem)) return;
	switch (action) {
		case "manage":
			if (canManagePackageContents(args.detailItem)) args.onOpenPackageGroups(args.detailItem);
			return;
		case "toggle":
			return args.onToggleItem(args.detailItem);
		case "pin":
			return args.onTogglePinned(args.detailItem);
		case "expose":
			if (canExposeResource(args.detailItem)) args.onToggleExpose(args.detailItem);
			return;
		case "update":
			return args.onUpdateItem(args.detailItem);
		case "back":
			return args.onExitDetailMode();
	}
}

export function handlePackageGroupsInput(data: string, args: {
	packageItem?: ResourceItem;
	entries: PackageGroupEntry[];
	selectedIndex: number;
	setSelectedIndex: (value: number) => void;
	onOpenSettings: () => void;
	onOpenDetailItem: (item: ResourceItem) => void;
	onOpenParentPackage: (item: ResourceItem) => void;
	onSetMode: (mode: BrowserMode) => void;
	onSetPackageContentsCategory: (category: PackageContentCategory) => void;
	onRefreshPackageContents: () => void;
	onTogglePinned: (item: ResourceItem) => void;
	onToggleItem: (item: ResourceItem) => void;
	searchInput: Input;
	getSearchQuery: () => string;
	onInvalidatePackageViewCaches: (packageId?: string) => void;
	onGetEntriesLength: () => number;
}): void {
	const kb = getKeybindings();
	if (data === "S") return args.onOpenSettings();
	if (kb.matches(data, "tui.select.cancel")) {
		if (args.packageItem) return args.onOpenParentPackage(args.packageItem);
		return args.onSetMode("list");
	}
	if (kb.matches(data, "tui.select.up")) return args.setSelectedIndex(moveSelection(args.selectedIndex, args.entries.length, -1));
	if (kb.matches(data, "tui.select.down")) return args.setSelectedIndex(moveSelection(args.selectedIndex, args.entries.length, 1));
	const selected = args.entries[args.selectedIndex];
	if (selected && data === "P" && selected.kind === "item") return args.onTogglePinned(selected.item);
	if (selected && data === " " && selected.kind === "item") return args.onToggleItem(selected.item);
	if (selected && kb.matches(data, "tui.select.confirm") && args.packageItem && isPackageItem(args.packageItem)) {
		if (selected.kind === "item") return args.onOpenDetailItem(selected.item);
		args.onSetPackageContentsCategory(selected.category);
		args.onRefreshPackageContents();
		return args.onSetMode("packageItems");
	}
	const previousQuery = args.getSearchQuery();
	args.searchInput.handleInput(data);
	if (args.getSearchQuery() !== previousQuery) {
		args.onInvalidatePackageViewCaches(args.packageItem && isPackageItem(args.packageItem) ? getPackageResourceId(args.packageItem.scope, args.packageItem.source) : undefined);
	}
	args.setSelectedIndex(moveSelection(args.selectedIndex, args.onGetEntriesLength(), 0));
}

export function handleSettingsInput(data: string, args: {
	settingsReturnMode: Exclude<BrowserMode, "settings">;
	onSetMode: (mode: BrowserMode) => void;
	onMoveSettingsSection: (delta: -1 | 1) => void;
	settingsList: () => SettingsList;
	searchInput: Input;
	onResetSettingsListCache: () => void;
}): void {
	const kb = getKeybindings();
	if (kb.matches(data, "tui.select.cancel")) return args.onSetMode(args.settingsReturnMode);
	if (kb.matches(data, "tui.editor.cursorLeft")) return args.onMoveSettingsSection(-1);
	if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.input.tab")) return args.onMoveSettingsSection(1);
	if (
		kb.matches(data, "tui.select.up") ||
		kb.matches(data, "tui.select.down") ||
		kb.matches(data, "tui.select.pageUp") ||
		kb.matches(data, "tui.select.pageDown") ||
		kb.matches(data, "tui.select.confirm") ||
		data === " "
	) {
		args.settingsList().handleInput?.(data);
		return;
	}
	const before = args.searchInput.getValue();
	args.searchInput.handleInput(data);
	if (args.searchInput.getValue() !== before) args.onResetSettingsListCache();
}

export function handlePackageItemsInput(data: string, args: {
	selectedItem?: ResourceItem;
	itemsLength: number;
	selectedIndex: number;
	setSelectedIndex: (value: number) => void;
	packageItem?: ResourceItem;
	packageContentsCategory: PackageContentCategory;
	onOpenSettings: () => void;
	onSetMode: (mode: BrowserMode) => void;
	onOpenDetailItem: (item: ResourceItem) => void;
	onTogglePinned: (item: ResourceItem) => void;
	onToggleItem: (item: ResourceItem) => void;
	searchInput: Input;
	getSearchQuery: () => string;
	onInvalidatePackageViewCaches: (packageId: string | undefined, category: PackageContentCategory) => void;
	onRefreshPackageContents: () => void;
}): void {
	const kb = getKeybindings();
	if (data === "S") return args.onOpenSettings();
	if (kb.matches(data, "tui.select.cancel")) return args.onSetMode("packageGroups");
	if (kb.matches(data, "tui.select.up")) return args.setSelectedIndex(moveSelection(args.selectedIndex, args.itemsLength, -1));
	if (kb.matches(data, "tui.select.down")) return args.setSelectedIndex(moveSelection(args.selectedIndex, args.itemsLength, 1));
	if (kb.matches(data, "tui.select.confirm")) {
		if (args.selectedItem) args.onOpenDetailItem(args.selectedItem);
		return;
	}
	if (data === "P") {
		if (args.selectedItem) args.onTogglePinned(args.selectedItem);
		return;
	}
	if (data === " ") {
		if (args.selectedItem) args.onToggleItem(args.selectedItem);
		return;
	}
	const previousQuery = args.getSearchQuery();
	args.searchInput.handleInput(data);
	if (args.getSearchQuery() !== previousQuery) {
		args.onInvalidatePackageViewCaches(args.packageItem && isPackageItem(args.packageItem) ? getPackageResourceId(args.packageItem.scope, args.packageItem.source) : undefined, args.packageContentsCategory);
	}
	args.onRefreshPackageContents();
}
