import { describe, expect, it } from "vitest";
import { layoutSpread } from "../src/ink/spread";
import { bandOf, hitLabel, jumpViewport, layoutBand, semanticAlpha, visibleLabels, type ScreenLabel, type SemanticSource } from "../src/ink/semantic-zoom";
import { fitWidth } from "../src/ink/viewport";

/** 0.27 integration: the semantic zoom labels follow the page boxes of a two-page spread (a row holds two pages side by side). */
const pages = Array.from({ length: 5 }, () => ({ width: 595, height: 842 }));
const layout = layoutSpread(pages, { firstAlone: false }); // rows 0-1, 2-3, 4
const view = { width: 1000, height: 700 };

const heading = (key: string, pageIndex: number, y: number): SemanticSource => ({
	key, kind: "heading", level: 1, pageIndex, x: 40, y, width: 200, height: 40, aspect: 5, ink: [key],
});

describe("semantic zoom in a two-page spread", () => {
	it("places each label inside the box of its own page, left or right of the binding", () => {
		const sources = [heading("a", 0, 100), heading("b", 1, 100), heading("c", 2, 100), heading("d", 3, 100)];
		const out = layoutBand({ sources, layout, view, band: bandOf(0.2) });
		expect(out.labels).toHaveLength(4);
		for (const l of out.labels) {
			const box = layout.boxes[l.source.pageIndex]!;
			expect(l.x).toBeGreaterThanOrEqual(box.x - 1e-6);
			expect(l.x + l.width).toBeLessThanOrEqual(box.x + box.width + 1e-6);
			expect(l.y).toBeGreaterThanOrEqual(box.y - 1e-6);
			expect(l.y + l.height).toBeLessThanOrEqual(box.y + box.height + 1e-6);
		}
		const a = out.labels.find((l) => l.source.key === "a")!;
		const b = out.labels.find((l) => l.source.key === "b")!;
		// Same row: same height, the right page's label is to the right of the left page's one.
		expect(a.y).toBeCloseTo(b.y, 6);
		expect(b.x).toBeGreaterThan(a.x + a.width);
	});

	it("does not let the labels of the two pages of a row push each other away", () => {
		const out = layoutBand({ sources: [heading("a", 0, 100), heading("b", 1, 100)], layout, view, band: bandOf(0.2) });
		const [a, b] = ["a", "b"].map((k) => out.labels.find((l) => l.source.key === k)!);
		expect(a!.y).toBeCloseTo(b!.y, 6);
	});

	it("hits the label of the right page and jumps to the fit of the whole spread", () => {
		const out = layoutBand({ sources: [heading("a", 0, 100), heading("b", 1, 100)], layout, view, band: bandOf(0.2) });
		const fit = fitWidth(view, layout);
		const vp = { scale: out.scale, offsetX: 0, offsetY: 0 };
		const pool: ScreenLabel[] = [];
		const n = visibleLabels(out, vp, view, pool, Infinity);
		expect(n).toBeGreaterThan(0);
		const bi = pool.slice(0, n).findIndex((l) => l.label?.source.key === "b");
		expect(bi).toBeGreaterThanOrEqual(0);
		const b = pool[bi]!;
		const hit = hitLabel(pool, n, b.x + 2, b.y + 2);
		expect(pool[hit]?.label?.source.key).toBe("b");
		const j = jumpViewport(layout, view, { pageIndex: 1, y: 100, height: 40 })!;
		expect(j.scale).toBeCloseTo(fit.scale, 9);
		// The jumped-to line lands in the upper part of the view, and the spread is centred horizontally as the fit does.
		expect(j.offsetX).toBeCloseTo(fit.offsetX, 9);
		expect(100 * j.scale + j.offsetY).toBeLessThan(view.height);
	});

	it("is off at the fit of the spread (the overlay never shows over a normally zoomed spread)", () => {
		const fit = fitWidth(view, layout).scale;
		expect(semanticAlpha(fit, fit)).toBe(0);
	});
});
