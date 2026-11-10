import { describe, expect, it } from "vitest";
import { createDocument, createPage } from "../src/model/document";
import {
	AddAsset, AddElement, AddPage, AddStroke, Batch, DeletePage, History, MovePage, RemoveElement, ReplaceElement, ReplaceStroke, SetMeta, SetPaper, type Command,
} from "../src/model/history";
import { ReorderPages } from "../src/model/page-ops";
import { SetPageLocked } from "../src/model/page-lock";
import { CLASSIFIED, pageRules, pageScope, sharedElsewhere } from "../src/model/page-undo";
import { checkContent } from "../src/model/serialize";
import type { Asset, NotebookDocument, PageElement, Stroke } from "../src/model/types";
import { line } from "./helpers";

/** Every source file of the plugin as text (the command classes are read from it). */
const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

const text = (id: string, body = "hello"): PageElement => ({ id, type: "text", x: 10, y: 10, width: 100, text: body, fontSize: 14, color: "#000000" });
const image = (id: string, asset: string): PageElement => ({ id, type: "image", asset, x: 0, y: 0, width: 50, height: 50, rotation: 0 });
const asset = (id: string): Asset => ({ id, kind: "image", path: `_assets/${id}.png`, name: `${id}.png`, bytes: 10 });

interface Rig {
	doc: NotebookDocument;
	history: History;
	pages: [string, string, string];
	/** The ink of each page, in order. */
	ids(i: number): string[];
	refused: Array<{ message: string; step?: "undo" | "redo" }>;
	locked: string[][];
	write(i: number, s?: Stroke): Stroke;
}

function rig(options: { guard?: (doc: NotebookDocument) => string | null; pagewise?: boolean } = {}): Rig {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.pages.push(createPage(), createPage());
	const refused: Rig["refused"] = [];
	const locked: string[][] = [];
	const history = new History(() => doc, 500, options.guard ?? null, (message, step) => refused.push({ message, step }), null, (ids) => locked.push([...ids]));
	history.setPageRules(pageRules);
	history.setPagewise(options.pagewise ?? true);
	let n = 0;
	return {
		doc, history, refused, locked,
		pages: [doc.pages[0]!.id, doc.pages[1]!.id, doc.pages[2]!.id],
		ids: (i) => doc.pages[i]!.strokes.map((s) => s.id),
		write(i, s) {
			const stroke = s ?? line(0, 20 * n++, 50, 20 * n);
			expect(history.execute(new AddStroke(doc.pages[i]!.id, stroke, doc.pages[i]!.strokes.length))).toBe(true);
			return stroke;
		},
	};
}

describe("step scopes", () => {
	it("a single page edit is local to its page", () => {
		const r = rig();
		const s = pageScope(new AddStroke(r.pages[0], line(0, 0, 5, 5), 0));
		expect(s.local).toBe(true);
		expect([...s.pages]).toEqual([r.pages[0]]);
	});

	it("a batch or group on one page is local; across pages it is global and names both", () => {
		const r = rig();
		const one = new Batch("Run macro", [new AddStroke(r.pages[0], line(0, 0, 5, 5), 0), new SetPaper(r.pages[0], { kind: "grid", spacing: 20 }, { kind: "ruled", spacing: 30 })]);
		expect(pageScope(one).local).toBe(true);
		const two = new Batch("Run macro", [new AddStroke(r.pages[0], line(0, 0, 5, 5), 0), new AddStroke(r.pages[1], line(0, 0, 5, 5), 0)]);
		const scope = pageScope(two);
		expect(scope.local).toBe(false);
		expect([...scope.pages].sort()).toEqual([r.pages[0], r.pages[1]].sort());
	});

	it("page structure, notebook-wide and unknown commands are global", () => {
		const r = rig();
		const extra = createPage();
		expect(pageScope(new AddPage(extra, 1)).local).toBe(false);
		expect(pageScope(new DeletePage(r.doc.pages[1]!, 1)).local).toBe(false);
		expect(pageScope(new MovePage(r.pages[0], 0, 2)).local).toBe(false);
		expect(pageScope(new SetMeta(r.doc.meta!, r.doc.meta!)).local).toBe(false);
		const reorder = pageScope(new ReorderPages([...r.pages], [r.pages[2], r.pages[1], r.pages[0]]));
		expect(reorder.local).toBe(false);
		expect(reorder.all).toBe(true);
		const strange: Command = { label: "Strange", apply: () => undefined, revert: () => undefined };
		const scope = pageScope(strange);
		expect(scope.local).toBe(false);
		expect(scope.all).toBe(true); // fails closed: blocks every page
	});

	it("every command class of the source is classified (a new one must be decided on purpose)", () => {
		const names = new Set<string>(CLASSIFIED);
		const found: string[] = [];
		for (const source of Object.values(SOURCES)) {
			for (const m of source.matchAll(/class (\w+) implements Command\b/g)) found.push(m[1]!);
		}
		expect(found.length).toBeGreaterThan(25);
		expect(found.filter((n) => !names.has(n))).toEqual([]);
	});
});

