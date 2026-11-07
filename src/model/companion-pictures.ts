/**
 * 0.20 review (D1, D2): how the companion headings keep their pictures. Pure: no DOM, no 'obsidian'.
 *
 * - `NotebookLru`: one value per notebook path, bounded, so a heading index is kept for each of a few notebooks and one
 *   notebook's work never evicts another's.
 * - `choosePicturePath`: where a heading picture goes. Every picture the plugin makes carries the ink it shows in a PNG text
 *   chunk (`PICTURE_MARK`). A file at the wanted name that has no mark is the user's (cropped, annotated, their own): it is never
 *   written over, the picture takes the next free name instead. A file with the same mark is already right (nothing is written,
 *   whatever encoder drew it, so devices do not rewrite each other's pictures); one with another mark is ours and stale.
 *   Stale is rewritten only while its pixels are still the ones the plugin wrote (`intact`): a picture the user cropped or
 *   annotated in an editor that kept the text chunks is theirs now, so the picture takes the next free name instead.
 */

/** Keyword of the PNG text chunk that holds the ink key. */
export const PICTURE_MARK = "notebook-heading";

/** Most notebooks whose heading analysis is kept at the same time. */
export const MAX_HEADING_NOTEBOOKS = 4;

/** Values by notebook path, least recently used dropped first. */
export class NotebookLru<V> {
	private readonly map = new Map<string, V>();

	constructor(readonly capacity = MAX_HEADING_NOTEBOOKS) {}

	get size(): number {
		return this.map.size;
	}

	has(key: string): boolean {
		return this.map.has(key);
	}

	/** The value of `key` (now the most recently used), made by `make` when there is none. */
	get(key: string, make: () => V): V {
		const have = this.map.get(key);
		if (have !== undefined) {
			this.map.delete(key);
			this.map.set(key, have);
			return have;
		}
		const value = make();
		this.map.set(key, value);
		while (this.map.size > this.capacity) {
			const oldest = this.map.keys().next();
			if (oldest.done) break;
			this.map.delete(oldest.value);
		}
		return value;
	}
}

/** Size and modification time of a file, as the vault knows them. */
export interface FileStamp {
	mtime: number;
	size: number;
}

/** What is at a path: nothing, or a file with its mark (null when it has none), whether its pixels are still as written, and its stamp. */
export type PictureProbe = { kind: "free" } | { kind: "file"; mark: string | null; intact?: boolean; stamp?: FileStamp };

/**
 * `create`: a free name. `keep`: already right. `rewrite`: ours and stale (`stamp`: the file as it was probed, to check right before the write).
 * `full`: every name is taken; `path` is the newest picture of ours (stale, never written over), kept as the link.
 */
export type PicturePlan = { path: string; action: "create" | "keep" | "rewrite" | "full"; stamp?: FileStamp };

/** Most names tried (`p3-h1.png`, `p3-h1 2.png`, ...). */
export const MAX_PICTURE_NAMES = 24;

/** `a/p3-h1.png` -> `a/p3-h1 2.png`. */
export function numberedName(path: string, n: number): string {
	if (n <= 1) return path;
	const dot = path.lastIndexOf(".");
	return dot > path.lastIndexOf("/") ? `${path.slice(0, dot)} ${n}${path.slice(dot)}` : `${path} ${n}`;
}

/**
 * Where the picture of ink `key` goes, starting from `base`. When every name is taken by files that are not rewritable, the
 * picture does not vanish from the note: the plan is `full`, pointing at the newest picture of ours (a stale one, left as it is),
 * so the previous link stays; null only when none of the names is ours.
 */
export async function choosePicturePath(base: string, key: string, probe: (path: string) => Promise<PictureProbe>): Promise<PicturePlan | null> {
	let newestOurs: string | null = null;
	for (let n = 1; n <= MAX_PICTURE_NAMES; n++) {
		const path = numberedName(base, n);
		const found = await probe(path);
		if (found.kind === "free") return { path, action: "create" };
		if (found.mark === key) return { path, action: "keep" };
		if (found.mark !== null) newestOurs = path;
		// `intact` false: the pixels are no longer the ones this plugin wrote, so the file has become the user's (next name).
		if (found.mark !== null && found.intact !== false) return { path, action: "rewrite", ...(found.stamp ? { stamp: found.stamp } : {}) };
	}
	return newestOurs ? { path: newestOurs, action: "full" } : null;
}

/** True when a file is no longer as it was at `before`: gone, or another size or time. */
export function changedSince(before: FileStamp | undefined, now: FileStamp | null | undefined): boolean {
	if (!now) return true;
	if (!before) return false; // nothing was recorded: nothing to compare with
	return now.mtime !== before.mtime || now.size !== before.size;
}

/** The little the write needs of a vault (a test passes a fake). */
export interface PictureVault<F extends { stat: FileStamp }> {
	getFileByPath(path: string): F | null;
	modifyBinary(file: F, data: ArrayBuffer): Promise<void>;
}

/**
 * 0.21 (R5): rewrites the picture at `plan.path` only if the file is still as it was probed. There is no atomic read-compare-
 * write for binary files, so the stamp is read again right before the write, with nothing awaited in between. False (nothing
 * written) when the file changed or vanished meanwhile: the caller picks a new name.
 */
export async function rewriteIfUnchanged<F extends { stat: FileStamp }>(vault: PictureVault<F>, plan: PicturePlan, data: ArrayBuffer): Promise<{ file: F | null; changed: boolean }> {
	const file = vault.getFileByPath(plan.path);
	if (!file || changedSince(plan.stamp, file.stat)) return { file: null, changed: true };
	await vault.modifyBinary(file, data);
	return { file, changed: false };
}
