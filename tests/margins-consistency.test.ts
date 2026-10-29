/**
 * v6 page margins kept consistent across page restore, conflicted-copy merge, repair and the space
 * tool: a page that loses its margins would show its PDF stretched and its ink out of place.
 */
import { describe, expect, it } from "vitest";
import { planSpaceChange } from "../src/ink/space";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { History, SetPageMargins } from "../src/model/history";
import { backgroundRect, translateStroke } from "../src/model/margins";
import { mergeChangeCount, mergeCovers, planMerge, strokeContentKey } from "../src/model/merge";
import { pageContentCommand } from "../src/model/page-content";
import { planPageRestore } from "../src/model/page-restore";
import { repairNotebookText } from "../src/model/repair";
import { freezeStroke, parse, serialize, serializeChecked } from "../src/model/serialize";
import type { NotebookDocument, Page, TextElement } from "../src/model/types";
import { combineCandidates } from "../src/storage/recovery";
import { line } from "./helpers";

const ASSET = "abcdef0123456789abcdef01";
const MARGINS = { left: 80, right: 40, bottom: 60 };

function clone(doc: NotebookDocument): NotebookDocument {
	const r = parse(serialize(doc));
	if (!r.ok) throw new Error(r.message);
	return r.doc;
}

/** Two pages; the second shows a PDF page (600 × 400) with one stroke and one text box. */
function pdfDoc(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.assets = { [ASSET]: { id: ASSET, kind: "pdf", path: "N/_assets/x.pdf", name: "slides.pdf", bytes: 10 } };
	doc.pages[0]!.strokes.push(line(10, 10, 100, 10));
	const page = createPage({ width: 600, height: 400 });
	page.background = { kind: "pdf", asset: ASSET, page: 1 };
	page.strokes.push(freezeStroke(createStroke("#112233", 2, [[10, 20, 0.5], [30.25, 40, 0.5]])));
	const text: TextElement = { id: "t1", type: "text", x: 50, y: 60, width: 100, text: "note", fontSize: 12, color: "#000000" };
	page.elements = [Object.freeze(text)];
	doc.pages.push(page);
	return doc;
}

/** The PDF page of `doc` with margins added through the regular command (content shifted by the left margin). */
function withMargins(doc: NotebookDocument, margins = MARGINS): NotebookDocument {
	const out = clone(doc);
	new SetPageMargins(out.pages[1]!.id, undefined, margins).apply(out);
	return clone(out);
}

function merged(main: NotebookDocument, other: NotebookDocument): NotebookDocument {
	const out = clone(main);
	planMerge(out, other).command?.apply(out);
	const checked = serializeChecked(out, true);
	if (!checked.ok) throw new Error(checked.message);
	return clone(out);
}

const keys = (p: Page) => p.strokes.map((s) => strokeContentKey(s)).sort();

describe("page restore keeps v6 margins", () => {
	it("replace: the restored page has the margins of the version it comes from", () => {
		const old = withMargins(pdfDoc());
		const doc = clone(pdfDoc());
		const history = new History(() => doc);
		const before = serialize(doc);
		history.execute(planPageRestore(doc, old, 1, 1, "replace")!.command);
		const page = doc.pages[1]!;
		expect(page.margins).toEqual(MARGINS);
		expect(page.width).toBe(old.pages[1]!.width);
		expect(backgroundRect(page)).toEqual(backgroundRect(old.pages[1]!));
		expect(keys(page)).toEqual(keys(old.pages[1]!));
		expect(page.margins).not.toBe(old.pages[1]!.margins);
		expect(serializeChecked(doc, true).ok).toBe(true);
		history.undo();
		expect(serialize(doc)).toBe(before);
	});

	it("replace: a page without margins replacing one with margins has none", () => {
		const old = pdfDoc();
		const doc = withMargins(pdfDoc());
		planPageRestore(doc, old, 1, 1, "replace")!.command.apply(doc);
		expect(doc.pages[1]!.margins).toBeUndefined();
		expect(backgroundRect(doc.pages[1]!)).toEqual({ x: 0, y: 0, width: 600, height: 400 });
	});
});