describe("Undo / Redo on one page", () => {
	it("undoes the newest step of one page out of three interleaved ones, and leaves the others alone", () => {
		const r = rig();
		const a1 = r.write(0);
		const b1 = r.write(1);
		const c1 = r.write(2);
		const a2 = r.write(0);
		const b2 = r.write(1);
		const c2 = r.write(2);
		// page B twice: B2 then B1 go; the other pages keep every stroke
		expect(r.history.undoOnPage(r.pages[1]).kind).toBe("done");
		expect(r.ids(1)).toEqual([b1.id]);
		expect(r.history.undoOnPage(r.pages[1]).kind).toBe("done");
		expect(r.ids(1)).toEqual([]);
		expect(r.history.undoOnPage(r.pages[1]).kind).toBe("nothing");
		expect(r.ids(0)).toEqual([a1.id, a2.id]);
		expect(r.ids(2)).toEqual([c1.id, c2.id]);
		// the steps that are left are still the ones of A and C, in order, and the plain Undo takes the newest of them
		expect(r.history.depth()).toEqual({ undo: 4, redo: 2 });
		expect(r.history.undo()).not.toBeNull();
		expect(r.ids(2)).toEqual([c1.id]);
		void b2;
	});

	it("redoes on a page the step that page undid last, in the right order", () => {
		const r = rig();
		const a1 = r.write(0);
		const b1 = r.write(1);
		const a2 = r.write(0);
		r.history.undoOnPage(r.pages[0]); // A2
		r.history.undoOnPage(r.pages[0]); // A1 (out of order: B1 sits in between)
		expect(r.ids(0)).toEqual([]);
		expect(r.ids(1)).toEqual([b1.id]);
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([a1.id]);
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([a1.id, a2.id]);
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("nothing");
		expect(r.history.depth()).toEqual({ undo: 3, redo: 0 });
	});

	it("a redone out-of-order step is the newest step of its page again, so Undo on the page takes it back", () => {
		const r = rig();
		const a1 = r.write(0);
		r.write(1);
		r.history.undoOnPage(r.pages[0]);
		r.history.redoOnPage(r.pages[0]);
		expect(r.ids(0)).toEqual([a1.id]);
		r.history.undoOnPage(r.pages[0]);
		expect(r.ids(0)).toEqual([]);
		expect(r.ids(1)).toHaveLength(1);
	});

	it("the plain Redo still brings back a step undone on a page", () => {
		const r = rig();
		const a1 = r.write(0);
		r.write(1);
		r.history.undoOnPage(r.pages[0]);
		expect(r.history.redo()).not.toBeNull();
		expect(r.ids(0)).toEqual([a1.id]);
	});

	it("works on erase, replace, element and layer steps with the commands' own inverses", () => {
		const r = rig();
		const s = r.write(0);
		const keep = r.write(0);
		const el = text("t1");
		r.history.execute(new AddElement(r.pages[0], el, 0));
		const edited = { ...el, text: "changed" } as PageElement;
		r.history.execute(new ReplaceElement(r.pages[0], r.doc.pages[0]!.elements![0]!, edited));
		r.write(1);
		r.history.execute(new ReplaceStroke(r.pages[0], s, [], 0));
		r.write(2);
		// undo the replace-stroke on page 0 although steps of pages 1 and 2 came after it
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([s.id, keep.id]);
		// then the element edit, then the element, then the strokes
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect((r.doc.pages[0]!.elements![0] as { text: string }).text).toBe("hello");
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.doc.pages[0]!.elements ?? []).toHaveLength(0);
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([]);
		expect(r.ids(1)).toHaveLength(1);
		expect(r.ids(2)).toHaveLength(1);
		// and all the way back with the page's redo
		for (let i = 0; i < 5; i++) expect(r.history.redoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([keep.id]);
		expect((r.doc.pages[0]!.elements![0] as { text: string }).text).toBe("changed");
	});
});

