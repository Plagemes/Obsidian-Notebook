import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { boundCandidates, clampCount, goneChosen, hasSignal, linkOutcome, rankLinkSuggestions, resolveChosen, type LinkCandidate } from "../src/zettel/link-suggest";
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

	it("reads the sequence-link setting: a boolean only, on by default (review Z13)", () => {
		expect(readZettelSettings({}).zettelSequenceLink).toBe(true);
		expect(readZettelSettings({ zettelSequenceLink: false }).zettelSequenceLink).toBe(false);
		expect(readZettelSettings({ zettelSequenceLink: true }).zettelSequenceLink).toBe(true);
		expect(readZettelSettings({ zettelSequenceLink: "no" }).zettelSequenceLink).toBe(true);
		expect(readZettelSettings({ zettelSequenceLink: 0 }).zettelSequenceLink).toBe(true);
	});
});

describe("linking the chosen cards to the note just made (review Z1)", () => {
	const rec = (path: string, id: string) => ({ path, id });
	const a = rec("Cards/1 A.md", "1");
	const b = rec("Cards/2 B.md", "2");
	const byPath = new Map([a, b].map((c) => [c.path, c]));
	const byId = new Map([a, b].map((c) => [c.id, c]));

	it("resolves each chosen card, never the new note itself, and drops doubles", () => {
		const made = rec("Cards/3 C.md", "3");
		expect(resolveChosen([a, b, a, made], new Map([...byPath, [made.path, made]]), new Map([...byId, ["3", made]]), made.path)).toEqual([a, b]);
	});

	it("finds a card that was renamed meanwhile by its id, and drops one that is gone", () => {
		const renamed = rec("Moved/1 A.md", "1");
		expect(resolveChosen([a, rec("Cards/9 Gone.md", "9")], new Map([[renamed.path, renamed]]), new Map([["1", renamed]]), "x.md")).toEqual([renamed]);
		expect(resolveChosen([rec("Old/1.md", "1A")], new Map(), new Map([["1a", rec("New/1a.md", "1a")]]), "x.md")).toEqual([rec("New/1a.md", "1a")]);
	});

	it("links nothing when nothing was chosen, and says what happened", () => {
		expect(resolveChosen([], byPath, byId, "x.md")).toEqual([]);
		expect(linkOutcome(0, 0)).toBe("none");
		expect(linkOutcome(1, 0)).toBe("one");
		expect(linkOutcome(2, 0)).toBe("many");
		expect(linkOutcome(2, 1)).toBe("failed");
	});

	it("review R6: counts the chosen cards that are gone apart from those already linked", () => {
		const gone = rec("Cards/9 Gone.md", "9");
		expect(goneChosen([a, gone, gone, rec("x.md", "3")], byPath, byId, "x.md")).toBe(1);
		expect(goneChosen([a, b], byPath, byId, "x.md")).toBe(0);
		// A card renamed meanwhile is found by its id, so it is not gone.
		expect(goneChosen([rec("Old/1 A.md", "1")], new Map(), byId, "x.md")).toBe(0);
		expect(linkOutcome(0, 0, 2, 0)).toBe("gone");
		expect(linkOutcome(0, 0, 1, 1)).toBe("none"); // the one still there was linked already; the gone one is said apart
		expect(linkOutcome(1, 0, 1, 0)).toBe("one");
		expect(linkOutcome(0, 1, 1, 0)).toBe("failed");
		for (const key of ["zettel.suggest.gone", "zettel.suggest.goneOne", "sequence.linkFailed", "sequence.pageKept", "sequence.pageKeptSlipBox", "zettel.pageGone"] as const) {
			expect(en[key]).toBeTruthy();
			expect(itMessages[key]).toBeTruthy();
		}
		expect(en["zettel.suggest.gone"]).toContain("{n}");
		expect(en["zettel.suggest.goneOne"]).not.toContain("{n}");
	});
});
