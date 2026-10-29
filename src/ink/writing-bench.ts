import { createStroke, quantizePoint } from "../model/document";
import { freezeStroke } from "../model/serialize";
import { stressDocument } from "../model/stress";
import { RENDER_FREEHAND, RENDER_INK, type Point, type RenderVersion } from "../model/types";
import { InkBuilder } from "./ink-geometry";
import { layoutPages } from "./layout";
import { OneEuroFilter, stabilizationParams } from "./one-euro";
import { PressureModel } from "./pressure";
import { Renderer } from "./renderer";
import { Stabilizer } from "./stabilizer";
import { fitWidth } from "./viewport";

/**
 * Reproducible writing replay (in-app benchmark and the PC browser harness): synthetic pen
 * samples at 120 and 240 Hz, written on a page that already holds 2,000 strokes, through the old
 * pipeline (one rebuild of the whole stroke outline per frame on the live canvas) and the new one
 * (wet ink painted per input event). Everything is drawn off-screen; times are JavaScript time on
 * the main thread (the browser may rasterize later), so they are a lower bound for drawing.
 */

export interface PenSample {
	x: number;
	y: number;
	p: number;
	t: number;
}

/** Deterministic handwriting-like strokes in CSS px: loops, direction changes, pressure swings. */
export function syntheticWriting(hz: number, strokes: number, seconds: number, originX: number, originY: number): PenSample[][] {
	const out: PenSample[][] = [];
	let seed = 12345;
	const rand = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 0x100000000;
	};
	for (let k = 0; k < strokes; k++) {
		const n = Math.round(hz * seconds);
		const list: PenSample[] = [];
		const x0 = originX + (k % 5) * 120, y0 = originY + Math.floor(k / 5) * 60;
		for (let i = 0; i < n; i++) {
			const s = i / hz;
			list.push({
				x: x0 + 70 * s + 14 * Math.sin(s * 15 + k),
				y: y0 + 16 * Math.cos(s * 11 + k) + 6 * Math.sin(s * 27),
				p: 0.3 + 0.35 * Math.sin(s * 4 + k) ** 2 + (rand() - 0.5) * 0.02,
				t: 1000 + k * 2000 + (i * 1000) / hz,
			});
		}
		out.push(list);
	}
	return out;
}

interface MemoryInfo {
	usedJSHeapSize: number;
}

function heapMb(): number | null {
	const mem = (performance as Performance & { memory?: MemoryInfo }).memory;
	return mem ? mem.usedJSHeapSize / 1048576 : null;
}

function summary(a: number[], digits = 2): string {
	if (a.length === 0) return "–";
	const s = [...a].sort((x, y) => x - y);
	const avg = a.reduce((x, y) => x + y, 0) / a.length;
	const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
	return `avg ${avg.toFixed(digits)} · p95 ${p95.toFixed(digits)} · max ${s[s.length - 1]!.toFixed(digits)} ms`;
}

export interface WritingBenchOptions {
	width: number;
	height: number;
	dpr: number;
	log: (line: string) => void;
	pause: () => Promise<void>;
	/** Element the off-screen canvases are created in. */
	stage: HTMLElement;
}

/**
 * Forces the canvas' pending drawing to be rasterized (one pixel is read back). Used for the static
 * layer only: reading back a low-latency (desynchronized) canvas costs milliseconds by itself.
 */
function rasterize(c: HTMLCanvasElement): void {
	c.getContext("2d")?.getImageData(0, 0, 1, 1);
}

/** Old pressure model: an object per sample (as before this engine). */
class OldPressure {
	private last: { x: number; y: number; t: number } | null = null;
	private sim = 0.5;
	sample(x: number, y: number, t: number): number {
		const prev = this.last;
		this.last = { x, y, t };
		if (!prev) return this.sim;
		const speed = Math.hypot(x - prev.x, y - prev.y) / Math.max(1, t - prev.t);
		this.sim += ((1 - Math.min(speed, 3) / 3 * 0.7) * 0.8 + 0.1 - this.sim) * 0.3;
		return this.sim;
	}
}

