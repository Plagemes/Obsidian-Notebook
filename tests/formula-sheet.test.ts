// 0.23 (#249) Formula sheet: collection order, LaTeX escaping, the Markdown section and marker safety.
import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import {
	FORMULA_END, FORMULA_START, buildFormulaSection, collectFormulas, formulaLatex, formulaRegionOf, formulaStartMarker, newFormulaNote, pickFormulaNote, replaceFormulaSection,
} from "../src/model/formula-sheet";
import type { EquationElement, Page } from "../src/model/types";

let n = 0;
function eq(latex: string, x: number, y: number, extra: Partial<EquationElement> = {}): EquationElement {
	return { id: `e${++n}`, type: "equation", x, y, width: 100, height: 40, latex, fontSize: 18, color: "#000000", ...extra };
}
function pageWith(...els: EquationElement[]): Page {
	const p = createPage({ width: 600, height: 800 });
	p.elements = els;
	return p;
}
const section = (entries: ReturnType<typeof collectFormulas>, owner?: string, id?: string) =>
	buildFormulaSection({ entries, pageLink: (p) => `[[Nb#page=${p}|p. ${p}]]`, intro: "Intro", none: "None", owner, ownerId: id });

describe("collection order", () => {
	it("goes page by page, rows top to bottom, then left to right inside a row", () => {
		const p1 = pageWith(eq("c", 300, 210), eq("a", 50, 100), eq("b", 300, 108), eq("d", 50, 400));
		const p2 = pageWith(eq("z", 10, 10));
		const out = collectFormulas([p1, p2]);
		expect(out.map((f) => f.latex)).toEqual(["a", "b", "c", "d", "z"]);
		expect(out.map((f) => f.pageIndex)).toEqual([0, 0, 0, 0, 1]);
	});

	it("skips empty equations and non-equation elements, and tolerates a page without elements", () => {
		const p = pageWith(eq("  \n ", 0, 0), eq("x^2", 0, 50));
		const bare = createPage({ width: 600, height: 800 });
		delete (bare as { elements?: unknown }).elements;
		expect(collectFormulas([bare, p]).map((f) => f.latex)).toEqual(["x^2"]);
	});

	it("carries the equation number of a numbered equation", () => {
		const out = collectFormulas([pageWith(eq("a", 0, 0, { numbered: true }), eq("b", 0, 100)), pageWith(eq("c", 0, 0, { numbered: true }))]);
		expect(out.map((f) => f.number)).toEqual([1, undefined, 2]);
	});
});

describe("LaTeX escaping", () => {
	it("escapes a dollar sign, keeps an already escaped one, drops blank lines", () => {
		expect(formulaLatex("a \\$ + $b$\n\n\n c")).toBe("a \\$ + \\$b\\$\n c");
	});

	it("cannot close the region or open a comment", () => {
		const s = formulaLatex("x --> y <!-- z");
		expect(s).not.toContain("-->");
		expect(s).not.toContain("<!--");
	});

	it("cuts an overlong source at a line end", () => {
		const long = Array.from({ length: 2000 }, (_, i) => `x_{${i}}`).join("\n");
		const s = formulaLatex(long);
		expect(s.length).toBeLessThanOrEqual(4000);
		expect(long.startsWith(s)).toBe(true);
		expect(s.endsWith("}")).toBe(true);
	});
});

describe("section", () => {
	const entries = collectFormulas([pageWith(eq("a^2+b^2=c^2", 0, 0, { numbered: true })), pageWith(), pageWith(eq("E=mc^2", 0, 0))]);

	it("writes a heading with a link per page and a $$ block per formula, deterministically", () => {
		const s = section(entries, "A/Nb.notebook", "doc1");
		expect(s.startsWith(formulaStartMarker("A/Nb.notebook", "doc1"))).toBe(true);
		expect(s.endsWith(FORMULA_END)).toBe(true);
		expect(s).toContain("### [[Nb#page=1|p. 1]]\n\n$$\na^2+b^2=c^2\n\\tag{1}\n$$");
		expect(s).toContain("### [[Nb#page=3|p. 3]]\n\n$$\nE=mc^2\n$$");
		expect(s).not.toContain("page=2");
		expect(section(entries, "A/Nb.notebook", "doc1")).toBe(s);
	});

	it("says so when there is nothing", () => {
		expect(section([])).toContain("None");
	});

	it("round-trips the owner in the marker (paths with -- and >)", () => {
		const s = section(entries, "My--Folder/Nb>x é.notebook", "id 1");
		expect(formulaRegionOf(s)).toEqual({ path: "My--Folder/Nb>x é.notebook", id: "id 1" });
		expect(formulaRegionOf(section(entries))).toEqual({ path: null, id: null });
		expect(formulaRegionOf("nothing")).toBeUndefined();
	});
});

