import { beforeEach, describe, expect, it } from "vitest";
import { detectStrikes } from "../src/ink/strikethrough";
import { erasableStrokes, scribbleEraseCommand, scribbleEraseSteps } from "../src/ink/scribble";
import { createDocument, createStroke } from "../src/model/document";
import { History } from "../src/model/history";
import type { Page, Point, Stroke } from "../src/model/types";
import { reseed, writeLine } from "./words-gen";

const BASE = 100;

function line(id: string, x0: number, y0: number, x1: number, y1: number): Stroke {
	const pts: Point[] = [];
	for (let i = 0; i <= 12; i++) pts.push([x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12 + Math.sin(i * 1.7) * 0.4, 0.5]);
	const s = createStroke("#000000", 1.5, pts, "pen");
	s.id = id;
	return s;
}

/** A fast back-and-forth scratch of `legs` legs over [cx - half, cx + half], sampled every point. */
function scratch(cx: number, cy: number, half: number, legs = 7, pitch = 4): Stroke {
	const pts: Point[] = [];
	for (let i = 0; i < legs; i++) {
		const from = i % 2 === 0 ? -half : half, to = -from;
		const y = cy + (i - legs / 2) * pitch;
		for (let k = 0; k <= 2 * half; k++) pts.push([cx + from + ((to - from) * k) / (2 * half), y, 0.5]);
	}
	return createStroke("#1e1e1e", 2, pts, "pen");
}

describe("scribble erase and hidden struck words", () => {
	beforeEach(() => reseed(11));

	function scene() {
		const text = writeLine("a", "hello brave new world", { x: 40, baseY: BASE });
		const word = text.filter((s) => s.id.split(":")[1] === "1");
		const minX = Math.min(...word.flatMap((s) => s.points.map((p) => p[0])));
		const maxX = Math.max(...word.flatMap((s) => s.points.map((p) => p[0])));
		const strike = line("strike", minX - 4, BASE - 5, maxX + 4, BASE - 5);
		const page = { id: "p1", strokes: [...text, strike] } as Pick<Page, "id" | "strokes">;
		const hidden = detectStrikes(page.strokes).ink;
		return { page, hidden, cx: (minX + maxX) / 2, half: (maxX - minX) / 2 + 6 };
	}

	it("without the skip the scribble would delete the struck word (the test is meaningful)", () => {
		const { page, hidden, cx, half } = scene();
		expect(hidden.size).toBeGreaterThan(0);
		const steps = scribbleEraseSteps(page, scratch(cx, BASE - 6, half), 500);
		expect(steps).not.toBeNull();
	});

	it("never deletes the hidden struck ink", () => {
		const { page, hidden, cx, half } = scene();
		const sc = scratch(cx, BASE - 6, half);
		const steps = scribbleEraseSteps(page, sc, 500, undefined, {}, false, hidden);
		// Everything the scribble crossed is hidden: nothing to erase, so it stays an ordinary stroke.
		expect(steps).toBeNull();
		expect(scribbleEraseCommand(page, sc.points, 500, sc.width, undefined, {}, false, hidden)).toBeNull();
	});

	it("still deletes the visible ink the scribble crosses, and only that", () => {
		const { page, hidden, cx, half } = scene();
		// New writing on the (blank-looking) place of the struck word: it is visible and may be scratched out.
		const extra = createStroke("#000000", 1.5, [[cx - 3, BASE - 8, 0.5], [cx - 2, BASE - 2, 0.5]], "pen");
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		const p = doc.pages[0]!;
		p.strokes.push(...page.strokes, extra);
		const steps = scribbleEraseSteps(p, scratch(cx, BASE - 6, half), 500, undefined, {}, false, hidden);
		expect(steps).not.toBeNull();
		const history = new History(() => doc);
		history.execute(steps!.keep);
		history.execute(steps!.erase);
		expect(p.strokes.includes(extra)).toBe(false);
		expect(p.strokes.filter((s) => hidden.has(s.id))).toHaveLength(hidden.size);
		expect(p.strokes).toHaveLength(page.strokes.length);
	});

	it("erasableStrokes leaves out the skipped ids", () => {
		const { page, hidden } = scene();
		const all = erasableStrokes(page);
		const some = erasableStrokes(page, hidden);
		expect(all).toHaveLength(page.strokes.length);
		expect(some).toHaveLength(page.strokes.length - hidden.size);
		expect(some.some((s) => hidden.has(s.id))).toBe(false);
		expect(erasableStrokes(page, null)).toBe(page.strokes);
	});
});
