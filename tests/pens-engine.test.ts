/**
 * 0.22 (pens, #35): the geometry of the fountain pen, the brush and the marker — direction and pressure response, a wet stroke that is the
 * same shape as the committed one, boxes and hit tests that reach the whole line, the nib after a move, the same look in every export,
 * and the cost of a point (no garbage per sample, no more than a small multiple of the pen's time).
 */
import { describe, expect, it } from "vitest";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { addInkPath, FOUNTAIN_MIN, inkBounds, InkBuilder, inkPath, inkReach, MARKER_MIN, SvgPathSink, type PathSink } from "../src/ink/ink-geometry";
import { strokeBounds, strokeHit } from "../src/ink/hit-test";
import { nibAfter, transformStroke } from "../src/ink/lasso";
import { lodNodes, lodSvgPath } from "../src/ink/lod";
import { eraseSegment } from "../src/ink/segment-erase";
import { inkAlpha, inkBlend, MARKER_ALPHA, strokeSvgPath } from "../src/ink/stroke-shape";
import { rotateAbout, scaleAbout, translate } from "../src/ink/transform";
import { createPage, createStroke } from "../src/model/document";
import { serializeChecked } from "../src/model/serialize";
import { RENDER_INK, type Point, type Stroke, type Tool } from "../src/model/types";
import { sleep } from "./node-env";

const NEW_PENS: Tool[] = ["fountain", "brush", "marker"];
const ALL_TOOLS: Tool[] = ["pen", "highlighter", "shape", "fountain", "brush", "marker"];

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/** Handwriting-like points: loops and direction changes, pressure varying. */
function handwriting(n: number, seed = 1): Point[] {
	const r = rng(seed);
	const out: Point[] = [];
	for (let i = 0; i < n; i++) {
		const s = i / 60;
		out.push([
			Math.round((100 + 240 * s + 18 * Math.sin(s * 14) + (r() - 0.5) * 0.3) * 100) / 100,
			Math.round((200 + 22 * Math.cos(s * 9) + 9 * Math.sin(s * 23) + (r() - 0.5) * 0.3) * 100) / 100,
			Math.round((0.1 + 0.8 * Math.sin(s * 5) ** 2) * 1000) / 1000,
		]);
	}
	return out;
}

/** A straight line of `n` points `step` pt apart in direction (dx, dy), constant pressure. */
function straight(dx: number, dy: number, n = 40, p = 0.5, step = 2): Point[] {
	const l = Math.hypot(dx, dy);
	return Array.from({ length: n }, (_, i): Point => [Math.round((100 + (dx / l) * step * i) * 100) / 100, Math.round((100 + (dy / l) * step * i) * 100) / 100, p]);
}

/** Radius of the node in the middle of the stroke. */
function midRadius(points: Point[], tool: Tool, width = 4, nib?: number): number {
	const g = InkBuilder.fromPoints(points, width, tool, undefined, nib);
	return g.nr[Math.floor(g.nodeCount / 2)]!;
}

