// 0.18 (#178): splitting an infinite page into sheets of paper for the PDF and PNG export. Pure: nothing here touches the
// document, the DOM or 'obsidian'. `planSplit` turns one page and the reader's choices (paper, scale, margins, overlap) into
// tiles in reading order (left to right, then the next row down); the horizontal cuts prefer the white space between lines of
// ink (`findCut`) and never cross a text box, picture or box when a gap is near. The writers (ink/export-pdf.ts,
// view/export-png.ts) only draw what the plan says; the strokes are never changed.
import { backgroundRect } from "../model/margins";
import { hiddenStickyInk } from "../model/sticky";
import type { Page } from "../model/types";
import { elementBounds, type MeasureText } from "./elements";
import { strokeBounds } from "./hit-test";
import { estimateMeasure } from "./text-layout";

export type SplitPaper = "a4" | "letter" | "a5";
export const SPLIT_PAPERS: readonly SplitPaper[] = ["a4", "letter", "a5"];
export type SplitOrientation = "portrait" | "landscape";
export type SplitScale = "fit" | "actual";

/** Sheet sizes in pt (portrait). */
export const PAPER_PT: Readonly<Record<SplitPaper, { width: number; height: number }>> = {
	a4: { width: 595.28, height: 841.89 },
	letter: { width: 612, height: 792 },
	a5: { width: 419.53, height: 595.28 },
};
/** Margin choices in pt (0, 6 mm, 12.7 mm, 19 mm). */
export const SPLIT_MARGINS: readonly number[] = [0, 18, 36, 54];
/** Overlap choices in pt (0, 5 mm, 10 mm, 15 mm): the strip of one sheet that is repeated at the top or left of the next. */
export const SPLIT_OVERLAPS: readonly number[] = [0, 14, 28, 42];

export interface SplitSettings {
	paper: SplitPaper;
	orientation: SplitOrientation;
	/** "fit": the width of the content fills the printable width of a sheet; "actual": 100% (1 pt of the page is 1 pt on paper). */
	scale: SplitScale;
	/** Margin on every side of a sheet, pt. */
	margin: number;
	/** Strip repeated between neighbouring sheets, pt on paper. */
	overlap: number;
	/** Move the horizontal cuts into the white space between lines of ink. */
	smartCuts: boolean;
	/** Write "1/6" at the bottom of every sheet (PDF). */
	pageNumbers: boolean;
	/** Leave out sheets that would be empty. */
	skipBlank: boolean;
}

export const DEFAULT_SPLIT: SplitSettings = {
	paper: "a4", orientation: "portrait", scale: "fit", margin: 36, overlap: 0, smartCuts: true, pageNumbers: true, skipBlank: true,
};

function nearest(list: readonly number[], v: unknown, fallback: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return list.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best));
}

/** Settings from anything stored or typed: unknown fields are dropped, bad values fall back to the defaults. */
export function normalizeSplit(raw: unknown): SplitSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_SPLIT;
	return {
		paper: SPLIT_PAPERS.find((p) => p === r.paper) ?? d.paper,
		orientation: r.orientation === "landscape" ? "landscape" : "portrait",
		scale: r.scale === "actual" ? "actual" : "fit",
		margin: nearest(SPLIT_MARGINS, r.margin, d.margin),
		overlap: nearest(SPLIT_OVERLAPS, r.overlap, d.overlap),
		smartCuts: typeof r.smartCuts === "boolean" ? r.smartCuts : d.smartCuts,
		pageNumbers: typeof r.pageNumbers === "boolean" ? r.pageNumbers : d.pageNumbers,
		skipBlank: typeof r.skipBlank === "boolean" ? r.skipBlank : d.skipBlank,
	};
}

/** Size of a sheet in pt. */
export function sheetSize(s: Pick<SplitSettings, "paper" | "orientation">): { width: number; height: number } {
	const p = PAPER_PT[s.paper];
	return s.orientation === "landscape" ? { width: p.height, height: p.width } : { width: p.width, height: p.height };
}

/** Something on the page a cut should not go through. `hard`: a text box, picture, box, equation, graph or note. */
export interface Obstacle {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	hard: boolean;
}

