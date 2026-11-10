/**
 * Study tape (0.29, #10): the fixes of the second independent review (R1–R6). The pen delete gesture spares covered ink, a table insert pushes
 * covered ink with its row, Delete/Cut ask first when the selection holds covered content, the text tool and Insert space respect a tape,
 * and the reference windows number figure captions from the notebook they show.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import viewSrc from "../src/view/notebook-view.ts?raw";
import refSrc from "../src/view/ref-window-sources.ts?raw";
import pdfRefSrc from "../src/view/pdf-reference.ts?raw";
import { createDocument, createStroke, quantizePoint } from "../src/model/document";
import { freezeStroke } from "../src/model/serialize";
import { History } from "../src/model/history";
import type { NotebookDocument, Page, Point, Stroke, TapeElement, TextElement } from "../src/model/types";
import { selectionHoldsCovered, strokeTouchesTapes } from "../src/ink/tape-guard";
import { analyseSpace } from "../src/ink/space";
import { detectTable, gridAt, insertRow, normaliseSpec } from "../src/ink/table";
import { insertTableCommand, planTableEdit } from "../src/ink/table-edit";
import { en } from "../src/i18n/en";
import { it as it_ } from "../src/i18n/it";
import { line } from "./helpers";

const { runGesture } = await import("../src/view/pen-gesture-actions");

const stamp = "2026-11-10T10:00:00.000Z";

function tape(id: string, extra: Partial<TapeElement> = {}): TapeElement {
	return Object.freeze({ id, type: "tape", x: 100, y: 100, width: 100, height: 40, color: "#8fd3bf", ...extra });
}

function withId(s: Stroke, id: string): Stroke {
	return freezeStroke({ ...s, id });
}

function docWith(elements: Page["elements"], strokes: Stroke[] = []): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	page.id = "p1";
	page.strokes = strokes;
	if (elements && elements.length > 0) page.elements = elements;
	return doc;
}

/** A fast zig-zag scratch over x 140..240, y ~86..114, sampled every ~1 pt. */
function zigzag(cx = 190, cy = 100, half = 50, legs = 7, pitch = 4): Point[] {
	const vertices: Array<[number, number]> = [];
	for (let i = 0; i <= legs; i++) vertices.push([cx + (i % 2 === 0 ? -half : half), cy + (i - legs / 2) * pitch]);
	const out: Point[] = [];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!, [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
		for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, 0.5]);
	}
	return out;
}

/** A gesture view on one page at scale 1 (stage px = page pt). */
function gestureView(doc: NotebookDocument, executed: unknown[][], extra: Record<string, unknown> = {}) {
	return {
		app: {} as never,
		settings: () => ({ penGestureSpacePt: 40 }) as never,
		doc: () => doc,
		editable: () => true,
		pageIndexAt: () => 0,
		toLocal: (_i: number, p: { x: number; y: number }) => [p.x, p.y] as [number, number],
		stageRect: () => ({ left: 0, top: 0 }) as DOMRect,
		boundsOf: () => undefined,
		revealed: () => false,
		selection: () => null,
		selectionHit: () => false,
		selectPolygon: () => undefined,
		clearSelection: () => undefined,
		penStyle: () => ({ color: "#1e1e1e", width: 2 }),
		execute: (commands: unknown[]) => void executed.push(commands),
		editTags: () => undefined,
		openSearch: () => undefined,
		...extra,
	};
}

