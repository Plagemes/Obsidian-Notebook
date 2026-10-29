import { normalizePath, TFile, type App } from "obsidian";
import type { ClipContent } from "../ink/clipboard";
import { cleanStampName, readStamp, serializeStamp, STAMP_EXTENSION, stampsFolder, uniqueStampName } from "../ink/stamps";
import { ensureFolder } from "./vault-io";

/**
 * Personal stamps in the vault (roadmap 142): one `<notebooks folder>/_stamps/<name>.stamp` file each, so they sync
 * with the vault and not with the plugin settings. Only the Vault API is used. Saving always creates a new file
 * (nothing is overwritten), after the text has been serialized, validated and written, and read back.
 */

/** The stamp files, by name. */
export function listStampFiles(app: App, notebooksFolder: string): TFile[] {
	const folder = app.vault.getFolderByPath(normalizePath(stampsFolder(notebooksFolder)));
	if (!folder) return [];
	return folder.children
		.filter((f): f is TFile => f instanceof TFile && f.extension === STAMP_EXTENSION)
		.sort((a, b) => a.basename.localeCompare(b.basename, undefined, { sensitivity: "base" }));
}

export type StampLoad = { ok: true; clip: ClipContent } | { ok: false; message: string };

export async function loadStamp(app: App, file: TFile): Promise<StampLoad> {
	try {
		return readStamp(await app.vault.read(file));
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
}

/** Saves `clip` as a new stamp called `name` (made unique); throws a readable error when it cannot. */
export async function saveStamp(app: App, notebooksFolder: string, name: string, clip: ClipContent): Promise<TFile> {
	const saved = serializeStamp(clip);
	if (!saved.ok) throw new Error(saved.message);
	const folder = normalizePath(stampsFolder(notebooksFolder));
	await ensureFolder(app, folder);
	const taken = listStampFiles(app, notebooksFolder).map((f) => f.basename);
	const base = uniqueStampName(name, taken);
	let path = normalizePath(`${folder}/${base}.${STAMP_EXTENSION}`);
	// Names are compared case-insensitively above; a stray file of another kind could still be in the way.
	for (let i = 2; app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${base} ${i}.${STAMP_EXTENSION}`);
	const file = await app.vault.create(path, saved.text);
	const back = readStamp(await app.vault.read(file));
	if (!back.ok) throw new Error(back.message);
	return file;
}

/** Renames a stamp (its file); returns the new name. A taken name gets a number. */
export async function renameStamp(app: App, notebooksFolder: string, file: TFile, name: string): Promise<string | null> {
	const clean = cleanStampName(name);
	if (clean === "" || clean === file.basename) return null;
	const taken = listStampFiles(app, notebooksFolder).filter((f) => f.path !== file.path).map((f) => f.basename);
	const base = uniqueStampName(clean, taken);
	const folder = file.parent?.path ?? normalizePath(stampsFolder(notebooksFolder));
	await app.fileManager.renameFile(file, normalizePath(`${folder}/${base}.${STAMP_EXTENSION}`));
	return base;
}

/** Moves a stamp to the trash chosen in Obsidian's settings (not a permanent delete). */
export async function deleteStamp(app: App, file: TFile): Promise<void> {
	await app.fileManager.trashFile(file);
}
