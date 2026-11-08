// 0.21 (#187) Back-of-book index: labels, term parsing, sorting (locale, accents), merging, sub-terms, the Markdown section and its replacement.
import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { createMarker } from "../src/model/markers";
import {
	DEFAULT_INDEX_PREFIX, INDEX_END, INDEX_START, indexOwnerOf, indexRegionOf, indexNoteIsMine, indexStartMarker, pickIndexNote, buildIndex, buildIndexSection, collectIndexEntries, filterIndex, indexCounts, indexLabel, indexTermOf,
	newIndexNote, normalizeIndexPrefix, replaceIndexSection, sectionLetter, splitTerm, type IndexEntry,
} from "../src/model/book-index";
import type { Page } from "../src/model/types";

function pageWith(...labels: Array<[string, number?]>): Page {
	const p = createPage({ width: 600, height: 800 });
	p.elements = labels.map(([text, y]) => createMarker("star", 50, y ?? 100, { text }));
	return p;
}

const entry = (term: string, pageIndex: number): IndexEntry => ({ path: splitTerm(term), ref: { pageIndex, pageId: `p${pageIndex}`, markerId: `m${pageIndex}${term}`, y: 0 } });
const names = (s: ReturnType<typeof buildIndex>) => s.flatMap((x) => x.terms.map((t) => t.name));

describe("prefix and labels", () => {
	it("normalizes the prefix to one word, with a default", () => {
		expect(normalizeIndexPrefix("")).toBe(DEFAULT_INDEX_PREFIX);
		expect(normalizeIndexPrefix("  idx: more words ")).toBe("idx:");
		expect(normalizeIndexPrefix(5)).toBe(DEFAULT_INDEX_PREFIX);
	});

	it("round-trips a term through its label", () => {
		const label = indexLabel("  Cell / Nucleus ", "#idx");
		expect(label).toBe("#idx Cell / Nucleus");
		expect(indexTermOf(label, "#idx")).toBe("Cell / Nucleus");
		expect(indexLabel("   ", "#idx")).toBeUndefined();
	});

	it("only recognises the prefix as a whole word, ignoring case, with a term after it", () => {
		expect(indexTermOf("#IDX Atom", "#idx")).toBe("Atom");
		expect(indexTermOf("#idxAtom", "#idx")).toBeNull();
		expect(indexTermOf("#idx", "#idx")).toBeNull();
		expect(indexTermOf("#idx   ", "#idx")).toBeNull();
		expect(indexTermOf("A question", "#idx")).toBeNull();
		expect(indexTermOf(undefined, "#idx")).toBeNull();
	});

	it("splits sub-terms, drops empty levels and caps the depth at three", () => {
		expect(splitTerm("A / B")).toEqual(["A", "B"]);
		expect(splitTerm(" A //  B / ")).toEqual(["A", "B"]);
		expect(splitTerm("a/b/c/d/e")).toEqual(["a", "b", "c / d / e"]);
		expect(splitTerm(" / ")).toEqual([]);
	});
});

describe("collectIndexEntries", () => {
	it("takes only prefixed markers, in page and reading order", () => {
		const pages = [pageWith(["#idx Beta", 300], ["#idx Alpha", 100], ["a plain question"]), pageWith(["#idx Alpha", 50])];
		const got = collectIndexEntries(pages, "#idx");
		expect(got.map((e) => [e.path.join("/"), e.ref.pageIndex])).toEqual([["Alpha", 0], ["Beta", 0], ["Alpha", 1]]);
	});

	it("honours a custom prefix", () => {
		expect(collectIndexEntries([pageWith(["ix Foo"], ["#idx Bar"])], "ix").map((e) => e.path[0])).toEqual(["Foo"]);
	});
});