describe("R1: the pen delete gesture spares ink a hidden tape reaches over", () => {
	const trail = zigzag().map((p, i) => ({ x: p[0], y: p[1], t: i * 2, p: 0.5 }));
	// A word of six tall strokes at x 150..220; a tape over x 200..260 covers the last two.
	const word = (): Stroke[] => Array.from({ length: 6 }, (_, i) => withId(line(150 + i * 14, 90, 151 + i * 14, 110), `w${i}`));
	const cover = tape("t", { x: 200, y: 80, width: 60, height: 40 });

	it("deletes only the visible strokes the scratch crosses, keeps the covered ones and says so", () => {
		const strokes = word();
		const doc = docWith([cover], strokes);
		const page = doc.pages[0]!;
		const covered = strokes.filter((s) => strokeTouchesTapes(s, [cover]));
		expect(covered.map((s) => s.id)).toEqual(["w4", "w5"]);
		const executed: unknown[][] = [];
		let kept = 0;
		const v = gestureView(doc, executed, {
			spareStroke: () => (s: Stroke) => strokeTouchesTapes(s, [cover]),
			tapeKept: () => void kept++,
		});
		runGesture(v, { type: "builtin", id: "delete" } as never, trail);
		expect(executed).toHaveLength(1);
		const history = new History(() => doc);
		for (const c of executed[0]!) history.execute(c as never);
		expect(page.strokes.map((s) => s.id)).toEqual(["w4", "w5"]);
		expect(kept).toBe(1);
	});

	it("without a hidden tape (no spare hook) the same scratch deletes the whole word, and nothing is said", () => {
		const doc = docWith([cover], word());
		const executed: unknown[][] = [];
		let kept = 0;
		runGesture(gestureView(doc, executed, { spareStroke: () => undefined, tapeKept: () => void kept++ }), { type: "builtin", id: "delete" } as never, trail);
		const history = new History(() => doc);
		for (const c of executed[0]!) history.execute(c as never);
		expect(doc.pages[0]!.strokes).toEqual([]);
		expect(kept).toBe(0);
	});

	it("the view wires the hook with the hidden tapes of the page", () => {
		const body = viewSrc.slice(viewSrc.indexOf("private gestureView(): PenGestureView"), viewSrc.indexOf("selectionHit: (pageIndex, local)"));
		expect(body).toContain("spareStroke: (page) =>");
		expect(body).toContain("this.hidingTapesOf(page)");
		expect(body).toContain("tapeKept: () => this.tapeKeptNotice()");
	});
});

describe("R2: a table row insert pushes covered answers with their row", () => {
	const style = { color: "#1e1e1e", width: 1.5 };
	let n = 0;
	const ids = () => `tb${++n}`;
	const pt = (x: number, y: number): Point => quantizePoint(x, y, 0.5);

	it("with all the ink (what the view passes now) the covered answer moves with the visible word of its row", () => {
		const doc = createDocument(new Date(stamp));
		const p = doc.pages[0]!;
		const history = new History(() => doc, 100);
		const grid = gridAt(normaliseSpec({ rows: 3, cols: 2, cellW: 80, cellH: 40 }, p.width), 300, 300, p);
		const made = insertTableCommand(p, grid, style, ids);
		history.execute(made.cmd);
		const table = detectTable(p.strokes.filter((s) => s.group === made.group))!;
		const g = table.grid;
		const word = withId(createStroke("#000000", 2, [pt(g.xs[0]! + 10, g.ys[2]! + 20), pt(g.xs[1]! - 10, g.ys[2]! + 20)]), "word");
		const answer = withId(createStroke("#000000", 2, [pt(g.xs[1]! + 10, g.ys[2]! + 20), pt(g.xs[2]! - 10, g.ys[2]! + 20)]), "answer");
		p.strokes.push(word, answer);
		const cover = tape("t", { x: g.xs[1]! + 2, y: g.ys[0]! + 2, width: g.xs[2]! - g.xs[1]! - 4, height: g.ys[3]! - g.ys[0]! - 4 });
		p.elements = [cover];
		expect(strokeTouchesTapes(answer, [cover])).toBe(true);
		const edit = insertRow(table.grid, 0)!;
		// What the view used to pass (ink outside tapes): the answer would stay behind while its word moves down a row.
		const split = planTableEdit(p, table, edit, p.strokes.filter((s) => !strokeTouchesTapes(s, [cover])));
		expect(split.ok).toBe(true);
		const plan = planTableEdit(p, table, edit, p.strokes);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(history.execute(plan.cmd)).toBe(true);
		const by = edit.shift!.by;
		const after = (id: string) => p.strokes.find((s) => s.id === id)!;
		expect(after("word").points[0]![1]).toBeCloseTo(word.points[0]![1] + by, 1);
		expect(after("answer").points[0]![1]).toBeCloseTo(answer.points[0]![1] + by, 1);
	});
});

