import { describe, expect, it } from "vitest";
import {
	colName, evaluate, evaluateSheet, formulaOfText, parseFormula, refName, RESULT_MARK, rewriteWithResult, showValue, valueOfText, withResult,
	type CellValue, type SheetCell,
} from "../src/math/table-formula";

/** A 1-based table of plain values, one row per string array; a string starting with "=" is a formula. */
function sheet(rows: string[][]): CellValue[][] {
	return evaluateSheet(rows.map((r): SheetCell[] => r.map((s) => (s.startsWith("=") ? { formula: s.slice(1) } : { value: s }))));
}
const shown = (rows: string[][], r: number, c: number): string => showValue(sheet(rows)[r]![c]!);
/** One formula over a column of numbers in A1:A4 (the formula sits in B1). */
const calc = (f: string, col = ["10", "20", "30", "40"]): string => shown([[...[col[0]!], `=${f}`], ...col.slice(1).map((v) => [v, ""])], 0, 1);

describe("cell names", () => {
	it("names columns like a spreadsheet", () => {
		expect([0, 1, 25, 26, 27].map(colName)).toEqual(["A", "B", "Z", "AA", "AB"]);
		expect(refName(0, 0)).toBe("A1");
		expect(refName(3, 2)).toBe("C4");
	});
});

describe("formula arithmetic (#147)", () => {
	it("works out numbers, precedence, parentheses and signs", () => {
		expect(calc("1+2*3")).toBe("7");
		expect(calc("(1+2)*3")).toBe("9");
		expect(calc("-2^2")).toBe("-4");
		expect(calc("2^3^2")).toBe("512");
		expect(calc("2^-1")).toBe("0.5");
		expect(calc("10/4")).toBe("2.5");
		expect(calc(" 1 + 2 ")).toBe("3");
		expect(calc(".5+1e1")).toBe("10.5");
		expect(calc("0.1+0.2")).toBe("0.3");
	});
	it("reads cell references and ignores the dollar signs", () => {
		expect(calc("A1*A2")).toBe("200");
		expect(calc("$A$1+a2")).toBe("30");
		expect(calc("A4/A1")).toBe("4");
	});
	it("reads a postfix percentage", () => {
		expect(calc("50%")).toBe("0.5");
		expect(calc("A1*10%")).toBe("1");
		expect(calc("A2+A2*15%")).toBe("23");
		expect(calc("200%")).toBe("2");
	});
	it("takes the typographic operators", () => {
		expect(calc("6" + String.fromCharCode(0xd7) + "7")).toBe("42");
		expect(calc("8" + String.fromCharCode(0xf7) + "2")).toBe("4");
		expect(calc("5" + String.fromCharCode(0x2212) + "7")).toBe("-2");
	});
});

describe("formula functions (#147)", () => {
	it("sums, averages, counts and finds extremes over ranges", () => {
		expect(calc("SUM(A1:A4)")).toBe("100");
		expect(calc("AVG(A1:A4)")).toBe("25");
		expect(calc("AVERAGE(A1:A4)")).toBe("25");
		expect(calc("MIN(A1:A4)")).toBe("10");
		expect(calc("MAX(A1:A4)")).toBe("40");
		expect(calc("COUNT(A1:A4)")).toBe("4");
		expect(calc("MEDIAN(A1:A4)")).toBe("25");
		expect(calc("MEDIAN(A1:A3)")).toBe("20");
		expect(calc("PRODUCT(A1:A2)")).toBe("200");
	});
	it("is not case sensitive and accepts the Italian names", () => {
		expect(calc("sum(a1:a4)")).toBe("100");
		expect(calc("SOMMA(A1:A4)")).toBe("100");
		expect(calc("MEDIA(A1:A4)")).toBe("25");
		expect(calc("CONTA(A1:A4)")).toBe("4");
	});
	it("mixes numbers, cells and ranges, with , or ; between arguments", () => {
		expect(calc("SUM(A1, 5, A3:A4)")).toBe("85");
		expect(calc("MAX(A1;A2;99)")).toBe("99");
		expect(calc("SUM(A1:A2)/SUM(A1:A4)*100")).toBe("30");
	});
	it("takes a range in any corner order", () => {
		expect(calc("SUM(A4:A1)")).toBe("100");
	});
	it("skips text and empty cells inside a range, as a spreadsheet does", () => {
		expect(calc("SUM(A1:A4)", ["1", "n/a", "", "4"])).toBe("5");
		expect(calc("COUNT(A1:A4)", ["1", "n/a", "", "4"])).toBe("2");
		expect(calc("AVG(A1:A4)", ["1", "n/a", "", "5"])).toBe("3");
	});
	it("has an answer for ranges without a number", () => {
		expect(calc("SUM(A1:A2)", ["x", "y"])).toBe("0");
		expect(calc("MIN(A1:A2)", ["x", "y"])).toBe("0");
		expect(calc("AVG(A1:A2)", ["x", "y"])).toBe("#DIV/0");
		expect(calc("MEDIAN(A1:A2)", ["x", "y"])).toBe("#NUM");
	});
	it("has ABS, SQRT, ROUND and PCT", () => {
		expect(calc("ABS(-3)")).toBe("3");
		expect(calc("SQRT(16)")).toBe("4");
		expect(calc("SQRT(-1)")).toBe("#NUM");
		expect(calc("ROUND(2.5)")).toBe("3");
		expect(calc("ROUND(-2.5)")).toBe("-3");
		expect(calc("ROUND(1.005,2)")).toBe("1.01");
		expect(calc("ROUND(3.14159, 3)")).toBe("3.142");
		expect(calc("PCT(A1, A4)")).toBe("25");
		expect(calc("PCT(1,0)")).toBe("#DIV/0");
	});
});

