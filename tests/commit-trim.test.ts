/**
 * Wiring of "Trim hooks as you write" (review R1, R2, R3, R6): the step that follows the committed stroke, and taking a contact back
 * as a whole. `src/view/commit-trim.ts` is what the view calls, tested here with a real `History`.
 */
import { describe, expect, it } from "vitest";
import { trimAtPenUp } from "../src/ink/hook-clean";
import { createDocument, createStroke } from "../src/model/document";
import { AddStroke, History, type Command } from "../src/model/history";
import { pageTimes } from "../src/model/page-times";
import { RENDER_INK, type Point, type Stroke } from "../src/model/types";
import { commitTrim, isTrimStep, retractCommit, type Committed } from "../src/view/commit-trim";

function line(vertices: Array<[number, number]>): Point[] {
	const out: Point[] = [[vertices[0]![0], vertices[0]![1], 0.5]];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!;
		const [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
		for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, 0.5]);
	}
	return out;
}

const hooked = (): Stroke => Object.freeze({ ...createStroke("#111111", 2, line([[40, 50], [100, 50], [97.05, 50.52]]), "pen", RENDER_INK) });
const plain = (): Stroke => Object.freeze({ ...createStroke("#111111", 2, line([[40, 90], [100, 90]]), "pen", RENDER_INK) });

function scene() {
	const doc = createDocument();
	const page = doc.pages[0]!;
	const history = new History(() => doc, 500, null, null, null, null, () => 1_800_000_000_000);
	/** What the view does at pen-up: commit the raw stroke, then the trim worked out beforehand. */
	function penUp(raw: Stroke): { committed: Committed | null; step: Command | null; cut: Stroke | null } {
		const cut = trimAtPenUp(raw);
		const cmd = new AddStroke(page.id, raw, page.strokes.length);
		const committed: Committed | null = history.execute(cmd) ? { ids: new Set([raw.id]), cmd } : null;
		const step = cut ? commitTrim(history, page, raw.id, cut, committed) : null;
		return { committed, step, cut };
	}
	return { doc, page, history, penUp };
}

describe("pen-up trim wiring", () => {
	it("records the raw stroke, then the trim as its own step that holds the object the renderer drew", () => {
		const s = scene();
		const raw = hooked();
		const { committed, step, cut } = s.penUp(raw);
		expect(cut).not.toBeNull();
		expect(step).not.toBeNull();
		expect(committed?.trim).toBe(step);
		expect(isTrimStep(step)).toBe(true);
		expect(isTrimStep(committed?.cmd)).toBe(false);
		expect(s.page.strokes).toEqual([cut]);
		expect(s.page.strokes[0]).toBe(cut);
		expect(s.history.pending()).toEqual([committed!.cmd, step]);
		// One stamp, from the stroke itself.
		const times = JSON.stringify(pageTimes(s.page));
		expect(times).not.toBe("null");
		s.history.undo();
		expect(s.page.strokes[0]).toBe(raw);
		expect(JSON.stringify(pageTimes(s.page))).toBe(times);
	});

	it("records nothing more for a stroke without a hook", () => {
		const s = scene();
		const { committed, step, cut } = s.penUp(plain());
		expect(cut).toBeNull();
		expect(step).toBeNull();
		expect(committed?.trim).toBeUndefined();
		expect(s.history.pending()).toHaveLength(1);
	});

	it("a locked page records neither the stroke nor the trim", () => {
		const s = scene();
		s.page.locked = true;
		const { committed, step } = s.penUp(hooked());
		expect(committed).toBeNull();
		expect(step).toBeNull();
		expect(s.page.strokes).toHaveLength(0);
		expect(s.history.canUndo()).toBe(false);
	});

	it("uses the points of the trim on a committed object that is not the one that was drawn (slide link)", () => {
		const s = scene();
		const raw = hooked();
		const cut = trimAtPenUp(raw)!;
		const linked: Stroke = Object.freeze({ ...raw, slide: "sl1" });
		s.history.execute(new AddStroke(s.page.id, linked, 0));
		const step = commitTrim(s.history, s.page, raw.id, cut, null);
		expect(step).not.toBeNull();
		expect(s.page.strokes[0]!.slide).toBe("sl1");
		expect(s.page.strokes[0]!.points).toEqual(cut.points);
	});

	it("does nothing when the stroke is not on the page", () => {
		const s = scene();
		const raw = hooked();
		expect(commitTrim(s.history, s.page, raw.id, trimAtPenUp(raw)!, null)).toBeNull();
		expect(s.history.canUndo()).toBe(false);
	});
});

describe("taking a contact back", () => {
	it("a late side-button press undoes the trim and the stroke together", () => {
		const s = scene();
		const { committed } = s.penUp(hooked());
		const r = retractCommit(s.history, committed!);
		expect(r).toEqual({ ok: true, changed: true });
		expect(s.page.strokes).toHaveLength(0);
		expect(s.history.canUndo()).toBe(false);
	});

	it("also works without a trim", () => {
		const s = scene();
		const { committed } = s.penUp(plain());
		expect(retractCommit(s.history, committed!)).toEqual({ ok: true, changed: true });
		expect(s.page.strokes).toHaveLength(0);
	});

	it("does nothing when something else was done since, or a step waits to be redone", () => {
		const s = scene();
		const { committed } = s.penUp(hooked());
		s.penUp(plain());
		expect(retractCommit(s.history, committed!)).toEqual({ ok: false, changed: false });
		expect(s.page.strokes).toHaveLength(2);
		const t = scene();
		const again = t.penUp(hooked());
		t.history.undo();
		expect(retractCommit(t.history, again.committed!)).toEqual({ ok: false, changed: false });
		expect(t.page.strokes).toHaveLength(1);
	});

	it("reports a change when the second undo is refused, so the view still redraws and saves (R2)", () => {
		const trim: Command = { label: "trim", apply: () => undefined, revert: () => undefined };
		const add: Command = { label: "add", apply: () => undefined, revert: () => undefined };
		const stack: Command[] = [add, trim];
		const fake = {
			canRedo: () => false,
			pending: () => stack,
			undo: () => {
				const top = stack[stack.length - 1];
				if (top === trim) return stack.pop() ?? null;
				return null;
			},
		};
		const r = retractCommit(fake, { ids: new Set(["x"]), cmd: add, trim });
		expect(r).toEqual({ ok: false, changed: true });
	});
});
