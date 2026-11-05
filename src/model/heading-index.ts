/**
 * The headings of a notebook, found from the size of the handwriting (roadmap #102) and kept per page (0.20). Pure: no DOM,
 * no 'obsidian', nothing stored (no format change).
 *
 * Each page's text layout is cached by a fingerprint of its content (`pageFingerprint`: the page size and, for every visible
 * pen or shape stroke, its id, point count and a few sampled points), so a page that did not change costs a comparison of
 * stroke identities, and one whose strokes were rebuilt with the same content (undo, redo, a reload, a sync) is not analysed
 * again either. `warm` analyses the stale pages a little at a time for an idle callback; `headings` finishes the rest.
 *
 * The notebook-wide reference (the usual letter height, weighted by strokes) is what a page with too few lines of its own is
 * measured against, so the headings of a page are found again only when that reference moves.
 */
import { detectHeadings, lineSizes, referenceHeight, type LineSize, type PageHeading } from "../ink/headings";
import { segmentText, type TextLayout } from "../ink/words";
import type { Page, Stroke } from "./types";

/** Pages with more strokes than this are not searched for headings (the outline must stay cheap on a heavy page). */
export const MAX_HEADING_STROKES = 4000;

const FNV = 0x01000193;

/** Two 32-bit FNV-1a lanes over numbers and text, printed as 16 hex digits. */
class Hash {
	private a = 0x811c9dc5;
	private b = 0x9e3779b1;
	num(n: number): void {
		const v = Math.round(n * 10) | 0;
		this.a = Math.imul(this.a ^ v, FNV);
		this.b = Math.imul(this.b ^ (v >>> 7) ^ (v << 5), FNV) + 0x7f4a7c15;
	}
	str(s: string): void {
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i);
			this.a = Math.imul(this.a ^ c, FNV);
			this.b = Math.imul(this.b ^ c, FNV) + 0x6d2b79f5;
		}
		this.num(s.length);
	}
	hex(): string {
		return (this.a >>> 0).toString(16).padStart(8, "0") + (this.b >>> 0).toString(16).padStart(8, "0");
	}
}

/** The strokes the headings are read from: visible pen and shape strokes (a highlighter or an invisible stroke is not handwriting). */
export function textStrokes(strokes: readonly Stroke[]): Stroke[] {
	return strokes.filter((s) => !s.hidden && (s.tool === "pen" || s.tool === "shape"));
}

/** Fingerprint of what the headings of a page depend on. Equal content gives an equal fingerprint, whatever objects hold it. */
export function pageFingerprint(page: { width: number; height: number; strokes: readonly Stroke[] }): string {
	const h = new Hash();
	h.num(page.width);
	h.num(page.height);
	for (const s of textStrokes(page.strokes)) {
		h.str(s.id);
		const pts = s.points;
		h.num(pts.length);
		if (pts.length === 0) continue;
		// First, last and three points in between: a stroke that was edited changes at least its length or one of them.
		const last = pts.length - 1;
		for (const k of [0, Math.floor(last / 4), Math.floor(last / 2), Math.floor((3 * last) / 4), last]) {
			const p = pts[k]!;
			h.num(p[0]);
			h.num(p[1]);
		}
	}
	return h.hex();
}

export interface PageHeadingList {
	pageId: string;
	/** 0-based. */
	index: number;
	headings: PageHeading[];
}

interface Entry {
	/** The page's strokes as last seen (identity fast path). */
	raw: readonly Stroke[];
	visible: Stroke[];
	fingerprint: string;
	width: number;
	height: number;
	sizes: LineSize[];
	layout: TextLayout;
	/** Headings with the notebook reference they were found with. */
	found: { reference: number; list: PageHeading[] } | null;
}

function sameStrokes(a: readonly Stroke[], b: readonly Stroke[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Keeps the per-page work between calls. One instance per open notebook. */
export class HeadingIndex {
	private readonly entries = new Map<string, Entry>();
	/** Pages analysed since `resetCount` (for tests and the status of the cache). */
	computed = 0;

	resetCount(): void {
		this.computed = 0;
	}

	/** The cached entry of a page, analysed now when it is new or changed; null for a page too heavy to search. */
	private entry(page: Page): Entry | null {
		if (page.strokes.length > MAX_HEADING_STROKES) {
			this.entries.delete(page.id);
			return null;
		}
		const have = this.entries.get(page.id);
		if (have && have.width === page.width && have.height === page.height && sameStrokes(have.raw, page.strokes)) return have;
		const fingerprint = pageFingerprint(page);
		if (have && have.fingerprint === fingerprint) {
			have.raw = page.strokes.slice();
			return have;
		}
		const visible = textStrokes(page.strokes);
		const layout = segmentText(visible);
		const next: Entry = {
			raw: page.strokes.slice(), visible, fingerprint, width: page.width, height: page.height, sizes: lineSizes(layout), layout, found: null,
		};
		this.entries.set(page.id, next);
		this.computed++;
		return next;
	}

	/** Whether the page has to be analysed (its cached analysis is missing or out of date). */
	private stale(page: Page): boolean {
		if (page.strokes.length > MAX_HEADING_STROKES) return false;
		const have = this.entries.get(page.id);
		if (!have || have.width !== page.width || have.height !== page.height) return true;
		return !sameStrokes(have.raw, page.strokes) && have.fingerprint !== pageFingerprint(page);
	}

	/** Pages whose analysis is out of date. */
	pending(pages: readonly Page[]): number {
		let n = 0;
		for (const p of pages) if (this.stale(p)) n++;
		return n;
	}

	/**
	 * Analyses stale pages until `budgetMs` of `now()` is used up (at least one page per call, so it always advances).
	 * Returns the number of pages still stale; 0 means `headings` will not have to analyse anything.
	 */
	warm(pages: readonly Page[], budgetMs: number, now: () => number = () => Date.now()): number {
		const start = now();
		let left = 0;
		let done = 0;
		for (const page of pages) {
			if (!this.stale(page)) continue;
			if (done > 0 && now() - start >= budgetMs) {
				left++;
				continue;
			}
			this.entry(page);
			done++;
		}
		this.forget(pages);
		return left;
	}

	/** The headings of every page that has some, in page order. Analyses what is still stale. */
	headings(pages: readonly Page[]): PageHeadingList[] {
		const entries = pages.map((page) => this.entry(page));
		const reference = referenceHeight(entries.flatMap((e) => e?.sizes ?? []));
		const out: PageHeadingList[] = [];
		pages.forEach((page, index) => {
			const e = entries[index];
			if (!e) return;
			if (!e.found || e.found.reference !== reference) {
				e.found = { reference, list: detectHeadings(e.layout, page, reference, {}, e.visible) };
			}
			if (e.found.list.length > 0) out.push({ pageId: page.id, index, headings: e.found.list });
		});
		this.forget(pages);
		return out;
	}

	/** Drops the cache of pages that are gone. */
	private forget(pages: readonly Page[]): void {
		if (this.entries.size <= pages.length) return;
		const ids = new Set(pages.map((p) => p.id));
		for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.entries.delete(id);
	}
}