describe("formula errors are values (#147)", () => {
	it("says #DIV/0, #REF, #VALUE, #NAME, #NUM and #ERR", () => {
		expect(calc("1/0")).toBe("#DIV/0");
		expect(calc("A1/(A2-A2)")).toBe("#DIV/0");
		expect(calc("0^-1")).toBe("#DIV/0");
		expect(calc("Z9")).toBe("#REF");
		expect(calc("SUM(A1:A9)")).toBe("#REF");
		expect(calc("SUM(Z1)")).toBe("#REF");
		expect(calc("A1+B")).toBe("#NAME");
		expect(calc("FOO(1)")).toBe("#NAME");
		expect(calc("2^2000")).toBe("#NUM");
		expect(calc("1+")).toBe("#ERR");
		expect(calc("(1")).toBe("#ERR");
		expect(calc("1 2")).toBe("#ERR");
		expect(calc("SUM()")).toBe("#ERR");
		expect(calc("SUM")).toBe("#ERR");
		expect(calc("ABS(1,2)")).toBe("#ERR");
		expect(calc("1 $ 2")).toBe("#ERR");
	});
	it("says #VALUE for text where a number is needed and for a range in arithmetic", () => {
		expect(calc("A1+1", ["abc", "2"])).toBe("#VALUE");
		expect(calc("A1:A2+1")).toBe("#VALUE");
		expect(calc("ABS(A1:A2)")).toBe("#VALUE");
		expect(calc("A1:A2")).toBe("#VALUE");
	});
	it("takes an empty cell as 0 in arithmetic", () => {
		expect(calc("A1+1", ["", "2"])).toBe("1");
	});
	it("passes an error on to every formula that uses it", () => {
		const rows = [["=1/0", "=A1+1", "=SUM(A1:B1)"]];
		expect(sheet(rows)[0]!.map(showValue)).toEqual(["#DIV/0", "#DIV/0", "#DIV/0"]);
	});
	it("refuses a hostile formula without overflowing the stack", () => {
		expect(parseFormula("(".repeat(500))).toEqual({ ok: false, code: "#ERR" });
		expect(parseFormula("-".repeat(200) + "1")).toEqual({ ok: false, code: "#ERR" });
		expect(parseFormula("1+".repeat(300) + "1").ok).toBe(false);
		expect(parseFormula("")).toEqual({ ok: false, code: "#ERR" });
	});
});

describe("cycles (#147)", () => {
	it("marks a cell that uses itself", () => {
		expect(shown([["=A1+1"]], 0, 0)).toBe("#CYCLE");
	});
	it("marks cells that use each other, and the formulas that depend on them", () => {
		const out = sheet([["=B1", "=A1", "=A1+5", "7", "=D1*2"]])[0]!.map(showValue);
		expect(out).toEqual(["#CYCLE", "#CYCLE", "#CYCLE", "7", "14"]);
	});
	it("marks a longer loop and leaves the rest of the sheet alone", () => {
		const out = sheet([["=B1", "=C1", "=A1"], ["1", "=A2+1", "=SUM(A2:B2)"]]);
		expect(out[0]!.map(showValue)).toEqual(["#CYCLE", "#CYCLE", "#CYCLE"]);
		expect(out[1]!.map(showValue)).toEqual(["1", "2", "3"]);
	});
});

