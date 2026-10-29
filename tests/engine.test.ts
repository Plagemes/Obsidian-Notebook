import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldTracker } from "../src/ink/hold";
import { isHold } from "../src/ink/recognize";
import { addCapsule, addInkPath, INK_STEP_PT, InkBuilder, inkPath, inkRadius, type PathSink } from "../src/ink/ink-geometry";
import { OneEuroFilter, stabilizationParams } from "../src/ink/one-euro";
import { isNewSample, SampleBuffer } from "../src/ink/pointer-controller";
import { PressureModel } from "../src/ink/pressure";
import { Stabilizer } from "../src/ink/stabilizer";
import { strokePath, strokeSvgPath } from "../src/ink/stroke-shape";
import { capsulesIn, emptyRect, isEmpty, pageBoxToDevice, unionInto, WetInk, type PageTransform } from "../src/ink/wet-ink";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import { createPage, createStroke } from "../src/model/document";
import { RENDER_FREEHAND, RENDER_INK, type Point } from "../src/model/types";
import { serialize } from "../src/model/serialize";
import { DocumentSession, type DocumentIO } from "../src/storage/session";
import { sampleDocument } from "./helpers";

/** Deterministic pseudo-random numbers. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

/** Handwriting-like samples: loops and direction changes, `hz` samples per second. */
function handwriting(n: number, hz: number, seed = 1): Array<{ x: number; y: number; p: number; t: number }> {
	const r = rng(seed);
	const out = [];
	for (let i = 0; i < n; i++) {
		const t = (i * 1000) / hz;
		const s = t / 1000;
		out.push({
			x: 100 + 60 * s * 4 + 18 * Math.sin(s * 14) + (r() - 0.5) * 0.3,
			y: 200 + 22 * Math.cos(s * 9) + 9 * Math.sin(s * 23) + (r() - 0.5) * 0.3,
			p: 0.35 + 0.3 * Math.sin(s * 5) ** 2,
			t,
		});
	}
	return out;
}

const snapshot = (g: InkBuilder) => ({
	x: Array.from(g.nx.subarray(0, g.nodeCount)),
	y: Array.from(g.ny.subarray(0, g.nodeCount)),
	r: Array.from(g.nr.subarray(0, g.nodeCount)),
});

describe("one-euro filter (stabilization)", () => {
	it("level 0 turns it off and passes points through", () => {
		expect(stabilizationParams(0)).toBeNull();
		const f = new OneEuroFilter(stabilizationParams(0));
		f.reset(0, 0, 0);
		f.filter(10, 5, 4);
		expect([f.x, f.y]).toEqual([10, 5]);
	});

	it("removes jitter when the pen is still, more at higher levels and more than the old stabilizer", () => {
		// RMS of the output around the true position, relative to the RMS of the raw jitter.
		const residual = (push: (x: number, y: number, t: number) => [number, number]) => {
			const r = rng(7);
			let out = 0, raw = 0;
			for (let i = 1; i < 960; i++) {
				const nx = r() - 0.5, ny = r() - 0.5;
				const [x, y] = push(50 + nx, 50 + ny, i * (1000 / 240));
				if (i > 100) {
					out += (x - 50) ** 2 + (y - 50) ** 2;
					raw += nx * nx + ny * ny;
				}
			}
			return Math.sqrt(out / raw);
		};
		const euro = (level: number) => {
			const f = new OneEuroFilter(stabilizationParams(level));
			f.reset(50, 50, 0);
			return (x: number, y: number, t: number): [number, number] => (f.filter(x, y, t), [f.x, f.y]);
		};
		const ema = (level: number) => {
			const s = new Stabilizer(level);
			s.reset(50, 50);
			return (x: number, y: number): [number, number] => s.push(x, y);
		};
		expect(residual(euro(2))).toBeLessThan(0.4);
		expect(residual(euro(2))).toBeLessThan(residual(ema(2)));
		expect(residual(euro(10))).toBeLessThan(residual(euro(2)) / 2);
		expect(residual(euro(10))).toBeLessThan(residual(ema(10)));
	});

	it("lags far less than the old exponential stabilizer while writing", () => {
		const lag = (hz: number, push: (x: number, t: number) => number) => {
			let worst = 0;
			for (let i = 1; i <= hz; i++) {
				const t = (i * 1000) / hz;
				const x = 0.5 * t; // 500 px/s
				const out = push(x, t);
				if (i > hz / 4) worst = Math.max(worst, x - out);
			}
			return worst;
		};
		for (const hz of [120, 240]) {
			const f = new OneEuroFilter(stabilizationParams(2));
			f.reset(0, 0, 0);
			const one = lag(hz, (x, t) => (f.filter(x, 0, t), f.x));
			const old = new Stabilizer(2);
			old.reset(0, 0);
			const ema = lag(hz, (x) => old.push(x, 0)[0]);
			expect(one).toBeLessThan(1.6);
			expect(one).toBeLessThan(ema);
		}
	});

	it("tolerates repeated and out-of-order timestamps", () => {
		const f = new OneEuroFilter(stabilizationParams(5));
		f.reset(0, 0, 10);
		f.filter(1, 1, 10);
		f.filter(2, 2, 5);
		expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
	});
});

