// 0.21 (#187) Back-of-book index: labels, term parsing, sorting (locale, accents), merging, sub-terms, the Markdown section and its replacement.
import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { createMarker } from "../src/model/markers";
import {
	DEFAULT_INDEX_PREFIX, INDEX_END, INDEX_START, buildIndex, buildIndexSection, collectIndexEntries, filterIndex, indexCounts, indexLabel, indexTermOf,
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