describe("fountain pen: the width follows the direction", () => {
	it("is a hairline along the nib and full width across it (nib 45: '/' is thin, '\\' is thick)", () => {
		const along = midRadius(straight(1, -1), "fountain");
		const across = midRadius(straight(1, 1), "fountain");
		expect(across).toBeCloseTo(2, 1);
		expect(along).toBeCloseTo(2 * FOUNTAIN_MIN, 1);
		expect(along).toBeLessThan(across / 4);
	});

	it("horizontal and vertical lines are in between, and equal at 45", () => {
		const h = midRadius(straight(1, 0), "fountain");
		const v = midRadius(straight(0, 1), "fountain");
		expect(h).toBeCloseTo(v, 6);
		expect(h).toBeGreaterThan(midRadius(straight(1, -1), "fountain"));
		expect(h).toBeLessThan(midRadius(straight(1, 1), "fountain"));
	});

	it("turns with the nib angle", () => {
		// Nib 0: horizontal lines are thin, vertical ones thick.
		expect(midRadius(straight(1, 0), "fountain", 4, 0)).toBeLessThan(midRadius(straight(0, 1), "fountain", 4, 0) / 4);
		// Nib 90: the other way round.
		expect(midRadius(straight(0, 1), "fountain", 4, 90)).toBeLessThan(midRadius(straight(1, 0), "fountain", 4, 90) / 4);
		// Nib 135 is nib 45 mirrored: '\' is thin.
		expect(midRadius(straight(1, 1), "fountain", 4, 135)).toBeLessThan(midRadius(straight(1, -1), "fountain", 4, 135) / 4);
	});

	it("pressure still modulates the width, 0.7 to 1.3", () => {
		const soft = midRadius(straight(1, 1, 40, 0.0), "fountain");
		const mid = midRadius(straight(1, 1, 40, 0.5), "fountain");
		const hard = midRadius(straight(1, 1, 40, 1), "fountain");
		expect(soft).toBeCloseTo(mid * 0.7, 6);
		expect(hard).toBeCloseTo(mid * 1.3, 6);
	});

	it("has crisp ends: the first and the last disc are as wide as the middle of a straight line", () => {
		const g = InkBuilder.fromPoints(straight(1, 1), 4, "fountain");
		const mid = g.nr[Math.floor(g.nodeCount / 2)]!;
		expect(g.nr[g.nodeCount - 1]).toBeCloseTo(mid, 6);
		// The first point has no direction yet: the average one.
		expect(g.nr[0]!).toBeGreaterThan(mid * 0.5);
	});
});

describe("marker: a flat chisel", () => {
	it("ignores pressure completely", () => {
		for (const p of [0, 0.3, 1]) expect(midRadius(straight(1, 1, 40, p), "marker")).toBeCloseTo(midRadius(straight(1, 1, 40, 0.5), "marker"), 9);
	});

	it("is MARKER_MIN of the width along the nib and the whole width across it", () => {
		expect(midRadius(straight(1, -1), "marker", 10)).toBeCloseTo(5 * MARKER_MIN, 1);
		expect(midRadius(straight(1, 1), "marker", 10)).toBeCloseTo(5, 1);
	});
});

describe("brush: pressure, speed and soft ends", () => {
	it("is much finer for light pressure than for heavy pressure", () => {
		expect(midRadius(straight(1, 0, 60, 0.9), "brush", 6)).toBeGreaterThan(midRadius(straight(1, 0, 60, 0.15), "brush", 6) * 3);
	});

	it("is thinner when it moves fast", () => {
		const slow = midRadius(straight(1, 0, 60, 0.6, 1), "brush", 6);
		const fast = midRadius(straight(1, 0, 60, 0.6, 14), "brush", 6);
		expect(fast).toBeLessThan(slow * 0.65);
		expect(fast).toBeGreaterThan(slow * 0.4);
	});

	it("starts from a point and closes to a point", () => {
		const g = InkBuilder.fromPoints(straight(1, 0, 60, 0.7, 1.5), 6, "brush");
		const mid = g.nr[Math.floor(g.nodeCount / 2)]!;
		expect(g.nr[0]!).toBeLessThan(mid * 0.45);
		expect(g.nr[g.nodeCount - 1]!).toBeLessThan(g.nr[g.nodeCount - 4]! * 0.5);
	});

	it("never has a degenerate radius", () => {
		for (const tool of NEW_PENS) {
			const g = InkBuilder.fromPoints(handwriting(400, 3).map(([x, y]): Point => [x, y, 0]), 0.8, tool);
			for (let i = 0; i < g.nodeCount; i++) expect(g.nr[i]!).toBeGreaterThan(0);
		}
	});

	it("a tap draws a dot", () => {
		for (const tool of NEW_PENS) {
			const g = InkBuilder.fromPoints([[50, 50, 0.5]], 4, tool);
			expect(g.nodeCount).toBe(1);
			expect(g.nr[0]!).toBeGreaterThan(0.3);
		}
	});
});

