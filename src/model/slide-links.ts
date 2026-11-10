/**
 * v12 automatic notes ↔ slide link (#226), the pure part: ink written while a slide is shown beside the notes (side by
 * side, view/pdf-sync.ts) remembers that slide. No 'obsidian', no DOM.
 *
 * - The document keeps a small table of the slides ink was written beside (`NotebookDocument.slides`: PDF source id,
 *   1-based page, the vault path of a plain PDF); each such stroke names its entry (`Stroke.slide`, a short id). One entry
 *   per slide, shared by all the ink written beside it, so a stroke costs a dozen characters, not a PDF id and a path.
 * - Linking is part of the stroke's own undo step: the strokes carry the id, and a new entry is added by `AddSlideRef` in
 *   the same batch (undo removes both, redo puts both back). Entries no stroke refers to any more are not written.
 * - Ink copied within the notebook (duplicate, paste, move between pages) keeps the link; ink pasted into another notebook
 *   names an entry that is not there, which the writer leaves out (the ink stays, unlinked).
 */
import { strokeBounds, type BBox } from "../ink/hit-test";
import type { Command } from "./history";
import { freezeStroke } from "./serialize";
import { SLIDE_PATH_MAX, SLIDE_SOURCE_MAX, type NotebookDocument, type SlideRef, type Stroke } from "./types";

/** A slide without its id: what the side-by-side pane shows. */
export interface SlideKey {
	source: string;
	/** 1-based page. */
	page: number;
	path?: string;
}

/** Same slide: same page of the same PDF (same content id, or the same vault path: a plain PDF replaced in place). */
export function sameSlide(a: SlideKey, b: SlideKey): boolean {
	return a.page === b.page && sameSource(a, b);
}

/**
 * Same PDF: the same content id, or the same vault path of a plain PDF (replaced in place, so its content id changed). A
 * notebook path says nothing: one notebook can show pages of several PDFs.
 */
export function sameSource(a: { source: string; path?: string }, b: { source: string; path?: string }): boolean {
	return a.source === b.source || (a.path !== undefined && a.path.toLowerCase().endsWith(".pdf") && a.path === b.path);
}

const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 8;

/** A new id of 8 base-36 characters that is not in `taken`. */
export function newSlideId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
	for (;;) {
		let id = "";
		for (let i = 0; i < ID_LENGTH; i++) id += ID_CHARS[Math.floor(random() * ID_CHARS.length) % ID_CHARS.length];
		if (!taken.has(id)) return id;
	}
}

/** The entry of the table for exactly this slide (same source, page and path), or null. */
export function findSlideRef(doc: NotebookDocument, key: SlideKey): SlideRef | null {
	for (const r of doc.slides ?? []) {
		if (r.source === key.source && r.page === key.page && (r.path ?? "") === (key.path ?? "")) return r;
	}
	return null;
}

/** The slide a stroke was written beside, or null. */
export function slideRefOf(doc: NotebookDocument, stroke: Stroke): SlideRef | null {
	if (stroke.slide === undefined) return null;
	return (doc.slides ?? []).find((r) => r.id === stroke.slide) ?? null;
}

/** The table by id. */
export function slideTable(doc: NotebookDocument): ReadonlyMap<string, SlideRef> {
	return new Map((doc.slides ?? []).map((r) => [r.id, r]));
}

/**
 * Adds an entry to the slide table. An entry with that id already there is left alone, and then undoing does not remove
 * it: revert() removes only what this command added (like AddAsset).
 */
export class AddSlideRef implements Command {
	readonly label = "Link ink to slide";
	private added = false;
	constructor(readonly ref: SlideRef) {}

	/** 0.28 (#98): this command added the entry (it was not there), so undoing it takes the entry away. */
	get adds(): boolean {
		return this.added;
	}

	apply(doc: NotebookDocument): void {
		const list = (doc.slides ??= []);
		this.added = !list.some((r) => r.id === this.ref.id);
		if (this.added) list.push(this.ref);
	}

	revert(doc: NotebookDocument): void {
		if (!this.added) return;
		this.added = false;
		const list = doc.slides ?? [];
		const i = list.indexOf(this.ref);
		if (i >= 0) list.splice(i, 1);
		if (list.length === 0) delete doc.slides;
	}
}

/**
 * Strokes about to be committed, linked to the slide `key`: copies that name its entry, and the command that adds the
 * entry when the table does not have it yet (to run in the same undo step, before or after the strokes). Values the file
 * format bounds are checked here: a path that is too long is left out of the entry (the slide is still told by its PDF id),
 * and a source that is too long links nothing (the strokes come back unchanged): a longer value would make every save fail.
 */
