/**
 * 0.17 review fixes (E1-E7): the ink a collapsed sticky note keeps hidden is never selected, so every path that copies, cuts,
 * duplicates, moves, erases, deletes or merges must account for it through the note's own list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class Stub {}
	const real: Record<string, unknown> = {
		setIcon: () => undefined,
		getLanguage: () => "en",
		Notice: class {
			hide(): void {}
			setMessage(): void {}
		},
		Menu: class {
			addItem(): this {
				return this;
			}
			showAtMouseEvent(): void {}
		},
	};
	return new Proxy(real, { get: (target, key) => (key === "then" ? undefined : key in target ? target[key as string] : Stub), has: (_t, key) => key !== "then" });
});
vi.mock("../src/library/library-modals", () => ({ PromptModal: class {} }));
vi.mock("../src/view/toolbar", () => ({ PEN_COLORS: ["#111111"], PEN_WIDTHS: [1], HIGHLIGHTER_COLORS: ["#ffee00"], HIGHLIGHTER_WIDTHS: [10] }));

import { deleteSelectionCommands, pinnedInk } from "../src/ink/attach";
import { instantiateClip, pasteCommand } from "../src/ink/clipboard";
import { eraseAreaCommand } from "../src/ink/erase-area";
import { measureText } from "../src/ink/renderer";
import { detectScribble, erasableStrokes, scribbleEraseSteps, scribbleVictims } from "../src/ink/scribble";
import { planSpaceChange } from "../src/ink/space";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { Batch, History, type Command } from "../src/model/history";
import { planMerge } from "../src/model/merge";
import { pageContentCommand } from "../src/model/page-content";
import { planMoveToPage } from "../src/model/selection-move";
import { freezeElement, freezeStroke, parse, serialize, serializeChecked } from "../src/model/serialize";
import { hiddenStickyInk } from "../src/model/sticky";
import type { NotebookDocument, Page, Point, StickyElement, Stroke } from "../src/model/types";
import { internalClip } from "../src/view/clipboard";
import { SelectionActions, type SelectionHost, type SelectionState } from "../src/view/selection-actions";

const stamp = "2026-11-05T10:00:00.000Z";

function stroke(id: string, x: number, y: number): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + 20, y, 0.5], [x + 20, y + 10, 0.5]]), id });
}

function note(id: string, over: Partial<StickyElement> = {}): StickyElement {
	return freezeElement({ id, type: "sticky", x: 100, y: 100, width: 150, height: 150, color: "#F59E0B", fontSize: 14, ...over });
}

/** Page p1: collapsed note n1 hiding s1 and s2 (lying where the open note was), plus ink off the note (s3). */
function collapsedDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp), { width: 400, height: 600 });
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.id = "p1";
	page.elements = [note("n1", { collapsed: true, ink: ["s1", "s2"] })];
	page.strokes.push(stroke("s1", 110, 178), stroke("s2", 115, 188), stroke("s3", 300, 400));
	return doc;
}

/** Ids the notes of a page hide that are strokes of the page. */
function liveHidden(page: Page): string[] {
	const ids = new Set(page.strokes.map((s) => s.id));
	return [...(hiddenStickyInk(page.elements) ?? [])].filter((id) => ids.has(id));
}

// --- E1: copy, cut, duplicate through the real selection actions ---

class El {
	dataset: Record<string, string> = {};
	createDiv(): El {
		return new El();
	}
	empty(): void {}
	remove(): void {}
	addClass(): void {}
	toggleClass(): void {}
	addEventListener(): void {}
}

interface Rig {
	history: History;
	actions: SelectionActions;
	published: unknown[];
	selected: Array<{ pageIndex: number; strokes: Stroke[]; elements: unknown[] }>;
}

