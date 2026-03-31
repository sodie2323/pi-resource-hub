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

type BrowserMode = "list" | "detail";
type DetailAction = "toggle" | "update" | "remove" | "back";

interface BrowserCallbacks {
	onClose: () => void | Promise<void>;
	onInspect?: (item: ResourceItem) => void;
	onToggle?: (item: ResourceItem) => void;
	onUpdate?: (item: ResourceItem) => void;
	onRemove?: (item: ResourceItem) => void;
}

export class ResourceBrowser implements Component, Focusable {
	private readonly theme: Theme;
	private readonly callbacks: BrowserCallbacks;
	private readonly searchInput: Input;
	private readonly resources: ResourceIndex;
	private category: ResourceCategory;
	private filteredItems: ResourceItem[] = [];
	private selectedIndex = 0;
	private maxVisible = 8;
	private mode: BrowserMode = "list";
	private detailItem: ResourceItem | undefined;
	private detailSelectedIndex = 0;
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
		this.searchInput.focused = value;
	}

	constructor(theme: Theme, resources: ResourceIndex, category: ResourceCategory, callbacks: BrowserCallbacks) {
		this.theme = theme;
		this.resources = resources;
		this.category = category;
		this.callbacks = callbacks;
		this.searchInput = new Input();
		this.searchInput.setValue("");
		this.applyFilter();
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.mode === "detail") {
			this.handleDetailInput(data);
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

		this.searchInput.handleInput(data);
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
		const left = this.theme.fg("accent", this.theme.bold("Resources:"));
		const right = this.theme.fg("muted", `${this.filteredItems.length} item(s)`);
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
		const inputWidth = Math.max(1, width - 10);
		const inputLines = this.searchInput.render(inputWidth);
		const input = inputLines[0] ?? "";
		return [truncateToWidth(`${this.theme.fg("muted", "Search:")} ${input}`, width, "…")];
	}

	private renderList(width: number): string[] {
		if (this.filteredItems.length === 0) {
			return [this.theme.fg("muted", "No resources found")];
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
			const toggle = item.enabled
				? this.theme.fg("success", this.theme.bold("[on]"))
				: this.theme.fg("dim", this.theme.bold("[off]"));
			const name = selected ? this.theme.bold(item.name) : this.theme.fg("text", item.name);
			const scope = item.scope === "project" ? this.theme.fg("success", "project") : this.theme.fg("warning", "user");
			const source = this.theme.fg("dim", item.source);
			const left = `${marker} ${toggle} ${name}`;
			const right = `${scope}  ${source}`;
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
		if (!item) return [this.theme.fg("muted", "No selection")];

		const enabledText = item.enabled ? this.theme.fg("success", "on") : this.theme.fg("dim", "off");
		const title = this.theme.fg("accent", this.theme.bold(`Resource Details: ${item.name}`));
		const hint = this.theme.fg("dim", "Esc to go back");
		const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
		const lines = [
			truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, "…"),
			"",
			truncateToWidth(`${this.theme.fg("muted", "Category")}: ${CATEGORY_LABELS[item.category]}`, width, "…"),
			truncateToWidth(`${this.theme.fg("muted", "Enabled")}: ${enabledText}`, width, "…"),
			truncateToWidth(`${this.theme.fg("muted", "Scope")}: ${item.scope}`, width, "…"),
			truncateToWidth(`${this.theme.fg("muted", "Source")}: ${item.source}`, width, "…"),
			truncateToWidth(`${this.theme.fg("muted", "Value")}: ${"path" in item ? item.path : item.name}`, width, "…"),
		];
		if (item.category === "packages") {
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

	private renderFooter(width: number): string {
		return truncateToWidth(
			this.theme.fg("dim", "Left/Right switch tabs · Up/Down navigate · Space toggle/apply · Enter inspect · Esc close"),
			width,
			"…",
		);
	}

	private renderDetailFooter(width: number): string {
		return truncateToWidth(this.theme.fg("dim", "Up/Down choose action · Enter confirm · Esc back"), width, "…");
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
			this.detailSelectedIndex = Math.max(0, this.detailSelectedIndex - 1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.confirmingRemove) {
				this.confirmingRemove = false;
				this.actionMessage = undefined;
			}
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
		if (
			action === "update" &&
			this.detailItem.category === "packages" &&
			!this.supportsPackageUpdate(this.detailItem)
		) {
			return;
		}
		switch (action) {
			case "toggle":
				if (this.detailItem.category !== "themes") {
					this.detailItem.enabled = !this.detailItem.enabled;
				}
				this.callbacks.onToggle?.(this.detailItem);
				return;
			case "update":
				this.callbacks.onUpdate?.(this.detailItem);
				return;
			case "back":
				this.exitDetailMode();
				return;
		}
	}

	private getDetailActions(item: ResourceItem): DetailAction[] {
		if (item.category === "packages") return ["toggle", "update", "remove", "back"];
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
			case "toggle":
				if (item.category === "themes") {
					return item.enabled ? this.theme.fg("success", "Currently active") : this.theme.fg("dim", "Enter to apply theme");
				}
				return this.theme.fg("dim", item.enabled ? "Enter to disable" : "Enter to enable");
			case "update":
				if (item.category !== "packages") return undefined;
				if (!this.supportsPackageUpdate(item)) {
					return this.theme.fg("warning", "Local path packages cannot be updated");
				}
				return this.theme.fg("dim", "Enter to update package");
			case "remove":
				if (item.category === "themes" && !("path" in item)) {
					return this.theme.fg("warning", "Built-in themes cannot be removed");
				}
				return this.confirmingRemove
					? this.theme.fg("warning", "Enter again to remove · Esc cancel")
					: this.theme.fg("dim", "Enter to remove");
			case "back":
				return this.theme.fg("dim", "Enter to return to list");
		}
	}

	private supportsPackageUpdate(item: ResourceItem): boolean {
		return item.category === "packages" && isRemotePackageSource(item.source);
	}

	private getDetailActionLabel(action: DetailAction, item: ResourceItem, selected: boolean): string {
		switch (action) {
			case "toggle":
				if (item.category === "themes") {
					return item.enabled ? this.theme.fg("success", "Active") : this.theme.fg("accent", "Apply");
				}
				return item.enabled ? this.theme.fg("warning", "Disable") : this.theme.fg("success", "Enable");
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

	public advanceLoadingFrame(): void {
		if (!this.loadingAction) return;
		this.loadingFrame += 1;
	}

	public setResources(resources: ResourceIndex): void {
		for (const category of CATEGORY_ORDER) {
			this.resources.categories[category] = resources.categories[category];
		}
		if (this.detailItem) {
			this.detailItem = this.resources.categories[this.detailItem.category].find((item) => item.id === this.detailItem?.id);
			if (!this.detailItem) {
				this.exitDetailMode();
			}
		}
		this.applyFilter();
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filteredItems.length - 1));
	}

	public removeItem(item: ResourceItem): void {
		for (const category of CATEGORY_ORDER) {
			this.resources.categories[category] = this.resources.categories[category].filter((candidate) => candidate.id !== item.id);
		}
		this.exitDetailMode();
		this.applyFilter();
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filteredItems.length - 1));
	}

	private exitDetailMode(): void {
		this.mode = "list";
		this.detailItem = undefined;
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
		this.detailItem = selected;
		this.detailSelectedIndex = 0;
		this.confirmingRemove = false;
		this.mode = "detail";
		this.callbacks.onInspect?.(selected);
	}

	private moveCategory(direction: 1 | -1): void {
		const index = CATEGORY_ORDER.indexOf(this.category);
		const next = (index + direction + CATEGORY_ORDER.length) % CATEGORY_ORDER.length;
		this.category = CATEGORY_ORDER[next]!;
		this.searchInput.setValue("");
		this.applyFilter();
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue().trim().toLowerCase();
		const items = this.resources.categories[this.category];
		this.filteredItems = items.filter((item) => {
			if (!query) return true;
			const haystacks = [item.name, item.description, item.source, "path" in item ? item.path : item.name];
			return haystacks.some((value) => value.toLowerCase().includes(query));
		});
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
	}
}
