import { describe, expect, it } from "vitest";
import { findAnnotators, mayMentionAsset, notebookPageFor, summarizeForAnnotate, viewerPageNumber } from "../src/library/annotate-pdf-logic";

const bg = (asset: string, page: number) => ({ kind: "pdf", asset, page });

describe("annotate PDF logic", () => {
	const a = summarizeForAnnotate("A.notebook", "A", { modified: 5, pages: [{ background: bg("x", 1) }, { background: bg("x", 2) }, {}] });
	const b = summarizeForAnnotate("B.notebook", "B", { modified: 9, pages: [{ background: bg("y", 1) }, { background: { kind: "image", asset: "x" } }] });
	const c = summarizeForAnnotate("C.notebook", "C", { modified: 9, pages: [{}, { background: bg("x", 4) }, { background: bg("x", 2) }] });

	it("summarizes only PDF backgrounds", () => {
		expect(b.backgrounds).toEqual([{ asset: "y", page: 1 }, null]);
	});
	it("finds notebooks on the asset, newest first, none for an unknown PDF", () => {
		expect(findAnnotators([a, b, c], "x", null).map((r) => r.path)).toEqual(["C.notebook", "A.notebook"]);
		expect(findAnnotators([a, b, c], "zzz", null)).toEqual([]);
		expect(findAnnotators([a, b, c], "x", null)[1]!.pdfPages).toBe(2);
	});
	it("opens the notebook page that shows the viewer page, else the first PDF page, else 1", () => {
		expect(notebookPageFor(c.backgrounds, "x", 2)).toBe(3);
		expect(notebookPageFor(c.backgrounds, "x", 99)).toBe(2);
		expect(notebookPageFor(c.backgrounds, "x", null)).toBe(2);
		expect(notebookPageFor(a.backgrounds, "q", 1)).toBe(1);
	});
	it("pre-filters by asset id", () => {
		expect(mayMentionAsset('{"assets":{"abc":1}}', "abc")).toBe(true);
		expect(mayMentionAsset("{}", "abc")).toBe(false);
		expect(mayMentionAsset("abc", "")).toBe(false);
	});
	it("reads the viewer page defensively", () => {
		expect(viewerPageNumber({ viewer: { child: { pdfViewer: { pdfViewer: { currentPageNumber: 7 } } } } })).toBe(7);
		expect(viewerPageNumber({ viewer: { child: { pdfViewer: { currentPageNumber: 3 } } } })).toBe(3);
		expect(viewerPageNumber({ viewer: null })).toBeNull();
		expect(viewerPageNumber({ viewer: { child: { pdfViewer: { currentPageNumber: 0 } } } })).toBeNull();
		expect(viewerPageNumber(undefined)).toBeNull();
	});
});
