import { describe, expect, it, vi } from "vitest";
import { hitLink, soleLink } from "../src/ink/link-text";
import type { PageElement, TextElement } from "../src/model/types";

vi.mock("obsidian", async () => ({ ...(await import("./fake-vault")).obsidianMock(), getLanguage: () => "en" }));

const {
	CHIP_BAND, CHIP_FONT_SIZE, CHIP_LEFT, CHIP_TOP, chipLabel, chipText, copyBlocker, hasChip, isOwnChip, planChip, planPairs, positionChoices, positionLabel, reversible, withoutChips,
} = await import("../src/library/copy-with-link-logic");

const fixed = (s: string, size: number) => Array.from(s).length * size * 0.5;

describe("chip text", () => {
	it("says where the page came from or went to", () => {
		expect(chipLabel("from", "Physics", 3)).toBe("Copied from Physics p.3");
		expect(chipLabel("to", "Maths", 7)).toBe("Copied to Maths p.7");
	});

	it("is one wikilink with the page number and the page id, so a whole-text link opens it", () => {
		const text = chipText("from", "Notes/Physics.notebook", "Physics", 3, "pg_abc123");
		const link = soleLink(text);
		expect(link).not.toBeNull();
		expect(link!.target).toBe("Notes/Physics.notebook");
		expect(link!.subpath).toMatch(/^p3&id=pg_abc123$/);
		expect(link!.display).toBe("Copied from Physics p.3");
	});

	it("keeps brackets, bars and hashes of a name out of the link", () => {
		const text = chipText("to", "A|B#C[[x]]", "A|B", 1, "pg1");
		expect(soleLink(text)).not.toBeNull();
		expect(text.match(/\|/g)).toHaveLength(1);
	});
});

describe("chips a copied page brought along", () => {
	it("drops the source's older chips and keeps everything else", () => {
		const old = planChip("c1", chipText("to", "Old.notebook", "Old", 4, "o4"), "Copied to Old p.4", { width: 595 }, fixed)!;
		const body: TextElement = { id: "b", type: "text", x: 40, y: 20, width: 200, text: "hello", fontSize: 12, color: "#000" };
		const link: TextElement = { ...body, id: "l", y: 300, text: chipText("to", "X.notebook", "X", 1, "x1"), fontSize: CHIP_FONT_SIZE };
		const kept = withoutChips([old, body, link]);
		expect(kept.map((e) => e.id)).toEqual(["b", "l"]);
		expect(withoutChips(undefined)).toEqual([]);
	});

	it("drops only the plugin's own chips, in either language, and keeps a small link of the page's own", () => {
		const base: TextElement = { id: "x", type: "text", x: CHIP_LEFT, y: CHIP_TOP, width: 200, text: "", fontSize: CHIP_FONT_SIZE, color: "#000" };
		const english = { ...base, id: "en", text: "[[Physics.notebook#p3&id=pg_abc123|Copied from Physics p.3]]" };
		const italian = { ...base, id: "it", text: "[[Fisica.notebook#p7|Copiata in Fisica p.7]]" };
		const ownLink = { ...base, id: "own", text: "[[Physics.notebook#p3&id=pg_abc123|See the proof]]" };
		const ownHeading = { ...base, id: "head", text: "[[Notes#Copied from the book|Copied from Notes p.2]]" };
		const plainNote = { ...base, id: "plain", text: "[[Reading list]]" };
		const otherSize = { ...english, id: "big", fontSize: 14 };
		const kept = withoutChips([english, italian, ownLink, ownHeading, plainNote, otherSize]);
		expect(kept.map((e) => e.id)).toEqual(["own", "head", "plain", "big"]);
		expect(isOwnChip(english)).toBe(true);
		expect(isOwnChip(italian)).toBe(true);
	});
});

