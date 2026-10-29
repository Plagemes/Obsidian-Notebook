import { MM, type Page } from "../model/types";
import type { BBox } from "./hit-test";

export type PaperLineKind = "minor" | "major" | "margin";

export interface PaperLine {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	kind: PaperLineKind;
}

export interface PaperPattern {
	lines: PaperLine[];
	dots: Array<[number, number]>;
}

/** Ruled paper: the first line is drawn after this many blank line heights (a top margin of two lines). */
export const RULED_TOP_LINES = 3;
/** Ruled paper: x of the vertical margin line, about 25 mm from the left edge. */
export const RULED_MARGIN_X = 25 * MM;
/** Millimetre paper: every Nth line is a major line (10 mm). */
export const MILLIMETRE_MAJOR_EVERY = 10;
/** Minor lines or dots closer than this (CSS px) are not worth drawing. */
export const MIN_MINOR_PX = 3;

/** True if minor lines spaced `spacing` pt apart are at least about 3 CSS px apart at `scale`. */
export function minorVisible(spacing: number, scale: number): boolean {
	return spacing * scale >= MIN_MINOR_PX;
}

/**
 * Paper pattern of a page in page coordinates (pt), limited to what intersects `visible`.
 * Lines span the whole page; nothing is drawn on the page edge. With `includeMinor: false` the
 * minor lines and the dots are left out (major and margin lines remain).
 */
/** Upper bound on pattern lines per axis (an A4 page at 1 mm has about 300). */
export const MAX_PATTERN_STEPS = 5000;

export function paperPattern(page: Page, visible: BBox, options: { includeMinor?: boolean } = {}): PaperPattern {
	const includeMinor = options.includeMinor ?? true;
	const lines: PaperLine[] = [];
	const dots: Array<[number, number]> = [];
	const { kind, spacing } = page.paper;
	const { width, height } = page;
	if (kind === "blank" || !(spacing > 0)) return { lines, dots };
	// Safety cap for documents that bypassed validation: never walk more than MAX_PATTERN_STEPS per axis.
	if (Math.max(width, height) / spacing > MAX_PATTERN_STEPS) return { lines, dots };

	const vx = (x: number) => x >= visible.minX && x <= visible.maxX;
	const vy = (y: number) => y >= visible.minY && y <= visible.maxY;
	const vertical = (x: number, k: PaperLineKind) => {
		if (vx(x)) lines.push({ x1: x, y1: 0, x2: x, y2: height, kind: k });
	};
	const horizontal = (y: number, k: PaperLineKind) => {
		if (vy(y)) lines.push({ x1: 0, y1: y, x2: width, y2: y, kind: k });
	};
	// Index range of multiples of `spacing` inside [lo, hi] and strictly inside (0, limit).
	const range = (lo: number, hi: number, limit: number, first = 1): [number, number] => {
		const a = Math.max(first, Math.ceil(lo / spacing));
		const b = Math.min(Math.ceil(limit / spacing) - 1, Math.floor(hi / spacing));
		return [a, b];
	};

	switch (kind) {
		case "grid": {
			if (!includeMinor) break;
			const [ia, ib] = range(visible.minX, visible.maxX, width);
			for (let i = ia; i <= ib; i++) vertical(i * spacing, "minor");
			const [ja, jb] = range(visible.minY, visible.maxY, height);
			for (let j = ja; j <= jb; j++) horizontal(j * spacing, "minor");
			break;
		}
		case "ruled": {
			if (includeMinor) {
				const [ja, jb] = range(visible.minY, visible.maxY, height, RULED_TOP_LINES);
				for (let j = ja; j <= jb; j++) horizontal(j * spacing, "minor");
			}
			if (RULED_MARGIN_X < width) vertical(RULED_MARGIN_X, "margin");
			break;
		}
		case "dotted": {
			if (!includeMinor) break;
			const [ia, ib] = range(visible.minX, visible.maxX, width);
			const [ja, jb] = range(visible.minY, visible.maxY, height);
			for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) dots.push([i * spacing, j * spacing]);
			break;
		}
		case "millimetre": {
			const [ia, ib] = range(visible.minX, visible.maxX, width);
			for (let i = ia; i <= ib; i++) {
				const major = i % MILLIMETRE_MAJOR_EVERY === 0;
				if (major || includeMinor) vertical(i * spacing, major ? "major" : "minor");
			}
			const [ja, jb] = range(visible.minY, visible.maxY, height);
			for (let j = ja; j <= jb; j++) {
				const major = j % MILLIMETRE_MAJOR_EVERY === 0;
				if (major || includeMinor) horizontal(j * spacing, major ? "major" : "minor");
			}
			break;
		}
	}
	return { lines, dots };
}

/** Paper colours shared by the canvas renderer and the exporters. */
export const PAPER_COLORS = {
	minor: "#cfdcea",
	major: "#9fb6cf",
	margin: "#e9a3a3",
	dot: "#8fa5bd",
} as const;
