/**
 * 0.29 round-2 review of history and redaction: H1 (a left margin moves the background out from under the boxes: refused forward and on
 * undo/redo), H2 (the checkbox label rule is decided on the ink before struck words are left out), H3 (struck words alone keep the study
 * tapes), H4 (refusal notices only once the step is back; a check that throws has its own), H5 (comment ids repeat across pages).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import dialogSrc from "../src/view/export-dialog.ts?raw";
import shareSrc from "../src/view/share-page.ts?raw";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import { Notice } from "obsidian";
import { backgroundShifts, captureForStep, redactStepCheck, stepMovesUnderRedaction, type StepBoxes } from "../src/ink/redact-step";
import { redactPage } from "../src/ink/redact";
import { struckInk } from "../src/ink/strikethrough";
import { cleanPageForExport, cleanPagesForExport, STRUCK_ONLY } from "../src/model/clean-export";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { pageTexts } from "../src/model/export-markdown";
import { AddStroke, Batch, History, SetPageMargins, SetPageSize } from "../src/model/history";
import type { RedactBox } from "../src/model/redact";
import { checkContent } from "../src/model/serialize";
import type { CheckboxElement, NotebookDocument, Page, PageComment, Point, Stroke, TapeElement } from "../src/model/types";
import { withRedaction } from "../src/view/export-redact";
import { marginsRefused } from "../src/view/pdf-actions";
import { line } from "./helpers";
import { reseed, writeLine } from "./words-gen";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const SCAN = "a".repeat(24);
const PDF = { kind: "pdf" as const, asset: SCAN, page: 3 };

function store(unreadable = false) {
	const boxes: Record<string, RedactBox[]> = {};
	const read = (): StepBoxes => ({ boxesOf: (id) => boxes[id] ?? [], unreadable, any: Object.values(boxes).some((l) => l.length > 0) });
	return { boxes, read };
}

function rig(doc: NotebookDocument, unreadable = false) {
	const history = new History(() => doc, 100, checkContent);
	const s = store(unreadable);
	const refused: Array<"undo" | "redo"> = [];
	const failed: Array<"undo" | "redo"> = [];
	history.setStepCheck(redactStepCheck(s.read, (step) => refused.push(step)), (step) => failed.push(step));
	return { history, s, refused, failed };
}

/** A scanned page (a PDF page, no ink at all): what a margin moves is the background alone. */
function scanDoc(): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(NOW);
	doc.assets = { [SCAN]: { id: SCAN, kind: "pdf", path: `Notebooks/_assets/${SCAN}.pdf`, name: "Statement.pdf", bytes: 10 } };
	const page = doc.pages[0]!;
	page.background = { ...PDF };
	return { doc, page };
}

