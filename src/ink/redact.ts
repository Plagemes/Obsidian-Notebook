/**
 * 0.26 redact (#285): redaction before export. Pure: no 'obsidian', no DOM, no format change. `redactPage` builds a COPY of a page in
 * which everything that lies under the redaction boxes is really gone, and in which the boxes are drawn as solid black rectangles on top
 * of everything. The document is never touched, and because every export writer draws the page it is given, every export (PDF, SVG, the
 * interactive HTML, PNG, print, the written-area picture, copy as image, the hand-in PDF, the share sheet, the Markdown pages) leaves the
 * covered content out without a line of change in the writers. What is not a vector in the copy is handled by the two raster paths that
 * need it: a PDF page or picture used as the page background is burned in with the boxes before it is encoded (`burnPixelRects`).
 *
 * What happens to each part of a page (the rules the tests pin):
 * - ink is CUT: the parts of a stroke outside the boxes stay (as new strokes of their own), the parts inside, and a pen-width margin around
 *   the box (the largest radius the engine can draw for that stroke, so the thickness of the line never shows under the edge), are removed
 *   from the data. A closed shape with a fill that touches a box is dropped whole.
 * - elements (text, pictures, equations, graphs, boxes, sticky notes, markers, checkboxes, excerpts) whose area touches a box are dropped
 *   WHOLE, including their text, source and picture: a text box that is half under a box does not leave its other half behind. The area of
 *   a text box is measured pessimistically (`redactBounds`). The area highlighter holds no content, so it is cut like a rectangle minus the box.
 * - an excerpt whose SOURCE region a box touches is dropped on whatever page shows it (its snapshot is the covered pixels); a checkbox whose
 *   handwritten label a box touches loses its typed label.
 * - ink that the dropped graph clipped to its frame goes with it; ink a collapsed sticky note hides is never drawn by an export and is left out.
 * - margin comments anchored on a box are dropped with their replies; the automatic header or footer is dropped on a page whose box covers it.
 * - the page's tags and its states are not drawn by any export and are removed from the copy.
 */
import { hiddenStickyInk } from "../model/sticky";
import { EQUATION_NUMBER_GAP } from "../model/math-elements";
import { backgroundRect } from "../model/margins";
import { isCheckbox } from "../model/checklist";
import { pageCopy } from "../model/states";
import { rectsOverlap, type RedactBox, type Redactions, boxesOf } from "../model/redact";
import { RENDER_INK, type AreaElement, type ExcerptElement, type NotebookMeta, type Page, type PageComment, type PageElement, type Point, type Stroke } from "../model/types";
import { boundGraphId } from "./attach";
import { checkboxLabelBounds } from "./checklist";
import { elementBounds } from "./elements";
import { inkReach, inkRadius } from "./ink-geometry";
import { LINE_HEIGHT, layoutText, estimateMeasure } from "./text-layout";
import { shownText } from "./wikilink";
import type { HeaderLayout } from "./page-header";
import { isFilled } from "./shape-style";
import type { BBox } from "./hit-test";

/** Ids of the strokes that draw the boxes start with this (a page id never starts a stroke id). */
const BOX_ID_PREFIX = "redact-";
/** Distance (pt) of the two extra points near each corner of a box's outline. */
const CORNER_EASE = 0.4;
/** The colour of a redaction box. */
export const REDACT_COLOR = "#000000";
/** Pt added around an element's area before it is tested against a box (the writers draw a little beyond the stored geometry). */
const ELEMENT_PAD = 3;
/** Pt added to the reach of a pen around a box: ink within it is cut as well, so no thickness of a line shows under the edge. */
const INK_PAD = 1;
/** Pixels added on every side of a burned rectangle (the JPEG of a background smears a little past an edge). */
const BURN_PAD_PX = 2;

const REDACTED = Symbol("notebook.redacted");
type Redacted = Page & { [REDACTED]?: readonly RedactBox[] };

/** The boxes a copy made by `redactPage` carries (none for any other page): the raster paths burn them into the background. */
export function redactionOf(page: Page): readonly RedactBox[] {
	return (page as Redacted)[REDACTED] ?? [];
}

const sameBoxes = (a: readonly RedactBox[], b: readonly RedactBox[]): boolean =>
	a.length === b.length && a.every((x, i) => x.x === b[i]!.x && x.y === b[i]!.y && x.width === b[i]!.width && x.height === b[i]!.height);

