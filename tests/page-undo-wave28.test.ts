// 0.28 integration: every History command class the wave adds is classified for per-page undo the way it was decided on purpose.
// (pdfrotate SetPdfView, linehandle "Move line", tables "Insert table" / "Edit table", bucket "Fill area", livelecture bookmark SetMeta,
// geosuggest selection highlight AddElement; boxnum writes a note outside the document and has no History command.)
import { describe, expect, it } from "vitest";
import { UpdateItems } from "../src/model/groups";
import { SetPageComments } from "../src/model/comments";
import { createDocument, createPage } from "../src/model/document";
import { AddElement, AddStroke, Batch, History, ReplaceElement, SetMeta, type Command } from "../src/model/history";
import { SetViews } from "../src/model/views";
import { pageRules, pageScope } from "../src/model/page-undo";
import { SetPdfView } from "../src/model/pdf-view-command";
import { transformStroke } from "../src/ink/lasso";
import { IDENTITY, translate } from "../src/ink/transform";
import { bucketStroke } from "../src/ink/paint-bucket";
import { gridAt, insertRow, tableOfSelection } from "../src/ink/table";
import { editTableCommand, insertTableCommand } from "../src/ink/table-edit";
import type { AreaElement, NotebookDocument, Page, PageComment, PageElement } from "../src/model/types";
import { line } from "./helpers";

const NOW = new Date("2026-10-29T10:00:00.000Z");
const spec = { rows: 3, cols: 4, cellW: 50, cellH: 30 };
const style = { color: "#1e1e1e", width: 1.5 };

function setup(): { doc: NotebookDocument; history: History; a: Page; b: Page } {
	const doc = createDocument(NOW);
	doc.pages.push(createPage());
	const history = new History(() => doc, 100, null, null, null, null);
	history.setPageRules(pageRules);
	history.setPagewise(true);
	return { doc, history, a: doc.pages[0]!, b: doc.pages[1]! };
}

const plan = (page: Page): ConstructorParameters<typeof SetPdfView>[1] => ({
	background: { kind: "pdf", asset: "pdf1", page: 1, rotate: 90 }, width: page.width, height: page.height, margins: undefined, matrix: IDENTITY,
});

function expectLocal(cmd: Command, pageId: string): void {
	const scope = pageScope(cmd);
	expect(scope.local).toBe(true);
	expect(scope.all).toBe(false);
	expect([...scope.pages]).toEqual([pageId]);
	expect(scope.registers).toEqual([]);
}

describe("per-page undo scopes of the 0.28 commands", () => {
	it("pdfrotate: SetPdfView changes the geometry of its page, so it is global (it names its page, blocks no other)", () => {
		const { a } = setup();
		for (const kind of ["rotate", "crop"] as const) {
			const scope = pageScope(new SetPdfView(a.id, plan(a), kind));
			expect(scope.local).toBe(false);
			expect(scope.all).toBe(false);
			expect([...scope.pages]).toEqual([a.id]);
			expect(scope.registers).toEqual([]);
		}
	});

	it("pdfrotate: the all-pages form (one SetPdfView per page, in a Batch) is a global, multi-page step", () => {
		const { a, b } = setup();
		const scope = pageScope(new Batch("PDF page rotated", [new SetPdfView(a.id, plan(a)), new SetPdfView(b.id, plan(b))]));
		expect(scope.local).toBe(false);
		expect(scope.all).toBe(false);
		expect([...scope.pages].sort()).toEqual([a.id, b.id].sort());
	});

	it("pdfrotate: the step with followers (excerpts on another page, saved views) is global and names every page it touches", () => {
		const { doc, a, b } = setup();
		const excerpt = { id: "ex1", type: "excerpt" } as unknown as PageElement;
		const scope = pageScope(new Batch("PDF page rotated", [
			new ReplaceElement(b.id, excerpt, { ...excerpt }), new SetPdfView(a.id, plan(a)), new SetViews(doc.views ?? [], doc.views ?? []),
		]));
		expect(scope.local).toBe(false);
		expect([...scope.pages].sort()).toEqual([a.id, b.id].sort());
	});

	it("linehandle: a Move line batch (items and comments) is local to its page", () => {
		const { a } = setup();
		const comments: PageComment[] = [];
		const items = new UpdateItems(a.id, new Set(["s1"]), (item) => item, "Move line");
		expectLocal(items, a.id);
		expectLocal(new Batch("Move line", [items, new SetPageComments(a.id, undefined, comments, "Move line")]), a.id);
	});

	it("tables: Insert table and Edit table batches are local to their page", () => {
		const { a } = setup();
		const grid = gridAt(spec, 300, 400, { width: a.width, height: a.height });
		const made = insertTableCommand(a, grid, style);
		expectLocal(made.cmd, a.id);
		a.strokes.push(...made.strokes);
		const table = tableOfSelection(a.strokes, 0);
		expect(table).not.toBeNull();
		const edited = editTableCommand(a, table!, insertRow(table!.grid, 0)!, a.strokes);
		expect(edited).not.toBeNull();
		expectLocal(edited!.cmd, a.id);
	});

	it("bucket: Fill area is local to its page", () => {
		const { a } = setup();
		const fill = bucketStroke([[0, 0, 0.5], [40, 0, 0.5], [40, 40, 0.5], [0, 40, 0.5]], "#ffcc00", false, undefined, "fill1");
		expectLocal(new Batch("Fill area", [new AddStroke(a.id, fill, 0)]), a.id);
	});

	it("livelecture: a bookmark (SetMeta) stays a step of the whole notebook", () => {
		const { doc } = setup();
		const scope = pageScope(new SetMeta(doc.meta!, { ...doc.meta!, bookmarks: [doc.pages[0]!.id] }));
		expect(scope.local).toBe(false);
		expect(scope.pages.size).toBe(0);
	});

	it("geosuggest: the selection highlight (AddElement of an area) is local to its page", () => {
		const { a } = setup();
		const area: AreaElement = { id: "area1", type: "area", x: 0, y: 0, width: 50, height: 20, color: "#ffeb3b" };
		expectLocal(new AddElement(a.id, area, 0), a.id);
	});
});

