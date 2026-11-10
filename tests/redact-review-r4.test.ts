/**
 * 0.29 round-4 review of the round-3 fixes (FAIL CLOSED, no format change). Z3 solved in the checks: an infinite page grows as in 0.28
 * (`SetPageSize`), and the undo/redo check and the early notice let the growth of an infinite page through (`grownOnly`) while the export
 * still refuses a boxed page whose background no longer matches its boxes. Y4: pre-0.29 boxes adopt a geometry only when their view
 * matches. Y5: Update PDF is checked before the new PDF is stored. Y6: one correct notice on restores and merges. Y7: a batch is judged in
 * order. Y8: a table insert that would push an answer from under a locked tape is refused.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import * as infinite from "../src/ink/infinite";
import notebookViewSrc from "../src/view/notebook-view.ts?raw";
import pdfActionsSrc from "../src/view/pdf-actions.ts?raw";
import reliabilitySrc from "../src/integration/reliability.ts?raw";
import versionDiffSrc from "../src/view/version-diff-dialog.ts?raw";
import { backgroundShifts, redactStepCheck, type StepBoxes } from "../src/ink/redact-step";
import { detectTable, gridAt, insertRow, normaliseSpec } from "../src/ink/table";
import { insertTableCommand, planTableEdit } from "../src/ink/table-edit";
import { createDocument, createStroke, quantizePoint } from "../src/model/document";
import { AddStroke, Batch, History, SetPageBackground, SetPageMargins, SetPageSize } from "../src/model/history";
import { backgroundRect } from "../src/model/margins";
import { planMerge } from "../src/model/merge";
import { adoptGeometry, backgroundGeometry, staleRedactionPages, tagNewBoxes, type RedactBox, type Redactions } from "../src/model/redact";
import { checkContent, freezeStroke } from "../src/model/serialize";
import type { NotebookDocument, Page, Point, Stroke, TapeElement } from "../src/model/types";
import { RedactionUnavailableError, withRedaction } from "../src/view/export-redact";
import { republishRefused } from "../src/view/pdf-actions";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { line } from "./helpers";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const SCAN = "b".repeat(24);
const PDF = { kind: "pdf" as const, asset: SCAN, page: 3 };
const BOX = { x: 150, y: 100, width: 120, height: 20 };

/** An A4 PDF page (infinite when asked). */
function scanDoc(inf = true): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(NOW);
	doc.assets = { [SCAN]: { id: SCAN, kind: "pdf", path: `Notebooks/_assets/${SCAN}.pdf`, name: "Statement.pdf", bytes: 10 } };
	const page = doc.pages[0]!;
	page.id = "p1";
	page.background = { ...PDF };
	if (inf) page.infinite = true;
	return { doc, page };
}

const drawnOn = (page: Page, box: RedactBox = BOX): Redactions => tagNewBoxes({ [page.id]: [box] }, undefined, [page]);

function rig(doc: NotebookDocument, unreadable = false) {
	const history = new History(() => doc, 100, checkContent);
	const boxes: Record<string, RedactBox[]> = {};
	const read = (): StepBoxes => ({ boxesOf: (id) => boxes[id] ?? [], unreadable, any: Object.values(boxes).some((l) => l.length > 0) });
	const refused: Array<"undo" | "redo"> = [];
	history.setStepCheck(redactStepCheck(read, (step) => refused.push(step)), () => undefined);
	return { history, boxes, refused };
}

/** Writing near the bottom of an infinite page, as `addStrokes` commits it (0.28: the stroke and a `SetPageSize` in one step). */
function writeLow(page: Page, id = "low"): Batch {
	const s = freezeStroke({ ...line(100, page.height - 20, 300, page.height - 20), id });
	const height = infinite.growForInfinite(page, { maxY: page.height - 20 })!;
	expect(height).toBeGreaterThan(page.height);
	return new Batch("Draw", [new AddStroke(page.id, s, page.strokes.length), new SetPageSize(page.id, { width: page.width, height: page.height }, { width: page.width, height })]);
}

