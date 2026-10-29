// Reproducible benchmarks of the pure logic on a generated 10,000-stroke notebook: `npm run bench`.
// Rendering is measured in the app (command "Run performance benchmark"), where a real canvas exists.
import { expect, it } from "vitest";
import { findHitStrokes, strokeBounds, type BBox } from "../src/ink/hit-test";
import type { Stroke } from "../src/model/types";
import { strokesInLasso } from "../src/ink/lasso";
import { eraseSegment } from "../src/ink/segment-erase";
import { InkBuilder, inkPath, type PathSink } from "../src/ink/ink-geometry";
import { OneEuroFilter, stabilizationParams } from "../src/ink/one-euro";
import { Stabilizer } from "../src/ink/stabilizer";
import { strokePath } from "../src/ink/stroke-shape";
import { syntheticWriting } from "../src/ink/writing-bench";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";

/** Runs `fn` repeatedly for about `budgetMs` after a warm-up and returns the mean time per call. */
function measure(fn: () => unknown, budgetMs = 400): { mean: number; runs: number } {
	for (let i = 0; i < 3; i++) fn();
	let runs = 0;
	const t0 = performance.now();
	while (performance.now() - t0 < budgetMs || runs < 5) {
		fn();
		runs++;
	}
	return { mean: (performance.now() - t0) / runs, runs };
}

const NULL_SINK: PathSink = { moveTo() {}, lineTo() {}, arc() {}, closePath() {} };

it("benchmarks (10,000 strokes, 10 pages; tools on 1,000 strokes of one page)", () => {
	const doc = stressDocument(10_000, 10);
	const text = serialize(doc);
	const page = doc.pages[0]!;
	// The app caches stroke bounds (Renderer.boundsOf); do the same here.
	const cache = new WeakMap<Stroke, BBox>();
	const boundsOf = (st: Stroke) => cache.get(st) ?? (cache.set(st, strokeBounds(st)), cache.get(st)!);
	const rows: Array<[string, () => unknown]> = [
		["serialize", () => serialize(doc)],
		["generate notebook", () => stressDocument(10_000, 10)],
		["generate + first save check (cold cache)", () => serializeChecked(stressDocument(10_000, 10))],
		["save check, next saves (cached strokes)", () => serializeChecked(doc)],
		["parse + validate (open)", () => parse(text)],
		["open + first save, cache not warmed yet", () => {
			const r = parse(text);
			if (r.ok) serializeChecked(r.doc);
		}],
		["eraser hit test, one move", () => findHitStrokes(page.strokes, 200, 300, 206, 304, 4, boundsOf)],
		["segment eraser, one cut", () => eraseSegment(page.strokes[10]!, 0, 0, 600, 800, 3)],
		["lasso selection, quarter page", () => strokesInLasso(page.strokes, [[0, 0], [300, 0], [300, 420], [0, 420]])],
		["stroke outline (perfect-freehand)", () => strokePath(page.strokes[0]!.points, 1.6)],
		["stroke path, wet-ink geometry (same points)", () => inkPath(NULL_SINK, page.strokes[0]!.points, 1.6, "pen")],
	];
	// Writing hot path on a 1.5 s stroke sampled at 240 Hz (360 samples).
	const pen = syntheticWriting(240, 1, 1.5, 100, 100)[0]!;
	const euro = new OneEuroFilter(stabilizationParams(2));
	const ema = new Stabilizer(2);
	const g = new InkBuilder();
	rows.push(
		["writing: 1€ filter, 360 samples", () => {
			euro.reset(pen[0]!.x, pen[0]!.y, pen[0]!.t);
			for (const s of pen) euro.filter(s.x, s.y, s.t);
		}],
		["writing: old EMA stabilizer, 360 samples", () => {
			ema.reset(pen[0]!.x, pen[0]!.y);
			for (const s of pen) ema.push(s.x, s.y);
		}],
		["writing: wet-ink geometry, 360 samples", () => {
			g.reset("pen", 1.6);
			for (const s of pen) g.add(s.x / 2, s.y / 2, s.p);
			g.finish();
		}],
		["writing: old per-frame outlines, 360 samples", () => {
			// The old live layer rebuilt the whole outline once per frame (every 4 samples at 240 Hz).
			const pts: Array<[number, number, number]> = [];
			pen.forEach((s, i) => {
				pts.push([s.x / 2, s.y / 2, s.p]);
				if (i % 4 === 3) strokePath(pts, 1.6, false, "pen");
			});
		}],
	);
	const lines = [`file size ${(text.length / 1e6).toFixed(2)} MB`];
	for (const [name, fn] of rows) {
		const { mean, runs } = measure(fn);
		lines.push(`${name.padEnd(42)} ${mean.toFixed(mean < 1 ? 4 : 1).padStart(9)} ms  (${runs} runs)`);
	}
	console.log(`\n${lines.join("\n")}\n`);
	expect(serializeChecked(doc).ok).toBe(true);
});
