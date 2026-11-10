import { describe, expect, it } from "vitest";
import { detectTable } from "../src/ink/table";
import { redactBounds } from "../src/ink/redact";
import { redactStepCheck } from "../src/ink/redact-step";
import type { RedactBox } from "../src/model/redact";
import {
	buildTimeline, nearestSize, parseTimelineGroup, planTimelineInsert, planTimelineUpdate, readTimeline, sameTimeline, timelineGroupId, timelineOfSelection,
	timelineWidth, type TimelineChoice,
} from "../src/ink/timeline";
import {
	BOX_W, compressedGaps, editNeedsFixing, EVENT_SIZE, eventFromText, eventText, layoutTimeline, MAX_EVENTS, niceStep, parseEventLines, parseTimelineDate, romanValue,
	splitEventLine, yearLabel, type TimelineLabels,
} from "../src/math/timeline-layout";
import { createDocument } from "../src/model/document";
import { groupRenamer } from "../src/model/groups";
import { History } from "../src/model/history";
import { pageRules, pageScope } from "../src/model/page-undo";
import { serializeChecked } from "../src/model/serialize";
import type { Page, TextElement } from "../src/model/types";
import { LABELS } from "../src/model/history-describe";

const NOW = new Date("2026-11-10T10:00:00.000Z");
const labels: TimelineLabels = { bc: "BC", gap: (n) => `${n} years` };
let n = 0;
const ids = () => `t${++n}`;
const pos = (s: string) => parseTimelineDate(s)?.pos;

function setup(): { doc: ReturnType<typeof createDocument>; page: Page; history: History } {
	const doc = createDocument(NOW);
	const page = doc.pages[0]!;
	const history = new History(() => doc, 100, null, null, null, null);
	return { doc, page, history };
}

const EVENTS = "753 BC: Rome founded\n44 BC: Caesar killed\n476: Fall of the Western Empire\n1492: Columbus\n1969: Moon landing";
const choiceOf = (text: string, extra: Partial<TimelineChoice> = {}): TimelineChoice => ({ title: "History", colour: 2, size: "standard", events: parseEventLines(text).events, ...extra });

describe("dates (#148)", () => {
	it("reads plain years, BC and AD in the usual spellings", () => {
		expect(pos("1492")).toBe(1492);
		expect(pos("1492 AD")).toBe(1492);
		expect(pos("AD 1492")).toBe(1492);
		expect(pos("1492 d.C.")).toBe(1492);
		expect(pos("44 BC")).toBe(-43);
		expect(pos("44BC")).toBe(-43);
		expect(pos("44 B.C.")).toBe(-43);
		expect(pos("44 a.C.")).toBe(-43);
		expect(pos("44 BCE")).toBe(-43);
		expect(pos("BC 44")).toBe(-43);
		expect(pos("-44")).toBe(-43);
		expect(pos("1 BC")).toBe(0);
		expect(pos("1 AD")).toBe(1);
		expect(pos("c. 1500")).toBe(1500);
		expect(pos("circa 1500")).toBe(1500);
		expect(pos("ca. 500 a.C.")).toBe(-499);
	});

	it("has no year 0 and refuses nonsense", () => {
		for (const bad of ["", "0", "0 BC", "hello", "44 BC AD", "-44 BC", "1492 Columbus", "13/13/1492", "century", "5th", "99999999"]) expect(parseTimelineDate(bad), bad).toBeNull();
	});

	it("puts a year BC and the next year AD one year apart", () => {
		expect(pos("1 AD")! - pos("1 BC")!).toBe(1);
		expect(pos("10 BC")! - pos("11 BC")!).toBe(1);
	});

	it("reads centuries in Arabic and Roman numerals, BC and AD", () => {
		expect(pos("5th century")).toBe(450.5);
		expect(pos("1st century")).toBe(50.5);
		expect(pos("21st century")).toBe(2050.5);
		expect(pos("5th century BC")).toBe(-449.5);
		expect(pos("V secolo a.C.")).toBe(-449.5);
		expect(pos("XV secolo")).toBe(1450.5);
		expect(pos("il XIX secolo")).toBe(1850.5);
		expect(pos("sec. XX")).toBe(1950.5);
		expect(pos("2nd c. BC")).toBe(-149.5);
		expect(pos("century 3")).toBe(250.5);
		expect(parseTimelineDate("5th century BC")?.kind).toBe("century");
		expect(parseTimelineDate("IIII secolo")).toBeNull();
		expect(parseTimelineDate("100th century")).toBeNull();
	});

	it("reads decades, ranges and calendar dates", () => {
		expect(pos("1960s")).toBe(1964.5);
		expect(parseTimelineDate("490s BC")).toBeNull();
		expect(pos("1914-1918")).toBe(1916);
		expect(pos("1914-18")).toBe(1916);
		expect(pos("1914 – 1918")).toBe(1916);
		expect(pos("490-479 BC")).toBe((-489 + -478) / 2);
		const iso = pos("1789-07-14")!;
		expect(iso).toBeGreaterThan(1789.5);
		expect(iso).toBeLessThan(1789.6);
		expect(pos("14/07/1789")).toBe(iso);
		expect(pos("14 July 1789")).toBe(iso);
		expect(pos("14 luglio 1789")).toBe(iso);
		expect(pos("July 1789")).toBeLessThan(iso);
		expect(pos("May 1945")!).toBeGreaterThan(1945.3);
		expect(pos("1 gennaio 2000")).toBe(2000);
		expect(parseTimelineDate("14 July 1789")?.kind).toBe("day");
	});

	it("Roman numerals are checked", () => {
		expect(romanValue("xiv")).toBe(14);
		expect(romanValue("xcix")).toBe(99);
		expect(romanValue("iiii")).toBeNull();
		expect(romanValue("vx")).toBeNull();
		expect(romanValue("")).toBeNull();
	});

	it("labels a tick with the year, or the year and BC", () => {
		expect(yearLabel(1492, "BC")).toBe("1492");
		expect(yearLabel(-500, "BC")).toBe("500 BC");
		expect(yearLabel(-500, "a.C.")).toBe("500 a.C.");
	});
});

