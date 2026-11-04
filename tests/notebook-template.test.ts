import { describe, expect, it } from "vitest";
import { createDocument, createPage } from "../src/model/document";
import { expandPlaceholders, notebookFromTemplate, templateFromNotebook } from "../src/model/notebook-template";
import { addState, makePart, withPose } from "../src/model/states";
import { parse, serializeChecked, freezeElement } from "../src/model/serialize";
import { isHiddenNotebookPath, notebookTemplatesFolderPath } from "../src/storage/trash-paths";
import type { Asset, NotebookDocument } from "../src/model/types";
import { line } from "./helpers";

const NOW = new Date(2026, 10, 4, 9, 5);

/** A two-page planner: ink, a text box with {{date}}, an image, a PDF background, slide-linked ink, bookmarks and tags. */
function planner(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	const p1 = doc.pages[0]!;
	const p2 = createPage();
	doc.pages.push(p2);
	p1.strokes.push(line(10, 10, 100, 10), line(10, 20, 100, 20));
	p1.elements = [
		freezeElement({ id: "t1", type: "text", x: 20, y: 30, width: 200, text: "Week of {{date}}", fontSize: 16, color: "#000000" }),
		freezeElement({ id: "i1", type: "image", asset: "aaaa01", x: 0, y: 0, width: 50, height: 50, rotation: 0 }),
	];
	p2.background = { kind: "pdf", asset: "bbbb02", page: 3 };
	p2.strokes.push({ ...line(5, 5, 50, 50), slide: "sl000001" });
	const asset = (id: string, kind: Asset["kind"]): Asset => ({ id, kind, path: `_assets/${id}.bin`, name: `${id}.bin`, bytes: 1 });
	doc.assets = { aaaa01: asset("aaaa01", "image"), bbbb02: asset("bbbb02", "pdf"), cccc03: asset("cccc03", "image") };
	doc.slides = [{ id: "sl000001", source: "bbbb02", page: 3 }, { id: "sl000002", source: "bbbb02", page: 9 }];
	doc.meta = { tags: ["x"], favorite: true, cover: "#aa3300", bookmarks: [p1.id], description: "My planner", coverArt: { kind: "art", style: "waves", seed: "s" } };
	return doc;
}

function allIds(doc: NotebookDocument): string[] {
	return [doc.id, ...doc.pages.flatMap((p) => [p.id, ...p.strokes.map((s) => s.id), ...(p.elements ?? []).map((e) => e.id)])];
}

describe("expandPlaceholders", () => {
	it("fills date, time, year, month and day; leaves the rest", () => {
		expect(expandPlaceholders("Lab {{date}}", NOW)).toBe("Lab 2026-11-04");
		expect(expandPlaceholders("{{ Time }} {{year}}/{{month}}/{{day}} {{other}}", NOW)).toBe("09:05 2026/11/04 {{other}}");
		expect(expandPlaceholders("plain", NOW)).toBe("plain");
	});
});

describe("templateFromNotebook", () => {
	it("renews every id and keeps the content, assets in use and slide links", () => {
		const src = planner();
		const tpl = templateFromNotebook(src, NOW);
		const before = new Set(allIds(src));
		for (const id of allIds(tpl)) expect(before.has(id)).toBe(false);
		expect(tpl.pages).toHaveLength(2);
		expect(tpl.pages[0]!.strokes).toHaveLength(2);
		expect(Object.keys(tpl.assets ?? {}).sort()).toEqual(["aaaa01", "bbbb02"]);
		expect(tpl.slides).toEqual([{ id: "sl000001", source: "bbbb02", page: 3 }]);
		expect(tpl.pages[1]!.strokes[0]!.slide).toBe("sl000001");
		expect(tpl.pages[1]!.background).toEqual({ kind: "pdf", asset: "bbbb02", page: 3 });
	});

	it("does not copy bookmarks, tags or favourite, but keeps the cover", () => {
		const tpl = templateFromNotebook(planner(), NOW);
		expect(tpl.meta).toMatchObject({ tags: [], favorite: false, bookmarks: [], cover: "#aa3300", description: "My planner", coverArt: { kind: "art", style: "waves", seed: "s" } });
	});

	it("does not touch the source", () => {
		const src = planner();
		const copy = JSON.stringify(src);
		templateFromNotebook(src, NOW);
		expect(JSON.stringify(src)).toBe(copy);
	});

	it("writes a document that reads back", () => {
		const checked = serializeChecked(templateFromNotebook(planner(), NOW), true);
		expect(checked.ok).toBe(true);
		if (checked.ok) expect(parse(checked.text).ok).toBe(true);
	});
});

