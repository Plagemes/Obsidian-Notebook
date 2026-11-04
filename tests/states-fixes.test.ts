/**
 * 0.15 review fixes for drawings with states (format v13): the pieces an eraser leaves stay in their part (segment and area
 * eraser, one undo step), a margin change moves the parts' pivots with the ink, the state shown is the view's own choice,
 * and the live view of a page is cached.
 */
import { describe, expect, it } from "vitest";
import { createDocument, createId, createStroke } from "../src/model/document";
import { eraseAreaCommand } from "../src/ink/erase-area";
import { eraseSegment } from "../src/ink/segment-erase";
import { strokeBounds } from "../src/ink/hit-test";
import { Batch, History, ReplaceStroke, SetPageMargins, type Command } from "../src/model/history";
import { freezeStroke } from "../src/model/serialize";
import {
	addState, displacedStrokeIds, liveStateView, makePart, partOfStroke, replaceItem, shiftPivots, shownStateId, showsState, stateView,
	viewPages, withActive, withPose, writtenStates, type ShownStates,
} from "../src/model/states";
import { statesAfterCuts } from "../src/model/states-erase";
import type { NotebookDocument, Page, PageStates, Stroke } from "../src/model/types";

const stamp = "2026-11-04T10:00:00.000Z";

function seeded(seed: number): () => number {
	let x = seed;
	return () => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x / 2147483648;
	};
}

/** A long horizontal stroke (dense, so the eraser can cut it). */
function bar(id: string, x: number, y: number, length = 200): Stroke {
	const points: Array<[number, number, number]> = [];
	for (let i = 0; i <= length; i += 5) points.push([x + i, y, 0.5]);
	return freezeStroke({ ...createStroke("#111111", 2, points), id });
}

interface Fixture {
	doc: NotebookDocument;
	page: Page;
	arm: Stroke;
	leg: Stroke;
	label: Stroke;
	armPart: string;
	legPart: string;
	state: string;
}

/** A page with a part "Arm" (one long stroke), a part "Leg", an ordinary label, and a state that turns and scales the arm. */
function fixture(): Fixture {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	const arm = bar("arm", 100, 100);
	const leg = bar("leg", 100, 300);
	const label = bar("lab", 100, 500, 40);
	page.strokes.push(arm, leg, label);
	const a = makePart(undefined, [arm], "Arm", seeded(1))!;
	const l = makePart(a.states, [leg], "Leg", seeded(2))!;
	const s = addState(l.states, "Bent", null, seeded(3))!;
	let states = withPose(s.states, s.stateId, a.partId, { rot: 30, scale: 1.5, dx: 10 });
	states = withPose(states, s.stateId, l.partId, { dy: 40 });
	page.states = withActive(states, s.stateId);
	return { doc, page, arm, leg, label, armPart: a.partId, legPart: l.partId, state: s.stateId };
}

/** What the view's segment eraser does with one movement of the eraser on the page: cuts applied while the pen moves. */
function segmentCuts(doc: NotebookDocument, page: Page, targetId: string, ax: number, ay: number, bx: number, by: number, radius: number): ReplaceStroke[] {
	const cmds: ReplaceStroke[] = [];
	const stroke = page.strokes.find((s) => s.id === targetId)!;
	const runs = eraseSegment(stroke, ax, ay, bx, by, radius);
	if (runs === null) return cmds;
	const after = runs.map((points) => freezeStroke({ ...stroke, id: createId(), points }));
	const cmd = new ReplaceStroke(page.id, stroke, after, page.strokes.indexOf(stroke));
	cmd.apply(doc);
	cmds.push(cmd);
	return cmds;
}

/** The end of an eraser gesture as the view does it: the states command joins the cuts in one recorded batch. */
function endGesture(history: History, doc: NotebookDocument, cuts: Command[]): void {
	const kept = statesAfterCuts(doc, cuts);
	for (const c of kept) c.apply(doc);
	history.record(new Batch("Erase", [...cuts, ...kept]));
}

const itemsOf = (page: Page, partId: string): string[] => [...page.states!.parts.find((p) => p.id === partId)!.items];

