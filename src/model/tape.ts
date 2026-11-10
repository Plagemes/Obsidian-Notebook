import { createId } from "./document";
import type { BBox } from "../ink/hit-test";
import type { NotebookDocument, Page, PageElement, TapeElement } from "./types";

/**
 * Study tape (0.29, roadmap #10, format v27). Pure data and geometry: no 'obsidian', no DOM. A drag with the study tape on becomes a page element
 * (`TapeElement`): an opaque axis-aligned rectangle in a tape colour, drawn above all the ink and every other element, that hides what is under
 * it. A tap on a tape reveals it (only its outline is left, so it can be tapped again to hide it).
 *
 * Whether a tape is revealed is **view-only** (`TapeReveal`): it is never saved, never an undo step and never synced, and every tape is hidden
 * again when the notebook is opened (that is what a study tape is for: test yourself, then cover the answers again). "Reveal all" and "Hide
 * all" work on the same view state. Exports draw every tape hidden, as a notebook opens; a clean export leaves them out (model/clean-export.ts).
 */

/** A tape is never thinner than this (pt): anything smaller is a tap, not a drag. */
export const TAPE_MIN_SIDE = 4;
/** The largest side the format accepts (pt); far beyond any page, it only bounds corrupt values. */
export const TAPE_MAX_SIDE = 20000;

/** The tape colours offered (the "Study tape colour" setting): soft, opaque, readable as "something is under here" in day and night. */
export const TAPE_COLORS = {
	mint: "#8fd3bf",
	sky: "#9cc3ec",
	rose: "#f2aebf",
	sand: "#ead39a",
	slate: "#a3acbb",
} as const;
export type TapeColorName = keyof typeof TAPE_COLORS;
export const TAPE_COLOR_NAMES = Object.keys(TAPE_COLORS) as TapeColorName[];
export const DEFAULT_TAPE_COLOR: TapeColorName = "mint";

/** Whether a saved settings value is one of the tape colour names. */
export function isTapeColorName(v: unknown): v is TapeColorName {
	return typeof v === "string" && (TAPE_COLOR_NAMES as readonly string[]).includes(v);
}

/** The colour of a settings value (a name of TAPE_COLORS; anything else is the default). */
export function tapeColorOf(name: string): string {
	return (TAPE_COLORS as Record<string, string>)[name] ?? TAPE_COLORS[DEFAULT_TAPE_COLOR];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function isTape(el: PageElement): el is TapeElement {
	return el.type === "tape";
}

/** Tapes of a page, in array order (the last is drawn on top). */
export function tapesOf(page: Pick<Page, "elements">): TapeElement[] {
	return (page.elements ?? []).filter(isTape);
}

/** The box of the tape. */
export function tapeBounds(el: TapeElement): BBox {
	return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

/**
 * The rectangle of a drag from corner `a` to corner `b`, kept inside a page of `page` size, or null when it is too small to be a tape (a tap
 * or a stray touch). Coordinates are rounded to 0.01 pt like every element.
 */
export function tapeRect(
	a: readonly [number, number], b: readonly [number, number], page: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
	if (![a[0], a[1], b[0], b[1], page.width, page.height].every(Number.isFinite)) return null;
	const clampX = (v: number) => Math.min(page.width, Math.max(0, v));
	const clampY = (v: number) => Math.min(page.height, Math.max(0, v));
	const x0 = clampX(Math.min(a[0], b[0]));
	const x1 = clampX(Math.max(a[0], b[0]));
	const y0 = clampY(Math.min(a[1], b[1]));
	const y1 = clampY(Math.max(a[1], b[1]));
	const width = round2(x1 - x0);
	const height = round2(y1 - y0);
	if (!(width >= TAPE_MIN_SIDE) || !(height >= TAPE_MIN_SIDE)) return null;
	return { x: round2(x0), y: round2(y0), width: Math.min(width, TAPE_MAX_SIDE), height: Math.min(height, TAPE_MAX_SIDE) };
}

/** A new tape from a drag, or null when the drag is too small. */
export function createTape(
	a: readonly [number, number], b: readonly [number, number], page: { width: number; height: number }, color: string,
): TapeElement | null {
	const r = tapeRect(a, b, page);
	return r ? { id: createId(), type: "tape", ...r, color } : null;
}

/** The top-most tape (the last in array order) whose rectangle, grown by `tolerance` pt, holds the point; null when none does. */
export function tapeAt(elements: readonly PageElement[], x: number, y: number, tolerance = 0): TapeElement | null {
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i]!;
		if (el.type !== "tape") continue;
		if (x >= el.x - tolerance && x <= el.x + el.width + tolerance && y >= el.y - tolerance && y <= el.y + el.height + tolerance) return el;
	}
	return null;
}

