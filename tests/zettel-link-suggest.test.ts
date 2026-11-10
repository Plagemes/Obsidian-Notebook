import { describe, expect, it } from "vitest";
import { boundCandidates, clampCount, hasSignal, rankLinkSuggestions, type LinkCandidate } from "../src/zettel/link-suggest";
import { readZettelSettings } from "../src/zettel/settings";

const card = (path: string, title: string, tags: string[] = [], mtime = 0): LinkCandidate => ({ path, id: path, title, tags, mtime });

describe("link suggestions (Z5)", () => {
	const cards = [
		card("a", "Spaced repetition schedules", ["memory", "learning"], 10),
		card("b", "Cooking pasta", ["food"], 20),
		card("c", "Memory palace technique", ["memory"], 30),
		card("d", "Retrieval practice", ["learning"], 5),
	];

	it("suggests nothing for an empty form", () => {
		expect(hasSignal({ title: "", tags: [] })).toBe(false);
		expect(rankLinkSuggestions({ title: "", tags: [] }, cards, 4)).toEqual([]);
	});

	it("ranks shared tags above a single shared word and drops unrelated cards", () => {
		const out = rankLinkSuggestions({ title: "", tags: ["#Memory", "learning"] }, cards, 4);
		expect(out.map((s) => s.candidate.path)).toEqual(["a", "c", "d"]);
		expect(out[0]!.sharedTags).toEqual(["memory", "learning"]);
	});

	it("matches title words ignoring accents and case, and a contained title", () => {
		const out = rankLinkSuggestions({ title: "Mémory techniques", tags: [] }, [card("x", "Memory palace technique", [], 1), card("y", "Other", [], 2)], 4);
		expect(out.map((s) => s.candidate.path)).toEqual(["x"]);
		const contained = rankLinkSuggestions({ title: "Retrieval", tags: [] }, cards, 4);
		expect(contained[0]!.candidate.path).toBe("d");
	});

	it("breaks ties by recency, honours the limit and the exclusion", () => {
		const out = rankLinkSuggestions({ title: "", tags: ["memory"] }, cards, 4);
		expect(out.map((s) => s.candidate.path)).toEqual(["c", "a"]);
		expect(rankLinkSuggestions({ title: "", tags: ["memory"] }, cards, 1)).toHaveLength(1);
		expect(rankLinkSuggestions({ title: "", tags: ["memory"] }, cards, 4, new Set(["c"])).map((s) => s.candidate.path)).toEqual(["a"]);
	});

	it("bounds the candidate set to the most recent cards", () => {
		const many = Array.from({ length: 1000 }, (_, i) => card(`p${i}`, `t${i}`, [], i));
		const kept = boundCandidates(many, 600);
		expect(kept).toHaveLength(600);
		expect(kept.some((c) => c.path === "p999")).toBe(true);
		expect(kept.some((c) => c.path === "p0")).toBe(false);
	});

	it("clamps the count and reads the settings leniently", () => {
		expect(clampCount(0)).toBe(1);
		expect(clampCount(99)).toBe(8);
		expect(clampCount("x")).toBe(4);
		expect(readZettelSettings({}).zettelLinkSuggest).toBe(true);
		expect(readZettelSettings({ zettelLinkSuggest: false, zettelLinkSuggestCount: 50 })).toMatchObject({ zettelLinkSuggest: false, zettelLinkSuggestCount: 8 });
		expect(readZettelSettings({ zettelLinkSuggestCount: "3" }).zettelLinkSuggestCount).toBe(4);
	});
});
