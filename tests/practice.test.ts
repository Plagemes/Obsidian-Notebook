import { describe, expect, it } from "vitest";
import { AddPage, History } from "../src/model/history";
import { createDocument, createStroke, createPage } from "../src/model/document";
import {
	applyPracticeOp, attemptFromTags, attemptsOf, attemptTag, buildPracticePage, elapsedSeconds, emptyPractice, exercisesName,
	formatAttemptDate, formatDuration, hasPracticeTag, hidesAll, inkColours, inkTools, insertIndexAfter, newRecord, nextAttemptNumber,
	normalizeHideSpec, parsePracticePrefs, parsePractice, peekStrokes, practiceTags, PRACTICE_FORMAT, recordOf, serializePractice, splitInk, totalSeconds,
	type AttemptRecord, type PracticeData,
} from "../src/model/practice";
import { parse, serialize } from "../src/model/serialize";
import { PracticeBlockedError, PRACTICE_FILE, PracticeStore } from "../src/storage/practice-store";
import type { LinkFileAdapter } from "../src/storage/pdf-links-store";
import type { Page, Point, Tool } from "../src/model/types";

const pts: Point[] = [[10, 10, 0.5], [20, 20, 0.5]];
const stroke = (color: string, tool: Tool = "pen") => createStroke(color, 2, pts.map((p) => [...p] as Point), tool);

function exercisePage(): Page {
	const page = createPage();
	page.strokes = [stroke("#1e1e1e"), stroke("#ff0000"), stroke("#FF0000", "highlighter"), stroke("#0000ff", "highlighter"), stroke("#1e1e1e", "shape")];
	page.elements = [{ id: "t1", type: "text", x: 10, y: 10, width: 100, text: "Exercise 3", fontSize: 14, color: "#000000" }];
	page.background = { kind: "pdf", asset: "a".repeat(24), page: 4 };
	page.margins = { left: 100, right: 0, bottom: 0 };
	page.tags = ["maths", "Practice", "attempt/7"];
	return page;
}

describe("hide specs", () => {
	it("no criterion hides every stroke", () => {
		const page = exercisePage();
		const { hidden, kept } = splitInk(page.strokes, {});
		expect(hidden.length).toBe(5);
		expect(kept.length).toBe(0);
		expect(hidesAll({})).toBe(true);
		expect(hidesAll({ colors: ["#ff0000"] })).toBe(false);
	});

	it("colours and tools combine (a stroke must match both), colours ignore case", () => {
		const page = exercisePage();
		expect(splitInk(page.strokes, { colors: ["#ff0000"] }).hidden.length).toBe(2);
		expect(splitInk(page.strokes, { tools: ["highlighter"] }).hidden.length).toBe(2);
		expect(splitInk(page.strokes, { colors: ["#ff0000"], tools: ["highlighter"] }).hidden).toEqual([page.strokes[2]]);
		expect(splitInk(page.strokes, { colors: ["#ff0000", "#0000ff"], tools: ["highlighter"] }).hidden.length).toBe(2);
	});

	it("a region is the stroke ids, and combines with the other criteria", () => {
		const page = exercisePage();
		const ids = [page.strokes[0]!.id, page.strokes[1]!.id];
		expect(splitInk(page.strokes, { strokes: ids }).hidden).toEqual([page.strokes[0], page.strokes[1]]);
		expect(splitInk(page.strokes, { strokes: ids, colors: ["#ff0000"] }).hidden).toEqual([page.strokes[1]]);
		expect(splitInk(page.strokes, { strokes: ["nope"] }).hidden).toEqual([]);
	});

	it("normalisation drops invalid entries and empty criteria", () => {
		expect(normalizeHideSpec({ colors: ["red", "#ABCDEF", "#abcdef", 3], tools: ["pen", "eraser", "pen"], strokes: [] })).toEqual({ colors: ["#abcdef"], tools: ["pen"] });
		expect(normalizeHideSpec(null)).toEqual({});
		expect(normalizeHideSpec({ colors: [] })).toEqual({});
	});

	it("lists the colours and tools of the ink, most used first", () => {
		const page = exercisePage();
		expect(inkColours(page.strokes)).toEqual([
			{ color: "#1e1e1e", count: 2 }, { color: "#ff0000", count: 2 }, { color: "#0000ff", count: 1 },
		]);
		expect(inkTools(page.strokes)).toEqual([{ tool: "pen", count: 2 }, { tool: "highlighter", count: 2 }, { tool: "shape", count: 1 }]);
	});
});

