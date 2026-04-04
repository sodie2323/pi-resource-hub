import { basename } from "node:path";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { isRemotePackageSource, type ResourceCategory, type ResourceIndex, type ResourceItem } from "./types.js";

const CATEGORY_ORDER: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];

const CATEGORY_LABELS: Record<ResourceCategory, string> = {
	packages: "Packages",
	skills: "Skills",
	extensions: "Extensions",
	prompts: "Prompts",
	themes: "Themes",
};

function formatPackageLabel(source: string): string {
	if (source.startsWith("npm:")) return source;
	if (source.startsWith("git:")) return source;
	if (source.startsWith("http://") || source.startsWith("https://")) return source;
	return `local:${basename(source.replace(/[\\/]+$/, "")) || source}`;
}

type BrowserMode = "list" | "detail" | "packageGroups" | "packageItems";
type DetailAction = "manage" | "toggle" | "expose" | "update" | "remove" | "back";
type PackageContentCategory = Exclude<ResourceCategory, "packages">;
type PackageGroupEntry =
	| { kind: "category"; category: PackageContentCategory }
	| { kind: "item"; category: PackageContentCategory; item: ResourceItem }
	| { kind: "more"; category: PackageContentCategory; remaining: number };

interface BrowserCallbacks {
	onClose: () => void | Promise<void>;
	onInspect?: (item: ResourceItem) => void;
	onToggle?: (item: ResourceItem) => void;
	onExpose?: (item: ResourceItem) => void;
	onUpdate?: (item: ResourceItem) => void;
	onRemove?: (item: ResourceItem) => void;
}

