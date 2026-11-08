import { describe, expect, it } from "vitest";
import {
	formatGalleryQuery, GALLERY_MAX_READS, notebookMatches, notebookPagesOf, pageMatchesMarked, parseGalleryQuery, resolveGallery,
	type GalleryContext, type GalleryQuery, type NotebookPages,
} from "../src/integration/gallery-query";
import type { LibraryEntry } from "../src/library/index";
import type { Page, PageElement } from "../src/model/types";

const ok = (src: string): GalleryQuery => {
	const r = parseGalleryQuery(src);
	if (!r.ok) throw new Error(`${r.error} ${r.detail}`);
	return r.query;
};
const bad = (src: string) => {
	const r = parseGalleryQuery(src);
	return r.ok ? null : `${r.error}|${r.detail}`;
};

const page = (id: string, extra: Partial<Page> = {}): Page => ({ id, width: 600, height: 800, paper: { kind: "blank", spacing: 30 }, strokes: [], ...extra });
const marker = (id: string, kind: string): PageElement => ({ id, type: "marker", kind, x: 0, y: 0 }) as PageElement;
const entry = (path: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
	path, folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", name: (path.split("/").pop() ?? path).replace(/\.[^.]+$/, ""),
	mtime: 1, size: 1, created: 1, modified: 1, pages: 5, tags: [], favorite: false, cover: "#000000", ...over,
});
const ctx = (over: Partial<GalleryContext> = {}): GalleryContext => ({ courseOf: () => [], globalBookmarks: () => [], ...over });
const never = async (): Promise<NotebookPages | null> => {
	throw new Error("no pages should be read");
};

describe("parseGalleryQuery", () => {
	it("an empty block is the default query", () => {
		const q = ok("");
		expect(q).toMatchObject({ tags: [], bookmarked: false, courses: [], notebooks: [], marked: [], limit: 12, sort: "recent" });
	});
	it("reads every kind of line, in either separator", () => {
		const q = ok("tag: #exam\ncourse: Analysis\nnotebook = Notebooks/Maths.notebook\nmarked: question|homework\nbookmarked\nlimit: 8\nsort: title");
		expect(q).toEqual({ tags: ["exam"], bookmarked: true, courses: ["Analysis"], notebooks: ["Notebooks/Maths.notebook"], marked: ["question", "homework"], limit: 8, sort: "title" });
	});
	it("tags: several on a line or several lines, case-insensitive duplicates once", () => {
		expect(ok("tag: #a, #B\ntags: b #c").tags).toEqual(["a", "B", "c"]);
		expect(ok("tag: #two words").tags).toEqual(["two words"]);
	});
	it("marked accepts commas, spaces and the kinds of the marked-pages filter", () => {
		expect(ok("marked: Question, star task").marked).toEqual(["question", "star", "task"]);
	});
	it("bookmarked: yes / no", () => {
		expect(ok("bookmarked: yes").bookmarked).toBe(true);
		expect(ok("bookmarked\nbookmarked: no").bookmarked).toBe(false);
	});
	it("quoted values lose the quotes; comment lines are skipped", () => {
		expect(ok('// note\ncourse: "Intro to Law"').courses).toEqual(["Intro to Law"]);
	});
	it("the limit is capped at 60", () => expect(ok("limit: 500").limit).toBe(60));
	it("errors name the line and never guess", () => {
		expect(bad("colour: red")).toBe("unknown-key|colour");
		expect(bad("hello there")).toBe("syntax|hello there");
		expect(bad("marked: nonsense")).toBe("bad-value|nonsense");
		expect(bad("limit: many")).toBe("bad-value|limit: many");
		expect(bad("limit: 0")).toBe("bad-value|limit: 0");
		expect(bad("sort: random")).toBe("bad-value|sort: random");
		expect(bad("tag:")).toBe("bad-value|tag: ");
		expect(bad("bookmarked: maybe")).toBe("bad-value|bookmarked: maybe");
		expect(bad("course:")).toBe("bad-value|course: ");
	});
	it("a block written by formatGalleryQuery reads back the same", () => {
		const q = ok("tag: #exam #ch1\ncourse: Analysis\nmarked: question|gap\nbookmarked\nlimit: 6\nsort: title");
		const text = formatGalleryQuery(q);
		expect(text.startsWith("```notebook-gallery\n")).toBe(true);
		expect(text.endsWith("\n```")).toBe(true);
		expect(ok(text.split("\n").slice(1, -1).join("\n"))).toEqual(q);
		expect(formatGalleryQuery({})).toBe("```notebook-gallery\n```");
	});
});