describe("what clears the redo list", () => {
	it("a new edit on another page keeps what a page undid; a new edit on the same page drops it", () => {
		const r = rig();
		const a1 = r.write(0);
		r.write(1);
		r.history.undoOnPage(r.pages[0]);
		r.write(1); // another page
		expect(r.history.depth().redo).toBe(1);
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([a1.id]);
		r.history.undoOnPage(r.pages[0]);
		r.write(0); // the same page
		expect(r.history.depth().redo).toBe(0);
	});

	it("with the setting off a new edit clears the redo list as it always did", () => {
		const r = rig({ pagewise: false });
		r.write(0);
		r.write(1);
		r.history.undoOnPage(r.pages[0]);
		r.write(1);
		expect(r.history.depth().redo).toBe(0);
	});

	it("a global new edit (a page added) or a global undone step drops the redo list", () => {
		const r = rig();
		r.write(0);
		r.history.undoOnPage(r.pages[0]);
		r.history.execute(new AddPage(createPage(), 3));
		expect(r.history.depth().redo).toBe(0);
		const s = rig();
		s.write(0);
		s.history.execute(new AddPage(createPage(), 3));
		s.history.undo(); // the page: a global step now waits to be redone
		s.write(1);
		expect(s.history.depth().redo).toBe(0);
	});

	it("a macro group on one page keeps the other pages' undone steps; across pages it clears them", () => {
		const r = rig();
		r.write(0);
		r.history.undoOnPage(r.pages[0]);
		r.history.group("Run macro", () => {
			r.write(1);
			r.write(1);
		});
		expect(r.history.depth()).toEqual({ undo: 1, redo: 1 });
		// a group that reaches the page with an undone step drops that step, like any edit on that page
		r.history.group("Run macro", () => {
			r.write(1);
			r.write(0);
		});
		expect(r.history.depth().redo).toBe(0);
	});
});

