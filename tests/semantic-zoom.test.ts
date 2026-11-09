import { describe, expect, it } from "vitest";
import { layoutPages } from "../src/ink/layout";
import {
	bandOf, bandScale, BAND_STEP, hitLabel, jumpViewport, layoutBand, MAX_LABELS_PER_PAGE, semanticAlpha, semanticRange, SemanticLayoutCache,
	visibleLabels, type ScreenLabel, type SemanticSource,
} from "../src/ink/semantic-zoom";
import { fitWidth, MIN_SCALE } from "../src/ink/viewport";

const pages = Array.from({ length: 4 }, () => ({ width: 595, height: 842 }));
const layout = layoutPages(pages);
const view = { width: 800, height: 600 };

const heading = (key: string, pageIndex: number, y: number, over: Partial<SemanticSource> = {}): SemanticSource => ({
	key, kind: "heading", level: 1, pageIndex, x: 40, y, width: 200, height: 40, aspect: 5, ink: [key], ...over,
});
const text = (key: string, pageIndex: number, y: number, over: Partial<SemanticSource> = {}): SemanticSource => ({
	key, kind: "bookmark", level: 1, pageIndex, x: 16, y, width: 0, height: 14, text: key, ...over,
});

describe("semantic zoom: when it shows", () => {
	it("is invisible at the fit-to-width zoom and complete far out, smooth in between", () => {
		const fit = fitWidth(view, layout).scale;
		expect(semanticAlpha(fit, fit)).toBe(0);
		expect(semanticAlpha(fit * 2, fit)).toBe(0);
		const { on, full } = semanticRange(fit);
		expect(semanticAlpha(full, fit)).toBe(1);
		expect(semanticAlpha(MIN_SCALE, fit)).toBe(1);
		let prev = 0;
		for (let s = on; s >= full; s -= (on - full) / 20) {
			const a = semanticAlpha(s, fit);
			expect(a).toBeGreaterThanOrEqual(prev);
			prev = a;
		}
		expect(semanticAlpha((on + full) / 2, fit)).toBeGreaterThan(0.2);
		expect(semanticAlpha((on + full) / 2, fit)).toBeLessThan(0.8);
	});

	it("is reachable on a phone, where the fit scale is small", () => {
		const fit = 0.64;
		const { on, full } = semanticRange(fit);
		expect(full).toBeGreaterThan(MIN_SCALE);
		expect(on).toBeGreaterThan(full);
		expect(semanticAlpha(MIN_SCALE, fit)).toBe(1);
	});

	it("is off for a degenerate zoom", () => {
		expect(semanticAlpha(0, 1)).toBe(0);
		expect(semanticAlpha(NaN, 1)).toBe(0);
		expect(semanticAlpha(0.3, 0)).toBe(0);
	});
});

describe("semantic zoom: bands", () => {
	it("quantises the zoom in geometric steps and round-trips", () => {
		expect(bandOf(1)).toBe(0);
		expect(bandOf(BAND_STEP)).toBe(1);
		expect(bandScale(bandOf(0.3))).toBeGreaterThan(0.3 / Math.sqrt(BAND_STEP) - 1e-9);
		expect(bandScale(bandOf(0.3))).toBeLessThan(0.3 * Math.sqrt(BAND_STEP) + 1e-9);
		expect(bandOf(0)).toBeLessThan(0);
	});
});