describe("B1: the pieces an eraser leaves stay in their part", () => {
	it("segment eraser: the pieces of the cut stroke take its place in the part, in one undo step", () => {
		const f = fixture();
		const history = new History(() => f.doc);
		const before = f.page.states;
		const cuts = segmentCuts(f.doc, f.page, "arm", 190, 90, 210, 110, 8);
		expect(cuts).toHaveLength(1);
		const pieces = cuts[0]!.after;
		expect(pieces.length).toBe(2);
		endGesture(history, f.doc, cuts);

		expect(itemsOf(f.page, f.armPart)).toEqual(pieces.map((p) => p.id));
		for (const p of pieces) expect(partOfStroke(f.page.states, p.id)?.id).toBe(f.armPart);
		expect(itemsOf(f.page, f.legPart)).toEqual(["leg"]);
		// The table is what a save keeps: nothing left the part (the bug: the pieces were dropped at write).
		expect(writtenStates(f.page)!.parts.find((p) => p.id === f.armPart)!.items).toEqual(pieces.map((p) => p.id));
		// Both pieces are posed with the part in the state (a torn figure would leave one at its drawn place).
		const shown = stateView(f.page, f.state).strokes;
		for (const p of pieces) {
			const posed = shown.find((s) => s.id === p.id)!;
			expect(posed.points[0]).not.toEqual(p.points[0]);
		}
		expect(displacedStrokeIds(f.page)).toEqual(new Set([...pieces.map((p) => p.id), "leg"]));

		// One undo step puts the stroke and the table back, one redo the pieces and the table again.
		history.undo();
		expect(f.page.strokes.includes(f.arm)).toBe(true);
		expect(f.page.strokes.some((s) => s.id === pieces[0]!.id)).toBe(false);
		expect(f.page.states).toBe(before);
		history.redo();
		expect(itemsOf(f.page, f.armPart)).toEqual(pieces.map((p) => p.id));
		expect(f.page.strokes.map((s) => s.id)).toEqual([pieces[0]!.id, pieces[1]!.id, "leg", "lab"]);
		history.undo();
		history.redo();
		history.undo();
		expect(f.page.states).toBe(before);
	});

	it("segment eraser: a piece cut again in the same gesture stays in the part, and an erased-whole stroke is left alone", () => {
		const f = fixture();
		const history = new History(() => f.doc);
		const first = segmentCuts(f.doc, f.page, "arm", 190, 90, 210, 110, 8);
		const left = first[0]!.after[0]!;
		const second = segmentCuts(f.doc, f.page, left.id, 140, 90, 150, 110, 6);
		expect(second).toHaveLength(1);
		// A whole stroke erased (the label is no part; the leg is erased entirely by a wide eraser).
		const whole = segmentCuts(f.doc, f.page, "leg", 90, 290, 310, 310, 30);
		expect(whole[0]!.after).toHaveLength(0);
		endGesture(history, f.doc, [...first, ...second, ...whole]);

		const items = itemsOf(f.page, f.armPart);
		const ids = new Set(f.page.strokes.map((s) => s.id));
		expect(items.every((id) => ids.has(id))).toBe(true);
		expect(items.length).toBe(first[0]!.after.length - 1 + second[0]!.after.length);
		// The whole-erased stroke keeps its id in its part (the writer drops it; undo brings the stroke back into the part).
		expect(itemsOf(f.page, f.legPart)).toEqual(["leg"]);
		expect(writtenStates(f.page)!.parts.map((p) => p.id)).toEqual([f.armPart]);
		history.undo();
		expect(partOfStroke(f.page.states, "leg")?.id).toBe(f.legPart);
		expect(writtenStates(f.page)!.parts).toHaveLength(2);
	});

	it("segment eraser: ink that is no part, and a page without states, need no states command", () => {
		const f = fixture();
		const cuts = segmentCuts(f.doc, f.page, "lab", 110, 490, 120, 510, 6);
		expect(cuts).toHaveLength(1);
		expect(statesAfterCuts(f.doc, cuts)).toEqual([]);
		const plain = createDocument(new Date(stamp));
		const s = bar("x", 10, 10);
		plain.pages[0]!.strokes.push(s);
		const plainCuts = segmentCuts(plain, plain.pages[0]!, "x", 90, 0, 110, 20, 8);
		expect(statesAfterCuts(plain, plainCuts)).toEqual([]);
	});

	it("area eraser: the pieces of the cut stroke stay in the part, in the same batch (one undo step)", () => {
		const f = fixture();
		const history = new History(() => f.doc);
		const before = f.page.states;
		const cmd = eraseAreaCommand(f.page, [[180, 80], [220, 80], [220, 120], [180, 120]], { filter: { kind: "all", color: "#000000" }, includeElements: false })!;
		expect(cmd).not.toBeNull();
		const kept = statesAfterCuts(f.doc, [cmd]);
		expect(kept).toHaveLength(1);
		expect(history.execute(new Batch("Erase area", [cmd, ...kept]))).toBe(true);

		const arm = f.page.strokes.filter((s) => partOfStroke(f.page.states, s.id)?.id === f.armPart);
		expect(arm.length).toBe(2);
		expect(f.page.strokes.map((s) => s.id)).toEqual([...arm.map((s) => s.id), "leg", "lab"]);
		expect(writtenStates(f.page)!.parts.find((p) => p.id === f.armPart)!.items).toEqual(arm.map((s) => s.id));
		expect(showsState(f.page)).toBe(true);
		for (const piece of arm) expect(stateView(f.page, f.state).strokes.find((s) => s.id === piece.id)!.points[0]).not.toEqual(piece.points[0]);

		history.undo();
		expect(f.page.strokes.includes(f.arm)).toBe(true);
		expect(f.page.states).toBe(before);
		history.redo();
		expect(f.page.strokes.filter((s) => partOfStroke(f.page.states, s.id)?.id === f.armPart).length).toBe(2);
		history.undo();
		expect(f.page.states).toBe(before);
	});

	it("area eraser: the new ids of two strokes of different parts go to their own parts", () => {
		const f = fixture();
		const cmd = eraseAreaCommand(f.page, [[180, 80], [220, 80], [220, 320], [180, 320]], { filter: { kind: "all", color: "#000000" }, includeElements: false })!;
		const kept = statesAfterCuts(f.doc, [cmd]);
		expect(kept).toHaveLength(1);
		cmd.apply(f.doc);
		kept[0]!.apply(f.doc);
		expect(itemsOf(f.page, f.armPart).length).toBe(2);
		expect(itemsOf(f.page, f.legPart).length).toBe(2);
		expect(new Set([...itemsOf(f.page, f.armPart), ...itemsOf(f.page, f.legPart)]).size).toBe(4);
	});

	it("replaceItem keeps the order of the part and returns the same table when no part holds the id", () => {
		const f = fixture();
		const states = f.page.states!;
		expect(replaceItem(states, "nothing", ["a"])).toBe(states);
		expect(replaceItem(states, "arm", [])).toBe(states);
		expect(replaceItem(undefined, "arm", ["a"])).toBeUndefined();
		const next = replaceItem(states, "arm", ["a1", "a2"])!;
		expect(next.parts.find((p) => p.id === f.armPart)!.items).toEqual(["a1", "a2"]);
		expect(next.active).toBe(states.active);
		expect(Object.isFrozen(next)).toBe(true);
	});
});