/** Selection actions over `doc` with the real delete path (`deleteSelectionCommands`, the one the view uses) and a real history. */
function rig(doc: NotebookDocument, sel: SelectionState): Rig {
	const history = new History(() => doc);
	const published: unknown[] = [];
	const selected: Rig["selected"] = [];
	const host: Partial<SelectionHost> = {
		doc: () => doc,
		media: () => null,
		editable: () => true,
		selection: () => sel,
		boxes: () => doc.pages.map((_, i) => ({ x: 0, y: i * 700, width: 400, height: 600 })),
		execute: (cmd: Command) => history.execute(cmd),
		select: (pageIndex, strokes, elements) => void selected.push({ pageIndex, strokes, elements }),
		sharedClips: () => ({ publish: (clip: unknown) => { published.push(clip); return Promise.resolve(); } }) as never,
		deleteSelection: () => {
			const page = doc.pages[sel.pageIndex]!;
			const { commands } = deleteSelectionCommands(page, sel.strokes, sel.elements);
			history.execute(new Batch("Delete selection", commands));
		},
	};
	const actions = new SelectionActions(new El() as unknown as HTMLElement, host as SelectionHost);
	return { history, actions, published, selected };
}

function twoNotePages(): NotebookDocument {
	const doc = collapsedDoc();
	const p2 = createPage({ width: 400, height: 600 });
	p2.elements = [note("n2", { collapsed: true, ink: ["t1"] })];
	p2.strokes.push(stroke("t1", 120, 160));
	doc.pages.push(p2);
	return doc;
}

describe("E1: a collapsed note's hidden ink travels with the note", () => {
	beforeEach(() => internalClip.clear());

	it("copy: the clip holds the note and its two hidden strokes, and the pasted note names the copies", () => {
		const doc = collapsedDoc();
		const r = rig(doc, { pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!] });
		expect(r.actions.copySync()).not.toBeNull();
		const clip = internalClip.get()!.content;
		expect(clip.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
		const made = instantiateClip(clip, 30, 30, undefined, measureText);
		const el = made.elements[0] as StickyElement;
		expect(el.ink).toHaveLength(2);
		expect(el.ink!.every((id) => made.strokes.some((s) => s.id === id))).toBe(true);
		expect(el.ink!.some((id) => id === "s1" || id === "s2")).toBe(false);
		// The source is untouched.
		expect(doc.pages[0]!.strokes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
	});

	it("cut then paste: the note comes back with its ink (not an empty note), the original is gone", async () => {
		const doc = collapsedDoc();
		const r = rig(doc, { pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!] });
		await r.actions.cut();
		const page = doc.pages[0]!;
		expect(page.elements).toEqual([]);
		expect(page.strokes.map((s) => s.id)).toEqual(["s3"]);
		const made = instantiateClip(internalClip.get()!.content, 10, 10, undefined, measureText);
		new History(() => doc).execute(pasteCommand(page, made.strokes, made.elements, []));
		expect(page.elements).toHaveLength(1);
		expect(liveHidden(page)).toHaveLength(2);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("duplicate: a second note with its own two strokes; the first keeps its ink", () => {
		const doc = collapsedDoc();
		const r = rig(doc, { pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!] });
		r.actions.duplicate();
		const page = doc.pages[0]!;
		expect(page.elements).toHaveLength(2);
		expect(page.strokes).toHaveLength(5);
		const [a, b] = page.elements as StickyElement[];
		expect(a!.ink).toEqual(["s1", "s2"]);
		expect(b!.ink).toHaveLength(2);
		expect(b!.ink!.some((id) => a!.ink!.includes(id))).toBe(false);
		expect(liveHidden(page)).toHaveLength(4);
	});

	it("duplicate across pages: each page's note takes its ink", () => {
		const doc = twoNotePages();
		const r = rig(doc, {
			pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!],
			others: [{ pageIndex: 1, strokes: [], elements: [doc.pages[1]!.elements![0]!] }],
		});
		r.actions.duplicate();
		expect(doc.pages[0]!.elements).toHaveLength(2);
		expect(doc.pages[1]!.elements).toHaveLength(2);
		expect(liveHidden(doc.pages[0]!)).toHaveLength(4);
		expect(liveHidden(doc.pages[1]!)).toHaveLength(2);
	});

	it("copy across pages (cross-page capture): the clip holds the hidden ink of both notes", () => {
		const doc = twoNotePages();
		const r = rig(doc, {
			pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!],
			others: [{ pageIndex: 1, strokes: [], elements: [doc.pages[1]!.elements![0]!] }],
		});
		r.actions.copySync();
		expect(internalClip.get()!.content.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "t1"]);
	});

	it("copy to other devices: the published clip holds the hidden ink", async () => {
		const doc = collapsedDoc();
		const r = rig(doc, { pageIndex: 0, strokes: [], elements: [doc.pages[0]!.elements![0]!] });
		await r.actions.copyToDevices();
		expect(r.published).toHaveLength(1);
		expect((r.published[0] as { strokes: Stroke[] }).strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
	});

	it("a note selected together with ink of its own: nothing is taken twice", () => {
		const doc = collapsedDoc();
		const [s1, , s3] = doc.pages[0]!.strokes;
		const r = rig(doc, { pageIndex: 0, strokes: [s3!, s1!], elements: [doc.pages[0]!.elements![0]!] });
		r.actions.copySync();
		expect(internalClip.get()!.content.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
	});
});

