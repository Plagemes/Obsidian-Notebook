import { describe, expect, it } from "vitest";
import { planTableCompute, readFormulaGrid } from "../src/ink/table-compute";
import type { TableGrid } from "../src/ink/table";
import { createDocument } from "../src/model/document";
import { History } from "../src/model/history";
import { serializeChecked } from "../src/model/serialize";
import type { EquationElement, Page, TapeElement, TextElement } from "../src/model/types";
import { RESULT_MARK } from "../src/math/table-formula";

const NOW = new Date("2026-11-10T10:00:00.000Z");
/** 4 columns x 5 rows of 60 x 30 cells with the top-left corner at (20, 20). */
const grid: TableGrid = { xs: [20, 80, 140, 200, 260], ys: [20, 50, 80, 110, 140, 170] };
let n = 0;

function setup() {
	const doc = createDocument(NOW);
	const p = doc.pages[0]!;
	const history = new History(() => doc, 100);
	return { doc, p, history };
}

/** A text box inside cell (r, c) (0-based). */
const box = (r: number, c: number, text: string, extra: Partial<TextElement> = {}): TextElement => ({
	id: `t${++n}`, type: "text", x: grid.xs[c]! + 4, y: grid.ys[r]! + 4, width: 50, text, fontSize: 12, color: "#000000", ...extra,
});

function fill(p: Page, cells: Record<string, string>): Map<string, TextElement> {
	const out = new Map<string, TextElement>();
	p.elements = p.elements ?? [];
	for (const [k, text] of Object.entries(cells)) {
		const r = Number(k.split(",")[0]);
		const c = Number(k.split(",")[1]);
		const el = box(r, c, text);
		out.set(k, el);
		p.elements.push(el);
	}
	return out;
}

const texts0 = (p: Page): string[] => (p.elements ?? []).map((e) => (e.type === "text" ? e.text : ""));

describe("reading a table's formulas (#147)", () => {
	it("tells formula boxes from values by position, and ignores boxes outside the table", () => {
		const { p } = setup();
		fill(p, { "0,0": "10", "1,0": "20", "2,0": "=SUM(A1:A2)" });
		p.elements!.push(box(0, 0, "outside", { x: 400 }), { id: "eq", type: "equation", x: grid.xs[1]! + 5, y: grid.ys[0]! + 5, width: 40, height: 20, latex: "7", color: "#000" } as EquationElement);
		const sheet = readFormulaGrid(grid, p.elements!);
		expect(sheet.rows).toBe(5);
		expect(sheet.cols).toBe(4);
		expect([...sheet.boxes.keys()]).toEqual(["2,0"]);
		expect(sheet.cells[0]![0]).toEqual({ value: "10" });
		expect(sheet.cells[0]![1]).toEqual({ value: "7" });
		expect(sheet.cells[2]![0]).toEqual({ formula: "SUM(A1:A2)" });
		expect(sheet.cells[4]![3]).toEqual({ value: "" });
	});
	it("joins the boxes of a cell without a formula and lets the first formula box win", () => {
		const { p } = setup();
		p.elements = [box(0, 0, "3"), { ...box(0, 0, "kg"), x: grid.xs[0]! + 30 }, box(1, 1, "=1+1"), { ...box(1, 1, "=9"), y: grid.ys[1]! + 14 }];
		const sheet = readFormulaGrid(grid, p.elements);
		expect(sheet.cells[0]![0]).toEqual({ value: "3 kg" });
		expect(sheet.cells[1]![1]).toEqual({ formula: "1+1" });
	});
});