describe("H1: a left margin never moves the background out from under the boxes", () => {
	it("tells the steps that move a background sideways: a left margin, a page size that drops the margins, inside a batch too", () => {
		const { doc, page } = scanDoc();
		expect(backgroundShifts(doc, new SetPageMargins(page.id, undefined, { left: 85, right: 0, bottom: 0 }))).toEqual([page.id]);
		expect(backgroundShifts(doc, new SetPageMargins(page.id, undefined, { left: 0, right: 85, bottom: 40 }))).toEqual([]);
		expect(backgroundShifts(doc, new Batch("Change page margins", [new SetPageMargins(page.id, undefined, { left: 10, right: 0, bottom: 0 })]))).toEqual([page.id]);
		expect(backgroundShifts(doc, new SetPageSize(page.id, { width: page.width, height: page.height }, { width: 300, height: 400 }))).toEqual([]);
		page.margins = { left: 200, right: 0, bottom: 0 };
		// Narrower than the left margin: the margins are dropped and the background goes back to x 0.
		expect(backgroundShifts(doc, new SetPageSize(page.id, { width: page.width, height: page.height }, { width: 150, height: 400 }))).toEqual([page.id]);
		expect(backgroundShifts(doc, new SetPageSize(page.id, { width: page.width, height: page.height }, { width: page.width + 50, height: page.height }))).toEqual([]);
	});

	it("the margins dialog refuses a new left margin on a page with boxes (or unreadable boxes), with a notice; right and bottom stay free", () => {
		const { doc, page } = scanDoc();
		const shown = (Notice as unknown as { shown: string[] }).shown;
		shown.length = 0;
		const left = new SetPageMargins(page.id, undefined, { left: 85, right: 0, bottom: 0 });
		const right = new SetPageMargins(page.id, undefined, { left: 0, right: 85, bottom: 0 });
		expect(marginsRefused({ doc, hasRedaction: () => true }, left)).toBe(true);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain("left margin");
		expect(marginsRefused({ doc, hasRedaction: () => true }, right)).toBe(false);
		expect(marginsRefused({ doc, hasRedaction: () => false }, left)).toBe(false);
		expect(marginsRefused({ doc }, left)).toBe(false);
		expect(shown).toHaveLength(1);
	});

	it("scenario B: Undo of a margin change on a background-only page with a box is refused and stays; it runs once the box is gone", () => {
		const { doc, page } = scanDoc();
		const { history, s, refused } = rig(doc);
		const cmd = new SetPageMargins(page.id, undefined, { left: 85, right: 0, bottom: 0 });
		expect(history.execute(cmd)).toBe(true);
		// The box is drawn afterwards over the account number of the moved scan.
		s.boxes[page.id] = [{ x: 150, y: 100, width: 120, height: 20 }];
		expect(history.undo()).toBeNull();
		expect(refused).toEqual(["undo"]);
		expect(page.margins).toEqual({ left: 85, right: 0, bottom: 0 });
		expect(history.canUndo()).toBe(true);
		s.boxes[page.id] = [];
		expect(history.undo()).toBe(cmd);
		expect(page.margins).toBeUndefined();
		// And the Redo, once a box is drawn on the page as it is now.
		s.boxes[page.id] = [{ x: 60, y: 100, width: 120, height: 20 }];
		expect(history.redo()).toBeNull();
		expect(refused).toEqual(["undo", "redo"]);
		expect(page.margins).toBeUndefined();
		expect(history.canRedo()).toBe(true);
	});

	it("another background (asset, page, turn or crop) under the boxes is refused too; a page without a background is never held back by it", () => {
		const { doc, page } = scanDoc();
		const s = store();
		s.boxes[page.id] = [{ x: 10, y: 10, width: 50, height: 50 }];
		let before = captureForStep(doc, s.read())!;
		page.background = { ...PDF, rotate: 90 };
		expect(stepMovesUnderRedaction(before, doc, s.read())).toBe(true);
		page.background = { ...PDF, page: 4 };
		expect(stepMovesUnderRedaction(before, doc, s.read())).toBe(true);
		page.background = { ...PDF };
		expect(stepMovesUnderRedaction(before, doc, s.read())).toBe(false);
		// Unreadable boxes: a named page is checked as if it had boxes.
		const u = store(true);
		before = captureForStep(doc, u.read())!;
		page.margins = { left: 30, right: 0, bottom: 0 };
		expect(stepMovesUnderRedaction(before, doc, u.read())).toBe(true);

		const plain = createDocument(NOW);
		const p = plain.pages[0]!;
		const r = rig(plain);
		r.history.execute(new SetPageSize(p.id, { width: p.width, height: p.height }, { width: p.width, height: p.height + 200 }));
		r.s.boxes[p.id] = [{ x: 10, y: 10, width: 50, height: 50 }];
		expect(r.history.undo()).not.toBeNull();
		expect(r.refused).toEqual([]);
	});
});

const BASE = 100;

function strike(id: string, x0: number, x1: number, y: number): Stroke {
	const pts: Point[] = [];
	for (let i = 0; i <= 12; i++) pts.push([x0 + ((x1 - x0) * i) / 12, y + Math.sin(i * 1.7) * 0.4, 0.5]);
	const s = createStroke("#000000", 1.5, pts, "pen");
	s.id = id;
	return s;
}

