/**
 * 浏览器各页面的纯渲染函数。
 */
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { BrowserTheme, DetailAction, PackageContentCategory, PackageGroupEntry, SettingsSection } from "./shared.js";
import { CATEGORY_LABELS, CATEGORY_ORDER, SETTINGS_SECTION_LABELS, SETTINGS_SECTION_ORDER, formatPackageLabel } from "./shared.js";
import { canExposeResource, isContainedResource, isPackageItem } from "../resource/capabilities.js";
import type { ResourceCategory, ResourceItem } from "../types.js";

export function renderHeader(theme: BrowserTheme, width: number, title: string, count: number): string[] {
	const left = theme.fg("accent", theme.bold(title));
	const right = theme.fg("muted", `${count} result${count === 1 ? "" : "s"}`);
	const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return [truncateToWidth(`${left}${" ".repeat(spacing)}${right}`, width, "")];
}

export function renderTabs(theme: BrowserTheme, width: number, category: ResourceCategory): string[] {
	const title = theme.fg("muted", "(tab to cycle)");
	const tabs = CATEGORY_ORDER.map((entry) => {
		const label = ` ${CATEGORY_LABELS[entry]} `;
		if (entry === category) {
			return theme.bg("selectedBg", theme.fg("accent", theme.bold(label)));
		}
		return theme.fg("muted", label);
	}).join(" ");
	return [truncateToWidth(`${tabs}  ${title}`, width, "…")];
}

export function renderSearch(
	theme: BrowserTheme,
	width: number,
	mode: "packageGroups" | "packageItems" | "list",
	packageContentsCategory: PackageContentCategory,
	inputText: string,
): string[] {
	const label = mode === "packageGroups"
		? "Search in package:"
		: mode === "packageItems"
			? `Search in ${CATEGORY_LABELS[packageContentsCategory].toLowerCase()}:`
			: "Search:";
	return [truncateToWidth(`${theme.fg("muted", label)} ${inputText}`, width, "…")];
}

export function renderListPage(args: {
	theme: BrowserTheme;
	width: number;
	items: ResourceItem[];
	selectedIndex: number;
	maxVisible: number;
	isPinned: (item: ResourceItem) => boolean;
	formatPackageToggleState: (item: ResourceItem) => string;
	formatBinaryToggle: (enabled: boolean, bold?: boolean) => string;
}): string[] {
	const { theme, width, items, selectedIndex, maxVisible, isPinned, formatPackageToggleState, formatBinaryToggle } = args;
	if (items.length === 0) {
		return [theme.fg("muted", "  Nothing matches the current view")];
	}

	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
	const endIndex = Math.min(items.length, startIndex + maxVisible);
	const lines: string[] = [];

	for (let index = startIndex; index < endIndex; index++) {
		const item = items[index]!;
		const selected = index === selectedIndex;
		const marker = selected ? theme.fg("accent", "▌") : theme.fg("dim", " ");
		const toggle = isPackageItem(item) ? formatPackageToggleState(item) : formatBinaryToggle(item.enabled, true);
		const pinBadge = isPinned(item) ? theme.fg("accent", "[pin] ") : "";
		const packageBadge = isContainedResource(item) ? theme.fg("accent", theme.bold("[pkg] ")) : "";
		const packageVersion = isPackageItem(item) && item.version ? theme.fg("dim", ` @${item.version}`) : "";
		const nameText = `${pinBadge}${packageBadge}${item.name}${packageVersion}`;
		const name = selected ? theme.bold(nameText) : theme.fg("text", nameText);
		const scope = item.scope === "project" ? theme.fg("success", "project") : theme.fg("warning", "user");
		const sourceValue = item.packageSource ?? item.sourceLabel ?? item.source;
		const source = theme.fg("dim", item.packageSource ? formatPackageLabel(sourceValue) : sourceValue);
		const right = `${scope}  ${source}`;
		const left = `${marker} ${toggle} ${name}`;
		const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		let line = truncateToWidth(`${left}${" ".repeat(spacing)}${right}`, width, "…");
		line = selected ? theme.bg("selectedBg", line) : theme.fg("text", line);
		lines.push(line);

		const nextItem = index + 1 < endIndex ? items[index + 1] : undefined;
		if (isPackageItem(item) && nextItem && !isPackageItem(nextItem)) {
			lines.push(theme.fg("dim", ""));
		}
	}

	if (startIndex > 0 || endIndex < items.length) {
		lines.push(theme.fg("dim", truncateToWidth(`(${selectedIndex + 1}/${items.length})`, width, "")));
	}

	return lines;
}

