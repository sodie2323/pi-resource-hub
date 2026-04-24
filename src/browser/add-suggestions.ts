import { access, readdir } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { detectAddTargetSync } from "../resource/add-detect.js";

export type AddSuggestion = { value: string; label: string; description?: string };

const ADD_SOURCE_SUGGESTIONS = [
	{ value: "npm:", description: "Install a package from npm" },
	{ value: "git:", description: "Install a package from a git URL" },
	{ value: "https://", description: "Install a package from a remote HTTPS URL" },
	{ value: "http://", description: "Install a package from a remote HTTP URL" },
	{ value: "./", description: "Install a package from a local path relative to the current project" },
	{ value: "../", description: "Install a package from a sibling or parent directory" },
	{ value: "/", description: "Install a package from an absolute path" },
	{ value: "E:/", description: "Install a package from an absolute Windows path" },
	{ value: "C:/", description: "Install a package from an absolute Windows path" },
] as const;
const NOISY_DIRECTORY_NAMES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

export async function getAddSuggestions(input: string, cwd: string): Promise<AddSuggestion[]> {
	const value = input.trim();
	if (!value) return [];
	if (isLikelyLocalPathInput(value)) {
		const detected = detectAddTargetSync(value, cwd);
		if (detected.kind === "package" || detected.kind === "path") return [];
		const pathSuggestions = await getLocalAddPathSuggestions(value, cwd);
		if (pathSuggestions.length > 0) return pathSuggestions;
	}
	return ADD_SOURCE_SUGGESTIONS
		.filter((item) => item.value.toLowerCase().startsWith(value.toLowerCase()))
		.map((item) => ({ value: item.value, label: item.value, description: item.description }));
}

function isLikelyLocalPathInput(value: string): boolean {
	return value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

async function getLocalAddPathSuggestions(input: string, cwd: string): Promise<AddSuggestion[]> {
	const normalizedInput = input.replace(/\\/g, "/");
	const hasTrailingSlash = normalizedInput.endsWith("/");
	const baseInput = hasTrailingSlash ? normalizedInput.slice(0, -1) : normalizedInput;
	const searchDirInput = hasTrailingSlash ? normalizedInput : dirname(baseInput).replace(/\\/g, "/");
	const fragment = hasTrailingSlash ? "" : basename(baseInput);
	const resolvedSearchDir = resolveLocalAddCompletionDir(searchDirInput, cwd);
	if (!resolvedSearchDir) return [];
	try {
		const entries = await readdir(resolvedSearchDir, { withFileTypes: true });
		const candidates = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => name.toLowerCase().startsWith(fragment.toLowerCase()));
		const scored = await Promise.all(candidates.map(async (name) => ({ name, score: await scoreLocalPackageDirectory(resolvedSearchDir, name) })));
		return scored
			.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
			.map(({ name, score }) => ({
				value: joinCompletionPath(searchDirInput, name),
				label: `${name}/`,
				description: describeLocalPackageDirectory(name, score),
			}));
	} catch {
		return [];
	}
}

function resolveLocalAddCompletionDir(searchDirInput: string, cwd: string): string | undefined {
	if (!searchDirInput || searchDirInput === ".") return cwd;
	if (searchDirInput === "/") return sep;
	if (/^[A-Za-z]:\/$/.test(searchDirInput)) return searchDirInput;
	if (/^[A-Za-z]:\//.test(searchDirInput)) return resolve(searchDirInput);
	if (searchDirInput.startsWith("/")) return resolve(searchDirInput);
	return resolve(cwd, searchDirInput);
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

function joinCompletionPath(baseInput: string, name: string): string {
	const normalizedBase = baseInput.replace(/\\/g, "/");
	if (!normalizedBase || normalizedBase === ".") return `./${name}/`;
	if (normalizedBase === "/") return `/${name}/`;
	if (/^[A-Za-z]:\/$/.test(normalizedBase)) return `${normalizedBase}${name}/`;
	if (normalizedBase.endsWith("/")) return `${normalizedBase}${name}/`;
	return `${normalizedBase}/${name}/`;
}