describe("B2: a margin change moves the pivots with the ink", () => {
	it("shifts the pivot of a part that is rotated and scaled, so the posed figure moves as a whole", () => {
		const f = fixture();
		const history = new History(() => f.doc);
		const before = f.page.states!;
		const pivot = before.parts.find((p) => p.id === f.armPart)!.pivot;
		const posedBefore = stateView(f.page, f.state).strokes.find((s) => s.id === "arm")!.points.map((p) => [...p]);
		history.execute(new SetPageMargins(f.page.id, undefined, { left: 40, right: 0, bottom: 0 }));

		const part = f.page.states!.parts.find((p) => p.id === f.armPart)!;
		expect(part.pivot).toEqual([pivot[0] + 40, pivot[1]]);
		expect(f.page.states!.parts.find((p) => p.id === f.legPart)!.pivot[0]).toBe(before.parts.find((p) => p.id === f.legPart)!.pivot[0] + 40);
		// The pose is relative to the pivot and the ink moved by the same 40 pt: the posed figure is the old one, 40 pt to the right.
		const posedAfter = stateView(f.page, f.state).strokes.find((s) => s.id === "arm")!.points;
		expect(posedAfter).toHaveLength(posedBefore.length);
		posedAfter.forEach((p, i) => {
			expect(p[0]).toBeCloseTo(posedBefore[i]![0]! + 40, 1);
			expect(p[1]).toBeCloseTo(posedBefore[i]![1]!, 1);
		});
		// The names, items and poses are untouched.
		expect(f.page.states!.list).toBe(before.list);
		expect(part.items).toEqual(["arm"]);
	});

	it("undo puts the very same table back and redo shifts again; a change that moves nothing leaves it alone", () => {
		const f = fixture();
		const history = new History(() => f.doc);
		const before = f.page.states;
		history.execute(new SetPageMargins(f.page.id, undefined, { left: 25.5, right: 10, bottom: 0 }));
		expect(f.page.states).not.toBe(before);
		history.undo();
		expect(f.page.states).toBe(before);
		history.redo();
		expect(f.page.states!.parts[0]!.pivot[0]).toBeCloseTo(before!.parts[0]!.pivot[0] + 25.5, 5);
		history.undo();
		expect(f.page.states).toBe(before);
		// Right and bottom margins do not move the ink: the pivots stay.
		history.execute(new SetPageMargins(f.page.id, undefined, { left: 0, right: 50, bottom: 30 }));
		expect(f.page.states).toBe(before);
		history.undo();
		expect(f.page.states).toBe(before);
	});

	it("a page without states is unaffected, and in a batch with another page each keeps its own table", () => {
		const f = fixture();
		f.doc.pages.push({ ...f.doc.pages[0]!, id: "p2", strokes: [bar("q", 10, 10)] });
		delete f.doc.pages[1]!.states;
		const history = new History(() => f.doc);
		history.execute(new Batch("m", f.doc.pages.map((p) => new SetPageMargins(p.id, undefined, { left: 20, right: 0, bottom: 0 }))));
		expect(f.doc.pages[1]!.states).toBeUndefined();
		expect(f.page.states!.parts[0]!.pivot[0]).toBeGreaterThan(100);
		history.undo();
		expect(f.doc.pages[1]!.states).toBeUndefined();
		expect(bounds(f.page.strokes[0]!)).toEqual(bounds(f.arm));
	});

	it("shiftPivots rounds like the file and leaves tables without parts alone", () => {
		const f = fixture();
		const moved = shiftPivots(f.page.states, 0.004)!;
		expect(moved.parts[0]!.pivot[0]).toBe(f.page.states!.parts[0]!.pivot[0]);
		expect(shiftPivots(f.page.states, 0)).toBe(f.page.states);
		expect(shiftPivots(undefined, 5)).toBeUndefined();
		const empty: PageStates = { parts: [], list: [] };
		expect(shiftPivots(empty, 5)).toBe(empty);
	});
});

