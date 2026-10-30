import { describe, expect, it } from "vitest";
import { parse, serializeChecked } from "../src/model/serialize";
import { MM, PAGE_SIZES, PAPER_SPACING } from "../src/model/types";
import { STAMPS_DIRNAME } from "../src/ink/stamps";
import { ACTIONS } from "../src/ui/actions";
import {
	customOrientation, customSide, depthBelow, folderChoices, isRootFolder, joinPath, MAX_NAME, nameProblem, nextArtStyle, notebookDocument,
	orientCustom, pageSize, SIZE_CHOICES, startFolder, STORE_FOLDERS, type NotebookSpec,
} from "../src/view/create-logic";

const spec = (over: Partial<NotebookSpec> = {}): NotebookSpec => ({
	name: "Anatomy", description: "  Bones and muscles  ", folder: "Notebooks", paper: "dotted", size: "a5", customMm: { width: 210, height: 297 },
	landscape: false, color: "#F0565E", art: { style: "waves", seed: "abc" }, ...over,
});

describe("creation dialog rules", () => {
	it("checks names: empty, invalid characters, a leading dot, too long, taken", () => {
		const none = () => false;
		expect(nameProblem("   ", none)).toBe("empty");
		for (const bad of ["a/b", "a\\b", "x:y", "q?", "#tag", "[x]", "a|b", "^"]) expect(nameProblem(bad, none), bad).toBe("chars");
		expect(nameProblem(".hidden", none)).toBe("dot");
		expect(nameProblem("x".repeat(MAX_NAME + 1), none)).toBe("long");
		expect(nameProblem(" Anatomy ", (n) => n === "Anatomy")).toBe("exists");
		expect(nameProblem("Anatomia – lezioni", none)).toBeNull();
	});

	it("joins paths at the vault root and below", () => {
		expect(joinPath("", "A")).toBe("A");
		expect(joinPath("/", "A")).toBe("A");
		expect(joinPath("Notebooks/", "A")).toBe("Notebooks/A");
	});

	it("offers A4 · A5 · B5 · Letter and sizes pages, landscape wider than tall", () => {
		expect(SIZE_CHOICES).toEqual(["a4", "a5", "b5", "letter"]);
		expect(pageSize("a4", false, { width: 0, height: 0 })).toEqual({ width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height });
		expect(pageSize("a4", true, { width: 0, height: 0 })).toEqual({ width: PAGE_SIZES.a4.height, height: PAGE_SIZES.a4.width });
	});

	it("applies custom sides as typed, whatever orientation was selected", () => {
		// 300 × 200 mm typed with "portrait" still selected is 300 wide and 200 tall.
		const custom = pageSize("custom", false, { width: 300, height: 200 });
		expect(custom.width).toBeCloseTo(300 * MM, 1);
		expect(custom.height).toBeCloseTo(200 * MM, 1);
		const tall = pageSize("custom", true, { width: 100, height: 150 });
		expect(tall.width).toBeCloseTo(100 * MM, 1);
		expect(tall.height).toBeCloseTo(150 * MM, 1);
	});

	it("keeps the orientation in step with the typed custom sides", () => {
		expect(customOrientation(300, 200, false)).toBe(true);
		expect(customOrientation(200, 300, true)).toBe(false);
		expect(customOrientation(250, 250, true)).toBe(true);
		expect(customOrientation(250, 250, false)).toBe(false);
		// Toggling the orientation swaps the two fields, even when one is not a valid number yet.
		expect(orientCustom({ width: "300", height: "200" }, false, true)).toEqual({ width: "200", height: "300" });
		expect(orientCustom({ width: "30", height: "200" }, true, true)).toEqual({ width: "200", height: "30" });
		// Entering a custom size: the fields are swapped only when they show the other orientation.
		expect(orientCustom({ width: "210", height: "297" }, true, false)).toEqual({ width: "297", height: "210" });
		expect(orientCustom({ width: "210", height: "297" }, false, false)).toEqual({ width: "210", height: "297" });
		expect(orientCustom({ width: "x", height: "297" }, true, false)).toEqual({ width: "x", height: "297" });
	});

	it("rejects a trailing dot or space and Windows device names, for notebooks and folders alike", () => {
		const none = () => false;
		for (const bad of ["Notes.", "Notes ..", "a."]) expect(nameProblem(bad, none), bad).toBe("trailing");
		for (const bad of ["CON", "con", "Prn", "AUX", "nul", "COM1", "com9", "LPT1", "lpt9", "NUL.txt", "con.notebook", "Com3.old"]) {
			expect(nameProblem(bad, none), bad).toBe("device");
		}
		for (const ok of ["CONS", "Console", "COM10", "COM0", "LPT", "Auxiliary", "null"]) expect(nameProblem(ok, none), ok).toBeNull();
	});

	it("rejects the plugin's store folders directly under the notebooks folder only, ignoring case", () => {
		const none = () => false;
		expect(STORE_FOLDERS).toEqual(expect.arrayContaining(["_templates", "_backup", "_stamps", "_assets", "_meta", "_trash"]));
		for (const name of STORE_FOLDERS) {
			expect(nameProblem(name, none, true), name).toBe("reserved");
			expect(nameProblem(name.toUpperCase(), none, true), name).toBe("reserved");
			expect(nameProblem(name, none, false), name).toBeNull();
		}
		expect(STORE_FOLDERS).toContain(STAMPS_DIRNAME);
		expect(nameProblem("_assets2", none, true)).toBeNull();
		expect(isRootFolder("Notebooks/", "/Notebooks")).toBe(true);
		expect(isRootFolder("Notebooks/Bio", "Notebooks")).toBe(false);
		expect(isRootFolder("/", "")).toBe(true);
	});

	it("checks whether the name as it will be created is taken", () => {
		const asked: string[] = [];
		expect(nameProblem("  Anatomy   2024 ", (n) => (asked.push(n), false))).toBeNull();
		expect(asked).toEqual(["Anatomy 2024"]);
	});

	it("reads custom sides in mm within bounds", () => {
		expect(customSide("210")).toBe(210);
		expect(customSide("148,5")).toBe(148.5);
		expect(customSide("10")).toBeNull();
		expect(customSide("5000")).toBeNull();
		expect(customSide("abc")).toBeNull();
	});

	it("lists the notebooks folder and its folders, never the reserved ones", () => {
		const all = ["Notebooks", "Notebooks/Math", "Notebooks/_assets", "Notebooks/_meta", "Notebooks/Bio/Cells", "Other", "Notebooks/Bio"];
		expect(folderChoices("Notebooks", all)).toEqual(["Notebooks", "Notebooks/Bio", "Notebooks/Bio/Cells", "Notebooks/Math"]);
		expect(folderChoices("", ["A", "_trash", "B/C"])).toEqual(["", "A", "B/C"]);
		expect(depthBelow("Notebooks", "Notebooks/Bio/Cells")).toBe(2);
		expect(depthBelow("Notebooks", "Notebooks")).toBe(0);
	});

	it("starts in the folder asked for, else the last one used, else the notebooks folder", () => {
		const c = ["Notebooks", "Notebooks/Math"];
		expect(startFolder(c, "Notebooks/Math", null)).toBe("Notebooks/Math");
		expect(startFolder(c, undefined, "Notebooks/Math")).toBe("Notebooks/Math");
		expect(startFolder(c, "Gone", "Also gone")).toBe("Notebooks");
	});

	it("cycles through the art styles", () => {
		expect(nextArtStyle("waves")).toBe("branches");
		expect(nextArtStyle("grid")).toBe("contours");
	});

	it("builds a valid v11 document with exactly the chosen settings", () => {
		const doc = notebookDocument(spec({ landscape: true }));
		const page = doc.pages[0]!;
		expect(page.paper).toEqual({ kind: "dotted", spacing: PAPER_SPACING.dotted });
		expect(page.width).toBe(PAGE_SIZES.a5.height);
		expect(page.height).toBe(PAGE_SIZES.a5.width);
		expect(doc.meta?.cover).toBe("#F0565E");
		expect(doc.meta?.description).toBe("Bones and muscles");
		expect(doc.meta?.coverArt).toEqual({ kind: "art", style: "waves", seed: "abc" });
		const out = serializeChecked(doc);
		expect(out.ok).toBe(true);
		if (out.ok) {
			const back = parse(out.text);
			expect(back.ok && back.doc.meta?.coverArt).toEqual({ kind: "art", style: "waves", seed: "abc" });
		}
		expect(notebookDocument(spec({ description: "  " })).meta?.description).toBeUndefined();
	});

	it("registers new-notebook and new-folder; the old 'create' command id stays", () => {
		const ids = new Map(ACTIONS.map((a) => [a.id, a]));
		expect(ids.get("create")?.command).toBeTruthy();
		expect(ids.get("new-notebook")?.surfaces).toContain("library");
		expect(ids.get("new-folder")?.command).toBeTruthy();
		expect(ids.get("new-folder")?.scope).toBe("global");
	});
});