describe("Compute table (#147)", () => {
	it("writes each result after its formula in one undo step", () => {
		const { doc, p, history } = setup();
		const b = fill(p, { "0,0": "Qty", "1,0": "3", "2,0": "4", "3,0": "=SUM(A2:A3)", "3,1": "=A4*2", "4,0": "=AVG(A2:A3)" });
		const plan = planTableCompute(p, grid);
		if (!plan.ok) throw new Error(plan.reason);
		expect(plan.summary).toEqual({ formulas: 3, changed: 3, errors: 0 });
		expect(history.execute(plan.cmd)).toBe(true);
		expect(texts0(p)).toContain(`=SUM(A2:A3) ${RESULT_MARK} 7`);
		const texts = p.elements!.map((e) => (e.type === "text" ? e.text : ""));
		expect(texts).toContain(`=A4*2 ${RESULT_MARK} 14`);
		expect(texts).toContain(`=AVG(A2:A3) ${RESULT_MARK} 3.5`);
		expect(texts).toContain("3");
		expect(() => serializeChecked(doc)).not.toThrow();
		history.undo();
		expect(p.elements!.map((e) => (e.type === "text" ? e.text : ""))).toEqual(["Qty", "3", "4", "=SUM(A2:A3)", "=A4*2", "=AVG(A2:A3)"]);
		expect(p.elements!.find((e) => e.id === b.get("3,0")!.id)).toBe(b.get("3,0"));
		history.redo();
		expect(texts).toContain(`=A4*2 ${RESULT_MARK} 14`);
		expect(p.elements!.map((e) => (e.type === "text" ? e.text : "")).filter((s) => s.includes(RESULT_MARK))).toHaveLength(3);
	});

	it("keeps the formula recoverable: changing a number and computing again updates the result", () => {
		const { p, history } = setup();
		fill(p, { "0,0": "5", "1,0": "=A1*2" });
		const first = planTableCompute(p, grid);
		if (!first.ok) throw new Error(first.reason);
		history.execute(first.cmd);
		const again = planTableCompute(p, grid);
		expect(again).toMatchObject({ ok: false, reason: "same" });
		const numberBox = p.elements!.find((e) => e.type === "text" && e.text === "5")!;
		p.elements![p.elements!.indexOf(numberBox)] = { ...numberBox, text: "8" } as TextElement;
		const second = planTableCompute(p, grid);
		if (!second.ok) throw new Error(second.reason);
		history.execute(second.cmd);
		expect(p.elements!.map((e) => (e.type === "text" ? e.text : ""))).toEqual(["8", `=A1*2 ${RESULT_MARK} 16`]);
	});

	it("shows errors as codes and counts them", () => {
		const { p, history } = setup();
		fill(p, { "0,0": "0", "0,1": "=1/A1", "0,2": "=Z99", "0,3": "=B2", "1,1": "=A2", "1,0": "=B2" });
		const plan = planTableCompute(p, grid);
		if (!plan.ok) throw new Error(plan.reason);
		expect(plan.summary.errors).toBe(5);
		history.execute(plan.cmd);
		const texts = p.elements!.map((e) => (e.type === "text" ? e.text : ""));
		expect(texts).toContain(`=1/A1 ${RESULT_MARK} #DIV/0`);
		expect(texts).toContain(`=Z99 ${RESULT_MARK} #REF`);
		expect(texts).toContain(`=B2 ${RESULT_MARK} #CYCLE`);
		expect(texts).toContain(`=A2 ${RESULT_MARK} #CYCLE`);
	});

	it("refuses a table with no formula, and says nothing changes when all results are shown", () => {
		const { p } = setup();
		fill(p, { "0,0": "1", "0,1": "2" });
		expect(planTableCompute(p, grid)).toEqual({ ok: false, reason: "none" });
	});

	it("refuses when a formula box is locked, and when it is part of a drawing with states", () => {
		const a = setup();
		a.p.elements = [box(0, 0, "=1+1", { locked: true })];
		expect(planTableCompute(a.p, grid)).toMatchObject({ ok: false, reason: "locked" });
		const b = setup();
		const el = box(0, 0, "=1+1");
		b.p.elements = [el];
		b.p.states = { parts: [{ id: "part", items: [el.id], pivot: [0, 0] }], states: [] } as unknown as Page["states"];
		expect(planTableCompute(b.p, grid)).toMatchObject({ ok: false, reason: "states" });
	});

	it("fails closed on redaction: a box over the table, over a result, or unreadable boxes", () => {
		const { p } = setup();
		fill(p, { "0,0": "42", "1,0": "=B2" });
		expect(planTableCompute(p, grid, { boxes: [] })).toMatchObject({ ok: true });
		// over the secret number the formula reads, even though the box does not touch the formula box
		expect(planTableCompute(p, grid, { boxes: [{ x: grid.xs[0]!, y: grid.ys[0]!, width: 40, height: 20 }] })).toMatchObject({ ok: false, reason: "redacted" });
		// over the formula box
		expect(planTableCompute(p, grid, { boxes: [{ x: grid.xs[0]!, y: grid.ys[1]!, width: 40, height: 20 }] })).toMatchObject({ ok: false, reason: "redacted" });
		// far away: no effect
		expect(planTableCompute(p, grid, { boxes: [{ x: 400, y: 600, width: 50, height: 50 }] })).toMatchObject({ ok: true });
		expect(planTableCompute(p, grid, { boxes: [], unreadable: true })).toMatchObject({ ok: false, reason: "redacted" });
	});

	it("does not touch the guard when nothing is to be written", () => {
		const { p } = setup();
		fill(p, { "0,0": "1" });
		expect(planTableCompute(p, grid, { boxes: [], unreadable: true })).toEqual({ ok: false, reason: "none" });
	});
});


