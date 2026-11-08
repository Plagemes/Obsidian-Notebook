import { describe, expect, it } from "vitest";
import {
	classifyPages, MAX_NAV_NOTEBOOKS, MAX_THUMBS, modeOf, nextMode, normaliseNavModes, pageRowTime, pageRowTitle, resolveLayout, ThumbCache, withMode,
} from "../src/ui/nav-adapt";
import type { Page } from "../src/model/types";

const bg = { kind: "pdf", asset: "a.pdf", page: 1 } as const;
const pages = (media: number, plain: number): Array<Pick<Page, "background">> => [
	...Array.from({ length: media }, () => ({ background: bg })),
	...Array.from({ length: plain }, (): Pick<Page, "background"> => ({})),
];

describe("classifyPages", () => {
	it("is mixed when empty", () => expect(classifyPages([])).toBe("mixed"));
	it("media when most pages have a background", () => {
		expect(classifyPages(pages(10, 0))).toBe("media");
		expect(classifyPages(pages(6, 4))).toBe("media");
	});
	it("written when few or none do", () => {
		expect(classifyPages(pages(0, 10))).toBe("written");
		expect(classifyPages(pages(2, 8))).toBe("written");
	});
	it("mixed in between", () => expect(classifyPages(pages(4, 6))).toBe("mixed"));
});

describe("resolveLayout", () => {
	it("auto follows the kind", () => {
		expect(resolveLayout("auto", "media")).toBe("large");
		expect(resolveLayout("auto", "written")).toBe("list");
		expect(resolveLayout("auto", "mixed")).toBe("normal");
	});
	it("list always lists; thumbnails are large only for media", () => {
		expect(resolveLayout("list", "media")).toBe("list");
		expect(resolveLayout("thumbs", "written")).toBe("normal");
		expect(resolveLayout("thumbs", "media")).toBe("large");
	});
	it("the toggle cycles", () => expect([nextMode("auto"), nextMode("thumbs"), nextMode("list")]).toEqual(["thumbs", "list", "auto"]));
});

describe("pageRowTitle and time", () => {
	const text = (id: string, y: number, t: string) => ({ id, type: "text", x: 0, y, width: 100, text: t, fontSize: 12, color: "#000" });
	const page = (elements: unknown[]) => ({ id: "p", elements } as unknown as Page);
	it("prefers the bookmark title", () => expect(pageRowTitle(page([text("a", 0, "Body")]), "Chapter 1")).toBe("Chapter 1"));
	it("takes the topmost text, first non-empty line, without markdown marks", () => {
		expect(pageRowTitle(page([text("a", 90, "low"), text("b", 10, "\n## Heading\nmore")]))).toBe("Heading");
	});
	it("cuts long titles and is empty without text", () => {
		expect(pageRowTitle(page([text("a", 0, "x".repeat(200))])).length).toBe(80);
		expect(pageRowTitle(page([]))).toBe("");
	});
	it("time only for a valid pair", () => {
		expect(pageRowTime({ startAt: 1_700_000_000_000, endAt: 1_700_000_100_000 })).toBe(1_700_000_000_000);
		expect(pageRowTime({ startAt: 5 })).toBeNull();
		expect(pageRowTime({})).toBeNull();
	});
});

describe("stored modes", () => {
	it("drops bad data", () => {
		expect(normaliseNavModes(null)).toEqual([]);
		expect(normaliseNavModes([1])).toEqual([]);
		expect(normaliseNavModes({ a: "list", b: "weird", "bad id!": "list" })).toEqual([["a", "list"]]);
	});
	it("remembers, replaces and clears a choice", () => {
		let s = withMode([], "n1", "list");
		expect(modeOf(s, "n1")).toBe("list");
		s = withMode(s, "n1", "thumbs");
		expect(modeOf(s, "n1")).toBe("thumbs");
		s = withMode(s, "n1", "auto");
		expect(modeOf(s, "n1")).toBe("auto");
		expect(modeOf(s, null)).toBe("auto");
	});
	it("is bounded, forgetting the oldest", () => {
		let s: ReturnType<typeof withMode> = [];
		for (let i = 0; i < MAX_NAV_NOTEBOOKS + 20; i++) s = withMode(s, `n${i}`, "list");
		expect(s).toHaveLength(MAX_NAV_NOTEBOOKS);
		expect(modeOf(s, "n0")).toBe("auto");
		expect(modeOf(s, `n${MAX_NAV_NOTEBOOKS + 19}`)).toBe("list");
	});
});

