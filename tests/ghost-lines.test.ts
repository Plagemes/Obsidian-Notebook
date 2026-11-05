import { describe, expect, it } from "vitest";
import {
	ghostAlpha, ghostApplies, ghostSegments, ghostSpacingPt, GHOST_FADE_MS, GHOST_IDLE_MS, inferGhostLines, MAX_SPACING, MIN_SPACING, normaliseGhostMode,
	normaliseGhostSpacing, type GhostBox,
} from "../src/model/ghost-lines";

/** A letter-sized stroke sitting on `base` (x-height 9, a few taller). */
const letter = (x: number, base: number, h = 9, w = 7): GhostBox => ({ minX: x, maxX: x + w, minY: base - h, maxY: base });

/** One line of `n` strokes from x = 40 on baseline `base` (optionally tilted by `slope`). */
function line(base: number, n = 12, slope = 0, from = 40): GhostBox[] {
	const out: GhostBox[] = [];
	for (let i = 0; i < n; i++) {
		const x = from + i * 11;
		out.push(letter(x, base + slope * (x - from), i % 4 === 3 ? 16 : 9));
	}
	return out;
}

describe("inferGhostLines", () => {
	it("finds the baseline of a first line", () => {
		const g = inferGhostLines(line(100));
		expect(g).not.toBeNull();
		expect(g!.y).toBeCloseTo(100, 0);
		expect(g!.slope).toBeCloseTo(0, 2);
		expect(g!.x0).toBe(40);
		expect(g!.spacing).toBeGreaterThanOrEqual(MIN_SPACING);
		expect(g!.spacing).toBeLessThanOrEqual(MAX_SPACING);
	});

	it("needs a first line: too few strokes, or too narrow, give nothing", () => {
		expect(inferGhostLines([])).toBeNull();
		expect(inferGhostLines(line(100, 2))).toBeNull();
		expect(inferGhostLines([letter(10, 100), letter(14, 100), letter(18, 100)])).toBeNull();
	});

	it("ignores descenders: the baseline is the typical bottom", () => {
		const boxes = line(100);
		boxes[2] = { ...boxes[2]!, maxY: 108 };
		boxes[7] = { ...boxes[7]!, maxY: 109 };
		expect(inferGhostLines(boxes)!.y).toBeCloseTo(100, 0);
	});

	it("measures the line height from the previous line", () => {
		const g = inferGhostLines([...line(100), ...line(128)]);
		expect(g!.y).toBeCloseTo(128, 0);
		expect(g!.spacing).toBeCloseTo(28, 0);
	});

	it("follows a tilted line within the tolerance", () => {
		const g = inferGhostLines(line(100, 14, 0.08));
		expect(g!.slope).toBeCloseTo(0.08, 1);
	});

	it("takes a line tilted too much as flat", () => {
		const g = inferGhostLines(line(100, 14, 0.6));
		expect(g?.slope ?? 0).toBe(0);
	});

	it("leaves a drawing out", () => {
		const drawing: GhostBox = { minX: 200, maxX: 420, minY: 40, maxY: 260 };
		const g = inferGhostLines([drawing, ...line(100), { minX: 10, maxX: 12, minY: 10, maxY: 300 }]);
		expect(g).not.toBeNull();
		expect(g!.y).toBeCloseTo(100, 0);
	});

	it("only a drawing gives nothing", () => {
		expect(inferGhostLines([{ minX: 0, maxX: 300, minY: 0, maxY: 300 }, { minX: 20, maxX: 280, minY: 30, maxY: 250 }, { minX: 40, maxX: 260, minY: 50, maxY: 200 }])).toBeNull();
	});

	it("falls back to the last complete line while the new line has just started", () => {
		const g = inferGhostLines([...line(100), letter(40, 130), letter(51, 130)]);
		expect(g!.y).toBeCloseTo(100, 0);
	});

	it("uses the fixed spacing when given", () => {
		expect(inferGhostLines(line(100), 30)!.spacing).toBe(30);
		expect(inferGhostLines(line(100), 5)!.spacing).toBe(MIN_SPACING);
	});

	it("skips broken boxes", () => {
		const bad: GhostBox = { minX: NaN, maxX: 1, minY: 0, maxY: 1 };
		expect(inferGhostLines([bad, ...line(100)])!.y).toBeCloseTo(100, 0);
	});

	it("looks only at the newest strokes", () => {
		const old = line(60, 12);
		const many: GhostBox[] = [];
		for (let i = 0; i < 100; i++) many.push(...old.slice(0, 1));
		expect(inferGhostLines([...many, ...line(300)])!.y).toBeCloseTo(300, 0);
	});
});

describe("ghostSegments", () => {
	const g = { x: 100, y: 100, slope: 0, spacing: 28, x0: 40, x1: 170, strokes: 12 };
	it("gives the baseline and the next line, clamped to the page", () => {
		const s = ghostSegments(g, 595, 842);
		expect(s).toHaveLength(2);
		expect(s[0]!.y1).toBe(100);
		expect(s[1]!.y1).toBe(128);
		expect(s[0]!.x1).toBe(28);
		expect(s[0]!.x2).toBeLessThanOrEqual(595);
	});
	it("drops a line that would fall off the page", () => {
		expect(ghostSegments(g, 595, 110)).toHaveLength(1);
	});
	it("follows the slope", () => {
		const s = ghostSegments({ ...g, slope: 0.1 }, 595, 842);
		expect(s[0]!.y2).toBeGreaterThan(s[0]!.y1);
	});
});

describe("ghostAlpha, modes and settings", () => {
	it("fades after the idle time in writing mode and never in always mode", () => {
		expect(ghostAlpha("writing", 0)).toBe(1);
		expect(ghostAlpha("writing", GHOST_IDLE_MS)).toBe(1);
		expect(ghostAlpha("writing", GHOST_IDLE_MS + GHOST_FADE_MS / 2)).toBeCloseTo(0.5, 5);
		expect(ghostAlpha("writing", GHOST_IDLE_MS + GHOST_FADE_MS)).toBe(0);
		expect(ghostAlpha("always", 1e6)).toBe(1);
		expect(ghostAlpha("off", 0)).toBe(0);
	});
	it("applies to blank paper only", () => {
		expect(ghostApplies("writing", "blank")).toBe(true);
		expect(ghostApplies("writing", "ruled")).toBe(false);
		expect(ghostApplies("off", "blank")).toBe(false);
	});
	it("normalises saved values", () => {
		expect(normaliseGhostMode("always")).toBe("always");
		expect(normaliseGhostMode("x")).toBe("off");
		expect(normaliseGhostSpacing(8)).toBe("8");
		expect(normaliseGhostSpacing("9")).toBe("9");
		expect(normaliseGhostSpacing(13)).toBe("auto");
		expect(normaliseGhostSpacing(undefined)).toBe("auto");
		expect(ghostSpacingPt("auto")).toBe(0);
		expect(ghostSpacingPt("10")).toBeCloseTo(28.35, 1);
	});
});