describe("new pens: wet ink is the committed shape", () => {
	it.each(NEW_PENS)("%s: nodes already built never change as the stroke grows, and the committed path is the same chain", (tool) => {
		const pts = handwriting(260, 5);
		const nib = tool === "fountain" ? 110 : undefined;
		const live = new InkBuilder();
		live.reset(tool, 3, nib);
		let built = 0;
		let snap: { x: number[]; y: number[]; r: number[] } | null = null;
		for (let i = 0; i < pts.length; i++) {
			live.add(pts[i]![0], pts[i]![1], pts[i]![2]);
			if (i === 150) {
				built = live.nodeCount;
				snap = { x: Array.from(live.nx.subarray(0, built)), y: Array.from(live.ny.subarray(0, built)), r: Array.from(live.nr.subarray(0, built)) };
			}
		}
		live.finish();
		const committed = InkBuilder.fromPoints(live.toPoints(), 3, tool, undefined, nib);
		expect(committed.nodeCount).toBe(live.nodeCount);
		expect(Array.from(committed.nr.subarray(0, committed.nodeCount))).toEqual(Array.from(live.nr.subarray(0, live.nodeCount)));
		expect(Array.from(committed.nx.subarray(0, committed.nodeCount))).toEqual(Array.from(live.nx.subarray(0, live.nodeCount)));
		// The first 150 points' nodes are the same ones in the finished stroke (nothing already on screen moved).
		expect(snap).not.toBeNull();
		expect(Array.from(live.nr.subarray(0, built))).toEqual(snap!.r);
		expect(Array.from(live.nx.subarray(0, built))).toEqual(snap!.x);
		expect(Array.from(live.ny.subarray(0, built))).toEqual(snap!.y);
	});

	it.each(NEW_PENS)("%s: the provisional tip radius is the last stored point's", (tool) => {
		const g = new InkBuilder();
		g.reset(tool, 3);
		expect(g.tipRadius(0.5)).toBeGreaterThan(0);
		for (const p of handwriting(20, 2)) g.add(p[0], p[1], p[2]);
		expect(g.tipRadius(0.9)).toBe(g.pr[g.count - 1]);
	});

	it("an unchanged stroke path is deterministic and depends on the nib", () => {
		const pts = handwriting(120, 8);
		const d = (nib: number | undefined) => strokeSvgPath({ points: pts, width: 3, tool: "fountain", render: RENDER_INK, nib });
		expect(d(undefined)).toBe(d(45));
		expect(d(45)).toBe(d(45));
		expect(d(10)).not.toBe(d(45));
	});
});