describe("wet-ink geometry", () => {
	it("pen radius follows PEN_V1's pressure response; highlighter is constant", () => {
		expect(inkRadius("pen", 2, 0.5)).toBeCloseTo(1);
		expect(inkRadius("pen", 2, 1)).toBeCloseTo(1.6);
		expect(inkRadius("highlighter", 8, 0.1)).toBe(4);
	});

	it("passes through every stored point and keeps collinear points on the line", () => {
		const g = new InkBuilder();
		g.reset("pen", 2);
		for (let i = 0; i < 20; i++) g.add(i * 3.7, i * 1.85, 0.5);
		g.finish();
		const s = snapshot(g);
		for (let i = 0; i < s.x.length; i++) expect(s.y[i]!).toBeCloseTo(s.x[i]! / 2, 6);
		for (let k = 0; k < 20; k++) expect(s.x).toContain(Math.round(k * 3.7 * 100) / 100);
		// Long segments are subdivided.
		expect(g.nodeCount).toBeGreaterThan(19 * Math.floor(Math.hypot(3.7, 1.85) / INK_STEP_PT));
	});

	it("is causal: nodes on screen never change as the stroke grows or ends (no jump at pen-up)", () => {
		const g = new InkBuilder();
		g.reset("pen", 1.6);
		let prev = snapshot(g);
		for (const s of handwriting(600, 240)) {
			g.add(s.x, s.y, s.p);
			const now = snapshot(g);
			expect(now.x.slice(0, prev.x.length)).toEqual(prev.x);
			expect(now.y.slice(0, prev.y.length)).toEqual(prev.y);
			expect(now.r.slice(0, prev.r.length)).toEqual(prev.r);
			prev = now;
		}
		g.finish();
		const done = snapshot(g);
		expect(done.x.slice(0, prev.x.length)).toEqual(prev.x);
		// The saved points rebuild exactly the same geometry: what was painted is what is committed.
		const again = InkBuilder.fromPoints(g.toPoints(), 1.6, "pen");
		expect(snapshot(again)).toEqual(done);
	});

	it("ignores a point on top of the previous one without changing it", () => {
		const g = new InkBuilder();
		g.reset("pen", 2);
		g.add(1, 1, 0.2);
		expect(g.add(1.001, 1.002, 0.9)).toBe(false);
		expect(g.toPoints()).toEqual([[1, 1, 0.2]]);
	});

	it("a single point is a dot", () => {
		const g = InkBuilder.fromPoints([[5, 5, 0.5]], 2, "pen");
		expect(g.nodeCount).toBe(1);
		expect(g.nr[0]).toBeCloseTo(1);
	});

	it("the committed outline equals the union of the painted capsules (within antialiasing tolerance)", () => {
		// Wet ink paints every capsule (disc + trapezoid); the committed path is fewer, larger
		// polygons. Fill both with the nonzero rule on a fine grid and compare.
		const cases: Array<[number, number, number]> = [[240, 1.6, 0.5], [60, 5, 0.5], [240, 8, 0.15]];
		for (const [hz, width, scale] of cases) {
			const g = new InkBuilder();
			g.reset("pen", width);
			for (const s of handwriting(Math.round(hz * 0.7), hz, hz)) g.add(s.x * scale, s.y * scale, s.p);
			g.finish();
			const painted = new AreaSink();
			for (let i = 0; i < g.nodeCount; i++) addCapsule(painted, g.nx, g.ny, g.nr, i, true);
			painted.flush();
			const committed = new AreaSink();
			addInkPath(committed, g);
			committed.flush();
			// Far fewer discs (each is several curve segments to fill).
			expect(committed.arcs).toBeLessThan(painted.arcs * (width > 6 ? 0.7 : 0.34));
			const step = Math.min(0.06, width / 25);
			const a = fillNonzero(painted.polys, step);
			const b = fillNonzero(committed.polys, step, a.box);
			let ink = 0, mismatch = 0;
			for (let k = 0; k < a.mask.length; k++) {
				ink += a.mask[k]!;
				if (a.mask[k] !== b.mask[k]) mismatch++;
			}
			expect(ink).toBeGreaterThan(5000);
			expect(mismatch / ink).toBeLessThan(0.004);
		}
	}, 120_000);

	it("all subpaths have the same orientation, so a nonzero fill is their union", () => {
		const rec = new AreaSink();
		const g = InkBuilder.fromPoints([[0, 0, 0.2], [10, 3, 0.9], [4, 12, 0.5], [-6, 2, 0.1]], 3, "pen");
		for (let i = 0; i < g.nodeCount; i++) addCapsule(rec, g.nx, g.ny, g.nr, i, true);
		rec.flush();
		expect(rec.areas.length).toBeGreaterThan(g.nodeCount);
		for (const a of rec.areas) expect(a).toBeGreaterThan(0);
	});
});

