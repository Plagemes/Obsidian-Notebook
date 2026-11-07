/**
 * Format v18: groups and locked elements (#39) — the optional `group` of strokes and elements, the `locked` flag and `lockAt` of
 * elements, the v17 -> v18 migration, lenient read and strict write, staged loading, repair, the history command and the
 * page-lock guard, selection (expansion to the group, the lasso and the area eraser skip locked elements), copies, clipboard,
 * merge of a conflicted copy.
 */
import { describe, expect, it } from "vitest";
import { captureClip, instantiateClip } from "../src/ink/clipboard";
import { eraseAreaCommand } from "../src/ink/erase-area";
import { elementsInLasso, hitElement, hitLockedElement, transformElement } from "../src/ink/elements";
import { translate } from "../src/ink/transform";
import { createDocument, createStroke } from "../src/model/document";
import {
	canGroup, expandToGroups, groupCommand, groupRenamer, groupStats, lockCommand, lockedElementsOf, mergedFlags, unlockCommand, UpdateItems, ungroupCommand, unlockedElements,
} from "../src/model/groups";
import { AddElement, Batch, History, quietSwap } from "../src/model/history";
import { mergeCovers, planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { notebookFromTemplate, templateFromNotebook } from "../src/model/notebook-template";
import { SetPageLocked } from "../src/model/page-lock";
import { duplicatePage } from "../src/model/pages";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, freezeElement, freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS, validate } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { CURRENT_VERSION, FORMAT_ID, type BoxElement, type NotebookDocument, type Page, type PageElement, type Stroke } from "../src/model/types";
import { setAt, type Raw } from "./raw-json";

const stamp = "2026-11-05T10:00:00.000Z";
const T0 = 1_760_000_000_000;

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function stroke(id: string, x: number, y: number, over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + 30, y + 5, 0.5], [x + 15, y + 10, 0.5]]), id, ...over });
}

function frame(id: string, x = 100, y = 100, over: Partial<BoxElement> = {}): BoxElement {
	return freezeElement({ id, type: "box", kind: "definition", x, y, width: 80, height: 40, ...over });
}

/** Page "p1": ink s1 and s2 and the elements e1 and e2 in group "g1", a loose stroke s3 and a locked box e3. */
function groupedDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.id = "p1";
	page.strokes.push(stroke("s1", 20, 20, { group: "g1" }), stroke("s2", 20, 60, { group: "g1" }), stroke("s3", 300, 300));
	page.elements = [frame("e1", 100, 100, { group: "g1" }), frame("e2", 100, 200, { group: "g1" }), frame("e3", 300, 100, { locked: true, lockAt: T0 })];
	return doc;
}

function v17Raw(): Raw {
	return {
		format: FORMAT_ID, version: 17, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			elements: [{ id: "e1", type: "box", kind: "definition", x: 10, y: 10, width: 50, height: 30 }],
			strokes: [
				{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] },
				{ id: "s2", tool: "pen", color: "#111111", width: 2, render: 1, points: [[5, 6, 0.5], [7, 8, 0.5]] },
			],
		}],
	};
}