export class ResourceBrowser implements Component, Focusable {
	private readonly theme: Theme;
	private readonly callbacks: BrowserCallbacks;
	private readonly mainSearchInput: Input;
	private readonly packageSearchInput: Input;
	private readonly resources: ResourceIndex;
	private category: ResourceCategory;
	private filteredItems: ResourceItem[] = [];
	private selectedIndex = 0;
	private maxVisible = 8;
	private mode: BrowserMode = "list";
	private detailItem: ResourceItem | undefined;
	private detailSelectedIndex = 0;
	private detailReturnMode: Exclude<BrowserMode, "detail"> = "list";
	private packageItem: ResourceItem | undefined;
	private packageGroupSelectionIndex = 0;
	private packageContentsCategory: PackageContentCategory = "extensions";
	private packageContentsItems: ResourceItem[] = [];
	private packageContentsSelectedIndex = 0;
	private containedItemsCache = new Map<string, ResourceItem[]>();
	private filteredPackageItemsCache = new Map<string, ResourceItem[]>();
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
	}

	constructor(theme: Theme, resources: ResourceIndex, category: ResourceCategory, callbacks: BrowserCallbacks) {
		this.theme = theme;
		this.resources = resources;
		this.category = category;
		this.callbacks = callbacks;
		this.mainSearchInput = new Input();
		this.packageSearchInput = new Input();
		this.mainSearchInput.setValue("");
		this.packageSearchInput.setValue("");
		this.applyFilter();
	}

	invalidate(): void {
		this.mainSearchInput.invalidate();
		this.packageSearchInput.invalidate();
	}

	private invalidatePackageCaches(): void {
		this.containedItemsCache.clear();
		this.filteredPackageItemsCache.clear();
		this.packageGroupEntriesCache = undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
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

		if (kb.matches(data, "tui.select.cancel")) {
			this.callbacks.onClose();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.moveCategory(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.input.tab")) {
			this.moveCategory(1);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.moveListSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveListSelection(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.moveListSelection(-this.maxVisible);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.moveListSelection(this.maxVisible);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.openSelectedItem();
			return;
		}
		if (data === " ") {
			const selected = this.filteredItems[this.selectedIndex];
			if (selected) {
				if (selected.category !== "themes") {
					selected.enabled = !selected.enabled;
				}
				this.callbacks.onToggle?.(selected);
			}
			return;
		}

		this.mainSearchInput.handleInput(data);
		this.applyFilter();
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
			this.mode === "packageItems"
				? this.packageContentsItems.length
				: this.mode === "packageGroups"
					? this.getPackageGroupEntries().length
					: this.filteredItems.length;
		const left = this.theme.fg("accent", this.theme.bold(this.getHeaderTitle()));
		const right = this.theme.fg("muted", `${count} result${count === 1 ? "" : "s"}`);
		const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return [truncateToWidth(`${left}${" ".repeat(spacing)}${right}`, width, "")];
	}

	private renderTabs(width: number): string[] {
		const title = this.theme.fg("muted", "(tab to cycle)");
		const tabs = CATEGORY_ORDER.map((category) => {
			const label = ` ${CATEGORY_LABELS[category]} `;
			if (category === this.category) {
				return this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(label)));
			}
			return this.theme.fg("muted", label);
		}).join(" ");
		return [truncateToWidth(`${tabs}  ${title}`, width, "…")];
	}

	private renderSearch(width: number): string[] {
		const label = this.mode === "packageGroups"
			? "Search in package:"
			: this.mode === "packageItems"
				? `Search in ${CATEGORY_LABELS[this.packageContentsCategory].toLowerCase()}:`
				: "Search:";
		const inputWidth = Math.max(1, width - visibleWidth(label) - 1);
		const inputLines = this.getActiveSearchInput().render(inputWidth);
		const input = inputLines[0] ?? "";
		return [truncateToWidth(`${this.theme.fg("muted", label)} ${input}`, width, "…")];
	}

	private renderList(width: number): string[] {
		if (this.filteredItems.length === 0) {
			return [this.theme.fg("muted", "Nothing matches the current view")];
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(this.filteredItems.length, startIndex + this.maxVisible);
		const lines: string[] = [];

		for (let index = startIndex; index < endIndex; index++) {
			const item = this.filteredItems[index]!;
			const selected = index === this.selectedIndex;
			const marker = selected ? this.theme.fg("accent", "▌") : this.theme.fg("dim", " ");
			const toggle = item.category === "packages" ? this.formatPackageToggleState(item) : this.formatBinaryToggle(item.enabled, true);
			const packageBadge = item.packageSource ? this.theme.fg("accent", this.theme.bold("[pkg] ")) : "";
			const nameText = `${packageBadge}${item.name}`;
			const name = selected ? this.theme.bold(nameText) : this.theme.fg("text", nameText);
			const scope = item.scope === "project" ? this.theme.fg("success", "project") : this.theme.fg("warning", "user");
			const sourceText = formatPackageLabel(item.packageSource ?? item.source);
			const source = this.theme.fg("dim", sourceText);
			const right = `${scope}  ${source}`;
			const left = `${marker} ${toggle} ${name}`;
			const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
			let line = truncateToWidth(`${left}${" ".repeat(spacing)}${right}`, width, "…");
			if (selected) {
				line = this.theme.bg("selectedBg", line);
			} else {
				line = this.theme.fg("text", line);
			}
			lines.push(line);

			const nextItem = index + 1 < endIndex ? this.filteredItems[index + 1] : undefined;
			if (item.category === "packages" && nextItem && nextItem.category !== "packages") {
				lines.push(this.theme.fg("dim", ""));
			}
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			lines.push(
				this.theme.fg("dim", truncateToWidth(`(${this.selectedIndex + 1}/${this.filteredItems.length})`, width, "")),
			);
		}

		return lines;
	}

	private renderDetailPage(width: number): string[] {
		const item = this.detailItem;
		if (!item) return [this.theme.fg("muted", "Nothing selected")];

		const enabledText = item.category === "packages"
			? this.formatPackageEnabledStateText(item)
			: item.enabled
				? this.theme.fg("success", "on")
				: this.theme.fg("dim", "off");
		const originLabel = item.category === "packages" ? "Package Source Type" : "Discovery Source";
		const valueLabel = "path" in item ? "Resource Path" : item.category === "packages" ? "Package Name" : "Resource Name";
		const valueText = "path" in item ? item.path : item.name;
		const lines = [
			truncateToWidth(`${this.theme.fg("muted", "Category")}: ${CATEGORY_LABELS[item.category]}`, width, "…"),
			truncateToWidth(`${this.theme.fg("muted", "Enabled")}: ${enabledText}`, width, "…"),
			truncateToWidth(`${this.theme.fg("muted", "Scope")}: ${item.scope}`, width, "…"),
			...(item.packageSource
				? [truncateToWidth(`${this.theme.fg("muted", "Package Source")}: ${item.packageSource}`, width, "…")]
				: [truncateToWidth(`${this.theme.fg("muted", originLabel)}: ${item.source}`, width, "…")]),
			...(item.packageRelativePath
				? [truncateToWidth(`${this.theme.fg("muted", "Resource Path in Package")}: ${item.packageRelativePath}`, width, "…")]
				: []),
			truncateToWidth(`${this.theme.fg("muted", valueLabel)}: ${valueText}`, width, "…"),
		];
		if (item.category === "packages") {
			const enabledSummary = this.formatPackageEnabledSummary(item);
			if (enabledSummary) {
				lines.push(truncateToWidth(`${this.theme.fg("muted", "Enabled Resources")}: ${enabledSummary}`, width, "…"));
			}
			const counts = this.formatPackageCounts(item, true);
			if (counts) {
				lines.push(truncateToWidth(`${this.theme.fg("muted", "Resources")}: ${counts}`, width, "…"));
			}
		}
		lines.push("");
		lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Description")), width, "…"));
		lines.push(...this.renderDescriptionBlock(item.description, width));
		lines.push("");
		lines.push(this.theme.fg("accent", this.theme.bold("Actions")));
		const actions = this.getDetailActions(item);
		for (let i = 0; i < actions.length; i++) {
			const action = actions[i]!;
			const selected = i === this.detailSelectedIndex;
			const label = this.getDetailActionLabel(action, item, selected);
			const actionHint = selected
				? this.getPersistedActionHint(action) ?? this.getDetailActionHint(action, item)
				: this.getPersistedActionHint(action);
			let line = `${selected ? this.theme.fg("accent", "› ") : "  "}${label}`;
			if (actionHint) {
				line += this.theme.fg("dim", "  ·  ") + actionHint;
			}
			line = truncateToWidth(line, width, "…");
			if (selected) line = this.theme.bg("selectedBg", line);
			lines.push(line);
		}
		return lines;
	}

	private renderPackageGroupsPage(width: number): string[] {
		const pkg = this.packageItem;
		if (!pkg || pkg.category !== "packages") return [this.theme.fg("muted", "No package selected")];
		const lines = [""];
		const entries = this.getPackageGroupEntries();
		if (entries.length === 0) {
			lines.push(this.theme.fg("muted", "No package contents match the current search"));
			return lines;
		}

		for (const [index, entry] of entries.entries()) {
			const selected = index === this.packageGroupSelectionIndex;
			let line = "";
			if (entry.kind === "category") {
				const items = this.getPackageContainedItems(pkg, entry.category);
				const enabledCount = items.filter((item) => item.enabled).length;
				const countColor = items.length === 0 ? "dim" : enabledCount === items.length ? "success" : enabledCount === 0 ? "dim" : "warning";
				line = `${selected ? this.theme.fg("accent", "› ") : "  "}${CATEGORY_LABELS[entry.category]} (${this.theme.fg(countColor, `${enabledCount}/${items.length}`)})`;
			} else if (entry.kind === "item") {
				const toggle = this.formatBinaryToggle(entry.item.enabled);
				const exposure = entry.item.packageSource && entry.item.category !== "themes"
					? entry.item.exposed
						? this.theme.fg("accent", "[shown]")
						: this.theme.fg("dim", "[hidden]")
					: "";
				const label = entry.item.packageRelativePath ?? entry.item.name;
				line = `  ${selected ? this.theme.fg("accent", "›") : " "}   ${toggle}${exposure ? ` ${exposure}` : ""} ${this.theme.fg("dim", label)}`;
			} else {
				line = `  ${selected ? this.theme.fg("accent", "›") : " "}   ${this.theme.fg("accent", `… more (${entry.remaining} more, press Enter to open full list)`)}`;
			}
			line = truncateToWidth(line, width, "…");
			if (selected) line = this.theme.bg("selectedBg", line);
			lines.push(line);
		}

		return lines;
	}

	private renderPackageItemsPage(width: number): string[] {
		const pkg = this.packageItem;
		if (!pkg || pkg.category !== "packages") return [this.theme.fg("muted", "No package selected")];
		const lines = [""];
		if (this.packageContentsItems.length === 0) {
			lines.push(this.theme.fg("muted", this.getEmptyPackageCategoryMessage(this.packageContentsCategory)));
			return lines;
		}

		for (let index = 0; index < this.packageContentsItems.length; index++) {
			const item = this.packageContentsItems[index]!;
			const selected = index === this.packageContentsSelectedIndex;
			const marker = selected ? this.theme.fg("accent", "▌") : this.theme.fg("dim", " ");
			const toggle = this.formatBinaryToggle(item.enabled, true);
			const exposure = item.packageSource && item.category !== "themes"
				? item.exposed
					? this.theme.fg("accent", this.theme.bold("[shown]"))
					: this.theme.fg("dim", "[hidden]")
				: "";
			const primary = `${marker} ${toggle}${exposure ? ` ${exposure}` : ""} ${item.name}`;
			const label = this.theme.fg("dim", item.packageRelativePath ?? ("path" in item ? item.path : item.name));
			const spacing = Math.max(1, width - visibleWidth(primary) - visibleWidth(label));
			let line = truncateToWidth(`${primary}${" ".repeat(spacing)}${label}`, width, "…");
			if (selected) {
				line = this.theme.bg("selectedBg", line);
			} else {
				line = this.theme.fg("text", line);
			}
			lines.push(line);
		}

		return lines;
	}

	private renderFooter(width: number): string {
		const selected = this.filteredItems[this.selectedIndex];
		const text = selected?.category === "packages"
			? "Tab switch · ↑↓ move · Space enable/disable all contents · Enter details · Esc close"
			: "Tab switch · ↑↓ move · Space toggle · Enter details · Esc close";
		return truncateToWidth(this.theme.fg("dim", text), width, "…");
	}

	private renderDetailFooter(width: number): string {
		return truncateToWidth(this.theme.fg("dim", "↑↓ move · Enter confirm · Esc back"), width, "…");
	}

	private renderPackageFooter(width: number): string {
		const selected = this.getPackageGroupEntries()[this.packageGroupSelectionIndex];
		const text = this.mode === "packageGroups"
			? selected?.kind === "item"
				? "Type to search · ↑↓ move · Space toggle · Enter details · Esc back"
				: "Type to search · ↑↓ move · Enter open full list · Esc back"
			: "Type to search · ↑↓ move · Enter details · Space toggle · Esc back";
		return truncateToWidth(this.theme.fg("dim", text), width, "…");
	}

	private renderDescriptionBlock(text: string, width: number): string[] {
		const wrapped = wrapTextWithAnsi(this.theme.fg("text", text), Math.max(10, width - 2));
		return wrapped.map((line) => truncateToWidth(`  ${line}`, width, "…"));
	}

	private renderTopRule(width: number): string {
		return this.theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
	}

	private wrapBlock(lines: string[], width: number): string[] {
		return lines.map((line) => truncateToWidth(` ${line}`, width, "…"));
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
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.confirmingRemove) {
				this.confirmingRemove = false;
				this.actionMessage = undefined;
				return;
			}
			this.exitDetailMode();
			return;
		}
		const actions = this.detailItem ? this.getDetailActions(this.detailItem) : [];
		if (kb.matches(data, "tui.select.up")) {
			if (this.confirmingRemove) {
				this.confirmingRemove = false;
				this.actionMessage = undefined;
			}
			this.clearTransientActionMessage();
			this.detailSelectedIndex = Math.max(0, this.detailSelectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.confirmingRemove) {
				this.confirmingRemove = false;
				this.actionMessage = undefined;
			}
			this.clearTransientActionMessage();
			this.detailSelectedIndex = Math.min(actions.length - 1, this.detailSelectedIndex + 1);
			return;
		}
		if (!kb.matches(data, "tui.select.confirm") || !this.detailItem) return;
		const action = actions[this.detailSelectedIndex]!;
		if (this.loadingAction === action) return;
		if (action === "remove") {
			if (!this.confirmingRemove) {
				this.confirmingRemove = true;
				this.actionMessage = undefined;
				return;
			}
			this.confirmingRemove = false;
			this.callbacks.onRemove?.(this.detailItem);
			return;
		}
		if (action === "update" && this.detailItem.category === "packages" && !this.supportsPackageUpdate(this.detailItem)) {
			return;
		}
		switch (action) {
			case "manage":
				if (this.detailItem.category === "packages") {
					this.openPackageGroups(this.detailItem);
				}
				return;
			case "toggle":
				if (this.detailItem.category !== "themes") {
					this.detailItem.enabled = !this.detailItem.enabled;
				}
				this.callbacks.onToggle?.(this.detailItem);
				return;
			case "expose":
				this.detailItem.exposed = !this.detailItem.exposed;
				this.callbacks.onExpose?.(this.detailItem);
				return;
			case "update":
				this.callbacks.onUpdate?.(this.detailItem);
				return;
			case "back":
				this.exitDetailMode();
				return;
			case "remove":
				return;
		}
	}

	private handlePackageGroupsInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.packageItem) {
				this.openDetailItem(this.packageItem, "list");
			} else {
				this.mode = "list";
			}
			return;
		}
		const entries = this.getPackageGroupEntries();
		if (kb.matches(data, "tui.select.up")) {
			this.packageGroupSelectionIndex = Math.max(0, this.packageGroupSelectionIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.packageGroupSelectionIndex = Math.min(entries.length - 1, this.packageGroupSelectionIndex + 1);
			return;
		}
		const selected = entries[this.packageGroupSelectionIndex];
		if (selected && data === " " && selected.kind === "item") {
			if (selected.item.category !== "themes") {
				selected.item.enabled = !selected.item.enabled;
			}
			this.callbacks.onToggle?.(selected.item);
			return;
		}
		if (selected && kb.matches(data, "tui.select.confirm") && this.packageItem?.category === "packages") {
			if (selected.kind === "item") {
				this.openDetailItem(selected.item, "packageGroups");
				return;
			}
			this.packageContentsCategory = selected.category;
			this.packageContentsItems = this.getFilteredPackageContainedItems(this.packageItem, this.packageContentsCategory);
			this.packageContentsSelectedIndex = 0;
			this.mode = "packageItems";
			return;
		}
		const previousQuery = this.getSearchQuery();
		this.packageSearchInput.handleInput(data);
		if (this.getSearchQuery() !== previousQuery) {
			this.filteredPackageItemsCache.clear();
			this.packageGroupEntriesCache = undefined;
		}
		this.packageGroupSelectionIndex = Math.max(0, Math.min(this.packageGroupSelectionIndex, this.getPackageGroupEntries().length - 1));
	}

	private handlePackageItemsInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.mode = "packageGroups";
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.packageContentsSelectedIndex = Math.max(0, this.packageContentsSelectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.packageContentsSelectedIndex = Math.min(this.packageContentsItems.length - 1, this.packageContentsSelectedIndex + 1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.packageContentsItems[this.packageContentsSelectedIndex];
			if (item) this.openDetailItem(item, "packageItems");
			return;
		}
		if (data === " ") {
			const item = this.packageContentsItems[this.packageContentsSelectedIndex];
			if (!item) return;
			if (item.category !== "themes") {
				item.enabled = !item.enabled;
			}
			this.callbacks.onToggle?.(item);
			return;
		}
		const previousQuery = this.getSearchQuery();
		this.packageSearchInput.handleInput(data);
		if (this.getSearchQuery() !== previousQuery) {
			this.filteredPackageItemsCache.clear();
			this.packageGroupEntriesCache = undefined;
		}
		this.refreshPackageContentsItems();
	}

	private getDetailActions(item: ResourceItem): DetailAction[] {
		if (item.category === "packages") return ["manage", "toggle", "update", "remove", "back"];
		if (item.packageSource && item.category !== "themes") return ["toggle", "expose", "back"];
		if (item.packageSource) return ["toggle", "back"];
		if (item.category === "themes") return ["toggle", "remove", "back"];
		return ["toggle", "remove", "back"];
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

	private getDetailActionHint(action: DetailAction, item: ResourceItem): string | undefined {
		switch (action) {
			case "manage":
				if (item.category !== "packages") return undefined;
				return this.theme.fg("dim", "Browse resources in this package");
			case "toggle":
				if (item.category === "packages") {
					return this.theme.fg("dim", item.enabled ? "Disable all resources in this package" : "Enable all resources in this package");
				}
				if (item.category === "themes") {
					return item.enabled ? this.theme.fg("success", "Theme is currently active") : this.theme.fg("dim", "Apply this theme");
				}
				return this.theme.fg("dim", item.enabled ? "Disable this resource" : "Enable this resource");
			case "expose":
				if (!item.packageSource || item.category === "themes") return undefined;
				return this.theme.fg("dim", item.exposed ? "Hide from top-level category" : "Show in top-level category");
			case "update":
				if (item.category !== "packages") return undefined;
				if (!this.supportsPackageUpdate(item)) {
					return this.theme.fg("warning", "Only remote packages can be updated");
				}
				return this.theme.fg("dim", "Update this package");
			case "remove":
				if (item.packageSource) {
					return this.theme.fg("warning", "This package resource can't be removed individually");
				}
				if (item.category === "themes" && !("path" in item)) {
					return this.theme.fg("warning", "Built-in themes can't be removed");
				}
				return this.confirmingRemove
					? this.theme.fg("warning", "Press Enter again to remove · Esc cancels")
					: this.theme.fg("dim", "Remove this resource");
			case "back":
				return this.theme.fg("dim", "Return to previous view");
		}
	}

	private supportsPackageUpdate(item: ResourceItem): boolean {
		return item.category === "packages" && isRemotePackageSource(item.source);
	}

	private getDetailActionLabel(action: DetailAction, item: ResourceItem, selected: boolean): string {
		switch (action) {
			case "manage":
				return this.theme.fg("accent", "Browse Package Contents");
			case "toggle":
				if (item.category === "packages") {
					return item.enabled ? this.theme.fg("warning", "Disable All Contents") : this.theme.fg("success", "Enable All Contents");
				}
				if (item.category === "themes") {
					return item.enabled ? this.theme.fg("success", "Active") : this.theme.fg("accent", "Apply");
				}
				return item.enabled ? this.theme.fg("warning", "Disable") : this.theme.fg("success", "Enable");
			case "expose":
				return item.exposed ? this.theme.fg("warning", "Hide from Category") : this.theme.fg("accent", "Show in Category");
			case "update":
				return "Update";
			case "remove":
				return selected ? this.theme.fg("error", this.theme.bold("Remove")) : this.theme.fg("error", "Remove");
			case "back":
				return "Back";
		}
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
		this.invalidatePackageCaches();
		if (this.detailItem) {
			this.detailItem = this.resources.categories[this.detailItem.category].find((item) => item.id === this.detailItem?.id);
			if (!this.detailItem) {
				this.exitDetailMode();
			}
		}
		if (this.packageItem?.category === "packages") {
			this.packageItem = this.resources.categories.packages.find((item) => item.id === this.packageItem?.id);
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
		this.invalidatePackageCaches();
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
		this.selectedIndex = Math.max(0, Math.min(Math.max(0, this.filteredItems.length - 1), this.selectedIndex + delta));
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
		this.filteredPackageItemsCache.clear();
		this.packageGroupEntriesCache = undefined;
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
		this.filteredItems = items.filter((item) => {
			if (!query) return true;
			const haystacks = [item.name, item.description, item.source, "path" in item ? item.path : item.name];
			return haystacks.some((value) => value.toLowerCase().includes(query));
		});
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
	}

	private getVisibleCategoryItems(category: ResourceCategory): ResourceItem[] {
		const items = this.resources.categories[category];
		if (category === "packages" || category === "themes") return items;
		return items.filter((item) => !item.packageSource || item.exposed);
	}

	private getHeaderTitle(): string {
		if (this.mode === "detail" && this.detailItem) return this.getDetailTitle(this.detailItem);
		if (this.mode === "packageGroups" && this.packageItem?.category === "packages") {
			return `Packages / ${formatPackageLabel(this.packageItem.source)} / Contents`;
		}
		if (this.mode === "packageItems" && this.packageItem?.category === "packages") {
			return `Packages / ${formatPackageLabel(this.packageItem.source)} / ${CATEGORY_LABELS[this.packageContentsCategory]}`;
		}
		return `Resources / ${CATEGORY_LABELS[this.category]}`;
	}

	private getDetailTitle(item: ResourceItem): string {
		if (item.category === "packages") return `Packages / ${formatPackageLabel(item.source)}`;
		if (item.packageSource) return `Packages / ${formatPackageLabel(item.packageSource)} / ${CATEGORY_LABELS[item.category]} / ${item.name}`;
		return `Resources / ${CATEGORY_LABELS[item.category]} / ${item.name}`;
	}

	private getEmptyPackageCategoryMessage(category: PackageContentCategory): string {
		if (this.getSearchQuery()) {
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

	private getPackageCategories(): PackageContentCategory[] {
		return ["extensions", "skills", "prompts", "themes"];
	}

	private getActiveSearchInput(): Input {
		return this.mode === "packageGroups" || this.mode === "packageItems" ? this.packageSearchInput : this.mainSearchInput;
	}

	private getSearchQuery(): string {
		return this.packageSearchInput.getValue().trim().toLowerCase();
	}

	private matchesResourceQuery(item: ResourceItem, query: string): boolean {
		if (!query) return true;
		const haystacks = [
			item.name,
			item.description,
			item.source,
			item.packageSource ?? "",
			item.packageRelativePath ?? "",
			"path" in item ? item.path : item.name,
		];
		return haystacks.some((value) => value.toLowerCase().includes(query));
	}

	private getFilteredPackageContainedItems(pkg: ResourceItem, category: PackageContentCategory): ResourceItem[] {
		const query = this.getSearchQuery();
		const cacheKey = `${pkg.id}:${category}:${query}`;
		const cached = this.filteredPackageItemsCache.get(cacheKey);
		if (cached) return cached;
		const items = this.getPackageContainedItems(pkg, category);
		const filtered = !query
			? items
			: CATEGORY_LABELS[category].toLowerCase().includes(query)
				? items
				: items.filter((item) => this.matchesResourceQuery(item, query));
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
		const entries: PackageGroupEntry[] = [];
		for (const category of this.getPackageCategories()) {
			const categoryMatches = !query || CATEGORY_LABELS[category].toLowerCase().includes(query);
			const items = this.getFilteredPackageContainedItems(pkg, category);
			if (!categoryMatches && items.length === 0) continue;
			entries.push({ kind: "category", category });
			for (const item of items.slice(0, 5)) {
				entries.push({ kind: "item", category, item });
			}
			if (items.length > 5) {
				entries.push({ kind: "more", category, remaining: items.length - 5 });
			}
		}
		this.packageGroupEntriesCache = { packageId: pkg.id, query, entries };
		return entries;
	}

	private getPackageContainedItems(pkg: ResourceItem, category: PackageContentCategory): ResourceItem[] {
		if (pkg.category !== "packages") return [];
		const cacheKey = `${pkg.id}:${category}`;
		const cached = this.containedItemsCache.get(cacheKey);
		if (cached) return cached;
		const items = this.resources.categories[category].filter((item) => item.packageSource === pkg.source);
		this.containedItemsCache.set(cacheKey, items);
		return items;
	}
}
