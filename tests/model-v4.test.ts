import { describe, expect, it } from "vitest";
import { cloneMeta, createDocument, createId, createPage, referencedAssets } from "../src/model/document";
import {
	AddAsset, AddElement, AddPage, Batch, DeletePage, History, InsertPages, RemoveElement, ReplaceElement,
	SetMeta, SetPageInfinite,
} from "../src/model/history";
import { MIGRATIONS } from "../src/model/migrations";
import { createPdfPages, duplicatePage } from "../src/model/pages";
import { FULL_CHECK_LIMIT, freezeStroke, parse, serialize, serializeChecked } from "../src/model/serialize";
import {
	CURRENT_VERSION, DEFAULT_META, FORMAT_ID,
	type Asset, type ImageElement, type NotebookDocument, type NotebookMeta, type TextElement,
} from "../src/model/types";
import { line } from "./helpers";

const stamp = "2026-10-29T10:00:00.000Z";
const PDF_ID = "ab12cd34ef56";
const IMG_ID = "0f0f0f";

const pdfAsset: Asset = { id: PDF_ID, kind: "pdf", path: `Notebooks/_assets/${PDF_ID}.pdf`, name: "Slides \"v2\".pdf", bytes: 123456 };
const imgAsset: Asset = { id: IMG_ID, kind: "image", path: `Notebooks/_assets/${IMG_ID}.png`, name: "photo.png", bytes: 0 };

const text = (over: Partial<TextElement> = {}): TextElement => ({
	id: createId(), type: "text", x: 10.5, y: 20, width: 200, text: "Hello\nworld è  ", fontSize: 16, color: "#112233", ...over,
});
const image = (over: Partial<ImageElement> = {}): ImageElement => ({
	id: createId(), type: "image", asset: IMG_ID, x: 5, y: 6, width: 100, height: 50, rotation: 0.25, ...over,
});

function v3Doc() {
	return {
		format: FORMAT_ID, version: 3, id: "doc", createdAt: stamp, modifiedAt: stamp,
		pages: [{
			id: "p", width: 595.28, height: 841.89, paper: { kind: "ruled", spacing: 22.68 },
			strokes: [{ id: "s", tool: "pen", color: "#000000", width: 2, points: [[1, 2, 0.5]] }],
		}],
	};
}

/** A v4 document with every feature in use. */
function fullDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.assets = { [PDF_ID]: pdfAsset, [IMG_ID]: imgAsset };
	const [p1] = doc.pages;
	p1!.strokes.push(freezeStroke(line(0, 0, 50, 50)));
	p1!.elements = [text(), image()];
	p1!.infinite = true;
	const pdfPages = createPdfPages(pdfAsset, [{ width: 300, height: 400 }, { width: 400, height: 300 }], 5);
	doc.pages.push(...pdfPages);
	const imgPage = createPage();
	imgPage.background = { kind: "image", asset: IMG_ID };
	doc.pages.push(imgPage);
	doc.meta = { tags: ["work", "pdf"], favorite: true, cover: "#ff8800", bookmarks: [pdfPages[1]!.id] };
	return doc;
}

