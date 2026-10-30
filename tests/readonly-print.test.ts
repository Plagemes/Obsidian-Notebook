// wave 0.10: read-only mode (51), PNG images, page ranges and printing (81). Pure logic only; the view is covered by the browser harness.
import { describe, expect, it, vi } from "vitest";
import { ACTIONS, baseContext, isChecked, isEnabled, isRelevant } from "../src/ui/actions";
import { placementsOf } from "../src/ui/layout";
import { InputPolicy } from "../src/ink/input-policy";
import { planExport } from "../src/ink/export-layers";
import { DEFAULT_PNG_SCALE, PNG_SCALES, isPngScale, planPageImages, scaleDpi } from "../src/model/export-pages";
import { renderSize } from "../src/model/export-markdown";
import { AddStroke, History } from "../src/model/history";
import { formatPageRange, parsePageRange } from "../src/model/page-range";
import { line, sampleDocument } from "./helpers";

vi.mock("obsidian", () => ({ getLanguage: () => "en" }));

const { commandActions } = await import("../src/view/commands");
const { rangeProblem } = await import("../src/view/range-text");

describe("page ranges (81)", () => {
	it("reads pages, ranges and open ends, as people write them", () => {
		expect(parsePageRange("3", 10)).toEqual({ ok: true, pages: [2] });
		expect(parsePageRange("1-3, 5", 10)).toEqual({ ok: true, pages: [0, 1, 2, 4] });
		expect(parsePageRange("8-", 10)).toEqual({ ok: true, pages: [7, 8, 9] });
		expect(parsePageRange("-2", 10)).toEqual({ ok: true, pages: [0, 1] });
		expect(parsePageRange("2 - 4;7 9", 10)).toEqual({ ok: true, pages: [1, 2, 3, 6, 8] });
		expect(parsePageRange("2–4", 10)).toEqual({ ok: true, pages: [1, 2, 3] });
		// Duplicates and overlaps are merged, the result is in page order.
		expect(parsePageRange("5, 1-3, 2-4", 10)).toEqual({ ok: true, pages: [0, 1, 2, 3, 4] });
	});

	it("says what is wrong instead of dropping pages", () => {
		expect(parsePageRange("", 10)).toEqual({ ok: false, error: "empty" });
		expect(parsePageRange("  ,; ", 10)).toEqual({ ok: false, error: "empty" });
		expect(parsePageRange("abc", 10)).toMatchObject({ ok: false, error: "syntax", text: "abc" });
		expect(parsePageRange("-", 10)).toMatchObject({ ok: false, error: "syntax" });
		expect(parsePageRange("1-2-3", 10)).toMatchObject({ ok: false, error: "syntax" });
		expect(parsePageRange("12345678", 10)).toMatchObject({ ok: false, error: "syntax" });
		expect(parsePageRange("5-2", 10)).toMatchObject({ ok: false, error: "backwards", text: "5-2" });
		expect(parsePageRange("0", 10)).toEqual({ ok: false, error: "outOfRange", page: 0 });
		expect(parsePageRange("11", 10)).toEqual({ ok: false, error: "outOfRange", page: 11 });
		expect(parsePageRange("3-12", 10)).toEqual({ ok: false, error: "outOfRange", page: 12 });
		expect(parsePageRange("8-", 5)).toEqual({ ok: false, error: "outOfRange", page: 8 });
	});

	it("reads pages back as ranges", () => {
		expect(formatPageRange([0, 1, 2, 4])).toBe("1-3, 5");
		expect(formatPageRange([4, 0, 2, 2, 1])).toBe("1-3, 5");
		expect(formatPageRange([7])).toBe("8");
		expect(formatPageRange([])).toBe("");
	});

	it("turns an error into a sentence for the dialog", () => {
		expect(rangeProblem(parsePageRange("1-3", 5), 5)).toBeNull();
		expect(rangeProblem(parsePageRange("9", 5), 5)).toContain("9");
		expect(rangeProblem(parsePageRange("x", 5), 5)).toContain("x");
		expect(rangeProblem(parsePageRange("", 5), 5)).toBeTruthy();
	});
});