describe("notebookMatches", () => {
	const q = (s: string) => ok(s);
	it("by path with or without the extension, by name, by folder", () => {
		const e = entry("Notebooks/Maths/Algebra.notebook");
		expect(notebookMatches(e, q("notebook: Notebooks/Maths/Algebra.notebook"), ctx())).toBe(true);
		expect(notebookMatches(e, q("notebook: notebooks/maths/algebra"), ctx())).toBe(true);
		expect(notebookMatches(e, q("notebook: Algebra"), ctx())).toBe(true);
		expect(notebookMatches(e, q("notebook: Notebooks/Maths/"), ctx())).toBe(true);
		expect(notebookMatches(e, q("notebook: Notebooks/Math"), ctx())).toBe(false);
		expect(notebookMatches(e, q("notebook: Geometry"), ctx())).toBe(false);
	});
	it("by timetable course, case-insensitive", () => {
		const c = ctx({ courseOf: (p) => (p === "a.notebook" ? ["Analysis"] : []) });
		expect(notebookMatches(entry("a.notebook"), q("course: analysis"), c)).toBe(true);
		expect(notebookMatches(entry("b.notebook"), q("course: analysis"), c)).toBe(false);
	});
});

describe("pageMatchesMarked", () => {
	const mctx = notebookPagesOf({ pages: [], bookmarks: ["b"] }, ["g"]).markCtx;
	it("marker kinds, any of them", () => {
		const p = page("a", { elements: [marker("1", "question")] });
		expect(pageMatchesMarked(p, ["question"], mctx)).toBe(true);
		expect(pageMatchesMarked(p, ["homework", "question"], mctx)).toBe(true);
		expect(pageMatchesMarked(p, ["homework"], mctx)).toBe(false);
	});
	it("the kinds of the marked-pages filter", () => {
		expect(pageMatchesMarked(page("b"), ["bookmark"], mctx)).toBe(true);
		expect(pageMatchesMarked(page("g"), ["global"], mctx)).toBe(true);
		expect(pageMatchesMarked(page("x", { tags: ["t"] }), ["tag"], mctx)).toBe(true);
		expect(pageMatchesMarked(page("x"), ["tag", "task"], mctx)).toBe(false);
	});
});

