/** 0.16 review (C7): the PDF outline cache is bounded by size as well as by count. */
import { describe, expect, it } from "vitest";
import {
	MAX_CACHE_CHARS, MAX_OUTLINE_CHARS, OUTLINE_CACHE_KEY, normaliseOutlineCache, outlineChars, storeOutline, type OutlineCacheData,
} from "../src/pdf/outline-cache";
import { PdfOutlineSource } from "../src/pdf/outline-source";
import type { PdfOutlineEntry } from "../src/pdf/pdf-outline";

const id = (i: number) => `pdf${String(i).padStart(10, "0")}`;
/** An outline of `n` entries with long titles (about 60 characters of JSON each). */
const outline = (n: number, title = "x".repeat(40)): PdfOutlineEntry[] => Array.from({ length: n }, (_, k) => ({ title: `${title}${k}`, level: 1, page: k }));
const total = (c: OutlineCacheData) => Object.values(c).reduce((n, r) => n + outlineChars(r), 0);

describe("C7: outline cache size", () => {
	it("an outline over the single-PDF limit is not cached, and drops an older copy of itself", () => {
		const big = outline(2000, "y".repeat(100)); // far over 128 KB once serialised
		expect(outlineChars({ at: 1, entries: big })).toBeGreaterThan(MAX_OUTLINE_CHARS);
		const empty: OutlineCacheData = {};
		expect(storeOutline(empty, id(1), big, 5)).toBe(empty);
		const withOld = storeOutline(empty, id(1), outline(3), 1);
		expect(id(1) in withOld).toBe(true);
		expect(id(1) in storeOutline(withOld, id(1), big, 9)).toBe(false);
	});

	it("evicts the least recently stored PDFs to stay under the total size", () => {
		let cache: OutlineCacheData = {};
		// ~100 KB each: not over the single limit, but only about five fit in 512 KB.
		const mid = outline(900, "m".repeat(60));
		const one = outlineChars({ at: 1, entries: mid });
		expect(one).toBeLessThan(MAX_OUTLINE_CHARS);
		const fit = Math.floor(MAX_CACHE_CHARS / one);
		expect(fit).toBeLessThan(10);
		for (let i = 0; i < 12; i++) cache = storeOutline(cache, id(i), mid, i + 1);
		expect(total(cache)).toBeLessThanOrEqual(MAX_CACHE_CHARS);
		expect(Object.keys(cache)).toHaveLength(fit);
		expect(id(11) in cache).toBe(true); // the newest stays
		expect(id(0) in cache).toBe(false); // the oldest went
	});

	it("an oversized cache read from storage is trimmed the same way, newest first", () => {
		const mid = outline(900, "m".repeat(60));
		const raw: Record<string, unknown> = {};
		for (let i = 0; i < 12; i++) raw[id(i)] = { at: i + 1, entries: mid };
		raw[id(99)] = { at: 50, entries: outline(2000, "y".repeat(100)) }; // over the single limit: dropped
		const cache = normaliseOutlineCache(raw);
		expect(total(cache)).toBeLessThanOrEqual(MAX_CACHE_CHARS);
		expect(id(99) in cache).toBe(false);
		expect(id(11) in cache).toBe(true);
	});

	it("an outline too big to cache is still read once and kept for the session (no read loop)", async () => {
		const data: Record<string, unknown> = {};
		let reads = 0;
		let changes = 0;
		const big = outline(2000, "y".repeat(100));
		const source = new PdfOutlineSource({
			storage: { loadLocalStorage: (k) => data[k] ?? null, saveLocalStorage: (k, v) => void (data[k] = v) },
			read: async () => (reads++, big),
			changed: () => void changes++,
		});
		expect(source.get(id(1))).toBeUndefined();
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(source.get(id(1))).toBe(big);
		expect(source.get(id(1))).toBe(big);
		expect(reads).toBe(1);
		expect(changes).toBe(1);
		expect(Object.keys(data[OUTLINE_CACHE_KEY] ?? {})).toEqual([]);
	});
});
