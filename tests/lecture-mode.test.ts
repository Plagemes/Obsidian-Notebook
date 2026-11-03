import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { parse, serializeChecked } from "../src/model/serialize";
import { createDocument } from "../src/model/document";
import type { TextElement } from "../src/model/types";
import {
	classCoversNotebook, DEFAULT_LECTURE_SETTINGS, lectureClassFor, lectureClassOf, readLectureSettings, stepLectureMode,
	type ActiveLecture, type LectureClass, type ModeInput,
} from "../src/timetable/lecture-mode";
import { findLecturePage } from "../src/timetable/lecture-open";
import {
	classForNotebook, courseForNotebook, parseTimetable, serializeTimetable, type ClassEntry, type NotebookRef, type Timetable,
} from "../src/timetable/schedule";
import {
	buildLecturePage, lectureDetailsText, lectureHeaderText, pickSlideRef, slideLine, DETAILS_FONT_SIZE, HEADER_MARGIN,
} from "../src/view/lecture-logic";
import { readSettings } from "../src/settings";

// 2026-10-26 is a Monday.
const mon = (h: number, m = 0) => new Date(2026, 9, 26, h, m, 0, 0);

function entry(over: Partial<ClassEntry> = {}): ClassEntry {
	return { id: "c1", course: "Analysis 1", day: 1, start: "09:00", end: "11:00", weeks: "all", ...over };
}

const books: NotebookRef[] = [
	{ path: "Notebooks/Analysis 1.notebook", basename: "Analysis 1", mtime: 5 },
	{ path: "Notebooks/Physics.notebook", basename: "Physics", mtime: 9 },
	{ path: "Notebooks/Math/Notes.notebook", basename: "Notes", mtime: 7 },
];

describe("lecture settings", () => {
	it("defaults to ask and ignores bad values", () => {
		expect(DEFAULT_LECTURE_SETTINGS.lectureMode).toBe("ask");
		expect(readLectureSettings({}).lectureMode).toBe("ask");
		expect(readLectureSettings({ lectureMode: "auto" }).lectureMode).toBe("auto");
		expect(readLectureSettings({ lectureMode: "off" }).lectureMode).toBe("off");
		expect(readLectureSettings({ lectureMode: "always" }).lectureMode).toBe("ask");
		expect(readLectureSettings({ lectureMode: true }).lectureMode).toBe("ask");
	});

	it("is part of the plugin settings", () => {
		expect(readSettings({}).lectureMode).toBe("ask");
		expect(readSettings({ lectureMode: "auto" }).lectureMode).toBe("auto");
	});
});

describe("a class occurrence", () => {
	it("carries the slot as local times and the details", () => {
		const c = lectureClassOf(entry({ room: "B2", lecturer: "Prof. Rossi" }), mon(10, 15));
		expect(c.course).toBe("Analysis 1");
		expect(new Date(c.startsAt).getHours()).toBe(9);
		expect(new Date(c.endsAt).getHours()).toBe(11);
		expect(c.endsAt - c.startsAt).toBe(2 * 3_600_000);
		expect(c.room).toBe("B2");
		expect(c.lecturer).toBe("Prof. Rossi");
		expect(c.key).toBe("c1@2026-10-26");
	});

	it("leaves out an empty room and lecturer", () => {
		const c = lectureClassOf(entry(), mon(10));
		expect("room" in c).toBe(false);
		expect("lecturer" in c).toBe(false);
	});
});

