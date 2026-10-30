/**
 * What the library check cannot see in the vault listing (roadmap 27): the asset ids held by notebooks that are open and by
 * the instant-save journal. Pure: no 'obsidian'.
 *
 * - **Open notebooks.** A notebook that is open may hold in memory an asset (a picture or a PDF just inserted, or one only the
 *   undo or redo history still names) that is not in the saved file yet. `assetIdsIn` walks whatever the views hand over (the
 *   document, the commands of the undo and redo stacks, the media not yet in the document) and collects every 24-digit hex
 *   run in any string or object key. Too much to walk, or anything that throws: incomplete.
 * - **The journal.** The instant-save journal (storage/journal.ts) keeps recent edits, as full text or as changed lines, in
 *   the plugin's config folder. An entry can name an asset the notebook file does not yet. `journalAssetIds` reads every
 *   `*.journal` file; one that cannot be read or is not a journal entry makes the answer incomplete.
 */
import { decodeEntry } from "../storage/journal";
import { hexTokens, type LiveReferences } from "./library-check";

/** Most values walked before giving up (a very large notebook with a long history): the answer is then incomplete. */
export const MAX_WALK_NODES = 8_000_000;

/** The asset ids named anywhere in `roots` (strings and object keys), and whether all of it could be walked. */
export function assetIdsIn(roots: readonly unknown[], maxNodes = MAX_WALK_NODES): LiveReferences & { ids: Set<string> } {
	const ids = new Set<string>();
	const seen = new WeakSet<object>();
	const stack: unknown[] = [...roots];
	let nodes = 0;
	const addString = (s: string) => {
		if (s.length < 24) return;
		for (const tok of hexTokens(s)) ids.add(tok);
	};
	try {
		while (stack.length > 0) {
			const v = stack.pop();
			if (typeof v === "string") {
				addString(v);
				continue;
			}
			if (typeof v !== "object" || v === null) continue;
			if (seen.has(v)) continue;
			seen.add(v);
			if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
			if (Array.isArray(v)) {
				// A list of numbers (a point of a stroke) is a leaf: it is not counted.
				let inner = false;
				for (const x of v) {
					if (typeof x === "object" && x !== null) {
						stack.push(x);
						inner = true;
					} else if (typeof x === "string") addString(x);
				}
				if (inner && ++nodes > maxNodes) return { ids, incomplete: true };
				continue;
			}
			if (++nodes > maxNodes) return { ids, incomplete: true };
			if (v instanceof Map) {
				for (const [k, x] of v) {
					stack.push(k, x);
				}
			} else if (v instanceof Set) {
				for (const x of v) stack.push(x);
			} else {
				for (const key of Object.keys(v)) {
					if (key.length >= 24) addString(key);
					const x = (v as Record<string, unknown>)[key];
					if (typeof x === "object" && x !== null) stack.push(x);
					else if (typeof x === "string") addString(x);
				}
			}
		}
	} catch {
		return { ids, incomplete: true };
	}
	return { ids, incomplete: false };
}

/** The file operations the journal scan uses (the vault adapter at runtime). */
export interface JournalReader {
	exists(path: string): Promise<boolean>;
	/** Paths of the files directly inside `folder`. */
	list(folder: string): Promise<string[]>;
	read(path: string): Promise<string>;
}

/**
 * The asset ids named by the journal files in `folder`. A missing folder is an empty journal. A file that cannot be read, is
 * empty, cut off or not a journal entry still has its ids collected, but makes the answer incomplete.
 */
export async function journalAssetIds(reader: JournalReader, folder: string): Promise<LiveReferences & { ids: Set<string> }> {
	const ids = new Set<string>();
	let incomplete = false;
	let files: string[];
	try {
		if (!(await reader.exists(folder))) return { ids, incomplete: false };
		files = (await reader.list(folder)).filter((f) => f.endsWith(".journal"));
	} catch {
		return { ids, incomplete: true };
	}
	for (const path of files) {
		try {
			const text = await reader.read(path);
			for (const tok of hexTokens(text)) ids.add(tok);
			if (decodeEntry(text) === null) incomplete = true;
		} catch {
			incomplete = true;
		}
	}
	return { ids, incomplete };
}

/** Both together. */
export async function liveAssetIds(roots: () => readonly unknown[], reader: JournalReader, journalFolder: string): Promise<LiveReferences & { ids: Set<string> }> {
	let viewRoots: readonly unknown[] = [];
	let incomplete = false;
	try {
		viewRoots = roots();
	} catch {
		incomplete = true;
	}
	const open = assetIdsIn(viewRoots);
	const journal = await journalAssetIds(reader, journalFolder);
	return { ids: new Set([...open.ids, ...journal.ids]), incomplete: incomplete || open.incomplete || journal.incomplete };
}
