import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { AddPage, DeletePage, History, MovePage, SetPageSize, SetPaper } from "../src/model/history";
import { MIGRATIONS } from "../src/model/migrations";
import { duplicatePage } from "../src/model/pages";
import { parse, serialize, serializeChecked } from "../src/model/serialize";
import {
	CURRENT_VERSION, FORMAT_ID, PAGE_SIZES, PAPER_KINDS, PAPER_SPACING,
	type NotebookDocument, type Paper,
} from "../src/model/types";

const stamp = "2026-10-29T10:00:00.000Z";

function v2Doc(paper: object = { kind: "grid", spacing: 14.17 }) {
	return {
		format: FORMAT_ID, version: 2, id: "doc", createdAt: stamp, modifiedAt: stamp,
		pages: [{
			id: "p", width: 595.28, height: 841.89, paper,
			strokes: [{ id: "s", tool: "highlighter", color: "#ffff00", width: 8, points: [[1, 2, 0.5]] }],
		}],
	};
}

function docWithPages(n: number): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	for (let i = 1; i < n; i++) doc.pages.push(createPage());
	return doc;
}

const ids = (doc: NotebookDocument) => doc.pages.map((p) => p.id);

describe("format v3 migration", () => {
	it("is at version 3 and has a v2 step", () => {
		expect(CURRENT_VERSION).toBe(3);
		expect(MIGRATIONS[2]).toBeTypeOf("function");
	});

	it("migrates v2 to v3 as identity plus version bump", () => {
		const v2 = v2Doc();
		const r = parse(JSON.stringify(v2));
		if (!r.ok) throw new Error(r.message);
		expect(r.migratedFrom).toBe(2);
		expect(r.doc.version).toBe(3);
		expect(r.doc.pages[0]!.paper).toEqual({ kind: "grid", spacing: 14.17 });
		expect(r.doc.pages[0]!.strokes[0]).toEqual(v2.pages[0]!.strokes[0]);
		expect(r.doc.pages[0]!.width).toBe(595.28);
	});

	it("v0 and v1 files still reach v3", () => {
		const v0 = parse(JSON.stringify({ strokes: [{ color: "#000000", size: 2, points: [{ x: 1, y: 2 }] }] }));
		expect(v0.ok && v0.doc.version).toBe(3);
		const v1 = parse(JSON.stringify({ ...v2Doc(), version: 1 }));
		expect(v1.ok && v1.doc.version).toBe(3);
		expect(v1.ok && v1.migratedFrom).toBe(1);
	});
});