describe("new pens: boxes and hit tests reach the whole line", () => {
	it.each(NEW_PENS)("%s: the bounding box of the stroke contains every disc", (tool) => {
		for (const seed of [1, 2, 3]) {
			for (const width of [0.8, 3, 10]) {
				const points = handwriting(150, seed).map(([x, y, p]): Point => [x, y, seed === 3 ? 1 : p]);
				const stroke: Stroke = { ...createStroke("#000000", width, points, tool, RENDER_INK) };
				const b = strokeBounds(stroke);
				const g = InkBuilder.fromPoints(points, width, tool);
				const e = inkBounds(g);
				// The smooth curve between two points can bulge a little beyond them (as the pen's does): a tolerance of 0.3 pt, far below the
				// 0.6 * width a missing reach would cost the brush.
				const tol = 0.3;
				expect(e.minX).toBeGreaterThanOrEqual(b.minX - tol);
				expect(e.minY).toBeGreaterThanOrEqual(b.minY - tol);
				expect(e.maxX).toBeLessThanOrEqual(b.maxX + tol);
				expect(e.maxY).toBeLessThanOrEqual(b.maxY + tol);
			}
		}
	});

	it("the old pens keep the box they always had", () => {
		for (const tool of ["pen", "highlighter", "shape"] as Tool[]) expect(inkReach(tool, 6)).toBe(3);
		expect(inkReach("fountain", 6)).toBeCloseTo(3.9, 9);
		expect(inkReach("brush", 6)).toBeCloseTo(4.8, 9);
		expect(inkReach("marker", 6)).toBe(3);
	});

	it("the eraser hits a thick brush stroke where it is thick, not far from it", () => {
		const points: Point[] = straight(1, 0, 40, 1, 2);
		const stroke: Stroke = createStroke("#000000", 10, points, "brush", RENDER_INK);
		const g = InkBuilder.fromPoints(points, 10, "brush");
		const maxR = Math.max(...Array.from(g.nr.subarray(0, g.nodeCount)));
		expect(maxR).toBeGreaterThan(5);
		// An eraser of radius 1 whose centre is 5.5 pt above the line: it touches the thick part of the outline (it reaches 4+ pt)...
		expect(strokeHit(stroke, 130, 100 - 5.5, 130, 100 - 5.5, 1)).toBe(true);
		// ... and not 30 pt away.
		expect(strokeHit(stroke, 130, 70, 130, 70, 1)).toBe(false);
		// Erasing a piece of it leaves two runs.
		const runs = eraseSegment(stroke, 130, 90, 130, 110, 2);
		expect(runs).not.toBeNull();
		expect(runs!.length).toBe(2);
	});

	it("a lasso, a move and an erase keep the tool and the nib of the stroke", () => {
		const s: Stroke = { ...createStroke("#102030", 4, straight(1, 1, 20), "fountain", RENDER_INK), nib: 70 };
		const moved = transformStroke(s, translate(10, 5));
		expect(moved).toMatchObject({ tool: "fountain", render: RENDER_INK, nib: 70 });
		const scaled = transformStroke(s, scaleAbout(2, 2, 0, 0));
		expect(scaled.nib).toBe(70);
		expect(scaled.width).toBe(8);
		const runs = eraseSegment({ ...s, points: straight(1, 0, 40, 0.5, 2) }, 140, 90, 140, 110, 2);
		expect(runs).not.toBeNull();
	});
});

describe("nib angle after a transform", () => {
	it("a move or a uniform scale leaves it, a rotation turns it, a flip mirrors it", () => {
		expect(nibAfter(45, translate(30, -4))).toBe(45);
		expect(nibAfter(45, scaleAbout(3, 3, 5, 5))).toBe(45);
		// The page turns clockwise by 90° (y grows downwards): a '/' nib becomes a '\' one.
		expect(nibAfter(45, rotateAbout(Math.PI / 2, 0, 0))).toBe(135);
		expect(nibAfter(0, rotateAbout(Math.PI / 2, 0, 0))).toBe(90);
		expect(nibAfter(45, rotateAbout(Math.PI, 0, 0))).toBe(45);
		expect(nibAfter(30, scaleAbout(-1, 1, 0, 0))).toBe(150);
		expect(nibAfter(90, scaleAbout(1, -1, 0, 0))).toBe(90);
	});

	it("a rotated stroke keeps its look: the same thick and thin parts follow the rotation", () => {
		const pts = straight(1, 1, 40);
		const s: Stroke = { ...createStroke("#000", 4, pts, "fountain", RENDER_INK) };
		const turned = transformStroke(s, rotateAbout(Math.PI / 2, 100, 100));
		const a = midRadius(s.points, "fountain", 4, s.nib);
		const b = midRadius(turned.points, "fountain", 4, turned.nib);
		expect(b).toBeCloseTo(a, 1);
	});

	it("a pen stroke is left as it is (no nib is invented)", () => {
		const s = createStroke("#000", 2, straight(1, 1, 5), "pen", RENDER_INK);
		expect("nib" in transformStroke(s, rotateAbout(1, 0, 0))).toBe(false);
		const f = createStroke("#000", 2, straight(1, 1, 5), "fountain", RENDER_INK);
		expect("nib" in transformStroke(f, translate(1, 1))).toBe(false);
	});
});

