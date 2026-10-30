import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { Batch, History, SetPageBackground, SetPageMargins, SetPageSize } from "../src/model/history";
import {
	backgroundRect, marginsAfterResize, marginsEqual, normalizeMargins, pagesWithSameBackground, sizeWithMargins, translateStroke,
} from "../src/model/margins";
import { MIGRATIONS } from "../src/model/migrations";
import { duplicatePage } from "../src/model/pages";
import { freezeStroke, parse, serialize, serializeChecked } from "../src/model/serialize";
import { CURRENT_VERSION, FORMAT_ID, type NotebookDocument, type Page, type TextElement } from "../src/model/types";
import { getAt, type Raw } from "./raw-json";

const stamp = "2026-10-29T10:00:00.000Z";

const ASSET = "abcdef0123456789abcdef01";

function v5Doc(extraPage: Raw = {}): Raw {
	return {
		format: FORMAT_ID, version: 5, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: { [ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "slides.pdf", bytes: 10 } },
		pages: [{
			id: "p1", width: 600, height: 400, paper: { kind: "blank", spacing: 14.17 },
			background: { kind: "pdf", asset: ASSET, page: 1 },
			strokes: [{ id: "s1", tool: "pen", color: "#112233", width: 2, render: 1, points: [[10, 20, 0.5], [30, 40, 0.5]] }],
			...extraPage,
		}],
	};
}

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

/** A PDF page (600 × 400) with one stroke and one text box. */
function pdfDoc(): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(new Date(stamp));
	doc.assets = { [ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "slides.pdf", bytes: 10 } };
	const page = doc.pages[0]!;
	page.width = 600;
	page.height = 400;
	page.background = { kind: "pdf", asset: ASSET, page: 1 };
	page.strokes.push(freezeStroke(createStroke("#112233", 2, [[10, 20, 0.5], [30.25, 40, 0.5]])));
	const text: TextElement = { id: "t1", type: "text", x: 50, y: 60, width: 100, text: "note", fontSize: 12, color: "#000000" };
	page.elements = [Object.freeze(text)];
	return { doc, page };
}

