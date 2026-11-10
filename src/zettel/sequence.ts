/**
 * Card sequences (Z7): the structure of Luhmann ids (`1`, `1a`, `1a1`, `1a2`, `1b`, `2`…) as a tree that can be walked:
 * parent, previous / next sibling, children, and the next free id of a follow-up card or a branch card.
 * Pure: no 'obsidian'. Nothing here is stored: the structure IS the id (`zettel-id` in the card's frontmatter), so a card
 * keeps its place when its note is renamed or moved, and the document format does not change.
 *
 * Ids are compared case-insensitively and returned lower case. Ids that are not Luhmann-style (timestamps) have no
 * place in a sequence and are ignored.
 *
 * Words used here:
 * - parent: the id with its last number or letter group cut off (`1a2` → `1a` → `1`). A missing parent (card deleted,
 *   id edited by hand) is skipped: the nearest card that exists above is the parent, so no card is ever unreachable.
 * - siblings: cards with the same (nearest existing) parent, in order. At the top level, the numbers `1`, `2`, `10`.
 * - follow-up: the next sibling of a card (`1a` → `1b`; `3` → `4`).
 * - branch: a child of a card (`1` → `1a`, `1a` → `1a1`): what you write when a card needs its own continuation.
 */
import { idSet, indexLetters, letterIndex, nextLuhmannChild, parseLuhmann } from "./ids";

export type SequenceKind = "follow-up" | "branch";

/** Pure-number file name parts this long or longer are dates (`20261029…`), never card numbers. */
const TIMESTAMP_DIGITS = 8;

type Part = number | string;

/** Whether the id is Luhmann-style (it has a place in a sequence). */
export function isSequenceId(id: string): boolean {
	return parseLuhmann(id) !== null;
}

function cmpParts(a: readonly Part[], b: readonly Part[]): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (typeof x === "number" && typeof y === "number") {
			if (x !== y) return x - y;
		} else if (typeof x === "string" && typeof y === "string") {
			const d = letterIndex(x) - letterIndex(y);
			if (d !== 0) return d;
		} else {
			// Cannot happen for two valid ids (numbers and letters alternate in the same places); numbers first.
			return typeof x === "number" ? -1 : 1;
		}
	}
	return a.length - b.length;
}

/**
 * Order of cards in a sequence: `1 < 1a < 1a1 < 1a2 < 1b < 1z < 1aa < 2 < 10`. A card comes before its own branches,
 * numbers compare as numbers (`2 < 10`) and letters as bijective base 26 (`z < aa`). Luhmann ids come before other ids,
 * which keep a natural text order; ids equal in value (`01`, `1`) fall back to plain text so the order is total.
 */
