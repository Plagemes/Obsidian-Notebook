/**
 * 0.28 review round 2 (R2-1) for per-page undo (#98): a new edit that drops an undone step which registered a shared entry (a slide entry,
 * a picture file) or was global also drops every undone step below it, on every page, so no redo left can bring back ink or a picture that
 * points at an entry nothing would put back. Ordinary per-page redo survival is unchanged.
 */
import { describe, expect, it } from "vitest";
import { createDocument, createPage } from "../src/model/document";
import { AddAsset, AddElement, AddStroke, Batch, History } from "../src/model/history";
import { pageRules } from "../src/model/page-undo";
import { checkContent, serializeChecked } from "../src/model/serialize";
import { AddSlideRef } from "../src/model/slide-links";
import type { Asset, NotebookDocument, PageElement, SlideRef, Stroke } from "../src/model/types";
import { line } from "./helpers";

const image = (id: string, asset: string): PageElement => ({ id, type: "image", asset, x: 0, y: 0, width: 50, height: 50, rotation: 0 });
const X: Asset = { id: "a1b2c3d4e5f60718", kind: "image", path: "_assets/a1b2c3d4e5f60718.png", name: "x.png", bytes: 10 };
const ref: SlideRef = { id: "slide001", source: "deck", page: 1 };
const onSlide = (): Stroke => ({ ...line(0, 0, 50, 5), slide: ref.id });

function rig(guard: (doc: NotebookDocument) => string | null = checkContent) {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.pages.push(createPage(), createPage());
	const refused: string[] = [];
	const history = new History(() => doc, 500, guard, (message) => refused.push(message));
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

/** Every stroke that names a slide names one in the slide table (the writer would silently drop the link otherwise). */
const slideLinksIntact = (doc: NotebookDocument): boolean =>
	doc.pages.every((p) => p.strokes.every((s) => s.slide === undefined || (doc.slides ?? []).some((e) => e.id === s.slide)));

describe("R2-1: a dropped step that registered a shared entry takes the undone steps below it along", () => {
	it("slide: undo on B, undo on A, write on A, redo on B never brings back ink with a missing slide entry", () => {
		const r = rig();
		r.history.execute(new Batch("Draw", [new AddSlideRef(ref), new AddStroke(r.ids[0], onSlide(), 0)]));
		r.history.execute(new AddStroke(r.ids[1], onSlide(), 0)); // the entry exists: no AddSlideRef
		expect(r.history.undoOnPage(r.ids[1]).kind).toBe("done");
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("done"); // the newest step of all: in order
		expect(r.doc.slides ?? []).toHaveLength(0);
		r.write(0);
		const res = r.history.redoOnPage(r.ids[1]);
		if (res.kind === "done") expect((r.doc.slides ?? []).some((e) => e.id === ref.id)).toBe(true);
		else expect(res.kind).toBe("nothing");
		expect(r.history.redo()).toBeNull();
		expect(slideLinksIntact(r.doc)).toBe(true);
		expect(r.refused).toEqual([]);
		expect(savable(r.doc)).toBe("ok");
	});

	it("image: undo on B, undo on A, write on A, redo on B is cleanly gone, with no error notice", () => {
		const r = rig();
		r.history.execute(new Batch("Insert image", [new AddAsset(X), new AddElement(r.ids[0], image("iA", X.id), 0)]));
		r.history.execute(new AddElement(r.ids[1], image("iB", X.id), 0)); // a paste of a known file adds no record
		expect(r.history.undoOnPage(r.ids[1]).kind).toBe("done");
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("done");
		expect(r.doc.assets?.[X.id]).toBeUndefined();
		r.write(0);
		const res = r.history.redoOnPage(r.ids[1]);
		if (res.kind === "done") expect(r.doc.assets?.[X.id]).toBeDefined();
		else expect(res.kind).toBe("nothing");
		expect(r.history.peekOnPage(r.ids[1]).redo).toBe("none");
		expect(r.refused).toEqual([]);
		expect(savable(r.doc)).toBe("ok");
	});

	it("the undone steps ABOVE the dropped one (redone before it) stay", () => {
		const r = rig();
		r.write(1);
		r.history.execute(new Batch("Draw", [new AddSlideRef(ref), new AddStroke(r.ids[0], onSlide(), 0)]));
		expect(r.history.undoOnPage(r.ids[0]).kind).toBe("done");
		expect(r.history.undoOnPage(r.ids[1]).kind).toBe("done");
		r.write(0); // drops the slide step, which is below page 2's
		expect(r.history.depth().redo).toBe(1);
		expect(r.history.redoOnPage(r.ids[1]).kind).toBe("done");
		expect(r.doc.pages[1]!.strokes).toHaveLength(1);
		expect(savable(r.doc)).toBe("ok");
	});

	it("a redo refused by the check that registered an entry drops the undone steps below it", () => {
		let armed = false;
		const r = rig((doc) => (armed && (doc.slides?.length ?? 0) > 0 ? "no slides now" : checkContent(doc)));
		r.history.execute(new Batch("Draw", [new AddSlideRef(ref), new AddStroke(r.ids[0], onSlide(), 0)]));
		r.history.execute(new AddStroke(r.ids[1], onSlide(), 0));
		r.history.undoOnPage(r.ids[1]);
		r.history.undoOnPage(r.ids[0]);
		armed = true;
		expect(r.history.redoOnPage(r.ids[0]).kind).toBe("refused");
		armed = false;
		expect(r.history.depth().redo).toBe(0);
		expect(r.history.redoOnPage(r.ids[1]).kind).toBe("nothing");
		expect(slideLinksIntact(r.doc)).toBe(true);
		expect(savable(r.doc)).toBe("ok");
	});
});

describe("R2-1: ordinary per-page redo survival is unchanged", () => {
	it("a step undone on another page stays redoable while you write elsewhere", () => {
		const r = rig();
		r.write(0);
		const b = r.write(1);
		r.write(2);
		expect(r.history.undoOnPage(r.ids[1]).kind).toBe("done");
		expect(r.history.undoOnPage(r.ids[2]).kind).toBe("done");
		r.write(0);
		r.write(2); // drops page 3's undone step, which shares nothing
		expect(r.history.depth().redo).toBe(1);
		expect(r.history.redoOnPage(r.ids[1]).kind).toBe("done");
		expect(r.doc.pages[1]!.strokes).toEqual([b]);
	});

	it("an undone step that registered an entry on another page survives, with the steps below it", () => {
		const r = rig();
		r.write(1);
		r.history.execute(new Batch("Draw", [new AddSlideRef(ref), new AddStroke(r.ids[2], onSlide(), 0)]));
		expect(r.history.undoOnPage(r.ids[2]).kind).toBe("done");
		expect(r.history.undoOnPage(r.ids[1]).kind).toBe("done");
		r.write(0); // touches neither page
		expect(r.history.depth().redo).toBe(2);
		expect(r.history.redoOnPage(r.ids[1]).kind).toBe("done");
		expect(r.history.redoOnPage(r.ids[2]).kind).toBe("done");
		expect(slideLinksIntact(r.doc)).toBe(true);
		expect(savable(r.doc)).toBe("ok");
	});
});
