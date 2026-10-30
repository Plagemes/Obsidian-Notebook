/**
 * v8 markers (#201 gaps, #202 questions, #203 importance, #209 homework), structured boxes (#204) and invisible
 * ink (#100): pure helpers shared by the format, the view, the companion note and the end-of-lecture panel.
 * No 'obsidian', no canvas. Elements are immutable: every change returns a new (frozen) element.
 */
import { createId } from "./document";
import {
	BOX_KINDS, MARKER_KINDS, MARKER_TEXT_MAX,
	type BoxElement, type BoxKind, type MarkerElement, type MarkerKind, type NotebookDocument, type Page, type PageElement, type Stroke,
} from "./types";

/** Side of a marker badge, pt (about 5 mm: easy to hit with a finger at 100 %, small next to handwriting). */
export const MARKER_BADGE = 14;
/** Height of a box's label tab, pt. */
export const BOX_LABEL_HEIGHT = 12;
/** Smallest box or marker region side, pt: anything smaller is a tap. */
export const MIN_MARKER_REGION = 4;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function isMarker(e: PageElement): e is MarkerElement {
	return e.type === "marker";
}

export function isBox(e: PageElement): e is BoxElement {
	return e.type === "box";
}

export function isMarkerKind(v: unknown): v is MarkerKind {
	return typeof v === "string" && (MARKER_KINDS as readonly string[]).includes(v);
}

export function isBoxKind(v: unknown): v is BoxKind {
	return typeof v === "string" && (BOX_KINDS as readonly string[]).includes(v);
}

/** Kinds whose marker can be resolved (a tap toggles `done`). Importance markers have no state. */
export function isResolvable(kind: MarkerKind): boolean {
	return kind === "gap" || kind === "question" || kind === "homework";
}

/** Importance markers cycle with a tap: ! → !! → ★ → !. */
export function nextImportance(kind: MarkerKind): MarkerKind | null {
	if (kind === "important") return "critical";
	if (kind === "critical") return "star";
	if (kind === "star") return "important";
	return null;
}

/** A label or title as one trimmed line (runs of whitespace collapse), at most MARKER_TEXT_MAX characters; undefined when empty. */
export function cleanMarkerText(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const chars = Array.from(raw.replace(/\s+/g, " ").trim());
	const out = (chars.length > MARKER_TEXT_MAX ? chars.slice(0, MARKER_TEXT_MAX).join("") : chars.join("")).trim();
	return out.length > 0 ? out : undefined;
}