describe("Z3 reverted: an infinite page grows as in 0.28", () => {
	it("no bottom-margin growth is left; the view grows by the page size", () => {
		expect("growCommand" in infinite).toBe(false);
		expect(notebookViewSrc).not.toContain("growCommand");
		expect(notebookViewSrc).toContain("commands.push(new SetPageSize(page.id, { width: page.width, height: page.height }, { width: page.width, height }));");
	});

	it("growth on a page without boxes: the background is stretched with the page, no margins, Undo puts it back", () => {
		const { doc, page } = scanDoc();
		const { history, refused } = rig(doc);
		const h = page.height;
		expect(history.execute(writeLow(page))).toBe(true);
		expect(page.margins).toBeUndefined();
		expect(page.height).toBeGreaterThan(h);
		expect(backgroundRect(page)).toEqual({ x: 0, y: 0, width: page.width, height: page.height });
		expect(history.undo()).not.toBeNull();
		expect(page.height).toBe(h);
		expect(refused).toEqual([]);
	});
});

describe("Z3: the Undo of writing on an infinite boxed PDF page is allowed; the export decides", () => {
	it("boxes drawn before the growth: export refused after it, Undo allowed and the export is fine again, Redo allowed", () => {
		const { doc, page } = scanDoc();
		const { history, boxes, refused } = rig(doc);
		const redact = drawnOn(page);
		boxes[page.id] = redact[page.id]!;
		expect(history.execute(writeLow(page))).toBe(true);
		expect(staleRedactionPages([page], redact)).toEqual([page.id]);
		expect(() => withRedaction([page], { redact })).toThrow(RedactionUnavailableError);
		expect(history.undo()).not.toBeNull();
		expect(refused).toEqual([]);
		expect(staleRedactionPages([page], redact)).toEqual([]);
		expect(history.redo()).not.toBeNull();
		expect(refused).toEqual([]);
		expect(staleRedactionPages([page], redact)).toEqual([page.id]);
	});

	it("boxes drawn on the grown page: Undo allowed, and the export afterwards is refused (the geometry changed)", () => {
		const { doc, page } = scanDoc();
		const { history, boxes, refused } = rig(doc);
		expect(history.execute(writeLow(page))).toBe(true);
		const redact = drawnOn(page);
		boxes[page.id] = redact[page.id]!;
		expect(history.undo()).not.toBeNull();
		expect(refused).toEqual([]);
		expect(staleRedactionPages([page], redact)).toEqual([page.id]);
		expect(() => withRedaction([page], { redact })).toThrow(RedactionUnavailableError);
	});

	it("still refused: a box that does not know its geometry, unreadable boxes, and a finite page stretched", () => {
		const legacy = scanDoc();
		const a = rig(legacy.doc);
		expect(a.history.execute(writeLow(legacy.page))).toBe(true);
		a.boxes[legacy.page.id] = [BOX];
		expect(a.history.undo()).toBeNull();
		expect(a.refused).toEqual(["undo"]);

		const locked = scanDoc();
		const b = rig(locked.doc, true);
		expect(b.history.execute(writeLow(locked.page))).toBe(true);
		expect(b.history.undo()).toBeNull();
		expect(b.refused).toEqual(["undo"]);

		const finite = scanDoc(false);
		const c = rig(finite.doc);
		const size = { width: finite.page.width, height: finite.page.height };
		expect(c.history.execute(new SetPageSize(finite.page.id, size, { width: size.width, height: size.height + 300 }))).toBe(true);
		c.boxes[finite.page.id] = drawnOn(finite.page)[finite.page.id]!;
		expect(c.history.undo()).toBeNull();
		expect(c.refused).toEqual(["undo"]);
	});

	it("another slide or a wider page on an infinite page is not growth", () => {
		const { doc, page } = scanDoc();
		const size = { width: page.width, height: page.height };
		expect(backgroundShifts(doc, new SetPageSize(page.id, size, { width: size.width, height: size.height + 400 }))).toEqual([]);
		expect(backgroundShifts(doc, new SetPageSize(page.id, size, { width: size.width + 50, height: size.height + 400 }))).toEqual([page.id]);
		expect(backgroundShifts(doc, new SetPageBackground(page.id, { ...PDF, page: 4 }, { width: size.width, height: size.height + 400 }))).toEqual([page.id]);
		// A finite page stretched downwards is still named.
		const finite = scanDoc(false);
		expect(backgroundShifts(finite.doc, new SetPageSize(finite.page.id, size, { width: size.width, height: size.height + 400 }))).toEqual([finite.page.id]);
	});

	it("Y1: a merge of a longer copy into an infinite boxed page is not refused, and its Undo is allowed", () => {
		const { doc, page } = scanDoc();
		const copy = JSON.parse(JSON.stringify(doc)) as NotebookDocument;
		const other = copy.pages[0]!;
		other.height = page.height + 600;
		other.strokes = [freezeStroke({ ...line(100, page.height + 200, 300, page.height + 200), id: "below" })];
		const plan = planMerge(doc, copy);
		expect(plan.command).toBeTruthy();
		expect(backgroundShifts(doc, plan.command!)).toEqual([]);
		const { history, boxes, refused } = rig(doc);
		boxes[page.id] = drawnOn(page)[page.id]!;
		const h = page.height;
		expect(history.execute(plan.command!)).toBe(true);
		expect(page.height).toBeGreaterThan(h);
		expect(staleRedactionPages([page], { [page.id]: boxes[page.id]! })).toEqual([page.id]);
		expect(history.undo()).not.toBeNull();
		expect(refused).toEqual([]);
	});
});