describe("dirty rectangles", () => {
	const t: PageTransform = { k: 4, tx: 10, ty: -20, pageW: 600, pageH: 800 };

	it("maps a page box to device pixels with an antialiasing margin, clamped to the canvas", () => {
		const r = pageBoxToDevice(t, 1.1, 10, 2.6, 12.2, 1000, 1000, emptyRect());
		// x: 1.1·4 + 10 = 14.4 → 14 − 2; 2.6·4 + 10 = 20.4 → 21 + 2. y: 10·4 − 20 = 20 → 18; 12.2·4 − 20 = 28.8 → 29 + 2.
		expect(r).toEqual({ x0: 12, y0: 18, x1: 23, y1: 31 });
		const c = pageBoxToDevice(t, -100, -100, 1000, 1000, 300, 200, emptyRect());
		expect(c).toEqual({ x0: 0, y0: 0, x1: 300, y1: 200 });
		expect(isEmpty(pageBoxToDevice(t, 500, 500, 600, 600, 300, 200, emptyRect()))).toBe(true);
	});

	it("union grows to include both rectangles and ignores empty ones", () => {
		const a = emptyRect();
		unionInto(a, { x0: 5, y0: 5, x1: 10, y1: 10 });
		unionInto(a, { x0: 0, y0: 8, x1: 7, y1: 20 });
		unionInto(a, emptyRect());
		expect(a).toEqual({ x0: 0, y0: 5, x1: 10, y1: 20 });
	});

	it("finds exactly the capsules that meet a rectangle", () => {
		const g = InkBuilder.fromPoints(handwriting(300, 240).map((s): Point => [s.x, s.y, s.p]), 2, "pen");
		const rect = pageBoxToDevice(t, 140, 190, 150, 205, 4000, 4000, emptyRect());
		const found: number[] = [];
		capsulesIn(g, t, rect, (i) => found.push(i));
		expect(found.length).toBeGreaterThan(0);
		expect(found.length).toBeLessThan(g.nodeCount / 2);
		// Brute force: every capsule with a sample point inside the rectangle is found.
		for (let i = 1; i < g.nodeCount; i++) {
			for (let s = 0; s <= 4; s++) {
				const x = g.nx[i - 1]! + ((g.nx[i]! - g.nx[i - 1]!) * s) / 4;
				const y = g.ny[i - 1]! + ((g.ny[i]! - g.ny[i - 1]!) * s) / 4;
				const dx = x * t.k + t.tx, dy = y * t.k + t.ty;
				if (dx >= rect.x0 && dx <= rect.x1 && dy >= rect.y0 && dy <= rect.y1) expect(found).toContain(i);
			}
		}
	});
});

