/**
 * Slide strip (#417), the pure part: for each slide of the notebook, what belongs to it — the slide's own page (a page
 * with that PDF page as background), the notes pages linked to it side by side (#106), the exercise page after it, the
 * ink written beside it (#226) or in the margin of its page, and the questions on it. No 'obsidian', no DOM.
 *
 * Where things come from:
 * - **Slide page**: the first page whose PDF background is that slide.
 * - **Notes pages**: the side-by-side links of this notebook (the sidecar of view/pdf-sync.ts), passed in by the caller.
 * - **Exercise page**: the plain page (no background) right after the slide's page, as "Exercise page here" makes it.
 * - **Notes on the slide**: ink linked to the slide (`Stroke.slide`), per page; and the ink in the margins of the slide's
 *   page (v6 margins, outside the background).
 * - **Questions**: question markers on the slide's page, next to ink linked to the slide, on its exercise page, or on a
 *   notes page linked only to that slide. Each question belongs to one slide.
 */
import { strokeBounds, type BBox } from "../ink/hit-test";
import { backgroundRect } from "./margins";
import { markerBounds } from "./markers";
import { GROUP_GAP, sameSource, slideInkGroups, slideTable, type SlideInkGroup } from "./slide-links";
import type { MarkerElement, NotebookDocument, Page, Stroke } from "./types";

/** A side-by-side link of this notebook: notes page `notesPage` belongs to page `page` of the PDF `source`. */
export interface StripLink {
	notesPage: string;
	source: string;
	page: number;
	path?: string;
}

export interface StripInk {
	/** 0-based page index. */
	page: number;
	strokes: number;
	bounds: BBox;
	/** "linked": written beside the slide (#226); "margin": in the margin of the slide's own page. */
	kind: "linked" | "margin";
}

export interface StripQuestion {
	page: number;
	id: string;
	text?: string;
	done: boolean;
}

export interface StripRow {
	source: string;
	/** 1-based page of the PDF. */
	page: number;
	path?: string;
	/** Index of the notebook page that shows this slide, or null. */
	slidePage: number | null;
	/** Indices of the notes pages linked to it, in page order. */
	notes: number[];
	/** Index of the exercise page after the slide's page, or null. */
	exercise: number | null;
	ink: StripInk[];
	/** Open questions first, then in page order. */
	questions: StripQuestion[];
}

export interface StripSection {
	source: string;
	path?: string;
	/** What to call the PDF: the asset's name, else the file name of the path, else null. */
	name: string | null;
	rows: StripRow[];
}

export interface StripInput {
	doc: NotebookDocument;
	links: readonly StripLink[];
	/** Only this PDF (the one beside the notes), or every PDF of the notebook. */
	only?: { source: string; path?: string } | null;
	/** The strokes the reader can see on a page (hidden ink left out); default: all of them. */
	visible?: (page: Page) => readonly Stroke[];
	/** Box of a stroke (cached by the caller); default: from its points. */
	boundsOf?: (s: Stroke) => BBox;
}

const keyOf = (source: string, page: number): string => `${source}#${page}`;

function baseName(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	const dot = file.lastIndexOf(".");
	return dot > 0 ? file.slice(0, dot) : file;
}

function overlaps(a: BBox, b: BBox, gap: number): boolean {
	return a.minX - gap <= b.maxX && b.minX - gap <= a.maxX && a.minY - gap <= b.maxY && b.minY - gap <= a.maxY;
}

