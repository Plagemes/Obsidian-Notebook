import { describe, expect, it } from "vitest";
import type { LibraryEntry } from "../src/library/index";
import { containsPhrase, coursesOfNote, linkNamesNote, relatedPages, tagsRelate, type RelatedNote } from "../src/library/related-pages";
import type { ClassEntry } from "../src/timetable/schedule";

/** An entry whose pages carry the given texts (page index = position). */
function entry(name: string, pageTexts: Array<string | null>, extra: Partial<LibraryEntry> = {}): LibraryEntry {
	let text = "";
	const textPages: number[] = [];
	pageTexts.forEach((p, i) => {
		if (p === null) return;
		textPages.push(i, text.length);
		text += p + " ";
	});
	return {
		path: `Notebooks/${name}.notebook`, folder: "Notebooks", name, mtime: 1, size: 1, created: 1, modified: 100, pages: pageTexts.length,
		...(text ? { text, textPages } : {}), tags: [], favorite: false, cover: "#888888", ...extra,
	};
}

const note: RelatedNote = { path: "Notes/Optics.md", title: "Optics", aliases: ["Light theory"], tags: ["#physics/optics"], headings: ["Snell law", "Lenses"] };

describe("matching helpers", () => {
	it("tags relate when equal or in the same branch", () => {
		expect(tagsRelate("physics", "physics/optics")).toBe(true);
		expect(tagsRelate("physics/optics", "physics/optics")).toBe(true);
		expect(tagsRelate("physics", "physicsx")).toBe(false);
		expect(tagsRelate("", "a")).toBe(false);
	});
	it("a phrase is matched as a whole word", () => {
		expect(containsPhrase("the optics lab", "optics")).toBe(true);
		expect(containsPhrase("biooptics", "optics")).toBe(false);
		expect(containsPhrase("optics.", "optics")).toBe(true);
		expect(containsPhrase("xx", "xx")).toBe(false);
	});
	it("a link names the note by name or by full path, ignoring case and accents", () => {
		expect(linkNamesNote("optics", note)).toBe(true);
		expect(linkNamesNote("Notes/Optics", note)).toBe(true);
		expect(linkNamesNote("Other/Optics", note)).toBe(true);
		expect(linkNamesNote("Optica", note)).toBe(false);
		expect(linkNamesNote("", note)).toBe(false);
	});
});

describe("relatedPages", () => {
	it("ranks a page that links to the note above a page that only names it", () => {
		const rows = relatedPages([entry("Lab", ["See [[Optics]] for the law", "We studied optics today"])], note);
		expect(rows.map((r) => [r.page, r.reason])).toEqual([[0, "links"], [1, "title"]]);
		expect(rows[1]!.detail).toBe("Optics");
	});

	it("reads links with a folder, a heading and an alias, and ignores embeds", () => {
		const rows = relatedPages([entry("A", ["[[Notes/Optics#Lenses|the lenses]]", "![[Optics]]", "[[Optical]]"])], { ...note, title: "Optics" });
		expect(rows.filter((r) => r.reason === "links").map((r) => r.page)).toEqual([0]);
	});

	it("finds aliases, headings and page tags", () => {
		const e = entry("Notes", ["Light theory summary", "The Snell law is n1 sin a", null, "blank"], { pageTags: [{ page: 2, tags: ["physics"] }] });
		const rows = relatedPages([e], note);
		const byPage = new Map(rows.map((r) => [r.page, r]));
		expect(byPage.get(0)!.reason).toBe("alias");
		expect(byPage.get(1)!.reason).toBe("heading");
		expect(byPage.get(1)!.detail).toBe("Snell law");
		expect(byPage.get(2)!.reason).toBe("tag");
		expect(byPage.get(2)!.detail).toBe("#physics");
		expect(byPage.has(3)).toBe(false);
	});

	it("a notebook named like the note, and a bookmark titled like it, relate", () => {
		const rows = relatedPages([entry("Optics", ["x"]), entry("Other", ["a", "b"], { bookmarks: [{ page: 1, title: "optics" }] })], note);
		expect(rows.map((r) => `${r.name}:${r.page}:${r.reason}`).sort()).toEqual(["Optics:0:title", "Other:1:title"]);
	});

	it("a page with two reasons keeps the best one and ranks above a page with one", () => {
		const both = entry("Both", ["[[Optics]] and the Lenses chapter"]);
		const one = entry("One", ["[[Optics]]"], { modified: 999 });
		const rows = relatedPages([one, both], note);
		expect(rows[0]!.name).toBe("Both");
		expect(rows[0]!.reason).toBe("links");
		expect(rows[0]!.also).toEqual(["title", "heading"]);
	});

	it("is quiet when nothing relates, and short words never match", () => {
		expect(relatedPages([entry("Biology", ["cells and enzymes"])], note)).toEqual([]);
		expect(relatedPages([entry("X", ["it is an on"])], { ...note, title: "On", aliases: [], tags: [], headings: [] })).toEqual([]);
	});

	it("caps the rows per notebook (links excepted) and the total", () => {
		const many = entry("Many", Array.from({ length: 12 }, () => "optics"));
		expect(relatedPages([many], note)).toHaveLength(5);
		const links = entry("Links", Array.from({ length: 12 }, () => "[[Optics]]"));
		expect(relatedPages([links], note)).toHaveLength(12);
		expect(relatedPages([links], note, { limit: 3 })).toHaveLength(3);
	});

	it("notebook-level tags give the first page a weak match", () => {
		const rows = relatedPages([entry("Tagged", ["a", "b"], { tags: ["physics"] })], note);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ page: 0, reason: "tag" });
	});

	it("is deterministic: ties go to the most recently changed notebook, then the name", () => {
		const a = entry("A", ["optics"], { modified: 5 });
		const b = entry("B", ["optics"], { modified: 9 });
		expect(relatedPages([a, b], note).map((r) => r.name)).toEqual(["B", "A"]);
		expect(relatedPages([b, a], note).map((r) => r.name)).toEqual(["B", "A"]);
	});
});

