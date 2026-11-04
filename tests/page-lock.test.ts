/**
 * Locking a finished page (roadmap #124): the guard in History refuses every kind of edit of a locked page, lock and unlock
 * are single undo steps, undo and redo respect the lock, and what is not content (tags, bookmarks, page order, inserting
 * pages) still works.
 */
import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import {
	AddElement, AddPage, AddStroke, Batch, DeletePage, EraseStrokes, History, InsertPages, MovePage, RemoveElement, ReorderLayer, ReplaceElement, ReplaceStroke,
	SetMeta, SetPageBackground, SetPageInfinite, SetPageMargins, SetPageSize, SetPaper, type Command,
} from "../src/model/history";
import { SetMarkerDone } from "../src/model/marker-commands";
import { exemptFromLocks, isLocked, lockedChanges, lockedPageIds, lockedPages, SetPageLocked, snapshotLocked } from "../src/model/page-lock";
import { allLocked, deleteCommand, lockCommand, ReorderPages } from "../src/model/page-ops";
import { SetPageContent } from "../src/model/page-content";
import { ReplacePage } from "../src/model/page-restore";
import { SetPageTags } from "../src/model/page-tags";
import { freezeElement, freezeStroke, serialize } from "../src/model/serialize";
import { addState, makePart, SetPageStates, withActive, withPose } from "../src/model/states";
import { stableStringify } from "../src/model/math-elements";
import type { NotebookDocument, Page, Stroke, TextElement } from "../src/model/types";
import { actionById, baseContext, isEnabled, isRelevant } from "../src/ui/actions";

const stamp = new Date("2026-11-04T10:00:00.000Z");

function stroke(id: string, x = 10, y = 10): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + 30, y, 0.5], [x + 30, y + 10, 0.5]]), id });
}

function text(id: string, body = "hello"): TextElement {
	return freezeElement<TextElement>({ id, type: "text", x: 20, y: 20, width: 200, text: body, fontSize: 16, color: "#111111" });
}

function seeded(seed: number): () => number {
	let x = seed;
	return () => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x / 2147483648;
	};
}

/** Two pages: p1 (ink, a text box, tags) and p2 (ink). p1 is locked unless `lock` is false. */
function fixture(lock = true): { doc: NotebookDocument; p1: Page; p2: Page; history: History; refused: string[][] } {
	const doc = createDocument(stamp);
	doc.id = "doc";
	const p1 = doc.pages[0]!;
	p1.id = "p1";
	p1.strokes.push(stroke("a"), stroke("b", 10, 60), stroke("c", 10, 110));
	p1.elements = [text("t1")];
	const p2 = createPage();
	p2.id = "p2";
	p2.strokes.push(stroke("d"));
	doc.pages.push(p2);
	if (lock) p1.locked = true;
	const refused: string[][] = [];
	const history = new History(() => doc, 100, null, null, null, (ids) => refused.push([...ids]));
	return { doc, p1, p2, history, refused };
}

/** The whole document as text: two equal values mean nothing changed. */
function fingerprint(doc: NotebookDocument): string {
	return serialize(doc);
}

describe("SetPageLocked", () => {
	it("locks and unlocks, and a missing page is a no-op", () => {
		const { doc, p1, p2 } = fixture(false);
		const lock = new SetPageLocked("p1", true);
		lock.apply(doc);
		expect(p1.locked).toBe(true);
		expect(p2.locked).toBeUndefined();
		lock.revert(doc);
		expect(p1.locked).toBeUndefined();
		expect("locked" in p1).toBe(false);
		new SetPageLocked("nope", true).apply(doc);
		expect(lockedPageIds(doc)).toEqual([]);
	});

	it("unlocked is the absence of the flag, never false", () => {
		const { doc, p1 } = fixture(true);
		const unlock = new SetPageLocked("p1", false);
		unlock.apply(doc);
		expect("locked" in p1).toBe(false);
		unlock.revert(doc);
		expect(p1.locked).toBe(true);
	});

	it("is one undo step, and the history lets it through on a locked page", () => {
		const { doc, p1, history } = fixture(true);
		expect(history.execute(new SetPageLocked("p1", false))).toBe(true);
		expect(p1.locked).toBeUndefined();
		expect(history.undo()).not.toBeNull();
		expect(p1.locked).toBe(true);
		expect(history.redo()).not.toBeNull();
		expect(p1.locked).toBeUndefined();
		expect(history.canUndo()).toBe(true);
		expect(lockedPageIds(doc)).toEqual([]);
	});

	it("lockCommand locks several pages in one step and is null when nothing changes", () => {
		const { doc, p1, p2, history } = fixture(false);
		expect(lockCommand(doc, ["p1", "p2"], false)).toBeNull();
		const cmd = lockCommand(doc, ["p1", "p2"], true)!;
		expect(history.execute(cmd)).toBe(true);
		expect(p1.locked && p2.locked).toBe(true);
		expect(allLocked(doc, ["p1", "p2"])).toBe(true);
		history.undo();
		expect(lockedPageIds(doc)).toEqual([]);
		expect(lockCommand(doc, ["p1"], true) instanceof Batch).toBe(true);
	});
});