describe("which notebook a class belongs to", () => {
	it("the notebook it links to, or one inside the linked folder", () => {
		expect(classCoversNotebook(entry({ notebook: "Notebooks/Physics.notebook" }), "Notebooks/Physics.notebook", books, "Notebooks")).toBe(true);
		expect(classCoversNotebook(entry({ notebook: "Notebooks/Physics.notebook" }), "Notebooks/Analysis 1.notebook", books, "Notebooks")).toBe(false);
		expect(classCoversNotebook(entry({ notebook: "Notebooks/Math/" }), "Notebooks/Math/Notes.notebook", books, "Notebooks")).toBe(true);
		expect(classCoversNotebook(entry({ notebook: "Notebooks/Math" }), "Notebooks/Physics.notebook", books, "Notebooks")).toBe(false);
	});

	it("an unlinked class belongs to the notebook named like the course, not to every open notebook", () => {
		expect(classCoversNotebook(entry(), "Notebooks/Analysis 1.notebook", books, "Notebooks")).toBe(true);
		expect(classCoversNotebook(entry(), "Notebooks/Physics.notebook", books, "Notebooks")).toBe(false);
		expect(classCoversNotebook(entry({ course: "analysis 1" }), "Notebooks/Analysis 1.notebook", books, "Notebooks")).toBe(true);
	});

	it("finds the class in progress for a notebook, with the lead", () => {
		const tt: Timetable = { version: 1, entries: [entry(), entry({ id: "c2", course: "Physics", start: "11:00", end: "13:00" })] };
		const at = (d: Date, lead = 0) => lectureClassFor(tt, "Notebooks/Analysis 1.notebook", books, "Notebooks", d, lead);
		expect(at(mon(10))?.course).toBe("Analysis 1");
		expect(at(mon(8, 56), 5)?.course).toBe("Analysis 1");
		expect(at(mon(8, 56), 0)).toBeNull();
		expect(at(mon(11, 0))).toBeNull();
		expect(lectureClassFor(tt, "Notebooks/Physics.notebook", books, "Notebooks", mon(10))).toBeNull();
		expect(lectureClassFor(tt, "Notebooks/Physics.notebook", books, "Notebooks", mon(12))?.course).toBe("Physics");
		expect(lectureClassFor(tt, null, books, "Notebooks", mon(10))).toBeNull();
	});

	it("classForNotebook is what courseForNotebook answers with", () => {
		const a = entry({ notebook: "Notebooks/Physics.notebook" });
		const b = entry({ id: "c2", course: "Chem" });
		expect(classForNotebook([b], "Notebooks/Physics.notebook", [a, b])).toBeNull();
		expect(classForNotebook([b], "Notebooks/Other.notebook", [a, b])?.id).toBe("c2");
		expect(courseForNotebook([b], "Notebooks/Other.notebook", [a, b])).toBe("Chem");
		expect(classForNotebook([], "x", [])).toBeNull();
	});
});

const cls = (over: Partial<LectureClass> = {}): LectureClass => ({
	key: "c1@2026-10-26", course: "Analysis 1", start: "09:00", end: "11:00", startsAt: mon(9).getTime(), endsAt: mon(11).getTime(), ...over,
});

function input(over: Partial<ModeInput> = {}): ModeInput {
	return { setting: "ask", now: mon(10).getTime(), match: cls(), active: null, asking: null, declined: new Set(), busy: false, ...over };
}

const on: ActiveLecture = { key: "c1@2026-10-26", endsAt: mon(11).getTime(), manual: false };