describe("dependency refusal and global steps", () => {
	/** Ink written on page 0, then moved to page 1 in one step (it touches both pages). */
	function moved() {
		const r = rig();
		const s = r.write(0);
		const copy = { ...s };
		const move = new Batch("Move selection to page", [new ReplaceStroke(r.pages[0], s, [], 0), new AddStroke(r.pages[1], copy, 0, false)]);
		expect(r.history.execute(move)).toBe(true);
		return { r, s, copy, move };
	}

	it("does not undo a page's newest step when it also touches another page, on either page", () => {
		const { r, move, copy } = moved();
		const a = r.history.undoOnPage(r.pages[0]);
		expect(a.kind).toBe("global");
		expect(a.kind === "global" && a.cmd).toBe(move);
		expect(r.history.undoOnPage(r.pages[1]).kind).toBe("global");
		expect(r.ids(1)).toEqual([copy.id]);
		expect(r.history.depth()).toEqual({ undo: 2, redo: 0 });
	});

	it("does not skip past the global step to an older step of the same page (it would depend on it)", () => {
		const { r } = moved();
		r.write(2);
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("global");
		expect(r.history.peekOnPage(r.pages[0])).toEqual({ undo: "global", redo: "none" });
		// the third page is not touched by it
		expect(r.history.undoOnPage(r.pages[2]).kind).toBe("done");
	});

	it("the plain Undo (and so the history panel) still undoes the global step, in order, and then per-page undo works again", () => {
		const { r, s } = moved();
		expect(r.history.undo()).not.toBeNull();
		expect(r.ids(0)).toEqual([s.id]);
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([]);
	});

	it("adding, deleting and reordering pages are global; reorder blocks every page", () => {
		const r = rig();
		r.write(0);
		r.history.execute(new ReorderPages([...r.pages], [r.pages[2], r.pages[0], r.pages[1]]));
		for (const id of r.pages) expect(r.history.undoOnPage(id).kind).toBe("global");
		const q = rig();
		q.write(0);
		const fresh = createPage();
		q.history.execute(new AddPage(fresh, 3));
		q.history.execute(new AddStroke(fresh.id, line(0, 0, 5, 5), 0));
		expect(q.history.undoOnPage(fresh.id).kind).toBe("done"); // the stroke
		expect(q.history.undoOnPage(fresh.id).kind).toBe("global"); // the page itself
		expect(q.history.undoOnPage(q.pages[0]).kind).toBe("done"); // the other pages are not in its way
		const d = rig();
		d.write(1);
		d.history.execute(new DeletePage(d.doc.pages[2]!, 2));
		expect(d.history.undoOnPage(d.pages[1]).kind).toBe("done"); // the deleted page is not this one
	});

	it("a step that touches the whole notebook does not block a page, and is not undone by a page", () => {
		const r = rig();
		r.write(0);
		r.history.execute(new SetMeta(r.doc.meta!, { ...r.doc.meta!, favorite: true }));
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.history.depth().undo).toBe(1);
	});

	it("nothing to undo on a page that was never edited", () => {
		const r = rig();
		r.write(0);
		expect(r.history.undoOnPage(r.pages[2]).kind).toBe("nothing");
		expect(r.history.peekOnPage(r.pages[2])).toEqual({ undo: "none", redo: "none" });
	});

	it("without page rules the page methods find nothing", () => {
		const doc = createDocument();
		const history = new History(() => doc);
		history.execute(new AddStroke(doc.pages[0]!.id, line(0, 0, 5, 5), 0));
		expect(history.undoOnPage(doc.pages[0]!.id).kind).toBe("nothing");
		expect(history.isPagewise).toBe(false);
	});
});

describe("groups", () => {
	it("a macro run on one page is one page step; one that wrote on two pages is a global step", () => {
		const r = rig();
		r.history.group("Run macro", () => {
			r.write(0);
			r.write(0);
			r.write(0);
		});
		r.write(1);
		expect(r.history.depth().undo).toBe(2);
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([]); // the three strokes went together
		r.history.group("Run macro", () => {
			r.write(0);
			r.write(1);
		});
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("global");
		expect(r.history.undoOnPage(r.pages[1]).kind).toBe("global");
	});

	it("a macro run that was grouped is redone as a whole on its page", () => {
		const r = rig();
		r.history.group("Run macro", () => {
			r.write(0);
			r.write(0);
		});
		r.write(1);
		r.history.undoOnPage(r.pages[0]);
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toHaveLength(2);
	});
});

describe("locked pages", () => {
	it("a page locked since is not undone (the step stays where it was), the other pages still are", () => {
		const r = rig();
		const a = r.write(0);
		r.write(1);
		r.doc.pages[0]!.locked = true; // locked since (a synced change, a lock left on)
		const res = r.history.undoOnPage(r.pages[0]);
		expect(res.kind).toBe("refused");
		expect(r.locked).toEqual([[r.pages[0]]]);
		expect(r.ids(0)).toEqual([a.id]);
		expect(r.history.depth()).toEqual({ undo: 2, redo: 0 });
		expect(r.history.undoOnPage(r.pages[1]).kind).toBe("done");
		// unlocked: the step is still there, in its place
		delete r.doc.pages[0]!.locked;
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([]);
	});

	it("a redo on a page that was locked meanwhile is refused and kept", () => {
		const r = rig();
		const a = r.write(0);
		r.write(1);
		r.history.undoOnPage(r.pages[0]);
		r.doc.pages[0]!.locked = true;
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("refused");
		expect(r.ids(0)).toEqual([]);
		expect(r.history.depth().redo).toBe(1);
		delete r.doc.pages[0]!.locked;
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.ids(0)).toEqual([a.id]);
	});

	it("locking and unlocking a page are steps of that page", () => {
		const r = rig();
		r.write(0);
		r.history.execute(new SetPageLocked(r.pages[0], true));
		r.write(1);
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done"); // the lock comes off first, as the lock is the page's newest step
		expect(r.doc.pages[0]!.locked).toBeUndefined();
		expect(r.ids(0)).toHaveLength(1);
	});
});

