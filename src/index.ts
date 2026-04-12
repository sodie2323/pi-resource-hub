/**
 * 插件主入口：注册 /resource 命令并分发子命令。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { discoverResources } from "./resource/discovery.js";
import { openResourceBrowser } from "./resource/browser-open.js";
import { ResourceCompletionProvider } from "./resource/completions.js";
import { handleAddCommand, handleExposureCommand, handleMutateCommand } from "./resource/commands.js";
import type { ResourceCategory } from "./types.js";

const CATEGORIES: ResourceCategory[] = ["packages", "skills", "extensions", "prompts", "themes"];
const completions = new ResourceCompletionProvider();

export default function resourceCenter(pi: ExtensionAPI) {
	pi.registerCommand("resource", {
		description: "Browse packages, skills, extensions, prompts, and themes",
		getArgumentCompletions: async (prefix) => completions.getArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			await handleResourceCommand(args, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		completions.setCwd(ctx.cwd);
		await completions.refresh(ctx.cwd);
	});
}

async function handleResourceCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	completions.setCwd(ctx.cwd);
	const [subcommand] = args.trim().split(/\s+/, 1);
	if (!subcommand) {
		await openResourceBrowser("packages", ctx, pi);
		return;
	}

	if (isCategory(subcommand)) {
		await openResourceBrowser(subcommand, ctx, pi);
		return;
	}

	if (subcommand === "sync") {
		const resources = await discoverResources(ctx.cwd);
		await completions.refresh(ctx.cwd);
		const count = Object.values(resources.categories).reduce((sum, items) => sum + items.length, 0);
		ctx.ui.notify(`Discovered ${count} resources`, "info");
		return;
	}

	const refresh = () => completions.refresh(ctx.cwd);
	if (subcommand === "add") {
		await handleAddCommand(sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "remove") {
		await handleMutateCommand("remove", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "enable") {
		await handleMutateCommand("enable", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "disable") {
		await handleMutateCommand("disable", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "expose") {
		await handleExposureCommand("expose", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}
	if (subcommand === "hide") {
		await handleExposureCommand("hide", sliceCommandArgs(args, subcommand), ctx, refresh);
		return;
	}

	ctx.ui.notify(`Unknown /resource subcommand: ${subcommand}`, "warning");
}

function isCategory(value: string): value is ResourceCategory {
	return CATEGORIES.includes(value as ResourceCategory);
}

function sliceCommandArgs(args: string, subcommand: string): string {
	return args.trim().slice(subcommand.length).trim();
}