describe("lecture mode rules", () => {
	it("asks in ask mode, enters in auto mode, does nothing when off", () => {
		expect(stepLectureMode(input()).kind).toBe("ask");
		expect(stepLectureMode(input({ setting: "auto" })).kind).toBe("enter");
		expect(stepLectureMode(input({ setting: "off" })).kind).toBe("none");
	});

	it("does nothing without a class for this notebook", () => {
		expect(stepLectureMode(input({ match: null })).kind).toBe("none");
		expect(stepLectureMode(input({ match: null, setting: "auto" })).kind).toBe("none");
	});

	it("never starts or asks while writing, and starts at the first pause", () => {
		expect(stepLectureMode(input({ busy: true })).kind).toBe("none");
		expect(stepLectureMode(input({ busy: true, setting: "auto" })).kind).toBe("none");
		expect(stepLectureMode(input({ busy: false, setting: "auto" })).kind).toBe("enter");
	});

	it("does not come back for a class the user turned down", () => {
		const declined = new Set(["c1@2026-10-26"]);
		expect(stepLectureMode(input({ declined })).kind).toBe("none");
		expect(stepLectureMode(input({ declined, setting: "auto" })).kind).toBe("none");
		expect(stepLectureMode(input({ declined, match: cls({ key: "c1@2026-11-02" }) })).kind).toBe("ask");
	});

	it("stays on while the class lasts", () => {
		expect(stepLectureMode(input({ active: on })).kind).toBe("none");
		expect(stepLectureMode(input({ active: on, now: mon(10, 59).getTime() })).kind).toBe("none");
	});

	it("leaves when the class ends, but not under the pen", () => {
		expect(stepLectureMode(input({ active: on, now: mon(11).getTime(), match: null })).kind).toBe("leave");
		expect(stepLectureMode(input({ active: on, now: mon(11, 1).getTime(), match: null, busy: true })).kind).toBe("none");
		expect(stepLectureMode(input({ active: on, now: mon(11, 2).getTime(), match: null, busy: false })).kind).toBe("leave");
	});

	it("a lecture mode started by hand with no class stays until switched off", () => {
		const manual: ActiveLecture = { key: null, endsAt: null, manual: true };
		expect(stepLectureMode(input({ active: manual, match: null, setting: "off", now: mon(23).getTime() })).kind).toBe("none");
	});

	it("a manual mode on a class still ends with the class, and survives the setting being off", () => {
		const manual: ActiveLecture = { ...on, manual: true };
		expect(stepLectureMode(input({ active: manual, setting: "off" })).kind).toBe("none");
		expect(stepLectureMode(input({ active: manual, setting: "off", now: mon(11, 5).getTime(), match: null })).kind).toBe("leave");
	});

	it("a mode the rule started ends when the setting is turned off", () => {
		expect(stepLectureMode(input({ active: on, setting: "off" })).kind).toBe("leave");
		expect(stepLectureMode(input({ active: on, setting: "off", busy: true })).kind).toBe("none");
	});

	it("withdraws a banner that no longer applies, keeps one that does", () => {
		const asking = cls();
		expect(stepLectureMode(input({ asking })).kind).toBe("none");
		expect(stepLectureMode(input({ asking, match: null })).kind).toBe("unask");
		expect(stepLectureMode(input({ asking, setting: "off" })).kind).toBe("unask");
		expect(stepLectureMode(input({ asking, setting: "auto" })).kind).toBe("unask");
		expect(stepLectureMode(input({ asking, match: cls({ key: "c2@2026-10-26" }) })).kind).toBe("unask");
		expect(stepLectureMode(input({ asking, declined: new Set([asking.key]) })).kind).toBe("unask");
	});

	it("while the banner is up a pen on the screen does not remove it", () => {
		expect(stepLectureMode(input({ asking: cls(), busy: true })).kind).toBe("none");
	});
});

describe("lecturer in the timetable file", () => {
	it("is written, read back and kept out when empty", () => {
		const tt: Timetable = { version: 1, entries: [entry({ lecturer: " Prof. Rossi " }), entry({ id: "c2", lecturer: "  " })] };
		const text = serializeTimetable(tt);
		expect(text).toContain("\"lecturer\": \"Prof. Rossi\"");
		const back = parseTimetable(text);
		expect(back.ok).toBe(true);
		if (back.ok) {
			expect(back.timetable.entries[0]!.lecturer).toBe("Prof. Rossi");
			expect(back.timetable.entries[1]!.lecturer).toBeUndefined();
		}
	});

	it("an old file without it still reads", () => {
		const r = parseTimetable(JSON.stringify({ version: 1, entries: [{ id: "a", course: "X", day: 2, start: "08:00", end: "09:00", weeks: "all" }] }));
		expect(r.ok).toBe(true);
	});
});

