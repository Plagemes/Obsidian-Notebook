import { describe, expect, it } from "vitest";
import { parse, serializeChecked } from "../src/model/serialize";
import { MM, PAGE_SIZES, PAPER_SPACING } from "../src/model/types";
import { ACTIONS } from "../src/ui/actions";
import {
	customSide, depthBelow, folderChoices, joinPath, MAX_NAME, nameProblem, nextArtStyle, notebookDocument, pageSize, SIZE_CHOICES,
	startFolder, type NotebookSpec,
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
		const custom = pageSize("custom", false, { width: 300, height: 200 });
		expect(custom.width).toBeCloseTo(200 * MM, 1);
		expect(custom.height).toBeCloseTo(300 * MM, 1);
		expect(pageSize("custom", true, { width: 100, height: 150 }).width).toBeCloseTo(150 * MM, 1);
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
