/**
 * 0.29 round-3 review of the round-2 fixes (FAIL CLOSED). Z1: a merge (an exempt wrapper with `inner`) that changes a boxed page's left margin
 * is refused like a direct margin change. Z2: every box records the background geometry of its page and an export refuses a page whose
 * background moved, grew, shrank or changed since (page size, orientation, Update PDF, page restore, a synced file); boxes stored before 0.29
 * adopt it. Z3: an infinite PDF page grows by a bottom margin (its Undo is never refused). Z5: objects under a study tape follow it on Insert
 * space. Z6: a table row insert moves the tapes over the pushed answers.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import reliabilitySrc from "../src/integration/reliability.ts?raw";
import { growCommand } from "../src/ink/infinite";
import { backgroundShifts, redactStepCheck, type StepBoxes } from "../src/ink/redact-step";
import { analyseSpace } from "../src/ink/space";
import { detectTable, gridAt, insertRow, normaliseSpec } from "../src/ink/table";
import { insertTableCommand, planTableEdit } from "../src/ink/table-edit";
import { strokeTouchesTapes } from "../src/ink/tape-guard";
import { createDocument, createStroke, quantizePoint } from "../src/model/document";
import { AddStroke, Batch, History, SetPageBackground, SetPageMargins, SetPageSize } from "../src/model/history";
import { backgroundRect } from "../src/model/margins";
import { planMerge } from "../src/model/merge";
import { exemptFromLocks } from "../src/model/page-lock";
import { ReplacePage } from "../src/model/page-restore";
import { adoptGeometry, backgroundGeometry, cleanBox, normaliseRedactions, staleRedactionPages, tagNewBoxes, type RedactBox, type Redactions } from "../src/model/redact";
import { checkContent, freezeStroke } from "../src/model/serialize";
import type { NotebookDocument, Page, Point, Stroke, TapeElement, TextElement } from "../src/model/types";
import { loadRedactState, saveRedactState } from "../src/ui/redact-store";
import { RedactionUnavailableError, withRedaction } from "../src/view/export-redact";
import { line } from "./helpers";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const SCAN = "b".repeat(24);
const PDF = { kind: "pdf" as const, asset: SCAN, page: 3 };
const BOX = { x: 150, y: 100, width: 120, height: 20 };

/** An A4 PDF page with a secret text under where the box goes. */
function scanDoc(): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(NOW);
	doc.assets = { [SCAN]: { id: SCAN, kind: "pdf", path: `Notebooks/_assets/${SCAN}.pdf`, name: "Statement.pdf", bytes: 10 } };
	const page = doc.pages[0]!;
	page.id = "p1";
	page.background = { ...PDF };
	const secret: TextElement = { id: "t1", type: "text", x: 155, y: 102, width: 100, text: "IBAN 123", fontSize: 12, color: "#000000" };
	page.elements = [Object.freeze(secret)];
	return { doc, page };
}

/** The box as the Redact dialog stores it: drawn now on `page`. */
const drawnOn = (page: Page, box: RedactBox = BOX): Redactions => tagNewBoxes({ [page.id]: [box] }, undefined, [page]);

function rig(doc: NotebookDocument) {
	const history = new History(() => doc, 100, checkContent);
	const boxes: Record<string, RedactBox[]> = {};
	const read = (): StepBoxes => ({ boxesOf: (id) => boxes[id] ?? [], unreadable: false, any: Object.values(boxes).some((l) => l.length > 0) });
	const refused: Array<"undo" | "redo"> = [];
	history.setStepCheck(redactStepCheck(read, (step) => refused.push(step)), () => undefined);
	return { history, boxes, refused };
}

describe("Z1: a merge that widens the left margin of a boxed page is caught", () => {
	it("sees through the exempt wrapper of a merge", () => {
		const { doc, page } = scanDoc();
		const wrapped = exemptFromLocks(new Batch("Merge", [new SetPageMargins(page.id, undefined, { left: 85, right: 0, bottom: 0 })]));
		expect(backgroundShifts(doc, wrapped)).toEqual([page.id]);
		expect(backgroundShifts(doc, exemptFromLocks(new SetPageMargins(page.id, undefined, { left: 0, right: 85, bottom: 0 })))).toEqual([]);
	});

	it("the scenario: a conflicted copy with a 30 mm left margin and ink in it", () => {
		const { doc, page } = scanDoc();
		const copy = JSON.parse(JSON.stringify(doc)) as NotebookDocument;
		const other = copy.pages[0]!;
		other.margins = { left: 85, right: 0, bottom: 0 };
		other.width = page.width + 85;
		other.strokes = [freezeStroke({ ...line(20, 300, 70, 300), id: "margin-note" })];
		const plan = planMerge(doc, copy);
		expect(plan.command).toBeTruthy();
		expect(backgroundShifts(doc, plan.command!)).toEqual([page.id]);
	});

	it("the conflict dialog asks the view first and gives its own reason", () => {
		expect(reliabilitySrc).toContain("this.view.redactRefuses?.(plan.command) === true) throw new Error(t(\"merge.redacted\"))");
	});
});

