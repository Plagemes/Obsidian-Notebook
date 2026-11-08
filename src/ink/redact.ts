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
 * - an excerpt of a page of this notebook is dropped on whatever page shows it while the notebook has any box (its snapshot is never
 *   refreshed, so it may hold content that has since been boxed anywhere); a checkbox whose
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
import { countBoxes, rectsOverlap, type RedactBox, type Redactions, boxesOf } from "../model/redact";
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

/** The width (em) a single character of a text box is allowed for when the box is narrower than it (CJK, emoji, a wide symbol). */
const WIDEST_EM = 1.5;

/**
 * Review fix (R6): the bound for every character that is NOT in one of the ranges below, whose widths were checked: unknown scripts and
 * symbols count as the widest glyph known in any font a writer may fall back to (U+FDFD, the bismillah ligature, is about 4.5 em in
 * Noto Naskh Arabic). An unknown character can make the measure too wide, never too narrow.
 */
const UNKNOWN_EM = 6;

/**
 * Character ranges with a checked upper bound (em) in the sans-serif fonts the writers use (Helvetica in PDF and SVG, the system
 * sans-serif on the canvas, with Noto and DejaVu as fallbacks). [first, last, em]; anything outside every range is `UNKNOWN_EM`.
 */
const EM_RANGES: ReadonlyArray<readonly [number, number, number]> = [
	[0x00bc, 0x00be, 1.5], // ¼ ½ ¾ (about 1.3 em in DejaVu Sans)
	[0x01c4, 0x01cc, 1.5], // Latin digraphs Ǆ…ǌ (about 1.3 em)
	[0x01f1, 0x01f3, 1.5], // Ǳ ǲ ǳ
	[0x00a0, 0x02ff, 1.25], // Latin-1, Latin Extended-A/B, IPA, spacing modifiers (Æ and Œ are the widest, about 1.07 em in DejaVu Sans)
	[0x0300, 0x036f, 1], // combining marks (they do not advance; counted anyway)
	[0x0370, 0x03ff, 1], // Greek
	[0x0400, 0x052f, 1.25], // Cyrillic (Ж Щ Ю about 1 em)
	[0x0530, 0x05ff, 1.25], // Armenian, Hebrew
	[0x0600, 0x06ff, 1.5], // Arabic letters (the wide ligatures of U+FDxx are not here)
	[0x0900, 0x0dff, 2], // Devanagari to Sinhala (Tamil ஔ and Malayalam ൌ about 1.6 em)
	[0x0e00, 0x0e7f, 1.25], // Thai
	[0x1100, 0x11ff, 1.5], // Hangul Jamo
	[0x1e00, 0x1fff, 1.25], // Latin Extended Additional, Greek Extended
	[0x2000, 0x206f, 1.5], // general punctuation (the em dash is 1 em; ‱ about 1.3)
	[0x2070, 0x209f, 1.5], // superscripts and subscripts (H₂O)
	[0x20a0, 0x20cf, 1.5], // currency signs
	[0x2100, 0x218f, 2], // letterlike symbols and number forms (™ № ℃; ℡ and ℻ about 1.6 em; Roman numerals)
	[0x2190, 0x21ff, 1.5], // arrows
	[0x2200, 0x22ff, 1.5], // mathematical operators
	[0x2300, 0x23ff, 1.5], // miscellaneous technical (⌘ ⏰)
	[0x2460, 0x24ff, 1.5], // enclosed alphanumerics
	[0x2500, 0x27bf, 1.5], // box drawing, blocks, shapes, dingbats
	[0x2b00, 0x2bff, 1.5], // miscellaneous symbols and arrows (⭐)
	[0x2e3a, 0x2e3a, 2], // ⸺ two-em dash
	[0x2e3b, 0x2e3b, 3], // ⸻ three-em dash
	[0x2e80, 0x9fff, 1.5], // CJK radicals, kana, CJK ideographs (1 em)
	[0xac00, 0xd7af, 1.5], // Hangul syllables
	[0xf900, 0xfaff, 1.5], // CJK compatibility ideographs
	[0xfb00, 0xfb4f, 1.5], // ligatures ﬁ ﬂ ﬃ, Hebrew presentation forms
	[0xfe00, 0xfe0f, 1], // variation selectors (do not advance)
	[0xff00, 0xffef, 1.5], // full-width and half-width forms
	[0x1f000, 0x1faff, 1.5], // emoji and pictographs (about 1.25 em)
];

