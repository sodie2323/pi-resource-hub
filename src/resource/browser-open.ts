/**
 * 负责打开资源浏览器，并把浏览器动作连接到实际资源变更逻辑。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ResourceBrowser } from "../browser/browser.js";
import { discoverResources } from "./discovery.js";
import { canRemoveResourceIndividually, isPackageItem, isThemeItem, supportsPackageUpdate } from "./capabilities.js";
import { buildSuccessOperationMessage, ResourceOperationStatusController } from "./operation-status.js";
import {
	getExposeErrorMessage,
	getExposeSuccessMessage,
	getRemoveBlockedMessage,
	getRemoveErrorMessage,
	getRemovedConventionFileMessage,
	getRemoveSuccessMessage,
	getToggleErrorMessage,
	getToggleSuccessMessage,
} from "./messages.js";
import { addResourceFromInput, reloadAfterSettingsChange } from "./commands.js";
import { detectAddTarget } from "./add-detect.js";
import { readResourceCenterSettings, removeConventionResource, removeResourceFromSettings, saveResourceCenterSettings, setActiveTheme, setResourceExposed, syncExternalSkillSourcesToPiSettings, toggleResourceInSettings } from "../settings.js";
import type { ResourceCategory, ResourceItem } from "../types.js";

export async function openResourceBrowser(category: ResourceCategory, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const resourceCenterSettings = await readResourceCenterSettings();
	await syncExternalSkillSourcesToPiSettings(resourceCenterSettings.externalSkillSources, resourceCenterSettings.externalSkillSources);
	const resources = await discoverResources(ctx.cwd);
	let currentResourceCenterSettings = resourceCenterSettings;
	let hasPendingChanges = false;

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let browserOpen = true;
		let browser!: ResourceBrowser;
		const requestRender = () => {
			if (browserOpen) tui.requestRender();
		};
		const refreshBrowser = async () => {
			browser.setResources(await discoverResources(ctx.cwd));
			requestRender();
		};
		const operationStatus = new ResourceOperationStatusController(ctx.ui, theme, {
			hasLoadingState: () => browser.hasLoadingState(),
			onTick: () => browser.advanceLoadingFrame(),
			requestRender,
			stopBrowserLoadingState: () => browser.stopActionLoading("update"),
		});
		const setActionMessage = (action: "toggle" | "expose" | "update" | "remove", type: "info" | "warning" | "error", text: string) => {
			browser.setActionMessage(action, type, text);
			requestRender();
		};
		const closeBrowser = async () => {
			browserOpen = false;
			done(undefined);
			if (!hasPendingChanges) {
				return;
			}
			await reloadAfterSettingsChange(ctx, "Resource settings saved", currentResourceCenterSettings.reloadBehavior);
		};
		const startUpdateSpinner = (source: string) => {
			operationStatus.stop();
			browser.startActionLoading("update", `Updating ${source}`);
			requestRender();
			operationStatus.start(`Updating ${source}...`);
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
				operationStatus.stop();
				const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
				if (result.code === 0) {
					hasPendingChanges = true;
					if (browserOpen) await refreshBrowser();
					const message = buildSuccessOperationMessage("Updated package", item.source, output);
					setActionMessage("update", "info", message);
					ctx.ui.notify(message, "info");
					if (!browserOpen) await reloadAfterSettingsChange(ctx, "Resource settings saved", currentResourceCenterSettings.reloadBehavior);
				} else {
					const message = output || `Failed to update package ${item.source}`;
					setActionMessage("update", "error", message);
					ctx.ui.notify(message, "warning");
				}
			} catch (error: unknown) {
				operationStatus.stop();
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("update", "error", `Failed to update package: ${message}`);
				ctx.ui.notify(`Failed to update package: ${message}`, "warning");
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
		const toggleGroup = async (items: ResourceItem[], enabled: boolean, label: string) => {
			const previousStates = items.map((item) => ({ item, enabled: item.enabled }));
			try {
				let settingsPath: string | undefined;
				let changedCount = 0;
				for (const item of items) {
					if (item.enabled === enabled) continue;
					item.enabled = enabled;
					settingsPath = await toggleResourceInSettings(ctx.cwd, item);
					changedCount += 1;
				}
				hasPendingChanges = true;
				await refreshBrowser();
				setActionMessage("toggle", "info", `${enabled ? "Enabled" : "Disabled"} ${changedCount} skills in ${label}${settingsPath ? ` · ${settingsPath}` : ""}`);
			} catch (error: unknown) {
				for (const state of previousStates) state.item.enabled = state.enabled;
				await refreshBrowser();
				const message = error instanceof Error ? error.message : String(error);
				setActionMessage("toggle", "error", `Failed to update ${label}: ${message}`);
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
		const addResource = async (request: { input: string; scope: "project" | "user"; preferredCategory?: import("./add-detect.js").AddPathCategory }): Promise<void> => {
			operationStatus.start(`Adding ${request.input}...`);
			try {
				const target = await detectAddTarget(request.input, ctx.cwd, { preferredCategory: request.preferredCategory });
				if (target.kind === "invalid") throw new Error(target.reason);
				if (target.kind === "ambiguous") {
					throw new Error(`Couldn't infer resource type for ${target.path}. Choose one of: ${target.candidates.join(", ")}`);
				}
				let message: string;
				if (target.kind === "package") {
					const cliEntry = process.argv[1];
					if (!cliEntry) throw new Error("Couldn't determine the pi CLI entrypoint");
					const installArgs = [cliEntry, "install", target.source, ...(request.scope === "project" ? ["-l"] : [])];
					const result = await pi.exec(process.execPath, installArgs, { signal: ctx.signal });
					const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
					if (result.code !== 0) throw new Error(output || `Failed to install package ${target.source}`);
					message = buildSuccessOperationMessage("Added package", target.source, output);
				} else {
					message = await addResourceFromInput(ctx.cwd, request.input, request.scope, request.preferredCategory);
				}
				hasPendingChanges = true;
				if (browserOpen) await refreshBrowser();
				operationStatus.stop();
				ctx.ui.notify(message, "info");
				if (browserOpen === false) await reloadAfterSettingsChange(ctx, "Resource settings saved", currentResourceCenterSettings.reloadBehavior);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				operationStatus.stop();
				ctx.ui.notify(message, "warning");
				throw error;
			}
		};

		browser = new ResourceBrowser(theme, resources, category, resourceCenterSettings, {
			onClose: closeBrowser,
			onInspect: undefined,
			onToggle: (item) => void toggleItem(item),
			onToggleGroup: (items, enabled, label) => void toggleGroup(items, enabled, label),
			onExpose: (item) => void exposeItem(item),
			onUpdate: (item) => void updatePackage(item),
			onRemove: (item) => void removeItem(item),
			onAdd: (request) => addResource(request),
			onSettingsChange: (settings) => {
				const previousExternalSources = JSON.stringify(currentResourceCenterSettings.externalSkillSources);
				const nextExternalSources = JSON.stringify(settings.externalSkillSources);
				const externalSourcesChanged = previousExternalSources !== nextExternalSources;
				if (externalSourcesChanged) hasPendingChanges = true;
				currentResourceCenterSettings = settings;
				void saveResourceCenterSettings(settings)
					.then(async () => {
						if (externalSourcesChanged) await refreshBrowser();
						const resources = await discoverResources(ctx.cwd);
						await saveResourceCenterSettings(settings, resources);
					})
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to save resource center settings: ${message}`, "error");
					});
			},
			onRequestRender: requestRender,
		}, ctx.cwd);
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