describe("marker safety", () => {
	const mine = "Maths/Nb.notebook";
	const sec = (body: string) => section(collectFormulas([pageWith(eq(body, 0, 0))]), mine, "doc1");

	it("replaces only the region and keeps the text around it byte for byte", () => {
		const first = newFormulaNote("T", sec("a"));
		const edited = `Before\n\n${first.trimEnd()}\n\nAfter`;
		const r = replaceFormulaSection(edited, sec("b"), mine, { id: "doc1" });
		expect(r.outcome).toBe("replaced");
		expect(r.text.startsWith("Before\n\n# T\n\n")).toBe(true);
		expect(r.text.endsWith("\n\nAfter")).toBe(true);
		expect(r.text).toContain("\nb\n");
		expect(r.text).not.toContain("\na\n");
	});

	it("never rewrites a note with one marker missing", () => {
		const text = `Mine ${FORMULA_START} broken`;
		expect(replaceFormulaSection(text, sec("a"), mine)).toEqual({ text, outcome: "unsafe" });
		const text2 = `Mine ${FORMULA_END}`;
		expect(replaceFormulaSection(text2, sec("a"), mine)).toEqual({ text: text2, outcome: "unsafe" });
	});

	it("never overwrites a note that lost its markers: it asks (appended) and the caller refuses", () => {
		const text = "A note of mine";
		const r = replaceFormulaSection(text, sec("a"), mine);
		expect(r.outcome).toBe("appended");
		expect(r.text.startsWith("A note of mine\n\n")).toBe(true);
		expect(replaceFormulaSection("  \n", sec("a"), mine).outcome).toBe("created");
	});

	it("leaves the region of another notebook alone, but takes back a moved notebook's note by id or gone path", () => {
		const other = `x\n${formulaStartMarker("Other/Nb2.notebook", "doc2")}\nold\n${FORMULA_END}\n`;
		expect(replaceFormulaSection(other, sec("a"), mine, { id: "doc1" })).toEqual({ text: other, outcome: "other" });
		const moved = `x\n${formulaStartMarker("Old/Nb.notebook", "doc1")}\nold\n${FORMULA_END}\n`;
		expect(replaceFormulaSection(moved, sec("a"), mine, { id: "doc1" }).outcome).toBe("replaced");
		const pathOnly = `x\n${formulaStartMarker("Old/Nb.notebook")}\nold\n${FORMULA_END}\n`;
		expect(replaceFormulaSection(pathOnly, sec("a"), mine, { pathExists: () => false }).outcome).toBe("replaced");
		expect(replaceFormulaSection(pathOnly, sec("a"), mine, { pathExists: () => true }).outcome).toBe("other");
	});

	it("picks the plain name, its own note, or a numbered one when another notebook owns it", async () => {
		const slots = [{ exists: true, owner: "Other/Nb2.notebook", ownerId: "doc2" }, { exists: false }];
		expect(await pickFormulaNote(async (i) => slots[i - 1] ?? { exists: false }, mine, "doc1")).toBe(2);
		expect(await pickFormulaNote(async () => ({ exists: true, owner: mine, ownerId: "doc1" }), mine, "doc1")).toBe(1);
		expect(await pickFormulaNote(async () => ({ exists: true, owner: other() }), mine, "doc1")).toBeNull();
	});
});

function other(): string {
	return "Other/Nb2.notebook";
}

describe("review V9: every dollar sign is escaped, also after a line break", () => {
	it("escapes the dollar that follows a double backslash", () => {
		expect(formulaLatex("a \\\\$ b")).toBe("a \\\\\\$ b");
		expect(formulaLatex("x \\\\\n$y$")).toBe("x \\\\\n\\$y\\$");
	});
	it("keeps a dollar that is escaped already, with an odd run of backslashes", () => {
		expect(formulaLatex("cost \\$5")).toBe("cost \\$5");
		expect(formulaLatex("a \\\\\\$ b")).toBe("a \\\\\\$ b");
	});
	it("escapes a plain dollar and leaves other commands alone", () => {
		expect(formulaLatex("$x$ \\frac{a}{b} \\\\ c")).toBe("\\$x\\$ \\frac{a}{b} \\\\ c");
	});
	it("no dollar that is left unescaped can close the block", () => {
		for (const src of ["a\\\\$$b", "\\\\\\\\$ $", "x\\\\$\\\\$"]) {
			const out = formulaLatex(src);
			expect(/(^|[^\\])(\\\\)*\$/.test(out)).toBe(false);
		}
	});
});

describe("review V10: a note of the user's with the same name is never a dead end", () => {
	const me = "Maths/Nb.notebook";
	it("skips a note with text and no region of ours, a half-marked one and a folder, and takes the next free name", async () => {
		const slots: Array<{ exists: boolean; folder?: boolean; owner?: string | null }> = [{ exists: true, owner: undefined }, { exists: true, folder: true }, { exists: true, owner: undefined }, { exists: false }];
		expect(await pickFormulaNote(async (i) => slots[i - 1] ?? { exists: false }, me, "doc1")).toBe(4);
	});
	it("still takes its own note at any number, and a plain-marker note at the first name", async () => {
		expect(await pickFormulaNote(async (i) => (i === 1 ? { exists: true, owner: undefined } : { exists: true, owner: me, ownerId: "doc1" }), me, "doc1")).toBe(2);
		expect(await pickFormulaNote(async () => ({ exists: true, owner: null }), me, "doc1")).toBe(1);
	});
	it("gives up only when every name is taken by something that is not ours", async () => {
		expect(await pickFormulaNote(async () => ({ exists: true, owner: undefined }), me, "doc1")).toBeNull();
	});
});