describe("new pens: the same look in every export", () => {
	function pageWith(tool: Tool, extra: Partial<Stroke> = {}) {
		const page = createPage();
		const s = { ...createStroke("#3366aa", 5, handwriting(120, 4), tool, RENDER_INK), ...extra };
		page.strokes.push(s);
		return { page, stroke: s };
	}

	/** Records the commands a path sink receives. */
	class Recorder implements PathSink {
		ops: string[] = [];
		moveTo(x: number, y: number): void { this.ops.push(`M${x},${y}`); }
		lineTo(x: number, y: number): void { this.ops.push(`L${x},${y}`); }
		arc(x: number, y: number, r: number): void { this.ops.push(`A${x},${y},${r}`); }
		closePath(): void { this.ops.push("Z"); }
	}

	it.each(NEW_PENS)("%s: SVG, canvas path and thumbnail path are one construction", (tool) => {
		const { page, stroke } = pageWith(tool, tool === "marker" ? { nib: 100 } : tool === "fountain" ? { nib: 20 } : {});
		const rec = new Recorder();
		inkPath(rec, stroke.points, stroke.width, stroke.tool, stroke.nib);
		const sink = new SvgPathSink();
		inkPath(sink, stroke.points, stroke.width, stroke.tool, stroke.nib);
		expect(sink.d.split("M").length - 1).toBe(rec.ops.filter((o) => o[0] === "M").length);
		expect(strokeSvgPath(stroke)).toBe(sink.d);
		expect(pageToSvg(page)).toContain(`d="${sink.d}"`);
		// Thumbnails at full detail are the same path.
		expect(lodSvgPath(stroke, stroke.width, 0)).toBe(sink.d);
	});

	it("a different nib is a different path in the SVG", () => {
		const a = pageWith("fountain", { nib: 10 }).page;
		const b = pageWith("fountain", { nib: 80 }).page;
		expect(pageToSvg(a)).not.toBe(pageToSvg(b));
	});

	it("the marker is 85% opaque and source-over everywhere; the highlighter and the pens are as before", () => {
		expect(MARKER_ALPHA).toBe(0.85);
		expect(inkAlpha("marker")).toBe(0.85);
		expect(inkAlpha("highlighter")).toBe(0.35);
		for (const t of ["pen", "shape", "fountain", "brush"] as Tool[]) expect(inkAlpha(t)).toBe(1);
		expect(inkBlend("marker")).toBe("source-over");
		expect(inkBlend("highlighter")).toBe("multiply");
		const svg = pageToSvg(pageWith("marker").page);
		expect(svg).toContain(`fill-opacity="${MARKER_ALPHA}"`);
		expect(svg).not.toContain("mix-blend-mode");
		const plain = pageToSvg(pageWith("fountain").page);
		expect(plain).not.toContain("fill-opacity");
	});

	it("the PDF draws the marker with its own graphics state and the others opaque", () => {
		const text = (pdf: Uint8Array) => new TextDecoder("latin1").decode(pdf);
		const marker = text(pagesToPdf([pageWith("marker").page]));
		expect(marker).toContain(`/ca ${MARKER_ALPHA}`);
		expect(marker).toContain("/GS3 gs");
		expect(marker).not.toContain("/Multiply");
		for (const tool of ["fountain", "brush"] as Tool[]) {
			const pdf = text(pagesToPdf([pageWith(tool).page]));
			expect(pdf).not.toContain("/GS3");
			expect(pdf).not.toContain(`/ca ${MARKER_ALPHA}`);
		}
	});

	it("the level-of-detail path is still the shape of the stroke", () => {
		const pts = handwriting(400, 6);
		for (const tool of NEW_PENS) {
			const nodes = lodNodes(pts, 3, tool, 2, 60);
			expect(nodes === null || nodes.length / 3 < InkBuilder.fromPoints(pts, 3, tool).nodeCount).toBe(true);
		}
	});

	it("every tool is accepted by the writer's strict check with the geometry it needs", () => {
		const page = createPage();
		page.strokes.push(...ALL_TOOLS.map((tool, i) => ({ ...createStroke("#000000", 2, handwriting(30, i + 1), tool, RENDER_INK), id: `s${i}` })));
		const doc = { format: "obsidian-notebook", version: 21, id: "d", createdAt: "2026-11-01T00:00:00.000Z", modifiedAt: "2026-11-01T00:00:00.000Z", pages: [page], meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {} } as const;
		expect(serializeChecked(doc as never, true).ok).toBe(true);
	});

	it("addInkPath makes the same chain for all of them (a path per run of nodes plus discs)", () => {
		for (const tool of NEW_PENS) {
			const rec = new Recorder();
			addInkPath(rec, InkBuilder.fromPoints(handwriting(200, 9), 3, tool));
			expect(rec.ops.length).toBeGreaterThan(10);
			expect(rec.ops.filter((o) => o === "Z").length).toBe(rec.ops.filter((o) => o[0] === "M").length);
		}
	});
});

