import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	setIcon: () => undefined,
	getLanguage: () => "en",
	Notice: class {
		hide(): void {}
		setMessage(): void {}
	},
	Modal: class {},
	Setting: class {},
}));

import { estimateMeasure } from "../src/ink/text-layout";
import { createDocument, createPage } from "../src/model/document";
import { History, type Command } from "../src/model/history";
import { SetPageLocked } from "../src/model/page-lock";
import { checkContent } from "../src/model/serialize";
import type { NotebookDocument, Stroke, TextElement } from "../src/model/types";
import {
	DEFAULT_HEADER_FIELDS, findFreeSpot, headerText, HEADER_EDGE, occupiedBoxes, pickHeaderClass, planLectureHeader,
	type HeaderFields,
} from "../src/timetable/lecture-header";
import { lectureClassOf } from "../src/timetable/lecture-mode";
import type { ClassEntry, Timetable } from "../src/timetable/schedule";
import type { EditContext } from "../src/view/edit-context";
import { insertHeader } from "../src/view/lecture-header";
import { lectureHeaderText } from "../src/view/lecture-logic";

// 2026-10-26 is a Monday. Local wall-clock times: a class at 09:00 is at 09:00 wherever the device is.
const mon = (h: number, m = 0) => new Date(2026, 9, 26, h, m, 0, 0);

const entry = (over: Partial<ClassEntry> = {}): ClassEntry => ({ id: "a", course: "Analysis 1", day: 1, start: "09:00", end: "11:00", weeks: "all", lecturer: "Prof. Rossi", room: "B2", ...over });
const table = (...entries: ClassEntry[]): Timetable => ({ version: 1, entries });

describe("lecture header: which class", () => {
	it("picks the class in progress, with the lead time before it starts", () => {
		const tt = table(entry());
		expect(pickHeaderClass(tt, "Notebooks/x.notebook", mon(10), 0, false)?.id).toBe("a");
		expect(pickHeaderClass(tt, "Notebooks/x.notebook", mon(8, 56), 5, false)?.id).toBe("a");
		expect(pickHeaderClass(tt, "Notebooks/x.notebook", mon(8, 50), 5, false)).toBeNull();
		expect(pickHeaderClass(tt, "Notebooks/x.notebook", mon(11), 0, false)).toBeNull();
	});

	it("a class at 09:00 is at 09:00 of the device's own clock, whatever the zone", () => {
		const tt = table(entry());
		// Built from the local fields, as the plugin reads them: the instant differs between zones, the wall clock does not.
		expect(pickHeaderClass(tt, null, new Date(2026, 9, 26, 9, 0), 0, false)?.id).toBe("a");
		expect(pickHeaderClass(tt, null, new Date(2026, 9, 26, 8, 59), 0, false)).toBeNull();
		// Another weekday never matches.
		expect(pickHeaderClass(tt, null, new Date(2026, 9, 27, 10, 0), 0, false)).toBeNull();
	});

	it("overlapping classes: the one that started last; a class linked to another notebook never applies", () => {
		const a = entry({ id: "a", start: "09:00", end: "12:00" });
		const b = entry({ id: "b", course: "Physics", start: "10:00", end: "11:00" });
		expect(pickHeaderClass(table(a, b), null, mon(10, 30), 0, false)?.id).toBe("b");
		expect(pickHeaderClass(table(a, b), null, mon(9, 30), 0, false)?.id).toBe("a");
		const linked = entry({ id: "l", notebook: "Notebooks/Other.notebook" });
		expect(pickHeaderClass(table(linked), "Notebooks/Mine.notebook", mon(10), 0, true)).toBeNull();
		expect(pickHeaderClass(table(linked), "Notebooks/Other.notebook", mon(10), 0, false)?.id).toBe("l");
	});

	it("no slot: nothing, also for the nearest", () => {
		expect(pickHeaderClass(table(), null, mon(10), 0, true)).toBeNull();
		expect(pickHeaderClass(table(entry({ day: 3 })), null, mon(10), 0, true)).toBeNull();
	});

	it("nearest: after the class the one that just ended, before it the next one, between two the closer", () => {
		const a = entry({ id: "a", start: "09:00", end: "10:00" });
		const b = entry({ id: "b", course: "Physics", start: "14:00", end: "15:00" });
		const tt = table(a, b);
		expect(pickHeaderClass(tt, null, mon(10, 30), 0, true)?.id).toBe("a");
		expect(pickHeaderClass(tt, null, mon(13, 0), 0, true)?.id).toBe("b");
		expect(pickHeaderClass(tt, null, mon(7, 0), 0, true)?.id).toBe("a");
		expect(pickHeaderClass(tt, null, mon(10, 30), 0, false)).toBeNull();
	});
});