describe("semantic zoom: layout", () => {
	const band = bandOf(0.3);

	it("makes labels legible at the zoom they are for", () => {
		const l = layoutBand({ sources: [heading("h1", 0, 100), text("t", 1, 20, { level: 2 })], layout, view, band });
		expect(l.labels).toHaveLength(2);
		const s = l.scale;
		const pic = l.labels.find((x) => x.source.key === "h1")!;
		// Level 1 picture: between 30 and 52 CSS px tall on the screen, in the proportions of the ink.
		expect(pic.height * s).toBeGreaterThanOrEqual(29.9);
		expect(pic.height * s).toBeLessThanOrEqual(52.1);
		expect(pic.width / pic.height).toBeCloseTo(5, 5);
		const txt = l.labels.find((x) => x.source.key === "t")!;
		expect(txt.font).toBe(16);
		expect(txt.height * s).toBeGreaterThanOrEqual(16 * 1.7);
	});

	it("anchors a label at its position, inside its page", () => {
		const l = layoutBand({ sources: [heading("h", 2, 300, { x: 30 })], layout, view, band });
		const box = layout.boxes[2]!;
		const p = l.labels[0]!;
		expect(p.x).toBeCloseTo(box.x + 30, 5);
		expect(p.y + p.height / 2).toBeCloseTo(box.y + 300 + 20, 3);
		// Near the right edge: pulled back inside the page.
		const edge = layoutBand({ sources: [heading("e", 0, 100, { x: 580 })], layout, view, band }).labels[0]!;
		expect(edge.x + edge.width).toBeLessThanOrEqual(layout.boxes[0]!.x + layout.boxes[0]!.width + 1e-9);
		// At the very top: pulled down inside the page.
		const top = layoutBand({ sources: [text("top", 0, -50)], layout, view, band }).labels[0]!;
		expect(top.y).toBeGreaterThanOrEqual(layout.boxes[0]!.y);
	});

	it("never overlaps two labels of a page, moving the less important one aside", () => {
		const srcs = [heading("a", 0, 100), heading("b", 0, 104, { level: 2 }), heading("c", 0, 108, { level: 2 })];
		const l = layoutBand({ sources: srcs, layout, view, band });
		expect(l.labels.length).toBeGreaterThanOrEqual(2);
		for (const a of l.labels) for (const b of l.labels) {
			if (a === b) continue;
			const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
			expect(apart).toBe(true);
		}
		// The level 1 label keeps its place.
		const first = l.labels.find((x) => x.source.key === "a")!;
		expect(first.y + first.height / 2).toBeCloseTo(layout.boxes[0]!.y + 120, 3);
	});

	it("drops a label that finds no room instead of piling it up", () => {
		const srcs = Array.from({ length: 5 }, (_, i) => heading(`k${i}`, 0, 100, { x: 40 }));
		const l = layoutBand({ sources: srcs, layout, view, band });
		expect(l.labels.length).toBeLessThanOrEqual(5);
		expect(l.labels.length).toBeGreaterThanOrEqual(1);
		for (const a of l.labels) for (const b of l.labels) if (a !== b) expect(a.y < b.y + b.height && b.y < a.y + a.height && a.x < b.x + b.width && b.x < a.x + a.width).toBe(false);
	});

	it("caps the labels of a page and keeps the most important", () => {
		const srcs = Array.from({ length: 12 }, (_, i) => heading(`m${i}`, 0, 20 + i * 60, { level: i === 7 ? 1 : 3 }));
		const l = layoutBand({ sources: srcs, layout, view, band });
		expect(l.labels.length).toBeLessThanOrEqual(MAX_LABELS_PER_PAGE);
		expect(l.labels.some((x) => x.source.key === "m7")).toBe(true);
	});

	it("is deterministic and independent of the order of the sources", () => {
		const srcs = [heading("a", 0, 100), text("b", 0, 20), heading("c", 1, 200, { level: 2 }), text("d", 3, 400, { level: 3 })];
		const a = layoutBand({ sources: srcs, layout, view, band });
		const b = layoutBand({ sources: srcs.slice().reverse(), layout, view, band });
		expect(a.labels.map((x) => [x.source.key, x.x, x.y, x.width, x.height])).toEqual(b.labels.map((x) => [x.source.key, x.x, x.y, x.width, x.height]));
	});

	it("limits the width of a long text and of a very wide picture", () => {
		const long = text("long", 0, 50, { text: "x".repeat(200) });
		const wide = heading("wide", 1, 50, { width: 500, height: 10, aspect: 50 });
		const l = layoutBand({ sources: [long, wide], layout, view, band });
		for (const p of l.labels) expect(p.width * l.scale).toBeLessThanOrEqual(360.001);
	});

	it("skips a source with nothing to show or a page that does not exist", () => {
		const l = layoutBand({ sources: [text("empty", 0, 10, { text: "  " }), heading("ghost", 9, 10), heading("noaspect", 0, 10, { aspect: 0 })], layout, view, band });
		expect(l.labels).toHaveLength(0);
	});

	it("shrinks a label wider than a narrow page, keeping its proportions", () => {
		const narrow = layoutPages([{ width: 60, height: 200 }]);
		const l = layoutBand({ sources: [heading("p", 0, 10, { aspect: 6 })], layout: narrow, view, band });
		const p = l.labels[0]!;
		expect(p.width).toBeLessThanOrEqual(60 + 1e-9);
		expect(p.width / p.height).toBeCloseTo(6, 5);
	});

	it("sorts the labels by position", () => {
		const l = layoutBand({ sources: [heading("z", 3, 10), heading("y", 0, 500), heading("x", 1, 10)], layout, view, band });
		const ys = l.labels.map((x) => x.y);
		expect(ys).toEqual(ys.slice().sort((a, b) => a - b));
	});
});