describe("new pens: the cost of a point", () => {
	function writeStrokes(tool: Tool, strokes: number, samples: Point[]): number {
		const g = new InkBuilder();
		const t0 = performance.now();
		for (let k = 0; k < strokes; k++) {
			g.reset(tool, 2, 45);
			for (const s of samples) g.add(s[0], s[1], s[2]);
			g.finish();
		}
		return performance.now() - t0;
	}

	const SAMPLES = handwriting(720, 11);

	it("is no more than a small multiple of the pen's time per point", () => {
		// Warm up, then measure the best of three runs each (a loaded machine only makes a run slower).
		for (const t of ["pen", ...NEW_PENS] as Tool[]) writeStrokes(t, 3, SAMPLES);
		const best = (tool: Tool) => Math.min(writeStrokes(tool, 40, SAMPLES), writeStrokes(tool, 40, SAMPLES), writeStrokes(tool, 40, SAMPLES));
		const pen = best("pen");
		for (const tool of NEW_PENS) {
			const ms = best(tool);
			// 28,800 points: far below a millisecond per stroke of 720 points on any device, and close to the pen's time.
			expect(ms).toBeLessThan(Math.max(pen * 4, 40));
		}
	});

	/** Minor (scavenge) collections while `fn` runs, or null if GC entries cannot be observed. */
	async function scavenges(fn: () => void): Promise<number | null> {
		let n = 0;
		let obs: PerformanceObserver;
		try {
			obs = new PerformanceObserver((list) => {
				for (const e of list.getEntries()) if ((e as unknown as { detail?: { kind?: number } }).detail?.kind === 1) n++;
			});
			obs.observe({ entryTypes: ["gc"] });
		} catch {
			return null;
		}
		fn();
		await sleep(50);
		obs.disconnect();
		return n;
	}

	it.each(NEW_PENS)("%s: makes no garbage per sample (the radius is worked out into typed arrays)", async (tool) => {
		writeStrokes(tool, 3, SAMPLES);
		const fresh = await scavenges(() => writeStrokes(tool, 10, SAMPLES));
		if (fresh === null) return;
		// 7,200 samples; the pen's own pipeline measures 1 scavenge for the same work.
		expect(fresh).toBeLessThanOrEqual(2);
	}, 60_000);
});

describe("new pens: interactive HTML export", () => {
	it("embeds the same SVG, with the marker 85% opaque", async () => {
		const { htmlPage } = await import("../src/ink/export-html");
		const page = createPage();
		page.strokes.push({ ...createStroke("#15803d", 8, handwriting(80, 2), "marker", RENDER_INK), nib: 30 });
		page.strokes.push(createStroke("#1d4ed8", 4, handwriting(80, 3), "brush", RENDER_INK));
		const svg = pageToSvg(page);
		const html = htmlPage(0, 1, svg, "p");
		expect(html).toContain(strokeSvgPath(page.strokes[0]!));
		expect(html).toContain(strokeSvgPath(page.strokes[1]!));
		expect(html).toContain(`fill-opacity="${MARKER_ALPHA}"`);
	});
});