describe("wet ink painter", () => {
	function painter() {
		const ctx = new CountingContext();
		const canvas = { width: 4000, height: 4000 } as unknown as HTMLCanvasElement;
		const wet = new WetInk(canvas, ctx as unknown as CanvasRenderingContext2D);
		return { ctx, wet };
	}
	const t: PageTransform = { k: 4, tx: 0, ty: 0, pageW: 600, pageH: 800 };

	it("paints only what is new: the work per sample does not grow with the stroke", () => {
		const { ctx, wet } = painter();
		const g = new InkBuilder();
		g.reset("pen", 1.6);
		wet.begin(g, "pen", "#000000", t);
		const arcs: number[] = [];
		for (const s of handwriting(2000, 240)) {
			g.add(s.x, s.y, s.p);
			wet.clearExtra();
			wet.pushExtra(s.x + 0.3, s.y, s.p);
			ctx.arcs = 0;
			wet.paint();
			arcs.push(ctx.arcs);
		}
		const early = Math.max(...arcs.slice(50, 250));
		const late = Math.max(...arcs.slice(1750));
		// Each paint fills a handful of capsules (new ones, the old tip's neighbours, the new tip),
		// whether the stroke has 50 points or 2,000; a full redraw would be thousands of arcs.
		expect(late).toBeLessThan(60);
		expect(late).toBeLessThanOrEqual(early * 2 + 10);
		expect(ctx.fullClears).toBe(0);
	});

	it("at pen-up the tip is erased and the final segment painted; nothing remains provisional", () => {
		const { ctx, wet } = painter();
		const g = new InkBuilder();
		g.reset("pen", 2);
		wet.begin(g, "pen", "#000000", t);
		for (const s of handwriting(50, 240)) {
			g.add(s.x, s.y, s.p);
			wet.paint();
		}
		expect(isEmpty(wet.tipRect)).toBe(false);
		g.finish();
		wet.clearExtra();
		wet.paint();
		expect(isEmpty(wet.tipRect)).toBe(true);
		expect(isEmpty(wet.inkRect)).toBe(false);
		expect(ctx.clears).toBeGreaterThan(0);
	});
});