/** True for a real calendar date written `YYYY-MM-DD` (the Tasks plugin's due date format). */
export function isIsoDate(v: unknown): v is string {
	if (typeof v !== "string") return false;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
	if (!m) return false;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const d = new Date(Date.UTC(year, month - 1, day));
	return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A rectangle from two corners, rounded like the file (0.01 pt). */
export function rectFrom(a: readonly [number, number], b: readonly [number, number]): Rect {
	const x = Math.min(a[0], b[0]);
	const y = Math.min(a[1], b[1]);
	return { x: round2(x), y: round2(y), width: round2(Math.abs(b[0] - a[0])), height: round2(Math.abs(b[1] - a[1])) };
}

/** Whether a dragged rectangle is a real region (not a tap). */
export function isRegion(r: Rect): boolean {
	return r.width >= MIN_MARKER_REGION && r.height >= MIN_MARKER_REGION;
}

/** The badge square of a marker (page coordinates). */
export function markerBadge(m: MarkerElement): Rect {
	return { x: m.x, y: m.y, width: MARKER_BADGE, height: MARKER_BADGE };
}

/** The region a marker is about, or null for a point marker. */
export function markerRegion(m: MarkerElement): Rect | null {
	return m.width !== undefined && m.height !== undefined ? { x: m.x, y: m.y, width: m.width, height: m.height } : null;
}

export interface Box4 {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Axis-aligned box of a marker: its badge and its region. */
export function markerBounds(m: MarkerElement): Box4 {
	const r = markerRegion(m);
	return {
		minX: m.x,
		minY: m.y,
		maxX: Math.max(m.x + MARKER_BADGE, r ? m.x + r.width : -Infinity),
		maxY: Math.max(m.y + MARKER_BADGE, r ? m.y + r.height : -Infinity),
	};
}

/** Axis-aligned box of a structured box: its frame and the label tab above it. */
export function boxBounds(b: BoxElement): Box4 {
	return { minX: b.x, minY: b.y - BOX_LABEL_HEIGHT, maxX: b.x + b.width, maxY: b.y + b.height };
}

/** Whether (x, y) is on the marker's badge, with `tolerance` pt around it (what a tap toggles). */
export function hitsBadge(m: MarkerElement, x: number, y: number, tolerance = 0): boolean {
	return x >= m.x - tolerance && x <= m.x + MARKER_BADGE + tolerance && y >= m.y - tolerance && y <= m.y + MARKER_BADGE + tolerance;
}

/** Whether (x, y) is on the box's label tab (what a tap edits). */
export function hitsBoxLabel(b: BoxElement, x: number, y: number, tolerance = 0): boolean {
	const w = Math.min(b.width, 140);
	return x >= b.x - tolerance && x <= b.x + w + tolerance && y >= b.y - BOX_LABEL_HEIGHT - tolerance && y <= b.y + tolerance;
}

/** Topmost marker badge under (x, y), else the topmost box label; null when there is none. */
export function markerAt(elements: readonly PageElement[], x: number, y: number, tolerance = 0): MarkerElement | BoxElement | null {
	for (let i = elements.length - 1; i >= 0; i--) {
		const e = elements[i]!;
		if (e.type === "marker" && hitsBadge(e, x, y, tolerance)) return e;
	}
	for (let i = elements.length - 1; i >= 0; i--) {
		const e = elements[i]!;
		if (e.type === "box" && hitsBoxLabel(e, x, y, tolerance)) return e;
	}
	return null;
}

export interface NewMarker {
	/** The region the marker is about; its badge goes on the region's top-left corner. */
	region?: Rect | null;
	at?: string;
	slide?: number | null;
	due?: string | null;
	text?: string | null;
}

/** A new marker with its badge centred on (x, y), or on the top-left corner of `region`. */
export function createMarker(kind: MarkerKind, x: number, y: number, options: NewMarker = {}): MarkerElement {
	const r = options.region && isRegion(options.region) ? options.region : null;
	const m: MarkerElement = r
		? { id: createId(), type: "marker", kind, x: round2(r.x), y: round2(r.y), width: round2(r.width), height: round2(r.height) }
		: { id: createId(), type: "marker", kind, x: round2(x - MARKER_BADGE / 2), y: round2(y - MARKER_BADGE / 2) };
	if (options.at) m.at = options.at;
	if (options.slide != null && Number.isSafeInteger(options.slide) && options.slide >= 1) m.slide = options.slide;
	if (isIsoDate(options.due)) m.due = options.due;
	const text = cleanMarkerText(options.text);
	if (text) m.text = text;
	return Object.freeze(m);
}

/** A new structured box around `rect`. */
export function createBox(kind: BoxKind, rect: Rect, title?: string | null): BoxElement {
	const b: BoxElement = { id: createId(), type: "box", kind, x: round2(rect.x), y: round2(rect.y), width: round2(rect.width), height: round2(rect.height) };
	const t = cleanMarkerText(title);
	if (t) b.title = t;
	return Object.freeze(b);
}

/** The same marker resolved or not (same id). */
export function withDone(m: MarkerElement, done: boolean): MarkerElement {
	const out: MarkerElement = { ...m };
	if (done) out.done = true;
	else delete out.done;
	return Object.freeze(out);
}

export interface MarkerEdit {
	kind?: MarkerKind;
	text?: string | null;
	due?: string | null;
	done?: boolean;
}

/** The same marker with some fields changed (same id); `null` clears a field. */
export function editMarker(m: MarkerElement, edit: MarkerEdit): MarkerElement {
	const out: MarkerElement = { ...m, kind: edit.kind ?? m.kind };
	if (edit.text !== undefined) {
		const t = cleanMarkerText(edit.text);
		if (t) out.text = t;
		else delete out.text;
	}
	if (edit.due !== undefined) {
		if (isIsoDate(edit.due)) out.due = edit.due;
		else delete out.due;
	}
	if (edit.done !== undefined) {
		if (edit.done) out.done = true;
		else delete out.done;
	}
	return Object.freeze(out);
}

/** The same box with another kind and/or title (same id). */
export function editBox(b: BoxElement, kind: BoxKind, title: string | null): BoxElement {
	const out: BoxElement = { ...b, kind };
	const t = cleanMarkerText(title);
	if (t) out.title = t;
	else delete out.title;
	return Object.freeze(out);
}

/** What a tap on a badge does: resolvable markers toggle `done`, importance markers cycle; null for homework (edited in a dialog). */
export function tapMarker(m: MarkerElement): MarkerElement | null {
	if (m.kind === "homework") return null;
	if (isResolvable(m.kind)) return withDone(m, !m.done);
	const next = nextImportance(m.kind);
	return next ? Object.freeze({ ...m, kind: next }) : null;
}

// ------------------------------------------------------------------ lists (end-of-lecture panel)

export interface MarkerEntry {
	pageIndex: number;
	pageId: string;
	element: MarkerElement | BoxElement;
}

/** Text of a lecture header ("Course — 2026-10-29" or just the date), as written by "New lecture". */
const LECTURE_HEADER = /^(?:.+ — )?\d{4}-\d{2}-\d{2}$/;

/** Whether a page starts a lecture (it carries a lecture header text box). */
export function startsLecture(page: Page): boolean {
	return (page.elements ?? []).some((e) => e.type === "text" && LECTURE_HEADER.test(e.text.trim()));
}

/**
 * Pages of the lecture that contains page `index`: from the closest page at or before it that carries a
 * lecture header, up to the next such page (excluded). Without any header before it: from the first page.
 */
export function lectureRange(pages: readonly Page[], index: number): { from: number; to: number } {
	const at = Math.max(0, Math.min(pages.length - 1, index));
	let from = 0;
	for (let i = at; i >= 0; i--) {
		if (startsLecture(pages[i]!)) {
			from = i;
			break;
		}
	}
	let to = pages.length;
	for (let i = at + 1; i < pages.length; i++) {
		if (startsLecture(pages[i]!)) {
			to = i;
			break;
		}
	}
	return { from, to };
}

/** Markers and boxes of pages `from` ≤ i < `to`, in reading order (page, then top to bottom, then left to right). */
export function collectMarkers(doc: NotebookDocument, range: { from: number; to: number } = { from: 0, to: Infinity }): MarkerEntry[] {
	const out: MarkerEntry[] = [];
	const to = Math.min(range.to, doc.pages.length);
	for (let i = Math.max(0, range.from); i < to; i++) {
		const page = doc.pages[i]!;
		const items = (page.elements ?? []).filter((e): e is MarkerElement | BoxElement => e.type === "marker" || e.type === "box");
		items.sort((a, b) => a.y - b.y || a.x - b.x);
		for (const element of items) out.push({ pageIndex: i, pageId: page.id, element });
	}
	return out;
}

export interface MarkerGroups {
	questions: MarkerEntry[];
	gaps: MarkerEntry[];
	homework: MarkerEntry[];
	importance: MarkerEntry[];
	boxes: MarkerEntry[];
}

/** The panel's sections. Open items first within questions, gaps and homework (resolved ones after them); homework by due date. */
export function groupMarkers(entries: readonly MarkerEntry[]): MarkerGroups {
	const g: MarkerGroups = { questions: [], gaps: [], homework: [], importance: [], boxes: [] };
	for (const e of entries) {
		const el = e.element;
		if (el.type === "box") g.boxes.push(e);
		else if (el.kind === "question") g.questions.push(e);
		else if (el.kind === "gap") g.gaps.push(e);
		else if (el.kind === "homework") g.homework.push(e);
		else g.importance.push(e);
	}
	const doneLast = (a: MarkerEntry, b: MarkerEntry) => Number(!!(a.element as MarkerElement).done) - Number(!!(b.element as MarkerElement).done);
	g.questions.sort(doneLast);
	g.gaps.sort(doneLast);
	g.homework.sort((a, b) => doneLast(a, b) || dueKey(a).localeCompare(dueKey(b)));
	return g;
}

function dueKey(e: MarkerEntry): string {
	return (e.element as MarkerElement).due ?? "9999-99-99";
}

/** Open (unresolved) questions, gaps and homework among `entries`. */
export function openCount(entries: readonly MarkerEntry[]): number {
	return entries.filter((e) => e.element.type === "marker" && isResolvable(e.element.kind) && !e.element.done).length;
}

// ------------------------------------------------------------------ invisible ink

/** Whether any page has hidden ink. */
export function hasHiddenInk(doc: Pick<NotebookDocument, "pages">): boolean {
	return doc.pages.some((p) => p.strokes.some((s) => s.hidden));
}

/** The page without its hidden strokes (the same object when it has none). For exports that leave the solutions out. */
export function withoutHiddenInk(page: Page): Page {
	return page.strokes.some((s) => s.hidden) ? { ...page, strokes: page.strokes.filter((s) => !s.hidden) } : page;
}

/** The strokes a reader sees on `page`: all of them when the solutions are shown, else the ones that are not hidden. */
export function visibleStrokes(strokes: readonly Stroke[], revealed: boolean): readonly Stroke[] {
	return revealed || !strokes.some((s) => s.hidden) ? strokes : strokes.filter((s) => !s.hidden);
}