/** Whether the point is under one of `tapes` (edges included). */
export function underTape(tapes: readonly TapeElement[], x: number, y: number): boolean {
	return tapes.some((t) => x >= t.x && x <= t.x + t.width && y >= t.y && y <= t.y + t.height);
}

/** Whether the box lies entirely under one of `tapes` (what such a tape hides completely). */
export function coveredByTape(b: BBox, tapes: readonly TapeElement[]): boolean {
	return tapes.some((t) => b.minX >= t.x && b.maxX <= t.x + t.width && b.minY >= t.y && b.maxY <= t.y + t.height);
}

/**
 * Which tapes are revealed in one notebook view (view-only, never saved). Ids of tapes that are gone are harmless (a tape that comes back with
 * an undo is revealed again, as it was); `prune` drops them when the document is replaced.
 */
export class TapeReveal {
	private readonly shown = new Set<string>();
	/** Bumped on every change, so a cache keyed on it (the renderer's) knows when to redraw. */
	version = 0;

	isRevealed(id: string): boolean {
		return this.shown.has(id);
	}

	/** Reveals a hidden tape or hides a revealed one; returns whether it is revealed now. */
	toggle(id: string): boolean {
		const on = !this.shown.has(id);
		if (on) this.shown.add(id);
		else this.shown.delete(id);
		this.version++;
		return on;
	}

	/** Reveals every tape of the list (true when one was hidden). */
	revealAll(tapes: Iterable<Pick<TapeElement, "id">>): boolean {
		let changed = false;
		for (const t of tapes) {
			if (this.shown.has(t.id)) continue;
			this.shown.add(t.id);
			changed = true;
		}
		if (changed) this.version++;
		return changed;
	}

	/** Hides every tape again (true when one was revealed). */
	hideAll(): boolean {
		if (this.shown.size === 0) return false;
		this.shown.clear();
		this.version++;
		return true;
	}

	/** Forgets every tape that is not in `doc` (a new document was loaded). */
	prune(doc: NotebookDocument | null): void {
		if (this.shown.size === 0) return;
		const alive = new Set<string>();
		for (const p of doc?.pages ?? []) for (const t of tapesOf(p)) alive.add(t.id);
		let changed = false;
		for (const id of [...this.shown]) {
			if (alive.has(id)) continue;
			this.shown.delete(id);
			changed = true;
		}
		if (changed) this.version++;
	}

	get size(): number {
		return this.shown.size;
	}
}

/** The tapes of `page` that hide what is under them now (not revealed in the view). */
export function hidingTapes(page: Pick<Page, "elements">, reveal: TapeReveal | null): TapeElement[] {
	return tapesOf(page).filter((t) => !reveal?.isRevealed(t.id));
}

/** How many tapes `pages` have and how many of them are revealed (the "Reveal all" / "Hide all" actions). */
export function tapeCounts(pages: readonly Pick<Page, "elements">[], reveal: TapeReveal | null): { total: number; revealed: number } {
	let total = 0;
	let revealed = 0;
	for (const p of pages) {
		for (const t of tapesOf(p)) {
			total++;
			if (reveal?.isRevealed(t.id)) revealed++;
		}
	}
	return { total, revealed };
}