describe("allocations in the writing hot path", () => {
	/** Minor (scavenge) collections while `fn` runs, or null if GC entries cannot be observed. */
	async function scavenges(fn: () => void): Promise<number | null> {
		let n = 0;
		let obs: PerformanceObserver;
		try {
			obs = new PerformanceObserver((list) => {
				// Node: detail.kind 1 = minor GC (NODE_PERFORMANCE_GC_MINOR).
				for (const e of list.getEntries()) if ((e as unknown as { detail?: { kind?: number } }).detail?.kind === 1) n++;
			});
			obs.observe({ entryTypes: ["gc"] });
		} catch {
			return null;
		}
		fn();
		await new Promise((r) => setTimeout(r, 50));
		obs.disconnect();
		return n;
	}

	const SAMPLES = handwriting(720, 240, 11); // 3 s of writing at 240 Hz
	const STROKES = 10;

	/** The new pipeline, as NotebookView.writeSamples() drives it. */
	function newPipeline(): () => void {
		const f = new OneEuroFilter(stabilizationParams(2));
		const pressure = new PressureModel("auto");
		const hold = new HoldTracker();
		const g = new InkBuilder();
		const wet = new WetInk({ width: 4000, height: 4000 } as unknown as HTMLCanvasElement, new CountingContext() as unknown as CanvasRenderingContext2D);
		return () => {
			for (let k = 0; k < STROKES; k++) {
				g.reset("pen", 1.6);
				wet.begin(g, "pen", "#000000", { k: 2, tx: 0, ty: 0, pageW: 1e6, pageH: 1e6 });
				pressure.begin("pen", 0.3);
				f.reset(SAMPLES[0]!.x, SAMPLES[0]!.y, 0);
				for (const s of SAMPLES) {
					f.filter(s.x, s.y, s.t);
					const p = pressure.sample("pen", s.p, s.x, s.y, s.t);
					if (g.distanceToLast(f.x, f.y) >= 0.25) g.add(f.x, f.y, p);
					hold.push(s.x, s.y, s.t);
					wet.clearExtra();
					wet.pushExtra(s.x, s.y, p);
					wet.paint();
				}
				g.finish();
				wet.paint();
			}
		};
	}

	/** The old pipeline: sample objects, EMA stabilizer, and the whole outline rebuilt every frame (4 samples at 240 Hz). */
	function oldPipeline(): () => void {
		const stab = new Stabilizer(2);
		return () => {
			for (let k = 0; k < STROKES; k++) {
				const points: Point[] = [];
				stab.reset(SAMPLES[0]!.x, SAMPLES[0]!.y);
				SAMPLES.forEach((raw, i) => {
					const s = { x: raw.x, y: raw.y, pressure: raw.p, t: raw.t, pointerType: "pen" };
					const [x, y] = stab.push(s.x, s.y);
					points.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(s.pressure * 1000) / 1000]);
					if (i % 4 === 3) strokePath(points, 1.6, false, "pen");
				});
			}
		};
	}

	it("creates far less garbage per sample than the old pipeline", async () => {
		const run = newPipeline();
		run(); // warm up: grows the typed arrays, lets the JIT settle
		const fresh = await scavenges(run);
		if (fresh === null) return; // GC entries are not observable in this runtime
		const before = oldPipeline();
		before();
		const old = (await scavenges(before))!;
		// 7,200 samples. Measured on the dev PC (Node 24): new 1 scavenge, old 56.
		expect(old).toBeGreaterThan(20);
		expect(fresh).toBeLessThanOrEqual(Math.max(2, old / 50));
	}, 60_000);

	it("the sample buffer reuses its arrays", () => {
		const b = new SampleBuffer(4);
		const x = b.x;
		for (let k = 0; k < 3; k++) {
			b.clear("pen");
			for (let i = 0; i < 4; i++) b.push(i, i, 0.5, i);
		}
		expect(b.x).toBe(x);
		b.push(9, 9, 0.5, 9);
		expect(b.count).toBe(5);
		expect(b.x[4]).toBe(9);
	});
});

describe("input samples", () => {
	it("each sample is delivered once (pointerrawupdate and pointermove report the same samples)", () => {
		expect(isNewSample(10, 1, 1, 9, 5, 5)).toBe(false);
		expect(isNewSample(10, 1, 1, 10, 1, 1)).toBe(false);
		expect(isNewSample(10, 1, 1, 10, 2, 1)).toBe(true);
		expect(isNewSample(10, 1, 1, 11, 1, 1)).toBe(true);
	});

	it("the hold tracker agrees with isHold", () => {
		const r = rng(3);
		for (let trial = 0; trial < 50; trial++) {
			const h = new HoldTracker(48);
			const list: Array<{ x: number; y: number; t: number }> = [];
			for (let i = 0; i < 80; i++) {
				const s = { x: i < 40 ? i * 3 : 120 + r() * 6, y: r() * 6, t: i * 20 };
				h.push(s.x, s.y, s.t);
				list.push(s);
			}
			const now = 80 * 20 + r() * 400;
			expect(h.isHold(now, 600, 4)).toBe(isHold(list.slice(-48), now, 600, 4));
		}
	});
});

