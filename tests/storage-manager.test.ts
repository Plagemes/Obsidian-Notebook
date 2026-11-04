import { describe, expect, it } from "vitest";
import { assetUses, planAssetRepoint, RemoveAsset, repointInText, useCount } from "../src/model/asset-ops";
import { cloneMeta, createPage } from "../src/model/document";
import { createExcerpt } from "../src/model/excerpts";
import { AddAsset, Batch, History } from "../src/model/history";
import { parse, serialize } from "../src/model/serialize";
import { DEFAULT_META, PAGE_SIZES, type Asset, type ImageElement, type NotebookDocument } from "../src/model/types";
import { sampleDocument } from "./helpers";

const id = (n: number) => n.toString(16).padStart(24, "0");
const image = (n: number, ext = "png", bytes = 100): Asset => ({ id: id(n), kind: "image", path: `Notebooks/_assets/${id(n)}.${ext}`, name: `pic${n}.${ext}`, bytes });

function imageElement(asset: number, n = 1): ImageElement {
	return { id: `el-${asset}-${n}`, type: "image", asset: id(asset), x: 10, y: 10, width: 100, height: 80, rotation: 0 };
}

/** A notebook that uses picture 1 as the page background of page 1, as an image on page 2, as an excerpt snapshot and as the cover. */
function busyDocument(): NotebookDocument {
	const doc = sampleDocument(2);
	const second = createPage(PAGE_SIZES.a4);
	doc.pages.push(second);
	doc.assets = { [id(1)]: image(1), [id(2)]: image(2) };
	doc.pages[0]!.background = { kind: "image", asset: id(1) };
	second.elements = [imageElement(1), imageElement(2), createExcerpt(doc, "Notebooks/A.notebook", doc.pages[0]!, { x: 0, y: 0, width: 50, height: 50 }, { x: 20, y: 20, width: 50, height: 50 }, id(1))];
	doc.meta = { ...cloneMeta(DEFAULT_META), coverArt: { kind: "image", asset: id(1) } };
	return doc;
}

describe("pointing a notebook at another picture", () => {
	it("finds every place a picture is used", () => {
		const uses = assetUses(busyDocument(), id(1));
		expect(uses.backgrounds).toHaveLength(1);
		expect(uses.elements).toHaveLength(2);
		expect(uses.cover).toBe(true);
		expect(useCount(uses)).toBe(4);
		expect(useCount(assetUses(busyDocument(), id(2)))).toBe(1);
		expect(useCount(assetUses(busyDocument(), id(9)))).toBe(0);
	});

	it("repoints the background, the image, the excerpt snapshot and the cover, registers the new one and drops the old record", () => {
		const doc = busyDocument();
		const plan = planAssetRepoint(doc, id(1), image(3, "jpg"))!;
		expect(plan).not.toBeNull();
		plan.apply(doc);
		expect(useCount(assetUses(doc, id(1)))).toBe(0);
		expect(useCount(assetUses(doc, id(3)))).toBe(4);
		expect(doc.assets![id(3)]).toBeDefined();
		expect(doc.assets![id(1)]).toBeUndefined();
		// The other picture is untouched.
		expect(doc.assets![id(2)]).toBeDefined();
		expect(useCount(assetUses(doc, id(2)))).toBe(1);
		// And the result is a document the writer accepts.
		const back = parse(serialize(doc));
		expect(back.ok).toBe(true);
	});

	it("is one batch: undo puts every use and the old record back, redo does it again", () => {
		const doc = busyDocument();
		const before = serialize(doc);
		const history = new History(() => doc);
		const plan = planAssetRepoint(doc, id(1), image(3))!;
		expect(plan).toBeInstanceOf(Batch);
		history.execute(plan);
		const after = serialize(doc);
		expect(after).not.toBe(before);
		history.undo();
		expect(serialize(doc)).toBe(before);
		history.redo();
		expect(serialize(doc)).toBe(after);
		expect(history.canUndo()).toBe(true);
	});

	it("does nothing for a picture the notebook does not use, the same picture, a PDF or an unknown id", () => {
		const doc = busyDocument();
		expect(planAssetRepoint(doc, id(9), image(3))).toBeNull();
		expect(planAssetRepoint(doc, id(1), image(1))).toBeNull();
		expect(planAssetRepoint(doc, id(1), { ...image(3), kind: "pdf" })).toBeNull();
		doc.assets![id(5)] = { id: id(5), kind: "pdf", path: "x.pdf", name: "x.pdf", bytes: 1 };
		expect(planAssetRepoint(doc, id(5), image(3))).toBeNull();
	});

	it("an existing record of the new picture is left alone, and undo does not remove it", () => {
		const doc = busyDocument();
		doc.assets![id(3)] = image(3);
		const mine = planAssetRepoint(doc, id(1), image(3, "jpg"))!;
		mine.apply(doc);
		expect(doc.assets![id(3)]!.path).toBe(image(3).path);
		mine.revert(doc);
		expect(doc.assets![id(3)]).toBeDefined();
		expect(doc.assets![id(1)]).toBeDefined();
	});

	it("RemoveAsset is a no-op both ways when the record is not there", () => {
		const doc = busyDocument();
		const cmd = new RemoveAsset(id(9));
		cmd.apply(doc);
		cmd.revert(doc);
		expect(Object.keys(doc.assets!)).toEqual([id(1), id(2)]);
	});

	it("keeps the page size when a background is repointed", () => {
		const doc = busyDocument();
		const page = doc.pages[0]!;
		const [w, h] = [page.width, page.height];
		planAssetRepoint(doc, id(1), image(3))!.apply(doc);
		expect([page.width, page.height]).toEqual([w, h]);
		expect(page.background).toEqual({ kind: "image", asset: id(3) });
	});
});

describe("repointing a closed notebook's text", () => {
	it("returns the new text, which reads back using only the new picture", () => {
		const text = serialize(busyDocument());
		const r = repointInText(text, id(1), image(3, "jpg"));
		expect(r.ok).toBe(true);
		if (!r.ok || r.text === null) throw new Error("expected text");
		expect(r.changes).toBe(4);
		const back = parse(r.text);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(useCount(assetUses(back.doc, id(1)))).toBe(0);
		expect(useCount(assetUses(back.doc, id(3)))).toBe(4);
		expect(r.text).not.toContain(id(1));
	});

	it("text: null (leave the file alone) when the notebook does not use the picture", () => {
		const r = repointInText(serialize(busyDocument()), id(9), image(3));
		expect(r).toEqual({ ok: true, text: null, changes: 0 });
	});

	it("never produces text for a notebook that does not parse", () => {
		const text = serialize(busyDocument());
		const r = repointInText(text.slice(0, text.length - 40), id(1), image(3));
		expect(r.ok).toBe(false);
		expect(repointInText("", id(1), image(3)).ok).toBe(false);
		expect(repointInText("{not json", id(1), image(3)).ok).toBe(false);
	});

	it("the modification stamp moves forward", () => {
		const doc = busyDocument();
		const r = repointInText(serialize(doc), id(1), image(3));
		if (!r.ok || r.text === null) throw new Error("expected text");
		const back = parse(r.text);
		if (!back.ok) throw new Error("expected a document");
		expect(Date.parse(back.doc.modifiedAt)).toBeGreaterThan(Date.parse(doc.modifiedAt));
	});
});

describe("AddAsset stays what it was", () => {
	it("registering twice adds once", () => {
		const doc = busyDocument();
		const cmd = new AddAsset(image(7));
		cmd.apply(doc);
		cmd.apply(doc);
		expect(Object.keys(doc.assets!)).toContain(id(7));
	});
});
