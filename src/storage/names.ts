/**
 * File and folder names of new notebooks and folders, kept pure (no 'obsidian') so the creation dialog's check and the
 * code that creates the file agree, and both are tested in Node.
 */

/** Characters Obsidian does not allow in file names, plus those that break links. */
const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

/** The name a notebook file gets: forbidden characters become spaces, runs of spaces one, no leading dots. */
export function sanitizeName(name: string): string {
	return name.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
}

/** Windows device names (with or without an extension): such a file cannot be created or synced to Windows. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isDeviceName(name: string): boolean {
	return DEVICE_NAME.test(name.trim());
}

/** A trailing dot or space is dropped by Windows (and some sync tools), so the name would not survive. */
export function hasTrailingDotOrSpace(name: string): boolean {
	return /[. ]$/.test(name);
}

/** The part of the vault a case-insensitive lookup needs (Obsidian's `Vault` fits; so does the tests' fake vault). */
export interface NameLookup {
	getAbstractFileByPath(path: string): unknown;
	/** Not in Obsidian's public typings; used when the running version has it. */
	getAbstractFileByPathInsensitive?: (path: string) => unknown;
	getRoot?(): unknown;
	getFolderByPath?(path: string): unknown;
}

function childrenOf(node: unknown): unknown[] | null {
	if (typeof node !== "object" || node === null) return null;
	const kids = (node as { children?: unknown }).children;
	return Array.isArray(kids) ? (kids as unknown[]) : null;
}

function nameOf(node: unknown): string | null {
	if (typeof node !== "object" || node === null) return null;
	const name = (node as { name?: unknown }).name;
	return typeof name === "string" ? name : null;
}

/**
 * Whether something exists at `path` when case is ignored, as on Windows, macOS and Android storage: there, creating
 * `Anatomy.notebook` next to `anatomy.notebook` would write over it. Uses Obsidian's own insensitive lookup when it is
 * there, and in any case walks the folders from the vault root comparing lower-cased names.
 */
export function existsInsensitive(vault: NameLookup, path: string): boolean {
	const p = path.replace(/^\/+|\/+$/g, "");
	if (p === "") return true;
	if (vault.getAbstractFileByPath(p) !== null) return true;
	const hit = vault.getAbstractFileByPathInsensitive?.(p);
	if (hit !== undefined && hit !== null) return true;
	let node: unknown = vault.getRoot?.() ?? vault.getFolderByPath?.("/") ?? vault.getAbstractFileByPath("/");
	for (const seg of p.split("/")) {
		const kids = childrenOf(node);
		if (!kids) return false;
		const want = seg.toLowerCase();
		node = kids.find((k) => nameOf(k)?.toLowerCase() === want);
		if (node === undefined) return false;
	}
	return true;
}