describe("tags", () => {
	it("a copy gets practice and attempt/n and loses older markers", () => {
		expect(practiceTags(["maths", "Practice", "attempt/7"], 2)).toEqual(["maths", "practice", "attempt/2"]);
		expect(practiceTags(undefined, 1)).toEqual(["practice", "attempt/1"]);
	});

	it("reads the attempt number and the marker back", () => {
		expect(attemptFromTags(["x", "attempt/12"])).toBe(12);
		expect(attemptFromTags(["attempt/x"])).toBeNull();
		expect(hasPracticeTag(["PRACTICE"])).toBe(true);
		expect(hasPracticeTag(["attempt/1"])).toBe(false);
		expect(attemptTag(3)).toBe("attempt/3");
	});
});

describe("practice copy", () => {
	it("keeps the background, margins, text boxes and the strokes that are not hidden, with new ids", () => {
		const page = exercisePage();
		const { page: copy, hidden } = buildPracticePage(page, { colors: ["#ff0000"] }, 2);
		expect(hidden).toBe(2);
		expect(copy.strokes.length).toBe(3);
		expect(copy.id).not.toBe(page.id);
		expect(copy.strokes.every((s) => !page.strokes.some((o) => o.id === s.id))).toBe(true);
		expect(copy.strokes.map((s) => s.color.toLowerCase())).toEqual(["#1e1e1e", "#0000ff", "#1e1e1e"]);
		expect(copy.background).toEqual(page.background);
		expect(copy.margins).toEqual(page.margins);
		expect(copy.elements?.length).toBe(1);
		expect(copy.elements?.[0]?.id).not.toBe("t1");
		expect(copy.tags).toEqual(["maths", "practice", "attempt/2"]);
	});

	it("hiding everything leaves a clean exercise sheet; the original is not touched", () => {
		const page = exercisePage();
		const before = JSON.stringify(page);
		const { page: copy, hidden } = buildPracticePage(page, {}, 1);
		expect(hidden).toBe(5);
		expect(copy.strokes).toEqual([]);
		expect(JSON.stringify(page)).toBe(before);
	});

	it("the strokes a copy hides are what the peek shows, in drawing order", () => {
		const page = exercisePage();
		const spec = { tools: ["highlighter" as const] };
		expect(peekStrokes(page, spec)).toEqual([page.strokes[2], page.strokes[3]]);
	});

	it("the copy is a valid page: it survives the file round trip", () => {
		const doc = createDocument(new Date("2026-10-30T08:00:00.000Z"));
		const original = exercisePage();
		original.background = undefined;
		delete original.background;
		delete original.margins;
		doc.pages = [original];
		const { page: copy } = buildPracticePage(original, { colors: ["#ff0000"] }, 1);
		doc.pages.push(copy);
		const back = parse(serialize(doc));
		expect(back.ok).toBe(true);
		if (back.ok) {
			expect(back.doc.pages[1]?.tags).toEqual(["maths", "practice", "attempt/1"]);
			expect(back.doc.pages[1]?.strokes.length).toBe(3);
		}
	});

	it("is one undo step in the target", () => {
		const doc = createDocument(new Date("2026-10-30T08:00:00.000Z"));
		const history = new History(() => doc);
		const { page } = buildPracticePage(exercisePage(), {}, 1);
		history.execute(new AddPage(page, 1));
		expect(doc.pages.length).toBe(2);
		history.undo();
		expect(doc.pages.length).toBe(1);
		history.redo();
		expect(doc.pages[1]).toBe(page);
	});
});

const rec = (practice: string, original: string, n: number, at: string, extra: Partial<AttemptRecord> = {}): AttemptRecord => ({
	practice: { doc: "docP", page: practice }, original: { doc: "docO", page: original }, n, at, hide: { colors: ["#ff0000"] }, ...extra,
});
const withAttempts = (...attempts: AttemptRecord[]): PracticeData => ({ ...emptyPractice(), attempts });