describe("formulas that use formulas (#147)", () => {
	it("follows a chain whatever the order of the cells", () => {
		const out = sheet([["=B2+1", "2"], ["=A1*2", "=B1*10"]]);
		expect(out[0]!.map(showValue)).toEqual(["21", "2"]);
		expect(out[1]!.map(showValue)).toEqual(["42", "20"]);
	});
	it("builds a total row", () => {
		const out = sheet([["Item", "Qty", "Price", "Cost"], ["pen", "3", "1,5", "=B2*C2"], ["ink", "2", "4", "=B3*C3"], ["Total", "=SUM(B2:B3)", "", "=SUM(D2:D3)"]]);
		expect(showValue(out[1]![3]!)).toBe("4.5");
		expect(showValue(out[2]![3]!)).toBe("8");
		expect(showValue(out[3]![1]!)).toBe("5");
		expect(showValue(out[3]![3]!)).toBe("12.5");
	});
	it("takes a typed percentage and a decimal comma as numbers", () => {
		expect(valueOfText("20 %")).toEqual({ k: "num", v: 0.2 });
		expect(valueOfText("3,5")).toEqual({ k: "num", v: 3.5 });
		expect(valueOfText("")).toEqual({ k: "blank" });
		expect(valueOfText("kg")).toEqual({ k: "text" });
		expect(valueOfText("%")).toEqual({ k: "text" });
		expect(shown([["200", "15%", "=A1*B1"]], 0, 2)).toBe("30");
	});
	it("evaluates one parsed formula over any source", () => {
		const p = parseFormula("A1+B1");
		if (!p.ok) throw new Error("parse");
		const at = (r: number, c: number): CellValue => ({ k: "num", v: r * 10 + c + 1 });
		expect(evaluate(p.node, { rows: 2, cols: 2, at })).toEqual({ k: "num", v: 3 });
		expect(evaluate(p.node, { rows: 1, cols: 1, at })).toEqual({ k: "err", code: "#REF" });
	});
});

describe("formula boxes (#147)", () => {
	it("reads a formula and drops an old result", () => {
		expect(formulaOfText("=SUM(B1:B4)")).toEqual({ src: "SUM(B1:B4)", typed: "=SUM(B1:B4)" });
		expect(formulaOfText("  = A1 + 2  ")).toEqual({ src: "A1 + 2", typed: "= A1 + 2" });
		expect(formulaOfText(`=SUM(B1:B4) ${RESULT_MARK} 100`)).toEqual({ src: "SUM(B1:B4)", typed: "=SUM(B1:B4)" });
		expect(formulaOfText("=A1\n+2")).toEqual({ src: "A1 +2", typed: "=A1 +2" });
	});
	it("is not a formula without text after the equals sign, or without the sign first", () => {
		for (const s of ["", "=", "  =  ", "total = 4", "1+1", "a=b"]) expect(formulaOfText(s)).toBeNull();
	});
	it("writes the result after the formula, and the written text reads back to the same formula", () => {
		const text = withResult("=A1*2", "42");
		expect(text).toBe(`=A1*2 ${RESULT_MARK} 42`);
		expect(formulaOfText(text)?.typed).toBe("=A1*2");
		expect(formulaOfText(withResult("=A1*2", "#DIV/0"))?.src).toBe("A1*2");
	});
});

describe("formula boxes with notes (review 0.30 I7)", () => {
	it("reads the formula before the arrow and ignores the person's words after the result", () => {
		expect(formulaOfText(`=B2*C2 ${RESULT_MARK} 120 (checked by hand)`)).toEqual({ src: "B2*C2", typed: "=B2*C2" });
		expect(formulaOfText("=A1+B1\n(net of VAT)")).toEqual({ src: "A1+B1", typed: "=A1+B1" });
	});
	it("rewrites only the result it owns", () => {
		expect(rewriteWithResult("=A1*2", "42")).toBe(`=A1*2 ${RESULT_MARK} 42`);
		// Review R3: a number with words right after it on its line may be the person's own: it is kept behind the new result.
		expect(rewriteWithResult(`=A1*2 ${RESULT_MARK} 120 (checked)`, "42")).toBe(`=A1*2 ${RESULT_MARK} 42 ${RESULT_MARK} 120 (checked)`);
		expect(rewriteWithResult(`=A1*2 ${RESULT_MARK} 42 ${RESULT_MARK} 120 (checked)`, "43")).toBe(`=A1*2 ${RESULT_MARK} 43 ${RESULT_MARK} 120 (checked)`);
		expect(rewriteWithResult(`=A1*2 ${RESULT_MARK} 120\n(checked)`, "42")).toBe(`=A1*2 ${RESULT_MARK} 42\n(checked)`);
		expect(rewriteWithResult(`=A1*2 ${RESULT_MARK} 1.5e-7`, "42")).toBe(`=A1*2 ${RESULT_MARK} 42`);
		expect(rewriteWithResult(`=A1*2 ${RESULT_MARK} #DIV/0`, "42")).toBe(`=A1*2 ${RESULT_MARK} 42`);
		expect(rewriteWithResult("1+1", "2")).toBeNull();
	});
});