// --- E2: move to another page ---

describe("E2: moving a collapsed note to another page takes its ink", () => {
	function twoPages(): NotebookDocument {
		const doc = collapsedDoc();
		doc.pages.push(createPage({ width: 400, height: 600 }));
		return doc;
	}

	it("move: the ink leaves the source page and the note on the target names it", () => {
		const doc = twoPages();
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [], elements: [doc.pages[0]!.elements![0]!], mode: "move" });
		if ("refused" in plan) throw new Error(plan.refused);
		expect(new History(() => doc).execute(plan.command)).toBe(true);
		expect(doc.pages[0]!.strokes.map((s) => s.id)).toEqual(["s3"]);
		expect(doc.pages[1]!.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(liveHidden(doc.pages[1]!)).toEqual(["s1", "s2"]);
		// The selection handed back holds the note only (its ink is hidden).
		expect(plan.strokes).toEqual([]);
		expect(plan.elements).toHaveLength(1);
	});

	it("copy: the target gets the note and its own copy of the ink; the source is unchanged", () => {
		const doc = twoPages();
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [], elements: [doc.pages[0]!.elements![0]!], mode: "copy" });
		if ("refused" in plan) throw new Error(plan.refused);
		new History(() => doc).execute(plan.command);
		expect(doc.pages[0]!.strokes).toHaveLength(3);
		expect(doc.pages[1]!.strokes).toHaveLength(2);
		expect(liveHidden(doc.pages[1]!)).toHaveLength(2);
		expect(plan.strokes).toEqual([]);
	});

	it("undo puts the source back", () => {
		const doc = twoPages();
		const plan = planMoveToPage({ doc, from: 0, to: 1, strokes: [], elements: [doc.pages[0]!.elements![0]!], mode: "move" });
		if ("refused" in plan) throw new Error(plan.refused);
		const history = new History(() => doc);
		history.execute(plan.command);
		history.undo();
		expect(doc.pages[0]!.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
		expect(doc.pages[1]!.strokes).toEqual([]);
	});
});

// --- E3: erasing ---

function zigzag(cx: number, cy: number): Point[] {
	const vertices: Array<[number, number]> = [];
	const legs = 7;
	for (let i = 0; i <= legs; i++) vertices.push([cx + (i % 2 === 0 ? -40 : 40), cy + (i - legs / 2) * 4]);
	const out: Point[] = [];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!, [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
		for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, 0.5]);
	}
	return out;
}