describe("buildIndex", () => {
	it("sorts ignoring case and accents, and groups by first letter", () => {
		const index = buildIndex([entry("zebra", 0), entry("Élan", 1), entry("apple", 2), entry("Eagle", 3), entry("42", 4), entry("Ápex", 5)], "en");
		expect(index.map((s) => s.letter)).toEqual(["#", "A", "E", "Z"]);
		expect(names(index)).toEqual(["42", "Ápex", "apple", "Eagle", "Élan", "zebra"]);
	});

	it("sorts with the locale's collation (Swedish puts Å after Z)", () => {
		const sv = buildIndex([entry("Zoo", 1), entry("Ada", 2), entry("Zed", 0)], "sv");
		expect(names(sv)).toEqual(["Ada", "Zed", "Zoo"]);
	});

	it("orders numbers by value", () => {
		expect(names(buildIndex([entry("Chapter 10", 0), entry("Chapter 2", 1)], "en"))).toEqual(["Chapter 2", "Chapter 10"]);
	});

	it("merges duplicates (case and accents), keeps the first spelling and one reference per page", () => {
		const index = buildIndex([entry("Élan", 4), entry("elan", 1), entry("ELAN", 1), entry("Elan", 2)], "en");
		expect(index).toHaveLength(1);
		const term = index[0]!.terms[0]!;
		expect(term.name).toBe("Élan");
		expect(term.refs.map((r) => r.pageIndex)).toEqual([1, 2, 4]);
	});

	it("nests sub-terms under their term, merging parents, and creates an unmarked parent", () => {
		const index = buildIndex([entry("Cell / Nucleus", 2), entry("cell", 0), entry("Cell / Membrane", 1), entry("Atom / Core / Shell", 5)], "en");
		const cell = index.find((s) => s.letter === "C")!.terms[0]!;
		expect(cell.refs.map((r) => r.pageIndex)).toEqual([0]);
		expect(cell.children.map((c) => c.name)).toEqual(["Membrane", "Nucleus"]);
		const atom = index.find((s) => s.letter === "A")!.terms[0]!;
		expect(atom.refs).toEqual([]);
		expect(atom.children[0]!.children[0]!.refs.map((r) => r.pageIndex)).toEqual([5]);
	});

	it("counts terms (with sub-terms) and distinct pages", () => {
		const index = buildIndex([entry("A / B", 0), entry("A", 0), entry("C", 3)], "en");
		expect(indexCounts(index)).toEqual({ terms: 3, pages: 2 });
		expect(buildIndex([], "en")).toEqual([]);
	});

	it("falls back when the locale is not valid", () => {
		expect(names(buildIndex([entry("b", 0), entry("a", 1)], "not a locale!"))).toEqual(["a", "b"]);
	});

	it("section letters: accents removed, others under #", () => {
		expect(sectionLetter("Élan")).toBe("E");
		expect(sectionLetter("7 wonders")).toBe("#");
		expect(sectionLetter("¿Qué?")).toBe("#");
	});
});

describe("filterIndex", () => {
	const index = buildIndex([entry("Cell / Nucleus", 0), entry("Atom", 1), entry("Cell / Wall", 2)], "en");
	it("keeps matching terms, their parents, and everything under a matching parent", () => {
		expect(names(filterIndex(index, "nucl"))).toEqual(["Cell"]);
		expect(filterIndex(index, "nucl")[0]!.terms[0]!.children.map((c) => c.name)).toEqual(["Nucleus"]);
		expect(filterIndex(index, "CELL")[0]!.terms[0]!.children).toHaveLength(2);
		expect(filterIndex(index, "zzz")).toEqual([]);
		expect(filterIndex(index, " ")).toHaveLength(2);
	});
});

