import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ResourceBrowser } from "./browser.js";
import { discoverResources } from "./discovery.js";
import { addPackageToSettings, removeResourceFromSettings, setActiveTheme, toggleResourceInSettings } from "./settings.js";
import { isRemotePackageSource, type ResourceCategory, type ResourceItem } from "./types.js";

const CATEGORIES: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];
const ROOT_COMPLETIONS = [
	{ value: "add", description: "Add a package source to project or user settings" },
	{ value: "remove", description: "Remove a resource or package from settings" },
	{ value: "enable", description: "Enable a resource or package in settings" },
	{ value: "disable", description: "Disable a resource or package in settings" },
	{ value: "sync", description: "Rediscover resources and report the current count" },
	{ value: "packages", description: "Open the packages browser" },
	{ value: "skills", description: "Open the skills browser" },
	{ value: "extensions", description: "Open the extensions browser" },
	{ value: "prompts", description: "Open the prompts browser" },
	{ value: "themes", description: "Open the themes browser" },
] as const;
const ADD_SCOPE_COMPLETIONS = [
	{ value: "project", description: "Write to the current project's pi settings" },
	{ value: "user", description: "Write to the user-level pi settings" },
] as const;
const MUTATION_CATEGORY_COMPLETIONS = [
	{ value: "package", description: "Match a package by name or source" },
	{ value: "skill", description: "Match a skill by name, source, or path" },
	{ value: "extension", description: "Match an extension by name, source, or path" },
	{ value: "prompt", description: "Match a prompt by name, source, or path" },
	{ value: "theme", description: "Match a theme by name, source, or path" },
] as const;
const CATEGORY_ALIAS_MAP: Record<string, ResourceCategory> = {
	package: "packages",
	packages: "packages",
	skill: "skills",
	skills: "skills",
	extension: "extensions",
	extensions: "extensions",
	prompt: "prompts",
	prompts: "prompts",
	theme: "themes",
	themes: "themes",
};

let resourceCompletionCache: Record<ResourceCategory, string[]> = {
	packages: [],
	skills: [],
	extensions: [],
	prompts: [],
	themes: [],
};

export default function resourceCenter(pi: ExtensionAPI) {
	pi.registerCommand("resource", {
		description: "Browse packages, skills, extensions, prompts, and themes",
		getArgumentCompletions: (prefix) => getResourceArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			await handleResourceCommand(args, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshCompletionCache(ctx.cwd);
	});
}

async function handleResourceCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const [subcommand] = args.trim().split(/\s+/, 1);
	if (!subcommand) {
		await openBrowser("packages", ctx, pi);
		return;
	}

	if (isCategory(subcommand)) {
		await openBrowser(subcommand, ctx, pi);
		return;
	}

	if (subcommand === "sync") {
		const resources = await discoverResources(ctx.cwd);
		const count = Object.values(resources.categories).reduce((sum, items) => sum + items.length, 0);
		ctx.ui.notify(`Discovered ${count} resources`, "info");
		return;
	}

	if (subcommand === "add") {
		await handleAddCommand(sliceCommandArgs(args, subcommand), ctx);
		return;
	}

	if (subcommand === "remove") {
		await handleMutateCommand("remove", sliceCommandArgs(args, subcommand), ctx);
		return;
	}

	if (subcommand === "enable") {
		await handleMutateCommand("enable", sliceCommandArgs(args, subcommand), ctx);
		return;
	}

	if (subcommand === "disable") {
		await handleMutateCommand("disable", sliceCommandArgs(args, subcommand), ctx);
		return;
	}

	ctx.ui.notify(`Unknown /resource subcommand: ${subcommand}`, "warning");
}

function isCategory(value: string): value is ResourceCategory {
	return CATEGORIES.includes(value as ResourceCategory);
}

function getResourceArgumentCompletions(prefix: string) {
	const trimmed = prefix.trimStart();
	const parts = trimmed.split(/\s+/).filter(Boolean);
	const endsWithSpace = /\s$/.test(prefix);

	if (parts.length === 0) {
		return buildCompletionItems(ROOT_COMPLETIONS, "");
	}

	if (parts.length === 1 && !endsWithSpace) {
		return buildCompletionItems(ROOT_COMPLETIONS, parts[0]!);
	}

	const command = parts[0]!;
	if (command === "add") {
		const current = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
		return buildCompletionItems(ADD_SCOPE_COMPLETIONS, current);
	}

	if (["remove", "enable", "disable"].includes(command)) {
		if (parts.length === 1 || (parts.length === 2 && !endsWithSpace)) {
			const current = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
			return buildCompletionItems(MUTATION_CATEGORY_COMPLETIONS, current);
		}

		const category = normalizeCategoryAlias(parts[1]!);
		const current = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
		return buildCompletionItems(resourceCompletionCache[category], current);
	}

	return null;
}

