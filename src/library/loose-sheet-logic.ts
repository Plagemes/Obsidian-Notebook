/** Pure logic of the loose sheet (no DOM, no 'obsidian'): where the quick-notes notebook lives. */
import { FILE_EXTENSION } from "../model/types";
import { isReservedPath } from "./folders";

export const LOOSE_SHEET_NAME = "Quick notes";

const FORBIDDEN = /[\\:*?"<>|#^[\]]/g;

function trimSlashes(path: string): string {
	return path.replace(/[\\]/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Default location: `<notebooks folder>/Quick notes.notebook`. */
export function defaultLooseSheetPath(folder: string): string {
	const dir = trimSlashes(folder);
	return `${dir ? `${dir}/` : ""}${LOOSE_SHEET_NAME}.${FILE_EXTENSION}`;
}

/**
 * Vault path of the loose sheet: the one set in the settings (made safe: no `..`, forbidden characters replaced,
 * `.notebook` added when missing) or the default one. A path inside the library's `_assets` or `_backup` folders
 * is not accepted, because the library does not list them.
 */
export function looseSheetPath(folder: string, custom: string): string {
	const fallback = defaultLooseSheetPath(folder);
	const parts = trimSlashes(custom.trim())
		.split("/")
		.map((p) => p.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim())
		.filter((p) => p !== "" && p !== "." && p !== "..");
	if (parts.length === 0) return fallback;
	const last = parts[parts.length - 1]!;
	const suffix = `.${FILE_EXTENSION}`;
	const stem = last.toLowerCase().endsWith(suffix) ? last.slice(0, -suffix.length).trim() : last;
	if (stem === "" || stem.startsWith(".")) return fallback;
	parts[parts.length - 1] = `${stem}${suffix}`;
	const path = parts.join("/");
	return isReservedPath(path, trimSlashes(folder)) ? fallback : path;
}

/** Folder part of a vault path ("" for the vault root). */
export function parentFolder(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/** File name without folder and extension. */
export function notebookBaseName(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}
