import { addRename, normaliseRenames, type RenameRow } from "../model/rename-map";

/**
 * The record of renamed notes on this device (0.19, #103; model/rename-map.ts): Obsidian's per-device local storage, bounded, a
 * convenience only (corrupt or missing data reads as empty, a failed write is ignored). Never in the vault, never synced.
 */

/** Local storage key of the record. */
export const RENAMED_NOTES_KEY = "notebook-renamed-notes";

/** The part of Obsidian's App that holds per-device values. */
interface LocalStore {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

/** The renames on this device (empty when missing or unreadable). */
export function loadRenames(app: LocalStore, now = Date.now()): RenameRow[] {
	try {
		return normaliseRenames(app.loadLocalStorage(RENAMED_NOTES_KEY), now);
	} catch {
		return [];
	}
}

/** Remembers that `from` became `to`. Never throws. */
export function recordRename(app: LocalStore, from: string, to: string, now = Date.now()): void {
	try {
		const list = loadRenames(app, now);
		const next = addRename(list, from, to, now);
		if (next === list) return;
		app.saveLocalStorage(RENAMED_NOTES_KEY, next);
	} catch (e) {
		console.error("[notebook] could not store the renamed notes record", e);
	}
}