const toBBox = (b: RedactBox, grow = 0): BBox => ({ minX: b.x - grow, minY: b.y - grow, maxX: b.x + b.width + grow, maxY: b.y + b.height + grow });

function overlaps(a: BBox, boxes: readonly RedactBox[], grow = 0): boolean {
	return boxes.some((b) => a.minX < b.x + b.width + grow && b.x - grow < a.maxX && a.minY < b.y + b.height + grow && b.y - grow < a.maxY);
}

/** A conservative width for wrapping: wider letters make more lines, so the area is never smaller than any writer's. */
const wideMeasure = (s: string, fontSize: number): number => Array.from(s).length * fontSize * 0.66;

/** The widest a character can be in the export font (em): a CJK or full-width character, an emoji or a symbol. */
const WIDEST_EM = 1.5;

/**
 * A width (em) no glyph of the sans-serif fonts the writers use is wider than, by character: the widest Latin capitals and `m`, `w`,
 * `@`, `%`, `&` are under 1 em; other ASCII under 0.8 em; other alphabets under 1 em; CJK, full-width forms, emoji and symbols (anything
 * from U+1100 on, and every character outside the basic plane) under 1.5 em.
 */
function charEm(ch: string): number {
	const c = ch.codePointAt(0) ?? 0;
	if (c < 0x80) return /[A-Z@%&mw]/.test(ch) ? 1 : 0.8;
	if (c < 0x1100) return 1;
	return WIDEST_EM;
}

/** A width for wrapping that is never smaller than the canvas, SVG or PDF one (so the lines are never fewer than on the page). */
export function pessimisticMeasure(s: string, fontSize: number): number {
	let em = 0;
	for (const ch of s) em += charEm(ch);
	return em * fontSize;
}

/**
 * The area an element can cover in any writer, grown a little: an equation also reaches its number, a note its shadow. Review fix (P1):
 * a text box is wrapped with a width per character that no real glyph exceeds (`pessimisticMeasure`), so wide text (CJK, emoji, capitals)
 * never covers more lines on the page than the area says; the tallest of that and the other estimates wins, and a single character wider
 * than the box widens the area.
 */
export function redactBounds(el: PageElement): BBox {
	let b: BBox;
	if (el.type === "text") {
		const text = shownText(el.text).text;
		const a = layoutText(text, el.fontSize, el.width, (s) => estimateMeasure(s, el.fontSize)).height;
		const c = layoutText(text, el.fontSize, el.width, (s) => wideMeasure(s, el.fontSize)).height;
		const p = layoutText(text, el.fontSize, el.width, (s) => pessimisticMeasure(s, el.fontSize)).height;
		b = { minX: el.x, minY: el.y, maxX: el.x + Math.max(el.width, WIDEST_EM * el.fontSize), maxY: el.y + Math.max(a, c, p, LINE_HEIGHT * el.fontSize) };
	} else if (el.type === "equation") {
		const base = elementBounds(el);
		b = el.numbered === true ? { ...base, maxX: base.maxX + el.fontSize * (EQUATION_NUMBER_GAP + 6) } : base;
	} else if (el.type === "sticky") {
		const base = elementBounds(el);
		b = { ...base, maxX: base.maxX + 6, maxY: base.maxY + 6 };
	} else b = elementBounds(el);
	return { minX: b.minX - ELEMENT_PAD, minY: b.minY - ELEMENT_PAD, maxX: b.maxX + ELEMENT_PAD, maxY: b.maxY + ELEMENT_PAD };
}

// ---------------------------------------------------------------------------------------------------------------------- ink

const EPS = 1e-9;

/** The part [t0, t1] of the segment (a to b) inside the closed box, or null (Liang–Barsky). */
function clipSegment(ax: number, ay: number, bx: number, by: number, z: BBox): [number, number] | null {
	const dx = bx - ax;
	const dy = by - ay;
	let t0 = 0;
	let t1 = 1;
	const edges: ReadonlyArray<readonly [number, number]> = [[-dx, ax - z.minX], [dx, z.maxX - ax], [-dy, ay - z.minY], [dy, z.maxY - ay]];
	for (const [p, q] of edges) {
		if (p === 0) {
			if (q < 0) return null;
			continue;
		}
		const r = q / p;
		if (p < 0) {
			if (r > t1) return null;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return null;
			if (r < t1) t1 = r;
		}
	}
	return t0 <= t1 ? [t0, t1] : null;
}

