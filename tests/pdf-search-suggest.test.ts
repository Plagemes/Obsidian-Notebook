import { describe, expect, it } from "vitest";
import {
	boundedDistance, buildPool, cleanTerm, filterSuggestions, foldTerm, gatherSuggestInput, matchTier, signatureOf, SuggestCache,
	MAX_HEADING_TERMS, MAX_OUTLINE_TERMS, MAX_TERM_CHARS, MAX_TEXT_TERMS,
	type SuggestInput,
} from "../src/pdf/search-suggest";
import { createDocument, createPage } from "../src/model/document";
import type { Page } from "../src/model/types";

const input = (over: Partial<SuggestInput> = {}): SuggestInput => ({ outline: [], headings: [], text: [], ...over });

describe("cleanTerm", () => {
	it("makes one clean line, cut at a word when long", () => {
		expect(cleanTerm("  Chapter\n 1:  Limits  ")).toBe("Chapter 1: Limits");
		const long = cleanTerm("alpha ".repeat(30));
		expect(long.length).toBeLessThanOrEqual(MAX_TERM_CHARS);
		expect(long.endsWith("alpha")).toBe(true);
	});
	it("drops numbers, symbols and one-letter terms", () => {
		expect(cleanTerm("42")).toBe("");
		expect(cleanTerm("—")).toBe("");
		expect(cleanTerm("a")).toBe("");
		expect(cleanTerm("1.2 Limiti")).toBe("1.2 Limiti");
	});
});

