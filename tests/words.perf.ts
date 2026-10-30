// Word and line segmentation on dense synthetic pages: `npm run bench`.
import { expect, it } from "vitest";
import type { Stroke } from "../src/model/types";
import { segmentText, TextLayoutCache, wordAt } from "../src/ink/words";
import { reseed, writeLine } from "./words-gen";

function page(lines: number): Stroke[] {
	reseed(11);
	const text = "the quick brown fox jumps over the lazy dog and keeps writing more words";
	const out: Stroke[] = [];
	for (let i = 0; i < lines; i++) out.push(...writeLine(`L${i}`, text, { x: 20, baseY: 30 + i * 22, H: 10, letterGap: 0.1 }));
	return out;
}

function measure(fn: () => unknown, runs = 20): number {
	for (let i = 0; i < 3; i++) fn();
	const t0 = performance.now();
	for (let i = 0; i < runs; i++) fn();
	return (performance.now() - t0) / runs;
}

it("segments pages of 1,000 / 3,000 / 10,000 strokes quickly", () => {
	const rows: string[] = [];
	for (const lines of [18, 55, 180]) {
		const strokes = page(lines);
		const layout = segmentText(strokes);
		expect(layout.lines).toHaveLength(lines);
		const cold = measure(() => segmentText(strokes));
		const cache = new TextLayoutCache();
		cache.get(strokes);
		const warm = measure(() => cache.get(strokes), 200);
		const hit = measure(() => wordAt(layout, 300, 500, 8), 200);
		rows.push(`${String(strokes.length).padStart(6)} strokes: segment ${cold.toFixed(2)} ms · cache hit ${warm.toFixed(3)} ms · word lookup ${hit.toFixed(3)} ms`);
		// Generous bound (CI machines vary); the printed figures are the measurement.
		expect(cold).toBeLessThan(250);
	}
	console.debug(`\n${rows.join("\n")}\n`);
});