describe("merge of a conflicted copy with v6 margins", () => {
	it("a page only in the copy keeps its margins, and coverage checks them", () => {
		const main = pdfDoc();
		main.pages.splice(1, 1);
		const other = withMargins(pdfDoc());
		const m = merged(main, other);
		const page = m.pages.find((p) => p.id === other.pages[1]!.id)!;
		expect(page.margins).toEqual(MARGINS);
		expect(backgroundRect(page)).toEqual(backgroundRect(other.pages[1]!));
		expect(mergeCovers(m, other)).toBe(true);
		// The same result with the margins lost is not a cover: its ink no longer lines up with the PDF.
		const lost = clone(m);
		const p = lost.pages.find((x) => x.id === page.id)!;
		delete p.margins;
		p.width = 600;
		p.height = 400;
		expect(mergeCovers(lost, other)).toBe(false);
	});

	it("margins changed on the other device: the same ink is recognised, not added again shifted", () => {
		const origin = pdfDoc();
		const main = clone(origin);
		const other = withMargins(origin);
		// The other device also drew a new stroke after adding the margins (in its own frame).
		const drawn = line(200, 100, 300, 120);
		other.pages[1]!.strokes.push(drawn);
		const plan = planMerge(clone(main), other);
		expect(plan.summary.identical).toBe(3);
		expect(plan.summary.strokesAdded).toBe(1);
		expect(plan.summary.strokesCopied).toBe(0);
		expect(plan.summary.elementsCopied).toBe(0);
		expect(plan.summary.marginsDiffer).toBe(1);
		expect(plan.summary.pageSettingsDiffer).toBe(1);
		const m = merged(main, other);
		const page = m.pages[1]!;
		// The main notebook's settings are kept; the new stroke lands where it was drawn on the PDF.
		expect(page.margins).toBeUndefined();
		expect(page.strokes).toHaveLength(2);
		expect(strokeContentKey(page.strokes[1]!)).toBe(strokeContentKey(translateStroke(drawn, -MARGINS.left)));
		expect(page.elements).toHaveLength(1);
		expect(mergeCovers(m, other)).toBe(true);
		expect(mergeCovers(m, main)).toBe(true);
		// Idempotent.
		const again = planMerge(clone(m), other);
		expect(again.command).toBeNull();
		expect(mergeChangeCount(again.summary)).toBe(0);
		expect(serialize(merged(m, other))).toBe(serialize(m));
	});

	it("the other way round: main has the margins, the copy has none", () => {
		const origin = pdfDoc();
		const main = withMargins(origin);
		const other = clone(origin);
		const plan = planMerge(clone(main), other);
		expect(plan.command).toBeNull();
		expect(plan.summary.marginsDiffer).toBe(1);
		expect(mergeCovers(main, other)).toBe(true);
	});

	it("different left margins on both sides: content compared by the difference", () => {
		const origin = pdfDoc();
		const main = withMargins(origin, { left: 30, right: 0, bottom: 0 });
		const other = withMargins(origin, { left: 100, right: 10, bottom: 5 });
		const plan = planMerge(clone(main), other);
		expect(plan.command).toBeNull();
		expect(plan.summary.identical).toBe(3);
		expect(mergeCovers(main, other)).toBe(true);
	});

	it("same margins on both sides: nothing is shifted and nothing differs", () => {
		const main = withMargins(pdfDoc());
		const other = clone(main);
		other.pages[1]!.strokes.push(line(200, 100, 300, 120));
		const plan = planMerge(clone(main), other);
		expect(plan.summary.marginsDiffer).toBe(0);
		expect(plan.summary.pageSettingsDiffer).toBe(0);
		const m = merged(main, other);
		expect(keys(m.pages[1]!)).toEqual(keys(other.pages[1]!));
	});

	it("recovery: combining two candidates keeps the margins of a page only the second one has", () => {
		const first = pdfDoc();
		first.pages.splice(1, 1);
		const second = withMargins(pdfDoc());
		const r = combineCandidates(
			{ text: serialize(first), doc: clone(first) } as Parameters<typeof combineCandidates>[0],
			{ text: serialize(second), doc: second } as Parameters<typeof combineCandidates>[1],
		);
		expect(r).not.toBeNull();
		expect(r!.doc.pages.find((p) => p.id === second.pages[1]!.id)!.margins).toEqual(MARGINS);
		expect(mergeCovers(r!.doc, second)).toBe(true);
	});
});