describe("buildPool", () => {
	it("ranks the outline, then headings, then frequent words, and keeps the outline's order", () => {
		const pool = buildPool(input({
			outline: ["Introduction", "Derivatives"],
			headings: ["Second law"],
			text: ["entropy entropy entropy enthalpy enthalpy once"],
		}));
		expect(pool.map((s) => s.term)).toEqual(["Introduction", "Derivatives", "Second law", "entropy", "enthalpy"]);
		expect(pool.map((s) => s.source)).toEqual(["outline", "outline", "heading", "text", "text"]);
	});
	it("leaves out stop-words (English and Italian) and words seen once", () => {
		const pool = buildPool(input({ text: ["the and with della funzione funzione limit limit limit 2026 2026 once"] }));
		expect(pool.map((s) => s.term)).toEqual(["limit", "funzione"]);
	});
	it("deduplicates ignoring case and accents, keeping the strongest source", () => {
		const pool = buildPool(input({ outline: ["Perché"], headings: ["perche", "Entropia"], text: ["entropia entropia"] }));
		expect(pool.map((s) => [s.term, s.source])).toEqual([["Perché", "outline"], ["Entropia", "heading"]]);
	});
	it("is bounded whatever the notebook holds", () => {
		const outline = Array.from({ length: 5000 }, (_, i) => `Section ${i} title`);
		const headings = Array.from({ length: 5000 }, (_, i) => `Heading ${i} here`);
		const text = [Array.from({ length: 20000 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i >> 5) % 26))}${i % 300} `).join("").repeat(2)];
		const pool = buildPool(input({ outline, headings, text }));
		expect(pool.filter((s) => s.source === "outline").length).toBe(MAX_OUTLINE_TERMS);
		expect(pool.filter((s) => s.source === "heading").length).toBe(MAX_HEADING_TERMS);
		expect(pool.filter((s) => s.source === "text").length).toBeLessThanOrEqual(MAX_TEXT_TERMS);
	});
	it("an empty notebook has no pool", () => {
		expect(buildPool(input())).toEqual([]);
	});
});

describe("matching", () => {
	it("measures a bounded edit distance", () => {
		expect(boundedDistance("entropy", "entropy", 1)).toBe(0);
		expect(boundedDistance("entrpy", "entropy", 1)).toBe(1);
		expect(boundedDistance("entopry", "entropy", 1)).toBeGreaterThan(1);
	});
	it("tiers: prefix, word prefix, inside, one typo", () => {
		expect(matchTier("ent", foldTerm("Entropy"))).toBe(4);
		expect(matchTier("law", foldTerm("Second law"))).toBe(3);
		expect(matchTier("tropy", foldTerm("Entropy"))).toBe(2);
		expect(matchTier("entrpy", foldTerm("Entropy"))).toBe(1);
		expect(matchTier("zzz", foldTerm("Entropy"))).toBe(0);
	});
});

describe("filterSuggestions", () => {
	const pool = buildPool(input({
		outline: ["Entropy and heat", "Derivatives", "Limits of functions"],
		headings: ["Second law", "Entalpia"],
		text: ["enthalpy enthalpy entropy entropy entropy"],
	}));
	it("with nothing typed, shows a mix of the sources up to the limit", () => {
		const out = filterSuggestions(pool, "", 4);
		expect(out.length).toBe(4);
		expect(new Set(out.map((s) => s.source)).size).toBeGreaterThanOrEqual(2);
		expect(filterSuggestions(pool, "  ", 100).length).toBe(pool.length);
	});
	it("typing filters by prefix first, then by word and by typo, ignoring accents and case", () => {
		const out = filterSuggestions(pool, "ENT", 10).map((s) => s.term);
		expect(out.slice(0, 3)).toContain("Entropy and heat");
		expect(out).toContain("entropy");
		expect(out).not.toContain("Derivatives");
		expect(filterSuggestions(pool, "law", 5).map((s) => s.term)).toEqual(["Second law"]);
		expect(filterSuggestions(pool, "derivtives", 5).map((s) => s.term)).toEqual(["Derivatives"]);
		expect(filterSuggestions(pool, "entalpí", 5).map((s) => s.term)).toContain("Entalpia");
	});
	it("does not offer what is already typed, and respects the limit", () => {
		expect(filterSuggestions(pool, "derivatives", 5)).toEqual([]);
		expect(filterSuggestions(pool, "e", 2).length).toBe(2);
		expect(filterSuggestions(pool, "e", 0)).toEqual([]);
		expect(filterSuggestions([], "e", 5)).toEqual([]);
	});
});

describe("cache and signature", () => {
	it("builds once for equal sources and again when they change", () => {
		const cache = new SuggestCache();
		const a = cache.get(input({ outline: ["Alpha"] }));
		const b = cache.get(input({ outline: ["Alpha"] }));
		expect(b).toBe(a);
		expect(cache.built).toBe(1);
		cache.get(input({ outline: ["Alpha", "Beta"] }));
		expect(cache.built).toBe(2);
		cache.clear();
		cache.get(input({ outline: ["Alpha", "Beta"] }));
		expect(cache.built).toBe(3);
	});
	it("the signature tells different sources apart", () => {
		expect(signatureOf(input({ headings: ["ab"] }))).not.toBe(signatureOf(input({ text: ["ab"] })));
		expect(signatureOf(input({ text: ["ab", "c"] }))).not.toBe(signatureOf(input({ text: ["a", "bc"] })));
	});
});

describe("gatherSuggestInput", () => {
	it("reads one notebook: outline entries it shows, titles, labels and typed text", () => {
		const doc = createDocument();
		const p1: Page = createPage();
		p1.background = { kind: "pdf", asset: "pdf1", page: 3 };
		p1.elements = [
			{ id: "t", type: "text", x: 0, y: 0, width: 100, text: "typed words", fontSize: 16, color: "#000000" },
			{ id: "b", type: "box", kind: "definition", x: 0, y: 0, width: 10, height: 10, title: "Entropy" },
			{ id: "s", type: "sticky", x: 0, y: 0, width: 10, height: 10, color: "#ffff00", text: "remember this", fontSize: 14 },
			{ id: "c", type: "checkbox", x: 0, y: 0, size: 10, color: "#000000", label: "read chapter" },
		] as Page["elements"];
		doc.pages = [p1];
		doc.meta = { tags: [], favorite: false, cover: "#6d8bff", bookmarks: [], bookmarkInfo: { [p1.id]: { title: "Midterm" } } };
		const got = gatherSuggestInput(doc, {
			pdf1: [{ title: "Chapter 3", level: 1, page: 3 }, { title: "Chapter 9", level: 1, page: 9 }],
			other: [{ title: "Not mine", level: 1, page: 1 }],
		});
		expect(got.outline).toEqual(["Chapter 3"]);
		expect(got.headings).toEqual(expect.arrayContaining(["Midterm", "Entropy"]));
		expect(got.text).toEqual(expect.arrayContaining(["typed words", "remember this", "read chapter"]));
	});
	it("no document, no sources", () => {
		expect(gatherSuggestInput(null)).toEqual({ outline: [], headings: [], text: [] });
	});
});