describe("lecture header: fields", () => {
	const cls = lectureClassOf(entry(), mon(9, 30));
	const fields = (over: Partial<HeaderFields> = {}): HeaderFields => ({ ...DEFAULT_HEADER_FIELDS, ...over });

	it("English", () => {
		const h = headerText(cls, mon(9, 30), "en", fields(), "Room");
		expect(h.title).toBe("Analysis 1");
		expect(h.details).toMatch(/^Prof. Rossi · Room B2 · Monday,? 26 October 2026 · 09:00$/);
	});

	it("Italian", () => {
		const h = headerText(cls, mon(9, 30), "it", fields(), "Aula");
		expect(h.details).toBe("Prof. Rossi · Aula B2 · lunedì 26 ottobre 2026 · 09:00");
	});

	it("leaves out the fields that are off or unknown", () => {
		expect(headerText(cls, mon(9), "en", fields({ lecturer: false, room: false, date: false }), "Room").details).toBe("09:00");
		expect(headerText(cls, mon(9), "en", fields({ lecturer: false, room: false, date: false, time: false }), "Room").details).toBe("");
		const bare = lectureClassOf(entry({ lecturer: undefined, room: undefined }), mon(9));
		expect(headerText(bare, mon(9), "en", fields({ date: false }), "Room").details).toBe("09:00");
	});

	it("an unknown locale falls back to English instead of throwing", () => {
		expect(headerText(cls, mon(9), "zz-not-a-locale-!!", fields(), "Room").details).toContain("2026");
	});

	it("collapses line breaks and runs of spaces", () => {
		const messy = lectureClassOf(entry({ course: "  Analysis\n 1 ", room: " B\n2" }), mon(9));
		const h = headerText(messy, mon(9), "en", fields(), "Room");
		expect(h.title).toBe("Analysis 1");
		expect(h.details).toContain("Room B 2");
	});
});

const stroke = (x: number, y: number, x2 = x + 20, y2 = y + 20): Stroke =>
	({ id: `s${x}-${y}`, tool: "pen", color: "#000000", width: 2, render: 1, points: [[x, y, 0.5], [x2, y2, 0.5]] }) as unknown as Stroke;

describe("lecture header: free area", () => {
	const page = { width: 595, height: 842 };

	it("an empty page: the top margin", () => {
		expect(findFreeSpot(page, [], 500, 40)).toEqual({ x: HEADER_EDGE, y: HEADER_EDGE });
	});

	it("moves below ink at the top and keeps clear of it", () => {
		const spot = findFreeSpot(page, [{ minX: 30, minY: 20, maxX: 300, maxY: 50 }], 500, 40)!;
		expect(spot.y).toBeGreaterThanOrEqual(60);
		expect(spot.y).toBeLessThan(80);
	});

	it("never overlaps: no spot when ink fills the top of the page", () => {
		expect(findFreeSpot(page, [{ minX: 0, minY: 0, maxX: 595, maxY: 600 }], 500, 40)).toBeNull();
	});

	it("ink away from the band does not matter", () => {
		expect(findFreeSpot(page, [{ minX: 30, minY: 400, maxX: 300, maxY: 450 }], 500, 40)).toEqual({ x: HEADER_EDGE, y: HEADER_EDGE });
	});

	it("a box wider than the page, or a page too small, has no spot", () => {
		expect(findFreeSpot(page, [], 600, 40)).toBeNull();
		expect(findFreeSpot({ width: 595, height: 50 }, [], 500, 40)).toBeNull();
	});

	it("looks at strokes and elements of a page", () => {
		const p = createPage({ width: 595, height: 842 });
		p.strokes.push(stroke(40, 30, 200, 60));
		const el: TextElement = { id: "t", type: "text", x: 300, y: 100, width: 100, text: "x", fontSize: 12, color: "#000" };
		p.elements = [el];
		const boxes = occupiedBoxes(p);
		expect(boxes).toHaveLength(2);
		expect(boxes[0]!.maxY).toBeGreaterThanOrEqual(60);
	});
});