function buildCompletionItems(
	values: ReadonlyArray<string | { value: string; description?: string; label?: string }>,
	prefix: string,
) {
	const normalizedPrefix = prefix.toLowerCase();
	const seen = new Set<string>();
	const items = values
		.map((value) =>
			typeof value === "string"
				? { value, label: value }
				: { value: value.value, label: value.label ?? value.value, description: value.description },
		)
		.filter((value) => {
			if (seen.has(value.value)) return false;
			seen.add(value.value);
			return value.value.toLowerCase().startsWith(normalizedPrefix);
		});
	return items.length > 0 ? items : null;
}

function sliceCommandArgs(args: string, subcommand: string): string {
	return args.trim().slice(subcommand.length).trim();
}

async function refreshCompletionCache(cwd: string): Promise<void> {
	const resources = await discoverResources(cwd);
	resourceCompletionCache = {
		packages: uniqueCompletionValues(resources.categories.packages),
		skills: uniqueCompletionValues(resources.categories.skills),
		extensions: uniqueCompletionValues(resources.categories.extensions),
		prompts: uniqueCompletionValues(resources.categories.prompts),
		themes: uniqueCompletionValues(resources.categories.themes),
	};
}

function uniqueCompletionValues(items: ResourceItem[]): string[] {
	return Array.from(
		new Set(items.flatMap((item) => ("path" in item ? [item.name, item.source, item.path] : [item.name, item.source]))),
	);
}

async function handleAddCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		ctx.ui.notify("Usage: /resource add <package-source> [project|user]", "info");
		return;
	}

	const source = parts[0]!;
	const scopeArg = parts[1];
	const scope = scopeArg === "user" ? "user" : "project";
	const settingsPath = await addPackageToSettings(ctx.cwd, source, scope);
	await refreshCompletionCache(ctx.cwd);
	ctx.ui.notify(`Added package to ${settingsPath}. Run /reload to apply.`, "info");
}

async function handleMutateCommand(
	action: "remove" | "enable" | "disable",
	args: string,
	ctx: ExtensionCommandContext,
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
		ctx.ui.notify(`No resource matched: ${query}`, "warning");
		return;
	}
	if (matches.length > 1) {
		const list = matches.slice(0, 5).map((item) => `${item.category}: ${item.name}`).join(", ");
		ctx.ui.notify(`Multiple resources matched: ${list}`, "warning");
		return;
	}

	const item = matches[0]!;
	if (action === "remove") {
		if (item.category === "themes" && !("path" in item)) {
			ctx.ui.notify(`Built-in theme ${item.name} cannot be removed`, "warning");
			return;
		}
		const settingsPath = await removeResourceFromSettings(ctx.cwd, item);
		await refreshCompletionCache(ctx.cwd);
		ctx.ui.notify(`${item.name} removed from ${settingsPath}. Run /reload to apply.`, "info");
		return;
	}

	if (item.category === "themes") {
		if (action === "disable") {
			ctx.ui.notify("Themes cannot be disabled. Select another theme instead.", "warning");
			return;
		}
		const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope);
		ctx.ui.setTheme(item.name);
		await refreshCompletionCache(ctx.cwd);
		ctx.ui.notify(`Applied theme ${item.name} via ${settingsPath}`, "info");
		return;
	}

	item.enabled = action === "enable";
	const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
	await refreshCompletionCache(ctx.cwd);
	ctx.ui.notify(`${item.name}: ${action}d in ${settingsPath}. Run /reload to apply.`, "info");
}

function findResources(
	resources: { categories: Record<ResourceCategory, ResourceItem[]> },
	query: string,
	category?: ResourceCategory,
): ResourceItem[] {
	const normalized = query.toLowerCase();
	const all = category ? resources.categories[category] : Object.values(resources.categories).flat();
	return all.filter((item) => {
		const candidates = [item.id, item.name, item.source, item.description];
		if ("path" in item) candidates.push(item.path);
		return candidates.some((value) => value.toLowerCase() === normalized || value.toLowerCase().includes(normalized));
	});
}

function isCategoryAlias(value: string): boolean {
	return value in CATEGORY_ALIAS_MAP;
}

function normalizeCategoryAlias(value: string): ResourceCategory {
	return CATEGORY_ALIAS_MAP[value] ?? "packages";
}