/**
 * A width (em) no glyph of the fonts the writers and the UI use is wider than, by character. Review fix (T8): with a margin over DejaVu
 * Sans (the usual sans-serif on Linux, and a fallback elsewhere), whose `@` is 1 em and whose `# + < = > ^ ~` are 0.838 em: the Latin
 * capitals and `m`, `w`, `@`, `%`, `&` count 1.1 em, other ASCII 0.9 em; the checked ranges their own bound (`EM_RANGES`); anything else
 * the widest bound of all.
 */
export function charEm(ch: string): number {
	const c = ch.codePointAt(0) ?? 0;
	if (c < 0x80) return /[A-Z@%&mw]/.test(ch) ? 1.1 : 0.9;
	for (const [first, last, em] of EM_RANGES) if (c >= first && c <= last) return em;
	return UNKNOWN_EM;
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
		let widest = WIDEST_EM;
		for (const ch of text) widest = Math.max(widest, charEm(ch));
		b = { minX: el.x, minY: el.y, maxX: el.x + Math.max(el.width, widest * el.fontSize), maxY: el.y + Math.max(a, c, p, LINE_HEIGHT * el.fontSize) };
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
	const set = withExcerptChains(pages, redactions);
	return pages.map((p) => redactPage(p, boxesOf(set, p.id), set));
}

/** Whether any of the pages has boxes in the set, or shows an excerpt of a region a box covers. */
export function hasRedactions(pages: readonly Page[], redactions: Redactions | undefined): boolean {
	if (!redactions) return false;
	const set = withExcerptChains(pages, redactions);
	return pages.some((p) => boxesOf(set, p.id).length > 0 || (p.elements ?? []).some((el) => coveredExcerpt(el, set)));
}

/** The rectangles of the excerpts that show covered pixels, by the id of the page that shows them (see `withExcerptChains`). */
const CHAIN = Symbol("notebook.excerptChain");
/** Review fix (T1): the ids of the pages of the notebook the set belongs to (see `withExcerptChains`). */
const PAGES = Symbol("notebook.pages");
type Chained = Redactions & { [CHAIN]?: Readonly<Record<string, readonly RedactBox[]>>; [PAGES]?: ReadonlySet<string> };

/**
 * Review fix (R5): the set, with the rectangles of every excerpt that shows covered pixels, at any depth. An excerpt of a region that holds
 * a covered excerpt carries those pixels in its own snapshot, so it is covered too (and an excerpt of that one, and so on). Found by
 * repeating over the excerpts of `pages` until nothing new is covered (each excerpt is added once, so a cycle ends). The rectangles ride
 * on the set in a symbol-keyed field: they decide only `coveredExcerpt`, never cut ink or draw a box, and never reach storage (a symbol is
 * not serialised; `Object.keys` and `boxesOf` do not see it). Chains already found on `redactions` (for a wider set of pages) are kept.
 */
