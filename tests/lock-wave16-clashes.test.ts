/**
 * Page lock (#124, format v14) against the other 0.16 features that edit pages: moving a selection to another page (#78),
 * adding a shared file to a notebook (#177), the bulk import (#80, makes new notebooks only) and the new notebook made from
 * a shared image. The guard is one place (model/history.ts + model/page-lock.ts): these tests pin that each flow goes
 * through it and is refused, unrecorded, on a locked page, and allowed where the page is only read.
 */
import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { Batch, History } from "../src/model/history";
import { planMoveToPage } from "../src/model/selection-move";
import { SetPageLocked } from "../src/model/page-lock";
import { serialize, parse } from "../src/model/serialize";
import { planClosedEdit } from "../src/integration/api-plan";
import { buildImagesDocument } from "../src/library/bulk-import-run";
import { buildImageDocument, prepareAppendImagePage, prepareAppendPdf, prepareImageElement } from "../src/library/shared-inbox-plan";
import { scannedPage } from "../src/scan/pages";
import { PAGE_SIZES } from "../src/model/types";
import type { Asset, NotebookDocument } from "../src/model/types";
import { sampleDocument } from "./helpers";

function twoPages(): NotebookDocument {
	const doc = sampleDocument(3);
	doc.pages.push(createPage());
	return doc;
}

function guarded(doc: NotebookDocument): { history: History; refused: string[][] } {
	const refused: string[][] = [];
	return { history: new History(() => doc, 500, null, null, null, (ids) => refused.push([...ids])), refused };
}

function move(doc: NotebookDocument, from: number, to: number, mode: "move" | "copy") {
	const plan = planMoveToPage({ doc, from, to, strokes: doc.pages[from]!.strokes.slice(0, 2), elements: [], mode });
	if ("refused" in plan) throw new Error("planned as refused");
	return plan.command;
}

describe("moving a selection to another page and the page lock", () => {
	it("refuses moving ink out of a locked page, leaves both pages as they were and reports the page", () => {
		const doc = twoPages();
		const { history, refused } = guarded(doc);
		history.execute(new SetPageLocked(doc.pages[0]!.id, true));
		const before = JSON.stringify(doc);
		expect(history.execute(move(doc, 0, 1, "move"))).toBe(false);
		expect(JSON.stringify(doc)).toBe(before);
		expect(refused).toEqual([[doc.pages[0]!.id]]);
		expect(history.canUndo()).toBe(true);
		history.undo(); // the lock is the only step: the refused move left nothing behind
		expect(doc.pages[0]!.locked).toBeUndefined();
	});

	it("refuses moving or copying ink onto a locked page", () => {
		for (const mode of ["move", "copy"] as const) {
			const doc = twoPages();
			const { history, refused } = guarded(doc);
			history.execute(new SetPageLocked(doc.pages[1]!.id, true));
			const before = JSON.stringify(doc);
			expect(history.execute(move(doc, 0, 1, mode))).toBe(false);
			expect(JSON.stringify(doc)).toBe(before);
			expect(refused).toEqual([[doc.pages[1]!.id]]);
		}
	});

	it("copying FROM a locked page to an unlocked one is allowed: a locked page can be read", () => {
		const doc = twoPages();
		const { history, refused } = guarded(doc);
		history.execute(new SetPageLocked(doc.pages[0]!.id, true));
		const count = doc.pages[0]!.strokes.length;
		expect(history.execute(move(doc, 0, 1, "copy"))).toBe(true);
		expect(doc.pages[0]!.strokes).toHaveLength(count);
		expect(doc.pages[1]!.strokes).toHaveLength(2);
		expect(refused).toEqual([]);
	});
});

describe("shared files added to a notebook and the page lock", () => {
	const img: Asset = { id: "d".repeat(24), kind: "image", path: "Notebooks/_assets/d.png", name: "shared.png", bytes: 10 };
	const pdf: Asset = { id: "e".repeat(24), kind: "pdf", path: "Notebooks/_assets/e.pdf", name: "slides.pdf", bytes: 10 };

	function locked(): { doc: NotebookDocument; text: string } {
		const doc = twoPages();
		doc.pages[1]!.locked = true;
		return { doc, text: serialize(doc) };
	}

	it("an image placed ON a locked page is refused in a closed notebook, nothing is written", () => {
		const { text } = locked();
		const plan = planClosedEdit(text, prepareImageElement(img, { width: 100, height: 100 }, 1), new Date(1));
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.error.code).toBe("page-locked");
	});

	it("an image placed on an unlocked page of a notebook that has a locked page works", () => {
		const { text } = locked();
		const plan = planClosedEdit(text, prepareImageElement(img, { width: 100, height: 100 }, 0), new Date(1));
		expect(plan.ok).toBe(true);
	});

	it("new pages are added after a locked last page (inserting pages is not an edit of the locked page)", () => {
		const { text } = locked();
		const page = planClosedEdit(text, prepareAppendImagePage(img, { width: 100, height: 100 }), new Date(1));
		const pages = planClosedEdit(text, prepareAppendPdf(pdf, [{ width: 595, height: 842 }, { width: 595, height: 842 }]), new Date(1));
		expect(page.ok).toBe(true);
		expect(pages.ok).toBe(true);
		if (page.ok) {
			const back = parse(page.text);
			expect(back.ok && back.doc.pages.length).toBe(3);
			expect(back.ok && back.doc.pages[1]!.locked).toBe(true);
		}
	});

	it("in an open notebook the history refuses the same edit and says which page", () => {
		const { doc } = locked();
		const { history, refused } = guarded(doc);
		const plan = prepareImageElement(img, { width: 100, height: 100 }, 1)(doc);
		expect(history.execute(new Batch("Insert image", plan.commands))).toBe(false);
		expect(doc.pages[1]!.strokes).toHaveLength(0);
		expect(doc.pages[1]!.elements ?? []).toHaveLength(0);
		expect(refused).toEqual([[doc.pages[1]!.id]]);
	});
});

describe("new notebooks from files are never locked", () => {
	const img: Asset = { id: "f".repeat(24), kind: "image", path: "Notebooks/_assets/f.png", name: "a.png", bytes: 10 };
	it("the bulk import and the shared-files New notebook make unlocked pages", () => {
		const bulk = buildImagesDocument([scannedPage(img, 800, 600)], [img], new Date(1));
		const shared = buildImageDocument(img, { width: 800, height: 600 }, new Date(1));
		for (const doc of [bulk, shared]) expect(doc.pages.every((p) => p.locked === undefined)).toBe(true);
		expect(bulk.pages[0]!.width).toBe(PAGE_SIZES.a4.width);
	});
});
