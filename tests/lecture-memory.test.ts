import { describe, expect, it } from "vitest";
import {
	LECTURE_MEMORY_KEYS, LECTURE_MEMORY_NOTEBOOKS, lectureMemoryOf, normaliseLectureMemory, rememberLecture, type LectureMemory,
} from "../src/timetable/lecture-memory";

const TODAY = "2026-10-26";
const key = (id: string, day = TODAY) => `${id}@${day}`;

describe("what lecture mode remembers on this device", () => {
	it("keeps declined and paged occurrences per notebook", () => {
		let m: LectureMemory = {};
		m = rememberLecture(m, "Notebooks/A.notebook", "declined", key("c1"), TODAY);
		m = rememberLecture(m, "Notebooks/A.notebook", "paged", key("c2"), TODAY);
		m = rememberLecture(m, "Notebooks/B.notebook", "paged", key("c1"), TODAY);
		const a = lectureMemoryOf(m, "Notebooks/A.notebook");
		expect([...a.declined]).toEqual([key("c1")]);
		expect([...a.paged]).toEqual([key("c2")]);
		expect([...lectureMemoryOf(m, "Notebooks/B.notebook").declined]).toEqual([]);
		expect([...lectureMemoryOf(m, "Notebooks/none.notebook").paged]).toEqual([]);
	});

	it("survives a round trip through JSON, as local storage does", () => {
		const m = rememberLecture({}, "N/a.notebook", "declined", key("c1"), TODAY);
		const back = normaliseLectureMemory(JSON.parse(JSON.stringify(m)), TODAY);
		expect(back).toEqual(m);
	});

	it("does not repeat a key", () => {
		let m: LectureMemory = {};
		for (let i = 0; i < 3; i++) m = rememberLecture(m, "N/a.notebook", "paged", key("c1"), TODAY);
		expect(m["N/a.notebook"]!.paged).toEqual([key("c1")]);
	});

	it("keeps only today's occurrences", () => {
		const old = { "N/a.notebook": { day: "2026-10-25", declined: [key("c1", "2026-10-25")], paged: [] } };
		expect(normaliseLectureMemory(old, TODAY)).toEqual({});
		// A row of an earlier day that is written to today forgets its old keys.
		const m = rememberLecture(old, "N/a.notebook", "declined", key("c2"), TODAY);
		expect(m["N/a.notebook"]).toEqual({ day: TODAY, declined: [key("c2")], paged: [] });
		// Keys of another day inside today's row are dropped.
		expect(normaliseLectureMemory({ "N/a.notebook": { day: TODAY, declined: [key("c1", "2026-10-25"), key("c3")], paged: [] } }, TODAY)["N/a.notebook"]!.declined)
			.toEqual([key("c3")]);
	});

	it("is bounded: notebooks and keys per notebook, the oldest go first", () => {
		let m: LectureMemory = {};
		for (let i = 0; i < LECTURE_MEMORY_NOTEBOOKS + 10; i++) m = rememberLecture(m, `N/${i}.notebook`, "paged", key("c"), TODAY);
		expect(Object.keys(m)).toHaveLength(LECTURE_MEMORY_NOTEBOOKS);
		expect(m["N/0.notebook"]).toBeUndefined();
		expect(m[`N/${LECTURE_MEMORY_NOTEBOOKS + 9}.notebook`]).toBeDefined();
		for (let i = 0; i < LECTURE_MEMORY_KEYS + 10; i++) m = rememberLecture(m, "N/busy.notebook", "declined", key(`k${i}`), TODAY);
		expect(m["N/busy.notebook"]!.declined).toHaveLength(LECTURE_MEMORY_KEYS);
		expect(m["N/busy.notebook"]!.declined[LECTURE_MEMORY_KEYS - 1]).toBe(key(`k${LECTURE_MEMORY_KEYS + 9}`));
		expect(Object.keys(m)).toHaveLength(LECTURE_MEMORY_NOTEBOOKS);
	});

	it("reads corrupt data as empty or drops the bad rows, never throws", () => {
		for (const junk of [null, undefined, 7, "x", [], true]) expect(normaliseLectureMemory(junk, TODAY)).toEqual({});
		expect(normaliseLectureMemory({ a: 1 }, "not a day")).toEqual({});
		const m = normaliseLectureMemory({
			"": { day: TODAY, declined: [key("c1")], paged: [] },
			s: "x", n: null, noDay: { declined: [key("c1")] }, bad: { day: TODAY, declined: "c1", paged: [3, null, {}] },
			ok: { day: TODAY, declined: [key("c1"), 4, key("c1")], paged: ["x@y"] },
		}, TODAY);
		expect(Object.keys(m)).toEqual(["ok"]);
		expect(m.ok!.declined).toEqual([key("c1")]);
	});

	it("a notebook called __proto__ does not reach the prototype", () => {
		const m = rememberLecture({}, "__proto__", "declined", key("c1"), TODAY);
		expect(Object.keys(m)).toEqual([]);
		expect(({} as Record<string, unknown>).declined).toBeUndefined();
	});
});