describe("E3: erasers leave a collapsed note's hidden ink alone", () => {
	function withVisibleInk(): NotebookDocument {
		const doc = collapsedDoc();
		// A visible stroke under the same spot, as control: it is erased, the hidden ones are not.
		doc.pages[0]!.strokes.push(stroke("v1", 118, 183));
		return doc;
	}

	it("scribble to erase over the note's empty place deletes the visible ink only", () => {
		const doc = withVisibleInk();
		const scribble = freezeStroke({ ...createStroke("#111111", 2, zigzag(125, 185)), id: "scr" });
		expect(detectScribble(scribble.points, 500)).not.toBeNull();
		// Baseline: without the note's list the scribble does cross the hidden strokes.
		expect(scribbleVictims(detectScribble(scribble.points, 500)!, doc.pages[0]!.strokes, 2).map((s) => s.id)).toEqual(expect.arrayContaining(["s1", "s2", "v1"]));
		const steps = scribbleEraseSteps(doc.pages[0]!, scribble, 500);
		expect(steps).not.toBeNull();
		const history = new History(() => doc);
		history.execute(steps!.keep);
		history.execute(steps!.erase);
		const ids = doc.pages[0]!.strokes.map((s) => s.id);
		expect(ids).toContain("s1");
		expect(ids).toContain("s2");
		expect(ids).not.toContain("v1");
	});

	it("the pen gesture's victim count (what decides a delete gesture) ignores the hidden ink too", () => {
		const doc = collapsedDoc();
		const scribble = detectScribble(zigzag(125, 185), 500)!;
		expect(scribbleVictims(scribble, doc.pages[0]!.strokes, 2)).toHaveLength(2);
		expect(scribbleVictims(scribble, erasableStrokes(doc.pages[0]!), 2)).toHaveLength(0);
	});

	it("the area eraser over the note's empty place cuts nothing of the hidden ink", () => {
		const doc = withVisibleInk();
		const page = doc.pages[0]!;
		const cmd = eraseAreaCommand(page, [[90, 140], [260, 140], [260, 260], [90, 260]], { filter: { kind: "all", color: "" }, includeElements: false });
		expect(cmd).not.toBeNull();
		new History(() => doc).execute(cmd!);
		const ids = page.strokes.map((s) => s.id);
		expect(ids).toContain("s1");
		expect(ids).toContain("s2");
		expect(ids).not.toContain("v1");
	});
});

// --- E7: insert space ---

describe("E7: insert space moves the hidden ink together with its note", () => {
	/** The collapsed icon is at `noteY`; its ink lies at `inkY` (where the open note was). */
	function spaceDoc(noteY: number, inkY: number): NotebookDocument {
		const doc = createDocument(new Date(stamp), { width: 400, height: 600 });
		const page = doc.pages[0]!;
		page.elements = [note("n1", { y: noteY, height: 40, collapsed: true, ink: ["s1", "s2"] })];
		page.strokes.push(stroke("s1", 110, inkY), stroke("s2", 120, inkY + 30));
		return doc;
	}
	const yOf = (page: Page, id: string) => Math.round(page.strokes.find((s) => s.id === id)!.points[0]![1]);

	it("the note is below the line: it and its ink move down by the same distance", () => {
		const doc = spaceDoc(250, 300);
		const plan = planSpaceChange(doc.pages, 0, 200, 60)!;
		new History(() => doc).execute(pageContentCommand(doc, plan, "Insert space"));
		const page = doc.pages[0]!;
		expect(Math.round((page.elements![0] as StickyElement).y)).toBe(310);
		expect(yOf(page, "s1")).toBe(360);
		expect(yOf(page, "s2")).toBe(390);
	});

	it("the note is below the line but its ink lies above it: both move", () => {
		const doc = spaceDoc(400, 100);
		const plan = planSpaceChange(doc.pages, 0, 300, 60)!;
		new History(() => doc).execute(pageContentCommand(doc, plan, "Insert space"));
		const page = doc.pages[0]!;
		expect(Math.round((page.elements![0] as StickyElement).y)).toBe(460);
		expect(yOf(page, "s1")).toBe(160);
	});

	it("the note is above the line but its ink lies below it: both stay (nothing moves)", () => {
		const doc = spaceDoc(100, 300);
		expect(planSpaceChange(doc.pages, 0, 200, 60)).toBeNull();
	});
});

