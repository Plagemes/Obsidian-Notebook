import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { AddStroke, Batch, History } from "../src/model/history";
import { line, sampleDocument } from "./helpers";

function setup(strokes = 0) {
	const doc = sampleDocument(strokes);
	const second = createPage();
	doc.pages.push(second);
	const refused: string[][] = [];
	const history = new History(() => doc, 500, null, null, null, (ids) => refused.push([...ids]));
	return { doc, first: doc.pages[0]!, second, history, refused };
}

describe("History.group (one undo step for a macro run)", () => {
	it("makes the steps recorded inside it one undo step, undone and redone together", () => {
		const { first, second, history } = setup();
		const a = line(0, 0, 10, 10);
		const b = line(0, 20, 10, 30);
		const c = line(0, 40, 10, 50);
		history.group("Run macro", () => {
			history.execute(new AddStroke(first.id, a, 0));
			history.execute(new AddStroke(second.id, b, 0));
			history.execute(new AddStroke(first.id, c, 1));
		});
		expect(history.depth()).toEqual({ undo: 1, redo: 0 });
		const entry = history.entries().undo[0]!;
		expect(entry.cmd).toBeInstanceOf(Batch);
		expect((entry.cmd as Batch).label).toBe("Run macro");
		expect((entry.cmd as Batch).commands).toHaveLength(3);
		history.undo();
		expect(first.strokes).toHaveLength(0);
		expect(second.strokes).toHaveLength(0);
		history.redo();
		expect(first.strokes.map((s) => s.id)).toEqual([a.id, c.id]);
		expect(second.strokes.map((s) => s.id)).toEqual([b.id]);
	});

	it("keeps the steps before the group untouched and the one after separate", () => {
		const { first, history } = setup();
		history.execute(new AddStroke(first.id, line(0, 0, 5, 5), 0));
		history.group("Run macro", () => {
			history.execute(new AddStroke(first.id, line(0, 10, 5, 15), 1));
			history.execute(new AddStroke(first.id, line(0, 20, 5, 25), 2));
		});
		history.execute(new AddStroke(first.id, line(0, 30, 5, 35), 3));
		expect(history.depth().undo).toBe(3);
		history.undo();
		history.undo();
		expect(first.strokes).toHaveLength(1);
	});

	it("leaves a single step, or none, as it is", () => {
		const { first, history } = setup();
		history.group("Run macro", () => undefined);
		expect(history.depth().undo).toBe(0);
		const only = new AddStroke(first.id, line(0, 0, 5, 5), 0);
		history.group("Run macro", () => history.execute(only));
		expect(history.entries().undo[0]!.cmd).toBe(only);
	});

	it("does not keep a refused step in the group, and the page lock still refuses it", () => {
		const { first, second, history, refused } = setup();
		second.locked = true;
		history.group("Run macro", () => {
			expect(history.execute(new AddStroke(first.id, line(0, 0, 5, 5), 0))).toBe(true);
			expect(history.execute(new AddStroke(second.id, line(0, 10, 5, 15), 0))).toBe(false);
			expect(history.execute(new AddStroke(first.id, line(0, 20, 5, 25), 1))).toBe(true);
		});
		expect(refused).toEqual([[second.id]]);
		expect(second.strokes).toHaveLength(0);
		expect(first.strokes).toHaveLength(2);
		expect(history.depth().undo).toBe(1);
		history.undo();
		expect(first.strokes).toHaveLength(0);
	});

	it("still makes one step when a step in the middle throws, and rethrows", () => {
		const { first, history } = setup();
		expect(() => history.group("Run macro", () => {
			history.execute(new AddStroke(first.id, line(0, 0, 5, 5), 0));
			history.execute(new AddStroke(first.id, line(0, 10, 5, 15), 1));
			throw new Error("boom");
		})).toThrow("boom");
		expect(history.depth().undo).toBe(1);
		history.undo();
		expect(first.strokes).toHaveLength(0);
	});

	it("a group inside a group belongs to the outer one; an undo inside leaves the steps separate", () => {
		const { first, history } = setup();
		history.group("outer", () => {
			history.execute(new AddStroke(first.id, line(0, 0, 5, 5), 0));
			history.group("inner", () => history.execute(new AddStroke(first.id, line(0, 10, 5, 15), 1)));
		});
		expect(history.depth().undo).toBe(1);
		expect((history.entries().undo[0]!.cmd as Batch).label).toBe("outer");
		const again = setup();
		again.history.group("Run macro", () => {
			again.history.execute(new AddStroke(again.first.id, line(0, 0, 5, 5), 0));
			again.history.execute(new AddStroke(again.first.id, line(0, 10, 5, 15), 1));
			again.history.undo();
		});
		expect(again.history.depth().undo).toBe(1);
		expect(again.first.strokes).toHaveLength(1);
	});

	it("does nothing in a read-only history", () => {
		const doc = sampleDocument(0);
		const history = new History(() => doc, 500, null, null, () => true);
		history.group("Run macro", () => {
			expect(history.execute(new AddStroke(doc.pages[0]!.id, line(0, 0, 5, 5), 0))).toBe(false);
		});
		expect(history.depth().undo).toBe(0);
	});
});