describe("remap after an upkeep change swapped element objects", () => {
	it("an out-of-order undo still finds the element an upkeep change replaced", () => {
		const r = rig();
		const el = text("t1", "note");
		r.history.execute(new AddElement(r.pages[0], el, 0));
		r.write(1);
		r.write(2);
		const current = r.doc.pages[0]!.elements![0]!;
		const swapped = { ...current, text: "followed" } as PageElement;
		expect(r.history.applyQuietly(new ReplaceElement(r.pages[0], current, swapped))).toBe(true);
		expect(r.doc.pages[0]!.elements![0]!).not.toBe(current);
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.doc.pages[0]!.elements ?? []).toHaveLength(0);
		// the redo puts back the element as it is now, once
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
		expect((r.doc.pages[0]!.elements![0] as { text: string }).text).toBe("followed");
	});

	it("a replace step undone out of order keeps the swapped fields", () => {
		const r = rig();
		const el = text("t1", "note");
		r.history.execute(new AddElement(r.pages[0], el, 0));
		const first = r.doc.pages[0]!.elements![0]!;
		r.history.execute(new ReplaceElement(r.pages[0], first, { ...first, x: 99 }));
		r.write(1);
		const now = r.doc.pages[0]!.elements![0]!;
		expect(r.history.applyQuietly(new ReplaceElement(r.pages[0], now, { ...now, text: "renamed" } as PageElement))).toBe(true);
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done"); // the move is taken back, the rename (upkeep) stays
		const back = r.doc.pages[0]!.elements![0] as unknown as { x: number; text: string };
		expect(back.x).toBe(10);
		expect(back.text).toBe("renamed");
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
	});
});

describe("the document guard and the unsavable step", () => {
	it("an out-of-order undo the guard refuses leaves the document as it was, drops the step and says so; other pages keep working", () => {
		let armed = false;
		const r = rig({ guard: (doc) => (armed && doc.pages[0]!.strokes.length === 0 ? "page 1 must not be empty" : null) });
		const a = r.write(0);
		r.write(1);
		const b = r.write(2);
		armed = true;
		const res = r.history.undoOnPage(r.pages[0]);
		expect(res.kind).toBe("refused");
		expect(r.ids(0)).toEqual([a.id]);
		expect(r.refused).toEqual([{ message: "page 1 must not be empty", step: "undo" }]);
		expect(r.history.depth()).toEqual({ undo: 2, redo: 0 }); // the refused step left the history
		expect(r.history.undoOnPage(r.pages[2]).kind).toBe("done");
		expect(r.ids(2)).toEqual([]);
		void b;
	});

	it("an out-of-order redo the guard refuses is undone and dropped", () => {
		let armed = false;
		const r = rig({ guard: (doc) => (armed && doc.pages[0]!.strokes.length > 0 ? "no ink on page 1" : null) });
		r.write(0);
		r.write(1);
		r.history.undoOnPage(r.pages[0]);
		armed = true;
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("refused");
		expect(r.ids(0)).toEqual([]);
		expect(r.refused[r.refused.length - 1]?.step).toBe("redo");
		expect(r.history.depth().redo).toBe(0);
		expect(r.history.undoOnPage(r.pages[1]).kind).toBe("done");
	});

	it("a duplicate id (what the writer refuses) cannot be brought back by a redo on a page", () => {
		const r = rig({ guard: checkContent });
		const a = r.write(0);
		r.write(1);
		r.history.undoOnPage(r.pages[0]);
		// the same stroke id appears on another page meanwhile (a synced change outside the history)
		r.doc.pages[2]!.strokes.push(a);
		expect(r.history.redoOnPage(r.pages[0]).kind).toBe("refused");
		expect(r.ids(0)).toEqual([]);
		expect(r.refused[r.refused.length - 1]?.step).toBe("redo");
	});

	it("read-only mode refuses everything", () => {
		const doc = createDocument();
		let readOnly = false;
		const history = new History(() => doc, 500, null, null, () => readOnly);
		history.setPageRules(pageRules);
		history.execute(new AddStroke(doc.pages[0]!.id, line(0, 0, 5, 5), 0));
		readOnly = true;
		expect(history.undoOnPage(doc.pages[0]!.id).kind).toBe("refused");
		expect(doc.pages[0]!.strokes).toHaveLength(1);
	});
});

