import { describe, expect, it } from "vitest";
import { parseEmbedSource } from "../src/integration/links";
import {
	embedSourceFromFile, embedSourceFromSrc, fileMenuKind, insertionText, isNotebookEmbedSrc, MAX_PAGE_SUGGESTIONS,
	pageFromEphemeralState, pageFromSubpath, pageSubpath, pageSuggestions, pageTargetFromEphemeralState, pageTargetFromSubpath, pageTitle,
	parsePageLinkTrigger, resolvePageTarget, withEmbedMarker,
} from "../src/integration/page-links";
import { createPage } from "../src/model/document";
import type { Page, TextElement } from "../src/model/types";

function text(y: number, x: number, value: string): TextElement {
	return { id: `t${y}-${x}`, type: "text", x, y, width: 200, text: value, fontSize: 14, color: "#000000" };
}

function pageWith(...elements: TextElement[]): Page {
	return { ...createPage(), elements };
}

describe("page link subpaths", () => {
	it("reads the page from a subpath", () => {
		expect(pageFromSubpath("#p3")).toBe(3);
		expect(pageFromSubpath("#3")).toBe(3);
		expect(pageFromSubpath("#page=12")).toBe(12);
		expect(pageFromSubpath("p4")).toBe(4);
	});

	it("rejects headings, block ids and zero", () => {
		expect(pageFromSubpath("")).toBeNull();
		expect(pageFromSubpath("#")).toBeNull();
		expect(pageFromSubpath("#Introduction")).toBeNull();
		expect(pageFromSubpath("#^abc123")).toBeNull();
		expect(pageFromSubpath("#p0")).toBeNull();
		expect(pageFromSubpath("#p-1x")).toBeNull();
	});

	it("builds the subpath that parsing reads back", () => {
		expect(pageSubpath(3)).toBe("#p3");
		expect(pageSubpath(0)).toBe("#p1");
		expect(pageSubpath(2.7)).toBe("#p2");
		expect(pageFromSubpath(pageSubpath(41))).toBe(41);
	});

	it("reads Obsidian's ephemeral state and the plugin's own page state", () => {
		expect(pageFromEphemeralState({ subpath: "#p5" })).toBe(5);
		expect(pageFromEphemeralState({ subpath: "#Heading", page: 2 })).toBe(2);
		expect(pageFromEphemeralState({ page: 7 })).toBe(7);
		expect(pageFromEphemeralState({ scroll: 10 })).toBeNull();
		expect(pageFromEphemeralState({ subpath: "" })).toBeNull();
		expect(pageFromEphemeralState(null)).toBeNull();
		expect(pageFromEphemeralState("#p3")).toBeNull();
	});
});

describe("page link targets: by id first", () => {
	const pages = [{ id: "a" }, { id: "b" }, { id: "c" }];

	it("reads the page number and the page id of a link", () => {
		expect(pageTargetFromSubpath("#p3&id=c")).toEqual({ page: 3, pageId: "c" });
		expect(pageTargetFromSubpath("#p3")).toEqual({ page: 3, pageId: null });
		expect(pageTargetFromSubpath("#&id=c")).toEqual({ page: null, pageId: "c" });
		expect(pageTargetFromSubpath("#p3&id=bad id")).toEqual({ page: 3, pageId: null });
		expect(pageTargetFromSubpath("#Heading")).toBeNull();
		expect(pageTargetFromEphemeralState({ subpath: "#p1&id=c&r=1,2,3,4" })).toEqual({ page: 1, pageId: "c" });
		expect(pageTargetFromEphemeralState({ subpath: "#Heading", page: 2 })).toEqual({ page: 2, pageId: null });
		expect(pageTargetFromEphemeralState({ scroll: 1 })).toBeNull();
		expect(pageTargetFromEphemeralState(null)).toBeNull();
	});

	it("opens the page with that id wherever it is now, and never another page when it was deleted", () => {
		// The page moved: `p1` is stale, the id decides.
		expect(resolvePageTarget(pages, { page: 1, pageId: "c" })).toEqual({ index: 2 });
		// Deleted: page 3 exists, but it is not the linked page.
		expect(resolvePageTarget(pages, { page: 3, pageId: "gone" })).toEqual({ missing: "deleted" });
		// No id: the number, kept inside the notebook.
		expect(resolvePageTarget(pages, { page: 2, pageId: null })).toEqual({ index: 1 });
		expect(resolvePageTarget(pages, { page: 9, pageId: null })).toEqual({ index: 2 });
	});
});

describe("link and embed text", () => {
	it("adds or removes the embed marker", () => {
		expect(withEmbedMarker("[[A.notebook#p3]]", true)).toBe("![[A.notebook#p3]]");
		expect(withEmbedMarker("![[A.notebook#p3]]", true)).toBe("![[A.notebook#p3]]");
		expect(withEmbedMarker("![[A.notebook#p3]]", false)).toBe("[[A.notebook#p3]]");
		expect(withEmbedMarker("[A](A.notebook#p3)", true)).toBe("![A](A.notebook#p3)");
	});

	it("puts an embed on its own line and leaves a link inline", () => {
		expect(insertionText("![[A.notebook#p3]]", true, true)).toBe("![[A.notebook#p3]]\n");
		expect(insertionText("![[A.notebook#p3]]", true, false)).toBe("\n![[A.notebook#p3]]\n");
		expect(insertionText("[[A.notebook#p3]]", false, false)).toBe("[[A.notebook#p3]]");
	});
});