describe("resolveGallery", () => {
	const a = entry("a.notebook", { modified: 30, pageTags: [{ page: 1, tags: ["Exam"] }, { page: 3, tags: ["exam", "ch1"] }], bookmarks: [{ page: 3, title: "x" }] });
	const b = entry("b.notebook", { modified: 20, pageTags: [{ page: 0, tags: ["exam"] }] });
	const c = entry("c.notebook", { modified: 10 });
	const all = [c, a, b];
	const run = (src: string, over: Partial<GalleryContext> = {}, entries = all) => resolveGallery(entries, ok(src), ctx(over), never);
	const keys = (items: Array<{ path: string; page: number }>) => items.map((i) => `${i.path.replace(".notebook", "")}:${i.page}`);

	it("no page condition: the first page of each notebook, newest first", async () => {
		expect(keys(await run(""))).toEqual(["a:0", "b:0", "c:0"]);
		expect(keys(await run("sort: title", {}, [c, b, a]))).toEqual(["a:0", "b:0", "c:0"]);
	});
	it("tag: the pages with the tag, in notebook order, case-insensitive", async () => {
		expect(keys(await run("tag: #exam"))).toEqual(["a:1", "a:3", "b:0"]);
		expect(keys(await run("tag: exam, #ch1"))).toEqual(["a:3"]);
	});
	it("tag from a notebook without page tags finds nothing", async () => expect(await run("tag: #none")).toEqual([]));
	it("bookmarked: titled bookmarks and global ones, with the page id of a global one", async () => {
		const items = await run("bookmarked", { globalBookmarks: (p) => (p === "b.notebook" ? [{ pageId: "pid", num: 3 }] : []) });
		expect(keys(items)).toEqual(["a:3", "b:2"]);
		expect(items[1]!.pageId).toBe("pid");
	});
	it("a global bookmark past the end lands on the last page", async () => {
		const items = await run("bookmarked", { globalBookmarks: (p) => (p === "c.notebook" ? [{ pageId: "z", num: 99 }] : []) });
		expect(keys(items)).toContain("c:4");
	});
	it("tag and bookmarked must both hold on the same page", async () => expect(keys(await run("tag: exam\nbookmarked"))).toEqual(["a:3"]));
	it("course restricts the notebooks", async () => {
		const items = await run("course: Analysis", { courseOf: (p) => (p === "b.notebook" ? ["Analysis"] : []) });
		expect(keys(items)).toEqual(["b:0"]);
	});
	it("one notebook named: its pages in order", async () => expect(keys(await run("notebook: b"))).toEqual(["b:0", "b:1", "b:2", "b:3", "b:4"]));
	it("the limit cuts the list", async () => {
		expect(keys(await run("tag: exam\nlimit: 2"))).toEqual(["a:1", "a:3"]);
		expect(await run("limit: 2")).toHaveLength(2);
	});
	it("marked: reads notebooks in order, keeps matching pages with their ids, stops at the limit", async () => {
		const pages: Record<string, Page[]> = {
			"a.notebook": [page("a0"), page("a1", { elements: [marker("m", "question")] }), page("a2", { elements: [marker("n", "homework")] })],
			"b.notebook": [page("b0", { elements: [marker("m", "question")] })],
		};
		const read: string[] = [];
		const pagesOf = async (e: LibraryEntry): Promise<NotebookPages | null> => {
			read.push(e.path);
			return pages[e.path] ? notebookPagesOf({ pages: pages[e.path]! }, []) : null;
		};
		const items = await resolveGallery(all, ok("marked: question|homework"), ctx(), pagesOf);
		expect(items.map((i) => i.pageId)).toEqual(["a1", "a2", "b0"]);
		expect(items.map((i) => i.page)).toEqual([1, 2, 0]);
		read.length = 0;
		await resolveGallery(all, ok("marked: question\nlimit: 1"), ctx(), pagesOf);
		expect(read).toEqual(["a.notebook"]);
	});
	it("marked narrows to the pages the index already picked", async () => {
		const p = [page("a0", { elements: [marker("m", "gap")] }), page("a1", { elements: [marker("m", "gap")] }), page("a2"), page("a3", { elements: [marker("m", "gap")] })];
		const items = await resolveGallery([a], ok("tag: exam\nmarked: gap"), ctx(), async () => notebookPagesOf({ pages: p }, []));
		expect(items.map((i) => i.page)).toEqual([1, 3]);
	});
	it("reads at most GALLERY_MAX_READS notebooks and skips unreadable ones", async () => {
		const many = Array.from({ length: GALLERY_MAX_READS + 10 }, (_, i) => entry(`n${i}.notebook`, { modified: 1000 - i }));
		let n = 0;
		const items = await resolveGallery(many, ok("marked: star"), ctx(), async () => (++n, null));
		expect(items).toEqual([]);
		expect(n).toBe(GALLERY_MAX_READS);
	});
});