export function renderDetailPage(args: {
	theme: BrowserTheme;
	width: number;
	item: ResourceItem | undefined;
	settings: {
		showSource: boolean;
		showPath: boolean;
		showPathInPackage: boolean;
		};
	isPinned: (item: ResourceItem) => boolean;
	detailSelectedIndex: number;
	getDetailActions: (item: ResourceItem) => DetailAction[];
	getDetailActionLabel: (action: DetailAction, item: ResourceItem, selected: boolean) => string;
	getPersistedActionHint: (action: DetailAction) => string | undefined;
	getDetailActionHint: (action: DetailAction, item: ResourceItem) => string | undefined;
	formatPackageEnabledStateText: (item: ResourceItem) => string;
	formatPackageEnabledSummary: (item: ResourceItem) => string | undefined;
	formatPackageCounts: (item: ResourceItem, detailed?: boolean, dimmed?: boolean) => string | undefined;
}): string[] {
	const {
		theme,
		width,
		item,
		settings,
		isPinned,
		detailSelectedIndex,
		getDetailActions,
		getDetailActionLabel,
		getPersistedActionHint,
		getDetailActionHint,
		formatPackageEnabledStateText,
		formatPackageEnabledSummary,
		formatPackageCounts,
	} = args;
	if (!item) return [theme.fg("muted", "Nothing selected")];

	const enabledText = isPackageItem(item)
		? formatPackageEnabledStateText(item)
		: item.enabled
			? theme.fg("success", "on")
			: theme.fg("dim", "off");
	const sourceText = item.packageSource ?? item.sourceLabel ?? item.source;
	const pathText = isPackageItem(item) ? item.installPath : "path" in item ? item.path : undefined;
	const pinnedText = isPinned(item) ? theme.fg("accent", "[pin]") : theme.fg("dim", "no");
	const lines = [
		truncateToWidth(`${theme.fg("muted", "Category")}: ${CATEGORY_LABELS[item.category]}`, width, "…"),
		truncateToWidth(`${theme.fg("muted", "Enabled")}: ${enabledText}`, width, "…"),
		truncateToWidth(`${theme.fg("muted", "Pinned")}: ${pinnedText}`, width, "…"),
		truncateToWidth(`${theme.fg("muted", "Scope")}: ${item.scope}`, width, "…"),
		truncateToWidth(`${theme.fg("muted", "Name")}: ${item.name}`, width, "…"),
		...(item.category === "prompts" && "argumentHint" in item && item.argumentHint
			? [truncateToWidth(`${theme.fg("muted", "Argument Hint")}: ${item.argumentHint}`, width, "…")]
			: []),
		...(settings.showSource ? [truncateToWidth(`${theme.fg("muted", "Source")}: ${sourceText}`, width, "…")] : []),
		...(settings.showPathInPackage && item.packageRelativePath
			? [truncateToWidth(`${theme.fg("muted", "Path in Package")}: ${item.packageRelativePath}`, width, "…")]
			: []),
		...(settings.showPath && pathText
			? [truncateToWidth(`${theme.fg("muted", "Path")}: ${pathText}`, width, "…")]
			: []),
	];
	if (isPackageItem(item)) {
		if (item.version) lines.push(truncateToWidth(`${theme.fg("muted", "Version")}: ${item.version}`, width, "…"));
		const enabledSummary = formatPackageEnabledSummary(item);
		if (enabledSummary) lines.push(truncateToWidth(`${theme.fg("muted", "Enabled Resources")}: ${enabledSummary}`, width, "…"));
		const counts = formatPackageCounts(item, true);
		if (counts) lines.push(truncateToWidth(`${theme.fg("muted", "Resources")}: ${counts}`, width, "…"));
	}
	lines.push("");
	lines.push(truncateToWidth(theme.fg("accent", theme.bold("Description")), width, "…"));
	lines.push(...renderDescriptionBlock(theme, item.description, width));
	lines.push("");
	lines.push(theme.fg("accent", theme.bold("Actions")));
	const actions = getDetailActions(item);
	for (let i = 0; i < actions.length; i++) {
		const action = actions[i]!;
		const selected = i === detailSelectedIndex;
		const label = getDetailActionLabel(action, item, selected);
		const actionHint = selected ? getPersistedActionHint(action) ?? getDetailActionHint(action, item) : getPersistedActionHint(action);
		let line = `${selected ? theme.fg("accent", "› ") : "  "}${label}`;
		if (actionHint) line += theme.fg("dim", "  ·  ") + actionHint;
		line = truncateToWidth(line, width, "…");
		if (selected) line = theme.bg("selectedBg", line);
		lines.push(line);
	}
	return lines;
}