describe("export plans with ranges, PNG images and print (81)", () => {
	it("keeps the old plans unchanged", () => {
		expect(planExport("pdf", "page", 1, 3)).toEqual([{ format: "pdf", pages: [1], suffix: " p2" }]);
		expect(planExport("pdf", "notebook", 0, 3, "ink")).toEqual([{ format: "pdf", pages: [0, 1, 2], suffix: " ink" }]);
		expect(planExport("svg", "notebook", 0, 2).map((j) => [j.pages, j.suffix])).toEqual([[[0], " p1"], [[1], " p2"]]);
	});

	it("a range is one PDF with a name that says which pages, or one SVG per page", () => {
		expect(planExport("pdf", "range", 0, 10, "both", [1, 2, 3])).toEqual([{ format: "pdf", pages: [1, 2, 3], suffix: " p2-4" }]);
		expect(planExport("pdf", "range", 0, 10, "ink", [0, 2, 4])).toEqual([{ format: "pdf", pages: [0, 2, 4], suffix: " p1+3+5 ink" }]);
		expect(planExport("pdf", "range", 0, 10, "both", [6])).toEqual([{ format: "pdf", pages: [6], suffix: " p7" }]);
		expect(planExport("svg", "range", 0, 10, "both", [3, 1]).map((j) => [j.pages, j.suffix])).toEqual([[[1], " p2"], [[3], " p4"]]);
		// A long list does not make a long file name.
		const many = Array.from({ length: 30 }, (_, i) => i * 2);
		expect(planExport("pdf", "range", 0, 100, "both", many)[0]!.suffix).toBe(" selection");
	});

	it("drops pages the notebook does not have and plans nothing for an empty range", () => {
		expect(planExport("pdf", "range", 0, 3, "both", [1, 7, -1, 1])).toEqual([{ format: "pdf", pages: [1], suffix: " p2" }]);
		expect(planExport("pdf", "range", 0, 3, "both", [])).toEqual([]);
		expect(planExport("png", "range", 0, 3, "both", [9])).toEqual([]);
	});

	it("PNG images and print are one job holding the chosen pages", () => {
		expect(planExport("png", "notebook", 0, 3)).toEqual([{ format: "png", pages: [0, 1, 2], suffix: "" }]);
		expect(planExport("png", "page", 2, 3)).toEqual([{ format: "png", pages: [2], suffix: "" }]);
		expect(planExport("print", "range", 0, 9, "both", [4, 5])).toEqual([{ format: "print", pages: [4, 5], suffix: "" }]);
		expect(planExport("print", "page", 5, 3)).toEqual([]);
	});
});

describe("PNG scale and file names (81)", () => {
	it("scales are pixels per pt: 1 is the 72 dpi of a PDF page", () => {
		expect(PNG_SCALES).toEqual([1, 1.5, 2, 3, 4]);
		expect(isPngScale(DEFAULT_PNG_SCALE)).toBe(true);
		expect(isPngScale(5)).toBe(false);
		expect(scaleDpi(1)).toBe(72);
		expect(scaleDpi(2)).toBe(144);
		const a4 = { width: 595, height: 842 };
		expect(renderSize(a4, scaleDpi(1))).toMatchObject({ width: 595, height: 842 });
		expect(renderSize(a4, scaleDpi(2))).toMatchObject({ width: 1190, height: 1684 });
	});

	it("very large scales are capped like the Markdown export", () => {
		const huge = renderSize({ width: 595, height: 20000 }, scaleDpi(4));
		expect(Math.max(huge.width, huge.height)).toBeLessThanOrEqual(8192);
		expect(huge.width * huge.height).toBeLessThanOrEqual(16_000_000);
	});

	it("names the images by their real page number, and never replaces a file", () => {
		expect(planPageImages("out", [0, 1, 2], 3, () => false)).toEqual(["page-001.png", "page-002.png", "page-003.png"]);
		// A range keeps the page numbers of the notebook.
		expect(planPageImages("out", [4, 6], 12, () => false)).toEqual(["page-005.png", "page-007.png"]);
		const taken = new Set(["out/page-002.png", "out/page-002 2.png"]);
		expect(planPageImages("out", [0, 1], 3, (p) => taken.has(p))).toEqual(["page-001.png", "page-002 3.png"]);
		// More than 999 pages: the numbers get longer so they sort.
		expect(planPageImages("", [0], 1200, () => false)).toEqual(["page-0001.png"]);
		expect(planPageImages("/", [8], 9, (p) => p === "page-009.png")).toEqual(["page-009 2.png"]);
	});
});

