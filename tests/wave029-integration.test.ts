/**
 * Cross-feature rules of the 0.29 wave: the study tape (#10, format 27) next to the redaction undo guard, the strike-through hide, the clean
 * export, the table readers of charts (#244) and statistics (#295), and the figure captions (#248).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => {
	const base = (await import("./fake-vault")).obsidianMock();
	class Notice {
		setMessage(): void {}
		hide(): void {}
	}
	return { ...base, Notice };
});

import { withRedaction } from "../src/view/export-redact";
import { readCells } from "../src/ink/table-data";
import { readTableCells } from "../src/ink/table-numbers";
import { captureForStep, stepMovesUnderRedaction, type StepBoxes } from "../src/ink/redact-step";
import { detectStrikes, struckInk } from "../src/ink/strikethrough";
import { createDocument, createStroke } from "../src/model/document";
import { cleanPageForExport, hasCleanableContent } from "../src/model/clean-export";
import { createTape } from "../src/model/tape";
import { CURRENT_VERSION, type NotebookDocument, type PageElement, type Point, type Stroke, type TextElement } from "../src/model/types";
import { reseed, writeLine } from "./words-gen";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const text = (x: number, y: number, s: string): TextElement => ({ id: `t${x}-${y}`, type: "text", x, y, width: 40, text: s, fontSize: 12, color: "#000000" });
const tapeAt = (x: number, y: number, w: number, h: number): PageElement => ({ ...createTape([x, y], [x + w, y + h], { width: 595, height: 842 }, "#a7f3d0")!, id: "tape-1" });

function strike(id: string, x0: number, x1: number, y: number): Stroke {
	const pts: Point[] = [];
	for (let i = 0; i <= 12; i++) pts.push([x0 + ((x1 - x0) * i) / 12, y + Math.sin(i * 1.7) * 0.4, 0.5]);
	const s = createStroke("#000000", 1.5, pts, "pen");
	s.id = id;
	return s;
}

function struckStrokes(): Stroke[] {
	reseed(11);
	const words = writeLine("a", "hello brave new world", { x: 40, baseY: 100 });
	const word = words.filter((s) => s.id.split(":")[1] === "1");
	const xs = word.flatMap((s) => s.points.map((p) => p[0]));
	return [...words, strike("strike", Math.min(...xs) - 4, Math.max(...xs) + 4, 95)];
}

describe("0.29 integration: the format", () => {
	it("is at least 27 (the study tape)", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(27);
	});
});

describe("0.29 integration: study tape and the strike-through hide", () => {
	it("a page that holds a tape detects the same struck words, and a tape is never part of the struck ink", () => {
		const strokes = struckStrokes();
		const base = struckInk(strokes);
		expect(base.size).toBeGreaterThan(0);
		const doc = createDocument(NOW);
		const page = doc.pages[0]!;
		page.strokes.push(...strokes);
		page.elements = [tapeAt(30, 60, 300, 60)];
		expect(struckInk(page.strokes)).toEqual(base);
		expect(detectStrikes(page.strokes).words.length).toBeGreaterThan(0);
	});

	it("a clean export drops the tapes and the struck words together, and leaves everything else", () => {
		const doc = createDocument(NOW);
		const page = doc.pages[0]!;
		page.strokes.push(...struckStrokes());
		const kept = text(10, 300, "kept");
		page.elements = [tapeAt(30, 60, 300, 60), kept];
		const struck = struckInk(page.strokes);
		const out = cleanPageForExport(page, { struck: true });
		expect(out.elements).toEqual([kept]);
		expect(out.strokes).toHaveLength(page.strokes.length - struck.size);
		expect(page.elements).toHaveLength(2); // the page itself is untouched
		const tapesOnly = cleanPageForExport(page, { struck: false });
		expect(tapesOnly.elements).toEqual([kept]);
		expect(tapesOnly.strokes).toHaveLength(page.strokes.length);
		const strikesOnly = cleanPageForExport(page, { struck: true, tapes: false });
		expect(strikesOnly.elements).toHaveLength(2);
		expect(strikesOnly.strokes).toHaveLength(page.strokes.length - struck.size);
		expect(hasCleanableContent(page, { markers: false, comments: false, collapsedStickies: false, struck: false })).toBe(true);
		expect(hasCleanableContent(page, { markers: false, comments: false, collapsedStickies: false, tapes: false, struck: false })).toBe(false);
	});
});

describe("0.29 integration: the struck-words export keeps the study tapes (every export draws them covering)", () => {
	it("withRedaction({ struck }) leaves the struck words out and the tapes in", () => {
		const doc = createDocument(NOW);
		const page = doc.pages[0]!;
		page.strokes.push(...struckStrokes());
		const tape = tapeAt(30, 60, 300, 60);
		page.elements = [tape];
		const struck = struckInk(page.strokes);
		const out = withRedaction([page], { struck: true }).pages[0]!;
		expect(out.strokes).toHaveLength(page.strokes.length - struck.size);
		expect(out.elements).toEqual([tape]);
	});
});

describe("0.29 integration: study tape and the table readers (charts, statistics)", () => {
	const grid = { xs: [0, 100, 200], ys: [0, 30, 60] };

	it("a tape over a table is not a cell: both readers give the same cells with or without it", () => {
		const cells: PageElement[] = [text(5, 5, "Name"), text(105, 5, "Value"), text(5, 35, "a"), text(105, 35, "3,5")];
		const withTape = [...cells, tapeAt(100, 30, 100, 30)];
		expect(readTableCells(grid, withTape)).toEqual(readTableCells(grid, cells));
		expect(readCells(grid, withTape)).toEqual(readCells(grid, cells));
		expect(readCells(grid, withTape)[1]![1]).toBe("3,5");
	});
});

describe("0.29 integration: study tape and the redaction undo guard", () => {
	const boxes = (): StepBoxes => ({ boxesOf: () => [{ x: 100, y: 100, width: 100, height: 40 }], unreadable: false, any: true });

	function docWith(tape: PageElement): NotebookDocument {
		const doc = createDocument(NOW);
		doc.pages[0]!.elements = [tape];
		return doc;
	}

	it("a step that moves a tape onto a redaction box is refused, like any other element", () => {
		const doc = docWith(tapeAt(300, 300, 80, 30));
		const before = captureForStep(doc, boxes())!;
		doc.pages[0]!.elements = [{ ...doc.pages[0]!.elements![0]!, x: 110, y: 105 }];
		expect(stepMovesUnderRedaction(before, doc, boxes())).toBe(true);
	});

	it("a step that moves a tape out from over a redaction box is refused", () => {
		const doc = docWith(tapeAt(110, 105, 80, 30));
		const before = captureForStep(doc, boxes())!;
		doc.pages[0]!.elements = [{ ...doc.pages[0]!.elements![0]!, x: 400, y: 400 }];
		expect(stepMovesUnderRedaction(before, doc, boxes())).toBe(true);
	});

	it("a tape that moves far from every box is not a problem", () => {
		const doc = docWith(tapeAt(300, 300, 80, 30));
		const before = captureForStep(doc, boxes())!;
		doc.pages[0]!.elements = [{ ...doc.pages[0]!.elements![0]!, x: 420, y: 500 }];
		expect(stepMovesUnderRedaction(before, doc, boxes())).toBe(false);
	});
});