describe("the guard: every kind of edit of a locked page is refused", () => {
	const kinds: Array<[string, (f: ReturnType<typeof fixture>) => Command]> = [
		["add a stroke", (f) => new AddStroke("p1", stroke("new"), f.p1.strokes.length)],
		["erase strokes", (f) => new EraseStrokes("p1", [{ stroke: f.p1.strokes[0]!, index: 0 }])],
		["replace (edit/segment erase/restyle/move) a stroke", (f) => new ReplaceStroke("p1", f.p1.strokes[0]!, [stroke("a2")], 0)],
		["delete the selection (strokes and elements)", (f) => new Batch("Delete selection", [new ReplaceStroke("p1", f.p1.strokes[1]!, [], 1), new RemoveElement("p1", f.p1.elements![0]!)])],
		["add an element (text, image, marker, equation, excerpt...)", () => new AddElement("p1", text("t2"), 1)],
		["remove an element", (f) => new RemoveElement("p1", f.p1.elements![0]!)],
		["replace an element (edit text, move, restyle)", (f) => new ReplaceElement("p1", f.p1.elements![0]!, text("t1", "changed"))],
		["change the layer order", (f) => new ReorderLayer("p1", "strokes", f.p1.strokes, [...f.p1.strokes].reverse())],
		["change the paper", () => new SetPaper("p1", { kind: "grid", spacing: 14.17 }, { kind: "ruled", spacing: 28 })],
		["change the page size", () => new SetPageSize("p1", { width: 595.28, height: 841.89 }, { width: 400, height: 600 })],
		["change the margins", () => new SetPageMargins("p1", undefined, { left: 20, right: 0, bottom: 0 })],
		["change the background", () => new SetPageBackground("p1", { kind: "image", asset: "a1" }, { width: 595.28, height: 841.89 })],
		["turn infinite on", () => new SetPageInfinite("p1", true)],
		["set the page content (split, insert space, republish)", (f) => new SetPageContent({ pageId: "p1", strokes: [f.p1.strokes[0]!], elements: [] })],
		["replace the page (restore a version)", (f) => new ReplacePage(f.p1, { ...f.p1, strokes: [stroke("old")], locked: undefined })],
		["delete the page", (f) => new DeletePage(f.p1, 0)],
		["delete pages (selection command)", (f) => deleteCommand(f.doc, ["p1"])!],
		["change the states (a pose, the default state)", (f) => {
			const made = makePart(undefined, f.p1.strokes.slice(0, 2), "Part", seeded(1))!;
			const st = addState(made.states, "End", null, seeded(2))!;
			return new SetPageStates("p1", undefined, withPose(st.states, st.stateId, made.partId, { dx: 10 }));
		}],
		["a batch with one allowed and one refused command", (f) => new Batch("Mixed", [new SetPageTags("p1", undefined, ["x"]), new AddStroke("p1", stroke("late"), f.p1.strokes.length)])],
		["a batch that unlocks and edits in one step", (f) => new Batch("Sneaky", [new SetPageLocked("p1", false), new AddStroke("p1", stroke("sneak"), f.p1.strokes.length)])],
	];

	for (const [name, build] of kinds) {
		it(`refuses: ${name}`, () => {
			const f = fixture(true);
			const before = fingerprint(f.doc);
			const strokesBefore = [...f.p1.strokes];
			const cmd = build(f);
			expect(f.history.execute(cmd)).toBe(false);
			expect(fingerprint(f.doc)).toBe(before);
			expect(f.p1.strokes).toEqual(strokesBefore);
			expect(f.p1.locked).toBe(true);
			expect(f.history.canUndo()).toBe(false);
			expect(f.refused).toEqual([["p1"]]);
		});
	}

	it("refuses a marker toggled on a locked page", () => {
		const f = fixture(true);
		f.p1.elements = [freezeElement({ id: "m1", type: "marker", kind: "question", x: 10, y: 10, text: "why?" } as never)];
		const before = fingerprint(f.doc);
		expect(f.history.execute(new SetMarkerDone("p1", "m1", true))).toBe(false);
		expect(fingerprint(f.doc)).toBe(before);
	});

	it("the same edits are fine on an unlocked page", () => {
		const f = fixture(false);
		expect(f.history.execute(new AddStroke("p1", stroke("new"), 3))).toBe(true);
		expect(f.history.execute(new SetPaper("p1", { kind: "grid", spacing: 14.17 }, { kind: "ruled", spacing: 28 }))).toBe(true);
		expect(f.history.execute(new DeletePage(f.p1, 0))).toBe(true);
		expect(f.refused).toEqual([]);
	});

	it("edits of other pages go through while one page is locked", () => {
		const f = fixture(true);
		expect(f.history.execute(new AddStroke("p2", stroke("n2"), 1))).toBe(true);
		expect(f.history.execute(new Batch("two pages", [new AddStroke("p2", stroke("n3"), 2), new AddStroke("p1", stroke("n4"), 3)]))).toBe(false);
		expect(f.p2.strokes.map((s) => s.id)).toEqual(["d", "n2"]);
	});

	it("is not content: tags, bookmarks, page order, inserting and adding pages, assets", () => {
		const f = fixture(true);
		expect(f.history.execute(new SetPageTags("p1", undefined, ["done"]))).toBe(true);
		expect(f.p1.tags).toEqual(["done"]);
		const meta = f.doc.meta!;
		expect(f.history.execute(new SetMeta(meta, { ...meta, bookmarks: ["p1"] }))).toBe(true);
		expect(f.history.execute(new MovePage("p1", 0, 1))).toBe(true);
		expect(f.doc.pages.map((p) => p.id)).toEqual(["p2", "p1"]);
		expect(f.history.execute(new ReorderPages(["p2", "p1"], ["p1", "p2"]))).toBe(true);
		const extra = createPage();
		expect(f.history.execute(new AddPage(extra, 1))).toBe(true);
		expect(f.history.execute(new InsertPages([createPage()], 0))).toBe(true);
		expect(f.p1.locked).toBe(true);
		expect(f.refused).toEqual([]);
	});

	it("a command exempted from the locks changes a locked page (the merge of a conflicted copy)", () => {
		const f = fixture(true);
		expect(f.history.execute(exemptFromLocks(new AddStroke("p1", stroke("merged"), 3)))).toBe(true);
		expect(f.p1.strokes.map((s) => s.id)).toContain("merged");
		expect(f.p1.locked).toBe(true);
		f.history.undo();
		expect(f.p1.strokes.map((s) => s.id)).not.toContain("merged");
	});

	it("tells who was hit once per refused command", () => {
		const f = fixture(true);
		f.p2.locked = true;
		f.history.execute(new Batch("both", [new AddStroke("p1", stroke("x"), 3), new AddStroke("p2", stroke("y"), 1)]));
		expect(f.refused).toEqual([["p1", "p2"]]);
	});

	it("costs nothing when no page is locked", () => {
		const f = fixture(false);
		expect(snapshotLocked(f.doc)).toBeNull();
	});
});