/** A checkbox with a typed label, the same words handwritten to its right, the last word (the IBAN) struck through, and a box over it. */
function ibanPage(): { page: Page; box: RedactBox; struckIds: ReadonlySet<string> } {
	const text = writeLine("a", "pay to iban", { x: 40, baseY: BASE });
	const word = text.filter((s) => s.id.split(":")[1] === "2");
	const xs = word.flatMap((s) => s.points.map((p) => p[0]));
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const cb: CheckboxElement = { id: "cb", type: "checkbox", x: 16, y: BASE - 14, size: 16, color: "#000000", label: "Pay 4500 to IBAN SECRET-IT60X054" };
	const page = {
		id: "p1", width: 600, height: 800, paper: { kind: "plain" }, strokes: [...text, strike("strike", minX - 4, maxX + 4, BASE - 5)], elements: [cb],
	} as unknown as Page;
	return { page, box: { x: minX + 2, y: BASE - 20, width: maxX - minX + 10, height: 26 }, struckIds: struckInk(page.strokes) };
}

const label = (p: Page): string | undefined => (p.elements?.find((e) => e.id === "cb") as CheckboxElement | undefined)?.label;

describe("H2: struck words left out never switch the checkbox label rule off", () => {
	beforeEach(() => reseed(11));

	it("the setting (withRedaction) and the dialog / share clean copy both drop the typed label of a box over struck handwriting", () => {
		const { page, box, struckIds } = ibanPage();
		expect(struckIds.has("strike")).toBe(true);
		expect(struckIds.size).toBeGreaterThan(1);
		const redact = { p1: [box] };
		// Control: on the ink without the struck words alone (what the clean copy draws), the box touches no label ink: the label would stay.
		const rest: Page = { ...page, strokes: page.strokes.filter((s) => !struckIds.has(s.id)) };
		expect(label(redactPage(rest, [box]))).toContain("SECRET");
		// Without the struck option the label goes (P13)…
		expect(label(withRedaction([page], { redact }).pages[0]!)).toBeUndefined();
		// …and with it too: the setting path (the Markdown export, the quick PDF, share with the setting on).
		const out = withRedaction([page], { struck: true, redact }).pages[0]!;
		expect(out.strokes.some((s) => struckIds.has(s.id))).toBe(false);
		expect(label(out)).toBeUndefined();
		expect(pageTexts(out).join("\n")).not.toContain("SECRET");
		// The dialog and the share sheet clean first, then redact.
		const cleaned = cleanPagesForExport([page], { struck: true });
		const dialog = withRedaction(cleaned, { redact }).pages[0]!;
		expect(label(dialog)).toBeUndefined();
		expect(pageTexts(dialog).join("\n")).not.toContain("SECRET");
		// A clean copy of a clean copy still knows the ink of the page.
		const twice = withRedaction([cleanPageForExport(cleaned[0]!, { struck: true, tapes: false })], { redact }).pages[0]!;
		expect(label(twice)).toBeUndefined();
		// A box elsewhere keeps the label.
		expect(label(withRedaction([page], { struck: true, redact: { p1: [{ x: 400, y: 600, width: 20, height: 20 }] } }).pages[0]!)).toContain("SECRET");
	});
});

describe("H3: struck words alone keep the study tapes", () => {
	beforeEach(() => reseed(11));

	it("STRUCK_ONLY leaves the struck words out and keeps the tapes; the export dialog and the share sheet use it", () => {
		const { page } = ibanPage();
		const tape: TapeElement = { id: "tape", type: "tape", x: 40, y: 300, width: 200, height: 20, color: "#8fd3bf" };
		const withTape = { ...page, elements: [...page.elements!, tape] } as Page;
		const out = cleanPageForExport(withTape, STRUCK_ONLY);
		expect(out.elements?.some((e) => e.id === "tape")).toBe(true);
		expect(out.strokes.some((s) => s.id === "strike")).toBe(false);
		for (const src of [dialogSrc, shareSrc]) expect(src).toContain("STRUCK_ONLY");
	});
});

