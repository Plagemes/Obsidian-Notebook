/**
 * 0.28 review fixes for per-page undo (#98): the shared tables of the notebook (the file table, the cover, the slide table) must never end
 * up pointing at something an out-of-order undo or redo removed. Every scenario runs the real History with the real content check and the
 * real writer and ends by asking that the notebook can still be saved.
 */
import { describe, expect, it } from "vitest";
import { planAssetRepoint } from "../src/model/asset-ops";
import { createDocument, createPage } from "../src/model/document";
import { AddAsset, AddElement, AddStroke, Batch, History, RemoveElement, ReplaceStroke, SetMeta, type Command } from "../src/model/history";
import { computeScope, pageRules } from "../src/model/page-undo";
import { checkContent, serializeChecked } from "../src/model/serialize";
import { AddSlideRef } from "../src/model/slide-links";
import type { Asset, NotebookDocument, PageElement, SlideRef, Stroke } from "../src/model/types";
import { line } from "./helpers";

const image = (id: string, asset: string): PageElement => ({ id, type: "image", asset, x: 0, y: 0, width: 50, height: 50, rotation: 0 });
const asset = (id: string): Asset => ({ id, kind: "image", path: `_assets/${id}.png`, name: `${id}.png`, bytes: 10 });
const X = asset("a1b2c3d4e5f60718");
const Y = asset("0f1e2d3c4b5a6978");
const Z = asset("1122334455667788");

function rig(options: { limit?: number; guard?: (doc: NotebookDocument) => string | null } = {}) {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.pages.push(createPage(), createPage());
	const refused: Array<{ message: string; step?: "undo" | "redo"; kept?: boolean }> = [];
	const history = new History(() => doc, options.limit ?? 500, options.guard ?? checkContent, (message, step, kept) => refused.push({ message, step, kept }));
	history.setPageRules(pageRules);
	history.setPagewise(true);
	const ids = doc.pages.map((p) => p.id) as [string, string, string];
	const write = (i: number, s: Stroke = line(0, 0, 50, 5)): Stroke => {
		expect(history.execute(new AddStroke(ids[i]!, s, doc.pages[i]!.strokes.length))).toBe(true);
		return s;
	};
	return { doc, history, refused, ids, write };
}

const savable = (doc: NotebookDocument): string => {
	const r = serializeChecked(doc, true);
	return r.ok ? "ok" : r.message;
};