describe("read-only mode (51)", () => {
	it("a locked history runs, undoes and redoes nothing", () => {
		const doc = sampleDocument(0);
		const page = doc.pages[0]!;
		let locked = false;
		const history = new History(() => doc, 500, null, null, () => locked);
		const a = line(0, 0, 10, 10);
		expect(history.execute(new AddStroke(page.id, a, 0))).toBe(true);
		locked = true;
		expect(history.execute(new AddStroke(page.id, line(0, 20, 10, 30), 1))).toBe(false);
		expect(page.strokes.map((s) => s.id)).toEqual([a.id]);
		// Undo and redo are refused too, and what was done before stays undoable afterwards.
		expect(history.undo()).toBeNull();
		expect(page.strokes.map((s) => s.id)).toEqual([a.id]);
		expect(history.canUndo()).toBe(true);
		locked = false;
		expect(history.undo()).not.toBeNull();
		expect(page.strokes).toHaveLength(0);
		locked = true;
		expect(history.redo()).toBeNull();
		expect(page.strokes).toHaveLength(0);
		locked = false;
		expect(history.redo()).not.toBeNull();
		expect(page.strokes.map((s) => s.id)).toEqual([a.id]);
	});

	it("a finger only navigates when finger drawing is off, whatever else is set (the view turns it off)", () => {
		const policy = new InputPolicy({ fingerDrawing: false, palmRejectionMs: 500 });
		expect(policy.route("touch", 1000)).toBe("navigate");
		expect(policy.route("touch", 1000, 0, 0, 0)).toBe("navigate");
	});

	it("the toggle is a registry action with a command, in the sheet, and works on a document that is read-only", () => {
		const a = ACTIONS.find((x) => x.id === "toggle-read-only")!;
		expect(a.scope).toBe("view");
		expect(a.command).toBeTruthy();
		expect(a.surfaces).toContain("sheet");
		expect(commandActions().some((x) => x.id === "toggle-read-only")).toBe(true);
		const on = baseContext({ editable: false, toggles: { ruler: false, penOnly: false, navigator: false, readOnly: true } });
		expect(isEnabled(a, on)).toBe(true);
		expect(isChecked(a, on)).toBe(true);
		expect(isChecked(a, baseContext())).toBe(false);
		expect(placementsOf("toggle-read-only", on, 800)).toContain("sheet");
		// Editing actions are disabled in this context, reading ones are not.
		const by = (id: string) => ACTIONS.find((x) => x.id === id)!;
		expect(isEnabled(by("tool-pen"), on)).toBe(false);
		expect(isEnabled(by("undo"), on)).toBe(false);
		expect(isEnabled(by("add-page"), on)).toBe(false);
		expect(isEnabled(by("export-png"), on)).toBe(true);
		expect(isEnabled(by("fit-width"), on)).toBe(true);
	});
});

describe("PNG and Print in the registry (81)", () => {
	it("PNG images are in the sheet and the notebook menu, with a command", () => {
		const a = ACTIONS.find((x) => x.id === "export-png")!;
		expect(a.command).toBeTruthy();
		expect(a.surfaces).toEqual(expect.arrayContaining(["sheet", "notebook"]));
		expect(isRelevant(a, baseContext({ canPrint: false }))).toBe(true);
	});

	it("Print is offered only where the device can print: a phone or tablet does not see it", () => {
		const a = ACTIONS.find((x) => x.id === "print")!;
		expect(a.command).toBeTruthy();
		expect(isRelevant(a, baseContext({ canPrint: true }))).toBe(true);
		expect(isRelevant(a, baseContext({ canPrint: false }))).toBe(false);
		expect(isRelevant(a, baseContext({ canPrint: undefined }))).toBe(false);
		expect(placementsOf("print", baseContext({ canPrint: true }), 800)).toContain("sheet");
		expect(placementsOf("print", baseContext({ canPrint: false }), 800)).toEqual([]);
	});
});
