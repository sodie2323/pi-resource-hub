/**
 * /resource 命令参数补全逻辑。
 */
import { access, readdir } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { discoverResources } from "./discovery.js";
import type { ResourceCategory, ResourceItem } from "../types.js";

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

export const CATEGORY_ALIAS_MAP: Record<string, ResourceCategory> = {
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

export class ResourceCompletionProvider {
	private resourceCompletionCache: Record<ResourceCategory, string[]> = {
		packages: [],
		skills: [],
		extensions: [],
		prompts: [],
		themes: [],
	};
	private exposureCompletionCache: Record<Exclude<ResourceCategory, "packages" | "themes">, string[]> = {
		skills: [],
		extensions: [],
		prompts: [],
	};
	private completionCwd = process.cwd();

	setCwd(cwd: string): void {
		this.completionCwd = cwd;
	}

	async refresh(cwd: string): Promise<void> {
		this.completionCwd = cwd;
		const resources = await discoverResources(cwd);
		this.resourceCompletionCache = {
			packages: uniqueCompletionValues(resources.categories.packages),
			skills: uniqueCompletionValues(resources.categories.skills),
			extensions: uniqueCompletionValues(resources.categories.extensions),
			prompts: uniqueCompletionValues(resources.categories.prompts),
			themes: uniqueCompletionValues(resources.categories.themes),
		};
		this.exposureCompletionCache = {
			skills: uniqueCompletionValues(resources.categories.skills.filter((item) => item.packageSource)),
			extensions: uniqueCompletionValues(resources.categories.extensions.filter((item) => item.packageSource)),
			prompts: uniqueCompletionValues(resources.categories.prompts.filter((item) => item.packageSource)),
		};
	}

	async getArgumentCompletions(prefix: string) {
		const trimmed = prefix.trimStart();
		const parts = trimmed.split(/\s+/).filter(Boolean);
		const endsWithSpace = /\s$/.test(prefix);

		if (parts.length === 0) return buildCompletionItems(ROOT_COMPLETIONS, "");
		if (parts.length === 1 && !endsWithSpace) return buildCompletionItems(ROOT_COMPLETIONS, parts[0]!);

		const command = parts[0]!;
		const commandPrefix = `${command} `;

		if (command === "add") {
			if (parts.length === 1) return buildScopedCompletionItems(ADD_SOURCE_COMPLETIONS, "", commandPrefix);
			if (parts.length === 2 && !endsWithSpace) {
				const current = parts[1] ?? "";
				const pathCompletions = isLikelyLocalPathInput(current) ? await this.getLocalPathCompletions(current) : null;
				const sourceCompletions = buildScopedCompletionItems(ADD_SOURCE_COMPLETIONS, current, commandPrefix);
				const matchingScopeCompletions = buildScopedCompletionItems(ADD_SCOPE_COMPLETIONS, current, commandPrefix);
				return prefixCompletionValues(pathCompletions, commandPrefix) ?? sourceCompletions ?? matchingScopeCompletions;
			}
			if (parts.length > 3 || (parts.length === 3 && endsWithSpace)) return null;
			const current = parts.length === 2 ? "" : (parts[parts.length - 1] ?? "");
			return buildScopedCompletionItems(ADD_SCOPE_COMPLETIONS, current, `add ${parts[1]!} `);
		}

		if (["remove", "enable", "disable"].includes(command)) {
			if (parts.length === 1) return buildScopedCompletionItems(MUTATION_CATEGORY_COMPLETIONS, "", commandPrefix);
			if (parts.length === 2 && !endsWithSpace) {
				const current = parts[1] ?? "";
				return buildScopedCompletionItems(prioritizeCategoryCompletions(MUTATION_CATEGORY_COMPLETIONS, this.allResourceCompletionValues()), current, commandPrefix);
			}
			if (!isCategoryAlias(parts[1]!)) return null;
			const category = normalizeCategoryAlias(parts[1]!);
			const current = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
			return buildScopedCompletionItems(this.resourceCompletionCache[category], current, `${command} ${parts[1]!} `);
		}

		if (["expose", "hide"].includes(command)) {
			if (parts.length === 1) return buildScopedCompletionItems(EXPOSURE_CATEGORY_COMPLETIONS, "", commandPrefix);
			if (parts.length === 2 && !endsWithSpace) {
				const current = parts[1] ?? "";
				return buildScopedCompletionItems(prioritizeCategoryCompletions(EXPOSURE_CATEGORY_COMPLETIONS, this.allExposureCompletionValues()), current, commandPrefix);
			}
			if (!isCategoryAlias(parts[1]!)) return null;
			const category = normalizeCategoryAlias(parts[1]!);
			if (category === "packages" || category === "themes") return null;
			const current = endsWithSpace ? "" : (parts[parts.length - 1] ?? "");
			return buildScopedCompletionItems(this.exposureCompletionCache[category], current, `${command} ${parts[1]!} `);
		}

		return null;
	}

	private allResourceCompletionValues(): string[] {
		return Array.from(new Set(Object.values(this.resourceCompletionCache).flat()));
	}

	private allExposureCompletionValues(): string[] {
		return Array.from(new Set(Object.values(this.exposureCompletionCache).flat()));
	}

	private async getLocalPathCompletions(input: string) {
		const normalizedInput = input.replace(/\\/g, "/");
		const hasTrailingSlash = normalizedInput.endsWith("/");
		const baseInput = hasTrailingSlash ? normalizedInput.slice(0, -1) : normalizedInput;
		const searchDirInput = hasTrailingSlash ? normalizedInput : dirname(baseInput).replace(/\\/g, "/");
		const fragment = hasTrailingSlash ? "" : basename(baseInput);
		const resolvedSearchDir = this.resolveLocalCompletionDir(searchDirInput);
		if (!resolvedSearchDir) return null;

		try {
			const entries = await readdir(resolvedSearchDir, { withFileTypes: true });
			const candidates = entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.filter((name) => name.toLowerCase().startsWith(fragment.toLowerCase()));
			const scored = await Promise.all(candidates.map(async (name) => ({ name, score: await scoreLocalPackageDirectory(resolvedSearchDir, name) })));
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

	private resolveLocalCompletionDir(searchDirInput: string): string | undefined {
		if (!searchDirInput || searchDirInput === ".") return this.completionCwd;
		if (searchDirInput === "/") return sep;
		if (/^[A-Za-z]:\/$/.test(searchDirInput)) return searchDirInput;
		if (/^[A-Za-z]:\//.test(searchDirInput)) return resolve(searchDirInput);
		if (searchDirInput.startsWith("/")) return resolve(searchDirInput);
		return resolve(this.completionCwd, searchDirInput);
	}
}

function buildCompletionItems(values: ReadonlyArray<string | { value: string; description?: string; label?: string }>, prefix: string) {
	const normalizedPrefix = prefix.toLowerCase();
	const seen = new Set<string>();
	const items = values
		.map((value) => typeof value === "string" ? { value, label: value } : { value: value.value, label: value.label ?? value.value, description: value.description })
		.filter((value) => {
			if (seen.has(value.value)) return false;
			seen.add(value.value);
			return value.value.toLowerCase().startsWith(normalizedPrefix);
		});
	return items.length > 0 ? items : null;
}

function buildScopedCompletionItems(values: ReadonlyArray<string | { value: string; description?: string; label?: string }>, prefix: string, replacementPrefix: string) {
	const items = buildCompletionItems(values, prefix);
	return prefixCompletionValues(items, replacementPrefix);
}

function prioritizeCategoryCompletions(categories: ReadonlyArray<{ value: string; description?: string; label?: string }>, values: ReadonlyArray<string>) {
	return [...categories, ...values];
}

function prefixCompletionValues<T extends { value: string; label?: string; description?: string }>(items: T[] | null, replacementPrefix: string) {
	if (!items) return null;
	return items.map((item) => ({ ...item, value: `${replacementPrefix}${item.value}` }));
}

function uniqueCompletionValues(items: ResourceItem[]): string[] {
	return Array.from(new Set(items.flatMap((item) => {
		const values = [item.name, item.source];
		if (item.packageRelativePath) values.push(item.packageRelativePath);
		if ("path" in item && item.path) values.push(item.path);
		return values;
	})));
}

function isLikelyLocalPathInput(value: string): boolean {
	return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
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

function isCategoryAlias(value: string): boolean {
	return value in CATEGORY_ALIAS_MAP;
}

export function normalizeCategoryAlias(value: string): ResourceCategory {
	return CATEGORY_ALIAS_MAP[value] ?? "packages";
}

function joinCompletionPath(baseInput: string, name: string): string {
	const normalizedBase = baseInput.replace(/\\/g, "/");
	if (!normalizedBase || normalizedBase === ".") return `./${name}/`;
	if (normalizedBase === "/") return `/${name}/`;
	if (/^[A-Za-z]:\/$/.test(normalizedBase)) return `${normalizedBase}${name}/`;
	if (normalizedBase.endsWith("/")) return `${normalizedBase}${name}/`;
	return `${normalizedBase}/${name}/`;
}
