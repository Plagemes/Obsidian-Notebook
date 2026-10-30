/**
 * v10 anchored excerpts, review fixes: the live-picture cache (LRU within a byte budget, ids no longer in the document
 * dropped), the region content (culled to the region, fingerprinted so edits elsewhere draw nothing again), the
 * on-screen scale cap, the document id of a notebook file (renamed sources), and the staged loading of large v9 files.
 */
import { describe, expect, it } from "vitest";
import { BoundsCache, LiveCache, liveScale, LIVE_MAX_SIDE, regionContent, Tokens, type LiveEntry } from "../src/ink/excerpt-live";
import { createDocument, createPage } from "../src/model/document";
import { documentIdOf } from "../src/model/excerpts";
import { v10OnlyElement } from "../src/model/migrations";
import { parseStaged, serialize, STAGED_MIN_CHARS, StagedParse } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import type { Page, TextElement } from "../src/model/types";
import { line } from "./helpers";

const region = { x: 100, y: 100, width: 200, height: 100 };

function entry(key: string, bytes: number): LiveEntry<{ name: string }> {
	return { key, picture: { name: key }, bytes, at: 0, fingerprint: "", source: { page: "p", region } };
}

describe("live picture cache", () => {
	it("keeps the most recently used pictures within the byte budget and releases the others", () => {
		const released: string[] = [];
		const cache = new LiveCache<{ name: string }>(100, (p) => released.push(p.name));
		cache.set("a", entry("a", 40));
		cache.set("b", entry("b", 40));
		cache.get("a");
		cache.set("c", entry("c", 40));
		expect(released).toEqual(["b"]);
		expect(cache.size).toBe(2);
		expect(cache.bytes).toBe(80);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")?.key).toBe("a");
	});

	it("always keeps the picture just drawn, even over the budget", () => {
		const cache = new LiveCache<{ name: string }>(10);
		cache.set("big", entry("big", 50));
		expect(cache.get("big")).toBeDefined();
		expect(cache.bytes).toBe(50);
	});

	it("drops the pictures of excerpts that are no longer in the document", () => {
		const released: string[] = [];
		const cache = new LiveCache<{ name: string }>(1000, (p) => released.push(p.name));
		cache.set("a", entry("a", 1));
		cache.set("b", entry("b", 1));
		cache.retain(new Set(["b"]));
		expect(released).toEqual(["a"]);
		expect(cache.size).toBe(1);
	});

	it("replacing a picture releases the old one only when it is another object", () => {
		const released: string[] = [];
		const cache = new LiveCache<{ name: string }>(1000, (p) => released.push(p.name));
		const e = entry("a", 10);
		cache.set("a", e);
		cache.set("a", { ...e, key: "a2" });
		expect(released).toEqual([]);
		cache.set("a", entry("a3", 10));
		expect(released).toEqual(["a"]);
		expect(cache.bytes).toBe(10);
	});
});

describe("region content", () => {
	function page(): Page {
		const p = createPage({ width: 600, height: 800 });
		p.strokes.push(line(120, 120, 180, 150), line(400, 600, 500, 650));
		const inside: TextElement = { id: "t1", type: "text", x: 150, y: 150, width: 50, text: "a", fontSize: 12, color: "#000000" };
		const outside: TextElement = { id: "t2", type: "text", x: 450, y: 700, width: 50, text: "b", fontSize: 12, color: "#000000" };
		p.elements = [inside, outside];
		return p;
	}

	it("keeps only what meets the region, in page order", () => {
		const p = page();
		const c = regionContent(p, region, new Tokens(), new BoundsCache());
		expect(c.strokes).toEqual([p.strokes[0]]);
		expect(c.elements.map((e) => e.id)).toEqual(["t1"]);
	});

	it("the fingerprint changes with the region's content only", () => {
		const p = page();
		const tokens = new Tokens();
		const bounds = new BoundsCache();
		const before = regionContent(p, region, tokens, bounds).fingerprint;
		p.strokes.push(line(450, 500, 550, 520));
		expect(regionContent(p, region, tokens, bounds).fingerprint).toBe(before);
		p.strokes.push(line(110, 110, 130, 130));
		const after = regionContent(p, region, tokens, bounds).fingerprint;
		expect(after).not.toBe(before);
		p.strokes[0] = line(120, 120, 180, 150);
		expect(regionContent(p, region, tokens, bounds).fingerprint).not.toBe(after);
	});
});

describe("live picture scale", () => {
	it("never exceeds the size on screen and steps by √2", () => {
		const s = liveScale(2, { width: 200 }, region);
		expect(s).toBeLessThanOrEqual(2);
		expect(s).toBeGreaterThan(2 / Math.SQRT2 - 1e-9);
		expect(liveScale(1.5, { width: 100 }, region)).toBeLessThanOrEqual(0.75);
	});

	it("is capped at LIVE_MAX_SIDE pixels a side", () => {
		const s = liveScale(50, { width: 2000 }, region);
		expect(region.width * s).toBeLessThanOrEqual(LIVE_MAX_SIDE);
	});
});

describe("the document id of a notebook file", () => {
	it("reads it from the header, or from the parsed JSON", () => {
		const doc = createDocument(new Date("2026-10-30T10:00:00.000Z"));
		doc.id = 'a"b';
		expect(documentIdOf(serialize(doc))).toBe('a"b');
		expect(documentIdOf(JSON.stringify({ pages: [], id: "x1", format: "obsidian-notebook" }))).toBe("x1");
		expect(documentIdOf("not json")).toBeNull();
		expect(documentIdOf(JSON.stringify({ id: 5 }))).toBeNull();
	});
});

describe("staged loading of large v9 files", () => {
	function v9Text(withExcerpt: boolean): string {
		const doc = stressDocument(9000, 4);
		const raw = JSON.parse(serialize(doc)) as { version: number; pages: Array<{ elements?: unknown[] }> };
		raw.version = 9;
		if (withExcerpt) raw.pages[2]!.elements = [{ id: "x", type: "excerpt", x: 0, y: 0, width: 1, height: 1, source: { notebook: "a", doc: "d", page: "p", x: 0, y: 0, width: 1, height: 1 } }];
		return JSON.stringify(raw);
	}

	it("stages a v9 file and reports it as migrated from v9", () => {
		const text = v9Text(false);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(9);
			expect(r.doc.version).toBe(10);
		}
	});

	it("refuses a v9 file with an excerpt on a page read later, like the migration", () => {
		const staged = parseStaged(v9Text(true), 1) as StagedParse;
		expect(staged).toBeInstanceOf(StagedParse);
		const r = staged.finish();
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("exists only from v10");
			expect(r.version).toBe(9);
		}
		expect(v10OnlyElement({ elements: [{ type: "text" }] }, 0)).toBeNull();
	});
});