describe("paper kinds and page sizes", () => {
	it.each(PAPER_KINDS)("round-trips paper kind %s", (kind) => {
		const doc = createDocument(new Date(stamp), PAGE_SIZES.a4, { kind, spacing: PAPER_SPACING[kind] });
		const text = serialize(doc);
		const r = parse(text);
		if (!r.ok) throw new Error(r.message);
		expect(r.migratedFrom).toBeNull();
		expect(r.doc).toEqual(doc);
		expect(r.doc.pages[0]!.paper.kind).toBe(kind);
		expect(serialize(r.doc)).toBe(text);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("keeps the serialized paper shape", () => {
		const text = serialize(createDocument(new Date(stamp), PAGE_SIZES.a4, { kind: "ruled", spacing: 22.68 }));
		expect(text).toContain('"paper": {"kind":"ruled","spacing":22.68},');
	});

	const sizes: [string, { width: number; height: number }][] = [
		["A5", PAGE_SIZES.a5],
		["Letter", PAGE_SIZES.letter],
		["A4 landscape", { width: PAGE_SIZES.a4.height, height: PAGE_SIZES.a4.width }],
		["Letter landscape", { width: PAGE_SIZES.letter.height, height: PAGE_SIZES.letter.width }],
	];
	it.each(sizes)("round-trips size %s", (_name, size) => {
		const doc = createDocument(new Date(stamp), size, { kind: "dotted", spacing: PAPER_SPACING.dotted });
		const text = serialize(doc);
		const r = parse(text);
		if (!r.ok) throw new Error(r.message);
		expect(r.doc.pages[0]).toMatchObject(size);
		expect(serialize(r.doc)).toBe(text);
	});

	it("createPage() defaults to A4 grid", () => {
		const page = createPage();
		expect(page).toMatchObject({ width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height, paper: { kind: "grid", spacing: PAPER_SPACING.grid } });
	});

	it("createPage copies the paper object", () => {
		const paper: Paper = { kind: "ruled", spacing: 20 };
		const page = createPage(PAGE_SIZES.a5, paper);
		expect(page.paper).toEqual(paper);
		expect(page.paper).not.toBe(paper);
	});

	it("rejects an unknown kind and non-positive or missing spacing", () => {
		const bad: unknown[] = [
			{ kind: "dots", spacing: 10 },
			{ kind: "ruled", spacing: 0 },
			{ kind: "ruled", spacing: -3 },
			{ kind: "blank" },
			{ kind: "millimetre", spacing: "2.8" },
			"grid",
			null,
		];
		for (const paper of bad) {
			const r = parse(JSON.stringify({ ...v2Doc(), version: 3, pages: [{ ...v2Doc().pages[0], paper }] }));
			expect(r.ok, JSON.stringify(paper)).toBe(false);
			if (!r.ok) expect(r.reason).toBe("invalid");
		}
	});
});

describe("duplicatePage", () => {
	function pageWithStrokes() {
		const page = createPage(PAGE_SIZES.letter, { kind: "dotted", spacing: 10 });
		page.strokes.push(createStroke("#ff0000", 3, [[1, 2, 0.5], [3, 4, 0.7]], "highlighter"), createStroke("#00ff00", 1, [[5, 6, 0.1]]));
		return page;
	}

	it("makes new page and stroke ids and keeps the content", () => {
		const page = pageWithStrokes();
		const copy = duplicatePage(page);
		expect(copy.id).not.toBe(page.id);
		expect(copy).toMatchObject({ width: 612, height: 792, paper: { kind: "dotted", spacing: 10 } });
		expect(copy.paper).not.toBe(page.paper);
		expect(copy.strokes).toHaveLength(2);
		copy.strokes.forEach((s, i) => {
			const o = page.strokes[i]!;
			expect(s.id).not.toBe(o.id);
			expect({ ...s, id: "" }).toEqual({ ...o, id: "" });
			expect(s.points).not.toBe(o.points);
			expect(Object.isFrozen(s)).toBe(true);
			expect(Object.isFrozen(s.points)).toBe(true);
			expect(Object.isFrozen(s.points[0])).toBe(true);
		});
	});

	it("an empty page duplicates to an empty page", () => {
		expect(duplicatePage(createPage()).strokes).toEqual([]);
	});

	it("a document with a duplicated page serializes with unique ids", () => {
		const doc = docWithPages(1);
		doc.pages[0]!.strokes.push(createStroke("#112233", 2, [[1, 1, 0.5]]));
		const h = new History(() => doc);
		h.execute(new AddPage(duplicatePage(doc.pages[0]!), 1));
		expect(doc.pages).toHaveLength(2);
		const all = doc.pages.flatMap((p) => [p.id, ...p.strokes.map((s) => s.id)]);
		expect(new Set(all).size).toBe(all.length);
		expect(serializeChecked(doc, true).ok).toBe(true);
		h.undo();
		expect(doc.pages).toHaveLength(1);
		h.redo();
		expect(doc.pages).toHaveLength(2);
		h.redo();
		expect(doc.pages).toHaveLength(2);
	});

	it("AddPage never inserts the same page twice", () => {
		const doc = docWithPages(1);
		const cmd = new AddPage(createPage(), 1);
		cmd.apply(doc);
		cmd.apply(doc);
		expect(doc.pages).toHaveLength(2);
	});
});

describe("DeletePage", () => {
	it("apply / undo / redo restores order and the same page object", () => {
		const doc = docWithPages(3);
		const [a, b, c] = doc.pages;
		const h = new History(() => doc);
		h.execute(new DeletePage(b!, 1));
		expect(doc.pages).toEqual([a, c]);
		h.undo();
		expect(doc.pages[1]).toBe(b);
		expect(ids(doc)).toEqual([a!.id, b!.id, c!.id]);
		h.undo();
		expect(doc.pages).toHaveLength(3);
		h.redo();
		expect(ids(doc)).toEqual([a!.id, c!.id]);
		h.redo();
		expect(doc.pages).toHaveLength(2);
	});

	it("deleting the last page is impossible, and so is its undo", () => {
		const doc = docWithPages(1);
		const page = doc.pages[0]!;
		const h = new History(() => doc);
		h.execute(new DeletePage(page, 0));
		expect(doc.pages).toEqual([page]);
		h.undo();
		expect(doc.pages).toEqual([page]);
		h.redo();
		expect(doc.pages).toEqual([page]);
	});

	it("never ends with zero pages when deleting everything", () => {
		const doc = docWithPages(2);
		const [a, b] = doc.pages;
		const h = new History(() => doc);
		h.execute(new DeletePage(a!, 0));
		h.execute(new DeletePage(b!, 0));
		expect(doc.pages).toEqual([b]);
		h.undo();
		h.undo();
		expect(ids(doc)).toEqual([a!.id, b!.id]);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("does not insert the page twice on repeated revert or apply", () => {
		const doc = docWithPages(2);
		const cmd = new DeletePage(doc.pages[1]!, 1);
		cmd.apply(doc);
		cmd.revert(doc);
		cmd.revert(doc);
		expect(doc.pages).toHaveLength(2);
		cmd.apply(doc);
		cmd.apply(doc);
		expect(doc.pages).toHaveLength(1);
	});
});

describe("MovePage", () => {
	it("moves forward and back with undo/redo", () => {
		const doc = docWithPages(4);
		const original = ids(doc);
		const moved = [original[1], original[2], original[0], original[3]];
		const h = new History(() => doc);
		h.execute(new MovePage(original[0]!, 0, 2));
		expect(ids(doc)).toEqual(moved);
		h.undo();
		expect(ids(doc)).toEqual(original);
		h.undo();
		expect(ids(doc)).toEqual(original);
		h.redo();
		expect(ids(doc)).toEqual(moved);
		h.redo();
		expect(ids(doc)).toEqual(moved);
	});

	it("moves backwards", () => {
		const doc = docWithPages(3);
		const original = ids(doc);
		const cmd = new MovePage(original[2]!, 2, 0);
		cmd.apply(doc);
		expect(ids(doc)).toEqual([original[2], original[0], original[1]]);
		cmd.revert(doc);
		expect(ids(doc)).toEqual(original);
	});

	it("handles the edges: first to last, last to first, same index", () => {
		const doc = docWithPages(3);
		const original = ids(doc);
		const toEnd = new MovePage(original[0]!, 0, 2);
		toEnd.apply(doc);
		expect(ids(doc)).toEqual([original[1], original[2], original[0]]);
		toEnd.revert(doc);
		const toStart = new MovePage(original[2]!, 2, 0);
		toStart.apply(doc);
		expect(ids(doc)[0]).toBe(original[2]);
		toStart.revert(doc);
		expect(ids(doc)).toEqual(original);
		const same = new MovePage(original[1]!, 1, 1);
		same.apply(doc);
		same.revert(doc);
		expect(ids(doc)).toEqual(original);
	});

	it("clamps an out-of-range target and still reverts exactly", () => {
		const doc = docWithPages(3);
		const original = ids(doc);
		const cmd = new MovePage(original[0]!, 0, 99);
		cmd.apply(doc);
		expect(ids(doc)).toEqual([original[1], original[2], original[0]]);
		cmd.revert(doc);
		expect(ids(doc)).toEqual(original);
	});

	it("ignores an unknown page and a repeated revert", () => {
		const doc = docWithPages(2);
		const original = ids(doc);
		const unknown = new MovePage("nope", 0, 1);
		unknown.apply(doc);
		unknown.revert(doc);
		expect(ids(doc)).toEqual(original);
		const cmd = new MovePage(original[0]!, 0, 1);
		cmd.apply(doc);
		cmd.revert(doc);
		cmd.revert(doc);
		expect(ids(doc)).toEqual(original);
	});
});

describe("SetPaper and SetPageSize", () => {
	it("SetPaper restores the exact paper on undo and reapplies on redo", () => {
		const doc = docWithPages(2);
		const page = doc.pages[1]!;
		const before = { ...page.paper };
		const after: Paper = { kind: "millimetre", spacing: PAPER_SPACING.millimetre };
		const h = new History(() => doc);
		h.execute(new SetPaper(page.id, before, after));
		expect(page.paper).toEqual(after);
		expect(doc.pages[0]!.paper).toEqual(before);
		h.undo();
		expect(page.paper).toEqual(before);
		h.undo();
		expect(page.paper).toEqual(before);
		h.redo();
		expect(page.paper).toEqual(after);
		expect(serializeChecked(doc).ok).toBe(true);
	});

	it("SetPaper does not alias the command's paper objects", () => {
		const doc = docWithPages(1);
		const page = doc.pages[0]!;
		const after: Paper = { kind: "ruled", spacing: 22 };
		const cmd = new SetPaper(page.id, { ...page.paper }, after);
		cmd.apply(doc);
		page.paper.spacing = 99;
		expect(after.spacing).toBe(22);
	});

	it("SetPageSize restores the exact size and leaves strokes untouched", () => {
		const doc = docWithPages(1);
		const page = doc.pages[0]!;
		const stroke = createStroke("#000000", 2, [[500, 800, 0.5]]);
		page.strokes.push(stroke);
		const before = { width: page.width, height: page.height };
		const after = { width: PAGE_SIZES.a5.width, height: PAGE_SIZES.a5.height };
		const h = new History(() => doc);
		h.execute(new SetPageSize(page.id, before, after));
		expect(page).toMatchObject(after);
		expect(page.strokes[0]).toBe(stroke);
		expect(stroke.points[0]).toEqual([500, 800, 0.5]);
		h.undo();
		expect(page).toMatchObject(before);
		h.undo();
		expect(page).toMatchObject(before);
		h.redo();
		expect(page).toMatchObject(after);
	});

	it("throws on an unknown page like the other page commands", () => {
		const doc = docWithPages(1);
		expect(() => new SetPaper("nope", { kind: "blank", spacing: 1 }, { kind: "grid", spacing: 1 }).apply(doc)).toThrow();
		expect(() => new SetPageSize("nope", { width: 1, height: 1 }, { width: 2, height: 2 }).apply(doc)).toThrow();
	});
});
