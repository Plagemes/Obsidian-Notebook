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
 *   the box (so the thickness of the line never shows under the edge), are removed from the data. A closed shape with a fill that touches a box
 *   is dropped whole.
 * - elements (text, pictures, equations, graphs, boxes, sticky notes, markers, checkboxes, excerpts) whose area touches a box are dropped
 *   WHOLE, including their text, source and picture: a text box that is half under a box does not leave its other half behind. The area
 *   highlighter holds no content, so it is cut like a rectangle minus the box.
 * - ink that the dropped graph clipped to its frame goes with it; ink a collapsed sticky note hides is never drawn by an export and is left out.
 * - margin comments anchored on a box are dropped with their replies; the automatic header or footer is dropped on a page whose box covers it.
 * - the page's tags and its states are not drawn by any export and are removed from the copy.
 */
import { hiddenStickyInk } from "../model/sticky";
import { EQUATION_NUMBER_GAP } from "../model/math-elements";
import { backgroundRect } from "../model/margins";
import { rectsOverlap, type RedactBox, type Redactions, boxesOf } from "../model/redact";
import { RENDER_INK, type AreaElement, type NotebookMeta, type Page, type PageComment, type PageElement, type Point, type Stroke } from "../model/types";
import { boundGraphId } from "./attach";
import { elementBounds } from "./elements";
import { inkReach } from "./ink-geometry";
import { layoutText, estimateMeasure } from "./text-layout";
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

/**
 * The area an element can cover in any writer (the canvas, the SVG and the PDF wrap text differently, so a text box is measured with two
 * letter widths and the taller wins), grown a little: an equation also reaches its number, a note its shadow.
 */
export function redactBounds(el: PageElement): BBox {
	let b: BBox;
	if (el.type === "text") {
		const text = shownText(el.text).text;
		const a = layoutText(text, el.fontSize, el.width, (s) => estimateMeasure(s, el.fontSize)).height;
		const c = layoutText(text, el.fontSize, el.width, (s) => wideMeasure(s, el.fontSize)).height;
		b = { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + Math.max(a, c) };
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
 * What is left of `stroke` once the boxes are removed: the stroke itself when no box reaches it, otherwise the pieces of its line outside
 * the boxes (each a stroke of its own, the first with the id of the stroke, the others `<id>.r1`, `<id>.r2`…; the style is kept). A filled
 * shape that a box reaches is dropped whole (cutting the line would leave a fill with no outline).
 */
export function cutStroke(stroke: Stroke, boxes: readonly RedactBox[]): Stroke[] {
	if (stroke.points.length === 0) return [stroke];
	const reach = inkReach(stroke.tool, stroke.width) + INK_PAD;
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
export function redactPage(page: Page, boxes: readonly RedactBox[]): Page {
	if (boxes.length === 0) return page;
	const have = redactionOf(page);
	if (sameBoxes(have, boxes)) return page;
	const all = have.length > 0 ? [...have, ...boxes.filter((b) => !have.some((h) => sameBoxes([h], [b])))] : boxes;
	const elements = page.elements ?? [];
	const never = hiddenStickyInk(elements);
	const goneGraphs = new Set<string>();
	const keptEls: PageElement[] = [];
	for (const el of elements) {
		if (el.type === "area") {
			keptEls.push(...cutArea(el, all));
			continue;
		}
		if (overlaps(redactBounds(el), all)) {
			if (el.type === "graph") goneGraphs.add(el.id);
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
	const next: Redacted = { ...page, strokes };
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

/** `redactPage` over a list; each page gets the boxes the set holds for its id (a page without any is the same object). */
export function redactPages(pages: readonly Page[], redactions: Redactions | undefined): Page[] {
	return pages.map((p) => redactPage(p, boxesOf(redactions, p.id)));
}

/** Whether any of the pages has boxes in the set. */
export function hasRedactions(pages: readonly Page[], redactions: Redactions | undefined): boolean {
	return !!redactions && pages.some((p) => boxesOf(redactions, p.id).length > 0);
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