describe("format v18: migration", () => {
	it("has the v17 step (the current format is v18 since groups and locked elements)", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(18);
		expect(typeof MIGRATIONS[17]).toBe("function");
	});

	it("reads a v17 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v17Raw()));
		expect(r.migratedFrom).toBe(17);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.strokes).toHaveLength(2);
		expect(r.dropped).toBeUndefined();
	});

	it("drops the v18 keys of a v17 file: they were never ours, so nothing is grouped or locked", () => {
		const raw = v17Raw();
		setAt(raw, ["pages", 0, "strokes", 0, "group"], "g");
		setAt(raw, ["pages", 0, "strokes", 1, "group"], "g");
		setAt(raw, ["pages", 0, "elements", 0, "group"], "g");
		setAt(raw, ["pages", 0, "elements", 0, "locked"], true);
		setAt(raw, ["pages", 0, "elements", 0, "lockAt"], 5);
		const r = parsed(JSON.stringify(raw));
		const page = r.doc.pages[0]!;
		expect(page.strokes.every((s) => s.group === undefined)).toBe(true);
		expect(page.elements![0]!.group).toBeUndefined();
		expect(page.elements![0]!.locked).toBeUndefined();
		expect(page.elements![0]!.lockAt).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("migrates a v17 round trip: the new version, the same ink, no groups", () => {
		const text = serialize(parsed(JSON.stringify(v17Raw())).doc);
		expect(text).toContain(`"version": ${CURRENT_VERSION}`);
		expect(text).not.toContain('"group"');
		expect(parsed(text).doc.pages[0]!.strokes).toHaveLength(2);
	});

	it("is refused by 0.19 and older as a newer format (they read up to v17, so v18 opens read-only and is never overwritten)", () => {
		const text = serialize(groupedDoc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		const r = parse(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});
});

describe("format v18: write and read", () => {
	it("writes the group after the slide of a stroke and the flags at the end of an element, byte for byte", () => {
		const doc = groupedDoc();
		const text = serialize(doc);
		expect(text).toContain('"render":1,"group":"g1","points"');
		expect(text).toContain('{"id":"e1","type":"box","kind":"definition","x":100,"y":100,"width":80,"height":40,"group":"g1"}');
		expect(text).toContain('{"id":"e3","type":"box","kind":"definition","x":300,"y":100,"width":80,"height":40,"locked":true,"lockAt":1760000000000}');
		const back = parsed(text).doc;
		expect(serialize(back)).toBe(text);
		expect(serializeChecked(doc, true)).toEqual({ ok: true, text });
		expect(back.pages[0]!.strokes[0]!.group).toBe("g1");
		expect(back.pages[0]!.elements![2]).toEqual(doc.pages[0]!.elements![2]);
	});

	it("an unlocked element keeps the time of its last decision and is written unlocked", () => {
		const doc = groupedDoc();
		doc.pages[0]!.elements![2] = frame("e3", 300, 100, { lockAt: T0 + 5 });
		const text = serialize(doc);
		expect(text).toContain('"height":40,"lockAt":1760000000005}');
		expect(parsed(text).doc.pages[0]!.elements![2]).toEqual({ id: "e3", type: "box", kind: "definition", x: 300, y: 100, width: 80, height: 40, lockAt: T0 + 5 });
	});

	it("every element type can carry the flags", () => {
		const doc = createDocument(new Date(stamp));
		const page = doc.pages[0]!;
		page.elements = [
			freezeElement({ id: "t", type: "text", x: 1, y: 1, width: 100, text: "hi", fontSize: 14, color: "#000000", group: "g", locked: true }),
			freezeElement({ id: "c", type: "checkbox", x: 1, y: 40, size: 20, color: "#000000", group: "g", locked: true, lockAt: 3 }),
			freezeElement({ id: "m", type: "marker", kind: "star", x: 200, y: 200, locked: true }),
			freezeElement({ id: "k", type: "sticky", x: 300, y: 300, width: 100, height: 100, color: "#fde68a", fontSize: 14, locked: true, group: "g" }),
		];
		const text = serialize(doc);
		const back = parsed(text).doc;
		expect(serialize(back)).toBe(text);
		expect(back.pages[0]!.elements!.map((e) => e.locked)).toEqual([true, true, true, true]);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("a group of one is not written: the member is written free, and an erased member never makes the notebook unsavable", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		page.strokes.splice(0, 2);
		page.elements!.splice(1, 1);
		expect(checkContent(doc)).toBeNull();
		const text = serialize(doc);
		expect(text).not.toContain('"group"');
		expect(serializeChecked(doc, true).ok).toBe(true);
		// the objects in memory are not changed by the writer
		expect(page.elements![0]!.group).toBe("g1");
	});

	it("a group needs two members across strokes and elements together", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		page.strokes.splice(0, 2);
		page.strokes.push(stroke("s4", 50, 50, { group: "g1" }));
		page.elements!.splice(1, 1);
		const text = serialize(doc);
		expect(text.match(/"group"/g)).toHaveLength(2);
	});

	it("reads leniently: a lone member is released and counted; strictly it fails", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		const text = serialize(doc);
		const lone = text.replace(/\{"id":"s2"[^\n]*"group":"g1"/, (m) => m.replace('"group":"g1"', '"group":"gx"'));
		expect(lone).not.toBe(text);
		const r = parsed(lone);
		expect(r.dropped).toBe(1);
		const free = r.doc.pages[0]!.strokes.find((s) => s.id === "s2")!;
		expect(free.group).toBeUndefined();
		expect(r.doc.pages[0]!.strokes.find((s) => s.id === "s1")!.group).toBe("g1");
		expect(page.strokes).toHaveLength(3);
		const raw = JSON.parse(lone) as unknown;
		expect(() => validate(raw)).toThrow(/fewer than two/);
	});

	it("drops an invalid group, lock or time and counts it, keeping the item", () => {
		const raw = v17Raw();
		raw.version = CURRENT_VERSION;
		setAt(raw, ["pages", 0, "strokes", 0, "group"], 7);
		setAt(raw, ["pages", 0, "elements", 0, "locked"], false);
		setAt(raw, ["pages", 0, "elements", 0, "lockAt"], -4);
		setAt(raw, ["pages", 0, "elements", 0, "group"], "x".repeat(200));
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(4);
		expect(r.doc.pages[0]!.strokes).toHaveLength(2);
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
		expect(parse(JSON.stringify(raw)).ok).toBe(true);
		expect(() => validate(raw)).toThrow();
	});

	it("the history guard accepts a locked or grouped element on its own and refuses an invalid flag", () => {
		expect(checkContent(groupedDoc())).toBeNull();
		const doc = groupedDoc();
		doc.pages[0]!.elements![0] = freezeElement({ ...frame("e1"), group: "x".repeat(70) });
		expect(checkContent(doc)).not.toBeNull();
	});
});

describe("format v18: staged loading", () => {
	it("stages a large v17 file, ignoring the v18 keys of every item", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[1]!.elements = [frame("fe")];
		const v17 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 17`).replace('"kind":"definition","x":100', '"kind":"definition","locked":true,"group":"g","x":100');
		expect(v17.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(v17, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(17);
			expect(r.doc.version).toBe(CURRENT_VERSION);
			expect(r.doc.pages[1]!.elements![0]!.locked).toBeUndefined();
			expect(r.dropped).toBeUndefined();
		}
	});

	it("stages a large v18 file with groups and locks and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		const strokes = doc.pages[1]!.strokes;
		doc.pages[1]!.strokes[0] = stroke(strokes[0]!.id, 1, 1, { group: "g" });
		doc.pages[1]!.strokes[1] = stroke(strokes[1]!.id, 9, 9, { group: "g" });
		doc.pages[1]!.elements = [frame("fe", 100, 100, { locked: true, lockAt: T0 })];
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const r = (parseStaged(text, 1) as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(serialize(r.doc)).toBe(text);
	});
});

describe("groups: selection", () => {
	it("picking one member takes the whole group, strokes and elements, and never a locked element", () => {
		const page = groupedDoc().pages[0]!;
		const sel = expandToGroups(page, { strokes: [page.strokes[0]!], elements: [] });
		expect(sel.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(sel.elements.map((e) => e.id)).toEqual(["e1", "e2"]);
		page.elements![1] = frame("e2", 100, 200, { group: "g1", locked: true });
		const again = expandToGroups(page, { strokes: [], elements: [page.elements![0]!] });
		expect(again.elements.map((e) => e.id)).toEqual(["e1"]);
		expect(again.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
	});

	it("only offers the ink it is given (hidden ink and the ink of a collapsed note stay out)", () => {
		const page = groupedDoc().pages[0]!;
		const sel = expandToGroups(page, { strokes: [], elements: [page.elements![0]!] }, [page.strokes[0]!]);
		expect(sel.strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("returns the same selection when nothing is added", () => {
		const page = groupedDoc().pages[0]!;
		const sel = { strokes: [page.strokes[2]!], elements: [] };
		expect(expandToGroups(page, sel)).toBe(sel);
	});

	it("knows what a selection says about groups", () => {
		const page = groupedDoc().pages[0]!;
		const all = { strokes: [...page.strokes], elements: [page.elements![0]!, page.elements![1]!] };
		expect(groupStats(all)).toEqual({ groups: 1, grouped: 4, total: 5 });
		expect(canGroup(all)).toBe(true);
		const exact = expandToGroups(page, { strokes: [page.strokes[0]!], elements: [] });
		expect(canGroup(exact)).toBe(false);
		expect(canGroup({ strokes: [page.strokes[2]!], elements: [] })).toBe(false);
	});

	it("the lasso, a tap and the area eraser skip a locked element", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		const poly: Array<[number, number]> = [[0, 0], [600, 0], [600, 600], [0, 600]];
		expect(elementsInLasso(page.elements!, poly).map((e) => e.id)).toEqual(["e1", "e2"]);
		expect(hitElement(page.elements!, 320, 120, 2)).toBeNull();
		expect(hitLockedElement(page.elements!, 320, 120, 2)?.id).toBe("e3");
		expect(hitElement(page.elements!, 120, 120, 2)?.id).toBe("e1");
		expect(unlockedElements(page.elements!).map((e) => e.id)).toEqual(["e1", "e2"]);
		expect(lockedElementsOf(page).map((e) => e.id)).toEqual(["e3"]);
		const cmd = eraseAreaCommand(page, poly, { filter: { kind: "all", color: "#000000" }, includeElements: true });
		cmd?.apply(doc);
		expect(doc.pages[0]!.elements!.map((e) => e.id)).toEqual(["e3"]);
	});

	it("a locked element above an unlocked one lets the tap through to the one below", () => {
		const els = [frame("below", 100, 100), frame("above", 100, 100, { locked: true })];
		expect(hitElement(els, 110, 110, 2)?.id).toBe("below");
	});

	it("moving and scaling keep the flags", () => {
		const e = frame("e", 10, 10, { group: "g", locked: true, lockAt: 4 });
		const moved = transformElement(e, translate(5, 5));
		expect(moved).toMatchObject({ x: 15, y: 15, group: "g", locked: true, lockAt: 4 });
	});
});

describe("groups: history", () => {
	function historyOf(doc: NotebookDocument, locked?: (ids: readonly string[]) => void) {
		return new History(() => doc, 100, checkContent, null, null, locked ?? null);
	}

	it("Group is one undo step that gives the selected items one new id; Ungroup takes it away", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		const h = historyOf(doc);
		const sel = { strokes: [page.strokes[2]!], elements: [page.elements![0]!, page.elements![1]!] };
		const cmd = groupCommand(page, sel, () => "g2");
		expect(cmd).not.toBeNull();
		expect(h.execute(cmd!)).toBe(true);
		expect(page.strokes[2]!.group).toBe("g2");
		expect(page.elements![0]!.group).toBe("g2");
		expect(page.elements![1]!.group).toBe("g2");
		// the old group lost two members to the new one: s1 and s2 are two members of g1, still a group
		expect(page.strokes[0]!.group).toBe("g1");
		expect(Object.isFrozen(page.elements![0])).toBe(true);
		h.undo();
		expect(page.strokes[2]!.group).toBeUndefined();
		expect(page.elements![0]!.group).toBe("g1");
		h.redo();
		expect(page.elements![1]!.group).toBe("g2");
		const un = ungroupCommand(page, { strokes: [page.strokes[2]!], elements: [page.elements![0]!, page.elements![1]!] });
		expect(h.execute(un!)).toBe(true);
		expect(page.elements![0]!.group).toBeUndefined();
		h.undo();
		expect(page.elements![0]!.group).toBe("g2");
		expect(checkContent(doc)).toBeNull();
	});

	it("does nothing for fewer than two items, an exact group, or nothing grouped", () => {
		const page = groupedDoc().pages[0]!;
		expect(groupCommand(page, { strokes: [page.strokes[2]!], elements: [] })).toBeNull();
		expect(groupCommand(page, expandToGroups(page, { strokes: [page.strokes[0]!], elements: [] }))).toBeNull();
		expect(ungroupCommand(page, { strokes: [page.strokes[2]!], elements: [] })).toBeNull();
		expect(lockCommand(page, [page.elements![2]!])).toBeNull();
		expect(unlockCommand(page, [page.elements![0]!])).toBeNull();
	});

	it("Lock and Unlock are one undo step each and stamp the decision", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		const h = historyOf(doc);
		expect(h.execute(lockCommand(page, [page.elements![0]!], T0 + 10)!)).toBe(true);
		expect(page.elements![0]).toMatchObject({ locked: true, lockAt: T0 + 10 });
		h.undo();
		expect(page.elements![0]!.locked).toBeUndefined();
		expect(page.elements![0]!.lockAt).toBeUndefined();
		h.redo();
		expect(page.elements![0]!.locked).toBe(true);
		const locked = page.elements![2]!;
		expect(h.execute(unlockCommand(page, [locked], T0 + 20)!)).toBe(true);
		expect(page.elements![2]!.locked).toBeUndefined();
		expect(page.elements![2]!.lockAt).toBe(T0 + 20);
		h.undo();
		expect(page.elements![2]).toBe(locked);
	});

	it("a redo puts back the very objects the steps above it hold", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		const h = historyOf(doc);
		h.execute(lockCommand(page, [page.elements![0]!])!);
		const locked = page.elements![0]!;
		h.undo();
		h.redo();
		expect(page.elements![0]).toBe(locked);
	});

	it("a locked page refuses Group, Lock and Unlock like any edit", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		const seen: string[] = [];
		const h = historyOf(doc, (ids) => seen.push(...ids));
		h.execute(new SetPageLocked("p1", true));
		const sel = { strokes: [page.strokes[2]!], elements: [page.elements![0]!] };
		expect(h.execute(groupCommand(page, sel)!)).toBe(false);
		expect(h.execute(lockCommand(page, [page.elements![0]!])!)).toBe(false);
		expect(h.execute(unlockCommand(page, [page.elements![2]!])!)).toBe(false);
		expect(seen).toEqual(["p1", "p1", "p1"]);
		expect(page.strokes[2]!.group).toBeUndefined();
		expect(page.elements![2]!.locked).toBe(true);
	});

	it("finds its items by id and by remap after an upkeep change replaced an element", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		const h = historyOf(doc);
		const cmd = lockCommand(page, [page.elements![0]!], T0)!;
		const before = page.elements![0]!;
		h.execute(cmd);
		const after = page.elements![0]!;
		// an upkeep change replaces the element (here with a new size) without an undo step
		const quiet = freezeElement({ ...after, width: 90 } as PageElement);
		page.elements![0] = quiet;
		cmd.remap?.(quietSwap(new Map([[after, quiet]])));
		h.undo();
		expect(page.elements!.filter((e) => e.id === "e1")).toHaveLength(1);
		expect(page.elements![0].locked).toBeUndefined();
		expect((page.elements![0] as BoxElement).width).toBe(90);
		expect(before.locked).toBeUndefined();
	});

	it("a Batch with a command of another kind still undoes as one step", () => {
		const doc = groupedDoc();
		const page = doc.pages[0]!;
		const h = historyOf(doc);
		h.execute(new Batch("both", [lockCommand(page, [page.elements![0]!])!, new AddElement("p1", frame("e9", 5, 5), 3)]));
		expect(page.elements).toHaveLength(4);
		h.undo();
		expect(page.elements).toHaveLength(3);
		expect(page.elements![0]!.locked).toBeUndefined();
	});

	it("UpdateItems on a page that is gone, or items that are gone, is a no-op both ways", () => {
		const doc = groupedDoc();
		const gone = new UpdateItems("nope", new Set(["e1"]), (i) => i, "x");
		gone.apply(doc);
		gone.revert(doc);
		const missing = new UpdateItems("p1", new Set(["zzz"]), (i) => ({ ...i, group: "q" }), "x");
		missing.apply(doc);
		missing.revert(doc);
		expect(doc.pages[0]!.elements![0]!.group).toBe("g1");
	});
});

describe("groups: copies, clipboard and templates", () => {
	it("pasting or duplicating a selection gives the copies one new group id, and keeps locks", () => {
		const page = groupedDoc().pages[0]!;
		const members = { strokes: [page.strokes[0]!, page.strokes[1]!], elements: [page.elements![0]!, page.elements![1]!] };
		const clip = captureClip(members.strokes, members.elements, {})!;
		const a = instantiateClip(clip, 10, 10);
		const b = instantiateClip(clip, 20, 20);
		const ids = new Set([...a.strokes, ...a.elements].map((i) => i.group));
		expect(ids.size).toBe(1);
		expect([...ids][0]).toBeDefined();
		expect([...ids][0]).not.toBe("g1");
		expect(b.strokes[0]!.group).not.toBe(a.strokes[0]!.group);
		const lockedClip = captureClip([], [page.elements![2]!], {})!;
		const copy = instantiateClip(lockedClip, 5, 5).elements[0]!;
		expect(copy).toMatchObject({ locked: true, lockAt: T0 });
		expect(copy.id).not.toBe("e3");
	});

	it("a lone member of a copied group is saved without it (the writer releases it)", () => {
		const page = groupedDoc().pages[0]!;
		const clip = captureClip([page.strokes[0]!], [], {})!;
		const out = instantiateClip(clip, 0, 0);
		const doc = createDocument(new Date(stamp));
		doc.pages[0]!.strokes.push(...out.strokes);
		expect(serialize(doc)).not.toContain('"group"');
	});

	it("duplicating a page gives its strokes and elements groups of their own", () => {
		const page = groupedDoc().pages[0]!;
		const copy = duplicatePage(page);
		const group = copy.strokes[0]!.group;
		expect(group).toBeDefined();
		expect(group).not.toBe("g1");
		expect(copy.strokes[1]!.group).toBe(group);
		expect(copy.elements![0]!.group).toBe(group);
		expect(copy.elements![1]!.group).toBe(group);
		expect(copy.strokes[2]!.group).toBeUndefined();
		expect(copy.elements![2]).toMatchObject({ locked: true, lockAt: T0 });
		expect(page.strokes[0]!.group).toBe("g1");
	});

	it("a template made from a notebook keeps its groups (under new ids) and its locks", () => {
		const t = templateFromNotebook(groupedDoc());
		const p = t.pages[0]!;
		expect(p.strokes[0]!.group).toBeDefined();
		expect(p.strokes[0]!.group).not.toBe("g1");
		expect(p.elements![2]!.locked).toBe(true);
		const fresh = notebookFromTemplate(t);
		expect(serializeChecked(fresh).ok).toBe(true);
		expect(fresh.pages[0]!.elements![2]!.locked).toBe(true);
	});

	it("groupRenamer gives the same new id to the same old one", () => {
		let n = 0;
		const rename = groupRenamer(() => `n${++n}`);
		expect([rename("a"), rename("b"), rename("a")]).toEqual(["n1", "n2", "n1"]);
	});
});

describe("groups: merge", () => {
	function twoCopies() {
		const main = groupedDoc();
		const other = parsed(serialize(main)).doc;
		return { main, other };
	}

	function run(main: NotebookDocument, other: NotebookDocument) {
		const plan = planMerge(main, other);
		if (plan.command) new History(() => main).execute(plan.command);
		return plan;
	}

	it("the same items with the same flags are not added twice", () => {
		const { main, other } = twoCopies();
		const plan = planMerge(main, other);
		expect(plan.command).toBeNull();
		expect(plan.summary.flagsUpdated).toBe(0);
		expect(mergeCovers(main, other)).toBe(true);
	});

	it("an element locked on one device only is the same element: it is locked in the result, never copied", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.elements![0] = frame("e1", 100, 100, { group: "g1", locked: true, lockAt: T0 + 50 });
		const plan = run(main, other);
		expect(plan.summary.elementsCopied).toBe(0);
		expect(plan.summary.flagsUpdated).toBe(1);
		expect(main.pages[0]!.elements).toHaveLength(3);
		expect(main.pages[0]!.elements![0]).toMatchObject({ locked: true, lockAt: T0 + 50 });
		expect(planMerge(main, other).command).toBeNull();
	});

	it("the later lock decision wins, an unlock included, either way round", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.elements![2] = frame("e3", 300, 100, { lockAt: T0 + 9 });
		run(main, other);
		expect(main.pages[0]!.elements![2]!.locked).toBeUndefined();
		expect(main.pages[0]!.elements![2]!.lockAt).toBe(T0 + 9);
		const a = groupedDoc();
		const b = parsed(serialize(a)).doc;
		a.pages[0]!.elements![2] = frame("e3", 300, 100, { lockAt: T0 + 9 });
		b.pages[0]!.elements![2] = frame("e3", 300, 100, { locked: true, lockAt: T0 });
		run(a, b);
		expect(a.pages[0]!.elements![2].locked).toBeUndefined();
	});

	it("a tie that disagrees keeps the lock", () => {
		const main = frame("m", 1, 1);
		expect(mergedFlags(main, frame("m", 1, 1, { locked: true }))).toMatchObject({ locked: true });
		expect(mergedFlags(frame("m", 1, 1, { locked: true }), frame("m", 1, 1))).toBeNull();
	});

	it("an item in no group takes the copy's group: membership is united by id", () => {
		const { main, other } = twoCopies();
		const m = main.pages[0]!;
		m.strokes[1] = stroke("s2", 20, 60);
		m.elements![1] = frame("e2", 100, 200);
		const plan = run(main, other);
		expect(plan.summary.flagsUpdated).toBe(2);
		expect(m.strokes[1].group).toBe("g1");
		expect(m.elements![1].group).toBe("g1");
		expect(m.strokes).toHaveLength(3);
	});

	it("the main notebook's group stands when both have one", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.strokes[0] = stroke("s1", 20, 20, { group: "other" });
		run(main, other);
		expect(main.pages[0]!.strokes[0]!.group).toBe("g1");
	});

	it("a new item of the copy comes with its group and lock", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.elements!.push(frame("e4", 400, 400, { group: "g1", locked: true, lockAt: T0 }));
		run(main, other);
		expect(main.pages[0]!.elements![3]).toMatchObject({ id: "e4", group: "g1", locked: true });
	});

	it("is one undo step", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.elements![0] = frame("e1", 100, 100, { group: "g1", locked: true, lockAt: T0 + 50 });
		const plan = planMerge(main, other);
		const h = new History(() => main);
		h.execute(plan.command!);
		h.undo();
		expect(main.pages[0]!.elements![0]!.locked).toBeUndefined();
		expect(main.pages[0]!.elements).toHaveLength(3);
	});
});

describe("groups: repair", () => {
	it("keeps the groups and locks of a truncated file", () => {
		const doc = stressDocument(40, 2, 3);
		const p0 = doc.pages[0]!;
		p0.strokes[0] = stroke(p0.strokes[0]!.id, 1, 1, { group: "gg" });
		p0.strokes[1] = stroke(p0.strokes[1]!.id, 9, 9, { group: "gg" });
		p0.elements = [frame("el1", 100, 100, { locked: true, lockAt: T0, group: "gg" })];
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const page = r.doc.pages[0]!;
		expect(page.strokes[0]!.group).toBe("gg");
		expect(page.strokes[1]!.group).toBe("gg");
		expect(page.elements![0]).toMatchObject({ locked: true, group: "gg" });
		expect(parse(r.text).ok).toBe(true);
	});

	it("releases a group that lost its other members and counts it", () => {
		const doc = stressDocument(40, 2, 3);
		const p0 = doc.pages[0]!;
		p0.strokes[0] = stroke(p0.strokes[0]!.id, 1, 1, { group: "gg" });
		p0.strokes[1] = stroke(p0.strokes[1]!.id, 9, 9, { group: "gg" });
		// the second stroke is moved to another group by hand: both groups now have one member
		const lines = serialize(doc).split("\n");
		const at = lines.findIndex((l, i) => l.includes('"group":"gg"') && lines.slice(0, i).some((x) => x.includes('"group":"gg"')));
		lines[at] = lines[at]!.replace('"group":"gg"', '"group":"zz"');
		const text = lines.join("\n");
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.fieldsReset).toBeGreaterThanOrEqual(2);
		expect(r.doc.pages[0]!.strokes.every((s) => s.group === undefined)).toBe(true);
		expect(parse(r.text).ok).toBe(true);
	});

	it("a clean v18 file with groups needs no repair", () => {
		const r = repairNotebookText(serialize(groupedDoc()));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.summary.alreadyReadable).toBe(true);
	});
});

describe("groups: the notebook as a whole", () => {
	it("a document with groups and locks round-trips through parse and serializeChecked", () => {
		const doc = groupedDoc();
		const text = serialize(doc);
		const back = parsed(text);
		expect(back.migratedFrom).toBeNull();
		expect(back.dropped).toBeUndefined();
		const page: Page = back.doc.pages[0]!;
		expect(groupStats({ strokes: page.strokes, elements: page.elements! })).toEqual({ groups: 1, grouped: 4, total: 6 });
	});
});