describe("undo and redo with locks", () => {
	it("lock then undo unlocks; the edit before it stays until the next undo", () => {
		const f = fixture(false);
		f.history.execute(new AddStroke("p1", stroke("w"), 3));
		f.history.execute(new SetPageLocked("p1", true));
		f.history.undo();
		expect(f.p1.locked).toBeUndefined();
		expect(f.p1.strokes.map((s) => s.id)).toContain("w");
		f.history.undo();
		expect(f.p1.strokes.map((s) => s.id)).not.toContain("w");
	});

	it("an older edit of a page locked since is not undone, and stays on the stack", () => {
		const f = fixture(false);
		f.history.execute(new AddStroke("p1", stroke("w"), 3));
		f.p1.locked = true; // locked outside the history (a synced change)
		expect(f.history.undo()).toBeNull();
		expect(f.p1.strokes.map((s) => s.id)).toContain("w");
		expect(f.history.canUndo()).toBe(true);
		expect(f.refused).toEqual([["p1"]]);
		delete f.p1.locked;
		expect(f.history.undo()).not.toBeNull();
		expect(f.p1.strokes.map((s) => s.id)).not.toContain("w");
	});

	it("a redo of a page locked since is not done, and stays on the stack", () => {
		const f = fixture(false);
		f.history.execute(new AddStroke("p1", stroke("w"), 3));
		f.history.undo();
		f.p1.locked = true;
		expect(f.history.redo()).toBeNull();
		expect(f.p1.strokes.map((s) => s.id)).not.toContain("w");
		expect(f.history.canRedo()).toBe(true);
		delete f.p1.locked;
		expect(f.history.redo()).not.toBeNull();
		expect(f.p1.strokes.map((s) => s.id)).toContain("w");
	});
});

