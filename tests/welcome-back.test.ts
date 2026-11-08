import { describe, expect, it } from "vitest";
import { createDocument, createPage } from "../src/model/document";
import { createMarker } from "../src/model/markers";
import {
	awayParts, clampWelcomeHours, normaliseSeen, planWelcome, recordSeen, WELCOME_HOURS_DEFAULT, WELCOME_MAX_NOTEBOOKS, WELCOME_PER_GROUP, WELCOME_TEXT_MAX,
} from "../src/model/welcome-back";
import type { NotebookDocument } from "../src/model/types";

const H = 3_600_000;
const NOW = 1_800_000_000_000;

function book(pages = 4): NotebookDocument {
	const doc = createDocument();
	while (doc.pages.length < pages) doc.pages.push(createPage());
	return doc;
}

describe("clampWelcomeHours", () => {
	it("keeps a number in range and falls back to the default", () => {
		expect(clampWelcomeHours(12)).toBe(12);
		expect(clampWelcomeHours(0)).toBe(1);
		expect(clampWelcomeHours(9999)).toBe(168);
		expect(clampWelcomeHours("x")).toBe(WELCOME_HOURS_DEFAULT);
		expect(clampWelcomeHours(NaN)).toBe(WELCOME_HOURS_DEFAULT);
	});
});

describe("seen store", () => {
	it("drops corrupt data and bad entries", () => {
		expect(normaliseSeen(null)).toEqual({});
		expect(normaliseSeen([1, 2])).toEqual({});
		expect(normaliseSeen({ ok: 5, "bad id": 6, neg: -1, str: "x", nan: NaN })).toEqual({ ok: 5 });
	});
	it("is bounded: the oldest are forgotten", () => {
		let s: Record<string, number> = {};
		for (let i = 1; i <= WELCOME_MAX_NOTEBOOKS + 10; i++) s = { ...s, [`n${i}`]: i };
		const n = normaliseSeen(s);
		expect(Object.keys(n)).toHaveLength(WELCOME_MAX_NOTEBOOKS);
		expect(n.n1).toBeUndefined();
		expect(n[`n${WELCOME_MAX_NOTEBOOKS + 10}`]).toBeDefined();
	});
	it("records a time and ignores a bad id", () => {
		expect(recordSeen({}, "abc", 5)).toEqual({ abc: 5 });
		const s = { a: 1 };
		expect(recordSeen(s, "bad id", 5)).toBe(s);
		expect(recordSeen(s, "a", NaN)).toBe(s);
	});
});

describe("planWelcome", () => {
	it("offers nothing the first time on this device", () => {
		const doc = book();
		doc.position = { page: doc.pages[2]!.id, at: "x" };
		expect(planWelcome(doc, { lastSeen: null, now: NOW, hours: 8 })).toBeNull();
	});
	it("offers nothing before the threshold", () => {
		const doc = book();
		doc.position = { page: doc.pages[2]!.id, at: "x" };
		expect(planWelcome(doc, { lastSeen: NOW - 7 * H, now: NOW, hours: 8 })).toBeNull();
		expect(planWelcome(doc, { lastSeen: NOW - 8 * H, now: NOW, hours: 8 })).not.toBeNull();
	});
	it("offers nothing when there is nothing to go to", () => {
		const doc = book();
		expect(planWelcome(doc, { lastSeen: NOW - 20 * H, now: NOW, hours: 8 })).toBeNull();
		doc.position = { page: doc.pages[0]!.id, at: "x" };
		expect(planWelcome(doc, { lastSeen: NOW - 20 * H, now: NOW, hours: 8 })).toBeNull();
	});
	it("resumes at the stored place, with the slide of a PDF page", () => {
		const doc = book();
		doc.pages[2]!.background = { kind: "pdf", asset: "a", page: 7 };
		doc.position = { page: doc.pages[2]!.id, y: 120, at: "x" };
		const plan = planWelcome(doc, { lastSeen: NOW - 20 * H, now: NOW, hours: 8 })!;
		expect(plan.resume).toEqual({ index: 2, y: 120, slide: 7 });
		expect(plan.questions).toEqual([]);
	});
	it("a position on a page that is gone is not offered", () => {
		const doc = book();
		doc.position = { page: "gone", at: "x" };
		expect(planWelcome(doc, { lastSeen: NOW - 20 * H, now: NOW, hours: 8 })).toBeNull();
	});
	it("lists open questions and gaps in reading order, skipping resolved and other markers", () => {
		const doc = book();
		const long = "q".repeat(200);
		doc.pages[1]!.elements = [
			createMarker("question", 50, 300, { text: "second" }),
			createMarker("question", 50, 100, { text: "first" }),
			{ ...createMarker("question", 50, 50, { text: "resolved" }), done: true },
			createMarker("homework", 50, 80, { text: "hw" }),
			createMarker("important", 50, 90),
		];
		doc.pages[3]!.elements = [createMarker("question", 10, 10, { text: long }), createMarker("gap", 10, 500), createMarker("gap", 10, 20, { text: "g1" })];
		const plan = planWelcome(doc, { lastSeen: NOW - 30 * H, now: NOW, hours: 8 })!;
		expect(plan.resume).toBeNull();
		expect(plan.questionTotal).toBe(3);
		expect(plan.questions).toHaveLength(WELCOME_PER_GROUP);
		expect(plan.questions.map((q) => q.text)).toEqual(["first", "second"]);
		expect(plan.questions[0]).toMatchObject({ pageIndex: 1, pageId: doc.pages[1]!.id });
		expect(plan.gapTotal).toBe(2);
		expect(plan.gaps.map((g) => g.pageIndex)).toEqual([3, 3]);
		expect(plan.gaps[0]!.text).toBe("g1");
		expect(plan.gaps[1]!.text).toBeNull();
		doc.pages[1]!.elements = [];
		doc.pages[3]!.elements = [createMarker("question", 10, 10, { text: long })];
		const shortened = planWelcome(doc, { lastSeen: NOW - 30 * H, now: NOW, hours: 8 })!;
		expect(Array.from(shortened.questions[0]!.text!)).toHaveLength(WELCOME_TEXT_MAX);
	});
	it("a threshold of more hours waits longer", () => {
		const doc = book();
		doc.pages[1]!.elements = [createMarker("gap", 10, 10)];
		expect(planWelcome(doc, { lastSeen: NOW - 20 * H, now: NOW, hours: 24 })).toBeNull();
	});
});

describe("awayParts", () => {
	it("counts hours, then days", () => {
		expect(awayParts(8.4 * H)).toEqual({ unit: "h", n: 8 });
		expect(awayParts(47 * H)).toEqual({ unit: "h", n: 47 });
		expect(awayParts(72 * H)).toEqual({ unit: "d", n: 3 });
		expect(awayParts(1000)).toEqual({ unit: "h", n: 1 });
	});
});
