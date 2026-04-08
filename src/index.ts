import { access, readdir } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ResourceBrowser } from "./browser.js";
import { discoverResources } from "./discovery.js";
import { addPackageToSettings, removeConventionResource, removeResourceFromSettings, setActiveTheme, setResourceExposed, toggleResourceInSettings } from "./settings.js";
import { isRemotePackageSource, type ResourceCategory, type ResourceItem } from "./types.js";

const CATEGORIES: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];
const ROOT_COMPLETIONS = [
	{ value: "add ", label: "add", description: "Add a package source to project or user settings" },
	{ value: "remove ", label: "remove", description: "Remove a resource or package from settings" },
	{ value: "enable ", label: "enable", description: "Enable a resource or package in settings" },
	{ value: "disable ", label: "disable", description: "Disable a resource or package in settings" },
	{ value: "expose ", label: "expose", description: "Show a package-contained resource in its top-level category" },
	{ value: "hide ", label: "hide", description: "Hide a package-contained resource from its top-level category" },
	{ value: "sync", description: "Rediscover resources and report the current count" },
	{ value: "packages", description: "Open the packages browser" },
	{ value: "skills", description: "Open the skills browser" },
	{ value: "extensions", description: "Open the extensions browser" },
	{ value: "prompts", description: "Open the prompts browser" },
	{ value: "themes", description: "Open the themes browser" },
] as const;
const ADD_SOURCE_COMPLETIONS = [
	{ value: "npm:", description: "Install a package from npm, for example npm:pi-resource-center" },
	{ value: "git:", description: "Install a package from a git URL, for example git:https://github.com/user/repo.git" },
	{ value: "https://", description: "Install a package from a remote HTTPS URL" },
	{ value: "http://", description: "Install a package from a remote HTTP URL" },
	{ value: "./", description: "Install a package from a local path relative to the current project" },
	{ value: "../", description: "Install a package from a sibling or parent directory" },
	{ value: "/", description: "Install a package from an absolute path" },
	{ value: "E:/", description: "Install a package from an absolute Windows path" },
	{ value: "C:/", description: "Install a package from an absolute Windows path" },
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

const EXPOSURE_CATEGORY_COMPLETIONS = [
	{ value: "skill", description: "Match a package-contained skill by name, source, or path" },
	{ value: "extension", description: "Match a package-contained extension by name, source, or path" },
	{ value: "prompt", description: "Match a package-contained prompt by name, source, or path" },
] as const;
const NOISY_DIRECTORY_NAMES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

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

let exposureCompletionCache: Record<Exclude<ResourceCategory, "packages" | "themes">, string[]> = {
	skills: [],
	extensions: [],
	prompts: [],
};

let completionCwd = process.cwd();

export default function resourceCenter(pi: ExtensionAPI) {
	pi.registerCommand("resource", {
		description: "Browse packages, skills, extensions, prompts, and themes",
		getArgumentCompletions: async (prefix) => getResourceArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			await handleResourceCommand(args, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		completionCwd = ctx.cwd;
		await refreshCompletionCache(ctx.cwd);
	});
}

async function handleResourceCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	completionCwd = ctx.cwd;
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
		await refreshCompletionCache(ctx.cwd);
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

	if (subcommand === "expose") {
		await handleExposureCommand("expose", sliceCommandArgs(args, subcommand), ctx);
		return;
	}

	if (subcommand === "hide") {
		await handleExposureCommand("hide", sliceCommandArgs(args, subcommand), ctx);
		return;
	}

	ctx.ui.notify(`Unknown /resource subcommand: ${subcommand}`, "warning");
}

function isCategory(value: string): value is ResourceCategory {
	return CATEGORIES.includes(value as ResourceCategory);
}

async function getResourceArgumentCompletions(prefix: string) {
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
	const commandPrefix = `${command} `;

	if (command === "add") {
		if (parts.length === 1) {
			return buildScopedCompletionItems(ADD_SOURCE_COMPLETIONS, "", commandPrefix);
		}
		if (parts.length === 2 && !endsWithSpace) {
			const current = parts[1] ?? "";
			const pathCompletions = isLikelyLocalPathInput(current) ? await getLocalPathCompletions(current) : null;
			const sourceCompletions = buildScopedCompletionItems(ADD_SOURCE_COMPLETIONS, current, commandPrefix);
			const matchingScopeCompletions = buildScopedCompletionItems(ADD_SCOPE_COMPLETIONS, current, commandPrefix);
			return prefixCompletionValues(pathCompletions, commandPrefix) ?? sourceCompletions ?? matchingScopeCompletions;
		}
		if (parts.length > 3 || (parts.length === 3 && endsWithSpace)) {
			return null;
		}
		const current = parts.length === 2 ? "" : (parts[parts.length - 1] ?? "");
		return buildScopedCompletionItems(ADD_SCOPE_COMPLETIONS, current, `add ${parts[1]!} `);
	}

	if (["remove", "enable", "disable"].includes(command)) {
		if (parts.length === 1) {
			return buildScopedCompletionItems(MUTATION_CATEGORY_COMPLETIONS, "", commandPrefix);
		}
		if (parts.length === 2 && !endsWithSpace) {
			const current = parts[1] ?? "";
			return buildScopedCompletionItems(prioritizeCategoryCompletions(MUTATION_CATEGORY_COMPLETIONS, allResourceCompletionValues()), current, commandPrefix);
		}
		if (!isCategoryAlias(parts[1]!)) {
			return null;
		}
		const category = normalizeCategoryAlias(parts[1]!);
		const current = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
		return buildScopedCompletionItems(resourceCompletionCache[category], current, `${command} ${parts[1]!} `);
	}

	if (["expose", "hide"].includes(command)) {
		if (parts.length === 1) {
			return buildScopedCompletionItems(EXPOSURE_CATEGORY_COMPLETIONS, "", commandPrefix);
		}
		if (parts.length === 2 && !endsWithSpace) {
			const current = parts[1] ?? "";
			return buildScopedCompletionItems(prioritizeCategoryCompletions(EXPOSURE_CATEGORY_COMPLETIONS, allExposureCompletionValues()), current, commandPrefix);
		}
		if (!isCategoryAlias(parts[1]!)) {
			return null;
		}
		const category = normalizeCategoryAlias(parts[1]!);
		if (category === "packages" || category === "themes") return null;
		const current = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
		return buildScopedCompletionItems(exposureCompletionCache[category], current, `${command} ${parts[1]!} `);
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

function buildScopedCompletionItems(
	values: ReadonlyArray<string | { value: string; description?: string; label?: string }>,
	prefix: string,
	replacementPrefix: string,
) {
	const items = buildCompletionItems(values, prefix);
	return prefixCompletionValues(items, replacementPrefix);
}

function prioritizeCategoryCompletions(
	categories: ReadonlyArray<{ value: string; description?: string; label?: string }>,
	values: ReadonlyArray<string>,
) {
	return [...categories, ...values];
}

function prefixCompletionValues<T extends { value: string; label?: string; description?: string }>(
	items: T[] | null,
	replacementPrefix: string,
) {
	if (!items) return null;
	return items.map((item) => ({ ...item, value: `${replacementPrefix}${item.value}` }));
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
	exposureCompletionCache = {
		skills: uniqueCompletionValues(resources.categories.skills.filter((item) => item.packageSource)),
		extensions: uniqueCompletionValues(resources.categories.extensions.filter((item) => item.packageSource)),
		prompts: uniqueCompletionValues(resources.categories.prompts.filter((item) => item.packageSource)),
	};
}

function uniqueCompletionValues(items: ResourceItem[]): string[] {
	return Array.from(
		new Set(
			items.flatMap((item) => {
				const values = [item.name, item.source];
				if (item.packageRelativePath) values.push(item.packageRelativePath);
				if ("path" in item && item.path) values.push(item.path);
				return values;
			}),
		),
	);
}

function allResourceCompletionValues(): string[] {
	return Array.from(new Set(Object.values(resourceCompletionCache).flat()));
}

function allExposureCompletionValues(): string[] {
	return Array.from(new Set(Object.values(exposureCompletionCache).flat()));
}

function isLikelyLocalPathInput(value: string): boolean {
	return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

async function getLocalPathCompletions(input: string) {
	const normalizedInput = input.replace(/\\/g, "/");
	const hasTrailingSlash = normalizedInput.endsWith("/");
	const baseInput = hasTrailingSlash ? normalizedInput.slice(0, -1) : normalizedInput;
	const searchDirInput = hasTrailingSlash ? normalizedInput : dirname(baseInput).replace(/\\/g, "/");
	const fragment = hasTrailingSlash ? "" : basename(baseInput);
	const resolvedSearchDir = resolveLocalCompletionDir(searchDirInput);
	if (!resolvedSearchDir) return null;

	try {
		const entries = await readdir(resolvedSearchDir, { withFileTypes: true });
		const candidates = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => name.toLowerCase().startsWith(fragment.toLowerCase()));
		const scored = await Promise.all(
			candidates.map(async (name) => ({
				name,
				score: await scoreLocalPackageDirectory(resolvedSearchDir, name),
			})),
		);
		const values = scored
			.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
			.map(({ name, score }) => ({
				value: joinCompletionPath(searchDirInput, name),
				description: describeLocalPackageDirectory(name, score),
				label: `${name}/`,
			}));
		return values.length > 0 ? values : null;
	} catch {
		return null;
	}
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

function resolveLocalCompletionDir(searchDirInput: string): string | undefined {
	if (!searchDirInput || searchDirInput === ".") return completionCwd;
	if (searchDirInput === "/") return sep;
	if (/^[A-Za-z]:\/$/.test(searchDirInput)) return searchDirInput;
	if (/^[A-Za-z]:\//.test(searchDirInput)) return resolve(searchDirInput);
	if (searchDirInput.startsWith("/")) return resolve(searchDirInput);
	return resolve(completionCwd, searchDirInput);
}

function joinCompletionPath(baseInput: string, name: string): string {
	const normalizedBase = baseInput.replace(/\\/g, "/");
	if (!normalizedBase || normalizedBase === ".") return `./${name}/`;
	if (normalizedBase === "/") return `/${name}/`;
	if (/^[A-Za-z]:\/$/.test(normalizedBase)) return `${normalizedBase}${name}/`;
	if (normalizedBase.endsWith("/")) return `${normalizedBase}${name}/`;
	return `${normalizedBase}/${name}/`;
}

async function handleAddCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parts = args.split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		ctx.ui.notify("Usage: /resource add <package-source> [project|user]", "info");
		return;
	}

	if (parts.length > 2) {
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
	await refreshCompletionCache(ctx.cwd);
	await reloadAfterSettingsChange(ctx, `Added package ${source} · ${settingsPath}`);
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
		if (item.packageSource) {
			ctx.ui.notify(`This resource comes from a package and can't be removed individually. Disable it instead.`, "warning");
			return;
		}
		if (item.category === "themes" && !("path" in item)) {
			ctx.ui.notify(`Built-in theme "${item.name}" can't be removed.`, "warning");
			return;
		}
		if (item.source === "convention") {
			const filePath = await removeConventionResource(item);
			await refreshCompletionCache(ctx.cwd);
			ctx.ui.notify(`Deleted file ${filePath}`, "info");
			return;
		}
		const settingsPath = await removeResourceFromSettings(ctx.cwd, item);
		await refreshCompletionCache(ctx.cwd);
		await reloadAfterSettingsChange(ctx, `Removed ${item.name} · ${settingsPath}`);
		return;
	}

	if (item.category === "themes") {
		if (item.packageSource && action === "disable") {
			item.enabled = false;
			const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
			await refreshCompletionCache(ctx.cwd);
			await reloadAfterSettingsChange(ctx, `Disabled ${item.name} · ${settingsPath}`);
			return;
		}
		if (action === "disable") {
			ctx.ui.notify("Themes aren't disabled directly. Apply another theme instead.", "warning");
			return;
		}
		const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope);
		ctx.ui.setTheme(item.name);
		await refreshCompletionCache(ctx.cwd);
		ctx.ui.notify(`Applied theme ${item.name} · ${settingsPath}`, "info");
		return;
	}

	item.enabled = action === "enable";
	const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
	await refreshCompletionCache(ctx.cwd);
	await reloadAfterSettingsChange(
		ctx,
		item.category === "packages"
			? `${action === "enable" ? "Enabled" : "Disabled"} all resources in package ${item.name} · ${settingsPath}`
			: `${action === "enable" ? "Enabled" : "Disabled"} ${item.name} · ${settingsPath}`,
	);
}

async function handleExposureCommand(
	action: "expose" | "hide",
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
		ctx.ui.notify(`No resource found for "${query}"`, "warning");
		return;
	}
	if (matches.length > 1) {
		const list = matches.slice(0, 5).map((item) => `${item.category}: ${item.name}`).join(", ");
		ctx.ui.notify(`More than one resource matched: ${list}`, "warning");
		return;
	}

	const item = matches[0]!;
	if (!item.packageSource || item.category === "packages" || item.category === "themes") {
		ctx.ui.notify("Only package-contained extensions, skills, and prompts can be shown or hidden in top-level categories.", "warning");
		return;
	}

	const exposed = action === "expose";
	const statePath = await setResourceExposed(ctx.cwd, item, exposed);
	await refreshCompletionCache(ctx.cwd);
	ctx.ui.notify(`${exposed ? "Shown" : "Hidden"} ${item.name} ${exposed ? "in" : "from"} ${item.category} · ${statePath}`, "info");
}

async function reloadAfterSettingsChange(ctx: ExtensionCommandContext, message: string): Promise<void> {
	try {
		await ctx.reload();
		return;
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`${message}. Settings were saved, but reload failed: ${detail}`, "warning");
	}
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
		if (item.packageRelativePath) candidates.push(item.packageRelativePath);
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
		const setActionMessage = (action: "toggle" | "expose" | "update" | "remove", type: "info" | "warning" | "error", text: string) => {
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
				return;
			} else {
				ctx.ui.notify("Settings saved. Run /reload when you're ready.", "info");
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
				setActionMessage("update", "warning", "Only packages can be updated here");
				return;
			}
			if (!isRemotePackageSource(item.source)) {
				setActionMessage("update", "warning", "Only remote packages can be updated");
				return;
			}
			const cliEntry = process.argv[1];
			if (!cliEntry) {
				setActionMessage("update", "error", "Couldn't determine the pi CLI entrypoint");
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
					setActionMessage("update", "info", output || `Updated package ${item.source}`);
				} else {
					setActionMessage("update", "error", output || `Failed to update package ${item.source}`);
				}
			} catch (error: unknown) {
				stopUpdateSpinner();
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("update", "error", `Failed to update package: ${message}`);
			}
		};
		const toggleItem = async (item: ResourceItem) => {
			try {
				if (item.category === "themes") {
					const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope);
					ctx.ui.setTheme(item.name);
					await refreshBrowser();
					setActionMessage("toggle", "info", `Applied theme ${item.name} · ${settingsPath}`);
					return;
				}
				const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage(
					"toggle",
					"info",
					item.category === "packages"
						? `${item.enabled ? "Enabled" : "Disabled"} all resources in package ${item.name} · ${settingsPath}`
						: `${item.enabled ? "Enabled" : "Disabled"} ${item.name} · ${settingsPath}`,
				);
			} catch (error: unknown) {
				if (item.category !== "themes") {
					item.enabled = !item.enabled;
				}
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("toggle", "error", `Failed to toggle ${item.category} ${item.name} in ${item.scope} scope: ${message}`);
			}
		};
		const exposeItem = async (item: ResourceItem) => {
			try {
				const statePath = await setResourceExposed(ctx.cwd, item, Boolean(item.exposed));
				await refreshBrowser();
				setActionMessage("expose", "info", `${item.exposed ? "Shown" : "Hidden"} ${item.name} ${item.exposed ? "in" : "from"} ${item.category} · ${statePath}`);
			} catch (error: unknown) {
				item.exposed = !item.exposed;
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("expose", "error", `Failed to ${item.exposed ? "show" : "hide"} ${item.category} ${item.name} in ${item.scope} scope: ${message}`);
			}
		};
		const removeItem = async (item: ResourceItem) => {
			try {
				if (item.packageSource) {
					setActionMessage("remove", "warning", "This resource comes from a package and can't be removed individually. Disable it instead.");
					return;
				}
				if (item.category === "themes" && !("path" in item)) {
					setActionMessage("remove", "warning", `Built-in theme "${item.name}" can't be removed.`);
					return;
				}
				if (item.source === "convention") {
					const filePath = await removeConventionResource(item);
					await refreshBrowser();
					setActionMessage("remove", "info", `Deleted file ${filePath}`);
					requestRender();
					return;
				}
				const settingsPath = await removeResourceFromSettings(ctx.cwd, item);
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage("remove", "info", `Removed ${item.name} · ${settingsPath}`);
				requestRender();
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("remove", "error", `Failed to remove ${item.category} ${item.name} from ${item.scope} scope: ${message}`);
			}
		};
		browser = new ResourceBrowser(theme, resources, category, {
			onClose: closeBrowser,
			onInspect: undefined,
			onToggle: (item) => void toggleItem(item),
			onExpose: (item) => void exposeItem(item),
			onUpdate: (item) => void updatePackage(item),
			onRemove: (item) => void removeItem(item),
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