describe("event lines (#148)", () => {
	it("splits a line at the longest date at its start", () => {
		expect(splitEventLine("1492: Columbus")).toMatchObject({ dateText: "1492", label: "Columbus" });
		expect(splitEventLine("1492 Columbus sails")).toMatchObject({ dateText: "1492", label: "Columbus sails" });
		expect(splitEventLine("44 BC Caesar killed")).toMatchObject({ dateText: "44 BC", label: "Caesar killed" });
		expect(splitEventLine("44 BC - Caesar killed")).toMatchObject({ dateText: "44 BC", label: "Caesar killed" });
		expect(splitEventLine("5th century BC, Pericles")).toMatchObject({ dateText: "5th century BC", label: "Pericles" });
		expect(splitEventLine("1914 - 1918: Great War")).toMatchObject({ dateText: "1914 - 1918", label: "Great War" });
		expect(splitEventLine("14 July 1789 | Bastille")).toMatchObject({ dateText: "14 July 1789", label: "Bastille" });
		expect(splitEventLine("476")).toMatchObject({ dateText: "476", label: "" });
		expect(splitEventLine("Columbus 1492")).toBeNull();
		expect(splitEventLine("no date here")).toBeNull();
	});

	it("reads a list in time order and reports lines it does not understand", () => {
		const r = parseEventLines("1969: Moon\n\nsome words\n753 BC: Rome\n1492: Columbus");
		expect(r.events.map((e) => e.dateText)).toEqual(["753 BC", "1492", "1969"]);
		expect(r.problems).toEqual([{ line: 3, text: "some words", reason: "date" }]);
		expect(r.dropped).toBe(0);
	});

	it("keeps the order of events on the same date", () => {
		const r = parseEventLines("1500: b\n1500: a\n1400: c");
		expect(r.events.map((e) => e.label)).toEqual(["c", "b", "a"]);
	});

	it("limits the number of events and the length of a label", () => {
		const many = Array.from({ length: MAX_EVENTS + 3 }, (_, i) => `${1000 + i}: e${i}`).join("\n");
		const r = parseEventLines(many);
		expect(r.events).toHaveLength(MAX_EVENTS);
		expect(r.dropped).toBe(3);
		const long = parseEventLines(`1900: ${"x".repeat(170)}`);
		expect(long.events).toHaveLength(0);
		expect(long.problems[0]?.reason).toBe("long");
		expect(parseEventLines(`1900: ${"x".repeat(400)}`).problems[0]?.reason).toBe("long");
	});

	it("writes an event into a label box and reads it back", () => {
		const e = parseEventLines("44 BC: Caesar  killed").events[0]!;
		expect(eventText(e)).toBe("44 BC\nCaesar killed");
		expect(eventFromText(eventText(e))).toEqual(e);
		expect(eventFromText("1492")).toEqual({ dateText: "1492", label: "", pos: 1492 });
		expect(eventFromText("oops\nlabel")).toBeNull();
		expect(eventFromText("1492\nline one\nline two")?.label).toBe("line one line two");
	});
});