describe("Y7: a batch is judged in order", () => {
	it("a right margin and then a taller page keep the background where it is (no false refusal)", () => {
		const { doc, page } = scanDoc(false);
		const w = page.width;
		const h = page.height;
		const cmd = new Batch("Merge", [
			new SetPageMargins(page.id, undefined, { left: 0, right: 40, bottom: 0 }),
			new SetPageSize(page.id, { width: w + 40, height: h }, { width: w + 40, height: h + 100 }),
		]);
		expect(backgroundShifts(doc, cmd)).toEqual([]);
		// And it does what the check says: the background is where it was.
		const geo = backgroundGeometry(page);
		cmd.apply(doc);
		expect(backgroundGeometry(page)).toBe(geo);
	});

	it("margins removed and then a taller page stretch the background (named, where the old walk missed it)", () => {
		const { doc, page } = scanDoc(false);
		page.margins = { left: 0, right: 40, bottom: 0 };
		page.width += 40;
		const w = page.width;
		const h = page.height;
		const cmd = new Batch("Edit", [
			new SetPageMargins(page.id, { left: 0, right: 40, bottom: 0 }, undefined),
			new SetPageSize(page.id, { width: w - 40, height: h }, { width: w - 40, height: h + 100 }),
		]);
		expect(backgroundShifts(doc, cmd)).toEqual([page.id]);
		const geo = backgroundGeometry(page);
		cmd.apply(doc);
		expect(backgroundGeometry(page)).not.toBe(geo);
	});

	it("leaves the document untouched", () => {
		const { doc, page } = scanDoc(false);
		const before = JSON.stringify(doc);
		backgroundShifts(doc, new Batch("x", [new SetPageMargins(page.id, undefined, { left: 30, right: 0, bottom: 0 }), new SetPageSize(page.id, { width: 1, height: 1 }, { width: 300, height: 300 })]));
		expect(JSON.stringify(doc)).toBe(before);
	});
});

describe("Y4: boxes from before 0.29 adopt a geometry only when their view matches", () => {
	it("a turned page: not adopted (stale by its view); an unturned page: adopted as it is now (0.28-level until re-confirmed)", () => {
		const { page } = scanDoc(false);
		const legacy: Redactions = { p1: [BOX] };
		const turned = { ...page, background: { ...PDF, rotate: 90 as const } };
		expect(adoptGeometry(legacy, [turned])).toBe(legacy);
		expect(staleRedactionPages([turned], legacy)).toEqual(["p1"]);
		// Documented limit: a slide switched before the first 0.29 open is not seen (the 0.28 view has no asset or page).
		const switched = { ...page, background: { ...PDF, page: 7 } };
		expect(adoptGeometry(legacy, [switched]).p1).toEqual([{ ...BOX, geo: backgroundGeometry(switched) }]);
	});
});