export async function runWritingBench(o: WritingBenchOptions): Promise<void> {
	const { width, height, dpr, log, pause, stage } = o;
	const frameMs = 1000 / 60;

	for (const render of [RENDER_FREEHAND, RENDER_INK] as RenderVersion[]) {
		const doc = stressDocument(2000, 1, 42, render);
		const layout = layoutPages(doc.pages);
		const renderer = new Renderer(stage);
		try {
			renderer.resize(width, height, dpr);
			renderer.setDocument(doc.pages, layout);
			renderer.setViewport(fitWidth({ width, height }, layout));
			renderer.renderNow();
			rasterize(renderer.staticCanvas);
			const js: number[] = [];
			const raster: number[] = [];
			for (let i = 0; i < 20; i++) {
				const a = performance.now();
				renderer.renderNow();
				const b = performance.now();
				rasterize(renderer.staticCanvas);
				js.push(b - a);
				raster.push(performance.now() - a);
			}
			log(`Static redraw, 2,000 strokes, render ${render}: JavaScript ${summary(js, 1)}; with rasterization ${summary(raster, 1)}`);
		} finally {
			renderer.destroy();
			stage.empty();
		}
		await pause();
	}

	for (const hz of [120, 240]) {
		const strokes = syntheticWriting(hz, 10, 1.5, 60, 80);
		const total = strokes.reduce((a, s) => a + s.length, 0);
		log(`— Writing replay at ${hz} Hz (JavaScript time): ${strokes.length} strokes, ${total} samples, page with 2,000 strokes —`);
		for (const pipeline of ["old", "new"] as const) {
			const doc = stressDocument(2000, 1);
			const page = doc.pages[0]!;
			const layout = layoutPages(doc.pages);
			const renderer = new Renderer(stage);
			try {
				renderer.resize(width, height, dpr);
				renderer.setDocument(doc.pages, layout);
				const v = fitWidth({ width, height }, layout);
				renderer.setViewport(v);
				renderer.renderNow();
				const box = layout.boxes[0]!;
				const toLocal = (x: number, y: number): [number, number] => [(x - v.offsetX) / v.scale - box.x, (y - v.offsetY) / v.scale - box.y];
				const perSample: number[] = [];
				const perFrame: number[] = [];
				const latency: number[] = [];
				const commit: number[] = [];
				const heap0 = heapMb();
				const t0 = performance.now();
				for (const list of strokes) {
					if (pipeline === "old") {
						const stab = new Stabilizer(2);
						const pressure = new OldPressure();
						const first = toLocal(list[0]!.x, list[0]!.y);
						stab.reset(first[0], first[1]);
						const stroke = createStroke("#1e1e1e", 1.6, [], "pen", RENDER_FREEHAND);
						const perFrameSamples = Math.max(1, Math.round(hz * frameMs / 1000));
						for (let i = 0; i < list.length; i += perFrameSamples) {
							// pointermove is aligned to frames: one event carries the frame's coalesced samples.
							const a = performance.now();
							const batch = list.slice(i, i + perFrameSamples).map((s) => ({ x: s.x, y: s.y, pressure: s.p, t: s.t, pointerType: "pen" }));
							for (const s of batch) {
								const local = toLocal(s.x, s.y);
								const [sx, sy] = stab.push(local[0], local[1]);
								stroke.points.push(quantizePoint(sx, sy, pressure.sample(s.x, s.y, s.t)));
							}
							const b = performance.now();
							renderer.setLive({ pageIndex: 0, tool: "pen", color: stroke.color, width: stroke.width, points: stroke.points, predicted: [] });
							renderer.renderLiveNow();
							const c = performance.now();
							perSample.push((b - a) / batch.length);
							perFrame.push(c - b);
							// A sample waits on average half a frame for the frame-aligned event, then the frame's work.
							for (let k = 0; k < batch.length; k++) latency.push(frameMs * (1 - (k + 0.5) / batch.length) + (c - a));
						}
						const a = performance.now();
						const frozen = freezeStroke({ ...stroke, points: [...stroke.points, ...stab.finish().map(([x, y]): Point => quantizePoint(x, y, 0.5))] });
						renderer.setLive(null);
						page.strokes.push(frozen);
						renderer.appendStroke(0, frozen);
						renderer.renderLiveNow();
						commit.push(performance.now() - a);
					} else {
						const filter = new OneEuroFilter(stabilizationParams(2));
						const pressure = new PressureModel("auto");
						const g = new InkBuilder();
						const s0 = list[0]!;
						filter.reset(s0.x, s0.y, s0.t);
						pressure.begin("pen", s0.p);
						g.reset("pen", 1.6);
						const minStep = 0.5 / v.scale;
						renderer.beginWet(0, g, "pen", "#1e1e1e");
						const wet = renderer.wetInk!;
						let rawX = 0, rawY = 0, rawP = 0.5;
						for (const s of list) {
							// pointerrawupdate: one event per sample, painted in the handler.
							const a = performance.now();
							filter.filter(s.x, s.y, s.t);
							const fx = (filter.x - v.offsetX) / v.scale - box.x, fy = (filter.y - v.offsetY) / v.scale - box.y;
							rawX = (s.x - v.offsetX) / v.scale - box.x;
							rawY = (s.y - v.offsetY) / v.scale - box.y;
							rawP = pressure.sample("pen", s.p, s.x, s.y, s.t);
							if (g.distanceToLast(fx, fy) >= minStep) g.add(fx, fy, rawP);
							wet.clearExtra();
							wet.pushExtra(rawX, rawY, rawP);
							renderer.paintWet();
							const b = performance.now();
							perSample.push(b - a);
							latency.push(b - a);
						}
						const a = performance.now();
						g.add(rawX, rawY, rawP);
						g.finish();
						const frozen = freezeStroke({ ...createStroke("#1e1e1e", 1.6, [], "pen", RENDER_INK), points: g.toPoints() });
						renderer.endWet(frozen);
						page.strokes.push(frozen);
						renderer.appendStroke(0, frozen);
						commit.push(performance.now() - a);
					}
					await pause();
				}
				const wall = performance.now() - t0;
				const heap1 = heapMb();
				log(`${pipeline === "old" ? "Old (per-frame outline)" : "New (wet ink per event)"}:`);
				log(`  work per sample: ${summary(perSample, 3)}`);
				log(`  per frame: ${pipeline === "old" ? summary(perFrame) : "none (nothing waits for a frame)"}`);
				log(`  input→paint estimate: ${summary(latency)} (${pipeline === "old" ? "half-frame alignment + frame work" : "handler work; samples via pointerrawupdate"}, display latency not included)`);
				log(`  pen-up commit: ${summary(commit)}`);
				log(`  wall time ${wall.toFixed(0)} ms${heap0 !== null && heap1 !== null ? `, JS heap ${heap0.toFixed(1)} → ${heap1.toFixed(1)} MB` : ""}`);
			} finally {
				renderer.destroy();
				stage.empty();
			}
			await pause();
		}
	}
}
