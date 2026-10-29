// Reproducible benchmarks of the pure logic on a generated 10,000-stroke notebook: `npm run bench`.
// Rendering is measured in the app (command "Run performance benchmark"), where a real canvas exists.
import { expect, it } from "vitest";
import { findHitStrokes, strokeBounds, type BBox } from "../src/ink/hit-test";
import type { Stroke } from "../src/model/types";
import { strokesInLasso } from "../src/ink/lasso";
import { eraseSegment } from "../src/ink/segment-erase";
import { strokePath } from "../src/ink/stroke-shape";
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
	];
	const lines = [`file size ${(text.length / 1e6).toFixed(2)} MB`];
	for (const [name, fn] of rows) {
		const { mean, runs } = measure(fn);
		lines.push(`${name.padEnd(42)} ${mean.toFixed(mean < 1 ? 4 : 1).padStart(9)} ms  (${runs} runs)`);
	}
	console.log(`\n${lines.join("\n")}\n`);
	expect(serializeChecked(doc).ok).toBe(true);
});