/** An AddStroke whose `apply` can be made to throw (the inverse of an undone step that fails). */
class Flaky extends AddStroke {
	fail = false;
	override apply(doc: NotebookDocument): void {
		if (this.fail) throw new Error("half done");
		super.apply(doc);
	}
}

describe("H4: what is said when a step is refused", () => {
	it("the refusal notice of the redaction check comes once the step is back, and the history says nothing else", () => {
		const { doc, page } = scanDoc();
		const messages: string[] = [];
		const history = new History(() => doc, 100, checkContent, (m) => messages.push(m));
		const s = store();
		const said: string[] = [];
		const cmd = new SetPageMargins(page.id, undefined, { left: 40, right: 0, bottom: 0 });
		// Said after the inverse ran: the page already has its margins back when the notice comes.
		history.setStepCheck(redactStepCheck(s.read, (step) => said.push(`${step}:${page.margins?.left ?? 0}`)));
		history.execute(cmd);
		s.boxes[page.id] = [{ x: 130, y: 290, width: 90, height: 30 }];
		expect(history.undo()).toBeNull();
		expect(said).toEqual(["undo:40"]);
		expect(messages).toEqual([]);
		expect(page.margins).toEqual({ left: 40, right: 0, bottom: 0 });
		expect(history.stepsTo(cmd)).toEqual({ direction: "undo", steps: 0 });
	});

	it("a refused step whose inverse throws says only that it was dropped", () => {
		const doc = createDocument(NOW);
		const p = doc.pages[0]!;
		const messages: string[] = [];
		const history = new History(() => doc, 100, null, (m) => messages.push(m));
		const said: string[] = [];
		const ink = line(100, 300, 160, 305);
		const cmd = new Flaky(p.id, ink, 0);
		history.execute(cmd);
		history.setStepCheck(() => () => () => said.push("refused"));
		cmd.fail = true;
		expect(() => history.undo()).not.toThrow();
		expect(said).toEqual([]);
		expect(messages).toEqual(["half done"]);
		expect(p.strokes).toEqual([ink]);
	});

	it("a check that throws (before or after the step) refuses it with its own notice", () => {
		const doc = createDocument(NOW);
		const p = doc.pages[0]!;
		const history = new History(() => doc, 100, checkContent);
		history.execute(new AddStroke(p.id, line(100, 300, 160, 305), 0));
		const failed: string[] = [];
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		history.setStepCheck(() => () => {
			throw new Error("boom");
		}, (step) => failed.push(step));
		expect(history.undo()).toBeNull();
		history.setStepCheck(() => {
			throw new Error("boom");
		}, (step) => failed.push(step));
		expect(history.undo()).toBeNull();
		expect(failed).toEqual(["undo", "undo"]);
		expect(p.strokes).toHaveLength(1);
		expect(history.canUndo()).toBe(true);
		errors.mockRestore();
	});
});

const note = (id: string, x: number): PageComment => ({ id, region: { x, y: 100, width: 40, height: 10 }, text: "PIN 9999", author: "me", created: NOW.getTime() });

describe("H5: comment ids repeat on a duplicated page", () => {
	it("a note removed from a page with a box is not taken for a move when a duplicate page already had the same id; a real move is", () => {
		const doc = createDocument(NOW);
		doc.pages.push(createPage());
		const [a, b] = [doc.pages[0]!, doc.pages[1]!];
		a.comments = [note("c1", 300)];
		b.comments = [note("c1", 300)];
		const s = store();
		s.boxes[a.id] = [{ x: 295, y: 95, width: 50, height: 20 }];
		const before = captureForStep(doc, s.read(), new Set([a.id, b.id]))!;
		a.comments = [];
		expect(stepMovesUnderRedaction(before, doc, s.read())).toBe(false);
		// A note that really goes to the other page (which did not have it) is a move.
		a.comments = [note("c2", 300)];
		b.comments = [];
		const before2 = captureForStep(doc, s.read(), new Set([a.id, b.id]))!;
		a.comments = [];
		b.comments = [note("c2", 300)];
		expect(stepMovesUnderRedaction(before2, doc, s.read())).toBe(true);
	});
});