// --- E4: delete across pages ---

describe("E4: deleting a note on any page of a cross-page selection deletes its hidden ink", () => {
	it("the per-page delete (shared by one page and several) removes the note's ink in the same step", () => {
		const doc = twoNotePages();
		const p1 = doc.pages[0]!;
		const p2 = doc.pages[1]!;
		p2.strokes.push(stroke("t2", 300, 300));
		const commands: Command[] = [];
		for (const page of [p1, p2]) commands.push(...deleteSelectionCommands(page, [], page.elements!).commands);
		const history = new History(() => doc);
		history.execute(new Batch("Delete selection", commands));
		expect(p1.strokes.map((s) => s.id)).toEqual(["s3"]);
		expect(p2.strokes.map((s) => s.id)).toEqual(["t2"]);
		history.undo();
		expect(p1.strokes).toHaveLength(3);
		expect(p2.strokes).toHaveLength(2);
	});
});

// --- E5: merge ---

describe("E5: merging a collapsed copy of a note that main has open", () => {
	function docWith(el: StickyElement, strokes: Stroke[]): NotebookDocument {
		const doc = createDocument(new Date(stamp), { width: 400, height: 600 });
		doc.id = "doc";
		doc.pages[0]!.id = "p1";
		doc.pages[0]!.elements = [el];
		doc.pages[0]!.strokes.push(...strokes);
		return doc;
	}

	it("the collapsed copy does not take over the strokes main already shows", () => {
		const main = docWith(note("n1", { text: "hello" }), [stroke("s1", 110, 160), stroke("s2", 120, 200)]);
		const other = docWith(note("n1", { text: "hello", collapsed: true, ink: ["s1", "s2"] }), [stroke("s1", 110, 160), stroke("s2", 120, 200)]);
		const plan = planMerge(main, other);
		if (plan.command) new History(() => main).execute(plan.command);
		// Main's strokes stay shown: no note hides them.
		expect(hiddenStickyInk(main.pages[0]!.elements)).toBeNull();
		expect(serializeChecked(main).ok).toBe(true);
	});

	it("the strokes the merge does add are still hidden by the collapsed copy", () => {
		const main = docWith(note("n1", { text: "hello" }), [stroke("s1", 110, 160)]);
		const other = docWith(note("n1", { text: "hello", collapsed: true, ink: ["s1", "s4"] }), [stroke("s1", 110, 160), stroke("s4", 130, 220)]);
		const plan = planMerge(main, other);
		new History(() => main).execute(plan.command!);
		const page = main.pages[0]!;
		expect([...hiddenStickyInk(page.elements)!]).toEqual(["s4"]);
		expect(pinnedInk(page.strokes, page.elements!).map((s) => s.id)).toEqual(["s4"]);
	});
});

// --- E6: the writer drops ids of strokes that are gone ---

describe("E6: ids of strokes that are gone are not written", () => {
	it("serialize writes only the ink ids that are on the page, and no list when none is", () => {
		const doc = collapsedDoc();
		doc.pages[0]!.elements = [note("n1", { collapsed: true, ink: ["s1", "gone", "s2"] })];
		expect(serialize(doc)).toContain('"collapsed":true,"ink":["s1","s2"]');
		doc.pages[0]!.elements = [note("n1", { collapsed: true, ink: ["gone"] })];
		const text = serialize(doc);
		expect(text).not.toContain('"ink":[');
		expect(text).not.toContain("gone");
		expect(parse(text).ok).toBe(true);
	});
});