describe("spacing (#148)", () => {
	it("spaces events in proportion to the time between them", () => {
		const events = parseEventLines("1000: a\n1100: b\n1400: c").events;
		const l = layoutTimeline(events, { title: "", colour: "#112233", labels }, 440);
		const dots = l.shapes.filter((s) => s.type === "circle").map((s) => (s as { cx: number }).cx);
		expect(dots).toHaveLength(3);
		expect((dots[1]! - dots[0]!) / (dots[2]! - dots[1]!)).toBeCloseTo(1 / 3, 1);
		expect(l.compressed).toBe(0);
	});

	it("compresses a gap that is more than four times all the others and says its length", () => {
		expect([...compressedGaps([-3000, 1900, 1914, 1945])]).toEqual([0]);
		expect(compressedGaps([1000, 1010, 2000]).has(1)).toBe(true);
		expect(compressedGaps([-752, -508, -43, 1492]).size).toBe(0);
		expect(compressedGaps([1, 5]).size).toBe(0); // one gap is never compressed
		expect(compressedGaps([1, 2, 3, 4]).size).toBe(0);
		const events = parseEventLines("3000 BC: a\n1900: b\n1914: c\n1945: d").events;
		const l = layoutTimeline(events, { title: "", colour: "#112233", labels }, 440);
		expect(l.compressed).toBe(1);
		expect(l.texts.some((t) => t.text === "4900 years" || t.text === `${Math.round(1900 - -2999)} years`)).toBe(true);
		const dots = l.shapes.filter((s) => s.type === "circle").map((s) => (s as { cx: number }).cx);
		// the three close events are no longer squeezed onto one spot
		expect(dots[2]! - dots[1]!).toBeGreaterThan(5);
		expect(l.shapes.some((s) => s.type === "poly" && s.dash === "dashed")).toBe(true);
	});

	it("draws ticks only on the proportional parts, labelled with BC for negative years", () => {
		const events = parseEventLines("800 BC: a\n100 AD: b\n1000: c").events;
		const l = layoutTimeline(events, { title: "", colour: "#112233", labels }, 440);
		const tickLabels = l.texts.filter((t) => t.size === 8).map((t) => t.text);
		expect(tickLabels.length).toBeGreaterThan(1);
		expect(tickLabels.some((t) => /BC$/.test(t))).toBe(true);
		expect(tickLabels.every((t) => /^\d+( BC)?$/.test(t))).toBe(true);
	});

	it("niceStep gives 1, 2 or 5 times a power of ten", () => {
		expect(niceStep(0.2)).toBe(1);
		expect(niceStep(1.1)).toBe(2);
		expect(niceStep(3)).toBe(5);
		expect(niceStep(60)).toBe(100);
		expect(niceStep(200)).toBe(200);
	});

	it("puts a lone date, and dates on the same day, on a sensible axis", () => {
		const one = layoutTimeline(parseEventLines("1492: Columbus").events, { title: "", colour: "#112233", labels }, 440);
		expect(one.shapes.filter((s) => s.type === "circle")).toHaveLength(1);
		const same = layoutTimeline(parseEventLines("1500: a\n1500: b\n1500: c").events, { title: "", colour: "#112233", labels }, 440);
		expect(same.texts.filter((t) => t.size === EVENT_SIZE)).toHaveLength(3);
	});
});

describe("labels do not overlap (#148)", () => {
	const boxesOf = (text: string, width = 440) => {
		const l = layoutTimeline(parseEventLines(text).events, { title: "", colour: "#112233", labels }, width);
		const boxes = l.texts.filter((t) => t.size === EVENT_SIZE).map((t) => ({ x0: t.x, x1: t.x + t.width, y0: t.y, y1: t.y + t.lines.length * EVENT_SIZE * 1.25, text: t.text }));
		return { l, boxes };
	};
	const touch = (a: { x0: number; x1: number; y0: number; y1: number }, b: typeof a): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

	it("alternates above and below the axis when labels are wide apart", () => {
		const { l, boxes } = boxesOf(EVENTS, 579);
		const above = boxes.filter((b) => b.y1 <= l.axisY).length;
		expect(above).toBeGreaterThan(0);
		expect(boxes.length - above).toBeGreaterThan(0);
	});

	it("never lets two labels touch, however crowded", () => {
		const crowded = Array.from({ length: 16 }, (_, i) => `${1900 + (i % 5)}: Event number ${i} with a longer label`).join("\n");
		for (const text of [EVENTS, crowded, "1500: a\n1500: b\n1500: c\n1500: d", "1000: a\n1001: b\n1002: c\n3000: d"]) {
			const { l, boxes } = boxesOf(text);
			for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(touch(boxes[i]!, boxes[j]!), `${text.slice(0, 20)} ${i} ${j}`).toBe(false);
			for (const b of boxes) {
				expect(b.x0).toBeGreaterThanOrEqual(0);
				expect(b.x1).toBeLessThanOrEqual(l.width + 0.01);
				expect(b.y0).toBeGreaterThanOrEqual(0);
				expect(b.y1).toBeLessThanOrEqual(l.height + 0.01);
			}
		}
	});

	it("never lets a pole cross another label", () => {
		const crowded = Array.from({ length: 12 }, (_, i) => `${1900 + (i % 4) * 3}: Event ${i} with a label`).join("\n");
		const { l, boxes } = boxesOf(crowded);
		const poles = l.shapes.filter((s) => s.type === "poly" && s.width === 1.2) as Array<{ vertices: Array<readonly [number, number]> }>;
		expect(poles).toHaveLength(12);
		for (const p of poles) {
			const [a, b] = p.vertices as [readonly [number, number], readonly [number, number]];
			const x = a[0];
			const y0 = Math.min(a[1], b[1]);
			const y1 = Math.max(a[1], b[1]);
			// its own label starts 4 pt to the right of the pole and touches the pole's far end: every other label must miss the pole
			const crossing = boxes.filter((bx) => bx.x0 < x && x < bx.x1 && bx.y0 < y1 - 0.01 && y0 + 0.01 < bx.y1);
			expect(crossing).toHaveLength(0);
		}
	});

	it("keeps the title in the block and above the labels", () => {
		const l = layoutTimeline(parseEventLines(EVENTS).events, { title: "Ancient and modern", colour: "#112233", labels }, 440);
		const title = l.texts.find((t) => t.size === 13)!;
		expect(title.text).toBe("Ancient and modern");
		for (const t of l.texts.filter((t) => t.size === EVENT_SIZE)) expect(t.y).toBeGreaterThanOrEqual(title.y + 16);
	});

	it("is deterministic", () => {
		const a = layoutTimeline(parseEventLines(EVENTS).events, { title: "T", colour: "#112233", labels }, 440);
		const b = layoutTimeline(parseEventLines(EVENTS).events, { title: "T", colour: "#112233", labels }, 440);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(BOX_W).toBe(92);
	});
});

