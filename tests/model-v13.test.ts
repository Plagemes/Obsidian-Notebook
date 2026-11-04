/**
 * Format v13: drawings with states (#241) — the page table `states` (parts of strokes and the states that move them),
 * the v12 -> v13 migration, lenient read and strict write, pruning, staged loading, the render-time transform, undo/redo,
 * copies, page trash and moves, conflicted-copy merge and repair.
 */
import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { AddStroke, Batch, History, ReplaceStroke } from "../src/model/history";
import { planPageMove } from "../src/library/page-move";
import { planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { addEntry, emptyPageTrash, makeEntry, planPageTrashRestore } from "../src/model/page-trash";
import { duplicatePage } from "../src/model/pages";
import { planPageRestore } from "../src/model/page-restore";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, freezeStroke, parse, parseStaged, readPageStates, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import {
	activeState, addState, deleteState, displacedStrokeIds, dissolvePart, freshStateName, makePart, partOfStroke, poseFromMatrix, poseMatrix,
	remapStates, renamePart, renameState, SetPageStates, showsState, stateView, steppedState, viewPages, withActive, withPose, withoutItems, writtenStates,
} from "../src/model/states";
import { normalizePageStates, statesLine } from "../src/model/states-format";
import { stressDocument } from "../src/model/stress";
import { CURRENT_VERSION, FORMAT_ID, type NotebookDocument, type PageStates, type Stroke } from "../src/model/types";
import { apply as applyMatrix } from "../src/ink/transform";
import { transformStroke } from "../src/ink/lasso";
import { getAt, setAt, type Raw } from "./raw-json";

const stamp = "2026-11-04T10:00:00.000Z";

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function seeded(seed: number): () => number {
	let x = seed;
	return () => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x / 2147483648;
	};
}

function stroke(id: string, x: number, y: number, color = "#111111"): Stroke {
	return freezeStroke({ ...createStroke(color, 2, [[x, y, 0.5], [x + 40, y, 0.5], [x + 40, y + 20, 0.5]]), id });
}

/** A page with a block (two strokes), a spring (one stroke) and a label that is not a part; states "Start" and "End". */
function physicsDoc(): { doc: NotebookDocument; start: string; end: string; block: string; spring: string } {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.strokes.push(stroke("b1", 100, 100), stroke("b2", 100, 130), stroke("sp", 200, 100), stroke("lab", 300, 300));
	const block = makePart(undefined, page.strokes.slice(0, 2), "Block", seeded(1))!;
	const spring = makePart(block.states, [page.strokes[2]!], "Spring", seeded(2))!;
	const s1 = addState(spring.states, "Start", null, seeded(3))!;
	const s2 = addState(s1.states, "End", s1.stateId, seeded(4))!;
	let states = withPose(s2.states, s2.stateId, block.partId, { dx: 120, rot: 15 });
	states = withPose(states, s2.stateId, spring.partId, { scale: 2, color: "#ff0000" });
	states = withActive(states, s1.stateId);
	page.states = states;
	return { doc, start: s1.stateId, end: s2.stateId, block: block.partId, spring: spring.partId };
}

function v12Raw(): Raw {
	return {
		format: FORMAT_ID, version: 12, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			strokes: [
				{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] },
				{ id: "s2", tool: "pen", color: "#111111", width: 2, render: 1, points: [[5, 6, 0.5], [7, 8, 0.5]] },
			],
		}],
	};
}

const OK_STATES = { parts: [{ id: "pa", name: "Block", pivot: [10, 20], items: ["s1"] }], list: [{ id: "st", name: "End", poses: [{ part: "pa", dx: 5 }] }], active: "st" };