describe("P1: the file table and the cover are never left behind by an out-of-order step", () => {
	it("1. a copy pasted on another page and deleted again keeps the picture's file", () => {
		const r = rig();
		r.history.execute(new Batch("Insert image", [new AddAsset(X), new AddElement(r.ids[0], image("iA", X.id), 0)]));
		r.history.execute(new AddElement(r.ids[1], image("iB", X.id), 0)); // a paste of a known file adds no record
		r.history.execute(new RemoveElement(r.ids[1], r.doc.pages[1]!.elements![0]!));
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("global");
		expect(r.history.undoOnPage(r.ids[1]).kind).toBe("done");
		expect(savable(r.doc)).toBe("ok");
		expect(r.doc.assets?.[X.id]).toBeDefined();
	});

	it("2. a picture deleted on a page and its file repointed by the storage manager", () => {
		const r = rig();
		r.history.execute(new Batch("Insert image", [new AddAsset(X), new AddElement(r.ids[0], image("iA", X.id), 0)]));
		r.history.execute(new AddElement(r.ids[1], image("iB", X.id), 0));
		r.history.execute(new RemoveElement(r.ids[0], r.doc.pages[0]!.elements![0]!));
		const repoint = planAssetRepoint(r.doc, X.id, Y);
		expect(repoint).not.toBeNull();
		expect(r.history.execute(repoint!)).toBe(true);
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("global");
		expect(savable(r.doc)).toBe("ok");
	});

	it("3. a redo on a page cannot jump over an undone step that registered its file", () => {
		const r = rig();
		r.history.execute(new Batch("Insert image", [new AddAsset(X), new AddElement(r.ids[1], image("iB", X.id), 0)]));
		r.history.execute(new AddElement(r.ids[0], image("iA", X.id), 0)); // a paste on page 1
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("done");
		expect(r.history.undo()).not.toBeNull(); // the picture of page 2, and its file
		expect(r.doc.assets?.[X.id]).toBeUndefined();
		const res = r.history.redoOnPage(r.ids[0]);
		expect(res.kind).toBe("global");
		expect(savable(r.doc)).toBe("ok");
		// in order it works: the file first, then the paste
		expect(r.history.redo()).not.toBeNull();
		expect(r.history.redo()).not.toBeNull();
		expect(savable(r.doc)).toBe("ok");
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
	});

	it("4. a cover that points at the file again after a global undo", () => {
		const r = rig();
		const meta = r.doc.meta!;
		r.history.execute(new Batch("Insert image", [new AddAsset(X), new AddElement(r.ids[0], image("iA", X.id), 0)]));
		r.history.execute(new SetMeta(meta, { ...meta, coverArt: { kind: "image", asset: X.id } }));
		r.history.execute(new Batch("Change cover", [new AddAsset(Z), new SetMeta({ ...meta, coverArt: { kind: "image", asset: X.id } }, { ...meta, coverArt: { kind: "image", asset: Z.id } })]));
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("global");
		r.history.undo(); // the panel: one step at a time, in order
		expect(savable(r.doc)).toBe("ok");
	});

	it("a step that did not add the file is still undone out of order", () => {
		const r = rig();
		r.history.execute(new Batch("Insert image", [new AddAsset(X), new AddElement(r.ids[0], image("iA", X.id), 0)]));
		r.history.execute(new AddElement(r.ids[1], image("iB", X.id), 0));
		r.write(2);
		expect(r.history.undoOnPage(r.ids[1]).kind).toBe("done");
		expect(savable(r.doc)).toBe("ok");
	});

	it("the step that added the file is undone when it is the newest of the whole history", () => {
		const r = rig();
		r.write(1);
		r.history.execute(new Batch("Insert image", [new AddAsset(X), new AddElement(r.ids[0], image("iA", X.id), 0)]));
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("done");
		expect(r.doc.assets?.[X.id]).toBeUndefined();
		expect(savable(r.doc)).toBe("ok");
	});

	it("removing a file blocks every page", () => {
		const scope = computeScope(planAssetRepoint(
			(() => {
				const d = createDocument();
				d.assets = { [X.id]: X };
				d.pages[0]!.elements = [image("i", X.id)];
				return d;
			})(),
			X.id,
			Y,
		)!);
		expect(scope.all).toBe(true);
		expect(scope.local).toBe(false);
	});

	it("an unclassified command blocks every page, whatever it names", () => {
		const strange = { label: "Strange", pageId: "p9", apply: () => undefined, revert: () => undefined } as Command & { pageId: string };
		const scope = computeScope(strange);
		expect(scope.all).toBe(true);
		expect(scope.local).toBe(false);
	});
});

describe("the content check no longer trusts the element cache for shared tables", () => {
	it("refuses a picture, a background or a cover whose file record is gone, and ink linked to a missing slide", () => {
		const doc = createDocument();
		const el = Object.freeze(image("i1", X.id));
		doc.assets = { [X.id]: X };
		doc.pages[0]!.elements = [el];
		expect(checkContent(doc)).toBeNull(); // the element is now cached as valid
		delete doc.assets[X.id];
		expect(checkContent(doc)).toMatch(/asset/);
		doc.assets[X.id] = X;
		doc.meta = { ...doc.meta!, coverArt: { kind: "image", asset: Y.id } };
		expect(checkContent(doc)).toMatch(/coverArt/);
		doc.meta = { ...doc.meta, coverArt: { kind: "image", asset: X.id } };
		expect(checkContent(doc)).toBeNull();
		doc.pages[0]!.background = { kind: "image", asset: Y.id };
		expect(checkContent(doc)).toMatch(/background/);
		delete doc.pages[0]!.background;
		doc.pages[0]!.strokes.push({ ...line(0, 0, 5, 5), slide: "gone" });
		expect(checkContent(doc)).toMatch(/slide/);
		doc.slides = [{ id: "gone", source: "s", page: 1 }];
		expect(checkContent(doc)).toBeNull();
	});
});

describe("P2: ink never comes back pointing at a removed slide entry", () => {
	it("an out-of-order undo of the step that added the slide entry is refused", () => {
		const r = rig();
		const ref: SlideRef = { id: "slide001", source: "deck", page: 1 };
		const onSlide = (): Stroke => ({ ...line(0, 0, 50, 5), slide: ref.id });
		r.history.execute(new Batch("Draw", [new AddSlideRef(ref), new AddStroke(r.ids[0], onSlide(), 0)]));
		const b = onSlide();
		r.history.execute(new AddStroke(r.ids[1], b, 0));
		r.history.execute(new ReplaceStroke(r.ids[1], b, [], 0));
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("global");
		expect(r.history.undoOnPage(r.ids[1]).kind).toBe("done");
		expect(r.doc.pages[1]!.strokes.every((s) => s.slide === undefined || (r.doc.slides ?? []).some((e) => e.id === s.slide))).toBe(true);
		expect(r.doc.slides).toHaveLength(1);
		expect(savable(r.doc)).toBe("ok");
	});
});