describe("render versions in exports", () => {
	const points: Point[] = [[10, 10, 0.4], [30, 14, 0.6], [50, 30, 0.5], [55, 60, 0.7]];

	it("render 1 keeps the perfect-freehand path; render 2 uses the wet-ink geometry", () => {
		const old = createStroke("#000000", 2, points, "pen", RENDER_FREEHAND);
		expect(strokeSvgPath(old)).toBe(strokePath(points, 2, true, "pen"));
		const ink = createStroke("#000000", 2, points, "pen", RENDER_INK);
		const d = strokeSvgPath(ink);
		expect(d).toMatch(/^M/);
		expect(d).toContain("A");
		const sink = new AreaSink();
		inkPath(sink, points, 2, "pen");
		expect(sink.subpaths).toBe((d.match(/M/g) ?? []).length);
	});

	it("SVG and PDF export draw render-2 strokes", () => {
		const page = createPage();
		page.strokes.push(createStroke("#112233", 2, points, "pen", RENDER_INK), createStroke("#ffee00", 8, points, "highlighter", RENDER_INK));
		const svg = pageToSvg(page);
		expect(svg).toContain('fill="#112233"');
		expect(svg).toMatch(/<path d="M[^"]*A/);
		const pdf = new TextDecoder("latin1").decode(pagesToPdf([page]));
		// Discs are written as cubic Béziers, the highlighter with its translucent graphics state.
		expect(pdf).toMatch(/ c /);
		expect(pdf).toContain("/GS1 gs");
	});
});

describe("saving waits for the pen", () => {
	class IO implements DocumentIO {
		content = serialize(sampleDocument(1));
		writes = 0;
		async read(): Promise<string> {
			return this.content;
		}
		async process(fn: (data: string) => string): Promise<void> {
			this.content = fn(this.content);
			this.writes++;
		}
		async backup(): Promise<string | null> {
			return "backup";
		}
	}
	const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number, clear: (h: number) => clearTimeout(h) };
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("does not save during a stroke or right after one, and saves once the pen rests", async () => {
		const io = new IO();
		let busy = false;
		const s = new DocumentSession(io, timers, {}, { busy: () => busy, debounceMs: 100 });
		await s.load();
		s.markChanged();
		s.gestureEnded();
		busy = true; // the next stroke starts 50 ms later
		await vi.advanceTimersByTimeAsync(300);
		expect(io.writes).toBe(0);
		busy = false;
		s.gestureEnded();
		await vi.advanceTimersByTimeAsync(200);
		expect(io.writes).toBe(0); // within the quiet period
		await vi.advanceTimersByTimeAsync(300);
		expect(io.writes).toBe(1);
	});

	it("an endless gesture cannot hold back saving forever", async () => {
		const io = new IO();
		const s = new DocumentSession(io, timers, {}, { busy: () => true, debounceMs: 100, maxBusyDeferMs: 2000 });
		await s.load();
		s.markChanged();
		await vi.advanceTimersByTimeAsync(1500);
		expect(io.writes).toBe(0);
		await vi.advanceTimersByTimeAsync(1000);
		expect(io.writes).toBe(1);
	});

	it("an explicit flush never waits", async () => {
		const io = new IO();
		const s = new DocumentSession(io, timers, {}, { busy: () => true });
		await s.load();
		s.markChanged();
		await s.flush();
		expect(io.writes).toBe(1);
	});
});