describe("Z2: a box records the background geometry and an export refuses a page whose background moved", () => {
	it("the geometry: the background's rectangle and what it shows; none without a background", () => {
		const { page } = scanDoc();
		const geo = backgroundGeometry(page);
		const r = backgroundRect(page);
		expect(geo.startsWith(`g${r.x},${r.y},${r.width},${r.height}|`)).toBe(true);
		expect(backgroundGeometry({ ...page, width: 612, height: 792 })).not.toBe(geo); // Letter
		expect(backgroundGeometry({ ...page, width: page.height, height: page.width })).not.toBe(geo); // landscape
		expect(backgroundGeometry({ ...page, margins: { left: 20, right: 0, bottom: 0 }, width: page.width + 20 })).not.toBe(geo);
		expect(backgroundGeometry({ ...page, margins: { left: 0, right: 80, bottom: 40 }, width: page.width + 80, height: page.height + 40 })).toBe(geo);
		expect(backgroundGeometry({ ...page, background: { ...PDF, page: 4 } })).not.toBe(geo); // Update PDF: another slide
		expect(backgroundGeometry({ ...page, background: { ...PDF, rotate: 90 } })).not.toBe(geo);
		const { background: _, ...plain } = page;
		expect(backgroundGeometry(plain)).toBe("");
	});

	it("is kept by the store's reading (and a value that is not ours is dropped)", () => {
		const { page } = scanDoc();
		const geo = backgroundGeometry(page);
		expect(cleanBox({ ...BOX, geo })).toEqual({ ...BOX, geo });
		expect(cleanBox({ ...BOX, geo: "<b>" })).toEqual(BOX);
		expect(normaliseRedactions({ p1: [{ ...BOX, geo }, BOX] }).p1).toEqual([{ ...BOX, geo }, BOX]);
		const mem = new Map<string, string>();
		const app = {
			loadLocalStorage: (k: string): unknown => (mem.has(k) ? JSON.parse(mem.get(k)!) : null),
			saveLocalStorage: (k: string, v: unknown): void => void (v === null ? mem.delete(k) : mem.set(k, JSON.stringify(v))),
		};
		expect(saveRedactState(app, "nb-geo", { on: true, boxes: { p1: [{ ...BOX, geo }] } }).stored).toBe(true);
		expect(loadRedactState({ loadLocalStorage: app.loadLocalStorage }, "nb-geo").boxes).toEqual({ p1: [{ ...BOX, geo }] });
	});

	it("the IBAN scenario: Size > Letter (or landscape) on a boxed A4 scan refuses the export, and its Undo is the way back", () => {
		const { doc, page } = scanDoc();
		const { history, boxes, refused } = rig(doc);
		const redact = drawnOn(page);
		boxes[page.id] = redact[page.id]!;
		expect(withRedaction([page], { redact }).pages[0]).not.toBe(page);
		expect(backgroundShifts(doc, new SetPageSize(page.id, { width: page.width, height: page.height }, { width: 612, height: 792 }))).toEqual([page.id]);
		// The size change reaches the page anyway (another device, a synced file): the export refuses it.
		const before = { width: page.width, height: page.height };
		expect(history.execute(new SetPageSize(page.id, before, { width: 612, height: 792 }))).toBe(true);
		expect(staleRedactionPages([page], redact)).toEqual([page.id]);
		expect(() => withRedaction([page], { redact })).toThrow(RedactionUnavailableError);
		// Undo brings the background back under the boxes: never refused.
		expect(history.undo()).not.toBeNull();
		expect(refused).toEqual([]);
		expect(page.width).toBe(before.width);
		expect(staleRedactionPages([page], redact)).toEqual([]);
		// Landscape: refused too.
		page.width = before.height;
		page.height = before.width;
		expect(staleRedactionPages([page], redact)).toEqual([page.id]);
	});

	it("a forward size change after the box was drawn: its Undo would stretch the scan away from the box and is refused", () => {
		const { doc, page } = scanDoc();
		const { history, boxes, refused } = rig(doc);
		expect(history.execute(new SetPageSize(page.id, { width: page.width, height: page.height }, { width: 612, height: 792 }))).toBe(true);
		boxes[page.id] = drawnOn(page)[page.id]!;
		expect(history.undo()).toBeNull();
		expect(refused).toEqual(["undo"]);
	});

	it("Update PDF, a page restore and a margin shrink are stale; a removed background, or one added to a plain page, is not", () => {
		const { doc, page } = scanDoc();
		const redact = drawnOn(page);
		const stale = (p: Page): boolean => staleRedactionPages([p], redact).length > 0;
		expect(stale({ ...page, background: { ...PDF, asset: "c".repeat(24) } })).toBe(true);
		expect(stale({ ...page, margins: { left: 30, right: 0, bottom: 0 }, width: page.width + 30 })).toBe(true);
		const { background: _, ...bare } = page;
		expect(stale(bare)).toBe(false);
		// Forward gates: another background, a restore with other margins; adding a background to a plain page is not counted.
		expect(backgroundShifts(doc, new SetPageBackground(page.id, { ...PDF, page: 9 }, { width: page.width, height: page.height }))).toEqual([page.id]);
		const restored: Page = { ...page, margins: { left: 40, right: 0, bottom: 0 }, width: page.width + 40 };
		expect(backgroundShifts(doc, new ReplacePage(page, restored))).toEqual([page.id]);
		expect(backgroundShifts(doc, new ReplacePage(page, { ...page }))).toEqual([]);
		const plainDoc = createDocument(NOW);
		const p = plainDoc.pages[0]!;
		expect(backgroundShifts(plainDoc, new SetPageBackground(p.id, { ...PDF }, { width: p.width, height: p.height }))).toEqual([]);
		// A box on a plain page records no geometry: a page size never makes it stale (ink stays where it was).
		const onPlain = tagNewBoxes({ [p.id]: [BOX] }, undefined, [p]);
		expect(onPlain[p.id]![0]!.geo).toBeUndefined();
		expect(staleRedactionPages([{ ...p, width: 300 }], onPlain)).toEqual([]);
	});

	it("boxes stored before 0.29 are checked on their view, and adopt the geometry once (not when already stale by their view)", () => {
		const { page } = scanDoc();
		const legacy: Redactions = { p1: [BOX] };
		// Unknown geometry: not refused for it (the view is still compared).
		expect(staleRedactionPages([{ ...page, width: 612 }], legacy)).toEqual([]);
		const adopted = adoptGeometry(legacy, [page]);
		expect(adopted.p1).toEqual([{ ...BOX, geo: backgroundGeometry(page) }]);
		expect(adoptGeometry(adopted, [page])).toBe(adopted);
		expect(staleRedactionPages([{ ...page, width: 612 }], adopted)).toEqual(["p1"]);
		// Drawn on the upright page, the page is turned now: stale by its view, so it keeps no geometry.
		const turned = { ...page, background: { ...PDF, rotate: 90 as const } };
		expect(adoptGeometry(legacy, [turned])).toBe(legacy);
		// Pages that are not open (or have no background) are left as they are.
		expect(adoptGeometry({ other: [BOX] }, [page])).toEqual({ other: [BOX] });
		// Confirming the Redact dialog adopts it too, and keeps a recorded geometry as it is.
		expect(tagNewBoxes(legacy, legacy, [page]).p1).toEqual([{ ...BOX, geo: backgroundGeometry(page) }]);
		const old = { ...BOX, geo: "g0,0,1,1|00000000000000" };
		expect(tagNewBoxes({ p1: [old] }, { p1: [old] }, [page]).p1).toEqual([old]);
	});
});