describe("semantic zoom: cache", () => {
	it("reuses the layout of a band for a pan or a zoom inside it, and rebuilds for a change", () => {
		const cache = new SemanticLayoutCache();
		const sources = [heading("h", 0, 100)];
		const band = bandOf(0.3);
		const a = cache.get({ sources, layout, view, band });
		expect(cache.get({ sources, layout, view, band })).toBe(a);
		expect(cache.computed).toBe(1);
		cache.get({ sources, layout, view, band: band - 1 });
		expect(cache.computed).toBe(2);
		cache.get({ sources: [...sources], layout, view, band: band - 1 });
		expect(cache.computed).toBe(3);
		cache.get({ sources, layout: layoutPages(pages), view, band });
		expect(cache.computed).toBe(4);
		cache.get({ sources, layout: cache.get({ sources, layout, view, band }) && layout, view: { ...view, width: 400 }, band });
		expect(cache.computed).toBeGreaterThanOrEqual(5);
	});
});

describe("semantic zoom: per frame", () => {
	const scale = 0.3;
	const band = bandOf(scale);
	const sources = [heading("p0", 0, 100), heading("p1", 1, 100), heading("p3", 3, 100), text("far", 3, 600, { level: 2 })];
	const l = layoutBand({ sources, layout, view, band });
	const fit = fitWidth(view, layout);

	it("returns the labels in the view, in the order of the document, positioned on the screen", () => {
		const pool: ScreenLabel[] = [];
		const vp = { scale, offsetX: 20, offsetY: 10 };
		const n = visibleLabels(l, vp, view, pool);
		expect(n).toBeGreaterThanOrEqual(1);
		const keys = pool.slice(0, n).map((s) => s.label!.source.key);
		expect(keys[0]).toBe("p0");
		for (const s of pool.slice(0, n)) {
			expect(s.x).toBeCloseTo(vp.offsetX + s.label!.x * scale, 6);
			expect(s.y).toBeCloseTo(vp.offsetY + s.label!.y * scale, 6);
			expect(s.y + s.height).toBeGreaterThan(0);
			expect(s.y).toBeLessThan(view.height);
		}
		expect(keys).not.toContain("p3");
	});

	it("follows a pan, and a scroll to the end brings the last labels", () => {
		const pool: ScreenLabel[] = [];
		const vp = { scale, offsetX: 20, offsetY: -layout.boxes[3]!.y * scale + 10 };
		const n = visibleLabels(l, vp, view, pool);
		const keys = pool.slice(0, n).map((s) => s.label!.source.key);
		expect(keys).toContain("p3");
		expect(keys).not.toContain("p0");
	});

	it("scales the label with the zoom inside the band", () => {
		const pool: ScreenLabel[] = [];
		const vp = { scale: scale * 1.05, offsetX: 0, offsetY: 0 };
		visibleLabels(l, vp, view, pool);
		const s = pool[0]!;
		expect(s.height).toBeCloseTo(s.label!.height * vp.scale, 6);
	});

	it("reuses the pool objects between frames", () => {
		const pool: ScreenLabel[] = [];
		visibleLabels(l, { scale, offsetX: 0, offsetY: 0 }, view, pool);
		const first = pool[0];
		const size = pool.length;
		visibleLabels(l, { scale, offsetX: 5, offsetY: 5 }, view, pool);
		expect(pool[0]).toBe(first);
		expect(pool.length).toBe(size);
	});

	it("respects a cap on the labels", () => {
		const pool: ScreenLabel[] = [];
		expect(visibleLabels(l, { scale, offsetX: 0, offsetY: 0 }, view, pool, 1)).toBe(1);
	});

	it("finds nothing in an empty layout", () => {
		const empty = layoutBand({ sources: [], layout, view, band });
		expect(visibleLabels(empty, { scale, offsetX: 0, offsetY: 0 }, view, [])).toBe(0);
	});

	it("hits the label under a point, the last one drawn first, with a margin", () => {
		const pool: ScreenLabel[] = [];
		const n = visibleLabels(l, { scale, offsetX: 20, offsetY: 10 }, view, pool);
		const s = pool[0]!;
		expect(hitLabel(pool, n, s.x + s.width / 2, s.y + s.height / 2)).toBe(0);
		expect(hitLabel(pool, n, s.x - 3, s.y + s.height / 2)).toBe(-1);
		expect(hitLabel(pool, n, s.x - 3, s.y + s.height / 2, 6)).toBe(0);
		expect(hitLabel(pool, n, -50, -50)).toBe(-1);
		expect(hitLabel(pool, 0, s.x, s.y)).toBe(-1);
		// Overlapping boxes: the later one wins.
		const a: ScreenLabel = { label: null, x: 0, y: 0, width: 50, height: 50, font: 0 };
		const b: ScreenLabel = { label: null, x: 25, y: 25, width: 50, height: 50, font: 0 };
		expect(hitLabel([a, b], 2, 30, 30)).toBe(1);
		expect(hitLabel([a, b], 2, 10, 10)).toBe(0);
	});

	it("jumps to the fit-to-width zoom with the line near the top of the view", () => {
		const v = jumpViewport(layout, view, { pageIndex: 2, y: 300, height: 40 })!;
		expect(v.scale).toBeCloseTo(fit.scale, 8);
		expect(v.offsetX).toBeCloseTo(fit.offsetX, 8);
		const lineY = (layout.boxes[2]!.y + 320) * v.scale + v.offsetY;
		expect(lineY / view.height).toBeCloseTo(0.22, 5);
		expect(semanticAlpha(v.scale, fit.scale)).toBe(0);
		expect(jumpViewport(layout, view, { pageIndex: 9, y: 0, height: 10 })).toBeNull();
		expect(jumpViewport(layout, { width: 0, height: 0 }, { pageIndex: 0, y: 0, height: 10 })).toBeNull();
	});
});

describe("semantic zoom: cost", () => {
	it("lays out and scans a 300-page notebook with a heading on each page quickly", () => {
		const many = layoutPages(Array.from({ length: 300 }, () => ({ width: 595, height: 842 })));
		const sources: SemanticSource[] = [];
		for (let i = 0; i < 300; i++) {
			sources.push(heading(`h${i}`, i, 60), heading(`s${i}`, i, 400, { level: 2 }), text(`t${i}`, i, 10, { level: 3 }));
		}
		const t0 = performance.now();
		const l = layoutBand({ sources, layout: many, view, band: bandOf(0.28) });
		const t1 = performance.now();
		const pool: ScreenLabel[] = [];
		for (let i = 0; i < 200; i++) visibleLabels(l, { scale: 0.28, offsetX: 0, offsetY: -i * 40 }, view, pool, 40);
		const t2 = performance.now();
		expect(l.labels.length).toBeGreaterThan(600);
		expect(t1 - t0).toBeLessThan(500);
		expect((t2 - t1) / 200).toBeLessThan(2);
	});
});