// --- helpers ---

/** Nonzero fill of polygons on a grid: 1 where the winding number is not 0. */
function fillNonzero(polys: Array<Array<[number, number]>>, step: number, box?: { x0: number; y0: number; w: number; h: number }) {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of polys) for (const [x, y] of p) {
		x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
	}
	const b = box ?? { x0: x0 - 1, y0: y0 - 1, w: Math.ceil((x1 - x0 + 2) / step), h: Math.ceil((y1 - y0 + 2) / step) };
	const wind = new Int16Array(b.w * b.h);
	for (const p of polys) {
		let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
		for (const [x, y] of p) {
			px0 = Math.min(px0, x); py0 = Math.min(py0, y); px1 = Math.max(px1, x); py1 = Math.max(py1, y);
		}
		const cy0 = Math.max(0, Math.floor((py0 - b.y0) / step)), cy1 = Math.min(b.h - 1, Math.ceil((py1 - b.y0) / step));
		const cx0 = Math.max(0, Math.floor((px0 - b.x0) / step)), cx1 = Math.min(b.w - 1, Math.ceil((px1 - b.x0) / step));
		for (let cy = cy0; cy <= cy1; cy++) {
			const y = b.y0 + (cy + 0.5) * step;
			for (let cx = cx0; cx <= cx1; cx++) {
				const x = b.x0 + (cx + 0.5) * step;
				let w = 0;
				for (let i = 0; i < p.length; i++) {
					const [ax, ay] = p[i]!;
					const [bx, by] = p[(i + 1) % p.length]!;
					if (ay <= y) {
						if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) w++;
					} else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) w--;
				}
				wind[cy * b.w + cx]! += w;
			}
		}
	}
	const mask = new Uint8Array(wind.length);
	for (let k = 0; k < wind.length; k++) mask[k] = wind[k] !== 0 ? 1 : 0;
	return { mask, box: b };
}

/** Records subpaths as polygons (arcs sampled) and their signed areas. */
class AreaSink implements PathSink {
	readonly areas: number[] = [];
	readonly polys: Array<Array<[number, number]>> = [];
	subpaths = 0;
	vertices = 0;
	arcs = 0;
	private cur: Array<[number, number]> = [];
	moveTo(x: number, y: number): void {
		this.flush();
		this.subpaths++;
		this.cur = [[x, y]];
	}
	lineTo(x: number, y: number): void {
		this.cur.push([x, y]);
	}
	arc(x: number, y: number, r: number, a0: number, a1: number): void {
		this.arcs++;
		for (let i = 0; i <= 32; i++) {
			const a = a0 + ((a1 - a0) * i) / 32;
			this.cur.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
		}
	}
	closePath(): void {}
	flush(): void {
		if (this.cur.length < 3) return;
		let area = 0;
		for (let i = 0; i < this.cur.length; i++) {
			const [x0, y0] = this.cur[i]!;
			const [x1, y1] = this.cur[(i + 1) % this.cur.length]!;
			area += x0 * y1 - x1 * y0;
		}
		this.areas.push(area / 2);
		this.polys.push(this.cur);
		this.vertices += this.cur.length;
		this.cur = [];
	}
}

/** Canvas context stand-in that counts the drawing calls. */
class CountingContext {
	arcs = 0;
	clears = 0;
	fullClears = 0;
	fillStyle = "";
	globalAlpha = 1;
	globalCompositeOperation = "source-over";
	save(): void {}
	restore(): void {}
	setTransform(): void {}
	beginPath(): void {}
	rect(): void {}
	clip(): void {}
	fill(): void {}
	moveTo(): void {}
	lineTo(): void {}
	closePath(): void {}
	arc(): void {
		this.arcs++;
	}
	clearRect(x: number, y: number, w: number, h: number): void {
		this.clears++;
		if (x <= 0 && y <= 0 && w >= 4000 && h >= 4000) this.fullClears++;
	}
}