describe("practice file", () => {
	it("round-trips and its text does not depend on the order of the attempts", () => {
		const a = rec("p1", "o1", 1, "2026-10-30T08:00:00.000Z", { seconds: 90 });
		const b = rec("p2", "o1", 2, "2026-10-31T08:00:00.000Z", { hide: {}, original: { doc: "docO", page: "o1", path: "Notebooks/A.notebook" } });
		const c = rec("p3", "o0", 1, "2026-10-29T08:00:00.000Z");
		const text = serializePractice(withAttempts(a, b, c));
		expect(serializePractice(withAttempts(c, b, a))).toBe(text);
		expect(text).toContain(PRACTICE_FORMAT);
		const back = parsePractice(text);
		expect(back.ok).toBe(true);
		if (back.ok) expect(serializePractice(back.data)).toBe(text);
		expect(text.split("\n").filter((l) => l.startsWith("{\"practice\"")).length).toBe(3);
	});

	it("empty text is an empty set; foreign JSON, broken JSON and newer versions are reported", () => {
		expect(parsePractice("")).toEqual({ ok: true, data: emptyPractice() });
		expect(parsePractice("{ nope")).toMatchObject({ ok: false, reason: "json" });
		expect(parsePractice("{\"a\":1}")).toMatchObject({ ok: false, reason: "format" });
		expect(parsePractice(`{"format":"${PRACTICE_FORMAT}","version":2,"attempts":[]}`)).toMatchObject({ ok: false, reason: "future" });
	});

	it("keeps entries it does not understand and writes them back; a repeated practice page keeps the later line", () => {
		const good = JSON.stringify(rec("p1", "o1", 1, "2026-10-30T08:00:00.000Z"));
		const later = JSON.stringify(rec("p1", "o1", 3, "2026-10-30T09:00:00.000Z"));
		const bad = JSON.stringify({ practice: { doc: "d", page: "p" }, n: 0 });
		const r = parsePractice(`{"format":"${PRACTICE_FORMAT}","version":1,"attempts":[${good},${bad},${later}]}`);
		expect(r.ok && r.data.attempts.length).toBe(1);
		expect(r.ok && r.data.attempts[0]?.n).toBe(3);
		expect(r.ok && r.data.unknown).toEqual([JSON.parse(bad)]);
		expect(serializePractice((r as { ok: true; data: PracticeData }).data)).toContain(bad);
	});

	it("add replaces the record of the same practice page; addSeconds accumulates; remove deletes", () => {
		let d = withAttempts(rec("p1", "o1", 1, "2026-10-30T08:00:00.000Z"));
		d = applyPracticeOp(d, { type: "addSeconds", practicePage: "p1", seconds: 60 });
		d = applyPracticeOp(d, { type: "addSeconds", practicePage: "p1", seconds: 30.4 });
		expect(d.attempts[0]?.seconds).toBe(90);
		expect(applyPracticeOp(d, { type: "addSeconds", practicePage: "p1", seconds: 0 })).toBe(d);
		expect(applyPracticeOp(d, { type: "addSeconds", practicePage: "other", seconds: 5 }).attempts[0]?.seconds).toBe(90);
		d = applyPracticeOp(d, { type: "add", record: rec("p1", "o1", 4, "2026-10-30T10:00:00.000Z") });
		expect(d.attempts.length).toBe(1);
		expect(d.attempts[0]?.n).toBe(4);
		expect(applyPracticeOp(d, { type: "remove", practicePage: "p1" }).attempts).toEqual([]);
	});

	it("finds the record of a practice page, the attempts of an original (numbered, dated) and the next number", () => {
		const d = withAttempts(
			rec("p2", "o1", 2, "2026-10-31T08:00:00.000Z", { seconds: 30 }),
			rec("p1", "o1", 1, "2026-10-30T08:00:00.000Z", { seconds: 60 }),
			rec("p9", "o2", 1, "2026-10-30T08:00:00.000Z"),
		);
		expect(recordOf(d, "p2")?.original.page).toBe("o1");
		expect(recordOf(d, "p2", "other")?.n).toBe(2);
		expect(recordOf(d, "o1")).toBeNull();
		const list = attemptsOf(d, { doc: "docO", page: "o1" });
		expect(list.map((a) => a.n)).toEqual([1, 2]);
		expect(totalSeconds(list)).toBe(90);
		expect(nextAttemptNumber(d, { doc: "docO", page: "o1" })).toBe(3);
		expect(nextAttemptNumber(d, { page: "o2" })).toBe(2);
		expect(nextAttemptNumber(d, { page: "fresh" })).toBe(1);
		expect(attemptsOf(d, { doc: "elsewhere", page: "o1" })).toEqual([]);
	});

	it("newRecord stamps the time and normalises the spec", () => {
		const r = newRecord({ practice: { doc: "a", page: "p" }, original: { doc: "b", page: "o" }, n: 1, hide: { colors: ["#FF0000"] }, now: new Date("2026-10-30T08:00:00.000Z") });
		expect(r.at).toBe("2026-10-30T08:00:00.000Z");
		expect(r.hide).toEqual({ colors: ["#ff0000"] });
	});
});

describe("text and small rules", () => {
	it("durations", () => {
		expect(formatDuration(0)).toBe("0:00");
		expect(formatDuration(65)).toBe("1:05");
		expect(formatDuration(3723)).toBe("1:02:03");
		expect(formatDuration(-4)).toBe("0:00");
	});

	it("attempt dates are local time, minutes", () => {
		const d = new Date(2026, 9, 30, 14, 5, 59);
		expect(formatAttemptDate(d.toISOString())).toBe("2026-10-30 14:05");
		expect(formatAttemptDate("garbage")).toBe("garbage");
	});

	it("elapsed time never goes negative", () => {
		expect(elapsedSeconds(1000, 61_400)).toBe(60);
		expect(elapsedSeconds(5000, 1000)).toBe(0);
	});

	it("the exercises notebook name is cleaned, with a default", () => {
		expect(exercisesName("  Maths / drills: 1 ")).toBe("Maths drills 1");
		expect(exercisesName("")).toBe("Exercises");
		expect(exercisesName(null)).toBe("Exercises");
		expect(exercisesName("///")).toBe("Exercises");
	});

	it("inserts right after the page, within the document", () => {
		expect(insertIndexAfter(0, 3)).toBe(1);
		expect(insertIndexAfter(2, 3)).toBe(3);
		expect(insertIndexAfter(9, 3)).toBe(3);
	});
});