describe("Y5: Update PDF is checked before the new PDF is stored", () => {
	it("the check comes before storeAsset in the flow", () => {
		const start = pdfActionsSrc.indexOf("export async function updatePdfFromNewVersion");
		const check = pdfActionsSrc.indexOf("republishRefused(host, draft.command)", start);
		const store = pdfActionsSrc.indexOf("await storeAsset(", start);
		expect(start).toBeGreaterThan(0);
		expect(check).toBeGreaterThan(start);
		expect(store).toBeGreaterThan(check);
	});

	it("refuses a slide switch on a boxed page, and asks the view when it can", () => {
		const { doc, page } = scanDoc(false);
		const sw = new SetPageBackground(page.id, { ...PDF, page: 9 }, { width: page.width, height: page.height });
		expect(republishRefused({ doc, hasRedaction: () => true }, sw)).toBe(true);
		expect(republishRefused({ doc, hasRedaction: () => false }, sw)).toBe(false);
		const asked: unknown[] = [];
		expect(republishRefused({ doc, hasRedaction: () => false, redactRefused: (c) => (asked.push(c), true) }, sw)).toBe(true);
		expect(asked).toEqual([sw]);
	});
});

describe("Y6: one correct notice on restores and merges", () => {
	it("the restores ask for the reason first and stop there; the merge names unreadable boxes", () => {
		for (const src of [reliabilitySrc, versionDiffSrc]) {
			const ask = src.indexOf("redactRefusal?.(");
			expect(ask).toBeGreaterThan(0);
			expect(src).toContain("t(why === \"unreadable\" ? \"redactmove.unreadable\" : \"redactmove.background\")");
		}
		expect(reliabilitySrc).toContain("\"merge.redactUnreadable\"");
		expect(notebookViewSrc).toContain("redactRefusal(cmd: Command): \"boxes\" | \"unreadable\" | null");
		for (const key of ["merge.redactUnreadable", "redactmove.unreadable", "table.noTapeLocked"] as const) {
			expect(en[key].length).toBeGreaterThan(20);
			expect(itMessages[key]?.length ?? 0).toBeGreaterThan(20);
		}
	});
});

describe("Y8: a table insert never pushes an answer from under a locked tape", () => {
	const style = { color: "#1e1e1e", width: 1.5 };
	let n = 0;
	const ids = () => `tl${++n}`;
	const pt = (x: number, y: number): Point => quantizePoint(x, y, 0.5);

	function tableWithAnswers() {
		const doc = createDocument(NOW);
		const p = doc.pages[0]!;
		const history = new History(() => doc, 100);
		const grid = gridAt(normaliseSpec({ rows: 3, cols: 2, cellW: 80, cellH: 40 }, p.width), 300, 300, p);
		const made = insertTableCommand(p, grid, style, ids);
		history.execute(made.cmd);
		const table = detectTable(p.strokes.filter((s) => s.group === made.group))!;
		const g = table.grid;
		const answerIn = (row: number, id: string): Stroke =>
			freezeStroke({ ...createStroke("#000000", 2, [pt(g.xs[1]! + 10, g.ys[row]! + 20), pt(g.xs[2]! - 10, g.ys[row]! + 20)]), id });
		p.strokes.push(answerIn(0, "a0"), answerIn(2, "a2"));
		const tapeOver = (row: number, id: string, locked: boolean): TapeElement => Object.freeze({
			id, type: "tape", x: g.xs[1]! + 2, y: g.ys[row]! + 4, width: g.xs[2]! - g.xs[1]! - 4, height: g.ys[row + 1]! - g.ys[row]! - 8, color: "#8fd3bf",
			...(locked ? { locked: true } : {}),
		});
		return { p, table, tapeOver };
	}

	it("refused when a locked tape covers an answer the insert pushes", () => {
		const { p, table, tapeOver } = tableWithAnswers();
		p.elements = [tapeOver(2, "t2", true)];
		const plan = planTableEdit(p, table, insertRow(table.grid, 1)!, p.strokes);
		expect(plan).toEqual({ ok: false, reason: "tapeLocked" });
	});

	it("allowed when the locked tape covers an answer that stays, or the tape over the pushed answer is unlocked", () => {
		const { p, table, tapeOver } = tableWithAnswers();
		p.elements = [tapeOver(0, "t0", true), tapeOver(2, "t2", false)];
		const plan = planTableEdit(p, table, insertRow(table.grid, 1)!, p.strokes);
		expect(plan.ok).toBe(true);
	});
});