describe("chip placement", () => {
	const page = { width: 595, elements: [] as PageElement[] };

	it("goes in the top margin, left, in a small size", () => {
		const text = chipText("from", "P.notebook", "P", 2, "pg2");
		const el = planChip("e1", text, chipLabel("from", "P", 2), page, fixed)!;
		expect(el).toMatchObject({ type: "text", x: CHIP_LEFT, y: CHIP_TOP, fontSize: CHIP_FONT_SIZE, text });
		expect(el.width).toBeLessThanOrEqual(page.width - 2 * CHIP_LEFT);
		expect(el.width).toBeGreaterThanOrEqual(60);
	});

	it("is a tap area for the link", () => {
		const text = chipText("from", "P.notebook", "P", 2, "pg2");
		const el = planChip("e1", text, "Copied from P p.2", page, fixed)!;
		expect(hitLink([el], el.x + 5, el.y + 3, 0, fixed)?.link.subpath).toBe("p2&id=pg2");
	});

	it("never exceeds a narrow page", () => {
		const text = chipText("from", "P.notebook", "A very long notebook name that goes on and on", 2, "pg2");
		const el = planChip("e1", text, "Copied from A very long notebook name that goes on and on p.2", { width: 200 }, fixed)!;
		expect(el.width).toBe(200 - 2 * CHIP_LEFT);
	});

	it("stacks under the chips the page already has", () => {
		const first = planChip("e1", chipText("from", "A.notebook", "A", 1, "a1"), "Copied from A p.1", page, fixed)!;
		const second = planChip("e2", chipText("to", "B.notebook", "B", 4, "b4"), "Copied to B p.4", { ...page, elements: [first] }, fixed)!;
		expect(second.y).toBeGreaterThan(first.y + first.fontSize);
		expect(second.x).toBe(first.x);
	});

	it("does not stack on ordinary text boxes or on content lower on the page", () => {
		const body: TextElement = { id: "t", type: "text", x: 40, y: 300, width: 200, text: "[[Note]]", fontSize: 14, color: "#000" };
		const chip = planChip("e", chipText("from", "A.notebook", "A", 1, "a1"), "Copied from A p.1", { width: 595, elements: [body] }, fixed)!;
		expect(chip.y).toBe(CHIP_TOP);
	});

	it("keeps a full band from pushing the chip into the page", () => {
		let elements: PageElement[] = [];
		for (let i = 0; i < 12; i++) {
			const el = planChip(`e${i}`, chipText("to", "B.notebook", "B", i + 1, `b${i}`), `Copied to B p.${i + 1}`, { width: 595, elements }, fixed)!;
			elements = [...elements, el];
			expect(el.y).toBeLessThanOrEqual(CHIP_BAND);
		}
	});

	it("is not added twice", () => {
		const text = chipText("from", "A.notebook", "A", 1, "a1");
		const el = planChip("e1", text, "Copied from A p.1", page, fixed)!;
		expect(hasChip([el], text)).toBe(true);
		expect(planChip("e2", text, "Copied from A p.1", { ...page, elements: [el] }, fixed)).toBeNull();
	});
});

describe("pairs of chips for several pages", () => {
	const input = {
		sources: [{ id: "s2", number: 2, locked: false }, { id: "s5", number: 5, locked: true }, { id: "s6", number: 6, locked: false }],
		copyIds: ["c2", "c5", "c6"], firstNumber: 8, sourceName: "Physics", destName: "Revision",
		sourceLinktext: "Physics.notebook", destLinktext: "Revision.notebook",
	};

	it("pairs each original with its copy, numbering the copies from where they were inserted", () => {
		const pairs = planPairs(input);
		expect(pairs.map((p) => [p.sourceNumber, p.copyNumber])).toEqual([[2, 8], [5, 9], [6, 10]]);
		expect(soleLink(pairs[1]!.fromText)!.subpath).toBe("p5&id=s5");
		expect(soleLink(pairs[1]!.toText)!.subpath).toBe("p9&id=c5");
		expect(pairs[1]!.fromAlias).toBe("Copied from Physics p.5");
		expect(pairs[1]!.toAlias).toBe("Copied to Revision p.9");
	});

	it("stops at the last copy when fewer ids than pages came back", () => {
		expect(planPairs({ ...input, copyIds: ["c2"] })).toHaveLength(1);
	});

	it("leaves locked and vanished originals without the reverse chip, and counts the locked", () => {
		const pairs = planPairs(input);
		const r = reversible(pairs, new Map([["s2", false], ["s5", true]]));
		expect(r.go.map((p) => p.sourceId)).toEqual(["s2"]);
		expect(r.skippedLocked).toBe(1);
		// An original locked since the copy is judged by the document as it is now.
		expect(reversible(pairs, new Map([["s2", true], ["s5", true], ["s6", false]])).go.map((p) => p.sourceId)).toEqual(["s6"]);
	});
});

describe("dialog decisions", () => {
	it("offers every place from the start to the end", () => {
		expect(positionChoices(0)).toEqual([0]);
		expect(positionChoices(3)).toEqual([0, 1, 2, 3]);
		expect(positionLabel(0, 3)).toBe("At the start");
		expect(positionLabel(3, 3)).toBe("At the end");
		expect(positionLabel(2, 3)).toBe("After page 2");
	});

	it("says what is missing before it can go on", () => {
		expect(copyBlocker(0, "a", true)).toBe("no-pages");
		expect(copyBlocker(2, null, false)).toBe("no-notebook");
		expect(copyBlocker(2, "a", false)).toBe("reading");
		expect(copyBlocker(2, "a", true)).toBeNull();
	});
});