describe("Compute keeps the words it did not write (review 0.30 I7)", () => {
	/** Computes the table and returns the text of the one box it rewrites. */
	function computeOne(text: string, other: Record<string, string> = { "0,0": "10", "0,1": "12" }): { before: string; after: string; again: string } {
		const { p, history } = setup();
		const target = box(2, 0, text);
		fill(p, other);
		p.elements!.push(target);
		const plan = planTableCompute(p, grid);
		if (!plan.ok) throw new Error(plan.reason);
		history.execute(plan.cmd);
		const after = (p.elements!.find((e) => e.id === target.id) as TextElement).text;
		const again = planTableCompute(p, grid);
		return { before: text, after, again: again.ok ? "changes" : again.reason };
	}

	it("replaces only the value after the arrow and keeps the person's annotation", () => {
		// Review R3: "99 (checked by hand)" on one line may be the person's own number: it is kept behind the new result.
		const r = computeOne(`=A1*2 ${RESULT_MARK} 99 (checked by hand)`);
		expect(r.after).toBe(`=A1*2 ${RESULT_MARK} 20 ${RESULT_MARK} 99 (checked by hand)`);
		expect(r.again).toBe("same");
		const own = computeOne(`=A1*2 ${RESULT_MARK} 99`);
		expect(own.after).toBe(`=A1*2 ${RESULT_MARK} 20`);
		const e = computeOne(`=SUM(A1:B1) ${RESULT_MARK} #REF see p.3`);
		expect(e.after).toBe(`=SUM(A1:B1) ${RESULT_MARK} 22 ${RESULT_MARK} see p.3`);
		expect(e.again).toBe("same");
	});

	it("review R2: a formula continued on a line below with a mistake gives #ERR, not the value of the first line", () => {
		const r = computeOne("=A1*2\n-B1 (discount)");
		expect(r.after).toMatch(new RegExp(`${RESULT_MARK} #[A-Z]+$`)); // an error code (here #NAME), never 20
		expect(r.after).toContain("(discount)");
	});

	it("keeps the box's line breaks and a note on a line below the formula", () => {
		const r = computeOne("=A1+B1\n(net of VAT)");
		expect(r.after).toBe(`=A1+B1 ${RESULT_MARK} 22\n(net of VAT)`);
		expect(r.again).toBe("same");
		const s = computeOne(`=A1+B1 ${RESULT_MARK} 5\n(net of VAT)\nsecond note`);
		expect(s.after).toBe(`=A1+B1 ${RESULT_MARK} 22\n(net of VAT)\nsecond note`);
		const wrapped = computeOne("=A1\n+B1");
		expect(wrapped.after).toBe(`=A1\n+B1 ${RESULT_MARK} 22`);
		expect(wrapped.again).toBe("same");
	});

	it("keeps text after an arrow that is not a result, behind the new result, and is idempotent", () => {
		const r = computeOne(`=A1*2 ${RESULT_MARK} my note`);
		expect(r.after).toBe(`=A1*2 ${RESULT_MARK} 20 ${RESULT_MARK} my note`);
		expect(r.again).toBe("same");
		const n = computeOne(`=A1*2 ${RESULT_MARK}\nsee p.3`);
		expect(n.after).toContain("see p.3");
		expect(n.again).toBe("same");
		const arrowInNote = computeOne(`=A1\n(see ${RESULT_MARK} p.3)`);
		expect(arrowInNote.after).toBe(`=A1 ${RESULT_MARK} 10\n(see ${RESULT_MARK} p.3)`);
		expect(arrowInNote.again).toBe("same");
	});

	it("never drops a word of any box it rewrites", () => {
		for (const text of [`=A1 ${RESULT_MARK} 1 alpha beta`, "=A1\nalpha\nbeta", `=A1 ${RESULT_MARK} x alpha`, "=A1 alpha"]) {
			const r = computeOne(text);
			for (const word of ["alpha", "beta"]) if (text.includes(word)) expect(r.after).toContain(word);
		}
	});
});

describe("Compute and study tapes (review 0.30 I16)", () => {
	it("refuses when a formula box that would be written lies under a tape, and does not mind a tape elsewhere", () => {
		const { p } = setup();
		fill(p, { "0,0": "4", "1,0": "=A1*2" });
		const under = { id: "tp", type: "tape", x: grid.xs[0]!, y: grid.ys[1]!, width: 50, height: 20, color: "#ffd60a" } as unknown as TapeElement;
		p.elements!.push(under);
		expect(planTableCompute(p, grid)).toMatchObject({ ok: false, reason: "tape" });
		const far = { ...under, x: 400, y: 600 };
		p.elements![p.elements!.length - 1] = far;
		expect(planTableCompute(p, grid)).toMatchObject({ ok: true });
	});
});