const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The runs of `points` that lie outside every zone, cut exactly where the line crosses a zone's edge. */
export function outsideRuns(points: readonly Point[], zones: readonly BBox[]): Point[][] {
	const runs: Point[][] = [];
	let cur: Point[] = [];
	const flush = (): void => {
		if (cur.length > 0) runs.push(cur);
		cur = [];
	};
	const insidePoint = (p: Point): boolean => zones.some((z) => p[0] >= z.minX && p[0] <= z.maxX && p[1] >= z.minY && p[1] <= z.maxY);
	if (points.length === 0) return runs;
	if (!insidePoint(points[0]!)) cur.push(points[0]!);
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!;
		const b = points[i]!;
		// The parts of the segment inside any zone, merged.
		const inside: Array<[number, number]> = [];
		for (const z of zones) {
			const hit = clipSegment(a[0], a[1], b[0], b[1], z);
			if (hit) inside.push(hit);
		}
		inside.sort((p, q) => p[0] - q[0]);
		const merged: Array<[number, number]> = [];
		for (const iv of inside) {
			const last = merged[merged.length - 1];
			if (last && iv[0] <= last[1] + EPS) last[1] = Math.max(last[1], iv[1]);
			else merged.push([iv[0], iv[1]]);
		}
		let t = 0;
		for (const [s, e] of merged) {
			if (s > t + EPS) {
				if (cur.length === 0) cur.push(lerp(a, b, t));
				cur.push(lerp(a, b, s));
			}
			flush();
			t = Math.max(t, e);
		}
		if (t < 1 - EPS) {
			if (cur.length === 0) cur.push(lerp(a, b, t));
			cur.push(b);
		}
	}
	flush();
	return runs;
}

/** Whether a run is more than a speck (a run cut off at a box edge by a line that merely grazed it is not kept). */
function isLine(run: readonly Point[]): boolean {
	if (run.length < 2) return false;
	let len = 0;
	for (let i = 1; i < run.length; i++) len += Math.hypot(run[i]![0] - run[i - 1]![0], run[i]![1] - run[i - 1]![1]);
	return len > 0.05;
}

/**
 * Review fix (P8): the largest radius the engine can draw for any point of `stroke` (pt), from its tool, width and the highest pressure
 * it holds (never less than full pressure, which a simulated pressure can reach): the pen draws up to 0.8 of its width, the fountain pen
 * up to 0.65, the brush up to 0.8 (`inkReach` for the other tools: half the width).
 */
export function redactReach(stroke: Pick<Stroke, "tool" | "width" | "points">): number {
	let p = 1;
	for (const pt of stroke.points) if (Number.isFinite(pt[2]) && pt[2] > p) p = pt[2];
	const half = stroke.width / 2;
	let r = inkReach(stroke.tool, stroke.width);
	if (stroke.tool === "pen") r = Math.max(r, inkRadius("pen", stroke.width, p));
	else if (stroke.tool === "fountain") r = Math.max(r, half * (0.7 + 0.6 * p));
	else if (stroke.tool === "brush") r = Math.max(r, inkReach("brush", stroke.width) * (0.08 + 0.92 * Math.pow(p, 1.4)));
	return r;
}

/**
 * What is left of `stroke` once the boxes are removed: the stroke itself when no box reaches it, otherwise the pieces of its line outside
 * the boxes (each a stroke of its own, the first with the id of the stroke, the others `<id>.r1`, `<id>.r2`…; the style is kept). A filled
 * shape that a box reaches is dropped whole (cutting the line would leave a fill with no outline).
 */