export function renderPackageGroupsPage(args: {
	theme: BrowserTheme;
	width: number;
	pkg: ResourceItem | undefined;
	entries: PackageGroupEntry[];
	selectedIndex: number;
	isPinned: (item: ResourceItem) => boolean;
	getItemsForCategory: (category: PackageContentCategory) => ResourceItem[];
	formatBinaryToggle: (enabled: boolean, bold?: boolean) => string;
}): string[] {
	const { theme, width, pkg, entries, selectedIndex, isPinned, getItemsForCategory, formatBinaryToggle } = args;
	if (!pkg || pkg.category !== "packages") return [theme.fg("muted", "No package selected")];
	const lines = [""];
	if (entries.length === 0) {
		lines.push(theme.fg("muted", "No package contents match the current search"));
		return lines;
	}
	for (const [index, entry] of entries.entries()) {
		const selected = index === selectedIndex;
		let line = "";
		if (entry.kind === "category") {
			const items = getItemsForCategory(entry.category);
			const enabledCount = items.filter((item) => item.enabled).length;
			const countColor = items.length === 0 ? "dim" : enabledCount === items.length ? "success" : enabledCount === 0 ? "dim" : "warning";
			line = `${selected ? theme.fg("accent", "› ") : "  "}${CATEGORY_LABELS[entry.category]} (${theme.fg(countColor, `${enabledCount}/${items.length}`)})`;
		} else if (entry.kind === "item") {
			const toggle = formatBinaryToggle(entry.item.enabled);
			const pinBadge = isPinned(entry.item) ? theme.fg("accent", "[pin]") : "";
			const exposure = canExposeResource(entry.item)
				? entry.item.exposed
					? theme.fg("accent", "[shown]")
					: theme.fg("dim", "[hidden]")
				: "";
			const label = entry.item.packageRelativePath ?? entry.item.name;
			line = `  ${selected ? theme.fg("accent", "›") : " "}   ${toggle}${exposure ? ` ${exposure}` : ""}${pinBadge ? ` ${pinBadge}` : ""} ${theme.fg("dim", label)}`;
		} else {
			line = `  ${selected ? theme.fg("accent", "›") : " "}   ${theme.fg("accent", `… more (${entry.remaining} more, press Enter to open full list)`)}`;
		}
		line = truncateToWidth(line, width, "…");
		if (selected) line = theme.bg("selectedBg", line);
		lines.push(line);
	}
	return lines;
}

export function renderPackageItemsPage(args: {
	theme: BrowserTheme;
	width: number;
	pkg: ResourceItem | undefined;
	items: ResourceItem[];
	selectedIndex: number;
	isPinned: (item: ResourceItem) => boolean;
	emptyMessage: string;
	formatBinaryToggle: (enabled: boolean, bold?: boolean) => string;
}): string[] {
	const { theme, width, pkg, items, selectedIndex, isPinned, emptyMessage, formatBinaryToggle } = args;
	if (!pkg || pkg.category !== "packages") return [theme.fg("muted", "No package selected")];
	const lines = [""];
	if (items.length === 0) {
		lines.push(theme.fg("muted", emptyMessage));
		return lines;
	}
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const selected = index === selectedIndex;
		const marker = selected ? theme.fg("accent", "▌") : theme.fg("dim", " ");
		const toggle = formatBinaryToggle(item.enabled, true);
		const pinBadge = isPinned(item) ? theme.fg("accent", "[pin] ") : "";
		const exposure = canExposeResource(item)
			? item.exposed
				? theme.fg("accent", theme.bold("[shown]"))
				: theme.fg("dim", "[hidden]")
			: "";
		const primary = `${marker} ${toggle}${exposure ? ` ${exposure}` : ""} ${pinBadge}${item.name}`;
		const label = theme.fg("dim", item.packageRelativePath ?? ("path" in item ? item.path : item.name));
		const spacing = Math.max(1, width - visibleWidth(primary) - visibleWidth(label));
		let line = truncateToWidth(`${primary}${" ".repeat(spacing)}${label}`, width, "…");
		line = selected ? theme.bg("selectedBg", line) : theme.fg("text", line);
		lines.push(line);
	}
	return lines;
}

export function renderFooterWithSettingsHint(theme: BrowserTheme, width: number, text: string): string {
	const base = theme.fg("dim", text);
	const hint = theme.fg("accent", theme.bold("S Settings"));
	return truncateToWidth(`${base}${theme.fg("dim", " · ")}${hint}`, width, "…");
}

export function renderSettingsTabs(theme: BrowserTheme, width: number, section: SettingsSection): string[] {
	const title = theme.fg("muted", "(tab to cycle)");
	const tabs = SETTINGS_SECTION_ORDER.map((entry) => {
		const label = ` ${SETTINGS_SECTION_LABELS[entry]} `;
		if (entry === section) {
			return theme.bg("selectedBg", theme.fg("accent", theme.bold(label)));
		}
		return theme.fg("muted", label);
	}).join(" ");
	return [truncateToWidth(`${tabs}  ${title}`, width, "…")];
}

export function renderSettingsSearch(theme: BrowserTheme, width: number, input: string): string[] {
	const label = "Search:";
	return [truncateToWidth(`${theme.fg("muted", label)} ${input}`, width, "…")];
}

export function renderDescriptionBlock(theme: BrowserTheme, text: string, width: number): string[] {
	const wrapped = wrapTextWithAnsi(theme.fg("text", text), Math.max(10, width - 2));
	return wrapped.map((line) => truncateToWidth(`  ${line}`, width, "…"));
}

export function renderTopRule(theme: BrowserTheme, width: number): string {
	return theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
}

export function wrapBlock(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(` ${line}`, width, "…"));
}
