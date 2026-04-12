import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { discoverResources } from "./discovery.js";
import { canExposeResource, canRemoveResourceIndividually, isContainedResource, isThemeItem } from "./resource-capabilities.js";
import { getResourceSearchCandidates } from "./resource-identity.js";
import {
	getExposeSuccessMessage,
	getRemoveBlockedMessage,
	getRemovedConventionFileMessage,
	getRemoveSuccessMessage,
	getToggleSuccessMessage,
} from "./resource-messages.js";
import { addPackageToSettings, removeConventionResource, removeResourceFromSettings, setActiveTheme, setResourceExposed, toggleResourceInSettings } from "./settings.js";
import { normalizeCategoryAlias } from "./resource-completions.js";
import type { ResourceCategory, ResourceItem } from "./types.js";

export async function handleAddCommand(
	args: string,
	ctx: ExtensionCommandContext,
	refreshCompletions: () => Promise<void>,
): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts.length > 2) {
		ctx.ui.notify("Usage: /resource add <package-source> [project|user]", "info");
		return;
	}
	const source = parts[0]!;
	const scopeArg = parts[1];
	if (scopeArg && scopeArg !== "project" && scopeArg !== "user") {
		ctx.ui.notify(`Unknown scope "${scopeArg}". Use project or user.`, "warning");
		return;
	}
	const scope = scopeArg === "user" ? "user" : "project";
	const settingsPath = await addPackageToSettings(ctx.cwd, source, scope);
	await refreshCompletions();
	await reloadAfterSettingsChange(ctx, `Added package ${source} · ${settingsPath}`);
}

export async function handleMutateCommand(
	action: "remove" | "enable" | "disable",
	args: string,
	ctx: ExtensionCommandContext,
	refreshCompletions: () => Promise<void>,
): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		ctx.ui.notify(`Usage: /resource ${action} [category] <name-or-source>`, "info");
		return;
	}
	let category: ResourceCategory | undefined;
	let query = args.trim();
	if (isCategoryAlias(parts[0]!)) {
		category = normalizeCategoryAlias(parts[0]!);
		query = args.trim().slice(parts[0]!.length).trim();
	}
	if (!query) {
		ctx.ui.notify(`Usage: /resource ${action} [category] <name-or-source>`, "info");
		return;
	}

	const resources = await discoverResources(ctx.cwd);
	const matches = findResources(resources, query, category);
	if (matches.length === 0) {
		ctx.ui.notify(`No resource found for "${query}"`, "warning");
		return;
	}
	if (matches.length > 1) {
		const list = matches.slice(0, 5).map((item) => `${item.category}: ${item.name}`).join(", ");
		ctx.ui.notify(`More than one resource matched: ${list}`, "warning");
		return;
	}

	const item = matches[0]!;
	if (action === "remove") {
		if (!canRemoveResourceIndividually(item)) {
			ctx.ui.notify(getRemoveBlockedMessage(item) ?? "Remove is not allowed for this resource.", "warning");
			return;
		}
		if (item.source === "convention") {
			const filePath = await removeConventionResource(item);
			await refreshCompletions();
			ctx.ui.notify(getRemovedConventionFileMessage(filePath), "info");
			return;
		}
		const settingsPath = await removeResourceFromSettings(ctx.cwd, item);
		await refreshCompletions();
		await reloadAfterSettingsChange(ctx, getRemoveSuccessMessage(item, settingsPath));
		return;
	}

	if (isThemeItem(item)) {
		if (isContainedResource(item) && action === "disable") {
			item.enabled = false;
			const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
			await refreshCompletions();
			await reloadAfterSettingsChange(ctx, getToggleSuccessMessage(item, settingsPath));
			return;
		}
		if (action === "disable") {
			ctx.ui.notify("Themes aren't disabled directly. Apply another theme instead.", "warning");
			return;
		}
		const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope);
		ctx.ui.setTheme(item.name);
		await refreshCompletions();
		ctx.ui.notify(getToggleSuccessMessage(item, settingsPath), "info");
		return;
	}

	item.enabled = action === "enable";
	const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
	await refreshCompletions();
	await reloadAfterSettingsChange(ctx, getToggleSuccessMessage(item, settingsPath));
}

export async function handleExposureCommand(
	action: "expose" | "hide",
	args: string,
	ctx: ExtensionCommandContext,
	refreshCompletions: () => Promise<void>,
): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		ctx.ui.notify(`Usage: /resource ${action} [category] <name-or-source>`, "info");
		return;
	}
	let category: ResourceCategory | undefined;
	let query = args.trim();
	if (isCategoryAlias(parts[0]!)) {
		category = normalizeCategoryAlias(parts[0]!);
		query = args.trim().slice(parts[0]!.length).trim();
	}
	if (!query) {
		ctx.ui.notify(`Usage: /resource ${action} [category] <name-or-source>`, "info");
		return;
	}

	const resources = await discoverResources(ctx.cwd);
	const matches = findResources(resources, query, category);
	if (matches.length === 0) {
		ctx.ui.notify(`No resource found for "${query}"`, "warning");
		return;
	}
	if (matches.length > 1) {
		const list = matches.slice(0, 5).map((item) => `${item.category}: ${item.name}`).join(", ");
		ctx.ui.notify(`More than one resource matched: ${list}`, "warning");
		return;
	}
	const item = matches[0]!;
	if (!canExposeResource(item)) {
		ctx.ui.notify("Only package-contained extensions, skills, and prompts can be shown or hidden in top-level categories.", "warning");
		return;
	}
	const exposed = action === "expose";
	const statePath = await setResourceExposed(ctx.cwd, item, exposed);
	await refreshCompletions();
	ctx.ui.notify(getExposeSuccessMessage(item, exposed, statePath), "info");
}

export async function reloadAfterSettingsChange(ctx: ExtensionCommandContext, message: string): Promise<void> {
	try {
		await ctx.reload();
		return;
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`${message}. Settings were saved, but reload failed: ${detail}`, "warning");
	}
}

export function findResources(resources: { categories: Record<ResourceCategory, ResourceItem[]> }, query: string, category?: ResourceCategory): ResourceItem[] {
	const normalized = query.toLowerCase();
	const all = category ? resources.categories[category] : Object.values(resources.categories).flat();
	return all.filter((item) => getResourceSearchCandidates(item).some((value) => value.toLowerCase() === normalized || value.toLowerCase().includes(normalized)));
}

function isCategoryAlias(value: string): boolean {
	return ["package", "packages", "skill", "skills", "extension", "extensions", "prompt", "prompts", "theme", "themes"].includes(value);
}
