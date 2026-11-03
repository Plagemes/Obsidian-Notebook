import { describe, expect, it } from "vitest";
import { markSeen, parseSeenState, freshSeenState, SEEN_CAP } from "../src/library/changed-seen";
import { computeSections, HOUR, markSectionSeen, NOW_WINDOW_MS, type SectionEntry, type SectionInput } from "../src/library/dynamic-sections";
import { extractEmptyPages, metaFromDocument } from "../src/library/scan";
import type { NotebookDocument } from "../src/model/types";

const NOW = 1_800_000_000_000;
const entry = (path: string, o: Partial<SectionEntry> = {}): SectionEntry => ({ path, mtime: NOW - 10 * HOUR, modified: NOW - 10 * HOUR, ...o });
const input = (entries: SectionEntry[], o: Partial<SectionInput> = {}): SectionInput => ({
	entries, now: NOW, lecturePath: null, openPaths: [], edits: [], seen: { version: 1, baseline: NOW - 100 * HOUR, seen: {} }, ...o,
});

describe("Now", () => {
	it("puts the class in progress first, then open tabs, then recent edits", () => {
		const s = computeSections(input([entry("a"), entry("b"), entry("c"), entry("d")], {
			lecturePath: "a", openPaths: ["b"], edits: [{ path: "c", at: NOW - HOUR }, { path: "d", at: NOW - 5 * HOUR }],
		}));
		expect(s.now.map((i) => [i.path, i.reason])).toEqual([["a", "lecture"], ["b", "open"], ["c", "edited"]]);
	});
	it("lists a notebook once and ignores unknown paths", () => {
		const s = computeSections(input([entry("a")], { lecturePath: "a", openPaths: ["a", "zz"], edits: [{ path: "a", at: NOW }, { path: "zz", at: NOW }] }));
		expect(s.now).toHaveLength(1);
	});
	it("an edit just outside the window is out", () => {
		const s = computeSections(input([entry("a")], { edits: [{ path: "a", at: NOW - NOW_WINDOW_MS - 1 }] }));
		expect(s.now).toEqual([]);
	});
});

describe("To complete", () => {
	it("lists notebooks with open markers or pages to fill, newest first", () => {
		const s = computeSections(input([
			entry("a", { openMarkers: 2, modified: 5 }), entry("b", { emptyPages: 3, modified: 9 }), entry("c"), entry("d", { openMarkers: 0, emptyPages: 0 }),
		]));
		expect(s.todo.map((i) => [i.path, i.reason, i.markers, i.empty])).toEqual([["b", "empty", undefined, 3], ["a", "markers", 2, undefined]]);
	});
});

describe("Changed on another device", () => {
	const seen = { version: 1, baseline: NOW - 50 * HOUR, seen: {} as Record<string, number> };
	it("flags files newer than the baseline that this device did not write", () => {
		const e = [entry("a", { mtime: NOW - HOUR }), entry("old", { mtime: NOW - 60 * HOUR })];
		expect(computeSections(input(e, { seen })).changed.map((i) => i.path)).toEqual(["a"]);
	});
	it("does not flag this device's own edits, with or without the save delay", () => {
		const e = [entry("a", { mtime: NOW - HOUR })];
		expect(computeSections(input(e, { seen, edits: [{ path: "a", at: NOW - HOUR - 5000 }] })).changed).toEqual([]);
		expect(computeSections(input(e, { seen, edits: [{ path: "a", at: NOW - 3 * HOUR }] })).changed).toHaveLength(1);
	});
	it("uses the seen time per notebook (id before path) and the clock tolerance", () => {
		const e = [entry("a", { id: "x1", mtime: NOW - HOUR })];
		expect(computeSections(input(e, { seen: { ...seen, seen: { "id:x1": NOW - HOUR } } })).changed).toEqual([]);
		expect(computeSections(input(e, { seen: { ...seen, seen: { "id:x1": NOW - HOUR - 1000 } } })).changed).toEqual([]);
		expect(computeSections(input(e, { seen: { ...seen, seen: { "id:x1": NOW - 2 * HOUR } } })).changed).toHaveLength(1);
	});
	it("marking a section seen clears it", () => {
		const e = [entry("a", { mtime: NOW - HOUR }), entry("b", { id: "q", mtime: NOW - 2 * HOUR })];
		const st = { ...seen, seen: {} as Record<string, number> };
		const before = computeSections(input(e, { seen: st }));
		expect(before.changed).toHaveLength(2);
		expect(markSectionSeen(st, e, before.changed)).toBe(true);
		expect(computeSections(input(e, { seen: st })).changed).toEqual([]);
		expect(markSectionSeen(st, e, before.changed)).toBe(false);
	});
});

describe("seen record", () => {
	it("starts from the moment it was made and survives bad data", () => {
		expect(parseSeenState(undefined, 7).baseline).toBe(7);
		expect(parseSeenState("{nope", 7).baseline).toBe(7);
		expect(parseSeenState({ version: 9, baseline: 1, seen: {} }, 7).baseline).toBe(7);
		expect(parseSeenState({ version: 1, baseline: 3, seen: { a: 5, b: "x" } }, 7)).toEqual({ version: 1, baseline: 3, seen: { a: 5 } });
	});
	it("only moves forward and is capped", () => {
		const s = freshSeenState(0);
		expect(markSeen(s, "a", 5)).toBe(true);
		expect(markSeen(s, "a", 4)).toBe(false);
		for (let i = 0; i < SEEN_CAP + 10; i++) markSeen(s, `k${i}`, 10 + i);
		expect(Object.keys(s.seen).length).toBe(SEEN_CAP);
	});
});

describe("pages still to fill (index)", () => {
	const page = (o: Record<string, unknown> = {}) => ({ id: "p", width: 1, height: 1, paper: {}, strokes: [] as unknown[], ...o });
	const doc = (pages: unknown[]) => ({ pages } as unknown as NotebookDocument);
	const ink = [{ id: "s" }];
	it("a fresh notebook has none", () => {
		expect(extractEmptyPages(doc([page()]))).toBe(0);
		expect(extractEmptyPages(doc([page(), page()]))).toBe(0);
	});
	it("counts skipped blank pages, unannotated PDF slides and empty practice copies", () => {
		expect(extractEmptyPages(doc([page({ strokes: ink }), page(), page({ strokes: ink }), page()]))).toBe(1);
		const pdf = { background: { kind: "pdf" } };
		expect(extractEmptyPages(doc([page({ strokes: ink, ...pdf }), page(pdf), page(pdf)]))).toBe(2);
		expect(extractEmptyPages(doc([page({ tags: ["practice", "attempt/1"] })]))).toBe(1);
		expect(extractEmptyPages(doc([page({ tags: ["practice"], strokes: ink })]))).toBe(0);
	});
	it("goes into the index fields only when there is something", () => {
		expect(metaFromDocument(doc([page({ strokes: ink }), page(), page({ strokes: ink })])).emptyPages).toBe(1);
		expect("emptyPages" in metaFromDocument(doc([page()]))).toBe(false);
	});
});