describe("formula boxes, round 2 (review 0.30 R2, R3)", () => {
	it("R2: a line that continues the formula is part of it, so a mistake there is an error, not a result of the lines above", () => {
		expect(formulaOfText("=B2*C2\n-D2 (discount)")?.typed).toBe("=B2*C2 -D2 (discount)");
		expect(parseFormula("B2*C2 -D2 (discount)").ok).toBe(false);
		for (const op of ["+", "*", "/", "^", "&", ",", ";", ")"]) expect(formulaOfText(`=A1\n${op}B1 x`)?.typed).toBe(`=A1 ${op}B1 x`);
		// A note that does not start with an operator is still a note.
		expect(formulaOfText("=A1+B1\n(net of VAT)")?.typed).toBe("=A1+B1");
		expect(formulaOfText("=A1\n+B1\nchecked")?.typed).toBe("=A1 +B1");
	});

	it("T1: a bullet note (an operator, a blank and a plain word) is a note; operators with a reference, a number, a call or a bracket continue", () => {
		for (const note of ["- includes VAT", "* see p. 4", "+ rounded", "  - net of VAT", "- già arrotondato", "- AB is a note"]) {
			expect(formulaOfText(`=SUM(B1:B4)\n${note}`)?.typed).toBe("=SUM(B1:B4)");
		}
		expect(formulaOfText("=SUM(B1:B4)\n- includes VAT\n- rounded")?.typed).toBe("=SUM(B1:B4)");
		for (const cont of ["-D2", "- D2", "+ B3", "* 2", "/ (A1+A2)", "+SUM(A1:A2)", "- SUM(A1:A2)", "- AB12", "- ROUND (A1, 2)"]) {
			expect(formulaOfText(`=A1\n${cont}`)?.typed).toBe(`=A1 ${cont.trim()}`);
		}
		// A bullet note under a formula keeps the formula's result, and Compute is stable on it.
		const once = rewriteWithResult("=A1*2\n- includes VAT", "20");
		expect(once).toBe(`=A1*2 ${RESULT_MARK} 20\n- includes VAT`);
		expect(rewriteWithResult(once!, "20")).toBe(once);
	});

	it("R3: a number the person wrote after their own arrow is never replaced; Compute's results are", () => {
		expect(rewriteWithResult(`=A1 ${RESULT_MARK} 3 apples`, "7")).toBe(`=A1 ${RESULT_MARK} 7 ${RESULT_MARK} 3 apples`);
		expect(rewriteWithResult(`=A1 ${RESULT_MARK} 7 ${RESULT_MARK} 3 apples`, "8")).toBe(`=A1 ${RESULT_MARK} 8 ${RESULT_MARK} 3 apples`);
		// Compute's own shapes: a result alone, before a line break, before a second arrow, or an error code.
		expect(rewriteWithResult(`=A1 ${RESULT_MARK} 3`, "7")).toBe(`=A1 ${RESULT_MARK} 7`);
		expect(rewriteWithResult(`=A1 ${RESULT_MARK} #REF see p.3`, "7")).toBe(`=A1 ${RESULT_MARK} 7 ${RESULT_MARK} see p.3`);
	});

	it("R3: a blank or text value shows '-', so annotations kept behind it never collect a second arrow", () => {
		const first = rewriteWithResult(`=A1 ${RESULT_MARK} 5 ${RESULT_MARK} checked`, showValue({ k: "blank" }));
		expect(first).toBe(`=A1 ${RESULT_MARK} - ${RESULT_MARK} checked`);
		expect(rewriteWithResult(first!, "6")).toBe(`=A1 ${RESULT_MARK} 6 ${RESULT_MARK} checked`);
		expect(rewriteWithResult("=A1", "")).toBe(`=A1 ${RESULT_MARK} -`);
	});
});