describe("Markdown section", () => {
	const link = (n: number) => `[[Nb#p${n}|p. ${n}]]`;
	const index = buildIndex([entry("Cell / Nucleus", 2), entry("Cell", 0), entry("Cell", 4), entry("[[evil]] *x*", 1)], "en");
	const section = buildIndexSection({ sections: index, pageLink: link, intro: "Intro", none: "Nothing" });

	it("lists letters, nested terms and page links, escaping the terms", () => {
		expect(section.startsWith(INDEX_START)).toBe(true);
		expect(section.endsWith(INDEX_END)).toBe(true);
		expect(section).toContain("### C");
		expect(section).toContain("- Cell — [[Nb#p1|p. 1]], [[Nb#p5|p. 5]]\n  - Nucleus — [[Nb#p3|p. 3]]");
		expect(section).toContain("\\[\\[evil\\]\\] \\*x\\*");
		expect(section).not.toContain("[[evil]]");
	});

	it("is stable and says when there is nothing", () => {
		expect(buildIndexSection({ sections: index, pageLink: link, intro: "Intro", none: "Nothing" })).toBe(section);
		expect(buildIndexSection({ sections: [], pageLink: link, intro: "Intro", none: "Nothing" })).toContain("Nothing");
	});

	it("replaces only the region between the markers", () => {
		const note = newIndexNote("Nb — Index", section);
		const next = buildIndexSection({ sections: [], pageLink: link, intro: "Intro", none: "Nothing" });
		const edited = `${note}\nmy own text after`;
		const r = replaceIndexSection(`Before\n\n${edited}`, next);
		expect(r.outcome).toBe("replaced");
		expect(r.text.startsWith("Before\n\n# Nb — Index")).toBe(true);
		expect(r.text.endsWith("my own text after")).toBe(true);
		expect(r.text).toContain("Nothing");
		expect(r.text).not.toContain("Nucleus");
	});

	it("creates, appends and refuses unsafe notes", () => {
		expect(replaceIndexSection("", section).outcome).toBe("created");
		expect(replaceIndexSection("my note", section).outcome).toBe("appended");
		expect(replaceIndexSection(`x ${INDEX_START} y`, section)).toEqual({ text: `x ${INDEX_START} y`, outcome: "unsafe" });
		expect(replaceIndexSection(`x ${INDEX_END} y`, section).outcome).toBe("unsafe");
	});
});

describe("review W21 D8: an index note belongs to one notebook", () => {
	const link = (n: number) => `[[Nb#p${n}|p. ${n}]]`;
	const make = (owner?: string) => buildIndexSection({ sections: [], pageLink: link, intro: "Intro", none: "Nothing", owner });

	it("records the notebook path in the start marker and reads it back, whatever the path holds", () => {
		for (const path of ["School/Bio 1.notebook", "A--B --> C.notebook", "Études/été #1.notebook"]) {
			const section = make(path);
			expect(section.startsWith("<!-- notebook-index:start for=")).toBe(true);
			expect(indexOwnerOf(`# t\n\n${section}\n`)).toBe(path);
		}
		expect(indexOwnerOf(`${make()}`)).toBeNull();
		expect(indexOwnerOf("my note")).toBeUndefined();
		expect(indexOwnerOf(`${indexStartMarker("x")} no end`)).toBeUndefined();
	});

	it("replaces a region of the same notebook, of a plain marker, and refuses another notebook's", () => {
		const mine = `Before\n\n${make("A.notebook")}\nAfter`;
		expect(replaceIndexSection(mine, make("A.notebook"), "A.notebook").outcome).toBe("replaced");
		const other = replaceIndexSection(mine, make("B.notebook"), "B.notebook");
		expect(other).toEqual({ text: mine, outcome: "other" });
		expect(replaceIndexSection(`x\n${make()}\ny`, make("A.notebook"), "A.notebook").outcome).toBe("replaced");
		// text outside the markers is untouched
		expect(replaceIndexSection(mine, make("A.notebook"), "A.notebook").text.startsWith("Before\n\n")).toBe(true);
		expect(replaceIndexSection(mine, make("A.notebook"), "A.notebook").text.endsWith("\nAfter")).toBe(true);
	});

	it("picks the plain name, or the first numbered one that is free or its own", async () => {
		const slots = (m: Record<number, { exists: boolean; folder?: boolean; owner?: string | null }>) => async (n: number) => m[n] ?? { exists: false };
		expect(await pickIndexNote(slots({}), "A")).toBe(1);
		expect(await pickIndexNote(slots({ 1: { exists: true, owner: "A" } }), "A")).toBe(1);
		// another notebook's note is skipped
		expect(await pickIndexNote(slots({ 1: { exists: true, owner: "B" } }), "A")).toBe(2);
		expect(await pickIndexNote(slots({ 1: { exists: true, owner: "B" }, 2: { exists: true, owner: "A" } }), "A")).toBe(2);
		expect(await pickIndexNote(slots({ 1: { exists: true, owner: "B" }, 2: { exists: true, owner: "C" } }), "A")).toBe(3);
		// the user's own note (no region) at the plain name is reported by the caller, not skipped
		expect(await pickIndexNote(slots({ 1: { exists: true, owner: undefined } }), "A")).toBe(1);
		// at a numbered name only the notebook's own note is reused
		expect(await pickIndexNote(slots({ 1: { exists: true, owner: "B" }, 2: { exists: true, owner: undefined } }), "A")).toBe(3);
		expect(await pickIndexNote(slots({ 1: { exists: true, folder: true } }), "A")).toBe(1);
		const all = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, { exists: true, owner: "B" }]));
		expect(await pickIndexNote(slots(all), "A")).toBeNull();
	});
});