describe("P3: a step the guard refuses out of order stays in the history, where it was", () => {
	it("an undo refused by the guard puts the step back at its place and says it is kept", () => {
		let armed = false;
		const r = rig({ guard: (doc) => (armed && doc.pages[0]!.strokes.length === 0 ? "page 1 must not be empty" : null) });
		const a = r.write(0);
		r.write(1);
		r.write(2);
		const before = r.history.entries().undo.map((e) => e.cmd);
		armed = true;
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("refused");
		expect(r.doc.pages[0]!.strokes).toEqual([a]);
		expect(r.history.entries().undo.map((e) => e.cmd)).toEqual(before);
		expect(r.history.depth().redo).toBe(0);
		expect(r.refused).toEqual([{ message: "page 1 must not be empty", step: "undo", kept: true }]);
		armed = false;
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("done"); // it can still be taken back once the guard allows it
		expect(r.doc.pages[0]!.strokes).toHaveLength(0);
	});

	it("an ordinary (in order) refused undo is still dropped, as before", () => {
		let armed = false;
		const r = rig({ guard: (doc) => (armed && doc.pages[0]!.strokes.length === 0 ? "no" : null) });
		r.write(0);
		armed = true;
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("refused");
		expect(r.history.depth()).toEqual({ undo: 0, redo: 0 });
		expect(r.refused[0]).toEqual({ message: "no", step: "undo", kept: false });
	});

	it("a redo refused out of order stays in the redo list", () => {
		let armed = false;
		const r = rig({ guard: (doc) => (armed && doc.pages[0]!.strokes.length > 0 ? "no ink on page 1" : null) });
		r.write(0);
		r.write(1);
		r.history.undoOnPage(r.ids[0]);
		r.history.undoOnPage(r.ids[1]);
		armed = true;
		expect(r.history.redoOnPage(r.ids[0]).kind).toBe("refused");
		expect(r.history.depth().redo).toBe(2);
		armed = false;
		expect(r.history.redoOnPage(r.ids[0]).kind).toBe("done");
	});
});

describe("P4: a refused redo does not clear the redo steps of other pages", () => {
	it("only the refused step goes, in order or not", () => {
		let armed = false;
		const r = rig({ guard: (doc) => (armed && doc.pages[1]!.strokes.length > 0 ? "no ink on page 2" : null) });
		r.write(0);
		r.write(1);
		r.write(2);
		r.history.undoOnPage(r.ids[0]);
		r.history.undoOnPage(r.ids[2]);
		r.history.undoOnPage(r.ids[1]); // the top of the redo list
		armed = true;
		expect(r.history.redoOnPage(r.ids[1]).kind).toBe("refused");
		expect(r.history.depth().redo).toBe(2);
		expect(r.history.redoOnPage(r.ids[0]).kind).toBe("done");
		expect(r.history.redoOnPage(r.ids[2]).kind).toBe("done");
	});
});

describe("P5: a macro group is filtered as one merged step", () => {
	it("a group that wrote on two pages is one global step and drops every undone step", () => {
		const r = rig();
		r.write(2);
		r.history.undoOnPage(r.ids[2]);
		r.history.group("Run macro", () => {
			r.write(0);
			r.write(1);
		});
		expect(r.history.depth()).toEqual({ undo: 1, redo: 0 });
	});

	it("a group on one page keeps the undone steps of the other pages", () => {
		const r = rig();
		r.write(2);
		r.history.undoOnPage(r.ids[2]);
		r.history.group("Run macro", () => {
			r.write(0);
			r.write(0);
		});
		expect(r.history.depth()).toEqual({ undo: 1, redo: 1 });
	});

	it("a group of one step, or a group that is not merged, is filtered step by step", () => {
		const r = rig();
		r.write(2);
		r.history.undoOnPage(r.ids[2]);
		r.history.group("Run macro", () => r.write(0));
		expect(r.history.depth()).toEqual({ undo: 1, redo: 1 });
	});
});

describe("P6: the redo list has the same depth limit as the undo list", () => {
	it("keeps at most `limit` undone steps, dropping the ones farthest from the top", () => {
		const r = rig({ limit: 3 });
		for (let i = 0; i < 3; i++) r.write(0);
		for (let i = 0; i < 3; i++) r.history.undoOnPage(r.ids[0]);
		expect(r.history.depth().redo).toBe(3);
		for (let i = 0; i < 3; i++) r.write(1);
		for (let i = 0; i < 3; i++) r.history.undoOnPage(r.ids[1]);
		expect(r.history.depth().redo).toBe(3);
		expect(r.history.depth().undo).toBe(0);
	});
});
