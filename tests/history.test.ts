import { describe, expect, it } from "vitest";
import { AddStroke, EraseStrokes, History } from "../src/model/history";
import { line, sampleDocument } from "./helpers";

function setup(n = 0) {
	const doc = sampleDocument(n);
	const page = doc.pages[0]!;
	const history = new History(() => doc);
	const ids = () => page.strokes.map((s) => s.id);
	return { doc, page, history, ids };
}

describe("History", () => {
	it("undoes and redoes added strokes", () => {
		const { page, history, ids } = setup();
		const a = line(0, 0, 10, 10);
		const b = line(0, 20, 10, 30);
		history.execute(new AddStroke(page.id, a, 0));
		history.execute(new AddStroke(page.id, b, 1));
		expect(ids()).toEqual([a.id, b.id]);
		history.undo();
		expect(ids()).toEqual([a.id]);
		history.undo();
		expect(ids()).toEqual([]);
		expect(history.undo()).toBeNull();
		history.redo();
		history.redo();
		expect(ids()).toEqual([a.id, b.id]);
		expect(history.redo()).toBeNull();
	});

	it("restores erased strokes at their original positions", () => {
		const { page, history, ids } = setup(5);
		const before = ids();
		// Erase strokes 1 and 3 in one gesture, the way the eraser does (splice while moving).
		const s1 = page.strokes[1]!;
		page.strokes.splice(1, 1);
		const s3 = page.strokes[2]!;
		page.strokes.splice(2, 1);
		history.record(new EraseStrokes(page.id, [{ stroke: s1, index: 1 }, { stroke: s3, index: 2 }]));
		expect(ids()).toEqual([before[0], before[2], before[4]]);
		history.undo();
		expect(ids()).toEqual(before);
		history.redo();
		expect(ids()).toEqual([before[0], before[2], before[4]]);
	});

	it("a new command clears the redo stack", () => {
		const { page, history } = setup();
		history.execute(new AddStroke(page.id, line(0, 0, 1, 1), 0));
		history.undo();
		expect(history.canRedo()).toBe(true);
		history.execute(new AddStroke(page.id, line(0, 0, 2, 2), 0));
		expect(history.canRedo()).toBe(false);
	});

	it("keeps at most `limit` commands", () => {
		const doc = sampleDocument(0);
		const page = doc.pages[0]!;
		const history = new History(() => doc, 3);
		for (let i = 0; i < 5; i++) history.execute(new AddStroke(page.id, line(i, 0, i, 10), i));
		let undone = 0;
		while (history.undo()) undone++;
		expect(undone).toBe(3);
		expect(page.strokes).toHaveLength(2);
	});

	it("undoing a mixed sequence returns to the initial state", () => {
		const { page, history, ids } = setup(2);
		const initial = ids();
		history.execute(new AddStroke(page.id, line(5, 5, 50, 50), 2));
		const s0 = page.strokes[0]!;
		page.strokes.splice(0, 1);
		history.record(new EraseStrokes(page.id, [{ stroke: s0, index: 0 }]));
		history.execute(new AddStroke(page.id, line(1, 1, 2, 2), page.strokes.length));
		while (history.undo()) { /* undo everything */ }
		expect(ids()).toEqual(initial);
	});
});