export function cutStroke(stroke: Stroke, boxes: readonly RedactBox[]): Stroke[] {
	if (stroke.points.length === 0) return [stroke];
	const reach = redactReach(stroke) + INK_PAD;
	const zones = boxes.map((b) => toBBox(b, reach));
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of stroke.points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	const bounds: BBox = { minX, minY, maxX, maxY };
	if (!zones.some((z) => bounds.minX <= z.maxX && z.minX <= bounds.maxX && bounds.minY <= z.maxY && z.minY <= bounds.maxY)) return [stroke];
	if (isFilled(stroke)) return [];
	if (stroke.points.length === 1) {
		const p = stroke.points[0]!;
		return zones.some((z) => p[0] >= z.minX && p[0] <= z.maxX && p[1] >= z.minY && p[1] <= z.maxY) ? [] : [stroke];
	}
	const runs = outsideRuns(stroke.points, zones);
	// Nothing was cut: the line never enters a zone.
	if (runs.length === 1 && runs[0]!.length === stroke.points.length && runs[0]!.every((p, i) => p === stroke.points[i])) return [stroke];
	const pieces: Stroke[] = [];
	for (const run of runs) {
		if (!isLine(run)) continue;
		const { fill: _fill, fillTint: _tint, ...rest } = stroke;
		void _fill;
		void _tint;
		pieces.push({ ...rest, id: pieces.length === 0 ? stroke.id : `${stroke.id}.r${pieces.length}`, points: run });
	}
	return pieces;
}

// ---------------------------------------------------------------------------------------------------------------------- area highlighter

/** The part of rectangle `r` left after `box` is taken out: up to four rectangles. */
function subtractBox(r: BBox, box: RedactBox): BBox[] {
	const b = toBBox(box);
	if (!(r.minX < b.maxX && b.minX < r.maxX && r.minY < b.maxY && b.minY < r.maxY)) return [r];
	const out: BBox[] = [];
	if (b.minY > r.minY) out.push({ minX: r.minX, minY: r.minY, maxX: r.maxX, maxY: b.minY });
	if (b.maxY < r.maxY) out.push({ minX: r.minX, minY: b.maxY, maxX: r.maxX, maxY: r.maxY });
	const top = Math.max(r.minY, b.minY);
	const bottom = Math.min(r.maxY, b.maxY);
	if (b.minX > r.minX) out.push({ minX: r.minX, minY: top, maxX: b.minX, maxY: bottom });
	if (b.maxX < r.maxX) out.push({ minX: b.maxX, minY: top, maxX: r.maxX, maxY: bottom });
	return out;
}