describe("timeline strokes and text boxes (#148)", () => {
	it("is built from shape strokes and text boxes of one group", () => {
		const { page } = setup();
		const plan = planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		expect(plan.strokes.every((s) => s.tool === "shape" && s.group === plan.group)).toBe(true);
		expect(plan.elements.every((e) => e.type === "text" && e.group === plan.group)).toBe(true);
		expect(plan.strokes.filter((s) => s.fill !== undefined)).toHaveLength(5);
		expect(plan.elements.filter((e) => e.fontSize === EVENT_SIZE)).toHaveLength(5);
		expect(plan.elements.some((e) => e.text === "History")).toBe(true);
		expect(parseTimelineGroup(plan.group)).toMatchObject({ colour: 2 });
		expect(plan.group.length).toBeLessThanOrEqual(64);
		// not mistaken for a table
		expect(detectTable(plan.strokes)).toBeNull();
	});

	it("inserts in one undoable step and the document stays valid", () => {
		const { doc, page, history } = setup();
		const plan = planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		const before = { s: page.strokes.length, e: page.elements?.length ?? 0 };
		expect(history.execute(plan.cmd)).toBe(true);
		expect(page.strokes.length).toBe(before.s + plan.strokes.length);
		expect(page.elements!.length).toBe(before.e + plan.elements.length);
		expect(serializeChecked(doc)).toBeTruthy();
		expect(history.undo()).not.toBeNull();
		expect(page.strokes.length).toBe(before.s);
		expect(page.elements?.length ?? 0).toBe(before.e);
		expect(history.redo()).not.toBeNull();
		expect(page.strokes.length).toBe(before.s + plan.strokes.length);
		expect(LABELS["Insert timeline"]).toBeTruthy();
		expect(LABELS["Update timeline"]).toBeTruthy();
	});

	it("is a step local to its page for per-page undo, inserted and edited", () => {
		const { page, history } = setup();
		history.setPageRules(pageRules);
		const plan = planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		const scope = pageScope(plan.cmd);
		expect(scope.local).toBe(true);
		expect([...scope.pages]).toEqual([page.id]);
		expect(scope.registers).toEqual([]);
		history.execute(plan.cmd);
		const tl = timelineOfSelection(page.strokes.filter((s) => s.group === plan.group), page.elements!.filter((e) => e.group === plan.group))!;
		const upd = planTimelineUpdate(page, tl, choiceOf(`${EVENTS}\n1066: Hastings`, { size: "keep" }), page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(`update ${upd.reason}`);
		const s2 = pageScope(upd.cmd);
		expect(s2.local).toBe(true);
		expect([...s2.pages]).toEqual([page.id]);
	});

	it("is kept inside the page, and refused when it cannot fit", () => {
		const { page } = setup();
		const corner = planTimelineInsert(page, choiceOf(EVENTS), { x: 0, y: 0 }, labels, undefined, ids);
		if (!corner.ok) throw new Error("plan");
		const xs = corner.strokes.flatMap((s) => s.points.map((p) => p[0]));
		const ys = corner.strokes.flatMap((s) => s.points.map((p) => p[1]));
		expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
		expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
		const far = planTimelineInsert(page, choiceOf(EVENTS), { x: 9999, y: 9999 }, labels, undefined, ids);
		if (!far.ok) throw new Error("plan");
		expect(Math.max(...far.strokes.flatMap((s) => s.points.map((p) => p[0])))).toBeLessThanOrEqual(page.width);
		expect(Math.max(...far.strokes.flatMap((s) => s.points.map((p) => p[1])))).toBeLessThanOrEqual(page.height);
		for (const e of far.elements) expect(e.x + e.width).toBeLessThanOrEqual(page.width + 0.01);
		const narrow = { ...page, width: 200 };
		expect(planTimelineInsert(narrow, choiceOf(EVENTS), { x: 100, y: 100 }, labels)).toEqual({ ok: false, reason: "edge" });
		const short = { ...page, height: 120 };
		expect(planTimelineInsert(short, choiceOf(EVENTS), { x: 100, y: 60 }, labels)).toEqual({ ok: false, reason: "edge" });
		expect(planTimelineInsert({ ...short, infinite: true }, choiceOf(EVENTS), { x: 100, y: 60 }, labels).ok).toBe(true);
		expect(planTimelineInsert(page, choiceOf(""), { x: 100, y: 100 }, labels)).toEqual({ ok: false, reason: "noEvents" });
	});

	it("is refused when it would touch a redaction box, or the boxes cannot be read", () => {
		const { page } = setup();
		const where = planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, undefined, ids);
		if (!where.ok) throw new Error("plan");
		const x = where.strokes[0]!.points[0]![0];
		const y = where.strokes[0]!.points[0]![1];
		const over = { boxes: [{ x: x + 20, y: y - 4, width: 30, height: 8 }] };
		expect(planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, over)).toEqual({ ok: false, reason: "redacted" });
		expect(planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, { boxes: [], unreadable: true })).toEqual({ ok: false, reason: "redacted" });
		expect(planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, { boxes: [{ x: 0, y: 0, width: 20, height: 20 }] }).ok).toBe(true);
		expect(planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, { boxes: [] }).ok).toBe(true);
	});

	it("gets a fresh group id when copied, which drops the link", () => {
		const { page } = setup();
		const plan = planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		const rename = groupRenamer(() => "fresh");
		expect(parseTimelineGroup(rename(plan.group))).toBeNull();
		expect(parseTimelineGroup("nbt1.9.x")).toBeNull();
		expect(parseTimelineGroup("nbt1.2")).toBeNull();
		expect(parseTimelineGroup(undefined)).toBeNull();
		expect(parseTimelineGroup(timelineGroupId(3, "abcd1234"))).toEqual({ colour: 3, random: "abcd1234" });
	});

	it("recognises a selection that is exactly one timeline", () => {
		const { page } = setup();
		const plan = planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: 300 }, labels, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		expect(timelineOfSelection(plan.strokes, plan.elements)?.group).toBe(plan.group);
		expect(timelineOfSelection(plan.strokes, [])?.group).toBe(plan.group);
		expect(timelineOfSelection([], plan.elements)).toBeNull();
		expect(timelineOfSelection([...plan.strokes, { ...plan.strokes[0]!, id: "x", group: "other" }], plan.elements)).toBeNull();
		expect(timelineOfSelection(plan.strokes, [...plan.elements, { ...plan.elements[0]!, id: "y", group: undefined }])).toBeNull();
	});
});

