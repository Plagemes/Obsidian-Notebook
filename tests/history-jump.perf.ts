// A jump of many steps in the history panel (#84): `npm run bench`. Every step is an ordinary undo with the content guard, so a long jump costs
// steps x document size. This measures a 500-step jump to "Start" on notebooks of growing size, in one go and in the 60 ms slices the view uses
// (a slice is the longest the screen waits), and checks that the slices give the same document and the same result as one go.
import { expect, it } from "vitest";
import { JumpRunner, jumpHistory } from "../src/model/history-jump";
import { AddStroke, History } from "../src/model/history";
import { createStroke, quantizePoint } from "../src/model/document";
import { checkContent } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";

const SLICE_MS = 60;

function notebook(strokes: number, pages: number, steps: number) {
	const doc = stressDocument(strokes, pages);
	const history = new History(() => doc, 500, checkContent);
	for (let i = 0; i < steps; i++) {
		const page = doc.pages[i % doc.pages.length]!;
		const stroke = createStroke("#1e1e1e", 2, [quantizePoint(10 + i, 10, 0.5), quantizePoint(30 + i, 20, 0.5)]);
		expect(history.execute(new AddStroke(page.id, stroke, page.strokes.length))).toBe(true);
	}
	return { doc, history };
}

it("a 500-step jump to Start: in one go and in slices", () => {
	const rows: string[] = [];
	for (const [strokes, pages] of [[2_000, 10], [10_000, 30], [40_000, 60]] as const) {
		const whole = notebook(strokes, pages, 500);
		const t0 = performance.now();
		const all = jumpHistory(whole.history, { kind: "start" });
		const total = performance.now() - t0;
		expect(all.done).toBe(500);

		const sliced = notebook(strokes, pages, 500);
		const runner = new JumpRunner(sliced.history, { kind: "start" });
		let longest = 0;
		let slices = 0;
		while (!runner.finished) {
			const s0 = performance.now();
			runner.advance(SLICE_MS);
			longest = Math.max(longest, performance.now() - s0);
			slices++;
		}
		expect(runner.result()).toEqual(all);
		expect(sliced.doc.pages.map((p) => p.strokes.length)).toEqual(whole.doc.pages.map((p) => p.strokes.length));
		// The screen waits for one slice, never for the whole jump: a slice is the budget plus at most one step.
		expect(longest).toBeLessThan(SLICE_MS + 500);
		rows.push(`${strokes} strokes, ${pages} pages: ${total.toFixed(0)} ms in one go; ${slices} slices of at most ${longest.toFixed(0)} ms`);
	}
	console.log(rows.join("\n"));
});