describe("files shared with another page", () => {
	it("does not undo a picture whose file another page still uses, and does when it is the only user", () => {
		const r = rig({ guard: checkContent });
		const a = asset("a".repeat(8));
		r.history.execute(new Batch("Insert image", [new AddAsset(a), new AddElement(r.pages[0], image("i1", a.id), 0)]));
		r.history.execute(new Batch("Insert image", [new AddAsset(a), new AddElement(r.pages[1], image("i2", a.id), 0)]));
		// page 0 added the file, page 1 uses it too: taking page 0's step back out of order would drop the file page 1 needs
		const res = r.history.undoOnPage(r.pages[0]);
		expect(res.kind).toBe("global");
		expect(res.kind === "global" && res.why).toBe("shared");
		expect(r.doc.assets?.[a.id]).toBeDefined();
		// page 1's step added nothing (the file was there): it goes
		expect(r.history.undoOnPage(r.pages[1]).kind).toBe("done");
		expect(r.doc.assets?.[a.id]).toBeDefined();
		// now page 0 is the only user
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.doc.assets?.[a.id]).toBeUndefined();
	});

	it("sharedElsewhere names a cover that uses the file", () => {
		const r = rig();
		const a = asset("c".repeat(8));
		const step = new Batch("Insert image", [new AddAsset(a), new AddElement(r.pages[0], image("i1", a.id), 0)]);
		r.history.execute(step);
		expect(sharedElsewhere(r.doc, pageScope(step), r.pages[0])).toBe(false);
		r.doc.meta = { ...r.doc.meta!, coverArt: { kind: "image", asset: a.id } };
		expect(sharedElsewhere(r.doc, pageScope(step), r.pages[0])).toBe(true);
	});
});

describe("ordinary Undo and Redo are unchanged", () => {
	it("a plain history behaves as before: one stack, a new edit clears the redo list", () => {
		const doc = createDocument();
		const history = new History(() => doc);
		const id = doc.pages[0]!.id;
		const a = line(0, 0, 5, 5);
		history.execute(new AddStroke(id, a, 0));
		history.execute(new AddStroke(id, line(0, 10, 5, 15), 1));
		history.undo();
		history.execute(new AddStroke(id, line(0, 20, 5, 25), 1));
		expect(history.depth()).toEqual({ undo: 2, redo: 0 });
		history.undo();
		history.undo();
		expect(doc.pages[0]!.strokes).toHaveLength(0);
		expect(history.redo()).not.toBeNull();
		expect(doc.pages[0]!.strokes.map((s) => s.id)).toEqual([a.id]);
	});

	it("a stale remove / replace of an element is a no-op, as before", () => {
		const r = rig();
		const el = text("t9");
		r.history.execute(new AddElement(r.pages[0], el, 0));
		r.history.execute(new RemoveElement(r.pages[0], r.doc.pages[0]!.elements![0]!));
		expect(r.history.undoOnPage(r.pages[0]).kind).toBe("done");
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
	});
});
