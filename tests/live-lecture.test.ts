import { describe, expect, it } from "vitest";
import {
	addMarkToTitle, collectLiveMarks, elapsedSeconds, formatElapsed, lectureStart, markLabel, parseElapsed, parseMarks,
} from "../src/timetable/live-lecture";
import { MAX_BOOKMARK_TITLE } from "../src/model/bookmarks";

describe("live lecture timer", () => {
	it("formats minutes and hours", () => {
		expect(formatElapsed(0)).toBe("00:00");
		expect(formatElapsed(754)).toBe("12:34");
		expect(formatElapsed(3599)).toBe("59:59");
		expect(formatElapsed(3723)).toBe("1:02:03");
		expect(formatElapsed(-5)).toBe("00:00");
		expect(formatElapsed(Number.NaN)).toBe("00:00");
	});
	it("counts whole seconds and never goes negative", () => {
		expect(elapsedSeconds(1000, 4999)).toBe(3);
		expect(elapsedSeconds(5000, 1000)).toBe(0);
		expect(elapsedSeconds(Number.NaN, 1)).toBe(0);
	});
	it("starts at the class start once it began, else now", () => {
		expect(lectureStart(1000, 5000)).toBe(1000);
		expect(lectureStart(9000, 5000)).toBe(5000);
		expect(lectureStart(null, 5000)).toBe(5000);
	});
	it("parses times back", () => {
		expect(parseElapsed("12:34")).toBe(754);
		expect(parseElapsed("1:02:03")).toBe(3723);
		expect(parseElapsed("12:75")).toBeNull();
		expect(parseElapsed("abc")).toBeNull();
	});
});

describe("live lecture marks", () => {
	it("labels a moment", () => {
		expect(markLabel(754)).toBe("★ 12:34");
	});
	it("builds and reads titles", () => {
		const a = addMarkToTitle(undefined, "★ 05:00");
		expect(a).toBe("★ 05:00");
		const b = addMarkToTitle(a, "★ 12:34");
		expect(b).toBe("★ 05:00 · ★ 12:34");
		expect(addMarkToTitle(b, "★ 12:34")).toBe(b);
		expect(parseMarks(b).map((m) => m.seconds)).toEqual([300, 754]);
		expect(addMarkToTitle("Theorem 3", "★ 01:00")).toBe("Theorem 3 · ★ 01:00");
		expect(parseMarks("Theorem 3")).toEqual([]);
	});
	it("keeps the title within the limit and the reader's text", () => {
		let title: string | undefined = "Mine";
		for (let i = 0; i < 80; i++) title = addMarkToTitle(title, markLabel(i * 61));
		expect(title.length).toBeLessThanOrEqual(MAX_BOOKMARK_TITLE);
		expect(title.startsWith("Mine")).toBe(true);
		expect(title.endsWith(markLabel(79 * 61))).toBe(true);
	});
	it("collects marks by page in time order, only for bookmarked pages in range", () => {
		const pages = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
		const info = { a: { title: "★ 10:00" }, b: { title: "★ 20:00 · ★ 15:00" }, c: { title: "★ 30:00" }, d: { title: "★ 40:00" } };
		const out = collectLiveMarks(pages, ["a", "b", "d"], info, { from: 0, to: 3 });
		expect(out.map((m) => [m.pageIndex, m.label])).toEqual([[0, "★ 10:00"], [1, "★ 15:00"], [1, "★ 20:00"]]);
		expect(collectLiveMarks(pages, ["a"], undefined, { from: 0, to: 4 })).toEqual([]);
	});
});