describe("courses", () => {
	const cls = (course: string, notebook?: string): ClassEntry => ({ id: course, course, day: 1, start: "08:00", end: "09:00", weeks: "all", ...(notebook ? { notebook } : {}) });
	const classes = [cls("Physics", "Notebooks/Physics"), cls("Chemistry", "Notebooks/Chem")];

	it("the note belongs to the course whose folder holds it or whose name it carries", () => {
		expect(coursesOfNote({ ...note, path: "Notebooks/Physics/Optics.md" }, classes).map((c) => c.course)).toEqual(["Physics"]);
		expect(coursesOfNote({ ...note, tags: ["#chemistry"] }, classes).map((c) => c.course)).toEqual(["Chemistry"]);
		expect(coursesOfNote({ ...note, tags: ["#maths"] }, classes)).toEqual([]);
	});

	it("adds the first page of the course's notebooks, last, once per notebook", () => {
		const n = { ...note, path: "Notebooks/Physics/Optics.md", tags: [] as string[] };
		const lab: LibraryEntry = { ...entry("Lab", ["[[Optics]]"]), path: "Notebooks/Physics/Lab.notebook" };
		const other: LibraryEntry = { ...entry("Waves", ["a", "b"]), path: "Notebooks/Physics/Waves.notebook" };
		const chem: LibraryEntry = { ...entry("Acids", ["a"]), path: "Notebooks/Chem/Acids.notebook" };
		const rows = relatedPages([lab, other, chem], n, { classes });
		expect(rows.map((r) => `${r.name}:${r.page}:${r.reason}`)).toEqual(["Lab:0:links", "Waves:0:course"]);
		expect(rows[1]!.detail).toBe("Physics");
		expect(relatedPages([lab, other, chem], n, { classes, course: false }).map((r) => r.name)).toEqual(["Lab"]);
		expect(relatedPages([lab, other, chem], n).map((r) => r.name)).toEqual(["Lab"]);
	});
});

describe("aliasesOf", () => {
	it("reads aliases or alias, a list or a comma-separated string, without blanks or repeats", async () => {
		const { aliasesOf } = await import("../src/library/related-pages");
		expect(aliasesOf({ aliases: ["Light theory", " ", "Light theory", "Rays"] })).toEqual(["Light theory", "Rays"]);
		expect(aliasesOf({ alias: "One, Two" })).toEqual(["One", "Two"]);
		expect(aliasesOf({ aliases: 5 })).toEqual([]);
		expect(aliasesOf(null)).toEqual([]);
		expect(aliasesOf("x")).toEqual([]);
	});
});

describe("course by tag", () => {
	it("a nested tag counts as the course of its first segment", () => {
		const classes: ClassEntry[] = [{ id: "p", course: "Physics", day: 1, start: "08:00", end: "09:00", weeks: "all" }];
		expect(coursesOfNote({ ...note, tags: ["#physics/optics"] }, classes).map((c) => c.course)).toEqual(["Physics"]);
		expect(coursesOfNote({ ...note, tags: ["#physicsx"] }, classes)).toEqual([]);
	});
});