export function compareSequenceIds(a: string, b: string): number {
	const pa = parseLuhmann(a);
	const pb = parseLuhmann(b);
	if (pa && pb) return cmpParts(pa, pb) || (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
	if (pa) return -1;
	if (pb) return 1;
	return a.localeCompare(b, undefined, { numeric: true });
}

/** The id one level up (`1a2` → `1a`, `1a` → `1`), null for a top-level number or an id that is not Luhmann-style. */
export function parentId(id: string): string | null {
	const s = id.trim().toLowerCase();
	if (!parseLuhmann(s)) return null;
	const tail = /(\d+|[a-z]+)$/.exec(s);
	const rest = tail ? s.slice(0, s.length - tail[0].length) : "";
	return rest || null;
}

/** Number of levels of an id (`1` is 1, `1a1` is 3); 0 when it is not Luhmann-style. */
export function depthOf(id: string): number {
	return parseLuhmann(id)?.length ?? 0;
}

/** The ids around a card in its sequence (all lower case; `null` / empty when there is none). */
export interface Neighbours {
	parent: string | null;
	previous: string | null;
	next: string | null;
	children: string[];
}

/**
 * The parent, siblings and children of `id` among `ids`. `id` itself need not be among them (a card about to be made).
 * A parent that does not exist is skipped (see the header), so `1a1` with no `1a` is a child of `1`.
 */
export function neighbours(id: string, ids: Iterable<string>): Neighbours {
	const key = id.trim().toLowerCase();
	const all = [...new Set([...ids].map((x) => x.trim().toLowerCase()).filter(isSequenceId))].sort(compareSequenceIds);
	const present = new Set(all);
	const parentOf = (x: string): string | null => {
		for (let p = parentId(x); p; p = parentId(p)) if (present.has(p)) return p;
		return null;
	};
	const parent = parentOf(key);
	if (!parseLuhmann(key)) return { parent: null, previous: null, next: null, children: [] };
	const siblings = all.filter((x) => x !== key && parentOf(x) === parent);
	let previous: string | null = null;
	let next: string | null = null;
	for (const s of siblings) {
		if (compareSequenceIds(s, key) < 0) previous = s;
		else if (next === null) next = s;
	}
	const children = all.filter((x) => x !== key && parentOf(x) === key);
	return { parent, previous, next, children };
}

/**
 * The next free sibling after `id`: `1a` → `1b`; when that is taken, the next free one after it (`1a` with `1b`, `1c` → `1d`;
 * with a gap, `1a` and `1c` → `1b`, which also keeps the cards in order). A top-level number goes to the next free number.
 * Null when `id` is not Luhmann-style.
 */
export function followUpId(id: string, takenIds: ReadonlySet<string>): string | null {
	const s = id.trim().toLowerCase();
	if (!parseLuhmann(s)) return null;
	const taken = occupiedIds(takenIds);
	const tail = /(\d+|[a-z]+)$/.exec(s)![0];
	const stem = s.slice(0, s.length - tail.length);
	const numeric = /^\d/.test(tail);
	for (let i = (numeric ? Number(tail) : letterIndex(tail)) + 1; ; i++) {
		const candidate = stem + (numeric ? String(i) : indexLetters(i));
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * The next free branch under `id` (`1` → `1a`, `1a` → `1a1`): one more than the last existing branch, so the id of a deleted
 * branch is not reused while later ones exist. Null when `id` is not Luhmann-style.
 */
export function branchId(id: string, taken: ReadonlySet<string>): string | null {
	// One past the largest existing branch, so it cannot be taken (`taken` holds lower-case ids, see `idSet`).
	// An id above a taken one counts too (`1a` above `1a1`), so the branch is never the parent of a card that already exists.
	return nextLuhmannChild(id.trim().toLowerCase(), occupiedIds(taken));
}

/**
 * The ids that count as taken: the given ones and every id above them (`1b1` takes `1b` and `1`). A new card never gets such an
 * id, or it would become the parent of the card below it, which belongs to another card of the same name (one that was deleted).
 */
export function occupiedIds(taken: Iterable<string>): Set<string> {
	const out = new Set<string>();
	for (const raw of taken) {
		const id = raw.trim().toLowerCase();
		out.add(id);
		for (let p = parentId(id); p && !out.has(p); p = parentId(p)) out.add(p);
	}
	return out;
}

/**
 * Ids that note names already use, for notes that are not cards (or cards not read yet): `1a Energy`, `2-k3f9`, `1b`.
 * A new card must not take such an id, or its file would collide with the existing note. Dates (`20261029 Plan`) are skipped.
 */
export function idsInNames(basenames: Iterable<string>): string[] {
	const out: string[] = [];
	for (const name of basenames) {
		const m = /^(\d+(?:[a-z]+\d+)*[a-z]*)(?=$|[\s\-_.])/i.exec(name.trim());
		if (!m) continue;
		const id = m[1]!.toLowerCase();
		if (/^\d+$/.test(id) && id.length >= TIMESTAMP_DIGITS) continue;
		out.push(id);
	}
	return out;
}

/**
 * The id for a new card of `kind` continuing `originId`, never one that exists: `cardIds` are the ids of the cards found,
 * `names` the names of notes (see `idsInNames`). Null when `originId` is not Luhmann-style.
 */
export function sequenceCardId(kind: SequenceKind, originId: string, cardIds: Iterable<string>, names: Iterable<string> = []): string | null {
	const taken = idSet([...cardIds, ...names]);
	return kind === "branch" ? branchId(originId, taken) : followUpId(originId, taken);
}