describe("notebookFromTemplate", () => {
	it("with content: new ids, ink kept, {{date}} filled, slide table carried", () => {
		const tpl = templateFromNotebook(planner(), NOW);
		const doc = notebookFromTemplate(tpl, { content: true, now: NOW });
		const before = new Set(allIds(tpl));
		for (const id of allIds(doc)) expect(before.has(id)).toBe(false);
		expect(doc.pages[0]!.strokes).toHaveLength(2);
		const text = doc.pages[0]!.elements!.find((e) => e.type === "text");
		expect(text && text.type === "text" ? text.text : "").toBe("Week of 2026-11-04");
		expect(doc.slides).toEqual([{ id: "sl000001", source: "bbbb02", page: 3 }]);
		expect(Object.keys(doc.assets ?? {}).sort()).toEqual(["aaaa01", "bbbb02"]);
		{ const r = serializeChecked(doc); expect(r.ok ? "" : r.message).toBe(""); }
	});

	it("pages only: no ink or elements, paper and PDF background stay, only the background asset comes along", () => {
		const tpl = templateFromNotebook(planner(), NOW);
		const doc = notebookFromTemplate(tpl, { content: false, now: NOW });
		expect(doc.pages).toHaveLength(2);
		for (const p of doc.pages) {
			expect(p.strokes).toEqual([]);
			expect(p.elements).toBeUndefined();
		}
		expect(doc.pages[1]!.background).toEqual({ kind: "pdf", asset: "bbbb02", page: 3 });
		expect(doc.pages[0]!.paper).toEqual(tpl.pages[0]!.paper);
		expect(Object.keys(doc.assets ?? {})).toEqual(["bbbb02"]);
		expect(doc.slides).toBeUndefined();
		{ const r = serializeChecked(doc); expect(r.ok ? "" : r.message).toBe(""); }
	});

	it("two notebooks from one template never share ids", () => {
		const tpl = templateFromNotebook(planner(), NOW);
		const a = new Set(allIds(notebookFromTemplate(tpl)));
		for (const id of allIds(notebookFromTemplate(tpl))) expect(a.has(id)).toBe(false);
	});

	it("a template without pages still gives one page", () => {
		const tpl = templateFromNotebook(planner(), NOW);
		tpl.pages = [];
		expect(notebookFromTemplate(tpl).pages).toHaveLength(1);
	});
});

describe("notebook templates folder", () => {
	it("defaults to notebooks inside the templates folder, and follows the setting", () => {
		expect(notebookTemplatesFolderPath("", "", "Notebooks")).toBe("Notebooks/_templates/notebooks");
		expect(notebookTemplatesFolderPath("", "T", "Notebooks")).toBe("T/notebooks");
		expect(notebookTemplatesFolderPath(" My/Planners/ ", "T", "Notebooks")).toBe("My/Planners");
	});

	it("is hidden from the library wherever it is", () => {
		expect(isHiddenNotebookPath("Notebooks/_templates/notebooks/Planner.notebook", "Notebooks", "")).toBe(true);
		expect(isHiddenNotebookPath("Notebooks/Planner.notebook", "Notebooks", "")).toBe(false);
		expect(isHiddenNotebookPath("Other/Planners/a.notebook", "Notebooks", "", "Other/Planners")).toBe(true);
		expect(isHiddenNotebookPath("Other/Planners/a.notebook", "Notebooks", "")).toBe(false);
	});
});

describe("templates and drawings with states (v13)", () => {
	/** The planner's first page with its two strokes grouped into a part and a state that moves it. */
	function withStates(): NotebookDocument {
		const doc = planner();
		const page = doc.pages[0]!;
		const part = makePart(undefined, page.strokes, "Block")!;
		const state = addState(part.states, "Pushed")!;
		page.states = withPose(state.states, state.stateId, part.partId, { dx: 40 });
		return doc;
	}

	it("a template of a notebook with states carries them to the new stroke ids", () => {
		const src = withStates();
		const tpl = templateFromNotebook(src, NOW);
		const page = tpl.pages[0]!;
		expect(page.states).toBeDefined();
		const ids = new Set(page.strokes.map((s) => s.id));
		const items = page.states!.parts[0]!.items;
		expect(items).toHaveLength(2);
		for (const id of items) expect(ids.has(id)).toBe(true);
		for (const id of items) expect(src.pages[0]!.strokes.some((s) => s.id === id)).toBe(false);
		expect(page.states!.list[0]!.poses[0]).toMatchObject({ dx: 40 });
		const checked = serializeChecked(tpl, true);
		expect(checked.ok).toBe(true);
		if (checked.ok) {
			const back = parse(checked.text);
			expect(back.ok && back.doc.pages[0]!.states?.parts[0]?.items).toEqual(items);
		}
	});

	it("from a template with content the states follow the strokes again; pages only leaves none behind", () => {
		const tpl = templateFromNotebook(withStates(), NOW);
		const full = notebookFromTemplate(tpl, { content: true, now: NOW });
		const strokeIds = new Set(full.pages[0]!.strokes.map((s) => s.id));
		for (const id of full.pages[0]!.states!.parts[0]!.items) expect(strokeIds.has(id)).toBe(true);
		const empty = notebookFromTemplate(tpl, { content: false, now: NOW });
		expect(empty.pages[0]!.states).toBeUndefined();
		const r = serializeChecked(empty);
		expect(r.ok).toBe(true);
	});
});
