import { describe, expect, it } from "vitest";
import { contextSnippet, hitsOfNote, lineOf, mentionPageId, mentionsMayChange, notebookMentions, pageMentionCount, pageMentions, sourcesIntact, type RawLink } from "../src/view/mentions-logic";

const pages = [{ id: "pg-aaaaaaaa" }, { id: "pg-bbbbbbbb" }, { id: "pg-cccccccc" }];
const link = (l: string, line = 0, col = 0, embed = false): RawLink => ({ link: l, line, col, endCol: col + l.length + 4, embed });
const yes = (p: string) => p === "Physics.notebook";

describe("mentionPageId", () => {
	it("resolves by number", () => {
		expect(mentionPageId("#p2", pages)).toBe("pg-bbbbbbbb");
	});
	it("prefers the id over the number", () => {
		expect(mentionPageId("#p1&id=pg-cccccccc", pages)).toBe("pg-cccccccc");
	});
	it("a page that is gone, no subpath and a heading name no page", () => {
		expect(mentionPageId("#p1&id=pg-zzzzzzzz", pages)).toBeNull();
		expect(mentionPageId("", pages)).toBeNull();
		expect(mentionPageId("#Heading", pages)).toBeNull();
		expect(mentionPageId("#p2", [])).toBeNull();
	});
	it("keeps a number inside the notebook", () => {
		expect(mentionPageId("#p99", pages)).toBe("pg-cccccccc");
	});
});

describe("hitsOfNote", () => {
	it("keeps only links to the notebook, with their page", () => {
		const hits = hitsOfNote("a/Note.md", [link("Physics.notebook#p3", 2), link("Other.notebook#p1", 3), link("Physics.notebook", 5, 0, true)], yes, pages);
		expect(hits.map((h) => [h.line, h.pageId, h.embed])).toEqual([[2, "pg-cccccccc", false], [5, null, true]]);
	});
});

describe("grouping", () => {
	const hits = [
		...hitsOfNote("b/Zed.md", [link("Physics.notebook#p1", 4), link("Physics.notebook#p1", 1)], yes, pages),
		...hitsOfNote("a/alpha.md", [link("Physics.notebook#p1&id=pg-aaaaaaaa", 7), link("Physics.notebook", 0)], yes, pages),
		...hitsOfNote("c/Mid.md", [link("Physics.notebook#p2", 2)], yes, pages),
	];
	it("lists a row per note for a page, by name, links in reading order", () => {
		const rows = pageMentions(hits, "pg-aaaaaaaa");
		expect(rows.map((r) => r.name)).toEqual(["alpha", "Zed"]);
		expect(rows[1]!.folder).toBe("b");
		expect(rows[1]!.hits.map((h) => h.line)).toEqual([1, 4]);
	});
	it("lists the notes that link without a page", () => {
		expect(notebookMentions(hits).map((r) => r.notePath)).toEqual(["a/alpha.md"]);
	});
	it("counts links to a page", () => {
		expect(pageMentionCount(hits, "pg-aaaaaaaa")).toBe(3);
		expect(pageMentionCount(hits, "pg-bbbbbbbb")).toBe(1);
		expect(pageMentionCount(hits, "pg-cccccccc")).toBe(0);
		expect(pageMentionCount(hits, null)).toBe(0);
	});
});

describe("contextSnippet", () => {
	it("returns a short line whole, whitespace collapsed", () => {
		expect(contextSnippet("  See   [[Physics.notebook#p3]]   for it ", 8, 30)).toBe("See [[Physics.notebook#p3]] for it");
	});
	it("cuts a long line around the link and marks the cuts", () => {
		const text = `${"a ".repeat(100)}[[Physics.notebook#p3]]${" b".repeat(100)}`;
		const start = text.indexOf("[[");
		const out = contextSnippet(text, start, start + 23, 60);
		expect(out.length).toBeLessThanOrEqual(62);
		expect(out).toContain("[[Physics.notebook#p3]]");
		expect(out.startsWith("…")).toBe(true);
		expect(out.endsWith("…")).toBe(true);
	});
	it("handles a blank line and out-of-range columns", () => {
		expect(contextSnippet("", 0, 0)).toBe("");
		expect(contextSnippet("abc", 10, 20)).toBe("abc");
	});
});

describe("lineOf", () => {
	it("returns a line or an empty string", () => {
		expect(lineOf("a\nb\nc", 1)).toBe("b");
		expect(lineOf("a\nb\nc", 2)).toBe("c");
		expect(lineOf("a\nb", 5)).toBe("");
	});
});

describe("which changes can alter the mentions", () => {
	const known = new Set(["Notes/a.md"]);
	const never = () => {
		throw new Error("the fresh links must not be read");
	};
	it("ignores a note that neither linked here nor links here now", () => {
		expect(mentionsMayChange("Other.md", "Physics.notebook", known, { "x.md": 1 }, () => false)).toBe(false);
		expect(mentionsMayChange("Other.md", "Physics.notebook", known, undefined, () => false)).toBe(false);
	});
	it("follows a known source, even when it no longer links here", () => {
		expect(mentionsMayChange("Notes/a.md", "Physics.notebook", known, {}, never)).toBe(true);
	});
	it("follows a note the index already has linking here", () => {
		expect(mentionsMayChange("b.md", "Physics.notebook", known, { "Physics.notebook": 2 }, never)).toBe(true);
		expect(mentionsMayChange("b.md", "Physics.notebook", known, { "Physics.notebook": 0 }, () => false)).toBe(false);
	});
	it("follows a note whose fresh links now reach the notebook, and never the notebook itself", () => {
		expect(mentionsMayChange("c.md", "Physics.notebook", known, undefined, () => true)).toBe(true);
		expect(mentionsMayChange("Physics.notebook", "Physics.notebook", new Set(["Physics.notebook"]), undefined, () => true)).toBe(false);
	});
	it("notices a source that is gone", () => {
		expect(sourcesIntact(known, (p) => p === "Notes/a.md")).toBe(true);
		expect(sourcesIntact(known, () => false)).toBe(false);
		expect(sourcesIntact(new Set(), () => false)).toBe(true);
	});
});