describe("lecture header: plan", () => {
	const cls = lectureClassOf(entry(), mon(9, 30));
	const text = headerText(cls, mon(9, 30), "en", DEFAULT_HEADER_FIELDS, "Room");

	it("two boxes in one fresh group at the top margin of an empty page", () => {
		const p = createPage({ width: 595, height: 842 });
		const plan = planLectureHeader(p, text, cls.course, mon(9, 30), estimateMeasure);
		expect(plan.kind).toBe("add");
		if (plan.kind !== "add") return;
		expect(plan.elements).toHaveLength(2);
		const [title, details] = plan.elements as [TextElement, TextElement];
		expect(title.y).toBe(HEADER_EDGE);
		expect(details.y).toBeGreaterThan(title.y);
		expect(title.group).toBeDefined();
		expect(title.group).toBe(details.group);
		expect(plan.group).toBe(title.group);
		expect(title.text).toBe("Analysis 1");
	});

	it("only the course: one box, no group", () => {
		const p = createPage({ width: 595, height: 842 });
		const only = headerText(cls, mon(9), "en", { lecturer: false, room: false, date: false, time: false }, "Room");
		const plan = planLectureHeader(p, only, cls.course, mon(9), estimateMeasure);
		expect(plan.kind === "add" && plan.elements.length === 1 && plan.group === null).toBe(true);
	});

	it("skips when the page is full at the top, already has the header, or has the title of a lecture page", () => {
		const full = createPage({ width: 595, height: 842 });
		full.strokes.push(stroke(10, 10, 580, 400));
		expect(planLectureHeader(full, text, cls.course, mon(9, 30))).toEqual({ kind: "skip", reason: "no-space" });

		const p = createPage({ width: 595, height: 842 });
		const first = planLectureHeader(p, text, cls.course, mon(9, 30));
		if (first.kind !== "add") throw new Error("expected a plan");
		p.elements = [...first.elements];
		expect(planLectureHeader(p, text, cls.course, mon(9, 30))).toEqual({ kind: "skip", reason: "present" });

		const lecture = createPage({ width: 595, height: 842 });
		lecture.elements = [{ id: "h", type: "text", x: 28, y: 28, width: 500, text: lectureHeaderText(cls.course, mon(9, 30)), fontSize: 16, color: "#000" }];
		expect(planLectureHeader(lecture, text, cls.course, mon(9, 30)).kind).toBe("skip");
	});

	it("a page with a plain text box of the same words (no group) is not a header", () => {
		const p = createPage({ width: 595, height: 842 });
		p.elements = [{ id: "n", type: "text", x: 300, y: 500, width: 200, text: "Analysis 1", fontSize: 12, color: "#000" }];
		expect(planLectureHeader(p, text, cls.course, mon(9, 30)).kind).toBe("add");
	});

	it("an empty course writes nothing", () => {
		const p = createPage({ width: 595, height: 842 });
		expect(planLectureHeader(p, { title: "", details: "x" }, "", mon(9))).toEqual({ kind: "skip", reason: "empty" });
	});
});

describe("lecture header: one undo step", () => {
	function scene() {
		const doc: NotebookDocument = createDocument(new Date(2026, 9, 26), { width: 595, height: 842 });
		const history = new History(() => doc, 500, checkContent);
		const ctx = {
			doc,
			measure: estimateMeasure,
			currentPage: () => 0,
			execute: (cmd: Command) => history.execute(cmd),
		} as unknown as EditContext;
		return { doc, history, ctx };
	}
	const cls = lectureClassOf(entry(), mon(9, 30));

	it("adds the group in one step and undoes it in one", () => {
		const { doc, history, ctx } = scene();
		expect(insertHeader(ctx, 0, cls, DEFAULT_HEADER_FIELDS, "en", mon(9, 30))).toBe("added");
		const els = doc.pages[0]!.elements!;
		expect(els).toHaveLength(2);
		expect(els[0]!.group).toBe(els[1]!.group);
		expect(checkContent(doc)).toBeNull();
		expect(insertHeader(ctx, 0, cls, DEFAULT_HEADER_FIELDS, "en", mon(9, 30))).toBe("present");
		history.undo();
		expect(doc.pages[0]!.elements ?? []).toHaveLength(0);
		expect(history.canUndo()).toBe(false);
		history.redo();
		expect(doc.pages[0]!.elements).toHaveLength(2);
	});

	it("does not overlap ink: no spot when the top is covered", () => {
		const { doc, ctx } = scene();
		doc.pages[0]!.strokes.push(stroke(20, 10, 570, 500));
		expect(insertHeader(ctx, 0, cls, DEFAULT_HEADER_FIELDS, "en", mon(9, 30))).toBe("no-space");
		expect(doc.pages[0]!.elements ?? []).toHaveLength(0);
	});

	it("refuses a locked page and changes nothing", () => {
		const { doc, history, ctx } = scene();
		history.execute(new SetPageLocked(doc.pages[0]!.id, true));
		expect(insertHeader(ctx, 0, cls, DEFAULT_HEADER_FIELDS, "en", mon(9, 30))).toBe("locked");
		expect(doc.pages[0]!.elements ?? []).toHaveLength(0);
	});

	it("a page that does not exist is nothing", () => {
		const { ctx } = scene();
		expect(insertHeader(ctx, 5, cls, DEFAULT_HEADER_FIELDS, "en", mon(9, 30))).toBe("empty");
	});
});

describe("lecture header: settings", () => {
	it("reads the mode and the fields, ignoring values of the wrong type", async () => {
		const { readSettings, DEFAULT_SETTINGS } = await import("../src/settings");
		expect(DEFAULT_SETTINGS.lectureHeader).toBe("ask");
		expect(readSettings({ lectureHeader: "auto", lectureHeaderRoom: false }).lectureHeader).toBe("auto");
		expect(readSettings({ lectureHeader: "auto", lectureHeaderRoom: false }).lectureHeaderRoom).toBe(false);
		expect(readSettings({ lectureHeader: "always" }).lectureHeader).toBe("ask");
		expect(readSettings({ lectureHeaderDate: "no" }).lectureHeaderDate).toBe(true);
	});
});