/** Bounding boxes of everything drawn on the page (hidden ink and the ink a collapsed note hides are left out, as in the export). */
export function contentObstacles(page: Page, measure: MeasureText = estimateMeasure): Obstacle[] {
	const out: Obstacle[] = [];
	const elements = page.elements ?? [];
	const noteInk = hiddenStickyInk(elements);
	for (const el of elements) {
		const b = elementBounds(el, measure);
		if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) continue;
		out.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, hard: el.type !== "marker" && el.type !== "area" });
	}
	for (const s of page.strokes) {
		if (s.points.length === 0 || s.hidden || noteInk?.has(s.id)) continue;
		const b = strokeBounds(s);
		if ([b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) out.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, hard: false });
	}
	return out;
}

const HARD_COST = 1000;
/** A gap narrower than this (pt of the page) is only taken when no wider one is near. */
const ROOMY_GAP = 6;

/**
 * Where to cut a page horizontally, between `lo` and `hi` (page y): the place crossed by the least ink, a text box or
 * picture counting far more than a stroke. Among equally good places the latest wins (the fullest sheet), at the middle of
 * its gap; a gap narrower than `ROOMY_GAP` is passed over for a roomier one. Returns `hi` when nothing is in the band.
 */
export function findCut(obstacles: readonly Obstacle[], lo: number, hi: number): number {
	if (!(hi > lo)) return hi;
	const near = obstacles.filter((o) => o.maxY > lo && o.minY < hi);
	if (near.length === 0) return hi;
	const marks = new Set<number>([lo, hi]);
	for (const o of near) {
		if (o.minY > lo && o.minY < hi) marks.add(o.minY);
		if (o.maxY > lo && o.maxY < hi) marks.add(o.maxY);
	}
	const ys = [...marks].sort((a, b) => a - b);
	const segs: Array<{ from: number; to: number; cost: number }> = [];
	for (let i = 0; i + 1 < ys.length; i++) {
		const from = ys[i]!;
		const to = ys[i + 1]!;
		const mid = (from + to) / 2;
		let cost = 0;
		for (const o of near) if (o.minY < mid && o.maxY > mid) cost += o.hard ? HARD_COST : 1;
		segs.push({ from, to, cost });
	}
	const best = Math.min(...segs.map((s) => s.cost));
	const tied = segs.filter((s) => s.cost === best);
	const longest = Math.max(...tied.map((s) => s.to - s.from));
	const roomy = tied.filter((s) => s.to - s.from >= Math.min(ROOMY_GAP, longest));
	const pick = roomy[roomy.length - 1]!;
	return (pick.from + pick.to) / 2;
}

export interface SplitTile {
	/** 0-based position in reading order, among the sheets that are written. */
	index: number;
	row: number;
	col: number;
	/** The part of the page (pt) this sheet shows. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Where its top-left corner goes on the sheet (pt from the sheet's top-left). */
	ox: number;
	oy: number;
}

export interface SplitPlan {
	sheetWidth: number;
	sheetHeight: number;
	/** Paper pt per page pt. */
	scale: number;
	/** The area that is split (page pt): the content plus a little room. */
	region: { x: number; y: number; width: number; height: number };
	/** Tiles in reading order. */
	tiles: SplitTile[];
	cols: number;
	rows: number;
	/** Page y of the cuts between rows (before the overlap), for the preview. */
	cuts: number[];
	/** Sheets left out because nothing is on them. */
	skippedBlank: number;
	/** Number the sheets "1/6". */
	pageNumbers: boolean;
	/** The page needed more than `MAX_TILES` sheets; the rest is not planned. */
	truncated: boolean;
}

/** Most sheets one page is split into. */
export const MAX_TILES = 200;
const PAD = 10;
const MIN_SCALE = 0.05;
const MAX_FIT_SCALE = 2;
/** Room kept under the printable area for the page number when the margin is smaller than this (pt). */
export const FOOTER = 22;

function overlaps(t: { x: number; y: number; width: number; height: number }, o: Obstacle): boolean {
	return o.maxX > t.x && o.minX < t.x + t.width && o.maxY > t.y && o.minY < t.y + t.height;
}

/**
 * The sheets of one page. Returns null when the page is not infinite (only those are split) or has nothing to draw.
 * `measure` sizes text boxes (the view's own when it has one).
 */