describe("edit timeline (#148)", () => {
	function made(extra: Partial<TimelineChoice> = {}) {
		const { doc, page, history } = setup();
		const plan = planTimelineInsert(page, choiceOf(EVENTS, extra), { x: 300, y: 300 }, labels, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		expect(history.execute(plan.cmd)).toBe(true);
		const tl = () => timelineOfSelection(page.strokes.filter((s) => s.group === plan.group), page.elements!.filter((e) => e.group === plan.group))!;
		return { doc, page, history, plan, tl };
	}

	it("reads the title, the events and the colour back from the group", () => {
		const { tl } = made();
		const draft = readTimeline(tl());
		if (typeof draft === "string") throw new Error(draft);
		expect(draft.title).toBe("History");
		expect(draft.colour).toBe(2);
		expect(draft.text.split("\n")).toEqual(["753 BC: Rome founded", "44 BC: Caesar killed", "476: Fall of the Western Empire", "1492: Columbus", "1969: Moon landing"]);
		expect(draft.width).toBeCloseTo(timelineWidth("standard", 595)!, 1);
		expect(parseEventLines(draft.text).events).toEqual(parseEventLines(EVENTS).events);
	});

	it("an edit with nothing changed says so and changes nothing", () => {
		const { page, tl } = made();
		const draft = readTimeline(tl());
		if (typeof draft === "string") throw new Error(draft);
		const same = planTimelineUpdate(page, tl(), { title: draft.title, colour: draft.colour, size: "keep", events: parseEventLines(draft.text).events }, page.strokes, labels, undefined, ids);
		expect(same).toEqual({ ok: false, reason: "same" });
	});

	it("replaces the timeline in the same place with the new events, in one undo step", () => {
		const { doc, page, history, plan, tl } = made();
		const oldPoints = JSON.stringify(plan.strokes.map((s) => s.points));
		const first = plan.strokes[0]!.points[0]!;
		const before = { s: page.strokes.length, e: page.elements!.length };
		const upd = planTimelineUpdate(page, tl(), choiceOf(`${EVENTS}\n1066: Battle of Hastings`, { size: "keep" }), page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(upd.reason);
		expect(history.execute(upd.cmd)).toBe(true);
		const now = tl();
		expect(now.elements.filter((e) => e.type === "text" && e.fontSize === EVENT_SIZE)).toHaveLength(6);
		expect(page.strokes.length).toBe(before.s + (upd.strokes.length - plan.strokes.length));
		expect(upd.group).toBe(plan.group);
		// the axis starts where it started, at the same height
		expect(now.strokes[0]!.points[0]![0]).toBeCloseTo(first[0], 1);
		expect(now.strokes[0]!.points[0]![1]).toBeCloseTo(first[1], 1);
		expect(serializeChecked(doc)).toBeTruthy();
		expect(history.undo()).not.toBeNull();
		expect(JSON.stringify(tl().strokes.map((s) => s.points))).toBe(oldPoints);
		expect(page.strokes.length).toBe(before.s);
		expect(page.elements!.length).toBe(before.e);
		expect(history.redo()).not.toBeNull();
		expect(tl().elements.filter((e) => e.type === "text" && e.fontSize === EVENT_SIZE)).toHaveLength(6);
	});

	it("keeps the z-order slot of the old timeline", () => {
		const { page, history, plan, tl } = made();
		const over = { id: "over", tool: "pen" as const, color: "#000000", width: 2, render: 1 as const, points: [[10, 10, 0.5]] as Array<[number, number, number]> };
		page.strokes.push(over);
		const upd = planTimelineUpdate(page, tl(), choiceOf(`${EVENTS}\n1066: Hastings`, { size: "keep" }), page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(upd.reason);
		history.execute(upd.cmd);
		expect(page.strokes.indexOf(over as never)).toBe(page.strokes.length - 1);
		expect(page.strokes.slice(0, upd.strokes.length).every((s) => s.group === plan.group)).toBe(true);
	});

	it("an edited label moves its dot on the next edit", () => {
		const { page, history, tl } = made();
		const box = page.elements!.find((e): e is TextElement => e.type === "text" && e.text.startsWith("1492"))!;
		page.elements![page.elements!.indexOf(box)] = { ...box, text: "1500\nColumbus, again" };
		const draft = readTimeline(tl());
		if (typeof draft === "string") throw new Error(draft);
		expect(draft.text).toContain("1500: Columbus, again");
		const upd = planTimelineUpdate(page, tl(), { title: draft.title, colour: draft.colour, size: "keep", events: parseEventLines(draft.text).events }, page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(upd.reason);
		expect(history.execute(upd.cmd)).toBe(true);
		expect(tl().elements.some((e) => e.type === "text" && e.text === "1500\nColumbus, again")).toBe(true);
	});

	it("keeps a line whose date is no longer understood so the dialog can show it", () => {
		const { page, tl } = made();
		const box = page.elements!.find((e): e is TextElement => e.type === "text" && e.text.startsWith("1492"))!;
		page.elements![page.elements!.indexOf(box)] = { ...box, text: "soon\nColumbus" };
		const draft = readTimeline(tl());
		if (typeof draft === "string") throw new Error(draft);
		expect(draft.text).toContain("soon: Columbus");
		expect(parseEventLines(draft.text).problems).toHaveLength(1);
	});

	it("changes the colour in the group id and the title", () => {
		const { page, history, plan, tl } = made();
		const upd = planTimelineUpdate(page, tl(), choiceOf(EVENTS, { colour: 5, title: "", size: "keep" }), page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(upd.reason);
		expect(upd.group).not.toBe(plan.group);
		expect(parseTimelineGroup(upd.group)).toMatchObject({ colour: 5 });
		expect(upd.group.length).toBeLessThanOrEqual(64);
		history.execute(upd.cmd);
		expect(page.strokes.some((s) => s.group === plan.group)).toBe(false);
		expect(upd.elements.some((e) => e.fontSize === 13)).toBe(false);
	});

	it("changes the size when asked", () => {
		const { page, tl } = made();
		const upd = planTimelineUpdate(page, tl(), choiceOf(EVENTS, { size: "wide" }), page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(upd.reason);
		const xs = upd.strokes.flatMap((s) => s.points.map((p) => p[0]));
		expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(400);
	});

	it("is refused for every reason it cannot be done, and changes nothing", () => {
		const { page, plan, tl } = made();
		const choice = choiceOf(`${EVENTS}\n1066: Hastings`, { size: "keep" });
		const before = JSON.stringify([page.strokes, page.elements]);
		// stale selection
		const stale = tl();
		expect(planTimelineUpdate(page, { ...stale, strokes: stale.strokes.slice(1) }, choice, page.strokes, labels)).toEqual({ ok: false, reason: "gone" });
		// out of view
		expect(planTimelineUpdate(page, tl(), choice, page.strokes.slice(2), labels)).toEqual({ ok: false, reason: "gone" });
		// nothing to draw
		expect(planTimelineUpdate(page, tl(), choiceOf("", { size: "keep" }), page.strokes, labels)).toEqual({ ok: false, reason: "noEvents" });
		// locked box
		const label = page.elements![0] as TextElement;
		const original = { ...label };
		page.elements![0] = { ...label, locked: true };
		expect(planTimelineUpdate(page, tl(), choice, page.strokes, labels)).toEqual({ ok: false, reason: "locked" });
		page.elements![0] = original;
		// a drawing with states
		page.states = { parts: [{ id: "p", items: [plan.strokes[0]!.id] }] } as never;
		expect(planTimelineUpdate(page, tl(), choice, page.strokes, labels)).toEqual({ ok: false, reason: "states" });
		delete page.states;
		// a resized text box
		page.elements![0] = { ...original, fontSize: 14 };
		expect(planTimelineUpdate(page, tl(), choice, page.strokes, labels)).toEqual({ ok: false, reason: "unreadable" });
		page.elements![0] = original;
		// redaction
		const first = plan.strokes[0]!.points[0]!;
		expect(planTimelineUpdate(page, tl(), choice, page.strokes, labels, { boxes: [{ x: first[0] + 30, y: first[1] - 3, width: 10, height: 6 }] })).toEqual({ ok: false, reason: "redacted" });
		expect(planTimelineUpdate(page, tl(), choice, page.strokes, labels, { boxes: [], unreadable: true })).toEqual({ ok: false, reason: "redacted" });
		// leaving the page
		const wide = { ...page, width: 200 };
		expect(planTimelineUpdate(wide, tl(), choiceOf(EVENTS, { size: "wide" }), page.strokes, labels)).toEqual({ ok: false, reason: "edge" });
		expect(JSON.stringify([page.strokes, page.elements])).toBe(before);
	});

	it("an edit that grows the timeline over the bottom edge is refused", () => {
		const { page } = setup();
		const plan = planTimelineInsert(page, choiceOf(EVENTS), { x: 300, y: page.height - 60 }, labels, undefined, ids);
		if (!plan.ok) throw new Error("plan");
		page.strokes.push(...plan.strokes);
		page.elements = [...(page.elements ?? []), ...plan.elements];
		const tl = timelineOfSelection(plan.strokes, plan.elements)!;
		const crowded = Array.from({ length: 12 }, (_, i) => `1900: Event ${i} with a long enough label to take lines`).join("\n");
		const upd = planTimelineUpdate(page, tl, choiceOf(crowded, { size: "keep" }), page.strokes, labels);
		expect(upd.ok).toBe(false);
	});

	it("sameTimeline ignores ids and tiny differences only", () => {
		const { plan } = made();
		const twin = buildTimeline(layoutTimeline(parseEventLines(EVENTS).events, { title: "History", colour: plan.strokes.find((s) => s.fill)!.color, labels }, timelineWidth("standard", 595)!), plan.group, { x: 0, y: 0 }, ids);
		expect(sameTimeline(plan.strokes, plan.elements, plan.strokes, plan.elements)).toBe(true);
		expect(sameTimeline(plan.strokes, plan.elements, twin.strokes, twin.elements)).toBe(false); // another place
		const moved = plan.elements.map((e) => ({ ...e, x: e.x + 1 }));
		expect(sameTimeline(plan.strokes, plan.elements, plan.strokes, moved)).toBe(false);
	});

	it("nearestSize picks the size a block has", () => {
		expect(nearestSize(timelineWidth("compact", 595)!, 595)).toBe("compact");
		expect(nearestSize(timelineWidth("wide", 595)!, 595)).toBe("wide");
		expect(nearestSize(440, 595)).toBe("standard");
	});

	// --- review 0.30 ---

	it("I4: an edit whose lines would be left out must be fixed first (nothing is dropped silently)", () => {
		expect(editNeedsFixing(parseEventLines(EVENTS))).toBe(false);
		expect(editNeedsFixing(parseEventLines(`${EVENTS}\nsoon: Columbus`))).toBe(true);
		expect(editNeedsFixing(parseEventLines(`1492: ${"x".repeat(170)}`))).toBe(true);
		expect(editNeedsFixing(parseEventLines(Array.from({ length: MAX_EVENTS + 1 }, (_, i) => `${1000 + i}: e`).join("\n")))).toBe(true);
		// the draft of a box that was typed over keeps its line, so the dialog shows it and holds the button
		const { page, tl } = made();
		const box = page.elements!.find((e): e is TextElement => e.type === "text" && e.text.startsWith("1492"))!;
		page.elements![page.elements!.indexOf(box)] = { ...box, text: "somewhere around then\nColumbus" };
		const draft = readTimeline(tl());
		if (typeof draft === "string") throw new Error(draft);
		expect(editNeedsFixing(parseEventLines(draft.text))).toBe(true);
	});

	it("I5: the edit keeps the ids of what survives, as replacements", () => {
		const { page, history, plan, tl } = made();
		const upd = planTimelineUpdate(page, tl(), choiceOf(`${EVENTS}\n1066: Battle of Hastings`, { size: "keep" }), page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(upd.reason);
		// every old stroke and every event label lives on under its id (a tick label that is no longer needed may go)
		const oldIds = [...plan.strokes, ...plan.elements.filter((e) => e.fontSize === EVENT_SIZE)].map((i) => i.id);
		const newIds = [...upd.strokes, ...upd.elements].map((i) => i.id);
		expect(oldIds.every((id) => newIds.includes(id))).toBe(true);
		expect(new Set(newIds).size).toBe(newIds.length);
		expect(history.execute(upd.cmd)).toBe(true);
		expect(new Set([...page.strokes, ...page.elements!].map((i) => i.id)).size).toBe(page.strokes.length + page.elements!.length);
	});

	it("I5: a smaller edit and its Undo and Redo put every item back where it was", () => {
		const { page, history, tl } = made();
		const snap = () => JSON.stringify([page.strokes, page.elements]);
		const before = snap();
		const upd = planTimelineUpdate(page, tl(), choiceOf("44 BC: Caesar killed\n1492: Columbus", { size: "keep" }), page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(upd.reason);
		history.execute(upd.cmd);
		const after = snap();
		expect(after).not.toBe(before);
		expect(history.undo()).not.toBeNull();
		expect(snap()).toBe(before);
		expect(history.redo()).not.toBeNull();
		expect(snap()).toBe(after);
	});

	it("I5: after a box is drawn over a moved label, Undo cannot bring the label out from under it", () => {
		const { page, history, plan, tl } = made();
		const boxes: RedactBox[] = [];
		const refused: string[] = [];
		history.setStepCheck(redactStepCheck(() => ({ boxesOf: () => boxes, unreadable: false, any: boxes.length > 0 }), (step) => refused.push(step)));
		const upd = planTimelineUpdate(page, tl(), choiceOf(`${EVENTS}\n1066: Battle of Hastings`, { size: "keep" }), page.strokes, labels, undefined, ids);
		if (!upd.ok) throw new Error(upd.reason);
		expect(history.execute(upd.cmd)).toBe(true);
		// a label that moved by the edit (the same box, another place)
		const moved = upd.elements.find((e) => {
			const old = plan.elements.find((o) => o.id === e.id);
			return old !== undefined && (Math.abs(old.x - e.x) > 4 || Math.abs(old.y - e.y) > 4);
		});
		expect(moved).toBeDefined();
		const old = plan.elements.find((o) => o.id === moved!.id) as TextElement;
		const r = redactBounds(moved!);
		boxes.push({ x: r.minX, y: r.minY, width: r.maxX - r.minX, height: r.maxY - r.minY });
		const snap = JSON.stringify([page.strokes, page.elements]);
		expect(history.undo()).toBeNull();
		expect(refused).toEqual(["undo"]);
		expect(JSON.stringify([page.strokes, page.elements])).toBe(snap);
		expect(page.elements!.some((e) => e.id === old.id && (e as TextElement).x === moved!.x)).toBe(true);
	});

	it("I6: refuses to rewrite a timeline whose old or new items lie under a study tape", () => {
		const { page, tl } = made();
		const choice = choiceOf(`${EVENTS}\n1066: Hastings`, { size: "keep" });
		const label = page.elements!.find((e): e is TextElement => e.type === "text" && e.fontSize === EVENT_SIZE)!;
		const tape = { id: "tape1", type: "tape" as const, x: label.x - 2, y: label.y - 2, width: 40, height: 14, color: "#ffd54a" };
		page.elements!.push(tape);
		const before = JSON.stringify([page.strokes, page.elements]);
		expect(planTimelineUpdate(page, tl(), choice, page.strokes, labels)).toEqual({ ok: false, reason: "tape" });
		expect(JSON.stringify([page.strokes, page.elements])).toBe(before);
		// a tape far away is no obstacle
		page.elements![page.elements!.indexOf(tape)] = { ...tape, x: 5, y: 760, width: 20, height: 10 };
		expect(planTimelineUpdate(page, tl(), choice, page.strokes, labels).ok).toBe(true);
	});

	it("I9: the place of an edit follows the axis, not the first stroke in page order", () => {
		const { page, tl } = made();
		const before = readTimeline(tl());
		const [axis] = page.strokes.splice(0, 1);
		page.strokes.push(axis!);
		expect(readTimeline(tl())).toEqual(before);
	});
});