describe("format v13: migration", () => {
	it("is at version 13 with a v12 step", () => {
		expect(CURRENT_VERSION).toBe(13);
		expect(MIGRATIONS[12]).toBeTypeOf("function");
	});

	it("reads a v12 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v12Raw()));
		expect(r.migratedFrom).toBe(12);
		expect(r.doc.version).toBe(13);
		expect(r.doc.pages[0]!.states).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("drops a states key found in a v12 file (a v12 reader ignored it, so it was never ours)", () => {
		const raw = v12Raw();
		setAt(raw, ["pages", 0, "states"], OK_STATES);
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.states).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("migrates a v12 round trip: v12 text -> v13 document -> text has no states and the same ink", () => {
		const doc = parsed(JSON.stringify(v12Raw())).doc;
		const text = serialize(doc);
		expect(text).toContain(`"version": 13`);
		expect(text).not.toContain('"states"');
		expect(parsed(text).doc.pages[0]!.strokes).toHaveLength(2);
	});

	it("is refused by 0.14 and older as a newer format (they read up to v12, so v13 opens read-only and is never overwritten)", () => {
		const text = serialize(physicsDoc().doc).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		const r = parse(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
		// What 0.14 does with a v13 file is what the current code does with the next version: the same "future-version" path.
		expect(serialize(physicsDoc().doc)).toContain(`"version": 13`);
	});
});

describe("format v13: write and read", () => {
	it("round-trips a drawing with states byte for byte", () => {
		const { doc } = physicsDoc();
		const text = serialize(doc);
		expect(text).toContain('"states": {"parts"');
		const back = parsed(text).doc;
		expect(back.pages[0]!.states).toEqual(doc.pages[0]!.states);
		expect(serialize(back)).toBe(text);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("writes the states on one line of the page (the repair line scan finds them)", () => {
		const text = serialize(physicsDoc().doc);
		const lines = text.split("\n").filter((l) => l.startsWith('\t\t\t"states"'));
		expect(lines).toHaveLength(1);
	});

	it("keeps the active state across a save", () => {
		const { doc, start } = physicsDoc();
		const back = parsed(serialize(doc)).doc;
		expect(activeState(back.pages[0]!)?.id).toBe(start);
	});

	it("prunes on write: erased strokes leave their part, an empty part goes with its poses, identity poses go", () => {
		const { doc, block, spring } = physicsDoc();
		const page = doc.pages[0]!;
		page.strokes = page.strokes.filter((s) => s.id !== "sp" && s.id !== "b2"); // the spring is gone, the block keeps b1
		const back = parsed(serialize(doc)).doc.pages[0]!;
		expect(back.states!.parts.map((p) => p.id)).toEqual([block]);
		expect(back.states!.parts[0]!.items).toEqual(["b1"]);
		for (const st of back.states!.list) expect(st.poses.every((p) => p.part !== spring)).toBe(true);
		// identity poses
		page.states = withPose(page.states!, page.states!.list[0]!.id, block, { dx: 0, rot: 0, scale: 1 });
		expect(writtenStates(page)!.list[0]!.poses).toEqual([]);
	});

	it("writes no states at all when no part is left and no state was made", () => {
		const doc = createDocument(new Date(stamp));
		doc.pages[0]!.strokes.push(stroke("a", 1, 1));
		doc.pages[0]!.states = { parts: [{ id: "x", pivot: [0, 0], items: ["gone"] }], list: [] };
		expect(serialize(doc)).not.toContain('"states"');
	});

	it("normalises names, numbers and an unknown active state", () => {
		const ids = new Set(["a"]);
		const out = normalizePageStates({
			parts: [{ id: "p", name: "  " + "x".repeat(100) + "  ", pivot: [1.23456, 2], items: ["a", "a", "zz"] }],
			list: [{ id: "s", name: "   ", poses: [{ part: "p", dx: 1.23456, rot: 99999, scale: 0 }] }],
			active: "nope",
		}, ids)!;
		expect(out.parts[0]!.name).toHaveLength(60);
		expect(out.parts[0]!.pivot).toEqual([1.23, 2]);
		expect(out.parts[0]!.items).toEqual(["a"]);
		expect(out.list[0]!.name).toBe("State");
		expect(out.list[0]!.poses[0]).toEqual({ part: "p", dx: 1.23, rot: 3600, scale: 0.01 });
		expect(out.active).toBeUndefined();
		expect(normalizePageStates(out, ids)).toEqual(out);
		expect(statesLine(out)).toBe(statesLine(normalizePageStates(out, ids)!));
	});

	it("stroke items may not be in two parts", () => {
		const out = normalizePageStates({ parts: [{ id: "p", pivot: [0, 0], items: ["a"] }, { id: "q", pivot: [0, 0], items: ["a"] }], list: [] }, new Set(["a"]))!;
		expect(out.parts.map((p) => p.id)).toEqual(["p"]);
	});
});

describe("format v13: lenient read, strict check", () => {
	function withStates(states: unknown): Raw {
		const raw = v12Raw();
		raw.version = 13;
		setAt(raw, ["pages", 0, "states"], states);
		return raw;
	}

	it("reads valid states", () => {
		const r = parsed(JSON.stringify(withStates(OK_STATES)));
		expect(r.dropped).toBeUndefined();
		expect(r.doc.pages[0]!.states!.parts[0]!.items).toEqual(["s1"]);
		expect(r.doc.pages[0]!.states!.active).toBe("st");
	});

	it("drops and counts: an item that names no stroke, a part left empty, a pose of an unknown part, a bad active", () => {
		const r = parsed(JSON.stringify(withStates({
			parts: [
				{ id: "pa", pivot: [0, 0], items: ["s1", "nope"] },
				{ id: "pb", pivot: [0, 0], items: ["ghost"] },
			],
			list: [{ id: "st", name: "End", poses: [{ part: "pa", dx: 5 }, { part: "pb", dx: 1 }, { part: "zz", dx: 1 }] }],
			active: "elsewhere",
		})));
		const s = r.doc.pages[0]!.states!;
		expect(s.parts.map((p) => p.id)).toEqual(["pa"]);
		expect(s.parts[0]!.items).toEqual(["s1"]);
		expect(s.list[0]!.poses.map((p) => p.part)).toEqual(["pa"]);
		expect(s.active).toBeUndefined();
		expect(r.dropped).toBe(6); // nope, the empty part and ghost, two poses, the active state
		expect(r.doc.pages[0]!.strokes).toHaveLength(2); // the drawing is untouched
	});

	it("drops a stroke from a second part and a duplicate part or state id", () => {
		const r = parsed(JSON.stringify(withStates({
			parts: [{ id: "pa", pivot: [0, 0], items: ["s1"] }, { id: "pa", pivot: [0, 0], items: ["s2"] }, { id: "pc", pivot: [0, 0], items: ["s1", "s2"] }],
			list: [{ id: "st", name: "A", poses: [] }, { id: "st", name: "B", poses: [] }],
		})));
		const s = r.doc.pages[0]!.states!;
		expect(s.parts.map((p) => [p.id, p.items])).toEqual([["pa", ["s1"]], ["pc", ["s2"]]]);
		expect(s.list.map((x) => x.name)).toEqual(["A"]);
	});

	it("drops bad numbers and colours of a pose, and bad names", () => {
		const r = parsed(JSON.stringify(withStates({
			parts: [{ id: "pa", name: "", pivot: [0, 0], items: ["s1"] }, { id: "pb", pivot: ["x", 0], items: ["s2"] }],
			list: [{ id: "st", name: "A", poses: [{ part: "pa", dx: "far" }, { part: "pa", scale: 0 }, { part: "pa", color: "red" }, { part: "pa", hidden: false }, { part: "pa", dy: 3 }] }],
		})));
		const s = r.doc.pages[0]!.states!;
		expect(s.parts.map((p) => p.id)).toEqual([]);
		expect(r.dropped).toBeGreaterThan(0);
	});

	it("a states value that is not an object is dropped and counted; the page opens", () => {
		const r = parsed(JSON.stringify(withStates("nonsense")));
		expect(r.doc.pages[0]!.states).toBeUndefined();
		expect(r.dropped).toBe(1);
	});

	it("is strict when asked: the same input fails instead of being dropped", () => {
		expect(() => readPageStates({ parts: [{ id: "pa", pivot: [0, 0], items: ["nope"] }], list: [] }, "states", new Set(["s1"]), null)).toThrow();
		expect(() => readPageStates(OK_STATES, "states", new Set(["s1"]), null)).not.toThrow();
		expect(() => readPageStates({ parts: [], list: [{ id: "a", name: "x", poses: [] }], active: "b" }, "states", new Set(), null)).toThrow();
	});

	it("limits: too many parts or states are refused by the strict reader", () => {
		const ids = new Set(Array.from({ length: 70 }, (_, i) => `s${i}`));
		const parts = Array.from({ length: 65 }, (_, i) => ({ id: `p${i}`, pivot: [0, 0], items: [`s${i}`] }));
		expect(() => readPageStates({ parts, list: [] }, "states", ids, null)).toThrow();
		const list = Array.from({ length: 33 }, (_, i) => ({ id: `t${i}`, name: "x", poses: [] }));
		expect(() => readPageStates({ parts: [], list }, "states", ids, null)).toThrow();
	});

	it("the history guard accepts valid states", () => {
		expect(checkContent(physicsDoc().doc)).toBeNull();
	});
});

describe("format v13: staged loading", () => {
	it("stages a large v12 file, ignoring a stray states key page by page", () => {
		const doc = stressDocument(6000, 3, 7);
		let v12 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 12`);
		v12 = v12.replace('"infinite"', '"states": {"parts":[],"list":[]},\n\t\t\t"infinite"');
		expect(v12.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(v12, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(12);
			expect(r.doc.version).toBe(CURRENT_VERSION);
			expect(r.doc.pages.every((p) => p.states === undefined)).toBe(true);
			expect(r.dropped).toBeUndefined();
		}
	});

	it("keeps the slide table of a large v12 file while staging it", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.slides = [{ id: "sl", source: "0123456789abcdef01234567", page: 2 }];
		const first = doc.pages[0]!.strokes[0]!;
		doc.pages[0]!.strokes[0] = freezeStroke({ ...first, slide: "sl" });
		const v12 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 12`);
		const r = (parseStaged(v12, 1) as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.doc.slides).toHaveLength(1);
			expect(r.doc.pages[0]!.strokes[0]!.slide).toBe("sl");
		}
	});

	it("stages a large v13 file with its states and checks them before writing", () => {
		const doc = stressDocument(6000, 3, 7);
		const page = doc.pages[1]!;
		const made = makePart(undefined, page.strokes.slice(0, 5), "Big", seeded(7))!;
		const added = addState(made.states, "Moved", null, seeded(8))!;
		page.states = withPose(added.states, added.stateId, made.partId, { dx: 50, rot: 10 });
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.doc.pages[1]!.states!.parts[0]!.items).toHaveLength(5);
			expect(serialize(r.doc)).toBe(text);
		}
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("a large document: states that cannot be read back are refused before writing", () => {
		const doc = stressDocument(6000, 3, 7);
		const page = doc.pages[0]!;
		page.states = { parts: [{ id: "p", pivot: [0, 0], items: [page.strokes[0]!.id] }], list: [{ id: "s", name: "x", poses: [{ part: "p", dx: 1 }] }] };
		expect(serializeChecked(doc).ok).toBe(true);
	});
});

describe("states at draw time", () => {
	it("shows the drawing as drawn when no state is active or the state moves nothing", () => {
		const { doc, start } = physicsDoc();
		const page = doc.pages[0]!;
		expect(showsState(page)).toBe(false); // "Start" has no poses
		expect(stateView(page)).toBe(page);
		expect(viewPages(doc.pages)).toBe(doc.pages);
		page.states = withActive(page.states!, null);
		expect(stateView(page, start)).toBe(page);
	});

	it("applies the poses of the active state to the member strokes only, keeping draw order", () => {
		const { doc, end, block, spring } = physicsDoc();
		const page = doc.pages[0]!;
		page.states = withActive(page.states!, end);
		expect(showsState(page)).toBe(true);
		const view = stateView(page);
		expect(view).not.toBe(page);
		expect(view.id).toBe(page.id);
		expect(view.strokes.map((s) => s.id)).toEqual(["b1", "b2", "sp", "lab"]);
		expect(view.strokes[3]).toBe(page.strokes[3]); // the label is not a part
		// The block is shifted by 120 and rotated 15 degrees about its pivot.
		const part = page.states.parts.find((p) => p.id === block)!;
		const m = poseMatrix({ dx: 120, rot: 15 }, part.pivot);
		const expected = transformStroke(page.strokes[0]!, m);
		expect(view.strokes[0]!.points).toEqual(expected.points);
		expect(view.strokes[0]!.color).toBe("#111111");
		// The spring is twice as big and red; its width scales with it.
		expect(view.strokes[2]!.color).toBe("#ff0000");
		expect(view.strokes[2]!.width).toBe(4);
		const springPart = page.states.parts.find((p) => p.id === spring)!;
		const [px, py] = springPart.pivot;
		const first = page.strokes[2]!.points[0]!;
		expect(view.strokes[2]!.points[0]![0]).toBeCloseTo(px + (first[0] - px) * 2, 1);
		expect(view.strokes[2]!.points[0]![1]).toBeCloseTo(py + (first[1] - py) * 2, 1);
		// The document itself is untouched.
		expect(page.strokes[0]!.points[0]).toEqual([100, 100, 0.5]);
		expect(viewPages(doc.pages)[0]!.strokes[0]).toBe(view.strokes[0]);
	});

	it("keeps the same copy for an unchanged part (the renderer caches by object)", () => {
		const { doc, end } = physicsDoc();
		const page = doc.pages[0]!;
		page.states = withActive(page.states!, end);
		expect(stateView(page).strokes[0]).toBe(stateView(page).strokes[0]);
	});

	it("hidden parts are not drawn", () => {
		const { doc, end, block } = physicsDoc();
		const page = doc.pages[0]!;
		page.states = withActive(withPose(page.states!, end, block, { hidden: true }), end);
		expect(stateView(page).strokes.map((s) => s.id)).toEqual(["sp", "lab"]);
	});

	it("tells the ink tools which strokes a shown state moved", () => {
		const { doc, end, start } = physicsDoc();
		const page = doc.pages[0]!;
		expect(displacedStrokeIds(page)).toBeNull();
		page.states = withActive(page.states!, end);
		expect([...displacedStrokeIds(page)!].sort()).toEqual(["b1", "b2", "sp"]);
		page.states = withActive(page.states, start);
		expect(displacedStrokeIds(page)).toBeNull();
	});

	it("poseFromMatrix inverts poseMatrix", () => {
		const pivot: [number, number] = [120, 80];
		const pose = { dx: 33.5, dy: -12.25, rot: 37.5, scale: 1.75 };
		const back = poseFromMatrix(poseMatrix(pose, pivot), pivot);
		expect(back).toEqual(pose);
		const [x, y] = applyMatrix(poseMatrix(pose, pivot), pivot[0], pivot[1]);
		expect(x).toBeCloseTo(pivot[0] + pose.dx, 6);
		expect(y).toBeCloseTo(pivot[1] + pose.dy, 6);
	});
});

describe("editing the table", () => {
	it("makePart moves strokes out of the parts they were in and drops a part left empty", () => {
		const { doc } = physicsDoc();
		const page = doc.pages[0]!;
		const next = makePart(page.states, [page.strokes[0]!, page.strokes[3]!], "Mixed", seeded(9))!;
		expect(partOfStroke(next.states, "b1")!.id).toBe(next.partId);
		expect(partOfStroke(next.states, "b2")!.items).toEqual(["b2"]);
		expect(partOfStroke(next.states, "lab")!.id).toBe(next.partId);
		const only = makePart(page.states, [page.strokes[2]!], "Again", seeded(10))!;
		expect(only.states.parts).toHaveLength(page.states!.parts.length); // the old spring part is empty and gone
	});

	it("dissolving a part removes its poses; deleting a state clears active", () => {
		const { doc, end, block } = physicsDoc();
		const states = doc.pages[0]!.states!;
		const dissolved = dissolvePart(states, block);
		expect(dissolved.parts.some((p) => p.id === block)).toBe(false);
		expect(dissolved.list.every((s) => s.poses.every((p) => p.part !== block))).toBe(true);
		const active = withActive(states, end);
		expect(deleteState(active, end).active).toBeUndefined();
		expect(deleteState(active, end).list).toHaveLength(1);
	});

	it("renames, steps and names new states", () => {
		const { doc, start, end } = physicsDoc();
		const states = doc.pages[0]!.states!;
		expect(renameState(states, start, " First ").list[0]!.name).toBe("First");
		expect(renameState(states, start, "   ")).toBe(states);
		expect(renamePart(states, states.parts[0]!.id, "Cart").parts[0]!.name).toBe("Cart");
		expect(steppedState(withActive(states, start), 1)).toBe(end);
		expect(steppedState(withActive(states, end), 1)).toBeNull(); // wraps to "as drawn"
		expect(steppedState(withActive(states, null), -1)).toBe(end);
		expect(steppedState(undefined, 1)).toBeNull();
		expect(freshStateName(states, "State")).toBe("State 3");
	});

	it("withPose with null puts a part back where it was drawn", () => {
		const { doc, end, block } = physicsDoc();
		const states = withPose(doc.pages[0]!.states!, end, block, null);
		expect(states.list.find((s) => s.id === end)!.poses.some((p) => p.part === block)).toBe(false);
	});

	it("addState copies the poses of the state it starts from", () => {
		const { doc, end } = physicsDoc();
		const next = addState(doc.pages[0]!.states, "Copy", end, seeded(11))!;
		expect(next.states.list[next.states.list.length - 1]!.poses).toEqual(doc.pages[0]!.states!.list.find((s) => s.id === end)!.poses);
		expect(next.states.active).toBe(next.stateId);
	});

	it("withoutItems and remapStates follow strokes", () => {
		const { doc } = physicsDoc();
		const states = doc.pages[0]!.states!;
		const less = withoutItems(states, new Set(["b1", "b2"]))!;
		expect(less.parts.map((p) => p.name)).toEqual(["Spring"]);
		const moved = remapStates(states, (id) => (id === "sp" ? "sp2" : undefined))!;
		expect(moved.parts).toHaveLength(1);
		expect(moved.parts[0]!.items).toEqual(["sp2"]);
		expect(remapStates(states, () => undefined)!.list).toHaveLength(2);
	});
});

describe("undo and redo", () => {
	it("one user action is one undo step", () => {
		const doc = createDocument(new Date(stamp));
		const page = doc.pages[0]!;
		page.strokes.push(stroke("a", 1, 1), stroke("b", 50, 50));
		const history = new History(() => doc, 100, checkContent);
		// "Make part" and the first state in one action.
		const made = makePart(page.states, page.strokes, "Both", seeded(1))!;
		const state = addState(made.states, "A", null, seeded(2))!;
		expect(history.execute(new Batch("Make part", [new SetPageStates(page.id, undefined, made.states, "Make part"), new SetPageStates(page.id, made.states, state.states)]))).toBe(true);
		expect(page.states!.list).toHaveLength(1);
		// A pose edit.
		const posed = withPose(state.states, state.stateId, made.partId, { dx: 10, rot: 20 });
		history.execute(new SetPageStates(page.id, state.states, posed, "Change part"));
		expect(page.states!.list[0]!.poses).toHaveLength(1);
		history.undo();
		expect(page.states!.list[0]!.poses).toHaveLength(0);
		history.undo();
		expect(page.states).toBeUndefined();
		history.redo();
		history.redo();
		expect(page.states!.list[0]!.poses[0]).toMatchObject({ dx: 10, rot: 20 });
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("erasing a member and undoing it brings the stroke back into its part", () => {
		const { doc } = physicsDoc();
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		const spring = page.strokes[2]!;
		history.execute(new ReplaceStroke(page.id, spring, [], 2));
		expect(parsed(serialize(doc)).doc.pages[0]!.states!.parts.map((p) => p.name)).toEqual(["Block"]);
		expect(page.states!.parts).toHaveLength(2); // in memory the part waits for an undo
		history.undo();
		expect(parsed(serialize(doc)).doc.pages[0]!.states!.parts.map((p) => p.name)).toEqual(["Block", "Spring"]);
	});

	it("a moved member keeps its id, so the part keeps it (transform replaces the stroke with the same id)", () => {
		const { doc } = physicsDoc();
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		const next = freezeStroke(transformStroke(page.strokes[0]!, [1, 0, 0, 1, 10, 0]));
		history.execute(new ReplaceStroke(page.id, page.strokes[0]!, [next], 0));
		expect(parsed(serialize(doc)).doc.pages[0]!.states!.parts[0]!.items).toEqual(["b1", "b2"]);
	});

	it("a new stroke added to a page with states is ordinary ink", () => {
		const { doc } = physicsDoc();
		const page = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		history.execute(new AddStroke(page.id, stroke("fresh", 5, 5), page.strokes.length));
		expect(partOfStroke(page.states, "fresh")).toBeNull();
	});
});

describe("copies, page trash, moves, restore", () => {
	it("a duplicated page keeps its parts and states on its own stroke ids", () => {
		const { doc } = physicsDoc();
		const copy = duplicatePage(doc.pages[0]!);
		const ids = new Set(copy.strokes.map((s) => s.id));
		expect(copy.states!.parts.every((p) => p.items.every((i) => ids.has(i)))).toBe(true);
		expect(copy.states!.parts[0]!.items).not.toContain("b1");
		expect(copy.states!.list).toEqual(doc.pages[0]!.states!.list);
		doc.pages.push(copy);
		expect(parsed(serialize(doc)).doc.pages[1]!.states!.parts).toHaveLength(2);
	});

	it("page trash carries the states and a restore brings them back (also under new ids on a clash)", () => {
		const { doc } = physicsDoc();
		const page = doc.pages[0]!;
		const trash = addEntry(emptyPageTrash("doc"), makeEntry(doc, page, 0, Date.now()), Date.now());
		const entry = trash.entries[0]!;
		const other = createDocument(new Date(stamp));
		const plan = planPageTrashRestore(other, entry)!;
		plan.command.apply(other);
		const restored = other.pages[plan.pageIndex]!;
		expect(restored.states!.parts).toHaveLength(2);
		expect(restored.states!.parts[0]!.items).toEqual(["b1", "b2"]);
		// A clash (the page is still in this notebook): new ids, parts follow.
		const again = planPageTrashRestore(doc, entry)!;
		again.command.apply(doc);
		const dup = doc.pages[again.pageIndex]!;
		expect(dup.id).not.toBe(page.id);
		expect(dup.states!.parts[0]!.items.every((i) => dup.strokes.some((s) => s.id === i))).toBe(true);
		expect(dup.strokes.some((s) => s.id === "b1")).toBe(false);
	});

	it("moving a page to another notebook takes its states along", () => {
		const { doc } = physicsDoc();
		const target = createDocument(new Date(stamp));
		const plan = planPageMove(doc, [doc.pages[0]!.id], target);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const moved = plan.pages[0]!;
		expect(moved.states!.parts).toHaveLength(2);
		expect(moved.states!.parts.every((p) => p.items.every((i) => moved.strokes.some((s) => s.id === i)))).toBe(true);
	});

	it("restoring a page version brings the version's states", () => {
		const { doc } = physicsDoc();
		const version = JSON.parse(serialize(doc)) as unknown;
		const old = parsed(JSON.stringify(version)).doc;
		doc.pages[0]!.states = undefined;
		delete doc.pages[0]!.states;
		const plan = planPageRestore(doc, old, 0, 0, "replace");
		expect(plan).not.toBeNull();
		plan!.command.apply(doc);
		expect(doc.pages[0]!.states!.parts).toHaveLength(2);
		expect(serializeChecked(doc).ok).toBe(true);
	});
});

describe("conflicted-copy merge", () => {
	it("a page that only the copy has brings its states, under the new stroke ids", () => {
		const main = createDocument(new Date(stamp));
		main.id = "doc";
		const { doc: other } = physicsDoc();
		other.id = "doc";
		const plan = planMerge(main, other);
		expect(plan.command).not.toBeNull();
		plan.command!.apply(main);
		const added = main.pages.find((p) => p.id === other.pages[0]!.id)!;
		expect(added.states!.parts).toHaveLength(2);
		expect(added.states!.parts.every((p) => p.items.every((i) => added.strokes.some((s) => s.id === i)))).toBe(true);
		expect(serializeChecked(main).ok).toBe(true);
		plan.command!.revert(main);
		expect(main.pages.find((p) => p.id === other.pages[0]!.id)).toBeUndefined();
	});

	it("a page of the main notebook with no states takes the copy's, mapped to the strokes that are there", () => {
		const { doc: other } = physicsDoc();
		other.id = "doc";
		const main: NotebookDocument = JSON.parse(JSON.stringify(other)) as NotebookDocument;
		for (const p of main.pages) {
			delete p.states;
			p.strokes = p.strokes.map((s) => freezeStroke({ ...s }));
		}
		const plan = planMerge(main, other);
		expect(plan.command).not.toBeNull();
		plan.command!.apply(main);
		expect(main.pages[0]!.states!.parts.map((p) => p.items)).toEqual([["b1", "b2"], ["sp"]]);
		plan.command!.revert(main);
		expect(main.pages[0]!.states).toBeUndefined();
	});

	it("when both have states the main notebook's stay", () => {
		const { doc: other } = physicsDoc();
		other.id = "doc";
		const main: NotebookDocument = JSON.parse(JSON.stringify(other)) as NotebookDocument;
		main.pages[0]!.states = renamePart(main.pages[0]!.states!, main.pages[0]!.states!.parts[0]!.id, "Mine");
		main.pages[0]!.strokes = main.pages[0]!.strokes.map((s) => freezeStroke({ ...s }));
		const plan = planMerge(main, other);
		if (plan.command) plan.command.apply(main);
		expect(main.pages[0]!.states.parts[0]!.name).toBe("Mine");
	});
});

describe("repair", () => {
	it("keeps the states of a truncated v13 file (the cut only costs what it ran through)", () => {
		const doc = stressDocument(40, 2, 3);
		const page = doc.pages[0]!;
		const made = makePart(undefined, page.strokes.slice(0, 3), "Part", seeded(5))!;
		const added = addState(made.states, "Moved", null, seeded(6))!;
		page.states = withPose(added.states, added.stateId, made.partId, { dx: 12 });
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.states!.parts[0]!.items).toHaveLength(3);
		expect(r.doc.pages[0]!.states!.list[0]!.poses[0]).toMatchObject({ dx: 12 });
		expect(r.summary.unknownFields).toBe(0);
		expect(parse(r.text).ok).toBe(true);
	});

	it("keeps the states when a stroke line in the middle is damaged; the part loses only that stroke", () => {
		const { doc } = physicsDoc();
		const lines = serialize(doc).split("\n");
		const at = lines.findIndex((l) => l.includes('"id":"b2"') && l.includes('"points"'));
		lines[at] = "\u0000\u0000 garbage";
		const r = repairNotebookText(lines.join("\n"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const s = r.doc.pages[0]!.states!;
		expect(s.parts.map((p) => p.items)).toEqual([["b1"], ["sp"]]);
		expect(s.list).toHaveLength(2);
	});

	it("repairs a file whose states are invalid: the ink is kept, the table is reset", () => {
		const { doc } = physicsDoc();
		const text = serialize(doc).replace(/"states": \{.*\},\n/, '"states": {"parts": "oops"},\n');
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.doc.pages[0]!.strokes).toHaveLength(4);
		expect(r.doc.pages[0]!.states).toBeUndefined();
	});

	it("a clean v13 file with states needs no repair", () => {
		const r = repairNotebookText(serialize(physicsDoc().doc));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.summary.alreadyReadable).toBe(true);
	});
});

describe("the format stays consistent", () => {
	it("getAt reads what the file holds", () => {
		const raw = JSON.parse(serialize(physicsDoc().doc)) as Raw;
		expect(getAt(raw, ["pages", 0, "states", "list", 1, "name"])).toBe("End");
		expect(getAt(raw, ["pages", 0, "states", "active"])).toBeTypeOf("string");
	});

	it("page states are frozen once read", () => {
		const doc = parsed(serialize(physicsDoc().doc)).doc;
		expect(Object.isFrozen(doc.pages[0]!.states)).toBe(true);
		expect(Object.isFrozen(doc.pages[0]!.states!.parts[0])).toBe(true);
	});

	it("a page made with createPage has no states", () => {
		expect(createPage().states).toBeUndefined();
	});
});

export type { PageStates };
