/**
 * 0.22 (roadmap #126): what the cloud sync covers. Pure: no `obsidian` import (tested in Node).
 *
 * Three scopes: the whole vault, only some folders, or include / exclude rules (glob patterns and file types). Some paths are
 * never synced whatever the scope: the configuration folder (`.obsidian`: per-device state, plugin data and workspace), every
 * hidden path (a segment starting with "."; `.trash` among them), temporary files (`*.tmp`) and the folder of the scheduled zip
 * backups (#127). A size limit is not a scope rule: it is the large-file rule of the engine (skip or ask), so a big file is
 * never mistaken for a deleted one.
 */

export const SCOPE_MODES = ["vault", "folders", "rules"] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];

export interface ScopeRules {
	mode: ScopeMode;
	/** Vault folders synced in "folders" mode. Empty: nothing is synced. */
	folders: readonly string[];
	/** "rules" mode: glob patterns a path must match (empty: every path). */
	include: readonly string[];
	/** "rules" mode: glob patterns that leave a path out (win over `include`). */
	exclude: readonly string[];
	/** "rules" mode: file extensions (lower case, no dot) synced; empty: every type. */
	types: readonly string[];
}

/** The paths that are never synced. */
export interface FixedExclusions {
	/** The vault's configuration folder (`app.vault.configDir`, usually ".obsidian"). */
	configDir: string;
	/** Folder of the scheduled zip backups (#127), or null. */
	backupFolder: string | null;
}

/** A comma- or newline-separated list as typed in the settings: trimmed, empty items dropped, duplicates removed. */
export function parseList(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split(/[,\n]/)) {
		const item = raw.trim();
		if (item && !out.includes(item)) out.push(item);
	}
	return out;
}

/** A folder as typed: forward slashes, no leading or trailing slash, no "." segments. Empty for the vault root. */
export function cleanFolder(folder: string): string {
	return folder.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".").join("/");
}

/** Extensions as typed ("pdf, .PNG, *.md"): lower case, without dot or star. */
export function parseTypes(text: string): string[] {
	return parseList(text).map((t) => t.replace(/^\*?\.?/, "").toLowerCase()).filter((t) => /^[a-z0-9_-]{1,16}$/.test(t));
}

const globCache = new Map<string, RegExp>();

/**
 * A glob pattern as a regular expression over vault paths ("/"-separated, no leading slash), case-insensitive:
 * `*` any characters except "/", `**` any characters, `?` one character except "/". A pattern without "/" matches the file or
 * folder name anywhere ("*.pdf", "drafts"); a pattern with "/" matches from the vault root ("School/**"). A pattern that names
 * a folder also covers everything inside it.
 */
export function globToRegExp(glob: string): RegExp {
	const cached = globCache.get(glob);
	if (cached) return cached;
	let g = glob.trim().replace(/\\/g, "/");
	const anchored = g.includes("/") && !g.startsWith("**/");
	g = g.replace(/^\/+/, "").replace(/\/+$/, "");
	let body = "";
	for (let i = 0; i < g.length; i++) {
		const c = g[i]!;
		if (c === "*") {
			if (g[i + 1] === "*") {
				// "**/" also matches no folder at all.
				if (g[i + 2] === "/") {
					body += "(?:.*/)?";
					i += 2;
				} else {
					body += ".*";
					i += 1;
				}
			} else body += "[^/]*";
		} else if (c === "?") body += "[^/]";
		else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	const re = new RegExp(`${anchored ? "^" : "(?:^|/)"}${body}(?:/.*)?$`, "i");
	if (globCache.size > 200) globCache.clear();
	globCache.set(glob, re);
	return re;
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
	return patterns.some((p) => p.trim() !== "" && globToRegExp(p).test(path));
}

function within(path: string, folder: string): boolean {
	const f = cleanFolder(folder).toLowerCase();
	if (!f) return true;
	const p = path.toLowerCase();
	return p === f || p.startsWith(f + "/");
}

/** Never synced, whatever the scope. */
export function alwaysExcluded(path: string, fixed: FixedExclusions): boolean {
	if (!path || path.startsWith("/") || path.split("/").some((s) => s === "" || s === "." || s === "..")) return true;
	if (path.split("/").some((s) => s.startsWith("."))) return true; // hidden: .obsidian, .trash, .git, .DS_Store...
	const config = cleanFolder(fixed.configDir);
	if (config && within(path, config)) return true;
	if (fixed.backupFolder && cleanFolder(fixed.backupFolder) && within(path, fixed.backupFolder)) return true;
	if (/\.tmp$/i.test(path)) return true;
	return false;
}

function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether the file at `path` (vault-relative, "/"-separated) is synced. Applied the same way to local and remote paths. */
export function inScope(path: string, rules: ScopeRules, fixed: FixedExclusions): boolean {
	if (alwaysExcluded(path, fixed)) return false;
	switch (rules.mode) {
		case "vault":
			return true;
		case "folders":
			return rules.folders.some((f) => cleanFolder(f) !== "" && within(path, f));
		case "rules": {
			if (rules.types.length > 0 && !rules.types.includes(extensionOf(path))) return false;
			if (rules.include.length > 0 && !matchesAny(path, rules.include)) return false;
			return !matchesAny(path, rules.exclude);
		}
	}
}