function cutArea(el: AreaElement, boxes: readonly RedactBox[]): AreaElement[] {
	let parts: BBox[] = [{ minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height }];
	for (const box of boxes) parts = parts.flatMap((p) => subtractBox(p, box));
	if (parts.length === 1 && parts[0]!.minX === el.x && parts[0]!.minY === el.y && parts[0]!.maxX === el.x + el.width && parts[0]!.maxY === el.y + el.height) return [el];
	const out: AreaElement[] = [];
	for (const p of parts) {
		const width = p.maxX - p.minX;
		const height = p.maxY - p.minY;
		if (width < 0.5 || height < 0.5) continue;
		const { group: _group, locked: _locked, lockAt: _lockAt, ...rest } = el;
		void _group;
		void _locked;
		void _lockAt;
		out.push({ ...rest, id: out.length === 0 ? el.id : `${el.id}.r${out.length}`, x: p.minX, y: p.minY, width, height });
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------------- the page

/** The solid black rectangle of a box as a stroke the writers already draw (a closed shape with a solid fill). Never saved: copies only. */
function boxStroke(page: Page, box: RedactBox, n: number): Stroke {
	const x0 = box.x;
	const y0 = box.y;
	const x1 = box.x + box.width;
	const y1 = box.y + box.height;
	const corners: ReadonlyArray<readonly [number, number]> = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
	// The line of a shape is drawn through its points as a smooth curve: two extra points close to each corner keep the corners sharp, so
	// the outline stays on the rectangle instead of bulging past it.
	const points: Point[] = [];
	for (let i = 0; i < corners.length - 1; i++) {
		const [ax, ay] = corners[i]!;
		const [bx, by] = corners[i + 1]!;
		const len = Math.hypot(bx - ax, by - ay);
		const k = Math.min(CORNER_EASE, len / 3) / len;
		points.push([ax, ay, 0.5], [ax + (bx - ax) * k, ay + (by - ay) * k, 0.5], [bx - (bx - ax) * k, by - (by - ay) * k, 0.5]);
	}
	points.push([x0, y0, 0.5]);
	return { id: `${BOX_ID_PREFIX}${page.id}-${n}`, tool: "shape", color: REDACT_COLOR, width: 1, render: RENDER_INK, fill: REDACT_COLOR, points };
}

/** Comments with the ones anchored on a box (and the replies of those) taken out. */
function keptComments(comments: readonly PageComment[], boxes: readonly RedactBox[]): PageComment[] {
	const gone = new Set<string>();
	for (const c of comments) {
		if (!("region" in c)) continue;
		if (boxes.some((b) => rectsOverlap(c.region, b))) gone.add(c.id);
	}
	return comments.filter((c) => !gone.has(c.id) && !("parent" in c && gone.has(c.parent)));
}

/**
 * A copy of `page` for an export: everything under `boxes` removed (see the file comment), the boxes drawn as solid black rectangles on top
 * of all. `page` itself when there are no boxes; a page already redacted with these boxes is returned as it is, one redacted with other
 * boxes is redacted again with both. Never changes `page` or anything it holds.
 */
export function redactPage(page: Page, boxes: readonly RedactBox[], notebook?: Redactions): Page {
	const elements = page.elements ?? [];
	if (boxes.length === 0) {
		// Review fix (P2): a page without boxes can still show an excerpt of a region another page covers.
		if (!elements.some((el) => coveredExcerpt(el, notebook))) return page;
		const next = pageCopy(page);
		const kept = elements.filter((el) => !coveredExcerpt(el, notebook));
		if (kept.length > 0) next.elements = kept;
		else delete next.elements;
		return next;
	}
	const have = redactionOf(page);
	if (sameBoxes(have, boxes) && !elements.some((el) => coveredExcerpt(el, notebook))) return page;
	const all = have.length > 0 ? [...have, ...boxes.filter((b) => !have.some((h) => sameBoxes([h], [b])))] : boxes;
	const never = hiddenStickyInk(elements);
	const checkboxes = elements.filter(isCheckbox);
	const goneGraphs = new Set<string>();
	const keptEls: PageElement[] = [];
	for (const el of elements) {
		if (el.type === "area") {
			keptEls.push(...cutArea(el, all));
			continue;
		}
		if (overlaps(redactBounds(el), all) || coveredExcerpt(el, notebook)) {
			if (el.type === "graph") goneGraphs.add(el.id);
			continue;
		}
		// Review fix (P13): the typed label of a checkbox whose handwritten label (the ink on its row, to its right) a box touches is
		// left out: it can say what the handwriting says.
		if (el.type === "checkbox" && el.label !== undefined && overlaps(checkboxLabelBounds(el, page.strokes, checkboxes), all, ELEMENT_PAD)) {
			const { label: _label, ...rest } = el;
			void _label;
			keptEls.push(rest);
			continue;
		}
		keptEls.push(el);
	}
	const strokes: Stroke[] = [];
	for (const s of page.strokes) {
		// The boxes an earlier pass drew are drawn again below, with the new ones.
		if (s.id.startsWith(BOX_ID_PREFIX) || never?.has(s.id)) continue;
		const graph = boundGraphId(s);
		if (graph !== null && goneGraphs.has(graph)) continue;
		strokes.push(...cutStroke(s, all));
	}
	all.forEach((b, i) => strokes.push(boxStroke(page, b, i)));
	// Review fix (P3): `pageCopy`, not a spread: the live view of a page with states holds its id, size and background in its prototype.
	const next: Redacted = pageCopy(page);
	next.strokes = strokes;
	if (keptEls.length > 0) next.elements = keptEls;
	else delete next.elements;
	if (page.comments) {
		const comments = keptComments(page.comments, all);
		if (comments.length > 0) next.comments = comments;
		else delete next.comments;
	}
	delete next.tags;
	delete next.states;
	next[REDACTED] = all;
	return next;
}

/**
 * `redactPage` over a list; each page gets the boxes the set holds for its id, and loses the excerpts of covered regions (a page that
 * needs nothing is the same object).
 */
export function redactPages(pages: readonly Page[], redactions: Redactions | undefined): Page[] {
	return pages.map((p) => redactPage(p, boxesOf(redactions, p.id), redactions));
}

/** Whether any of the pages has boxes in the set, or shows an excerpt of a region a box covers. */
export function hasRedactions(pages: readonly Page[], redactions: Redactions | undefined): boolean {
	return !!redactions && pages.some((p) => boxesOf(redactions, p.id).length > 0 || (p.elements ?? []).some((el) => coveredExcerpt(el, redactions)));
}

/**
 * Review fix (P2): whether `el` is an excerpt whose source region a box of the set touches. Its snapshot is the pixels of that region, so
 * an export leaves the whole excerpt out (the page it shows it on may have no box at all). Matched by the source page id, which is unique.
 */
export function coveredExcerpt(el: PageElement, redactions: Redactions | undefined): boolean {
	if (el.type !== "excerpt" || !redactions) return false;
	const s: ExcerptElement["source"] = el.source;
	const area: BBox = { minX: s.x, minY: s.y, maxX: s.x + s.width, maxY: s.y + s.height };
	return overlaps(area, boxesOf(redactions, s.page), ELEMENT_PAD);
}

/** The header or footer of a page, or null when a box covers it (its text could be what the reader wants out). */
export function headerAfterRedaction(header: HeaderLayout | null, page: Page): HeaderLayout | null {
	if (!header) return null;
	const boxes = redactionOf(page);
	if (boxes.length === 0) return header;
	const width = Math.min(header.maxWidth, Math.max(8, estimateMeasure(header.text, header.size) + 2));
	const left = header.align === "left" ? header.x : header.align === "right" ? header.x - width : header.x - width / 2;
	const area: BBox = { minX: left - 2, minY: header.y - header.size, maxX: left + width + 2, maxY: header.y + header.size };
	return overlaps(area, boxes) ? null : header;
}

/** The notebook's meta with the bookmark titles of the pages that have redaction boxes taken out (a title can name what is covered). */
export function metaWithoutRedactedTitles(meta: NotebookMeta | undefined, pages: readonly Page[]): NotebookMeta | undefined {
	if (!meta?.bookmarkInfo) return meta;
	const covered = pages.filter((p) => redactionOf(p).length > 0).map((p) => p.id);
	if (covered.length === 0) return meta;
	const info = { ...meta.bookmarkInfo };
	for (const id of covered) {
		const entry = info[id];
		if (!entry) continue;
		const { title: _title, ...rest } = entry;
		void _title;
		info[id] = rest;
	}
	return { ...meta, bookmarkInfo: info };
}

// ---------------------------------------------------------------------------------------------------------------------- raster backgrounds

/** A rectangle of pixels. */
export interface PixelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The pixel rectangles to paint black on the picture of a page's background, which fills `rect` (page coordinates) and is `pixelWidth` ×
 * `pixelHeight` pixels. Boxes outside the background give nothing; each is grown a few pixels (a JPEG smears past an edge) and cut at the
 * picture.
 */
export function burnPixelRects(boxes: readonly RedactBox[], rect: { x: number; y: number; width: number; height: number }, pixelWidth: number, pixelHeight: number): PixelRect[] {
	if (!(rect.width > 0) || !(rect.height > 0) || !(pixelWidth > 0) || !(pixelHeight > 0)) return [];
	const kx = pixelWidth / rect.width;
	const ky = pixelHeight / rect.height;
	const out: PixelRect[] = [];
	for (const b of boxes) {
		const x0 = Math.max(0, Math.floor((b.x - rect.x) * kx) - BURN_PAD_PX);
		const y0 = Math.max(0, Math.floor((b.y - rect.y) * ky) - BURN_PAD_PX);
		const x1 = Math.min(pixelWidth, Math.ceil((b.x + b.width - rect.x) * kx) + BURN_PAD_PX);
		const y1 = Math.min(pixelHeight, Math.ceil((b.y + b.height - rect.y) * ky) + BURN_PAD_PX);
		if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
	}
	return out;
}

/** What an exporter needs to burn boxes into a background picture: the rectangle the picture fills (page coordinates) and the boxes. */
export interface BurnPlan {
	rect: { x: number; y: number; width: number; height: number };
	boxes: readonly RedactBox[];
}

/** The plan to burn the boxes of `page` into its background picture, or null when there is nothing to burn. */
export function burnPlan(page: Page): BurnPlan | null {
	const boxes = redactionOf(page);
	if (boxes.length === 0 || !page.background) return null;
	const rect = backgroundRect(page);
	return boxes.some((b) => rectsOverlap(b, rect)) ? { rect, boxes } : null;
}

/** A key for caches of burned pictures: the same boxes burn the same picture. */
export function burnKey(boxes: readonly RedactBox[]): string {
	return boxes.map((b) => `${b.x},${b.y},${b.width},${b.height}`).join(";");
}