export function planSplit(page: Page, settings: SplitSettings, measure: MeasureText = estimateMeasure): SplitPlan | null {
	if (!page.infinite) return null;
	const s = normalizeSplit(settings);
	const sheet = sheetSize(s);
	const obstacles = contentObstacles(page, measure);
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const o of obstacles) {
		minX = Math.min(minX, o.minX);
		minY = Math.min(minY, o.minY);
		maxX = Math.max(maxX, o.maxX);
		maxY = Math.max(maxY, o.maxY);
	}
	const hasBackground = !!page.background;
	if (hasBackground) {
		const r = backgroundRect(page);
		minX = Math.min(minX, r.x);
		minY = Math.min(minY, r.y);
		maxX = Math.max(maxX, r.x + r.width);
		maxY = Math.max(maxY, r.y + r.height);
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
	// The region: the content with a little room, inside the page.
	const rx = Math.max(0, minX - PAD);
	const ry = Math.max(0, minY - PAD);
	const rr = Math.min(page.width, maxX + PAD);
	const rb = Math.min(page.height, maxY + PAD);
	if (!(rr > rx) || !(rb > ry)) return null;
	const region = { x: rx, y: ry, width: rr - rx, height: rb - ry };

	const m = s.margin;
	const footer = s.pageNumbers ? Math.max(m, FOOTER) : m;
	const pw = sheet.width - 2 * m;
	const ph = sheet.height - m - footer;
	const scale = s.scale === "actual" ? 1 : Math.min(MAX_FIT_SCALE, Math.max(MIN_SCALE, pw / region.width));
	const sw = pw / scale;
	const sh = ph / scale;
	const ov = Math.min(s.overlap / scale, 0.3 * Math.min(sw, sh));

	// Columns: a fixed grid from the left edge of the region.
	const colStarts: number[] = [];
	for (let x = region.x; colStarts.length < MAX_TILES; x += sw - ov) {
		colStarts.push(x);
		if (x + sw >= region.x + region.width - 1e-6) break;
	}
	// Rows: the cut falls where the page is emptiest near the bottom of the sheet.
	const cuts: number[] = [];
	const rowSpans: Array<{ y: number; height: number }> = [];
	const bottom = region.y + region.height;
	let y0 = region.y;
	let more = false;
	while (true) {
		const end = y0 + sh;
		if (end >= bottom - 1e-6) {
			rowSpans.push({ y: y0, height: bottom - y0 });
			break;
		}
		if (rowSpans.length >= MAX_TILES) {
			more = true;
			break;
		}
		const cut = s.smartCuts ? findCut(obstacles, Math.max(y0 + sh * 0.5, end - sh * 0.2), end) : end;
		rowSpans.push({ y: y0, height: cut - y0 });
		cuts.push(cut);
		y0 = cut - ov;
	}

	const all: Array<Omit<SplitTile, "index">> = [];
	let truncated = more;
	for (let row = 0; row < rowSpans.length; row++) {
		for (let col = 0; col < colStarts.length; col++) {
			if (all.length >= MAX_TILES) {
				truncated = true;
				break;
			}
			const x = colStarts[col]!;
			const w = Math.min(sw, region.x + region.width - x);
			const r = rowSpans[row]!;
			const ox = colStarts.length === 1 ? m + (pw - w * scale) / 2 : m;
			all.push({ row, col, x, y: r.y, width: w, height: r.height, ox, oy: m });
		}
	}
	let kept = all;
	let skippedBlank = 0;
	if (s.skipBlank && !hasBackground && obstacles.length > 0) {
		kept = all.filter((t) => obstacles.some((o) => overlaps(t, o)));
		if (kept.length === 0) kept = all.slice(0, 1);
		skippedBlank = all.length - kept.length;
	}
	return {
		sheetWidth: sheet.width, sheetHeight: sheet.height, scale, region,
		tiles: kept.map((t, index) => ({ ...t, index })),
		cols: colStarts.length, rows: rowSpans.length, cuts, skippedBlank, pageNumbers: s.pageNumbers, truncated,
	};
}

/** "1/6" */
export function tileLabel(plan: Pick<SplitPlan, "tiles">, index: number): string {
	return `${index + 1}/${plan.tiles.length}`;
}