describe("review W21 N1: the index note follows the notebook's document id", () => {
	const link = (n: number) => `[[Nb#p${n}|p. ${n}]]`;
	const make = (owner?: string, ownerId?: string) => buildIndexSection({ sections: [], pageLink: link, intro: "Intro", none: "Nothing", owner, ownerId });

	it("records the id next to the path and reads both back; old markers stay readable", () => {
		const s = make("Old/Bio.notebook", "doc id/1");
		expect(indexRegionOf(`# t\n${s}`)).toEqual({ path: "Old/Bio.notebook", id: "doc id/1" });
		expect(indexRegionOf(`# t\n${make("Old/Bio.notebook")}`)).toEqual({ path: "Old/Bio.notebook", id: null });
		expect(indexRegionOf(`# t\n${make()}`)).toEqual({ path: null, id: null });
		expect(indexOwnerOf(`# t\n${s}`)).toBe("Old/Bio.notebook");
		expect(indexRegionOf("plain")).toBeUndefined();
	});

	it("claims by id after a rename, by path for old markers, and by a vanished path; never another id", () => {
		expect(indexNoteIsMine({ owner: "Old/B", ownerId: "X" }, "New/B", "X")).toBe(true);
		expect(indexNoteIsMine({ owner: "New/B", ownerId: "Y" }, "New/B", "X")).toBe(false);
		expect(indexNoteIsMine({ owner: "New/B", ownerId: null }, "New/B", "X")).toBe(true);
		expect(indexNoteIsMine({ owner: "Old/B", ownerId: null }, "New/B", "X")).toBe(false);
		expect(indexNoteIsMine({ owner: "Old/B", ownerId: null, ownerGone: true }, "New/B", "X")).toBe(true);
		expect(indexNoteIsMine({ owner: "Old/B", ownerId: "Y", ownerGone: true }, "New/B", "X")).toBe(false);
	});

	it("rename the folder, then write: the note is replaced in place, not numbered", async () => {
		const note = `Before\n\n${make("Old/Bio.notebook", "X")}\nAfter`;
		const r = replaceIndexSection(note, make("New/Bio.notebook", "X"), "New/Bio.notebook", { id: "X", pathExists: () => false });
		expect(r.outcome).toBe("replaced");
		expect(r.text.startsWith("Before\n\n")).toBe(true);
		expect(r.text.endsWith("\nAfter")).toBe(true);
		expect(r.text).toContain('for=New%2FBio.notebook id=X');
		const pick = await pickIndexNote(async () => ({ exists: true, owner: "Old/Bio.notebook", ownerId: "X" }), "New/Bio.notebook", "X");
		expect(pick).toBe(1);
		// a path-only note whose path is gone is reclaimed; one whose path still exists is another notebook's
		expect(replaceIndexSection(`${make("Old/Bio.notebook")}`, make("New/Bio.notebook", "X"), "New/Bio.notebook", { id: "X", pathExists: () => false }).outcome).toBe("replaced");
		expect(replaceIndexSection(`${make("Old/Bio.notebook")}`, make("New/Bio.notebook", "X"), "New/Bio.notebook", { id: "X", pathExists: () => true }).outcome).toBe("other");
		// another notebook's id is never taken over, even when its path is gone
		expect(replaceIndexSection(`${make("Old/Bio.notebook", "Z")}`, make("New/Bio.notebook", "X"), "New/Bio.notebook", { id: "X", pathExists: () => false }).outcome).toBe("other");
		expect(await pickIndexNote(async (n) => (n === 1 ? { exists: true, owner: "Old/B", ownerId: "Z", ownerGone: true } : { exists: false }), "New/B", "X")).toBe(2);
		expect(await pickIndexNote(async (n) => (n === 1 ? { exists: true, owner: "Old/B", ownerId: null, ownerGone: true } : { exists: false }), "New/B", "X")).toBe(1);
	});
});