describe("the action registry", () => {
	const locked = baseContext({ page: { index: 0, count: 3, background: "none", infinite: false, bookmarked: false, locked: true } });
	const open = baseContext();
	it("offers Lock on an open page and Unlock on a locked one", () => {
		expect(isRelevant(actionById("page-lock")!, open)).toBe(true);
		expect(isRelevant(actionById("page-unlock")!, open)).toBe(false);
		expect(isRelevant(actionById("page-lock")!, locked)).toBe(false);
		expect(isRelevant(actionById("page-unlock")!, locked)).toBe(true);
	});

	it("disables the page settings and delete on a locked page, and not on an open one", () => {
		for (const id of ["page-paper", "page-size", "page-orientation", "page-infinite", "move-pages", "page-delete", "page-restore-version"]) {
			expect(isEnabled(actionById(id)!, open), id).toBe(true);
			expect(isEnabled(actionById(id)!, locked), id).toBe(false);
		}
	});

	it("lock and unlock need an editable notebook; the palette has one toggle", () => {
		const readOnly = baseContext({ editable: false, page: { index: 0, count: 3, background: "none", infinite: false, bookmarked: false, locked: true } });
		expect(isEnabled(actionById("page-unlock")!, readOnly)).toBe(false);
		expect(actionById("page-lock-toggle")!.command).toBe(true);
		expect(actionById("page-lock-toggle")!.surfaces).toEqual(["palette"]);
	});
});

describe("helpers", () => {
	it("lockedPages picks the locked ones of a list", () => {
		const f = fixture(true);
		expect(lockedPages(f.doc, ["p1", "p2", "zz"])).toEqual(["p1"]);
		expect(isLocked(f.p1)).toBe(true);
		expect(isLocked(f.p2)).toBe(false);
		expect(isLocked(null)).toBe(false);
	});

	it("lockedChanges sees a stroke swapped for another, an element moved, a shape change and a states change", () => {
		const f = fixture(true);
		const snap = snapshotLocked(f.doc)!;
		expect(lockedChanges(f.doc, snap)).toEqual([]);
		f.p1.strokes[0] = stroke("a-same-id-new-object");
		expect(lockedChanges(f.doc, snap)).toEqual(["p1"]);
		const g = fixture(true);
		const snapG = snapshotLocked(g.doc)!;
		g.p1.width = 100;
		expect(lockedChanges(g.doc, snapG)).toEqual(["p1"]);
		const h = fixture(true);
		const snapH = snapshotLocked(h.doc)!;
		h.doc.pages.splice(0, 1);
		expect(lockedChanges(h.doc, snapH)).toEqual(["p1"]);
		const k = fixture(true);
		const snapK = snapshotLocked(k.doc)!;
		k.p1.states = withActive(addState(undefined, "S", null, seeded(5))!.states, null);
		expect(lockedChanges(k.doc, snapK)).toEqual(["p1"]);
		expect(stableStringify({ a: 1 })).toBeTypeOf("string");
	});
});