describe("stored modes: order and the earlier object format (W12)", () => {
	it("forgets the oldest even when ids look like integers", () => {
		let s: ReturnType<typeof withMode> = [];
		// Integer-like ids are enumerated first by an object whatever the order they were added in.
		for (let i = 0; i < MAX_NAV_NOTEBOOKS + 5; i++) s = withMode(s, String(1000 - i), "list");
		expect(s).toHaveLength(MAX_NAV_NOTEBOOKS);
		expect(modeOf(s, "1000")).toBe("auto");
		expect(modeOf(s, String(1000 - (MAX_NAV_NOTEBOOKS + 4)))).toBe("list");
		expect(s[s.length - 1]![0]).toBe(String(1000 - (MAX_NAV_NOTEBOOKS + 4)));
	});
	it("a changed choice becomes the newest", () => {
		let s = withMode([], "a", "list");
		s = withMode(s, "b", "list");
		s = withMode(s, "a", "thumbs");
		expect(s).toEqual([["b", "list"], ["a", "thumbs"]]);
	});
	it("reads the object an earlier build stored, and its own pair list back", () => {
		const old = normaliseNavModes({ a: "list", b: "thumbs" });
		expect(old).toEqual([["a", "list"], ["b", "thumbs"]]);
		expect(normaliseNavModes(JSON.parse(JSON.stringify(old)))).toEqual(old);
		expect(normaliseNavModes([["a", "list"], ["a", "thumbs"], ["x", "weird"], "no", ["too", "many", "items"]])).toEqual([["a", "thumbs"]]);
	});
});

describe("ThumbCache (W12)", () => {
	it("is bounded: the least recently used go first", () => {
		const c = new ThumbCache(3);
		c.set("a", 120, "k", "A");
		c.set("b", 120, "k", "B");
		c.set("c", 120, "k", "C");
		expect(c.get("a", 120, "k")).toBe("A"); // a is used again
		c.set("d", 120, "k", "D");
		expect(c.size).toBe(3);
		expect(c.get("b", 120, "k")).toBeNull();
		expect(c.get("a", 120, "k")).toBe("A");
		expect(c.get("d", 120, "k")).toBe("D");
	});
	it("never holds more than the bound, however many widths and pages", () => {
		const c = new ThumbCache();
		for (let i = 0; i < MAX_THUMBS * 3; i++) for (const w of [60, 120, 240]) c.set(`p${i}`, w, "k", "u");
		expect(c.size).toBe(MAX_THUMBS);
	});
	it("a thumbnail is current only for the page content it was drawn for", () => {
		const c = new ThumbCache();
		c.set("a", 120, "v1", "A1");
		expect(c.get("a", 120, "v2")).toBeNull();
		expect(c.peek("a", "v2")).toBeNull();
		expect(c.peek("a", "v1")).toBe("A1");
	});
	it("other widths of a page are kept while current and dropped when the page changed", () => {
		const c = new ThumbCache();
		c.set("a", 60, "v1", "S");
		c.set("a", 120, "v1", "M");
		expect(c.get("a", 60, "v1")).toBe("S");
		c.set("a", 120, "v2", "M2");
		expect(c.get("a", 60, "v1")).toBeNull();
		expect(c.size).toBe(1);
	});
	it("drop forgets every width of one page only, clear forgets all", () => {
		const c = new ThumbCache();
		c.set("a", 60, "k", "1");
		c.set("a", 120, "k", "2");
		c.set("ab", 60, "k", "3");
		c.drop("a");
		expect(c.size).toBe(1);
		expect(c.peek("ab", "k")).toBe("3");
		c.clear();
		expect(c.size).toBe(0);
	});
});