describe("taper and opacity survive the 0.28 edits", () => {
	it("a table edit keeps the opacity of its lines; a table of the shape tool never carries a taper", () => {
		const { a } = setup();
		const grid = gridAt(spec, 300, 400, { width: a.width, height: a.height });
		const made = insertTableCommand(a, grid, { ...style, opacity: 0.5 });
		expect(made.strokes.every((s) => s.opacity === 0.5 && s.taperStart === undefined && s.taperEnd === undefined)).toBe(true);
		a.strokes.push(...made.strokes);
		const table = tableOfSelection(a.strokes, 0);
		expect(table?.style.opacity).toBe(0.5);
		const edited = editTableCommand(a, table!, insertRow(table!.grid, 0)!, a.strokes)!;
		expect(edited.strokes.length).toBeGreaterThan(made.strokes.length);
		expect(edited.strokes.every((s) => s.opacity === 0.5 && s.taperStart === undefined)).toBe(true);
	});

	it("a table without opacity stays without it", () => {
		const { a } = setup();
		const made = insertTableCommand(a, gridAt(spec, 300, 400, { width: a.width, height: a.height }), style);
		a.strokes.push(...made.strokes);
		const table = tableOfSelection(a.strokes, 0)!;
		expect(table.style.opacity).toBeUndefined();
		expect(editTableCommand(a, table, insertRow(table.grid, 0)!, a.strokes)!.strokes.some((s) => "opacity" in s)).toBe(false);
	});

	it("a bucket fill has the pen's opacity and no taper", () => {
		const fill = bucketStroke([[0, 0, 0.5], [40, 0, 0.5], [40, 40, 0.5]], "#ffcc00", true, 0.6, "fill1");
		expect(fill.opacity).toBe(0.6);
		expect("taperStart" in fill || "taperEnd" in fill).toBe(false);
	});

	it("a line move (a rigid translation) keeps taper, opacity and pressure", () => {
		const s = { ...line(0, 0, 50, 0), opacity: 0.7, taperStart: 0.4, taperEnd: 0.2 };
		const moved = transformStroke(s, translate(0, 30));
		expect(moved).toMatchObject({ id: s.id, opacity: 0.7, taperStart: 0.4, taperEnd: 0.2, width: s.width });
		expect(moved.points.map((p) => p[2])).toEqual(s.points.map((p) => p[2]));
	});
});

describe("per-page undo on the 0.28 commands", () => {
	it("a PDF rotation is not undone from its page (global): the plain Undo takes it back, another page is untouched", () => {
		const { history, a, b } = setup();
		expect(history.execute(new AddStroke(a.id, line(0, 0, 50, 0), 0))).toBe(true);
		expect(history.execute(new SetPdfView(a.id, plan(a)))).toBe(true);
		expect(a.background).toEqual({ kind: "pdf", asset: "pdf1", page: 1, rotate: 90 });
		expect(history.execute(new AddStroke(b.id, line(0, 0, 50, 0), 0))).toBe(true);
		// page b still undoes its own stroke
		expect(history.undoOnPage(b.id).kind).toBe("done");
		expect(b.strokes).toHaveLength(0);
		// page a: its newest step is the rotation, which is global
		expect(history.undoOnPage(a.id).kind).toBe("global");
		expect(a.background).toEqual({ kind: "pdf", asset: "pdf1", page: 1, rotate: 90 });
		expect(a.strokes).toHaveLength(1);
		expect(history.undo()).not.toBeNull();
		expect(a.background).toBeUndefined();
		expect(history.undoOnPage(a.id).kind).toBe("done");
		expect(a.strokes).toHaveLength(0);
	});

	it("a bookmark is never undone from a page (it needs the plain history) and does not block the page's own steps", () => {
		const { doc, history, a } = setup();
		expect(history.execute(new AddStroke(a.id, line(0, 0, 50, 0), 0))).toBe(true);
		expect(history.execute(new SetMeta(doc.meta!, { ...doc.meta!, bookmarks: [a.id] }))).toBe(true);
		expect(history.undoOnPage(a.id).kind).toBe("done");
		expect(a.strokes).toHaveLength(0);
		expect(doc.meta!.bookmarks).toEqual([a.id]);
		expect(history.undoOnPage(a.id).kind).toBe("nothing");
		expect(doc.meta!.bookmarks).toEqual([a.id]);
	});
});