function bounds(s: Stroke): string {
	return JSON.stringify(strokeBounds(s));
}

describe("B3: the state shown is the view's own choice", () => {
	it("a choice that names a state the page no longer has shows the saved default", () => {
		const f = fixture();
		const shown: ShownStates = new Map([[f.page.id, "gone"]]);
		expect(shownStateId(f.page, shown)).toBe(f.state);
		expect(shownStateId(f.page, new Map([[f.page.id, null]]))).toBeNull();
		expect(shownStateId(f.page, new Map([[f.page.id, f.state]]))).toBe(f.state);
		expect(shownStateId(f.page)).toBe(f.state);
	});

	it("a view's choice does not touch the page: the saved active is the starting state of every view", () => {
		const f = fixture();
		const states = f.page.states!;
		const asDrawn: ShownStates = new Map([[f.page.id, null]]);
		const [mine] = viewPages(f.doc.pages, asDrawn);
		const [other] = viewPages(f.doc.pages);
		expect(mine!.strokes[0]).toBe(f.arm);
		expect(other!.strokes[0]).not.toBe(f.arm);
		expect(f.page.states).toBe(states);
		expect(f.page.states!.active).toBe(f.state);
		expect(withActive(states, null).active).toBeUndefined();
	});
});

describe("B5: the live view of a page is cached", () => {
	it("returns the same strokes until the page's ink changes, and follows ink added or erased", () => {
		const f = fixture();
		const view = liveStateView(f.page);
		const first = view.strokes;
		expect(view.strokes).toBe(first);
		expect(view.strokes).toBe(first);
		expect(liveStateView(f.page)).toBe(view);
		expect(first.find((s) => s.id === "arm")).not.toBe(f.arm);

		// Ink added: the shown strokes follow, and the copies of the unchanged parts are the very same objects.
		const extra = bar("extra", 10, 10, 20);
		f.page.strokes.push(extra);
		const second = view.strokes;
		expect(second).not.toBe(first);
		expect(second[second.length - 1]).toBe(extra);
		expect(second.find((s) => s.id === "arm")).toBe(first.find((s) => s.id === "arm"));
		expect(view.strokes).toBe(second);

		// Ink erased in place (the array is mutated): seen at once.
		f.page.strokes.splice(f.page.strokes.indexOf(extra), 1);
		expect(view.strokes.some((s) => s.id === "extra")).toBe(false);
		// A replaced stroke (same length, other object).
		const idx = f.page.strokes.indexOf(f.label);
		const moved = freezeStroke({ ...f.label, id: "lab2" });
		f.page.strokes[idx] = moved;
		expect(view.strokes.find((s) => s.id === "lab2")).toBe(moved);
	});

	it("follows a change of the table or of the shown state, and hands out the page's own strokes as drawn", () => {
		const f = fixture();
		const asDrawn: ShownStates = new Map([[f.page.id, null]]);
		const view = liveStateView(f.page, asDrawn);
		expect(view.strokes).toBe(f.page.strokes);
		expect(liveStateView(f.page)).not.toBe(view);
		const posed = liveStateView(f.page);
		const strokes = posed.strokes;
		expect(posed.strokes).toBe(strokes);
		f.page.states = withPose(f.page.states!, f.state, f.armPart, { dx: 99 });
		expect(posed.strokes).not.toBe(strokes);
		expect(posed.strokes.find((s) => s.id === "arm")!.points[0]![0]).toBeCloseTo(f.arm.points[0]![0] + 99, 0);
		expect(posed.width).toBe(f.page.width);
	});
});