export function linkStrokes(doc: NotebookDocument, strokes: readonly Stroke[], key: SlideKey, random?: () => number): { strokes: Stroke[]; commands: Command[] } {
	if (key.source.length === 0 || key.source.length > SLIDE_SOURCE_MAX || !Number.isSafeInteger(key.page) || key.page < 1) return { strokes: [...strokes], commands: [] };
	const path = key.path !== undefined && key.path.length > 0 && key.path.length <= SLIDE_PATH_MAX ? key.path : undefined;
	key = path === undefined ? { source: key.source, page: key.page } : { source: key.source, page: key.page, path };
	let ref = findSlideRef(doc, key);
	const commands: Command[] = [];
	if (!ref) {
		const made: SlideRef = { id: newSlideId(new Set((doc.slides ?? []).map((r) => r.id)), random), source: key.source, page: key.page };
		if (path !== undefined) made.path = path;
		ref = Object.freeze(made);
		commands.push(new AddSlideRef(ref));
	}
	const id = ref.id;
	return { strokes: strokes.map((s) => (s.slide === id ? s : freezeStroke({ ...s, slide: id }))), commands };
}

/** The slide most of `strokes` were written beside (a tie: the one of the latest stroke), or null when none was. */
export function slideOfStrokes(doc: NotebookDocument, strokes: readonly Stroke[]): SlideRef | null {
	const table = slideTable(doc);
	const count = new Map<string, number>();
	let best: string | null = null;
	for (const s of strokes) {
		if (s.slide === undefined || !table.has(s.slide)) continue;
		const n = (count.get(s.slide) ?? 0) + 1;
		count.set(s.slide, n);
		if (best === null || n >= (count.get(best) ?? 0)) best = s.slide;
	}
	return best === null ? null : table.get(best) ?? null;
}

/** Ink written beside one slide, close together on one page: where its badge goes. */
export interface SlideInkGroup {
	ref: SlideRef;
	/** Number of strokes. */
	strokes: number;
	/** Bounds of the ink, page coordinates (half the stroke width included). */
	bounds: BBox;
}

/** Ink of the same slide closer than this (pt) is one group: one badge for a paragraph, not one per word. */
export const GROUP_GAP = 48;

/**
 * The groups of linked ink of a page, top to bottom: strokes written beside the same slide whose boxes come within
 * `gap` of each other. `boundsOf` is the stroke's box (cached by the caller; strokes are immutable).
 */
export function slideInkGroups(
	table: ReadonlyMap<string, SlideRef>, strokes: readonly Stroke[], gap = GROUP_GAP, boundsOf: (s: Stroke) => BBox = strokeBounds,
): SlideInkGroup[] {
	const groups: SlideInkGroup[] = [];
	const near = (a: BBox, b: BBox) => a.minX - gap <= b.maxX && b.minX - gap <= a.maxX && a.minY - gap <= b.maxY && b.minY - gap <= a.maxY;
	const grow = (a: BBox, b: BBox): BBox => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) });
	for (const s of strokes) {
		if (s.slide === undefined) continue;
		const ref = table.get(s.slide);
		if (!ref) continue;
		const box = boundsOf(s);
		const into = groups.find((g) => g.ref === ref && near(g.bounds, box));
		if (!into) {
			groups.push({ ref, strokes: 1, bounds: box });
			continue;
		}
		into.strokes++;
		into.bounds = grow(into.bounds, box);
		// The grown group may now reach another group of the same slide: one group then.
		for (let i = groups.length - 1; i >= 0; i--) {
			const g = groups[i]!;
			if (g === into || g.ref !== ref || !near(g.bounds, into.bounds)) continue;
			into.strokes += g.strokes;
			into.bounds = grow(into.bounds, g.bounds);
			groups.splice(i, 1);
		}
	}
	return groups.sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
}

/**
 * The main notebook's id for each slide of a conflicted copy (merge.ts): the same entry when it is there, an equal entry
 * under another id, else the copy's entry added (under a new id when the main notebook uses that id for another slide).
 * `commands` adds what is missing; call it once, after every `map`.
 */
export function slideMerger(main: NotebookDocument, other: NotebookDocument): { map(id: string): string | null; commands(): Command[] } {
	const mainTable = new Map((main.slides ?? []).map((r) => [r.id, r]));
	const otherTable = slideTable(other);
	const taken = new Set(mainTable.keys());
	const mapped = new Map<string, string>();
	const added: SlideRef[] = [];
	return {
		map(id) {
			const known = mapped.get(id);
			if (known !== undefined) return known;
			const ref = otherTable.get(id);
			if (!ref) return null;
			const same = mainTable.get(id);
			let to: string;
			if (same && same.source === ref.source && same.page === ref.page && (same.path ?? "") === (ref.path ?? "")) to = id;
			else {
				const equal = [...mainTable.values(), ...added].find((r) => r.source === ref.source && r.page === ref.page && (r.path ?? "") === (ref.path ?? ""));
				if (equal) to = equal.id;
				else {
					to = taken.has(id) ? newSlideId(taken) : id;
					taken.add(to);
					const copy: SlideRef = { id: to, source: ref.source, page: ref.page };
					if (ref.path !== undefined) copy.path = ref.path;
					added.push(Object.freeze(copy));
				}
			}
			mapped.set(id, to);
			return to;
		},
		commands: () => added.map((r) => new AddSlideRef(r)),
	};
}