describe("Z3: an infinite PDF page grows by a bottom margin", () => {
	it("keeps the background box, so writing at the bottom of a boxed infinite scan can be undone", () => {
		const { doc, page } = scanDoc();
		page.infinite = true;
		const { history, boxes, refused } = rig(doc);
		boxes[page.id] = drawnOn(page)[page.id]!;
		const geo = backgroundGeometry(page);
		const grow = growCommand(page, page.height + 400);
		expect(grow).toBeInstanceOf(SetPageMargins);
		const s = freezeStroke({ ...line(100, page.height - 20, 300, page.height - 20), id: "low" });
		expect(history.execute(new Batch("Draw", [new AddStroke(page.id, s, page.strokes.length), grow]))).toBe(true);
		expect(backgroundGeometry(page)).toBe(geo);
		expect(page.margins).toEqual({ left: 0, right: 0, bottom: 400 });
		expect(staleRedactionPages([page], { [page.id]: boxes[page.id]! })).toEqual([]);
		expect(history.undo()).not.toBeNull();
		expect(refused).toEqual([]);
		expect(page.margins).toBeUndefined();
		expect(history.redo()).not.toBeNull();
		expect(refused).toEqual([]);
		// A plain page, or a PDF page that already has margins, grows by its size as before.
		expect(growCommand({ ...page, background: undefined }, page.height + 400)).toBeInstanceOf(SetPageSize);
		expect(growCommand({ ...page, margins: { left: 0, right: 40, bottom: 0 } }, page.height + 400)).toBeInstanceOf(SetPageSize);
	});
});

