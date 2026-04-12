import { canRemoveResourceIndividually, isContainedResource, isPackageItem, isThemeItem } from "./resource-capabilities.js";
import type { ResourceItem } from "./types.js";

export function getRemoveBlockedMessage(item: ResourceItem): string | undefined {
	if (canRemoveResourceIndividually(item)) return undefined;
	return isContainedResource(item)
		? "This resource comes from a package and can't be removed individually. Disable it instead."
		: `Built-in theme "${item.name}" can't be removed.`;
}

export function getToggleSuccessMessage(item: ResourceItem, settingsPath: string): string {
	if (isThemeItem(item)) return `Applied theme ${item.name} · ${settingsPath}`;
	if (isPackageItem(item)) {
		return `${item.enabled ? "Enabled" : "Disabled"} all resources in package ${item.name} · ${settingsPath}`;
	}
	return `${item.enabled ? "Enabled" : "Disabled"} ${item.name} · ${settingsPath}`;
}

export function getToggleErrorMessage(item: ResourceItem, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `Failed to toggle ${item.category} ${item.name} in ${item.scope} scope: ${message}`;
}

export function getExposeSuccessMessage(item: ResourceItem, exposed: boolean, statePath: string): string {
	return `${exposed ? "Shown" : "Hidden"} ${item.name} ${exposed ? "in" : "from"} ${item.category} · ${statePath}`;
}

export function getExposeErrorMessage(item: ResourceItem, attemptedExpose: boolean, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `Failed to ${attemptedExpose ? "show" : "hide"} ${item.category} ${item.name} in ${item.scope} scope: ${message}`;
}

export function getRemoveSuccessMessage(item: ResourceItem, settingsPath: string): string {
	return `Removed ${item.name} · ${settingsPath}`;
}

export function getRemoveErrorMessage(item: ResourceItem, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `Failed to remove ${item.category} ${item.name} from ${item.scope} scope: ${message}`;
}

export function getRemovedConventionFileMessage(filePath: string): string {
	return `Deleted file ${filePath}`;
}