describe("repair of a damaged v6 notebook keeps the margins", () => {
	it("truncated file: the page keeps its margins and they are not counted as unknown", () => {
		const doc = withMargins(pdfDoc());
		const text = serialize(doc);
		// Cut in the middle of the PDF page's stroke (after its page fields, margins included).
		const at = text.indexOf("[110.25");
		expect(at).toBeGreaterThan(text.indexOf('"margins"'));
		const r = repairNotebookText(text.slice(0, at));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const page = r.doc.pages.find((p) => p.id === doc.pages[1]!.id)!;
		expect(page.margins).toEqual(MARGINS);
		expect(page.background).toEqual(doc.pages[1]!.background);
		expect(r.summary.unknownFields).toBe(0);
	});

	it("garbage in the middle: the line scan reads the margins of a page after the damage", () => {
		const doc = withMargins(pdfDoc());
		const text = serialize(doc);
		const lines = text.split("\n");
		// Damage the first page's stroke line, before the PDF page.
		const i = lines.findIndex((l) => l.startsWith("\t\t\t\t{"));
		lines[i] = "\t\t\t\t{\"id\": garbage";
		const r = repairNotebookText(lines.join("\n"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const page = r.doc.pages.find((p) => p.id === doc.pages[1]!.id)!;
		expect(page.margins).toEqual(MARGINS);
		expect(keys(page)).toEqual(keys(doc.pages[1]!));
		expect(r.summary.unknownFields).toBe(0);
	});

	it("invalid margins are reset (counted), the page and its ink are kept", () => {
		const doc = withMargins(pdfDoc());
		const text = serialize(doc).replace('"margins": {"left":80,', '"margins": {"left":-5,');
		expect(text).toContain('"left":-5');
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const page = r.doc.pages.find((p) => p.id === doc.pages[1]!.id)!;
		expect(page.margins).toBeUndefined();
		expect(page.strokes).toHaveLength(1);
		expect(r.summary.fieldsReset).toBeGreaterThan(0);
		expect(r.summary.unknownFields).toBe(0);
	});
});

describe("repair keeps the ink of PDF pages", () => {
	it("strokes of a page with a background are validated against the notebook's assets, not lost", () => {
		const doc = pdfDoc();
		const text = serialize(doc).replace('"version": 6', '"version": "x"');
		const r = repairNotebookText(text);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.strokes.lost).toBe(0);
		expect(keys(r.doc.pages[1]!)).toEqual(keys(doc.pages[1]!));
		expect(r.doc.pages[1]!.background).toEqual(doc.pages[1]!.background);
	});
});

describe("space tool on an infinite page with margins", () => {
	function infinitePdf(): { doc: NotebookDocument; page: Page } {
		const doc = withMargins(pdfDoc(), { left: 0, right: 0, bottom: 100 });
		const page = doc.pages[1]!;
		page.infinite = true;
		page.strokes.push(line(20, 450, 200, 460));
		doc.pages.splice(0, 1);
		return { doc, page };
	}

	it("grows into the bottom margin: the PDF keeps its box, undo restores margins and size exactly", () => {
		const { doc, page } = infinitePdf();
		const box = backgroundRect(page);
		const before = serialize(doc);
		const margins = page.margins;
		const plan = planSpaceChange(doc.pages, 0, 300, 200)!;
		expect(plan.changes[0]!.height).toBeGreaterThan(page.height);
		const history = new History(() => doc);
		history.execute(pageContentCommand(doc, plan, "Insert space"));
		expect(page.height).toBe(plan.changes[0]!.height);
		expect(backgroundRect(page)).toEqual(box);
		expect(page.margins).toEqual({ left: 0, right: 0, bottom: page.height - box.height });
		expect(serializeChecked(doc, true).ok).toBe(true);
		history.undo();
		expect(serialize(doc)).toBe(before);
		expect(page.margins).toBe(margins);
		history.redo();
		expect(backgroundRect(page)).toEqual(box);
	});

	it("pages without margins grow as before", () => {
		const doc = pdfDoc();
		doc.pages.splice(0, 1);
		const page = doc.pages[0]!;
		page.infinite = true;
		page.strokes.push(line(20, 350, 200, 360));
		const plan = planSpaceChange(doc.pages, 0, 300, 200)!;
		new History(() => doc).execute(pageContentCommand(doc, plan, "Insert space"));
		expect(page.margins).toBeUndefined();
		expect(page.height).toBe(plan.changes[0]!.height);
	});
});