function tape(id: string, extra: Partial<TapeElement> = {}): TapeElement {
	return Object.freeze({ id, type: "tape", x: 100, y: 100, width: 100, height: 40, color: "#8fd3bf", ...extra });
}

function plainWith(elements: Page["elements"], strokes: Stroke[] = []): NotebookDocument {
	const doc = createDocument(NOW);
	const page = doc.pages[0]!;
	page.id = "p1";
	page.strokes = strokes;
	if (elements && elements.length > 0) page.elements = elements;
	return doc;
}

describe("Z5: Insert space moves what lies under a tape with the tape", () => {
	it("a typed answer under a straddling tape goes with the tape", () => {
		const cover = tape("t", { x: 100, y: 100, width: 100, height: 40 }); // centre 120
		const answer: TextElement = Object.freeze({ id: "x", type: "text", x: 110, y: 96, width: 60, text: "42", fontSize: 10, color: "#000000" });
		const above = freezeStroke({ ...line(110, 50, 190, 50), id: "a" });
		const a = analyseSpace(plainWith([cover, answer], [above]).pages, 0, 112, 40)!;
		expect(a).not.toBeNull();
		expect(a.moves.map((m) => m.item.stroke?.id ?? m.item.element!.id).sort()).toEqual(["t", "x"]);
		expect(a.staying.map((s) => s.stroke?.id)).toEqual(["a"]);
	});

	it("a long stroke that only touches a tape keeps its own extent: Remove space never pulls ink over it", () => {
		const cover = tape("t", { x: 100, y: 200, width: 60, height: 30 }); // centre 215, below the line at 150
		// From y 60 down into the tape: it moves with the tape, but its top is at 60.
		const long = freezeStroke({ ...line(120, 60, 120, 210), id: "long" });
		const staying = freezeStroke({ ...line(300, 100, 380, 100), id: "s" });
		const a = analyseSpace(plainWith([cover], [long, staying]).pages, 0, 150, -80);
		// Without the union the moving top would be the tape's (200) and 80 pt could be removed, pulling the stroke over "s".
		expect(a).toBeNull();
	});
});

describe("Z6: a table row insert moves the tapes over the pushed answers", () => {
	const style = { color: "#1e1e1e", width: 1.5 };
	let n = 0;
	const ids = () => `tb${++n}`;
	const pt = (x: number, y: number): Point => quantizePoint(x, y, 0.5);

	it("each tape stays over its answer; a tape over an answer that stays does not move", () => {
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
		const top = answerIn(0, "a0");
		const low = answerIn(2, "a2");
		p.strokes.push(top, low);
		const tapeOver = (row: number, id: string): TapeElement =>
			tape(id, { x: g.xs[1]! + 2, y: g.ys[row]! + 4, width: g.xs[2]! - g.xs[1]! - 4, height: g.ys[row + 1]! - g.ys[row]! - 8 });
		const t0 = tapeOver(0, "t0");
		const t2 = tapeOver(2, "t2");
		p.elements = [t0, t2];
		expect(strokeTouchesTapes(low, [t2])).toBe(true);
		const edit = insertRow(table.grid, 1)!;
		const plan = planTableEdit(p, table, edit, p.strokes);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(history.execute(plan.cmd)).toBe(true);
		const by = edit.shift!.by;
		const el = (id: string) => p.elements!.find((e) => e.id === id) as TapeElement;
		expect(el("t2").y).toBeCloseTo(t2.y + by, 2);
		expect(el("t0").y).toBe(t0.y);
		const moved = p.strokes.find((s) => s.id === "a2")!;
		expect(strokeTouchesTapes(moved, [el("t2")])).toBe(true);
		history.undo();
		expect(el("t2")).toBe(t2);
	});
});
