/**
 * Review fixes for groups and locked elements (format v18, review G1-G9): merge counts and batches, lone group joins, the lock check
 * of `mergeCovers`, groups across pages and in a page split, locked markers, selection completed to its groups, the pieces of a
 * cut stroke, the repair summary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);
const opened = vi.hoisted(() => [] as string[]);

vi.mock("obsidian", () => ({
	Notice: class {
		constructor(message: string) {
			notices.push(message);
		}
	},
	Modal: class {
		constructor(public app: unknown) {}
		open() {
			opened.push("modal");
		}
	},
	FuzzySuggestModal: class {
		constructor(public app: unknown) {}
	},
	Setting: class {},
	getLanguage: () => "en",
}));

import { eraseAreaCommand } from "../src/ink/erase-area";
import { planCrossPageTransform, type PagePart } from "../src/ink/cross-page";
import { planPageSplit } from "../src/ink/heavy-page";
import { layoutPages } from "../src/ink/layout";
import { translate } from "../src/ink/transform";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { hasGroupMate, groupJoins, selectableItems, strokePieces, UpdateItems } from "../src/model/groups";
import { Batch, History } from "../src/model/history";
import { mergeChangeCount, mergeCovers, planMerge } from "../src/model/merge";
import { repairNotebookText } from "../src/model/repair";
import { freezeElement, freezeStroke, parse, serialize, serializeChecked } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import type { BoxElement, MarkerElement, NotebookDocument, Page, PageElement, Stroke } from "../src/model/types";
import { combineCandidates } from "../src/storage/recovery";
import { MarkerTools, type MarkerHost } from "../src/view/markers";

const stamp = "2026-11-05T10:00:00.000Z";
const T0 = 1_760_000_000_000;

function stroke(id: string, x: number, y: number, over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + 30, y + 5, 0.5], [x + 15, y + 10, 0.5]]), id, ...over });
}

function box(id: string, x = 100, y = 100, over: Partial<BoxElement> = {}): BoxElement {
	return freezeElement({ id, type: "box", kind: "definition", x, y, width: 80, height: 40, ...over });
}

function docWith(strokes: Stroke[], elements: PageElement[] = []): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.id = "p1";
	page.strokes.push(...strokes);
	if (elements.length > 0) page.elements = elements;
	return doc;
}

function copyOf(doc: NotebookDocument): NotebookDocument {
	const r = parse(serialize(doc));
	if (!r.ok) throw new Error(r.message);
	return r.doc;
}

function run(main: NotebookDocument, other: NotebookDocument) {
	const plan = planMerge(main, other);
	if (plan.command) new History(() => main).execute(plan.command);
	return plan;
}

function updates(plan: ReturnType<typeof planMerge>): UpdateItems[] {
	const inner = (plan.command as unknown as { inner: Batch }).inner;
	return inner.commands.filter((c): c is UpdateItems => c instanceof UpdateItems);
}

describe("G1: a merge that only brings flags counts as a change", () => {
	function lockedLater() {
		const main = docWith([stroke("s1", 20, 20)], [box("e1")]);
		const other = copyOf(main);
		other.pages[0]!.elements![0] = box("e1", 100, 100, { locked: true, lockAt: T0 });
		return { main, other };
	}

	it("counts the flag change", () => {
		const { main, other } = lockedLater();
		const plan = planMerge(main, other);
		expect(plan.command).not.toBeNull();
		expect(plan.summary.flagsUpdated).toBe(1);
		expect(mergeChangeCount(plan.summary)).toBe(1);
	});

	it("the recovery union keeps the other candidate's lock", () => {
		const { main, other } = lockedLater();
		const r = combineCandidates(
			{ text: serialize(main), doc: main } as Parameters<typeof combineCandidates>[0],
			{ text: serialize(other), doc: other } as Parameters<typeof combineCandidates>[1],
		);
		expect(r).not.toBeNull();
		expect(r!.added).toBe(1);
		expect(r!.doc.pages[0]!.elements![0]).toMatchObject({ locked: true, lockAt: T0 });
	});
});

describe("G2: one UpdateItems per page, linear", () => {
	it("groups 3000 strokes of a copy with one command, and undo and redo restore it", () => {
		const strokes = Array.from({ length: 3000 }, (_, i) => stroke(`s${i}`, i % 100, Math.floor(i / 100) * 10));
		const main = docWith(strokes);
		const other = copyOf(main);
		other.pages[0]!.strokes = other.pages[0]!.strokes.map((s) => freezeStroke({ ...s, group: "g1" }));
		const plan = planMerge(main, other);
		expect(plan.summary.flagsUpdated).toBe(3000);
		expect(updates(plan)).toHaveLength(1);
		const h = new History(() => main);
		h.execute(plan.command!);
		expect(main.pages[0]!.strokes.every((s) => s.group === "g1")).toBe(true);
		h.undo();
		expect(main.pages[0]!.strokes.every((s) => s.group === undefined)).toBe(true);
		h.redo();
		expect(main.pages[0]!.strokes.every((s) => s.group === "g1")).toBe(true);
		expect(serializeChecked(main).ok).toBe(true);
	});

	it("one command per page that has flags to bring", () => {
		const main = docWith([stroke("s1", 20, 20), stroke("s2", 20, 60)]);
		main.pages.push(createPage({ width: main.pages[0]!.width, height: main.pages[0]!.height }));
		const p2 = main.pages[1]!;
		p2.id = "p2";
		p2.strokes.push(stroke("t1", 20, 20), stroke("t2", 20, 60));
		const other = copyOf(main);
		for (const p of other.pages) p.strokes = p.strokes.map((s) => freezeStroke({ ...s, group: `g-${p.id}` }));
		const plan = run(main, other);
		expect(updates(plan)).toHaveLength(2);
		expect(main.pages.map((p) => p.strokes.map((s) => s.group))).toEqual([["g-p1", "g-p1"], ["g-p2", "g-p2"]]);
	});
});

describe("G3: an item never joins a group of one", () => {
	it("keeps C free when the copy's group of C has no other member here", () => {
		const main = docWith([stroke("a", 20, 20, { group: "g1" }), stroke("b", 20, 60, { group: "g1" }), stroke("c", 20, 100)]);
		const other = copyOf(main);
		// The copy grouped B and C instead of A and B.
		other.pages[0]!.strokes = [stroke("a", 20, 20), stroke("b", 20, 60, { group: "g2" }), stroke("c", 20, 100, { group: "g2" })];
		const plan = run(main, other);
		expect(main.pages[0]!.strokes.map((s) => s.group)).toEqual(["g1", "g1", undefined]);
		expect(plan.summary.flagsUpdated).toBe(0);
		// ... and the copy is not offered again.
		const again = planMerge(main, other);
		expect(again.command).toBeNull();
		expect(mergeChangeCount(again.summary)).toBe(0);
	});

	it("joins when two items of the copy's group are free here", () => {
		const main = docWith([stroke("a", 20, 20), stroke("b", 20, 60)]);
		const other = copyOf(main);
		other.pages[0]!.strokes = [stroke("a", 20, 20, { group: "g" }), stroke("b", 20, 60, { group: "g" })];
		run(main, other);
		expect(main.pages[0]!.strokes.map((s) => s.group)).toEqual(["g", "g"]);
	});

	it("joins a group whose other member is a new item the merge adds", () => {
		const main = docWith([stroke("a", 20, 20)]);
		const other = copyOf(main);
		other.pages[0]!.strokes = [stroke("a", 20, 20, { group: "g" }), stroke("b", 20, 60, { group: "g" })];
		run(main, other);
		expect(main.pages[0]!.strokes.map((s) => [s.id, s.group])).toEqual([["a", "g"], ["b", "g"]]);
	});

	it("groupJoins drops a join that would leave another group of one, until stable", () => {
		const page = { strokes: [stroke("a", 1, 1), stroke("b", 1, 1), stroke("c", 1, 1, { group: "x" })], elements: [] };
		const copies = new Map<string, Stroke>([["a", stroke("a", 1, 1, { group: "x" })], ["b", stroke("b", 1, 1, { group: "y" })]]);
		// x has c and a (two), y has only b: only a joins.
		expect([...groupJoins(page, [], copies)]).toEqual(["a"]);
	});
});

describe("G4: mergeCovers checks the lock", () => {
	const result = (over: Partial<BoxElement>) => docWith([], [box("e1", 100, 100, over)]);
	const copy = (over: Partial<BoxElement>) => docWith([], [box("e1", 100, 100, over)]);

	it("is not covered when the copy locked or unlocked later than the result", () => {
		expect(mergeCovers(result({}), copy({ locked: true, lockAt: T0 }))).toBe(false);
		expect(mergeCovers(result({ locked: true, lockAt: T0 }), copy({ lockAt: T0 + 5 }))).toBe(false);
	});

	it("is not covered when the copy's lock ties with the result's unlock", () => {
		expect(mergeCovers(result({ lockAt: T0 }), copy({ locked: true, lockAt: T0 }))).toBe(false);
	});

	it("is covered when the result decided as late or later", () => {
		expect(mergeCovers(result({ locked: true, lockAt: T0 }), copy({ locked: true, lockAt: T0 }))).toBe(true);
		expect(mergeCovers(result({ lockAt: T0 + 9 }), copy({ locked: true, lockAt: T0 }))).toBe(true);
		expect(mergeCovers(result({ locked: true, lockAt: T0 }), copy({ lockAt: T0 }))).toBe(true);
	});
});

describe("G5: groups across pages", () => {
	function twoPages(strokes: Stroke[]): { doc: NotebookDocument; boxes: ReturnType<typeof layoutPages>["boxes"] } {
		const doc = createDocument(new Date(stamp), { width: 200, height: 300 });
		doc.pages.push(createPage({ width: 200, height: 300 }));
		doc.pages[0]!.strokes.push(...strokes);
		return { doc, boxes: layoutPages(doc.pages).boxes };
	}
	const move = (doc: NotebookDocument, boxes: ReturnType<typeof layoutPages>["boxes"], selected: Stroke[], dy: number) => {
		let n = 0;
		const parts: PagePart[] = [{ pageIndex: 0, strokes: selected, elements: [] }];
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts, matrix: translate(0, dy), newGroupId: () => `new${++n}` })!;
		new History(() => doc).execute(plan.command);
		return plan;
	};

	it("members that arrive together form a new group on the page they went to; the ones left behind keep theirs", () => {
		const group = (id: string, y: number) => stroke(id, 40, y, { group: "g" });
		const all = [group("a", 40), group("b", 60), group("c", 140), group("d", 150)];
		const { doc, boxes } = twoPages(all);
		move(doc, boxes, [all[2]!, all[3]!], 200);
		const p0 = doc.pages[0]!;
		const p1 = doc.pages[1]!;
		expect(p0.strokes.map((s) => [s.id, s.group])).toEqual([["a", "g"], ["b", "g"]]);
		expect(p1.strokes.map((s) => [s.id, s.group])).toEqual([["c", "new1"], ["d", "new1"]]);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("a member that goes alone leaves its group, and a group of two left behind is released", () => {
		const all = [stroke("a", 40, 40, { group: "g" }), stroke("b", 40, 60, { group: "g" }), stroke("c", 40, 140, { group: "g" })];
		const { doc, boxes } = twoPages(all);
		move(doc, boxes, [all[2]!], 200);
		expect(doc.pages[1]!.strokes[0]!.group).toBeUndefined();
		expect(doc.pages[0]!.strokes.map((s) => s.group)).toEqual(["g", "g"]);
		// Now one of the two goes: it arrives free, the other is alone (the writer releases it; it is not touched here).
		const second = twoPages([stroke("a", 40, 40, { group: "g" }), stroke("b", 40, 140, { group: "g" })]);
		move(second.doc, second.boxes, [second.doc.pages[0]!.strokes[1]!], 200);
		expect(second.doc.pages[1]!.strokes[0]!.group).toBeUndefined();
		expect(copyOf(second.doc).pages[0]!.strokes[0]!.group).toBeUndefined();
		// Both of a pair selected: neither stays behind with a group, and the one that stays in place is released too.
		const third = twoPages([stroke("a", 40, 40, { group: "g" }), stroke("b", 40, 140, { group: "g" })]);
		move(third.doc, third.boxes, third.doc.pages[0]!.strokes.slice(), 200);
		expect(third.doc.pages[0]!.strokes.every((s) => s.group === undefined)).toBe(true);
	});

	it("a whole group that moves keeps together under a fresh id, and undo puts the old one back", () => {
		const all = [stroke("a", 40, 140, { group: "g" }), stroke("b", 40, 150, { group: "g" })];
		const { doc, boxes } = twoPages(all);
		const before = serialize(doc);
		const h = new History(() => doc);
		const parts: PagePart[] = [{ pageIndex: 0, strokes: all, elements: [] }];
		h.execute(planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts, matrix: translate(0, 200), newGroupId: () => "fresh" })!.command);
		expect(doc.pages[1]!.strokes.map((s) => s.group)).toEqual(["fresh", "fresh"]);
		h.undo();
		expect(serialize(doc)).toBe(before);
	});
});

describe("G5: Split page", () => {
	function word(id: string, y: number, over: Partial<Stroke> = {}): Stroke {
		return stroke(id, 50, y, over);
	}
	function page(strokes: Stroke[], elements: PageElement[] = []): Page {
		const doc = docWith(strokes, elements);
		return doc.pages[0]!;
	}
	const lines = (n: number, over: (i: number) => Partial<Stroke> = () => ({})): Stroke[] => Array.from({ length: n }, (_, i) => word(`s${i}`, 60 + i * 30, over(i)));

	it("a group that straddles the cut goes whole to one side", () => {
		const p = page(lines(10, (i) => (i === 3 || i === 5 ? { group: "g" } : {})));
		const plan = planPageSplit(p, 0)!;
		const ids = (list: readonly Stroke[]) => list.map((s) => s.id);
		const staying = ids(plan.changes[0]!.strokes);
		const moved = ids(plan.appended[0]!.strokes);
		expect([staying.includes("s3"), staying.includes("s5")]).toEqual([true, true]);
		expect(moved.includes("s3") || moved.includes("s5")).toBe(false);
	});

	it("a locked element stays on the page", () => {
		const p = page(lines(10), [box("lk", 100, 280, { locked: true, lockAt: T0 }), box("fr", 100, 300)]);
		const plan = planPageSplit(p, 0)!;
		expect(plan.changes[0]!.elements!.map((e) => e.id)).toContain("lk");
		expect(plan.appended[0]!.elements.map((e) => e.id)).not.toContain("lk");
		expect(plan.appended[0]!.elements.map((e) => e.id)).toContain("fr");
	});

	it("refuses when everything that would move is locked", () => {
		const p = page([word("s0", 50)], [box("lk", 100, 500, { locked: true, lockAt: T0 })]);
		expect(planPageSplit(p, 0)).toBeNull();
	});

	it("members that move away from a locked mate form a new group on the new page", () => {
		const p = page(lines(10, (i) => (i >= 8 ? { group: "g" } : {})), [box("lk", 100, 70, { group: "g", locked: true, lockAt: T0 })]);
		const plan = planPageSplit(p, 0)!;
		const moved = plan.appended[0]!.strokes;
		expect(moved.map((s) => s.id)).toEqual(expect.arrayContaining(["s8", "s9"]));
		const g = moved.find((s) => s.id === "s8")!.group;
		expect(g).toBeDefined();
		expect(g).not.toBe("g");
		expect(moved.find((s) => s.id === "s9")!.group).toBe(g);
		// the locked one is alone on the old page now
		expect(plan.changes[0]!.elements!.find((e) => e.id === "lk")!.group).toBeUndefined();
	});
});

describe("G6: a locked marker or box is not edited or deleted", () => {
	beforeEach(() => {
		notices.length = 0;
		opened.length = 0;
	});

	function tools(): { tools: MarkerTools; executed: unknown[] } {
		const executed: unknown[] = [];
		const host = { app: {}, doc: () => null, editable: () => true, execute: (c: unknown) => void executed.push(c) } as unknown as MarkerHost;
		return { tools: new MarkerTools(host), executed };
	}

	it("opens no editor for a locked marker, and says why", () => {
		const { tools: t } = tools();
		const marker = freezeElement<MarkerElement>({ id: "m1", type: "marker", kind: "homework", x: 10, y: 10, locked: true, lockAt: T0 });
		t.editMarkerDialog(page([marker]), marker);
		expect(opened).toEqual([]);
		expect(notices).toEqual(["This element is locked. Unlock it to edit or delete it."]);
	});

	it("opens no editor for a locked box", () => {
		const { tools: t } = tools();
		const b = box("b1", 10, 10, { locked: true, lockAt: T0 });
		t.editBoxDialog(page([b]), b);
		expect(opened).toEqual([]);
		expect(notices).toHaveLength(1);
	});

	it("still opens the editor of an unlocked marker", () => {
		const { tools: t } = tools();
		const marker = freezeElement<MarkerElement>({ id: "m2", type: "marker", kind: "homework", x: 10, y: 10 });
		t.editMarkerDialog(page([marker]), marker);
		expect(opened).toEqual(["modal"]);
		expect(notices).toEqual([]);
	});

	function page(elements: PageElement[]): Page {
		return docWith([], elements).pages[0]!;
	}
});

describe("G7: a selection made by a tool is completed to its groups", () => {
	function groupedPage(): Page {
		return docWith(
			[stroke("s1", 20, 20, { group: "g1" }), stroke("s2", 20, 60, { group: "g1" }), stroke("s3", 300, 300)],
			[box("e1", 100, 100, { group: "g1" }), box("e2", 100, 200, { group: "g1" }), box("e3", 300, 100, { locked: true, lockAt: T0, group: "g1" })],
		).pages[0]!;
	}

	it("brings in the other members and never a locked one", () => {
		const p = groupedPage();
		const sel = selectableItems(p, { strokes: [p.strokes[0]!], elements: [] });
		expect(sel.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
		expect(sel.elements.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
	});

	it("drops a locked element that was asked for", () => {
		const p = groupedPage();
		const sel = selectableItems(p, { strokes: [p.strokes[2]!], elements: [p.elements![2]!] });
		expect(sel.strokes.map((s) => s.id)).toEqual(["s3"]);
		expect(sel.elements).toEqual([]);
	});
});

describe("G8: a group that is gone does not come back with the pieces of a cut", () => {
	it("a lone member's pieces are free, a member with a mate keeps the group", () => {
		const lone = stroke("s", 20, 20, { group: "g" });
		const p = docWith([lone]).pages[0]!;
		expect(hasGroupMate(p, lone)).toBe(false);
		const runs = [[[1, 1, 0.5], [5, 5, 0.5]], [[8, 8, 0.5], [9, 9, 0.5]]] as Stroke["points"][];
		let n = 0;
		const free = strokePieces(p, lone, runs, () => `n${++n}`);
		expect(free.map((s) => [s.id, s.group])).toEqual([["n1", undefined], ["n2", undefined]]);
		const mate = docWith([lone, stroke("m", 20, 60, { group: "g" })]).pages[0]!;
		expect(strokePieces(mate, lone, runs).every((s) => s.group === "g")).toBe(true);
	});

	it("the area eraser cuts a lone member into free pieces", () => {
		const long = freezeStroke({ ...createStroke("#111111", 2, [[0, 50, 0.5], [100, 50, 0.5]]), id: "long", group: "g" });
		const p = docWith([long]).pages[0]!;
		const poly: Array<[number, number]> = [[40, 0], [60, 0], [60, 100], [40, 100]];
		const cmd = eraseAreaCommand(p, poly, { filter: { kind: "all", color: "#000000" }, includeElements: false })!;
		const doc = docWith([long]);
		cmd.apply(doc);
		expect(doc.pages[0]!.strokes.length).toBe(2);
		expect(doc.pages[0]!.strokes.every((s) => s.group === undefined)).toBe(true);
	});
});

describe("G9: an invalid group is counted once by the repair", () => {
	it("is a reset field, not also an unknown one", () => {
		const doc = stressDocument(40, 2, 3);
		const p0 = doc.pages[0]!;
		p0.strokes[0] = stroke(p0.strokes[0]!.id, 1, 1, { group: "gg" });
		p0.strokes[1] = stroke(p0.strokes[1]!.id, 9, 9, { group: "gg" });
		const text = serialize(doc).replace('"group":"gg"', '"group":""');
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.fieldsReset).toBeGreaterThanOrEqual(1);
		expect(r.summary.unknownFields).toBe(0);
	});
});