/** The strip: one section per PDF (the PDF beside the notes first when given), its slides in page order. */
export function buildSlideStrip(input: StripInput): StripSection[] {
	const { doc } = input;
	const visible = input.visible ?? ((p: Page) => p.strokes);
	const boundsOf = input.boundsOf ?? strokeBounds;
	const rows = new Map<string, StripRow>();
	const order: string[] = [];
	const row = (source: string, page: number, path?: string): StripRow => {
		const key = keyOf(source, page);
		let r = rows.get(key);
		if (!r) {
			r = { source, page, slidePage: null, notes: [], exercise: null, ink: [], questions: [] };
			if (path) r.path = path;
			rows.set(key, r);
			order.push(key);
		} else if (!r.path && path) r.path = path;
		return r;
	};
	const wanted = (source: string, path?: string): boolean => !input.only || sameSource(input.only, { source, path });

	// Slide pages.
	doc.pages.forEach((p, i) => {
		const bg = p.background;
		if (bg?.kind !== "pdf" || !wanted(bg.asset)) return;
		const r = row(bg.asset, bg.page);
		if (r.slidePage === null) r.slidePage = i;
	});
	// Notes pages linked side by side.
	const indexOf = new Map(doc.pages.map((p, i) => [p.id, i]));
	const slidesOfNotes = new Map<number, Set<string>>();
	for (const l of input.links) {
		const i = indexOf.get(l.notesPage);
		if (i === undefined || !wanted(l.source, l.path)) continue;
		const r = row(l.source, l.page, l.path);
		if (!r.notes.includes(i)) r.notes.push(i);
		const set = slidesOfNotes.get(i) ?? new Set<string>();
		set.add(keyOf(r.source, r.page));
		slidesOfNotes.set(i, set);
	}
	// Ink written beside a slide, grouped per page.
	const table = slideTable(doc);
	const groupsOn = new Map<number, SlideInkGroup[]>();
	doc.pages.forEach((p, i) => {
		const strokes = visible(p);
		if (!strokes.some((s) => s.slide !== undefined)) return;
		const groups = slideInkGroups(table, strokes, GROUP_GAP, boundsOf).filter((g) => wanted(g.ref.source, g.ref.path));
		if (groups.length === 0) return;
		groupsOn.set(i, groups);
		const perSlide = new Map<string, StripInk>();
		for (const g of groups) {
			const r = row(g.ref.source, g.ref.page, g.ref.path);
			const key = keyOf(r.source, r.page);
			const ink = perSlide.get(key);
			if (!ink) {
				const entry: StripInk = { page: i, strokes: g.strokes, bounds: { ...g.bounds }, kind: "linked" };
				perSlide.set(key, entry);
				r.ink.push(entry);
			} else {
				ink.strokes += g.strokes;
				ink.bounds = {
					minX: Math.min(ink.bounds.minX, g.bounds.minX), minY: Math.min(ink.bounds.minY, g.bounds.minY),
					maxX: Math.max(ink.bounds.maxX, g.bounds.maxX), maxY: Math.max(ink.bounds.maxY, g.bounds.maxY),
				};
			}
		}
	});
	// Margins of the slide pages, the exercise page after each.
	const claimed = new Set<number>();
	for (const r of rows.values()) {
		if (r.slidePage !== null) claimed.add(r.slidePage);
		for (const n of r.notes) claimed.add(n);
	}
	for (const r of rows.values()) {
		const i = r.slidePage;
		if (i === null) continue;
		const page = doc.pages[i]!;
		if (page.margins) {
			const bg = backgroundRect(page);
			let n = 0;
			let box: BBox | null = null;
			for (const s of visible(page)) {
				if (s.slide !== undefined && table.has(s.slide)) continue; // counted as linked ink
				const b = boundsOf(s);
				const inside = b.minX >= bg.x && b.maxX <= bg.x + bg.width && b.minY >= bg.y && b.maxY <= bg.y + bg.height;
				if (inside) continue;
				n++;
				box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
			}
			if (n > 0 && box) r.ink.unshift({ page: i, strokes: n, bounds: box, kind: "margin" });
		}
		const next = doc.pages[i + 1];
		if (next && !next.background && !claimed.has(i + 1)) r.exercise = i + 1;
	}
	// Questions: each on one slide.
	const exerciseOf = new Map<number, string>();
	const slideOfPage = new Map<number, string>();
	for (const [key, r] of rows) {
		if (r.exercise !== null) exerciseOf.set(r.exercise, key);
		if (r.slidePage !== null && !slideOfPage.has(r.slidePage)) slideOfPage.set(r.slidePage, key);
	}
	doc.pages.forEach((p, i) => {
		for (const el of p.elements ?? []) {
			if (el.type !== "marker" || el.kind !== "question") continue;
			const key = questionSlide(el, i, slideOfPage, groupsOn.get(i) ?? [], exerciseOf, slidesOfNotes);
			const r = key ? rows.get(key) : undefined;
			if (!r) continue;
			const q: StripQuestion = { page: i, id: el.id, done: !!el.done };
			if (el.text) q.text = el.text;
			r.questions.push(q);
		}
	});
	for (const r of rows.values()) {
		r.notes.sort((a, b) => a - b);
		r.ink.sort((a, b) => a.page - b.page || (a.kind === b.kind ? 0 : a.kind === "margin" ? -1 : 1));
		r.questions.sort((a, b) => Number(a.done) - Number(b.done) || a.page - b.page);
	}

	// Sections: the PDF beside the notes first, then in order of first appearance; slides in page order.
	const sections: StripSection[] = [];
	for (const key of order) {
		const r = rows.get(key)!;
		let section = sections.find((s) => sameSource(s, r));
		if (!section) {
			const asset = doc.assets?.[r.source];
			const name = asset?.name ? baseName(asset.name) : r.path ? baseName(r.path) : null;
			section = { source: r.source, name, rows: [] };
			if (r.path) section.path = r.path;
			sections.push(section);
		}
		section.rows.push(r);
	}
	for (const s of sections) s.rows.sort((a, b) => a.page - b.page);
	return sections;
}

/** Which slide (row key) a question belongs to, or null. */
function questionSlide(
	m: MarkerElement, page: number, slideOfPage: ReadonlyMap<number, string>, groups: readonly SlideInkGroup[],
	exerciseOf: ReadonlyMap<number, string>, slidesOfNotes: ReadonlyMap<number, ReadonlySet<string>>,
): string | null {
	const onSlide = slideOfPage.get(page);
	if (onSlide) return onSlide;
	const box = markerBounds(m);
	let best: { key: string; d: number } | null = null;
	for (const g of groups) {
		if (!overlaps(g.bounds, box, GROUP_GAP)) continue;
		const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
		const dx = Math.max(g.bounds.minX - cx, 0, cx - g.bounds.maxX);
		const dy = Math.max(g.bounds.minY - cy, 0, cy - g.bounds.maxY);
		const d = Math.hypot(dx, dy);
		if (!best || d < best.d) best = { key: keyOf(g.ref.source, g.ref.page), d };
	}
	if (best) return best.key;
	const exercise = exerciseOf.get(page);
	if (exercise) return exercise;
	const linked = slidesOfNotes.get(page);
	if (linked && linked.size === 1) return [...linked][0]!;
	return null;
}

/** Whether a row has anything beyond the slide itself (the strip shows bare slides too, but dimmed). */
export function rowHasNotes(r: StripRow): boolean {
	return r.notes.length > 0 || r.exercise !== null || r.ink.length > 0 || r.questions.length > 0;
}