describe("R3: Delete and Cut ask first when the selection holds covered content", () => {
	const cover = tape("t");
	const answer = withId(line(110, 120, 190, 120), "ans");
	const beside = withId(line(300, 120, 380, 120), "b");
	const text: TextElement = { id: "x", type: "text", x: 110, y: 105, width: 60, text: "42", fontSize: 14, color: "#000000" };

	it("covered ink or an object under a hidden tape counts; a tape alone, ink beside it or no hidden tape does not", () => {
		expect(selectionHoldsCovered([answer], [], [cover])).toBe(true);
		expect(selectionHoldsCovered([], [text], [cover])).toBe(true);
		expect(selectionHoldsCovered([beside, answer], [cover], [cover])).toBe(true); // the tape with what it covers
		expect(selectionHoldsCovered([beside], [cover], [cover])).toBe(false);
		expect(selectionHoldsCovered([answer], [text], [])).toBe(false); // revealed: nothing is hidden
	});

	it("the view asks through the destructive confirmation, in English and Italian, and the delete-ink offer counts only visible ink", () => {
		const body = viewSrc.slice(viewSrc.indexOf("\tdeleteSelection(): void {"), viewSrc.indexOf("private deleteSelectionNow("));
		expect(body).toContain("if (this.selectionCovered(sel))");
		expect(body).toContain("confirmDestructive(");
		expect(body).toContain("this.selection === sel");
		expect(en["tape.delete.body"]).toBe("This selection includes content hidden under study tapes. Delete it anyway?");
		expect(it_["tape.delete.body"]?.length ?? 0).toBeGreaterThan(20);
		expect(it_["tape.delete.title"]?.length ?? 0).toBeGreaterThan(5);
		expect(it_["tape.delete.confirm"]).toBe("Elimina");
		expect(viewSrc).toContain("inkOnRemoved(this.inkOutsideTapes(page)");
		expect(viewSrc).toContain("const visible = new Set(this.inkOutsideTapes(page))");
		expect(viewSrc).toContain("selectionCovered: () => this.selectionCovered()");
	});
});

describe("R4, R5, R6: text tool, Insert space and reference windows", () => {
	it("R4: a text-tool tap on a hidden tape opens no covered text box", () => {
		const body = viewSrc.slice(viewSrc.indexOf("private beginText(pageIndex: number"), viewSrc.indexOf("private commitText(): void"));
		expect(body).toContain("pointUnderTapes(this.hidingTapesOf(page), local[0], local[1])");
		expect(body).toContain("const texts = onTape ? [] :");
	});

	it("R5: ink a tape reaches over moves with the tape when the tape straddles the line", () => {
		const cover = tape("t", { x: 100, y: 100, width: 100, height: 40 }); // centre 120
		const covered = withId(line(110, 98, 190, 108), "c"); // centre ~103, above the line, reaching under the tape
		const above = withId(line(110, 50, 190, 50), "a");
		const doc = docWith([cover], [above, covered]);
		const a = analyseSpace(doc.pages, 0, 112, 40)!;
		expect(a).not.toBeNull();
		const moved = a.moves.map((m) => m.item.stroke?.id ?? m.item.element!.id).sort();
		expect(moved).toEqual(["c", "t"]);
		expect(a.staying.map((s) => s.stroke?.id)).toEqual(["a"]);
		// Without the tape the same stroke stays above the line.
		const plain = analyseSpace(docWith([], [above, covered]).pages, 0, 112, 40);
		expect(plain).toBeNull();
	});

	it("R6: both reference windows draw texts in the figure scope of the notebook they show", () => {
		expect(refSrc).toContain("withFigureLabels(pagesNow(), () => {");
		expect(pdfRefSrc).toContain("withFigureLabels(doc.pages, () => {");
	});
});