describe("native embeds", () => {
	it("recognises notebook embeds by extension, ignoring the subpath", () => {
		const ext = ["notebook"];
		expect(isNotebookEmbedSrc("Physics.notebook#p3", ext)).toBe(true);
		expect(isNotebookEmbedSrc("folder/Physics.NOTEBOOK", ext)).toBe(true);
		expect(isNotebookEmbedSrc("Physics.png", ext)).toBe(false);
		expect(isNotebookEmbedSrc("Physics", ext)).toBe(false);
		expect(isNotebookEmbedSrc("x.png#Physics.notebook", ext)).toBe(false);
	});

	it("builds sources that the code block parser reads as the same notebook and page", () => {
		expect(parseEmbedSource(embedSourceFromSrc("Physics.notebook#p3"))).toEqual({
			ok: true, target: { kind: "link", value: "Physics.notebook" }, page: 3,
		});
		expect(parseEmbedSource(embedSourceFromFile("Notebooks/Physics.notebook", "#p3"))).toEqual({
			ok: true, target: { kind: "path", value: "Notebooks/Physics.notebook" }, page: 3,
		});
		expect(parseEmbedSource(embedSourceFromFile("Notebooks/Physics.notebook", ""))).toMatchObject({ ok: true, page: 1 });
	});

	it("reports a subpath that is not a page", () => {
		expect(parseEmbedSource(embedSourceFromFile("Notebooks/Physics.notebook", "#Intro"))).toEqual({
			ok: false, error: "badPage", detail: "Intro",
		});
	});
});

describe("page link trigger", () => {
	it("fires inside the subpath of an unfinished link", () => {
		expect(parsePageLinkTrigger("see [[Physics.notebook#")).toEqual({ linkpath: "Physics.notebook", query: "", queryStart: 23 });
		expect(parsePageLinkTrigger("see ![[Physics#p")).toEqual({ linkpath: "Physics", query: "p", queryStart: 15 });
		expect(parsePageLinkTrigger("[[Notebooks/Physics.notebook#intro")).toMatchObject({ linkpath: "Notebooks/Physics.notebook", query: "intro" });
	});

	it("does not fire outside a link, after it is closed, or in an alias or block reference", () => {
		expect(parsePageLinkTrigger("Physics#p3")).toBeNull();
		expect(parsePageLinkTrigger("[[Physics.notebook#p3]] and #")).toBeNull();
		expect(parsePageLinkTrigger("[[Physics.notebook|alias#")).toBeNull();
		expect(parsePageLinkTrigger("[[Physics.notebook#^block")).toBeNull();
		expect(parsePageLinkTrigger("[[Physics.notebook")).toBeNull();
		expect(parsePageLinkTrigger("[[#")).toBeNull();
	});
});

describe("page titles and suggestions", () => {
	it("uses the first line of the topmost text box", () => {
		expect(pageTitle(pageWith(text(300, 10, "lower"), text(40, 10, "\n  Newton laws \nsecond line")))).toBe("Newton laws");
		expect(pageTitle(pageWith(text(40, 100, "right"), text(40, 10, "left")))).toBe("left");
		expect(pageTitle(pageWith(text(10, 10, "   "), text(20, 10, "after blank")))).toBe("after blank");
	});

	it("has no title without text, and shortens long ones", () => {
		expect(pageTitle(createPage())).toBeNull();
		const long = pageTitle(pageWith(text(1, 1, "x".repeat(200))));
		expect(long?.length).toBe(60);
		expect(long?.endsWith("…")).toBe(true);
	});

	const pages = [pageWith(text(1, 1, "Kinematics")), pageWith(text(1, 1, "Dynamics")), ...Array.from({ length: 10 }, () => createPage())];

	it("lists every page for an empty query", () => {
		const all = pageSuggestions(pages, "");
		expect(all.map((s) => s.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(all[0]).toEqual({ page: 1, pageId: pages[0]!.id, title: "Kinematics", hasInk: false });
	});

	it("matches digits, with or without p, against the start of the page number", () => {
		expect(pageSuggestions(pages, "1").map((s) => s.page)).toEqual([1, 10, 11, 12]);
		expect(pageSuggestions(pages, "p1").map((s) => s.page)).toEqual([1, 10, 11, 12]);
		expect(pageSuggestions(pages, "p12").map((s) => s.page)).toEqual([12]);
		expect(pageSuggestions(pages, "p").length).toBe(12);
		expect(pageSuggestions(pages, "99")).toEqual([]);
	});

	it("matches other text against the title, ignoring case", () => {
		expect(pageSuggestions(pages, "dyn").map((s) => s.page)).toEqual([2]);
		expect(pageSuggestions(pages, "physics")).toEqual([]);
	});

	it("is capped for very long notebooks", () => {
		const many = Array.from({ length: MAX_PAGE_SUGGESTIONS + 50 }, () => createPage());
		expect(pageSuggestions(many, "").length).toBe(MAX_PAGE_SUGGESTIONS);
	});
});

describe("file explorer menu", () => {
	it("offers a new notebook on folders and annotating on PDFs only", () => {
		expect(fileMenuKind({ isFolder: true })).toBe("folder");
		expect(fileMenuKind({ isFolder: false, extension: "pdf" })).toBe("pdf");
		expect(fileMenuKind({ isFolder: false, extension: "PDF" })).toBe("pdf");
		expect(fileMenuKind({ isFolder: false, extension: "md" })).toBeNull();
		expect(fileMenuKind({ isFolder: false })).toBeNull();
	});
});