export function withExcerptChains(pages: readonly Page[], redactions: Redactions | undefined): Redactions | undefined {
	if (!redactions) return redactions;
	const chain: Record<string, RedactBox[]> = {};
	const prior = (redactions as Chained)[CHAIN];
	if (prior) for (const id of Object.keys(prior)) chain[id] = [...prior[id]!];
	const out: Chained = { ...redactions };
	out[CHAIN] = chain;
	out[PAGES] = new Set([...((redactions as Chained)[PAGES] ?? []), ...pages.map((p) => p.id)]);
	const excerpts: Array<{ page: string; el: ExcerptElement; done: boolean }> = [];
	for (const p of pages) for (const el of p.elements ?? []) if (el.type === "excerpt") excerpts.push({ page: p.id, el, done: false });
	let grew = true;
	while (grew) {
		grew = false;
		for (const x of excerpts) {
			if (x.done || !coveredExcerpt(x.el, out)) continue;
			x.done = true;
			grew = true;
			(chain[x.page] ??= []).push({ x: x.el.x, y: x.el.y, width: x.el.width, height: x.el.height });
		}
	}
	return out;
}

/**
 * Review fix (P2): whether `el` is an excerpt whose source region a box of the set touches. Its snapshot is the pixels of that region, so
 * an export leaves the whole excerpt out (the page it shows it on may have no box at all). Matched by the source page id, which is unique.
 * Review fix (R5): a source region that holds an excerpt which is itself covered counts too (`withExcerptChains`).
 */
export function coveredExcerpt(el: PageElement, redactions: Redactions | undefined): boolean {
	if (el.type !== "excerpt" || !redactions || countBoxes(redactions) === 0) return false;
	const s: ExcerptElement["source"] = el.source;
	// Review fix (T1, which also settles T4): the snapshot is never refreshed after the excerpt is made, so the content it holds may since
	// have moved anywhere in the notebook and been boxed there; the current geometry cannot tell. While the notebook has any box, an excerpt
	// of one of its own pages is therefore left out whole, wherever its source region is. (Its source page having a box also proves it is
	// one of this notebook's pages when the set does not know them.)
	if ((redactions as Chained)[PAGES]?.has(s.page) || boxesOf(redactions, s.page).length > 0) return true;
	const area: BBox = { minX: s.x, minY: s.y, maxX: s.x + s.width, maxY: s.y + s.height };
	return overlaps(area, (redactions as Chained)[CHAIN]?.[s.page] ?? [], ELEMENT_PAD);
}

/**
 * Review fix (T2): the boxes that touch the given items with the same conservative areas the export uses: an element's `redactBounds`
 * (text measured at its widest), a stroke's bounds grown by its reach. A picture of a selection applies these (and not only the boxes
 * near its estimated area), so a box over the real last line of a long text is never missed.
 */
export function boxesTouching(items: { strokes: readonly Stroke[]; elements: readonly PageElement[] }, boxes: readonly RedactBox[]): RedactBox[] {
	const areas: BBox[] = items.elements.map((el) => redactBounds(el));
	for (const s of items.strokes) {
		if (s.points.length === 0) continue;
		const r = redactReach(s) + INK_PAD;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const [x, y] of s.points) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
		areas.push({ minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r });
	}
	return boxes.filter((b) => areas.some((a) => overlaps(a, [b])));
}

/**
 * Review fix (R1): whether the element `elementId` of `page` is still there once the page is redacted with the set (false when it is
 * dropped, or when its source region is covered). A copy of one element (the figures' *Copy*) is refused when it is not.
 */
export function elementKept(page: Page, elementId: string, redactions: Redactions | undefined): boolean {
	if (!(page.elements ?? []).some((el) => el.id === elementId)) return false;
	const drawn = redactPages([page], redactions)[0]!;
	return (drawn.elements ?? []).some((el) => el.id === elementId);
}

/** The header or footer of a page, or null when a box covers it (its text could be what the reader wants out). */
export function headerAfterRedaction(header: HeaderLayout | null, page: Page): HeaderLayout | null {
	if (!header) return null;
	const boxes = redactionOf(page);
	if (boxes.length === 0) return header;
	// Review fix (R2): measured like a text box (`pessimisticMeasure`), so capitals, CJK or a wide symbol never run past the area. Not
	// capped at `maxWidth`: the canvas and the PDF squeeze a long header into it, the SVG text does not.
	const width = Math.max(8, pessimisticMeasure(header.text, header.size) + 2);
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