async function openBrowser(category: ResourceCategory, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const resources = await discoverResources(ctx.cwd);
	let hasPendingChanges = false;

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let updateSpinner: ReturnType<typeof setInterval> | undefined;
		let browser!: ResourceBrowser;
		const requestRender = () => tui.requestRender();
		const refreshBrowser = async () => {
			browser.setResources(await discoverResources(ctx.cwd));
			requestRender();
		};
		const stopUpdateSpinner = () => {
			if (updateSpinner) {
				clearInterval(updateSpinner);
				updateSpinner = undefined;
			}
			browser.stopActionLoading("update");
		};
		const setActionMessage = (action: "toggle" | "update" | "remove", type: "info" | "warning" | "error", text: string) => {
			browser.setActionMessage(action, type, text);
			requestRender();
		};
		const closeBrowser = async () => {
			stopUpdateSpinner();
			if (!hasPendingChanges) {
				done(undefined);
				return;
			}
			const reloadNow = await ctx.ui.confirm("Settings updated", "Resource settings changed. Reload now to apply changes?");
			done(undefined);
			if (reloadNow) {
				await ctx.reload();
			} else {
				ctx.ui.notify("Settings saved. Run /reload when ready.", "info");
			}
		};
		const startUpdateSpinner = (source: string) => {
			stopUpdateSpinner();
			browser.startActionLoading("update", `Updating ${source}`);
			requestRender();
			updateSpinner = setInterval(() => {
				browser.advanceLoadingFrame();
				requestRender();
			}, 100);
		};
		const updatePackage = async (item: ResourceItem) => {
			if (item.category !== "packages") {
				setActionMessage("update", "warning", "Update is only supported for packages");
				return;
			}
			if (!isRemotePackageSource(item.source)) {
				setActionMessage("update", "warning", "Local path packages cannot be updated");
				return;
			}
			const cliEntry = process.argv[1];
			if (!cliEntry) {
				setActionMessage("update", "error", "Could not determine pi CLI entrypoint");
				return;
			}
			startUpdateSpinner(item.source);
			try {
				const result = await pi.exec(process.execPath, [cliEntry, "update", item.source], { signal: ctx.signal });
				stopUpdateSpinner();
				const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
				if (result.code === 0) {
					hasPendingChanges = true;
					await refreshBrowser();
					setActionMessage("update", "info", output || `Updated ${item.source}`);
				} else {
					setActionMessage("update", "error", output || `Failed to update ${item.source}`);
				}
			} catch (error: unknown) {
				stopUpdateSpinner();
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("update", "error", `Failed: ${message}`);
			}
		};
		const toggleItem = async (item: ResourceItem) => {
			try {
				if (item.category === "themes") {
					const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope);
					ctx.ui.setTheme(item.name);
					await refreshBrowser();
					setActionMessage("toggle", "info", `Applied theme ${item.name} (${settingsPath})`);
					return;
				}
				const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage("toggle", "info", `${item.enabled ? "Enabled" : "Disabled"} (${settingsPath})`);
			} catch (error: unknown) {
				if (item.category !== "themes") {
					item.enabled = !item.enabled;
				}
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("toggle", "error", `Failed: ${message}`);
			}
		};
		const removeItem = async (item: ResourceItem) => {
			try {
				if (item.category === "themes" && !("path" in item)) {
					setActionMessage("remove", "warning", `Built-in theme ${item.name} cannot be removed`);
					return;
				}
				const settingsPath = await removeResourceFromSettings(ctx.cwd, item);
				hasPendingChanges = true;
				browser.removeItem(item);
				await refreshBrowser();
				ctx.ui.notify(`${item.name} removed from ${settingsPath}`, "info");
				requestRender();
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("remove", "error", `Failed: ${message}`);
			}
		};
		const addItem = async () => {
			try {
				const source = (await ctx.ui.input("Add package", "Enter a package source (npm:, git:, url, or local path)"))?.trim();
				if (!source) return;
				const scope = await ctx.ui.select("Add package", ["project", "user"]);
				if (!scope) return;
				const settingsPath = await addPackageToSettings(ctx.cwd, source, scope === "user" ? "user" : "project");
				hasPendingChanges = true;
				await refreshBrowser();
				ctx.ui.notify(`Added package to ${settingsPath}`, "info");
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to add package: ${message}`, "error");
			}
		};

		browser = new ResourceBrowser(theme, resources, category, {
			onClose: closeBrowser,
			onInspect: undefined,
			onToggle: (item) => void toggleItem(item),
			onUpdate: (item) => void updatePackage(item),
			onRemove: (item) => void removeItem(item),
			onAdd: () => void addItem(),
		});
		return {
			render: (width) => browser.render(width),
			invalidate: () => browser.invalidate(),
			handleInput: (data) => {
				browser.handleInput(data);
				requestRender();
			},
		};
	});
}
