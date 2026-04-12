import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ResourceBrowser } from "./browser.js";
import { discoverResources } from "./discovery.js";
import { canRemoveResourceIndividually, isPackageItem, isThemeItem, supportsPackageUpdate } from "./resource-capabilities.js";
import {
	getExposeErrorMessage,
	getExposeSuccessMessage,
	getRemoveBlockedMessage,
	getRemoveErrorMessage,
	getRemovedConventionFileMessage,
	getRemoveSuccessMessage,
	getToggleErrorMessage,
	getToggleSuccessMessage,
} from "./resource-messages.js";
import { readResourceCenterSettings, removeConventionResource, removeResourceFromSettings, saveResourceCenterSettings, setActiveTheme, setResourceExposed, toggleResourceInSettings } from "./settings.js";
import type { ResourceCategory, ResourceItem } from "./types.js";

export async function openResourceBrowser(category: ResourceCategory, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const resources = await discoverResources(ctx.cwd);
	const resourceCenterSettings = await readResourceCenterSettings();
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
			}
			ctx.ui.notify("Settings saved. Run /reload when you're ready.", "info");
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
			if (!isPackageItem(item)) {
				setActionMessage("update", "warning", "Only packages can be updated here");
				return;
			}
			if (!supportsPackageUpdate(item)) {
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
				if (isThemeItem(item)) {
					const settingsPath = await setActiveTheme(ctx.cwd, item.name, item.scope);
					ctx.ui.setTheme(item.name);
					await refreshBrowser();
					setActionMessage("toggle", "info", getToggleSuccessMessage(item, settingsPath));
					return;
				}
				const settingsPath = await toggleResourceInSettings(ctx.cwd, item);
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage("toggle", "info", getToggleSuccessMessage(item, settingsPath));
			} catch (error: unknown) {
				if (item.category !== "themes") item.enabled = !item.enabled;
				setActionMessage("toggle", "error", getToggleErrorMessage(item, error));
			}
		};
		const exposeItem = async (item: ResourceItem) => {
			try {
				const statePath = await setResourceExposed(ctx.cwd, item, Boolean(item.exposed));
				await refreshBrowser();
				setActionMessage("expose", "info", getExposeSuccessMessage(item, Boolean(item.exposed), statePath));
			} catch (error: unknown) {
				item.exposed = !item.exposed;
				setActionMessage("expose", "error", getExposeErrorMessage(item, Boolean(item.exposed), error));
			}
		};
		const removeItem = async (item: ResourceItem) => {
			try {
				if (!canRemoveResourceIndividually(item)) {
					setActionMessage("remove", "warning", getRemoveBlockedMessage(item) ?? "Remove is not allowed for this resource.");
					return;
				}
				if (item.source === "convention") {
					const filePath = await removeConventionResource(item);
					await refreshBrowser();
					setActionMessage("remove", "info", getRemovedConventionFileMessage(filePath));
					requestRender();
					return;
				}
				const settingsPath = await removeResourceFromSettings(ctx.cwd, item);
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage("remove", "info", getRemoveSuccessMessage(item, settingsPath));
				requestRender();
			} catch (error: unknown) {
				setActionMessage("remove", "error", getRemoveErrorMessage(item, error));
			}
		};

		browser = new ResourceBrowser(theme, resources, category, resourceCenterSettings, {
			onClose: closeBrowser,
			onInspect: undefined,
			onToggle: (item) => void toggleItem(item),
			onExpose: (item) => void exposeItem(item),
			onUpdate: (item) => void updatePackage(item),
			onRemove: (item) => void removeItem(item),
			onSettingsChange: (settings) => {
				void saveResourceCenterSettings(settings).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save resource center settings: ${message}`, "error");
				});
			},
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