describe("format v6: page margins", () => {
	it("is at version 6 with a v5 step", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(6);
		expect(MIGRATIONS[5]).toBeTypeOf("function");
	});

	it("migrates a v5 file unchanged apart from the version", () => {
		const raw = v5Doc();
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(5);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.margins).toBeUndefined();
		expect(r.doc.pages[0]!.strokes[0]!.points).toEqual(getAt(raw, ["pages", 0, "strokes", 0, "points"]));
		expect(r.doc.pages[0]!.background).toEqual(getAt(raw, ["pages", 0, "background"]));
		const text = serialize(r.doc);
		expect(parsed(text).migratedFrom).toBeNull();
		expect(serialize(parsed(text).doc)).toBe(text);
	});

	it("drops a 'margins' key from a v5 file (v5 ignored it)", () => {
		const r = parsed(JSON.stringify(v5Doc({ margins: { left: 10, right: 0, bottom: 0 } })));
		expect(r.doc.pages[0]!.margins).toBeUndefined();
		expect(r.doc.pages[0]!.width).toBe(600);
	});

	it("v0 to v4 files still reach the current version", () => {
		const r = parsed(JSON.stringify({ strokes: [{ color: "#000000", size: 2, points: [{ x: 1, y: 2 }] }] }));
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.migratedFrom).toBe(0);
	});

	it("round-trips margins deterministically, after the background", () => {
		const raw = { ...v5Doc({ margins: { left: 20, right: 150.5, bottom: 30 }, width: 770.5, height: 430 }), version: 6 };
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.pages[0]!.margins).toEqual({ left: 20, right: 150.5, bottom: 30 });
		const text = serialize(r.doc);
		expect(text).toContain(`"margins": {"left":20,"right":150.5,"bottom":30},`);
		expect(text.indexOf('"background"')).toBeLessThan(text.indexOf('"margins"'));
		expect(serialize(parsed(text).doc)).toBe(text);
		const checked = serializeChecked(r.doc);
		expect(checked.ok && checked.text).toBe(text);
	});

	it.each([
		["not an object", 5],
		["negative", { left: -1, right: 0, bottom: 0 }],
		["missing side", { left: 1, right: 0 }],
		["NaN", { left: "x", right: 0, bottom: 0 }],
		["wider than the page", { left: 300, right: 300, bottom: 0 }],
		["taller than the page", { left: 0, right: 0, bottom: 400 }],
	])("rejects invalid margins: %s", (_name, margins) => {
		const r = parse(JSON.stringify({ ...v5Doc({ margins }), version: 6 }));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("invalid");
			expect(r.message).toContain("pages[0].margins");
		}
	});

	it("a file of a version after the current one is a future version (opens read-only, never rewritten)", () => {
		const r = parse(JSON.stringify({ ...v5Doc(), version: CURRENT_VERSION + 1 }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("the save check rejects margins that leave no room for the background", () => {
		const { doc, page } = pdfDoc();
		page.margins = { left: 400, right: 300, bottom: 0 };
		expect(serializeChecked(doc).ok).toBe(false);
	});
});

describe("margins helpers", () => {
	it("backgroundRect is the page minus its margins", () => {
		expect(backgroundRect({ width: 600, height: 400 })).toEqual({ x: 0, y: 0, width: 600, height: 400 });
		expect(backgroundRect({ width: 800, height: 450, margins: { left: 50, right: 150, bottom: 50 } })).toEqual({ x: 50, y: 0, width: 600, height: 400 });
	});

	it("normalizes: rounds, clamps and stores no margins as absence", () => {
		expect(normalizeMargins({ left: 0, right: 0, bottom: 0 })).toBeUndefined();
		expect(normalizeMargins({ left: -3, right: 10.004, bottom: Number.NaN })).toEqual({ left: 0, right: 10, bottom: 0 });
		expect(marginsEqual(undefined, { left: 0, right: 0, bottom: 0 })).toBe(true);
		expect(sizeWithMargins({ width: 600, height: 400 }, { left: 10, right: 20, bottom: 30 })).toEqual({ width: 630, height: 430 });
	});

	it("resizing a page with margins keeps the background box", () => {
		const page = { width: 800, height: 400, margins: { left: 50, right: 150, bottom: 0 } };
		expect(marginsAfterResize(page, { width: 800, height: 700 })).toEqual({ left: 50, right: 150, bottom: 300 });
		expect(marginsAfterResize(page, { width: 500, height: 400 })).toEqual({ left: 50, right: 0, bottom: 0 }); // the box shrinks
		expect(marginsAfterResize({ width: 800, height: 400, margins: { left: 50, right: 150, bottom: 0 } }, { width: 700, height: 400 })).toEqual({ left: 50, right: 50, bottom: 0 });
		expect(marginsAfterResize(page, { width: 40, height: 400 })).toBeUndefined();
		expect(marginsAfterResize({ width: 600, height: 400 }, { width: 700, height: 400 })).toBeUndefined();
	});

	it("translateStroke keeps id and quantization", () => {
		const s = freezeStroke(createStroke("#000000", 2, [[1.11, 2, 0.5]]));
		const t = translateStroke(s, 0.1);
		expect(t.id).toBe(s.id);
		expect(t.points).toEqual([[1.21, 2, 0.5]]);
		expect(Object.isFrozen(t)).toBe(true);
	});

	it("finds the pages of the same PDF", () => {
		const a = createPage();
		a.background = { kind: "pdf", asset: "x", page: 1 };
		const b = createPage();
		b.background = { kind: "pdf", asset: "x", page: 2 };
		const c = createPage();
		c.background = { kind: "pdf", asset: "y", page: 1 };
		const d = createPage();
		expect(pagesWithSameBackground([a, b, c, d], b)).toEqual([a, b]);
		expect(pagesWithSameBackground([a, b, c, d], d)).toEqual([d]);
	});
});

describe("SetPageMargins", () => {
	it("widens the page and moves ink and text with the PDF; undo restores the same objects", () => {
		const { doc, page } = pdfDoc();
		const history = new History(() => doc);
		const stroke = page.strokes[0]!;
		const text = page.elements![0]!;
		const pdfBefore = backgroundRect(page);
		history.execute(new SetPageMargins(page.id, undefined, { left: 40, right: 200, bottom: 25 }));
		expect(page.width).toBe(840);
		expect(page.height).toBe(425);
		expect(page.margins).toEqual({ left: 40, right: 200, bottom: 25 });
		const pdfAfter = backgroundRect(page);
		expect(pdfAfter).toEqual({ x: 40, y: 0, width: pdfBefore.width, height: pdfBefore.height });
		// Ink relative to the PDF is unchanged.
		const moved = page.strokes[0]!;
		expect(moved).not.toBe(stroke);
		expect(moved.id).toBe(stroke.id);
		expect(moved.points.map(([x, y]) => [x - pdfAfter.x, y])).toEqual(stroke.points.map(([x, y]) => [x - pdfBefore.x, y]));
		expect(page.elements![0]!.x - pdfAfter.x).toBe(text.x - pdfBefore.x);
		expect(serializeChecked(doc).ok).toBe(true);

		history.undo();
		expect(page.width).toBe(600);
		expect(page.height).toBe(400);
		expect(page.margins).toBeUndefined();
		expect(page.strokes[0]).toBe(stroke);
		expect(page.elements![0]).toBe(text);

		history.redo();
		expect(page.strokes[0]).toBe(moved);
		expect(page.width).toBe(840);
	});

	it("changing only the right or bottom margin does not move the ink", () => {
		const { doc, page } = pdfDoc();
		const stroke = page.strokes[0]!;
		new SetPageMargins(page.id, undefined, { left: 0, right: 100, bottom: 0 }).apply(doc);
		expect(page.strokes[0]).toBe(stroke);
		expect(page.width).toBe(700);
	});

	it("shrinking the left margin moves the ink back; removing margins restores the original size", () => {
		const { doc, page } = pdfDoc();
		const x0 = page.strokes[0]!.points[0]![0];
		const history = new History(() => doc);
		history.execute(new SetPageMargins(page.id, undefined, { left: 50, right: 0, bottom: 0 }));
		history.execute(new SetPageMargins(page.id, page.margins, { left: 20, right: 0, bottom: 0 }));
		expect(page.strokes[0]!.points[0]![0]).toBe(x0 + 20);
		history.execute(new SetPageMargins(page.id, page.margins, undefined));
		expect(page.width).toBe(600);
		expect(page.strokes[0]!.points[0]![0]).toBe(x0);
		expect(page.margins).toBeUndefined();
		history.undo();
		history.undo();
		history.undo();
		expect(page.width).toBe(600);
		expect(page.strokes[0]!.points[0]![0]).toBe(x0);
	});

	it("a batch over several pages is one undo step", () => {
		const { doc, page } = pdfDoc();
		const second = duplicatePage(page);
		doc.pages.push(second);
		const history = new History(() => doc);
		history.execute(new Batch("m", [page, second].map((p) => new SetPageMargins(p.id, undefined, { left: 0, right: 80, bottom: 0 }))));
		expect(doc.pages.map((p) => p.width)).toEqual([680, 680]);
		history.undo();
		expect(doc.pages.map((p) => p.width)).toEqual([600, 600]);
	});

	it("duplicatePage copies the margins", () => {
		const { page } = pdfDoc();
		page.margins = { left: 1, right: 2, bottom: 3 };
		const copy = duplicatePage(page);
		expect(copy.margins).toEqual(page.margins);
		expect(copy.margins).not.toBe(page.margins);
	});
});

describe("SetPageSize on a page with margins (infinite growth)", () => {
	it("grows below the PDF instead of stretching it, and undo restores the margins", () => {
		const { doc, page } = pdfDoc();
		page.margins = { left: 0, right: 100, bottom: 0 };
		page.width = 700;
		const box = backgroundRect(page);
		const history = new History(() => doc);
		history.execute(new SetPageSize(page.id, { width: 700, height: 400 }, { width: 700, height: 650 }));
		expect(backgroundRect(page)).toEqual(box);
		expect(page.margins).toEqual({ left: 0, right: 100, bottom: 250 });
		history.undo();
		expect(page.height).toBe(400);
		expect(page.margins).toEqual({ left: 0, right: 100, bottom: 0 });
	});

	it("leaves pages without margins as before", () => {
		const { doc, page } = pdfDoc();
		new SetPageSize(page.id, { width: 600, height: 400 }, { width: 600, height: 500 }).apply(doc);
		expect(page.margins).toBeUndefined();
		expect(backgroundRect(page)).toEqual({ x: 0, y: 0, width: 600, height: 500 });
	});
});

describe("SetPageBackground", () => {
	it("switches background and size, keeps ink and margins; undo restores", () => {
		const { doc, page } = pdfDoc();
		page.margins = { left: 10, right: 0, bottom: 0 };
		page.width = 610;
		const stroke = page.strokes[0]!;
		const history = new History(() => doc);
		history.execute(new SetPageBackground(page.id, { kind: "pdf", asset: "ffff", page: 3 }, { width: 510, height: 300 }));
		expect(page.background).toEqual({ kind: "pdf", asset: "ffff", page: 3 });
		expect(page.width).toBe(510);
		expect(page.margins).toEqual({ left: 10, right: 0, bottom: 0 });
		expect(page.strokes[0]).toBe(stroke);
		history.undo();
		expect(page.background).toEqual({ kind: "pdf", asset: ASSET, page: 1 });
		expect(page.width).toBe(610);
		expect(page.height).toBe(400);
	});
});
