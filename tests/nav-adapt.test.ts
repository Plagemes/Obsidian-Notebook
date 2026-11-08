import { describe, expect, it } from "vitest";
import {
	classifyPages, MAX_NAV_NOTEBOOKS, modeOf, nextMode, normaliseNavModes, pageRowTime, pageRowTitle, resolveLayout, withMode,
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
		expect(normaliseNavModes(null)).toEqual({});
		expect(normaliseNavModes([1])).toEqual({});
		expect(normaliseNavModes({ a: "list", b: "weird", "bad id!": "list" })).toEqual({ a: "list" });
	});
	it("remembers, replaces and clears a choice", () => {
		let s = withMode({}, "n1", "list");
		expect(modeOf(s, "n1")).toBe("list");
		s = withMode(s, "n1", "thumbs");
		expect(modeOf(s, "n1")).toBe("thumbs");
		s = withMode(s, "n1", "auto");
		expect(modeOf(s, "n1")).toBe("auto");
		expect(modeOf(s, null)).toBe("auto");
	});
	it("is bounded, forgetting the oldest", () => {
		let s = {};
		for (let i = 0; i < MAX_NAV_NOTEBOOKS + 20; i++) s = withMode(s, `n${i}`, "list");
		expect(Object.keys(s)).toHaveLength(MAX_NAV_NOTEBOOKS);
		expect(modeOf(s, "n0")).toBe("auto");
		expect(modeOf(s, `n${MAX_NAV_NOTEBOOKS + 19}`)).toBe("list");
	});
});
