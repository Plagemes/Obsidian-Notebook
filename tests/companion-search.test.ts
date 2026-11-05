import { describe, expect, it } from "vitest";
import { notebookUri } from "../src/integration/links";
import { companionContent, renderRegion, regionStatus } from "../src/model/companion-content";
import {
	equationCode, escapeSearchText, SEARCH_CUT_NOTE, SEARCH_ITEM_MAX, SEARCH_PAGE_MAX, searchLines,
} from "../src/model/companion-search";
import { createDocument, createPage } from "../src/model/document";
import type { NotebookDocument, Page, PageElement } from "../src/model/types";
import { DEFAULT_COMPANION_SETTINGS, readCompanionSettings } from "../src/storage/companion-path";

const PATH = "Notebooks/Physics.notebook";
const base = { notebookPath: PATH, pageUri: (p: number) => notebookUri("", PATH, p) };

function pageWith(elements: PageElement[], comments?: Page["comments"]): Page {
	const p = createPage();
	p.elements = elements;
	if (comments) p.comments = comments;
	return p;
}
const sticky = (text: string, y = 0): PageElement => ({ id: `s${y}`, type: "sticky", x: 0, y, width: 100, height: 80, color: "#ffd166", text, fontSize: 14 });
const eq = (latex: string, y = 0): PageElement => ({ id: `e${y}`, type: "equation", x: 0, y, width: 100, height: 40, latex, fontSize: 14, color: "#000000" });

function doc1(page: Page): NotebookDocument {
	const d = createDocument(new Date("2026-10-29T14:30:00Z"));
	d.id = "doc-1";
	d.pages = [page];
	return d;
}

describe("escapeSearchText", () => {
	it("leaves nothing that can become a link, tag, comment, math, html or block", () => {
		const out = escapeSearchText("[[Link]] #tag %% $x$ `c` <b> > quote ==hi== ![img](u)");
		// Every special character is preceded by a backslash.
		expect(out).not.toMatch(/(^|[^\\])[[\]#%$<>`=!]/);
		expect(out).toContain("\\[\\[Link\\]\\]");
	});
	it("one line, list and number starts escaped", () => {
		expect(escapeSearchText("a\n\n  b")).toBe("a b");
		expect(escapeSearchText("- item")).toBe("\\- item");
		expect(escapeSearchText("1. item")).toBe("\\1. item");
	});
});

describe("equationCode", () => {
	it("is one inline code span that cannot end itself or the region", () => {
		expect(equationCode("a`b\n%% c")).toBe("`a'b % % c`");
		expect(equationCode("   ")).toBe("");
	});
});

describe("searchLines", () => {
	it("lists sticky text, equations, marker labels, comments and replies", () => {
		const p = pageWith(
			[sticky("Buy milk", 10), eq("E=mc^2", 20), { id: "m", type: "marker", kind: "question", x: 0, y: 30, text: "Why?" }, { id: "h", type: "marker", kind: "homework", x: 0, y: 40, text: "Ex 4" }],
			[
				{ id: "c1", region: { x: 0, y: 0, width: 10, height: 10 }, text: "check this", author: "A", created: 1 },
				{ id: "r1", parent: "c1", text: "done", author: "B", created: 2 },
			],
		);
		expect(searchLines(p)).toEqual([
			"- sticky: Buy milk", "- equation: `E=mc^2`", "- question: Why?", "- comment: check this", "- reply: done",
		]);
	});
	it("is empty for a page without such text, and skips empty ones", () => {
		expect(searchLines(pageWith([sticky("   ")]))).toEqual([]);
		expect(searchLines(undefined)).toEqual([]);
	});
	it("is bounded per page and per item, and says so", () => {
		const many = Array.from({ length: 40 }, (_, i) => sticky("x".repeat(SEARCH_ITEM_MAX + 50), i));
		const lines = searchLines(pageWith(many));
		expect(lines[lines.length - 1]).toBe(SEARCH_CUT_NOTE);
		expect(lines.slice(0, -1).join("\n").length).toBeLessThanOrEqual(SEARCH_PAGE_MAX);
		expect(lines[0]!.length).toBeLessThan(SEARCH_ITEM_MAX + 30);
	});
});

describe("companionContent with searchText", () => {
	const p = pageWith([sticky("find me #x %% [[evil]]")]);
	it("off: unchanged behaviour (no sticky text, markdown link)", () => {
		const c = companionContent(doc1(p), base);
		expect(c.text).toBe("");
	});
	it("on: a heading, a wikilink back to the page by id, and the escaped text; the region stays well formed", () => {
		const d = doc1(p);
		const c = companionContent(d, { ...base, searchText: true });
		expect(c.text).toContain("### p. 1");
		expect(c.text).toContain(`[[${PATH}#p1&id=${p.id}|p. 1]]`);
		expect(c.text).toContain("- sticky: find me \\#x \\%\\% \\[\\[evil\\]\\]");
		expect(regionStatus(`x\n${renderRegion(c)}\ny`)).toBe("ok");
		// Deterministic: a second generation is byte-identical (no write when unchanged).
		expect(companionContent(d, { ...base, searchText: true }).text).toBe(c.text);
	});
});

describe("setting", () => {
	it("is off by default and read leniently", () => {
		expect(DEFAULT_COMPANION_SETTINGS.companionSearchText).toBe(false);
		expect(readCompanionSettings({ companionSearchText: true }).companionSearchText).toBe(true);
		expect(readCompanionSettings({ companionSearchText: "yes" }).companionSearchText).toBe(false);
	});
});