class MemoryAdapter implements LinkFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	writes: string[] = [];
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); this.writes.push(p); }
	async mkdir(p: string) { this.folders.add(p); }
}

describe("practice store", () => {
	const PATH = `Notebooks/_meta/${PRACTICE_FILE}`;

	it("a missing file is empty and loading writes nothing", async () => {
		const ad = new MemoryAdapter();
		const store = new PracticeStore(ad, "Notebooks");
		expect((await store.load()).attempts).toEqual([]);
		expect(ad.writes).toEqual([]);
		expect(store.path).toBe(PATH);
	});

	it("an update creates the folder and the file, and reads the file again first (another device's entry is kept)", async () => {
		const ad = new MemoryAdapter();
		const store = new PracticeStore(ad, () => "Notebooks");
		await store.update({ type: "add", record: rec("p1", "o1", 1, "2026-10-30T08:00:00.000Z") });
		expect(ad.folders.has("Notebooks/_meta")).toBe(true);
		// A sync brings an entry this store has not seen.
		const synced = parsePractice(ad.files.get(PATH)!);
		if (!synced.ok) throw new Error("bad");
		ad.files.set(PATH, serializePractice({ ...synced.data, attempts: [...synced.data.attempts, rec("p2", "o1", 2, "2026-10-31T08:00:00.000Z")] }));
		const after = await store.update({ type: "addSeconds", practicePage: "p1", seconds: 12 });
		expect(after.attempts.map((a) => a.practice.page).sort()).toEqual(["p1", "p2"]);
		expect(recordOf(after, "p1")?.seconds).toBe(12);
	});

	it("does not write when nothing changes", async () => {
		const ad = new MemoryAdapter();
		const store = new PracticeStore(ad, "Notebooks");
		await store.update({ type: "add", record: rec("p1", "o1", 1, "2026-10-30T08:00:00.000Z") });
		const n = ad.writes.length;
		await store.update({ type: "addSeconds", practicePage: "unknown", seconds: 3 });
		expect(ad.writes.length).toBe(n);
	});

	it("an unreadable file is never overwritten; one copy is kept", async () => {
		const ad = new MemoryAdapter();
		ad.files.set(PATH, "{ broken");
		const store = new PracticeStore(ad, "Notebooks");
		await expect(store.load()).rejects.toBeInstanceOf(PracticeBlockedError);
		await expect(store.update({ type: "add", record: rec("p1", "o1", 1, "2026-10-30T08:00:00.000Z") })).rejects.toBeInstanceOf(PracticeBlockedError);
		expect(ad.files.get(PATH)).toBe("{ broken");
		expect([...ad.files.keys()].filter((k) => k.includes("practice.unreadable-")).length).toBe(1);
	});

	it("a file from a newer version is left alone", async () => {
		const ad = new MemoryAdapter();
		const text = `{"format":"${PRACTICE_FORMAT}","version":9,"attempts":[]}`;
		ad.files.set(PATH, text);
		const store = new PracticeStore(ad, "Notebooks");
		await expect(store.update({ type: "remove", practicePage: "x" })).rejects.toMatchObject({ reason: "future" });
		expect(ad.files.get(PATH)).toBe(text);
	});

	it("concurrent updates all land", async () => {
		const ad = new MemoryAdapter();
		const store = new PracticeStore(ad, "");
		await Promise.all([1, 2, 3, 4].map((i) => store.update({ type: "add", record: rec(`p${i}`, "o1", i, `2026-10-0${i}T08:00:00.000Z`) })));
		expect(store.snapshot().attempts.length).toBe(4);
		expect(store.path).toBe("_meta/practice.json");
	});
});

describe("remembered choices", () => {
	it("anything stored becomes valid preferences", () => {
		expect(parsePracticePrefs(null)).toEqual({ target: "after", exercises: "Exercises" });
		expect(parsePracticePrefs({ target: "notebook", exercises: " Drills " })).toEqual({ target: "notebook", exercises: "Drills" });
		expect(parsePracticePrefs({ target: "elsewhere", exercises: 4 })).toEqual({ target: "after", exercises: "Exercises" });
	});
});
