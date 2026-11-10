import { describe, expect, it } from "vitest";
import { cardBodyText, linkedPaths, scanHygiene, titleKey, words, type HygieneCard } from "../src/zettel/hygiene";

const card = (id: string, over: Partial<HygieneCard> = {}): HygieneCard => ({
	path: `Zettel/${id}.md`, id, title: `T ${id}`, notebookId: "nb", pageId: `p-${id}`, region: null, links: [], ...over,
});

const LONG = "the quick brown fox jumps over the lazy dog while the cat watches quietly from the window";

async function scan(cards: HygieneCard[], texts: Record<string, string> = {}, outgoing: Array<[string, string[]]> = []) {
	return scanHygiene({
		cards,
		outgoing: new Map(outgoing.map(([k, v]) => [k, new Set(v)])),
		read: (c) => Promise.resolve(texts[c.id] ?? null),
		idle: () => Promise.resolve(),
	});
}

describe("hygiene helpers", () => {
	it("title keys ignore case, accents and punctuation", () => {
		expect(titleKey("  Élan Vital!  ")).toBe("elan vital");
		expect(titleKey("")).toBe("");
		expect(titleKey("?!")).toBe("");
	});
	it("the body is the note without frontmatter, embed and heading", () => {
		const raw = "---\nzettel-id: 1\n---\n![[Nb.notebook#p1&id=a]]\n\n## Transcription\n\nHello world\n";
		expect(words(cardBodyText(raw))).toEqual(["hello", "world"]);
		expect(cardBodyText("no frontmatter here")).toBe("no frontmatter here");
	});
	it("linked paths count links in both directions, never self links", () => {
		const a = card("a");
		const b = card("b");
		const c = card("c");
		const set = linkedPaths([a, b, c], new Map([[a.path, new Set([b.path, a.path])]]));
		expect(set.has(a.path) && set.has(b.path)).toBe(true);
		expect(set.has(c.path)).toBe(false);
		expect(linkedPaths([c], new Map([[c.path, new Set([c.path])]])).has(c.path)).toBe(false);
	});
	it("a note outside the cards linking to a card counts", () => {
		expect(linkedPaths([card("a")], new Map([["Daily.md", new Set(["Zettel/a.md"])]])).has("Zettel/a.md")).toBe(true);
	});
	it("a card's links property counts when it resolves", () => {
		const a = card("a", { links: ["[[b]]"] });
		const set = linkedPaths([a, card("b")], new Map(), (_c, l) => (l === "[[b]]" ? "Zettel/b.md" : null));
		expect(set.has("Zettel/b.md")).toBe(true);
	});
});

describe("scanHygiene", () => {
	it("lists unlinked and untitled cards", async () => {
		const r = await scan([card("1"), card("2", { title: "" }), card("3", { title: "  " })], {}, [["Zettel/1.md", ["Zettel/2.md"]]]);
		expect(r!.unlinked.map((c) => c.id)).toEqual(["3"]);
		expect(r!.untitled.map((c) => c.id)).toEqual(["2", "3"]);
	});
	it("groups cards with the same title", async () => {
		const r = await scan([card("1", { title: "Entropy" }), card("2", { title: "entropy " }), card("3", { title: "Other" })]);
		expect(r!.duplicates).toHaveLength(1);
		expect(r!.duplicates[0]!.cards.map((c) => c.id)).toEqual(["1", "2"]);
		expect(r!.duplicates[0]!.reasons).toEqual(["title"]);
	});
	it("untitled cards are not duplicates of each other by title", async () => {
		const r = await scan([card("1", { title: "" }), card("2", { title: "" })]);
		expect(r!.duplicates).toHaveLength(0);
	});
	it("two cards of the same page and region are duplicates; another region is not", async () => {
		const region = { x: 1, y: 2, width: 3, height: 4 };
		const r = await scan([
			card("1", { pageId: "p", region }), card("2", { pageId: "p", region: { ...region } }), card("3", { pageId: "p", region: { ...region, x: 9 } }),
		]);
		expect(r!.duplicates).toHaveLength(1);
		expect(r!.duplicates[0]!.cards.map((c) => c.id)).toEqual(["1", "2"]);
		expect(r!.duplicates[0]!.reasons).toEqual(["page"]);
	});
	it("identical and near-identical text are duplicates, different text is not", async () => {
		const r = await scan([card("1"), card("2"), card("3"), card("4")], {
			1: LONG, 2: `---\nx: 1\n---\n${LONG}`, 3: `${LONG} today`, 4: "something entirely different that talks about astronomy and the stars at night",
		});
		expect(r!.duplicates).toHaveLength(1);
		expect(r!.duplicates[0]!.cards.map((c) => c.id)).toEqual(["1", "2", "3"]);
		expect(r!.duplicates[0]!.reasons).toEqual(["text"]);
	});
	it("short texts are never compared", async () => {
		const r = await scan([card("1"), card("2")], { 1: "same words", 2: "same words" });
		expect(r!.duplicates).toHaveLength(0);
	});
	it("an unreadable note is still compared by title", async () => {
		const r = await scan([card("1", { title: "A" }), card("2", { title: "A" })]);
		expect(r!.duplicates).toHaveLength(1);
	});
	it("merges groups found by different reasons", async () => {
		const r = await scan([card("1", { title: "A", pageId: "p" }), card("2", { title: "A" }), card("3", { title: "B", pageId: "p" })]);
		expect(r!.duplicates).toHaveLength(1);
		expect(r!.duplicates[0]!.cards.map((c) => c.id)).toEqual(["1", "2", "3"]);
		expect(r!.duplicates[0]!.reasons).toEqual(["title", "page"]);
	});
	it("yields to the UI in slices and can be cancelled", async () => {
		const cards = Array.from({ length: 30 }, (_, i) => card(String(i)));
		let clock = 0;
		let idles = 0;
		let stop = false;
		const r = await scanHygiene({
			cards, outgoing: new Map(), read: () => { clock += 5; return Promise.resolve(LONG + clock); },
			idle: () => { idles++; if (idles === 3) stop = true; return Promise.resolve(); }, now: () => clock, sliceMs: 10, cancelled: () => stop,
		});
		expect(idles).toBe(3);
		expect(r).toBeNull();
	});
	it("handles a large vault", async () => {
		const cards = Array.from({ length: 2000 }, (_, i) => card(String(i)));
		const texts: Record<string, string> = {};
		for (const c of cards) texts[c.id] = `note number ${c.id} about topic ${Number(c.id) % 97} with some other words to make it long enough`;
		const r = await scan(cards, texts);
		expect(r!.scanned).toBe(2000);
	});
});
