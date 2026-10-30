import { describe, expect, it } from "vitest";
import { entryFromFile } from "../src/library/scan";
import type { LibraryEntry } from "../src/library/index";
import { fuzzyScore, parseQuery, searchPages } from "../src/library/page-search";
import { ago, RecentLog, RecentRecorder } from "../src/library/recent-log";
import { gotoTargets } from "../src/view/goto-logic";

function entry(over: Partial<LibraryEntry>): LibraryEntry {
	return { path: "N/a.notebook", folder: "N", name: "a", mtime: 1, size: 1, created: 1, modified: 1, pages: 20, tags: [], favorite: false, cover: "#3b82f6", ...over };
}

describe("page search", () => {
	it("scores substring above subsequence, none when letters are missing", () => {
		expect(fuzzyScore("phy", "physics")!).toBeGreaterThan(fuzzyScore("pcs", "physics")!);
		expect(fuzzyScore("xyz", "physics")).toBeNull();
	});
	it("parses 12 and p12 as a page, rest as words", () => {
		expect(parseQuery("Physics p12")).toEqual({ page: 12, words: ["physics"] });
		expect(parseQuery("12")).toEqual({ page: 12, words: [] });
	});
	it("finds a page by notebook name and number, ignoring pages that do not exist", () => {
		const es = [entry({ name: "Physics", path: "P.notebook", pages: 10 }), entry({ name: "Maths", path: "M.notebook", pages: 3 })];
		expect(searchPages(es, "phys 7").map((h) => [h.name, h.page])).toEqual([["Physics", 6]]);
		expect(searchPages(es, "p5").map((h) => h.name)).toEqual(["Physics"]);
	});
	it("finds bookmarks, page tags and text on the right page", () => {
		const e = entry({
			name: "Chem", bookmarks: [{ page: 4, title: "Exam Summary" }], pageTags: [{ page: 2, tags: ["lab"] }],
			text: "first words\nentropy rises", textPages: [0, 0, 7, 12],
		});
		expect(searchPages([e], "summary")[0]).toMatchObject({ kind: "bookmark", page: 4 });
		expect(searchPages([e], "lab")[0]).toMatchObject({ kind: "tag", page: 2 });
		expect(searchPages([e], "entropy")[0]).toMatchObject({ kind: "text", page: 7 });
		expect(searchPages([e], "")).toEqual([]);
		expect(searchPages([e], "zzzz")).toEqual([]);
	});
	it("indexes titled bookmarks only, by page order", () => {
		const doc = {
			pages: [{ id: "a" }, { id: "b" }, { id: "c" }],
			meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: ["c", "b"], bookmarkInfo: { c: { title: " Third " } } },
		};
		const e = entryFromFile({ path: "x.notebook", mtime: 1, size: 1 }, doc as never);
		expect(e.bookmarks).toEqual([{ page: 2, title: "Third" }]);
	});
});

describe("recent log", () => {
	const item = (page: string, at: number, nb = "n1") => ({ nb, path: "N/a.notebook", page, num: 1, at });
	it("keeps one entry per page, newest first, capped", () => {
		const log = new RecentLog([], 3);
		log.add(item("a", 1));
		log.add(item("b", 2));
		log.add(item("a", 3));
		expect(log.list().map((i) => i.page)).toEqual(["a", "b"]);
		log.add(item("c", 4));
		log.add(item("d", 5));
		expect(log.list().map((i) => i.page)).toEqual(["d", "c", "a"]);
	});
	it("round-trips and survives junk", () => {
		const log = new RecentLog([item("a", 1)]);
		expect(RecentLog.parse(JSON.stringify(log.toJSON())).list()).toEqual(log.list());
		for (const junk of [null, "x", "{", 4, { items: 3 }, { items: [{ nb: 1 }] }]) expect(RecentLog.parse(junk).list()).toEqual([]);
	});
	it("follows renames and removals", () => {
		const log = new RecentLog([item("a", 1)]);
		expect(log.rename("N", "M")).toBe(true);
		expect(log.list()[0]!.path).toBe("M/a.notebook");
		expect(log.removePath("M")).toBe(true);
		expect(log.list()).toEqual([]);
	});
	it("recorder writes once after the edits pause", () => {
		const log = new RecentLog();
		let saved = 0;
		let fire: (() => void) | null = null;
		const timers = { set: (fn: () => void) => ((fire = fn), 1), clear: () => (fire = null) };
		let now = 100;
		const rec = new RecentRecorder(log, timers, () => saved++, () => now);
		rec.touch("n1", "p", "a", 1);
		now = 200;
		rec.touch("n1", "p", "a", 1);
		expect(saved).toBe(0);
		fire!();
		expect(saved).toBe(1);
		expect(log.list()).toEqual([{ nb: "n1", path: "p", page: "a", num: 1, at: 200 }]);
		rec.flush();
		expect(saved).toBe(1);
	});
	it("ago picks a unit", () => {
		expect(ago(10 * 60_000, 0)).toEqual({ value: -10, unit: "minute" });
		expect(ago(3 * 3_600_000, 0)).toEqual({ value: -3, unit: "hour" });
		expect(ago(2 * 86_400_000, 0)).toEqual({ value: -2, unit: "day" });
	});
});

describe("go to page", () => {
	const bms = [{ index: 4, title: "Introduction" }, { index: 9, title: "Index of terms" }];
	it("accepts 12 and p12 inside the notebook only", () => {
		expect(gotoTargets("12", 20, bms)[0]).toMatchObject({ index: 11, kind: "page" });
		expect(gotoTargets("P3", 20, bms)[0]).toMatchObject({ index: 2 });
		expect(gotoTargets("21", 20, bms)).toEqual([]);
		expect(gotoTargets("0", 20, bms)).toEqual([]);
	});
	it("matches bookmark title prefixes first, then substrings, and lists all when empty", () => {
		expect(gotoTargets("in", 20, bms).map((x) => x.index)).toEqual([4, 9]);
		expect(gotoTargets("terms", 20, bms).map((x) => x.index)).toEqual([9]);
		expect(gotoTargets("", 20, bms)).toHaveLength(2);
	});
});
