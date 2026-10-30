import { describe, expect, it } from "vitest";
import { parseEmbedSource } from "../src/integration/links";
import { embedSourceFromFile, pageFromSubpath } from "../src/integration/page-links";
import { arrowPoints, linePoints, rectPoints } from "../src/ink/shapes";
import { regionSize } from "../src/library/thumbnail";
import type { CompanionTextDeps } from "../src/model/companion-content";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { arrowEnds, arrowLink, cardAt, type CardArea } from "../src/zettel/arrows";
import {
	addLinks, cardEmbed, cardProperties, editProperties, isCardFrontmatter, linkTarget, newCardText, orphanChanges, parseTagInput,
	readCard, titleChanges, TRANSCRIPTION_HEADING, type NewCard,
} from "../src/zettel/card-content";
import {
	cardFileName, idSet, indexLetters, isUntitledCardName, letterIndex, localDate, nameSuffixFor, nextCardId, nextLuhmannChild, nextLuhmannTop,
	parseLuhmann, randomSuffix, timestampId,
} from "../src/zettel/ids";
import { LocalPages } from "../src/zettel/local-pages";
import { A6_PAGE, readZettelSettings } from "../src/zettel/settings";
import {
	cardSubpath, clampRegion, formatRegion, lookupPage, parseRegion, parseSubpathParams, regionFromBounds,
} from "../src/zettel/subpath";

/** Test stand-ins for Obsidian's frontmatter helpers: `key: <JSON>` lines. */
const deps: CompanionTextDeps = {
	frontmatterInfo(text) {
		const open = /^---\r?\n/.exec(text);
		if (!open) return { exists: false, from: 0, to: 0 };
		const from = open[0].length;
		const close = text.indexOf("\n---", from - 1);
		return close < 0 ? { exists: false, from: 0, to: 0 } : { exists: true, from, to: close + 1 };
	},
	parseFrontmatter(yaml) {
		const out: Record<string, unknown> = {};
		for (const raw of yaml.split(/\r?\n/)) {
			if (!raw.trim()) continue;
			const i = raw.indexOf(":");
			if (i < 0) return null;
			try {
				out[raw.slice(0, i).trim()] = JSON.parse(raw.slice(i + 1).trim());
			} catch {
				return null;
			}
		}
		return out;
	},
	stringify(data) {
		return Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
	},
};

function unquote(v: string): string {
	const m = /^"(.*)"$/.exec(v.trim()) ?? /^'(.*)'$/.exec(v.trim());
	return m ? m[1]! : v.trim();
}

