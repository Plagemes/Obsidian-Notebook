/**
 * 0.20 review (D1, D2): how the companion headings keep their pictures. Pure: no DOM, no 'obsidian'.
 *
 * - `NotebookLru`: one value per notebook path, bounded, so a heading index is kept for each of a few notebooks and one
 *   notebook's work never evicts another's.
 * - `choosePicturePath`: where a heading picture goes. Every picture the plugin makes carries the ink it shows in a PNG text
 *   chunk (`PICTURE_MARK`). A file at the wanted name that has no mark is the user's (cropped, annotated, their own): it is never
 *   written over, the picture takes the next free name instead. A file with the same mark is already right (nothing is written,
 *   whatever encoder drew it, so devices do not rewrite each other's pictures); one with another mark is ours and stale.
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

/** What is at a path: nothing, or a file with its mark (null when it has none). */
export type PictureProbe = { kind: "free" } | { kind: "file"; mark: string | null };

export type PicturePlan = { path: string; action: "create" | "keep" | "rewrite" };

/** Most names tried (`p3-h1.png`, `p3-h1 2.png`, ...). */
export const MAX_PICTURE_NAMES = 9;

/** `a/p3-h1.png` -> `a/p3-h1 2.png`. */
export function numberedName(path: string, n: number): string {
	if (n <= 1) return path;
	const dot = path.lastIndexOf(".");
	return dot > path.lastIndexOf("/") ? `${path.slice(0, dot)} ${n}${path.slice(dot)}` : `${path} ${n}`;
}

/** Where the picture of ink `key` goes, starting from `base`; null when every name is taken by files that are not ours. */
export async function choosePicturePath(base: string, key: string, probe: (path: string) => Promise<PictureProbe>): Promise<PicturePlan | null> {
	for (let n = 1; n <= MAX_PICTURE_NAMES; n++) {
		const path = numberedName(base, n);
		const found = await probe(path);
		if (found.kind === "free") return { path, action: "create" };
		if (found.mark === key) return { path, action: "keep" };
		if (found.mark !== null) return { path, action: "rewrite" };
	}
	return null;
}