describe("lecture page prefilled from context (#438)", () => {
	const date = new Date(2026, 9, 26, 12);
	const texts = (page: ReturnType<typeof buildLecturePage>) => (page.elements ?? []).filter((e): e is TextElement => e.type === "text");

	it("without context it is the same single header box as before", () => {
		const page = buildLecturePage(undefined, "Analysis 1", date);
		const boxes = texts(page);
		expect(boxes).toHaveLength(1);
		expect(boxes[0]!.text).toBe("Analysis 1 — 2026-10-26");
		expect(buildLecturePage(undefined, "Analysis 1", date, {}).elements).toHaveLength(1);
	});

	it("with a class: slot, room and lecturer go in a second text box under the header", () => {
		const page = buildLecturePage(undefined, "Analysis 1", date, { start: "09:00", end: "11:00", room: "B2", lecturer: "Prof. Rossi" });
		const [header, details] = texts(page);
		expect(header!.text).toBe(lectureHeaderText("Analysis 1", date));
		expect(details!.text).toBe("09:00–11:00 · B2 · Prof. Rossi");
		expect(details!.fontSize).toBe(DETAILS_FONT_SIZE);
		expect(details!.y).toBeGreaterThan(header!.y + header!.fontSize);
		expect(details!.x).toBe(HEADER_MARGIN);
		expect(details!.width).toBe(header!.width);
	});

	it("the slide reference is a link for a PDF of the vault, plain text otherwise", () => {
		const linked = buildLecturePage(undefined, "A", date, { slide: { name: "deck", page: 12, path: "Slides/deck.pdf" } });
		expect(texts(linked)[1]!.text).toBe("Slides: [[Slides/deck.pdf#page=12]]");
		const plain = buildLecturePage(undefined, "A", date, { slide: { name: "Lecture 3", page: 4 } });
		expect(texts(plain)[1]!.text).toBe("Slides: Lecture 3, slide 4");
		expect(slideLine({ name: "Lecture 3", page: null })).toBe("Slides: Lecture 3");
		expect(slideLine({ name: "x", page: 2, path: "a[b].pdf" })).toBe("Slides: x, slide 2");
		expect(slideLine({ name: "  ", page: 2 })).toBe("");
	});

	it("both lines when there is a class and a slide; nothing when there is nothing", () => {
		expect(lectureDetailsText({ start: "09:00", end: "10:00", slide: { name: "d", page: 1 } })).toBe("09:00–10:00\nSlides: d, slide 1");
		expect(lectureDetailsText({ start: "09:00" })).toBe("09:00");
		expect(lectureDetailsText({})).toBe("");
		expect(lectureDetailsText({ room: "  ", lecturer: "" })).toBe("");
	});

	it("a long header pushes the details down", () => {
		const long = "A very long course title ".repeat(8);
		const short = texts(buildLecturePage(undefined, "A", date, { room: "B2" }))[1]!;
		const tall = texts(buildLecturePage(undefined, long, date, { room: "B2" }))[1]!;
		expect(tall.y).toBeGreaterThan(short.y);
	});

	it("the page is ordinary elements: it saves, reads back and is found as the lecture's page", () => {
		const like = createPage({ width: 595, height: 842 });
		const page = buildLecturePage(like, "Analysis 1", date, { start: "09:00", end: "11:00", room: "B2", slide: { name: "d", page: 3, path: "d.pdf" } });
		const doc = createDocument(new Date(), { width: 595, height: 842 });
		doc.pages.push(page);
		const saved = serializeChecked(doc);
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		const back = parse(saved.text);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		const pages = back.doc.pages;
		expect(pages[pages.length - 1]!.elements).toHaveLength(2);
		expect(findLecturePage(pages, "Analysis 1", date)).toBe(pages.length - 1);
	});

	it("picks the slide: the PDF beside the notes first, else the page's own PDF background", () => {
		const pdfPage = { ...createPage({ width: 595, height: 842 }), background: { kind: "pdf" as const, asset: "abc", page: 7 } };
		const assets = { abc: { name: "Notes week 2.pdf" } };
		expect(pickSlideRef({ pane: { open: true, file: { path: "Slides/deck.pdf", basename: "deck" } }, paneSlide: 5, page: pdfPage, assets }))
			.toEqual({ name: "deck", page: 5, path: "Slides/deck.pdf" });
		expect(pickSlideRef({ pane: { open: false, file: null }, paneSlide: null, page: pdfPage, assets })).toEqual({ name: "Notes week 2", page: 7 });
		expect(pickSlideRef({ pane: null, paneSlide: null, page: createPage({ width: 1, height: 1 }), assets })).toBeNull();
		expect(pickSlideRef({ pane: null, paneSlide: null, page: pdfPage, assets: {} })).toBeNull();
		expect(pickSlideRef({ pane: null, paneSlide: null, page: undefined, assets: undefined })).toBeNull();
	});
});
