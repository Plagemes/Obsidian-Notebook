import { copyBookmarkInfoMap } from "../model/bookmarks";
import { cloneMeta } from "../model/document";
import { parse, serializeChecked } from "../model/serialize";
import { DEFAULT_META, type NotebookMeta } from "../model/types";

/** Name of the disposable library index inside the plugin folder. */
export const LIBRARY_INDEX_FILE = "library-index.json";

/** `<config dir>/plugins/<plugin id>/library-index.json` (vault-relative, forward slashes). */
export function libraryIndexPath(configDir: string, pluginId: string): string {
	const dir = configDir.replace(/^\/+|\/+$/g, "");
	return `${dir ? dir + "/" : ""}plugins/${pluginId}/${LIBRARY_INDEX_FILE}`;
}

/** Parses stored JSON; null when the text is missing, empty or corrupt (the index is rebuilt then). */
export function parseStoredJson(raw: string | null | undefined): unknown {
	if (!raw || raw.trim().length === 0) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

/** `base` with the fields present in `patch` replaced; arrays are copied, never shared. */
export function mergeMeta(base: NotebookMeta | undefined, patch: Partial<NotebookMeta>): NotebookMeta {
	const next = cloneMeta(base ?? DEFAULT_META);
	if (patch.tags !== undefined) next.tags = [...patch.tags];
	if (patch.favorite !== undefined) next.favorite = patch.favorite;
	if (patch.cover !== undefined) next.cover = patch.cover;
	if (patch.bookmarks !== undefined) next.bookmarks = [...patch.bookmarks];
	if ("bookmarkInfo" in patch) {
		const info = copyBookmarkInfoMap(patch.bookmarkInfo);
		if (info) next.bookmarkInfo = info;
		else delete next.bookmarkInfo;
	}
	// v11: present with `undefined` (or "") clears the field.
	if ("description" in patch) {
		if (patch.description) next.description = patch.description;
		else delete next.description;
	}
	if ("coverArt" in patch) {
		if (patch.coverArt) next.coverArt = { ...patch.coverArt };
		else delete next.coverArt;
	}
	return next;
}

export type MetaPatchResult =
	| { ok: true; text: string; changed: boolean; migrated: boolean }
	| { ok: false; message: string };

/**
 * New document text with `patch` merged into the metadata of the notebook stored in `json`.
 * Never produces text for a file that fails to parse or whose result fails the round-trip check,
 * so the caller can refuse to write. `migrated` is true when the file is from an older format, or when
 * invalid v7 details were dropped on read (writing changes it beyond the patch, so the caller should keep
 * a backup).
 */
export function patchNotebookMeta(json: string, patch: Partial<NotebookMeta>): MetaPatchResult {
	const parsed = parse(json);
	if (!parsed.ok) return { ok: false, message: parsed.message };
	const doc = { ...parsed.doc, meta: mergeMeta(parsed.doc.meta, patch) };
	const out = serializeChecked(doc);
	if (!out.ok) return { ok: false, message: out.message };
	const migrated = parsed.migratedFrom !== null || (parsed.dropped ?? 0) > 0;
	return { ok: true, text: out.text, changed: migrated || out.text !== json, migrated };
}

/** Same as `patchNotebookMeta`, but gives the notebook the document id `id` (for a duplicated file). */
export function patchNotebookId(json: string, id: string): MetaPatchResult {
	const parsed = parse(json);
	if (!parsed.ok) return { ok: false, message: parsed.message };
	if (id.length === 0) return { ok: false, message: "empty id" };
	const out = serializeChecked({ ...parsed.doc, id });
	if (!out.ok) return { ok: false, message: out.message };
	return { ok: true, text: out.text, changed: parsed.doc.id !== id, migrated: parsed.migratedFrom !== null || (parsed.dropped ?? 0) > 0 };
}