/** Plain JSON of the serialized full doc, to be corrupted by the rejection tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

function rawFull(): Raw {
	return JSON.parse(serialize(fullDoc()));
}

describe("format v4 migrations", () => {
	it("has a v3 step", () => {
		expect(MIGRATIONS[3]).toBeTypeOf("function");
	});

	it("migrates v3 to v4: defaults added, content untouched", () => {
		const v3 = v3Doc();
		const r = parse(JSON.stringify(v3));
		if (!r.ok) throw new Error(r.message);
		expect(r.migratedFrom).toBe(3);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.meta).toEqual(DEFAULT_META);
		expect(r.doc.meta).not.toBe(DEFAULT_META);
		expect(r.doc.assets).toEqual({});
		expect(r.doc.pages[0]!.paper).toEqual({ kind: "ruled", spacing: 22.68 });
		expect(r.doc.pages[0]!.strokes[0]).toEqual({ ...v3.pages[0]!.strokes[0], render: 1 });
		expect(r.doc.pages[0]!.background).toBeUndefined();
		expect(r.doc.pages[0]!.elements).toBeUndefined();
		expect(r.doc.pages[0]!.infinite).toBeUndefined();
	});

	it.each([0, 1, 2])("a v%i file reaches the current version", (from) => {
		const raw = from === 0
			? { strokes: [{ color: "#000000", size: 2, points: [{ x: 1, y: 2 }] }] }
			: { ...v3Doc(), version: from, pages: [{ ...v3Doc().pages[0]!, paper: { kind: "grid", spacing: 14.17 } }] };
		const r = parse(JSON.stringify(raw));
		if (!r.ok) throw new Error(r.message);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.migratedFrom).toBe(from);
		expect(r.doc.meta).toEqual(DEFAULT_META);
		expect(r.doc.assets).toEqual({});
		// A migrated document is stable once written.
		const text = serialize(r.doc);
		const again = parse(text);
		expect(again.ok && serialize(again.doc)).toBe(text);
		expect(again.ok && again.migratedFrom).toBeNull();
	});

	it("rejects a pre-v4 file that contains the shape tool", () => {
		const v3 = v3Doc();
		v3.pages[0]!.strokes[0]!.tool = "shape";
		const r = parse(JSON.stringify(v3));
		expect(r.ok).toBe(false);
		// ...while the same stroke is valid in v4.
		const v4 = { ...v3, version: 4, meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] }, assets: {} };
		expect(parse(JSON.stringify(v4)).ok).toBe(true);
	});

	it("a v4 file without meta and assets gets the defaults", () => {
		const v4 = { ...v3Doc(), version: 4 };
		const r = parse(JSON.stringify(v4));
		if (!r.ok) throw new Error(r.message);
		expect(r.doc.meta).toEqual(DEFAULT_META);
		expect(r.doc.assets).toEqual({});
	});

	it("new documents carry independent default metadata", () => {
		const a = createDocument();
		const b = createDocument();
		expect(a.meta).toEqual(DEFAULT_META);
		expect(a.assets).toEqual({});
		a.meta!.tags.push("x");
		expect(b.meta!.tags).toEqual([]);
		expect(DEFAULT_META.tags).toEqual([]);
	});
});

describe("format v4 round trip", () => {
	it("round-trips meta, assets, backgrounds, elements and infinite", () => {
		const doc = fullDoc();
		const textOut = serialize(doc);
		const r = parse(textOut);
		if (!r.ok) throw new Error(r.message);
		expect(r.migratedFrom).toBeNull();
		expect(r.doc).toEqual(doc);
		expect(serialize(r.doc)).toBe(textOut);
		const checked = serializeChecked(doc);
		expect(checked.ok && checked.text).toBe(textOut);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("writes one element and one asset per line, in a fixed order, only when present", () => {
		const doc = fullDoc();
		const out = serialize(doc);
		const lines = out.split("\n");
		expect(lines.filter((l) => l.includes('"type":"text"')).length).toBe(1);
		expect(lines.filter((l) => l.includes('"type":"image"')).length).toBe(1);
		expect(lines.filter((l) => l.startsWith("\t\t\"")).length).toBe(2); // two assets
		// Assets sorted by id: "0f0f0f" before "ab12cd34ef56".
		expect(out.indexOf(`"${IMG_ID}": {`)).toBeLessThan(out.indexOf(`"${PDF_ID}": {`));
		expect(Object.keys(JSON.parse(out))).toEqual(["format", "version", "id", "createdAt", "modifiedAt", "meta", "assets", "pages"]);
		const pages = JSON.parse(out).pages;
		expect(Object.keys(pages[0])).toEqual(["id", "width", "height", "paper", "infinite", "elements", "strokes"]);
		expect(Object.keys(pages[1])).toEqual(["id", "width", "height", "paper", "background", "strokes"]);
		// A plain page carries none of the new keys.
		const plain = JSON.parse(serialize(createDocument())).pages[0];
		expect(Object.keys(plain)).toEqual(["id", "width", "height", "paper", "strokes"]);
	});

	it("is deterministic regardless of the asset insertion order", () => {
		const a = fullDoc();
		const b = fullDoc();
		b.id = a.id; b.pages = a.pages; b.meta = a.meta;
		b.assets = { [IMG_ID]: imgAsset, [PDF_ID]: pdfAsset };
		expect(serialize(b)).toBe(serialize(a));
	});

	it("keeps an explicit infinite:false and drops an empty elements array", () => {
		const raw = rawFull();
		raw.pages[0].infinite = false;
		raw.pages[1].elements = [];
		const r = parse(JSON.stringify(raw));
		if (!r.ok) throw new Error(r.message);
		expect(r.doc.pages[0]!.infinite).toBe(false);
		expect(r.doc.pages[1]!.elements).toBeUndefined();
		const again = parse(serialize(r.doc));
		expect(again.ok && serialize(again.doc)).toBe(serialize(r.doc));
	});

	it("parsed elements are frozen", () => {
		const r = parse(serialize(fullDoc()));
		if (!r.ok) throw new Error(r.message);
		const el = r.doc.pages[0]!.elements![0]!;
		expect(Object.isFrozen(el)).toBe(true);
		expect(() => { (el as { x: number }).x = 1; }).toThrow();
	});

	it("keeps newlines and special characters in text", () => {
		const doc = createDocument(new Date(stamp));
		const t = text({ text: "a\r\nb\t\"q\" \\ \u{1F600} \ud800" });
		doc.pages[0]!.elements = [t];
		const r = parse(serialize(doc));
		expect(r.ok && r.doc.pages[0]!.elements![0]).toEqual(t);
		expect(serializeChecked(doc).ok).toBe(true);
		const empty = text({ text: "" });
		doc.pages[0]!.elements = [empty];
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("filters dangling bookmarks and duplicate tags when writing and reading", () => {
		const doc = fullDoc();
		const pageId = doc.pages[1]!.id;
		doc.meta = { tags: ["a", "a", "b"], favorite: false, cover: "#000000", bookmarks: [pageId, "gone", pageId] };
		const out = serialize(doc);
		const r = parse(out);
		if (!r.ok) throw new Error(r.message);
		expect(r.doc.meta).toEqual({ tags: ["a", "b"], favorite: false, cover: "#000000", bookmarks: [pageId] });
		expect(serialize(r.doc)).toBe(out);
		// A hand-edited file with a stale bookmark loads, minus the stale entry.
		const raw = rawFull();
		raw.meta.bookmarks = [raw.pages[1].id, "stale"];
		const loaded = parse(JSON.stringify(raw));
		expect(loaded.ok && loaded.doc.meta!.bookmarks).toEqual([raw.pages[1].id]);
		// And the in-memory document is not touched by serializing it.
		expect(doc.meta.bookmarks).toEqual([pageId, "gone", pageId]);
	});
});

describe("format v4 validation", () => {
	function rejects(name: string, mutate: (raw: Raw) => void) {
		it(`rejects ${name}`, () => {
			const raw = rawFull();
			mutate(raw);
			const r = parse(JSON.stringify(raw));
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toBe("invalid");
		});
	}

	it("the unmodified raw document is valid", () => {
		expect(parse(JSON.stringify(rawFull())).ok).toBe(true);
	});

	rejects("a dangling image element asset", (d) => { d.pages[0].elements[1].asset = "dead"; });
	rejects("an image element that points to a PDF", (d) => { d.pages[0].elements[1].asset = PDF_ID; });
	rejects("a dangling pdf background", (d) => { d.pages[1].background.asset = "dead"; });
	rejects("a pdf background that points to an image", (d) => { d.pages[1].background.asset = IMG_ID; });
	rejects("an image background that points to a PDF", (d) => { d.pages[3].background.asset = PDF_ID; });
	rejects("page number 0", (d) => { d.pages[1].background.page = 0; });
	rejects("a fractional page number", (d) => { d.pages[1].background.page = 1.5; });
	rejects("a missing page number", (d) => { delete d.pages[1].background.page; });
	rejects("an unknown background kind", (d) => { d.pages[1].background.kind = "svg"; });
	rejects("a non-boolean infinite", (d) => { d.pages[0].infinite = "yes"; });
	rejects("a duplicate id between a stroke and an element", (d) => { d.pages[0].elements[0].id = d.pages[0].strokes[0].id; });
	rejects("a duplicate id between elements on different pages", (d) => { d.pages[3].elements = [{ ...d.pages[0].elements[0] }]; });
	rejects("a bad text colour", (d) => { d.pages[0].elements[0].color = "red"; });
	rejects("a text with width 0", (d) => { d.pages[0].elements[0].width = 0; });
	rejects("a text with fontSize 0", (d) => { d.pages[0].elements[0].fontSize = 0; });
	rejects("a text with fontSize above 400", (d) => { d.pages[0].elements[0].fontSize = 401; });
	rejects("a non-string text", (d) => { d.pages[0].elements[0].text = 5; });
	rejects("a null element coordinate (NaN on save)", (d) => { d.pages[0].elements[0].x = null; });
	rejects("an image with a null rotation", (d) => { d.pages[0].elements[1].rotation = null; });
	rejects("an image with height 0", (d) => { d.pages[0].elements[1].height = 0; });
	rejects("an unknown element type", (d) => { d.pages[0].elements[0].type = "sticker"; });
	rejects("elements that are not an array", (d) => { d.pages[0].elements = {}; });
	rejects("an asset whose key differs from its id", (d) => { d.assets[IMG_ID].id = "abc"; });
	rejects("an asset id that is not lowercase hex", (d) => {
		d.assets.XYZ = { ...d.assets[IMG_ID], id: "XYZ" };
	});
	rejects("an asset id in upper case", (d) => {
		d.assets.ABCD = { ...d.assets[IMG_ID], id: "ABCD" };
	});
	rejects("an unknown asset kind", (d) => { d.assets[IMG_ID].kind = "video"; });
	rejects("an empty asset path", (d) => { d.assets[IMG_ID].path = ""; });
	rejects("a non-string asset name", (d) => { d.assets[IMG_ID].name = 3; });
	rejects("negative asset bytes", (d) => { d.assets[IMG_ID].bytes = -1; });
	rejects("fractional asset bytes", (d) => { d.assets[IMG_ID].bytes = 1.5; });
	rejects("assets that are not an object", (d) => { d.assets = []; });
	rejects("an empty tag", (d) => { d.meta.tags = [""]; });
	rejects("a non-string tag", (d) => { d.meta.tags = [1]; });
	rejects("a non-boolean favorite", (d) => { d.meta.favorite = 1; });
	rejects("a bad cover colour", (d) => { d.meta.cover = "#abc"; });
	rejects("bookmarks that are not an array", (d) => { d.meta.bookmarks = "x"; });
	rejects("meta that is not an object", (d) => { d.meta = []; });

	it("accepts asset bytes 0 and an empty asset name", () => {
		const raw = rawFull();
		raw.assets[IMG_ID].name = "";
		expect(parse(JSON.stringify(raw)).ok).toBe(true);
	});

	it("an asset id such as __proto__ cannot be used to reach inherited properties", () => {
		const raw = rawFull();
		raw.pages[0].elements[1].asset = "constructor";
		expect(parse(JSON.stringify(raw)).ok).toBe(false);
	});

	it("serializeChecked rejects what parse would reject", () => {
		const doc = fullDoc();
		doc.pages[0]!.elements = [text({ x: NaN })];
		expect(serializeChecked(doc).ok).toBe(false);
		doc.pages[0]!.elements = [text({ color: "red" })];
		expect(serializeChecked(doc).ok).toBe(false);
		doc.pages[0]!.elements = [image({ asset: "nope" })];
		expect(serializeChecked(doc).ok).toBe(false);
		const d2 = fullDoc();
		d2.pages[1]!.background = { kind: "pdf", asset: PDF_ID, page: 0 };
		expect(serializeChecked(d2).ok).toBe(false);
		const d3 = fullDoc();
		d3.assets![IMG_ID] = { ...imgAsset, id: "other" };
		expect(serializeChecked(d3).ok).toBe(false);
		const d4 = fullDoc();
		d4.pages[0]!.elements!.push(text({ id: d4.pages[0]!.strokes[0]!.id }));
		expect(serializeChecked(d4).ok).toBe(false);
	});
});

describe("serializeChecked on a large document", () => {
	function largeDoc(): NotebookDocument {
		const doc = fullDoc();
		const page = doc.pages[0]!;
		while (serialize(doc).length < FULL_CHECK_LIMIT * 1.1) {
			for (let i = 0; i < 300; i++) page.strokes.push(freezeStroke(line(i % 500, (i * 7) % 800, (i % 500) + 30, ((i * 7) % 800) + 10, 30)));
		}
		return doc;
	}

	it("validates elements and asset references on every save, in the incremental path too", () => {
		const doc = largeDoc();
		const ok = serializeChecked(doc);
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		expect(ok.text.length).toBeGreaterThan(FULL_CHECK_LIMIT);
		expect(serializeChecked(doc).ok).toBe(true); // second run: stroke cache

		// An invalid element.
		const good = doc.pages[0]!.elements!;
		doc.pages[0]!.elements = [...good, text({ fontSize: 0 })];
		expect(serializeChecked(doc).ok).toBe(false);
		doc.pages[0]!.elements = [...good, text({ x: Infinity })];
		expect(serializeChecked(doc).ok).toBe(false);
		// A duplicate id between a stroke and an element.
		doc.pages[0]!.elements = [...good, text({ id: doc.pages[0]!.strokes[5]!.id })];
		expect(serializeChecked(doc).ok).toBe(false);
		doc.pages[0]!.elements = good;
		expect(serializeChecked(doc).ok).toBe(true);

		// A dangling asset reference (element and background).
		doc.pages[0]!.elements = [...good, image({ asset: "beef" })];
		expect(serializeChecked(doc).ok).toBe(false);
		doc.pages[0]!.elements = good;
		const saved = doc.assets![PDF_ID]!;
		delete doc.assets![PDF_ID];
		expect(serializeChecked(doc).ok).toBe(false);
		doc.assets![PDF_ID] = saved;
		expect(serializeChecked(doc).ok).toBe(true);

		// Wrong kind and a bad meta.
		doc.pages[1]!.background = { kind: "pdf", asset: IMG_ID, page: 1 };
		expect(serializeChecked(doc).ok).toBe(false);
	});
});

describe("referencedAssets", () => {
	it("collects backgrounds and image elements", () => {
		const doc = fullDoc();
		expect(referencedAssets(doc)).toEqual(new Set([PDF_ID, IMG_ID]));
		doc.pages[0]!.elements = [text()];
		doc.pages[3]!.background = undefined;
		delete doc.pages[3]!.background;
		expect(referencedAssets(doc)).toEqual(new Set([PDF_ID]));
		expect(referencedAssets(createDocument())).toEqual(new Set());
	});
});

describe("pages", () => {
	it("createPdfPages makes blank pages with pdf backgrounds", () => {
		const pages = createPdfPages(pdfAsset, [{ width: 100, height: 200 }, { width: 300, height: 150 }, { width: 50, height: 50 }], 3);
		expect(pages.map((p) => p.background)).toEqual([
			{ kind: "pdf", asset: PDF_ID, page: 3 }, { kind: "pdf", asset: PDF_ID, page: 4 }, { kind: "pdf", asset: PDF_ID, page: 5 },
		]);
		expect(pages.map((p) => [p.width, p.height])).toEqual([[100, 200], [300, 150], [50, 50]]);
		expect(pages.every((p) => p.paper.kind === "blank" && p.strokes.length === 0)).toBe(true);
		expect(new Set(pages.map((p) => p.id)).size).toBe(3);
		expect(createPdfPages(pdfAsset, [{ width: 1, height: 1 }])[0]!.background).toEqual({ kind: "pdf", asset: PDF_ID, page: 1 });
		expect(createPdfPages(pdfAsset, [])).toEqual([]);
	});

	it("createPdfPages rejects bad input", () => {
		expect(() => createPdfPages(imgAsset, [{ width: 1, height: 1 }])).toThrow();
		expect(() => createPdfPages(pdfAsset, [{ width: 0, height: 1 }])).toThrow();
		expect(() => createPdfPages(pdfAsset, [{ width: NaN, height: 1 }])).toThrow();
		expect(() => createPdfPages(pdfAsset, [{ width: 1, height: 1 }], 0)).toThrow();
	});

	it("duplicatePage copies background, elements with new ids, and infinite", () => {
		const doc = fullDoc();
		const src = doc.pages[0]!;
		const copy = duplicatePage(src);
		expect(copy.id).not.toBe(src.id);
		expect(copy.infinite).toBe(true);
		expect(copy.elements).toHaveLength(2);
		expect(copy.elements!.map((e) => e.id)).not.toContain(src.elements![0]!.id);
		expect({ ...copy.elements![0]!, id: "" }).toEqual({ ...src.elements![0]!, id: "" });
		expect(Object.isFrozen(copy.elements![0])).toBe(true);
		const pdfCopy = duplicatePage(doc.pages[1]!);
		expect(pdfCopy.background).toEqual(doc.pages[1]!.background);
		expect(pdfCopy.background).not.toBe(doc.pages[1]!.background);
		expect(pdfCopy.elements).toBeUndefined();
		expect(pdfCopy.infinite).toBeUndefined();
		// Plain pages stay plain.
		expect(Object.keys(duplicatePage(createPage()))).toEqual(["id", "width", "height", "paper", "strokes"]);
		// The duplicated document is valid, with unique ids across strokes and elements.
		doc.pages.push(copy);
		expect(serializeChecked(doc).ok).toBe(true);
	});
});

describe("v4 commands", () => {
	const make = () => {
		const doc = createDocument(new Date(stamp));
		return { doc, h: new History(() => doc) };
	};

	it("AddElement: apply, undo, redo, never duplicates", () => {
		const { doc, h } = make();
		const page = doc.pages[0]!;
		const a = text();
		const b = image();
		doc.assets = { [IMG_ID]: imgAsset };
		h.execute(new AddElement(page.id, a, 0));
		h.execute(new AddElement(page.id, b, 0));
		expect(page.elements).toEqual([b, a]);
		expect(Object.isFrozen(a)).toBe(true);
		const dup = new AddElement(page.id, a, 0);
		dup.apply(doc);
		expect(page.elements).toHaveLength(2);
		h.undo();
		expect(page.elements).toEqual([a]);
		h.undo();
		expect(page.elements).toEqual([]);
		h.redo();
		h.redo();
		expect(page.elements).toEqual([b, a]);
		expect(serializeChecked(doc).ok).toBe(true);
		// Index past the end is clamped.
		const c = text();
		new AddElement(page.id, c, 99).apply(doc);
		expect(page.elements![2]).toBe(c);
	});

	it("RemoveElement: apply, undo restores position, redo", () => {
		const { doc, h } = make();
		const page = doc.pages[0]!;
		const [a, b, c] = [text(), text(), text()];
		page.elements = [a, b, c];
		h.execute(new RemoveElement(page.id, b));
		expect(page.elements).toEqual([a, c]);
		h.undo();
		expect(page.elements).toEqual([a, b, c]);
		h.redo();
		expect(page.elements).toEqual([a, c]);
		h.undo();
		expect(page.elements).toEqual([a, b, c]);
		// Removing something that is not there changes nothing, in either direction.
		const ghost = new RemoveElement(page.id, text());
		ghost.apply(doc);
		ghost.revert(doc);
		expect(page.elements).toEqual([a, b, c]);
	});

	it("ReplaceElement: apply, undo, redo, position kept, never duplicates", () => {
		const { doc, h } = make();
		const page = doc.pages[0]!;
		const [a, b, c] = [text(), text(), text()];
		page.elements = [a, b, c];
		const b2 = { ...b, text: "edited" };
		h.execute(new ReplaceElement(page.id, b, b2));
		expect(page.elements).toEqual([a, b2, c]);
		expect(page.elements![1]).toBe(b2);
		expect(Object.isFrozen(b2)).toBe(true);
		h.undo();
		expect(page.elements![1]).toBe(b);
		h.redo();
		expect(page.elements![1]).toBe(b2);
		// A stale replacement (before is gone) is a no-op in both directions.
		const stale = new ReplaceElement(page.id, b, { ...b, text: "again" });
		stale.apply(doc);
		stale.revert(doc);
		expect(page.elements).toEqual([a, b2, c]);
		// Undo still works if the replaced object moved.
		page.elements = [c, b2, a];
		h.undo();
		expect(page.elements).toEqual([c, b, a]);
	});

	it("SetMeta: apply, undo, redo, with copies", () => {
		const { doc, h } = make();
		const before = cloneMeta(doc.meta!);
		const after: NotebookMeta = { tags: ["x"], favorite: true, cover: "#00ff00", bookmarks: [doc.pages[0]!.id] };
		const cmd = new SetMeta(before, after);
		after.tags.push("mutated later");
		h.execute(cmd);
		expect(doc.meta).toEqual({ tags: ["x"], favorite: true, cover: "#00ff00", bookmarks: [doc.pages[0]!.id] });
		doc.meta!.tags.push("in-place edit");
		h.undo();
		expect(doc.meta).toEqual(DEFAULT_META);
		h.redo();
		expect(doc.meta!.tags).toEqual(["x"]);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("AddAsset: undo removes only what this command added", () => {
		const { doc, h } = make();
		h.execute(new AddAsset(pdfAsset));
		expect(doc.assets![PDF_ID]).toBe(pdfAsset);
		h.undo();
		expect(doc.assets).toEqual({});
		h.redo();
		expect(doc.assets![PDF_ID]).toBe(pdfAsset);
		// The same content imported again: second command adds nothing and undoing it keeps the asset.
		const again = new AddAsset({ ...pdfAsset, name: "other name.pdf" });
		again.apply(doc);
		expect(doc.assets![PDF_ID]).toBe(pdfAsset);
		again.revert(doc);
		expect(doc.assets![PDF_ID]).toBe(pdfAsset);
		// A document without an assets map gets one.
		const bare = createDocument();
		delete bare.assets;
		new AddAsset(imgAsset).apply(bare);
		expect(bare.assets![IMG_ID]).toBe(imgAsset);
	});

	it("InsertPages: one command for many pages, exact undo, redo", () => {
		const { doc, h } = make();
		const second = createPage();
		doc.pages.push(second);
		const first = doc.pages[0]!;
		const pdfPages = createPdfPages(pdfAsset, Array.from({ length: 50 }, () => ({ width: 300, height: 400 })));
		h.execute(new Batch("Import PDF", [new AddAsset(pdfAsset), new InsertPages(pdfPages, 1)]));
		expect(doc.pages).toHaveLength(52);
		expect(doc.pages[0]).toBe(first);
		expect(doc.pages[1]).toBe(pdfPages[0]);
		expect(doc.pages[50]).toBe(pdfPages[49]);
		expect(doc.pages[51]).toBe(second);
		expect(doc.pages.map((p) => p.background?.kind === "pdf" ? p.background.page : 0).slice(1, 51)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
		expect(serializeChecked(doc).ok).toBe(true);
		h.undo();
		expect(doc.pages).toEqual([first, second]);
		expect(doc.pages[0]).toBe(first);
		expect(doc.assets).toEqual({});
		h.redo();
		expect(doc.pages).toHaveLength(52);
		expect(doc.assets![PDF_ID]).toBe(pdfAsset);
		expect(serializeChecked(doc).ok).toBe(true);
		const text2 = serialize(doc);
		const r = parse(text2);
		expect(r.ok && r.doc.pages.length).toBe(52);
	});

	it("InsertPages never duplicates a page and never leaves zero pages", () => {
		const { doc } = make();
		const extra = createPage();
		const cmd = new InsertPages([extra, extra], 1);
		cmd.apply(doc);
		expect(doc.pages).toHaveLength(2);
		cmd.apply(doc); // applying again inserts nothing new
		expect(doc.pages).toHaveLength(2);
		cmd.revert(doc);
		expect(doc.pages).toHaveLength(1);
		cmd.revert(doc); // reverting twice removes nothing more
		expect(doc.pages).toHaveLength(1);
		// Index clamped; empty list is a no-op.
		const p = createPage();
		new InsertPages([p], 99).apply(doc);
		expect(doc.pages[1]).toBe(p);
		new InsertPages([], 0).apply(doc);
		expect(doc.pages).toHaveLength(2);
		// If the document lost its other pages meanwhile, the last page is kept.
		const only = createDocument();
		const added = createPage();
		const ins = new InsertPages([added], 1);
		ins.apply(only);
		only.pages = [added];
		ins.revert(only);
		expect(only.pages).toEqual([added]);
	});

	it("InsertPages works together with page deletion undo", () => {
		const { doc, h } = make();
		const pages = [createPage(), createPage()];
		h.execute(new InsertPages(pages, 1));
		h.execute(new DeletePage(pages[0]!, 1));
		h.undo();
		expect(doc.pages).toHaveLength(3);
		h.undo();
		expect(doc.pages).toHaveLength(1);
		h.execute(new AddPage(createPage(), 1));
		expect(doc.pages).toHaveLength(2);
	});

	it("SetPageInfinite: apply, undo, redo, restores the previous state", () => {
		const { doc, h } = make();
		const page = doc.pages[0]!;
		h.execute(new SetPageInfinite(page.id, true));
		expect(page.infinite).toBe(true);
		h.undo();
		expect(page.infinite).toBeUndefined();
		expect("infinite" in page).toBe(false);
		h.redo();
		expect(page.infinite).toBe(true);
		h.execute(new SetPageInfinite(page.id, false));
		expect(page.infinite).toBeUndefined();
		h.undo();
		expect(page.infinite).toBe(true);
		// A page that stored an explicit false gets it back.
		page.infinite = false;
		const cmd = new SetPageInfinite(page.id, true);
		cmd.apply(doc);
		cmd.revert(doc);
		expect(page.infinite).toBe(false);
		cmd.revert(doc); // reverting twice does nothing
		expect(page.infinite).toBe(false);
	});

	it("a whole editing session undoes back to the starting file, byte for byte", () => {
		const { doc, h } = make();
		doc.assets = {};
		const start = serialize(doc);
		const page = doc.pages[0]!;
		const pdfPages = createPdfPages(pdfAsset, [{ width: 300, height: 400 }]);
		h.execute(new Batch("Import", [new AddAsset(pdfAsset), new InsertPages(pdfPages, 1)]));
		h.execute(new SetPageInfinite(page.id, true));
		h.execute(new AddElement(page.id, text(), 0));
		h.execute(new SetMeta(doc.meta!, { ...doc.meta!, favorite: true, tags: ["t"] }));
		expect(serializeChecked(doc).ok).toBe(true);
		while (h.canUndo()) h.undo();
		expect(serialize(doc)).toBe(start);
	});
});