/** A small YAML reader for the line-edit tests: plain and quoted scalars, block lists, comments, blank lines. */
const yamlDeps: CompanionTextDeps = {
	frontmatterInfo: (text) => deps.frontmatterInfo(text),
	parseFrontmatter(yaml) {
		const out: Record<string, unknown> = {};
		let list: unknown[] | null = null;
		for (const raw of yaml.split(/\r?\n/)) {
			const line = raw.replace(/\s+#.*$/, "");
			if (!line.trim() || line.trim().startsWith("#")) continue;
			const item = /^\s*-\s+(.*)$/.exec(line);
			if (item) {
				if (!list) return null;
				list.push(unquote(item[1]!));
				continue;
			}
			const kv = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
			if (!kv) return null;
			const key = unquote(kv[1]!);
			if (kv[2] === "") out[key] = list = [];
			else {
				list = null;
				out[key] = kv[2] === "true" ? true : unquote(kv[2]!);
			}
		}
		return out;
	},
	stringify(data) {
		return Object.entries(data).map(([k, v]) => (Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}` : `${k}: ${JSON.stringify(v)}`)).join("\n") + "\n";
	},
};

describe("card ids", () => {
	const at = new Date(2026, 9, 29, 14, 42, 7);

	it("timestamp: seconds and a random suffix (collision-safe across devices), then a counter", () => {
		expect(timestampId(at, new Set(), "k3f9")).toBe("20261029144207-k3f9");
		expect(timestampId(at, idSet(["20261029144207-K3F9"]), "k3f9")).toBe("20261029144207-k3f9-2");
		expect(timestampId(at, idSet(["20261029144207-k3f9", "20261029144207-k3f9-2"]), "k3f9")).toBe("20261029144207-k3f9-3");
		// Two devices, same second, neither knowing the other's card: different ids (and so different file names).
		const a = timestampId(at, new Set());
		const b = timestampId(at, new Set());
		expect(a).toMatch(/^20261029144207-[a-z0-9]{4}$/);
		expect(a).not.toBe(b);
		expect(parseLuhmann(a)).toBeNull();
	});

	it("random suffixes are short, lower case and use the whole alphabet", () => {
		expect(randomSuffix(() => 0)).toBe("aaaa");
		expect(randomSuffix(() => 0.999999)).toBe("9999");
		const many = new Set(Array.from({ length: 200 }, () => randomSuffix()));
		expect(many.size).toBeGreaterThan(190);
		for (const s of many) expect(s).toMatch(/^[a-z0-9]{4}$/);
	});

	it("parses Luhmann ids", () => {
		expect(parseLuhmann("1a2b")).toEqual([1, "a", 2, "b"]);
		expect(parseLuhmann("21")).toEqual([21]);
		expect(parseLuhmann("a1")).toBeNull();
		expect(parseLuhmann("202610291442-2")).toBeNull();
		expect(parseLuhmann("1A")).toEqual([1, "a"]);
	});

	it("letters are bijective base 26", () => {
		expect(letterIndex("a")).toBe(1);
		expect(letterIndex("z")).toBe(26);
		expect(letterIndex("aa")).toBe(27);
		for (const n of [1, 2, 25, 26, 27, 52, 53, 702, 703]) expect(letterIndex(indexLetters(n))).toBe(n);
		expect(indexLetters(27)).toBe("aa");
	});

	it("Luhmann top level and branches", () => {
		expect(nextLuhmannTop(new Set())).toBe("1");
		expect(nextLuhmannTop(idSet(["1", "2", "10", "2a", "202610291442x"]))).toBe("11");
		const taken = idSet(["1", "1a", "1b", "1a1", "1a2", "10"]);
		expect(nextLuhmannChild("1", taken)).toBe("1c");
		expect(nextLuhmannChild("1a", taken)).toBe("1a3");
		expect(nextLuhmannChild("1b", taken)).toBe("1b1");
		expect(nextLuhmannChild("2", taken)).toBe("2a");
		expect(nextLuhmannChild("1z", idSet(["1z", "1z9"]))).toBe("1z10");
		expect(nextLuhmannChild("1", idSet(["1", "1z"]))).toBe("1aa");
		expect(nextLuhmannChild("x", taken)).toBeNull();
	});

	it("nextCardId follows the scheme; a bad parent gives a top-level id", () => {
		const taken = idSet(["1", "1a"]);
		expect(nextCardId("timestamp", at, taken, null, "abcd")).toBe("20261029144207-abcd");
		expect(nextCardId("luhmann", at, taken)).toBe("2");
		expect(nextCardId("luhmann", at, taken, "1")).toBe("1b");
		expect(nextCardId("luhmann", at, taken, "not an id")).toBe("2");
	});

	it("file names: id and cleaned title", () => {
		expect(cardFileName("202610291442", "Energy: what is it?")).toBe("202610291442 Energy what is it");
		expect(cardFileName("1a", "  ")).toBe("1a");
		expect(cardFileName("1a", "[[x]] #tag | y")).toBe("1a x tag y");
		expect(cardFileName("1", "a".repeat(200)).length).toBeLessThanOrEqual(2 + 80);
		expect(localDate(at)).toBe("2026-10-29");
	});

	it("untitled Luhmann cards get a suffix in the file name, never in the id", () => {
		expect(cardFileName("2", "", "k3f9")).toBe("2-k3f9");
		expect(cardFileName("2", "Energy", "k3f9")).toBe("2 Energy");
		expect(nameSuffixFor("luhmann", "")).toMatch(/^[a-z0-9]{4}$/);
		expect(nameSuffixFor("luhmann", "  ")).not.toBeNull();
		expect(nameSuffixFor("luhmann", "Energy")).toBeNull();
		expect(nameSuffixFor("timestamp", "")).toBeNull();
		// Numbering is unaffected: ids stay 1, 2, 2a… whatever the file names are.
		expect(nextCardId("luhmann", at, idSet(["1", "2"]), "2")).toBe("2a");
		// Typing a title later renames a note that still has the plugin's name, with or without a suffix.
		expect(isUntitledCardName("2-k3f9", "2")).toBe(true);
		expect(isUntitledCardName("2", "2")).toBe(true);
		expect(isUntitledCardName("2-my notes", "2")).toBe(false);
		expect(isUntitledCardName("2 Energy", "2")).toBe(false);
		expect(isUntitledCardName("20261029144207-k3f9", "20261029144207-k3f9")).toBe(true);
	});
});

describe("card subpath", () => {
	it("formats and parses regions", () => {
		expect(formatRegion({ x: 10, y: 20.04, width: 100.26, height: 0.5 })).toBe("10,20,100.3,0.5");
		expect(parseRegion("10, 20,100.3,0.5")).toEqual({ x: 10, y: 20, width: 100.3, height: 0.5 });
		expect(parseRegion("1,2,3")).toBeNull();
		expect(parseRegion("1,2,0,4")).toBeNull();
		expect(parseRegion("1,2,a,4")).toBeNull();
		expect(parseRegion("-5,2,3,4")).toEqual({ x: -5, y: 2, width: 3, height: 4 });
	});

	it("builds and reads card subpaths", () => {
		const s = cardSubpath(3, "abc-123", { x: 40, y: 60, width: 200, height: 120 });
		expect(s).toBe("#p3&id=abc-123&r=40,60,200,120");
		expect(parseSubpathParams(s.slice(1))).toEqual({ head: "p3", pageId: "abc-123", region: { x: 40, y: 60, width: 200, height: 120 }, bad: null });
		expect(cardSubpath(1, "abc", null)).toBe("#p1&id=abc");
		expect(parseSubpathParams("p2&r=1,2,3,4&id=x&future=1")).toMatchObject({ head: "p2", pageId: "x", bad: null });
		expect(parseSubpathParams("p2&r=oops").bad).toBe("r=oops");
		expect(parseSubpathParams("p2&id=a b").bad).toBe("id=a b");
	});

	it("embeds and links read the card subpath; plain page links are unchanged", () => {
		expect(parseEmbedSource("[[Box.notebook#p3&id=abc&r=1,2,30,40]]")).toEqual({
			ok: true, target: { kind: "link", value: "Box.notebook" }, page: 3, pageId: "abc", region: { x: 1, y: 2, width: 30, height: 40 },
		});
		expect(parseEmbedSource(embedSourceFromFile("Notebooks/Box.notebook", "#p2&id=abc"))).toEqual({
			ok: true, target: { kind: "path", value: "Notebooks/Box.notebook" }, page: 2, pageId: "abc",
		});
		expect(parseEmbedSource("[[Box.notebook#p3]]")).toEqual({ ok: true, target: { kind: "link", value: "Box.notebook" }, page: 3 });
		expect(parseEmbedSource("[[Box.notebook#p3&r=bad]]")).toMatchObject({ ok: false, error: "badPage" });
		expect(parseEmbedSource("[[Box.notebook#&id=abc]]")).toMatchObject({ ok: true, page: 1, pageId: "abc" });
		expect(pageFromSubpath("#p4&id=abc&r=1,2,3,4")).toBe(4);
		expect(pageFromSubpath("#Heading")).toBeNull();
	});

	it("finds the page by id (moved pages), never another page when it was deleted", () => {
		const pages = [{ id: "a" }, { id: "b" }, { id: "c" }];
		expect(lookupPage(pages, 1, "c")).toEqual({ index: 2 });
		expect(lookupPage(pages, 3, "gone")).toEqual({ missing: "deleted" });
		expect(lookupPage(pages, 2, null)).toEqual({ index: 1 });
		expect(lookupPage(pages, 9, null)).toEqual({ missing: "range" });
	});

	it("clamps regions to the page and pads selections", () => {
		const page = { width: 100, height: 200 };
		expect(clampRegion({ x: -10, y: 190, width: 50, height: 50 }, page)).toEqual({ x: 0, y: 190, width: 40, height: 10 });
		expect(clampRegion({ x: 150, y: 0, width: 50, height: 50 }, page)).toBeNull();
		expect(regionFromBounds({ minX: 10, minY: 10, maxX: 20, maxY: 30 }, page)).toEqual({ x: 2, y: 2, width: 26, height: 36 });
	});

	it("region thumbnails keep the region's aspect ratio", () => {
		expect(regionSize({ width: 200, height: 50 }, 400)).toEqual({ width: 400, height: 100, scale: 2 });
	});
});

const card: NewCard = {
	id: "202610291442", title: "Energy", type: "permanent", source: "Feynman I", tags: ["#physics", "physics", "big idea"], date: "2026-10-29",
	notebookPath: "Notebooks/Box.notebook", notebookId: "doc-1", pageId: "page-1", page: 3, region: { x: 1, y: 2, width: 30, height: 40 },
};

describe("card notes", () => {
	it("builds a new card: properties, the live embed and a transcription section", () => {
		expect(cardProperties(card)).toEqual({
			"zettel-id": "202610291442", title: "Energy", aliases: ["Energy"], type: "permanent", source: "Feynman I", date: "2026-10-29",
			tags: ["physics", "big-idea"], "zettel-notebook": "[[Notebooks/Box.notebook|Box]]", "zettel-notebook-id": "doc-1", "page-id": "page-1", region: "1,2,30,40",
		});
		// Never the companion note's keys: an older device with companion notes on would claim the card.
		expect(cardProperties(card)).not.toHaveProperty("notebook");
		expect(cardProperties(card)).not.toHaveProperty("notebook-id");
		const text = newCardText(card, (props) => deps.stringify(props));
		expect(text.startsWith("---\nzettel-id: \"202610291442\"\n")).toBe(true);
		expect(text).toContain("\n---\n![[Notebooks/Box.notebook#p3&id=page-1&r=1,2,30,40]]\n\n## Transcription\n\n");
		expect(TRANSCRIPTION_HEADING).toBe("## Transcription");
	});

	it("a whole-page card without title has no region and no aliases", () => {
		const page = { ...card, title: "", region: null, tags: [] };
		const props = cardProperties(page);
		expect(props).not.toHaveProperty("region");
		expect(props).not.toHaveProperty("aliases");
		expect(props).not.toHaveProperty("tags");
		expect(cardEmbed(page)).toBe("![[Notebooks/Box.notebook#p3&id=page-1]]");
	});

	it("reads cards back from frontmatter (numbers as ids too)", () => {
		const record = readCard("Z/a.md", { ...cardProperties(card), "zettel-id": 202610291442, links: "[[1]]" });
		expect(record).toEqual({
			path: "Z/a.md", id: "202610291442", title: "Energy", notebookId: "doc-1", notebookLink: "[[Notebooks/Box.notebook|Box]]",
			pageId: "page-1", region: { x: 1, y: 2, width: 30, height: 40 }, orphaned: false, links: ["[[1]]"],
		});
		expect(readCard("x.md", { "notebook-id": "doc-1", notebook: "[[x]]" })).toBeNull();
		expect(isCardFrontmatter({ "zettel-id": "1" })).toBe(true);
		expect(isCardFrontmatter({ "notebook-id": "doc-1" })).toBe(false);
		expect(readCard("x.md", { "notebook-id": "doc-1", notebook: "[[x]]", "page-id": "p" })).toBeNull();
	});

	it("cards made with the companion keys (unreleased builds) are still read, only with zettel-id", () => {
		const legacy = { "zettel-id": "1", title: "", notebook: "[[Notebooks/Box.notebook|Box]]", "notebook-id": "doc-1", "page-id": "page-1" };
		expect(readCard("Z/1.md", legacy)).toMatchObject({ id: "1", notebookId: "doc-1", notebookLink: "[[Notebooks/Box.notebook|Box]]", pageId: "page-1" });
		// The card's own keys win over the companion keys.
		expect(readCard("Z/1.md", { ...legacy, "zettel-notebook-id": "doc-2", "zettel-notebook": "[[B.notebook]]" }))
			.toMatchObject({ notebookId: "doc-2", notebookLink: "[[B.notebook]]" });
		// With its own id, a stray companion `notebook` link is not taken for the card's.
		expect(readCard("Z/1.md", { "zettel-id": "1", "zettel-notebook-id": "doc-2", notebook: "[[Other.notebook]]", "page-id": "p" }))
			.toMatchObject({ notebookId: "doc-2", notebookLink: "" });
	});

	it("frontmatter edits touch only the changed keys: comments, quoting and the user's properties stay", () => {
		const fm = [
			"# my comment",
			"zettel-id: '1a'",
			"title: \"Energy\"   # typed on the tablet",
			"source:   Feynman I",
			"links:",
			"  - \"[[1]]\"",
			"",
			"my-list:",
			"- a",
			"- b",
			"",
		].join("\n");
		const body = "![[B.notebook#p1&id=x]]\n\nMy words.\n";
		const text = `---\n${fm}---\n${body}`;
		const added = editProperties(text, { orphaned: true }, yamlDeps);
		expect(added).toEqual({ kind: "changed", text: `---\n${fm}orphaned: true\n---\n${body}` });
		const links = editProperties(text, { links: ["[[1]]", "[[2]]"] }, yamlDeps);
		expect(links.kind === "changed" && links.text).toBe(text.replace("links:\n  - \"[[1]]\"\n", "links:\n  - \"[[1]]\"\n  - \"[[2]]\"\n"));
		const removed = editProperties(added.kind === "changed" ? added.text : "", { orphaned: undefined }, yamlDeps);
		expect(removed).toEqual({ kind: "changed", text });
		// A changed value in the middle: only that line.
		const title = editProperties(text, { title: "Work" }, yamlDeps);
		expect(title.kind === "changed" && title.text).toBe(text.replace("title: \"Energy\"   # typed on the tablet", "title: \"Work\""));
		// CRLF notes stay CRLF.
		const crlf = text.replace(/\n/g, "\r\n");
		const r = editProperties(crlf, { orphaned: true }, yamlDeps);
		expect(r.kind === "changed" && r.text).toBe(`---\r\n${fm.replace(/\n/g, "\r\n")}orphaned: true\r\n---\r\n${body.replace(/\n/g, "\r\n")}`);
		// Something the line edit cannot express safely falls back to re-serializing the block (values still right).
		const odd = "---\nlinks: &a\n  - x\nother: *a\n---\nbody";
		const anchorDeps: CompanionTextDeps = { ...yamlDeps, parseFrontmatter: (y) => (y.includes("&a") ? { links: ["x"], other: ["x"] } : yamlDeps.parseFrontmatter(y)) };
		const fallback = editProperties(odd, { links: ["x", "y"] }, anchorDeps);
		expect(fallback.kind === "changed" && fallback.text).toBe("---\nlinks:\n  - \"x\"\n  - \"y\"\nother:\n  - \"x\"\n---\nbody");
	});

	it("edits only the frontmatter, keeps the body byte for byte, writes nothing when unchanged", () => {
		const body = "![[Notebooks/Box.notebook#p3&id=page-1]]\n\n## Transcription\n\nMy own words.\n%% not ours %%\n";
		const text = `---\n${deps.stringify(cardProperties(card))}---\n${body}`;
		const r = editProperties(text, { orphaned: true }, deps);
		expect(r.kind).toBe("changed");
		if (r.kind !== "changed") return;
		expect(r.text.endsWith(`---\n${body}`)).toBe(true);
		expect(deps.parseFrontmatter(r.text.slice(4, r.text.indexOf("\n---") + 1))).toMatchObject({ orphaned: true, title: "Energy" });
		expect(editProperties(r.text, { orphaned: true }, deps)).toEqual({ kind: "unchanged" });
		const back = editProperties(r.text, { orphaned: undefined }, deps);
		expect(back.kind === "changed" && back.text).toBe(text);
		expect(editProperties("---\nnot yaml\n---\nbody", { orphaned: true }, deps)).toEqual({ kind: "yaml" });
		expect(editProperties("just text", { a: 1 }, deps)).toEqual({ kind: "changed", text: "---\na: 1\n---\njust text" });
	});

	it("drawn links are appended once, by target", () => {
		expect(linkTarget("[[Z/1a Energy|Energy]]")).toBe("z/1a energy");
		expect(linkTarget("[[1a.md#x]]")).toBe("1a");
		expect(addLinks(undefined, ["[[1a]]"])).toEqual(["[[1a]]"]);
		expect(addLinks(["[[1a|Energy]]"], ["[[1a]]"])).toBeNull();
		expect(addLinks(["[[1a]]"], ["[[1b]]", "[[1B]]"])).toEqual(["[[1a]]", "[[1b]]"]);
		// A single string becomes a list (so the graph sees each link).
		expect(addLinks("[[1a]]", ["[[1a]]"])).toEqual(["[[1a]]"]);
	});

	it("titles go to title and aliases; earlier titles stay as aliases", () => {
		expect(titleChanges({ title: "", aliases: undefined }, " Energy ")).toEqual({ title: "Energy", aliases: ["Energy"] });
		expect(titleChanges({ title: "Energy", aliases: ["Energy"] }, "Work")).toEqual({ title: "Work", aliases: ["Energy", "Work"] });
		expect(titleChanges({ title: "Work", aliases: ["Energy", "Work"] }, "Work")).toBeNull();
		expect(titleChanges({}, "  ")).toBeNull();
	});

	it("orphaned flag follows whether the page exists", () => {
		const record = readCard("a.md", cardProperties(card))!;
		expect(orphanChanges(record, new Set(["page-1"]))).toBeNull();
		expect(orphanChanges(record, new Set(["other"]))).toEqual({ orphaned: true });
		expect(orphanChanges({ ...record, orphaned: true }, new Set(["page-1"]))).toEqual({ orphaned: undefined });
	});

	it("parses typed tags", () => {
		expect(parseTagInput("#a, b c,,a 12")).toEqual(["a", "b", "c"]);
	});
});

describe("slip-box: pages made on this device", () => {
	it("the first look records every page; only pages added afterwards are fresh", () => {
		const pages = new LocalPages();
		expect(pages.seen("doc")).toBe(false);
		expect([...pages.fresh("doc", ["a", "b"])]).toEqual([]);
		expect(pages.seen("doc")).toBe(true);
		expect([...pages.fresh("doc", ["a", "b", "c"])]).toEqual(["c"]);
		// Pages that arrived through sync are recorded before this device's next save includes them.
		pages.know("doc", ["d"]);
		expect([...pages.fresh("doc", ["a", "b", "c", "d"])]).toEqual(["c"]);
		pages.know("doc", ["c"]);
		expect(pages.fresh("doc", ["a", "b", "c", "d"]).size).toBe(0);
		expect(pages.fresh("other", ["x"]).size).toBe(0);
	});
});

describe("drawn links: arrows between cards", () => {
	const cards: CardArea[] = [
		{ key: "A", region: { x: 0, y: 0, width: 100, height: 100 } },
		{ key: "B", region: { x: 200, y: 0, width: 100, height: 100 } },
		{ key: "inner", region: { x: 20, y: 20, width: 30, height: 30 } },
		{ key: "page", region: null },
	];

	it("finds tail and tip of shape-tool arrows in any direction and size", () => {
		for (const [a, b] of [[[50, 50], [250, 50]], [[250, 80], [40, 10]], [[0, 0], [0, 12]], [[10, 10], [900, 600]]] as const) {
			const ends = arrowEnds(arrowPoints(a, b, 16));
			expect(ends?.tail[0]).toBeCloseTo(a[0], 0);
			expect(ends?.tip[1]).toBeCloseTo(b[1], 0);
		}
	});

	it("lines, rectangles and short scribbles are not arrows", () => {
		expect(arrowEnds(linePoints([0, 0], [200, 0]))).toBeNull();
		expect(arrowEnds(rectPoints([0, 0], [100, 50]))).toBeNull();
		expect(arrowEnds([[0, 0, 0.5], [1, 1, 0.5], [2, 0, 0.5], [1, 1, 0.5], [0, 2, 0.5]])).toBeNull();
	});

	it("card under a point: smallest region, else the page card", () => {
		expect(cardAt(30, 30, cards)).toBe("inner");
		expect(cardAt(80, 80, cards)).toBe("A");
		expect(cardAt(150, 50, cards)).toBe("page");
		expect(cardAt(150, 50, cards.slice(0, 3))).toBeNull();
		expect(cardAt(103, 50, cards.slice(0, 2))).toBe("A");
	});

	it("an arrow from one card to another links them; within one card it does not", () => {
		expect(arrowLink(arrowPoints([80, 80], [250, 50], 16), cards)).toEqual({ from: "A", to: "B" });
		expect(arrowLink(arrowPoints([250, 50], [30, 30], 16), cards)).toEqual({ from: "B", to: "inner" });
		expect(arrowLink(arrowPoints([60, 60], [90, 90], 16), cards)).toBeNull();
		expect(arrowLink(linePoints([80, 80], [250, 50]), cards)).toBeNull();
	});
});

describe("zettel settings", () => {
	it("defaults and validation", () => {
		expect(DEFAULT_SETTINGS.zettelFolder).toBe("Zettelkasten");
		expect(DEFAULT_SETTINGS.zettelIdScheme).toBe("timestamp");
		expect(DEFAULT_SETTINGS.zettelShowRegions).toBe(true);
		const s = readSettings({ zettelFolder: " Cards/ ../x ", zettelIdScheme: "luhmann", zettelShowRegions: false, zettelSlipBoxes: ["a", 3, "a", ""] });
		expect(s.zettelFolder).toBe("Cards/x");
		expect(s.zettelIdScheme).toBe("luhmann");
		expect(s.zettelShowRegions).toBe(false);
		expect(s.zettelSlipBoxes).toEqual(["a"]);
		expect(readZettelSettings({ zettelIdScheme: "dewey" }).zettelIdScheme).toBe("timestamp");
		// Defaults are never shared between reads.
		readSettings({}).zettelSlipBoxes.push("x");
		expect(readSettings({}).zettelSlipBoxes).toEqual([]);
	});

	it("A6 card pages", () => {
		expect(A6_PAGE.width).toBeCloseTo(105 * 2.8346, 0);
		expect(A6_PAGE.height).toBeCloseTo(148 * 2.8346, 0);
	});
});
