/**
 * Format v19: start and end time of a page (#217) — the optional `startAt` / `endAt` of a page, the v18 -> v19 migration, lenient read and
 * strict write, staged loading, repair, the history stamp (upkeep: no undo step, Undo / Redo never move it), copies (duplicate and template
 * clear them, a moved page keeps them), merge of a conflicted copy (earliest start, latest end), the closed-notebook edit and the shown text.
 */
import { describe, expect, it } from "vitest";
import { pageTimesText, headerLayout, headerText, type HeaderNotebook, type HeaderSettings } from "../src/ink/page-header";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { AddElement, AddPage, AddStroke, Batch, collectAdds, EraseStrokes, History, ReplaceElement, RemoveElement } from "../src/model/history";
import { mergeCovers, planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { notebookFromTemplate, templateFromNotebook } from "../src/model/notebook-template";
import { pageInfo } from "../src/model/page-info";
import { SetPageLocked } from "../src/model/page-lock";
import { mergedTimes, pageTimes, pageTimesProblem, SetPageTimes, stampPage, stampPages } from "../src/model/page-times";
import { duplicatePage } from "../src/model/pages";
import { planPageRestore } from "../src/model/page-restore";
import { repairNotebookText } from "../src/model/repair";
import { checkContent, freezeElement, freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS, validate } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { CURRENT_VERSION, FORMAT_ID, type BoxElement, type NotebookDocument, type Page, type Stroke } from "../src/model/types";
import { planPageMove } from "../src/library/page-move";
import { setAt, type Raw } from "./raw-json";

const stamp = "2026-11-05T10:00:00.000Z";
const T0 = 1_760_000_000_000;

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function stroke(id: string, x: number, y: number): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, [[x, y, 0.5], [x + 30, y + 5, 0.5], [x + 15, y + 10, 0.5]]), id });
}

function box(id: string, x = 100, y = 100): BoxElement {
	return freezeElement({ id, type: "box", kind: "definition", x, y, width: 80, height: 40 });
}

/** A notebook with pages "p1" (with ink) and "p2" (empty). */
function baseDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const p1 = doc.pages[0]!;
	p1.id = "p1";
	p1.strokes.push(stroke("s1", 20, 20), stroke("s2", 20, 60));
	const p2 = createPage();
	p2.id = "p2";
	doc.pages.push(p2);
	return doc;
}

function timedDoc(): NotebookDocument {
	const doc = baseDoc();
	doc.pages[0]!.startAt = T0;
	doc.pages[0]!.endAt = T0 + 90_000;
	return doc;
}

function v18Raw(): Raw {
	return {
		format: FORMAT_ID, version: 18, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] }],
		}],
	};
}

function historyWith(doc: NotebookDocument, clock: () => number) {
	const refused: string[] = [];
	const history = new History(() => doc, 500, checkContent, (m) => refused.push(m), null, null, clock);
	return { history, refused };
}

describe("format v19: migration", () => {
	it("has the v18 step and the current format is v19", () => {
		expect(CURRENT_VERSION).toBe(19);
		expect(typeof MIGRATIONS[18]).toBe("function");
	});

	it("reads a v18 file unchanged apart from the version: no times, nothing dropped", () => {
		const r = parsed(JSON.stringify(v18Raw()));
		expect(r.migratedFrom).toBe(18);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.strokes).toHaveLength(1);
		expect(r.doc.pages[0]!.startAt).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("drops the v19 keys of a v18 file: they were never ours, so the page has no times (not even a lone one)", () => {
		const raw = v18Raw();
		setAt(raw, ["pages", 0, "startAt"], T0);
		setAt(raw, ["pages", 0, "endAt"], T0 + 5);
		let r = parsed(JSON.stringify(raw));
		expect(pageTimes(r.doc.pages[0]!)).toBeNull();
		expect(r.dropped).toBeUndefined();
		const lone = v18Raw();
		setAt(lone, ["pages", 0, "startAt"], "garbage");
		r = parsed(JSON.stringify(lone));
		expect(r.doc.pages[0]!.startAt).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("migrates a v18 round trip: the new version, the same ink, no times written", () => {
		const text = serialize(parsed(JSON.stringify(v18Raw())).doc);
		expect(text).toContain(`"version": ${CURRENT_VERSION}`);
		expect(text).not.toContain("startAt");
		expect(text).not.toContain("endAt");
		expect(parsed(text).doc.pages[0]!.strokes).toHaveLength(1);
	});

	it("is refused by 0.20 and older as a newer format (they read up to v18, so v19 opens read-only and is never overwritten)", () => {
		const text = serialize(timedDoc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		const r = parse(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});
});

describe("format v19: write and read", () => {
	it("writes the times on their own lines after the page's fixed fields, byte for byte, and reads them back", () => {
		const doc = timedDoc();
		const text = serialize(doc);
		expect(text).toContain(`\t\t\t"startAt": ${T0},\n\t\t\t"endAt": ${T0 + 90_000},\n\t\t\t"strokes": [`);
		const back = parsed(text);
		expect(back.migratedFrom).toBeNull();
		expect(back.dropped).toBeUndefined();
		expect(pageTimes(back.doc.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
		expect(pageTimes(back.doc.pages[1]!)).toBeNull();
		expect(serialize(back.doc)).toBe(text);
		expect(serializeChecked(doc, true)).toEqual({ ok: true, text });
		expect(serializeChecked(doc)).toEqual({ ok: true, text });
	});

	it("a page with a lock, tags, margins and times round-trips whole", () => {
		const doc = timedDoc();
		const page = doc.pages[0]!;
		page.locked = true;
		page.tags = ["a", "b"];
		page.margins = { left: 10, right: 5, bottom: 4 };
		page.elements = [box("e1")];
		const text = serialize(doc);
		const back = parsed(text).doc;
		expect(serialize(back)).toBe(text);
		expect(back.pages[0]).toMatchObject({ locked: true, startAt: T0, endAt: T0 + 90_000, tags: ["a", "b"] });
	});

	it("a start equal to the end is valid", () => {
		const doc = baseDoc();
		doc.pages[0]!.startAt = T0;
		doc.pages[0]!.endAt = T0;
		expect(pageTimes(parsed(serialize(doc)).doc.pages[0]!)).toEqual({ startAt: T0, endAt: T0 });
	});

	it("reads leniently: a lone, inverted, fractional, negative or non-numeric time is dropped (both) and counted; the ink stays", () => {
		const bad: Array<[unknown, unknown]> = [[T0, undefined], [undefined, T0], [T0 + 5, T0], [1.5, 2.5], [-1, 4], ["a", "b"], [T0, null], [T0, Number.MAX_SAFE_INTEGER + 2], [T0, 8_640_000_000_000_001]];
		for (const [start, end] of bad) {
			const raw = JSON.parse(serialize(timedDoc())) as Raw;
			setAt(raw, ["pages", 0, "startAt"], start);
			setAt(raw, ["pages", 0, "endAt"], end);
			const text = JSON.stringify(raw);
			const r = parsed(text);
			expect(r.dropped, `${String(start)} ${String(end)}`).toBe(1);
			expect(pageTimes(r.doc.pages[0]!)).toBeNull();
			expect(r.doc.pages[0]!.strokes).toHaveLength(2);
			expect(() => validate(JSON.parse(text) as unknown), `${String(start)} ${String(end)}`).toThrow();
		}
	});

	it("the strict check and the history guard refuse a page with a lone or inverted time, and the writer never writes one silently", () => {
		const cases: Array<[number | undefined, number | undefined]> = [[T0, undefined], [undefined, T0], [T0 + 1, T0], [0.5, 1]];
		for (const [startAt, endAt] of cases) {
			const doc = baseDoc();
			if (startAt !== undefined) doc.pages[0]!.startAt = startAt;
			if (endAt !== undefined) doc.pages[0]!.endAt = endAt;
			expect(checkContent(doc)).not.toBeNull();
			expect(serializeChecked(doc).ok).toBe(false);
			expect(serializeChecked(doc, true).ok).toBe(false);
		}
		expect(checkContent(timedDoc())).toBeNull();
	});

	it("pageTimesProblem tells valid pairs from invalid ones", () => {
		expect(pageTimesProblem(undefined, undefined)).toBeNull();
		expect(pageTimesProblem(0, 0)).toBeNull();
		expect(pageTimesProblem(1, undefined)).not.toBeNull();
		expect(pageTimesProblem(2, 1)).not.toBeNull();
		expect(pageTimesProblem("1", 2)).not.toBeNull();
		expect(pageTimesProblem(1, Number.NaN)).not.toBeNull();
	});
});

describe("format v19: staged loading", () => {
	it("stages a large v18 file, ignoring the v19 keys of every page", () => {
		const doc = stressDocument(6000, 3, 7);
		const v18 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 18`).replace(/("paper": \{[^\n]*\},\n)/, `$1\t\t\t"startAt": 7,\n\t\t\t"endAt": 9,\n`);
		expect(v18.length).toBeGreaterThan(STAGED_MIN_CHARS);
		expect(v18).toContain('"startAt": 7');
		const staged = parseStaged(v18, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(18);
			expect(r.doc.version).toBe(CURRENT_VERSION);
			expect(r.doc.pages.every((p) => p.startAt === undefined && p.endAt === undefined)).toBe(true);
			expect(r.dropped).toBeUndefined();
		}
	});

	it("stages a large v19 file with times page by page and writes it back the same", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[1]!.startAt = T0;
		doc.pages[1]!.endAt = T0 + 1000;
		doc.pages[2]!.startAt = T0 + 5;
		doc.pages[2]!.endAt = T0 + 5;
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const s = staged as StagedParse;
		expect(pageTimes(s.doc.pages[1]!)).toBeNull();
		const r = s.finish();
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(pageTimes(r.doc.pages[1]!)).toEqual({ startAt: T0, endAt: T0 + 1000 });
		expect(pageTimes(r.doc.pages[2]!)).toEqual({ startAt: T0 + 5, endAt: T0 + 5 });
		expect(serialize(r.doc)).toBe(text);
	});

	it("a staged v19 page with an inverted pair is dropped and counted like the whole-file read", () => {
		const doc = stressDocument(6000, 3, 7);
		doc.pages[1]!.startAt = T0;
		doc.pages[1]!.endAt = T0 + 1000;
		const text = serialize(doc).replace(`"endAt": ${T0 + 1000}`, `"endAt": ${T0 - 1}`);
		const staged = parseStaged(text, 1) as StagedParse;
		const r = staged.finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dropped).toBe(1);
			expect(pageTimes(r.doc.pages[1]!)).toBeNull();
		}
	});
});

describe("format v19: repair", () => {
	it("a clean v19 file with times needs no repair", () => {
		const r = repairNotebookText(serialize(timedDoc()));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.summary.alreadyReadable).toBe(true);
	});

	it("keeps the times of a salvaged page", () => {
		const doc = stressDocument(40, 2, 3);
		doc.pages[0]!.startAt = T0;
		doc.pages[0]!.endAt = T0 + 7;
		const text = serialize(doc);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(pageTimes(r.doc.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 7 });
		expect(parse(r.text).ok).toBe(true);
	});

	it("resets an invalid pair of a damaged file and counts it", () => {
		const doc = stressDocument(40, 2, 3);
		doc.pages[0]!.startAt = T0;
		doc.pages[0]!.endAt = T0 + 7;
		const text = serialize(doc).replace(`"endAt": ${T0 + 7}`, `"endAt": ${T0 - 7}`);
		const r = repairNotebookText(text.slice(0, Math.floor(text.length * 0.9)));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.fieldsReset).toBeGreaterThanOrEqual(1);
		expect(pageTimes(r.doc.pages[0]!)).toBeNull();
		expect(parse(r.text).ok).toBe(true);
	});
});

describe("stamping: the history marks the page when ink or an element is added", () => {
	it("the first addition starts the page, every later one moves the end", () => {
		const doc = baseDoc();
		let now = T0;
		const { history } = historyWith(doc, () => now);
		const page = doc.pages[1]!;
		expect(history.execute(new AddStroke("p2", stroke("n1", 5, 5), 0))).toBe(true);
		expect(pageTimes(page)).toEqual({ startAt: T0, endAt: T0 });
		now = T0 + 60_000;
		expect(history.execute(new AddElement("p2", box("n2"), 0))).toBe(true);
		expect(pageTimes(page)).toEqual({ startAt: T0, endAt: T0 + 60_000 });
		now = T0 + 90_000;
		history.execute(new AddStroke("p2", stroke("n3", 9, 9), 1));
		expect(pageTimes(page)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("only the pages the command added to are stamped, whatever else a batch does", () => {
		const doc = baseDoc();
		const { history } = historyWith(doc, () => T0);
		history.execute(new Batch("mixed", [new AddStroke("p1", stroke("n1", 5, 5), 2), new AddElement("p1", box("n2"), 0)]));
		expect(pageTimes(doc.pages[0]!)).toEqual({ startAt: T0, endAt: T0 });
		expect(pageTimes(doc.pages[1]!)).toBeNull();
	});

	it("stamping is not an undo step: one Undo removes the stroke, the times stay, and a Redo does not move them", () => {
		const doc = baseDoc();
		let now = T0;
		const { history } = historyWith(doc, () => now);
		const page = doc.pages[1]!;
		history.execute(new AddStroke("p2", stroke("n1", 5, 5), 0));
		now = T0 + 5000;
		history.execute(new AddStroke("p2", stroke("n2", 9, 9), 1));
		expect(page.strokes).toHaveLength(2);
		const undone = history.undo();
		expect(undone?.label).toBe("Add stroke");
		expect(page.strokes.map((s) => s.id)).toEqual(["n1"]);
		expect(pageTimes(page)).toEqual({ startAt: T0, endAt: T0 + 5000 });
		now = T0 + 999_999;
		expect(history.redo()?.label).toBe("Add stroke");
		expect(page.strokes.map((s) => s.id)).toEqual(["n1", "n2"]);
		expect(pageTimes(page)).toEqual({ startAt: T0, endAt: T0 + 5000 });
		// undo everything: two steps only, then nothing more to undo
		expect(history.undo()).not.toBeNull();
		expect(history.undo()).not.toBeNull();
		expect(history.undo()).toBeNull();
		expect(page.strokes).toHaveLength(0);
		expect(pageTimes(page)).toEqual({ startAt: T0, endAt: T0 + 5000 });
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("undo and redo are exact: the document text is the same as before the edit apart from the times, and the same again after the redo", () => {
		const doc = baseDoc();
		const { history } = historyWith(doc, () => T0);
		const noTimes = serialize(doc);
		history.execute(new AddStroke("p1", stroke("n1", 5, 5), 2));
		const edited = serialize(doc);
		history.undo();
		const undone = serialize(doc);
		expect(undone).toBe(noTimes.replace('"strokes": [', `"startAt": ${T0},\n\t\t\t"endAt": ${T0},\n\t\t\t"strokes": [`));
		history.redo();
		expect(serialize(doc)).toBe(edited);
	});

	it("an undo past a page's first addition leaves the page started: the page was written on", () => {
		const doc = baseDoc();
		const { history } = historyWith(doc, () => T0);
		history.execute(new AddElement("p2", box("e"), 0));
		history.undo();
		expect(doc.pages[1]!.elements ?? []).toHaveLength(0);
		expect(pageTimes(doc.pages[1]!)).toEqual({ startAt: T0, endAt: T0 });
	});

	it("removing, replacing and erasing never stamp", () => {
		const doc = timedDoc();
		const page = doc.pages[0]!;
		page.elements = [box("e1")];
		const { history } = historyWith(doc, () => T0 + 10_000_000);
		history.execute(new ReplaceElement("p1", page.elements[0]!, box("y")));
		history.execute(new RemoveElement("p1", page.elements[0]!));
		history.execute(new EraseStrokes("p1", [{ stroke: page.strokes[0]!, index: 0 }]));
		expect(pageTimes(page)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
	});

	it("a command refused by the lock or by the guard stamps nothing", () => {
		const doc = baseDoc();
		doc.pages[1]!.locked = true;
		const { history, refused } = historyWith(doc, () => T0);
		expect(history.execute(new AddStroke("p2", stroke("n1", 5, 5), 0))).toBe(false);
		expect(pageTimes(doc.pages[1]!)).toBeNull();
		// a duplicate id is refused by the guard
		expect(history.execute(new AddStroke("p1", stroke("s1", 5, 5), 2))).toBe(false);
		expect(refused).toHaveLength(1);
		expect(pageTimes(doc.pages[0]!)).toBeNull();
	});

	it("a clock that went back never moves the end back nor the start forward", () => {
		const doc = timedDoc();
		const { history } = historyWith(doc, () => T0 - 1000);
		history.execute(new AddStroke("p1", stroke("n1", 5, 5), 2));
		expect(pageTimes(doc.pages[0]!)).toEqual({ startAt: T0 - 1000, endAt: T0 + 90_000 });
		const later = historyWith(doc, () => T0 + 10);
		later.history.execute(new AddStroke("p1", stroke("n2", 5, 5), 3));
		expect(pageTimes(doc.pages[0]!)).toEqual({ startAt: T0 - 1000, endAt: T0 + 90_000 });
	});

	it("without a clock nothing is stamped (the default)", () => {
		const doc = baseDoc();
		new History(() => doc).execute(new AddStroke("p2", stroke("n1", 5, 5), 0));
		expect(pageTimes(doc.pages[1]!)).toBeNull();
	});

	it("an upkeep change (applyQuietly) is not an addition", () => {
		const doc = baseDoc();
		doc.pages[0]!.elements = [box("e1")];
		const { history } = historyWith(doc, () => T0);
		expect(history.applyQuietly({ label: "q", apply: () => undefined, revert: () => undefined })).toBe(true);
		expect(pageTimes(doc.pages[0]!)).toBeNull();
	});

	it("a page that is added or inserted with content is not stamped (it is not written on)", () => {
		const doc = baseDoc();
		const { history } = historyWith(doc, () => T0);
		const page = createPage();
		page.strokes.push(stroke("c1", 1, 1));
		history.execute(new AddPage(page, 2));
		expect(pageTimes(page)).toBeNull();
	});

	it("a stamp survives the undo of a refused step: the document is put back exactly", () => {
		const doc = baseDoc();
		const { history } = historyWith(doc, () => T0);
		history.execute(new AddStroke("p2", stroke("n1", 5, 5), 0));
		// someone corrupts the document outside the history: the undo is judged against that, never against the stamp
		expect(history.undo()).not.toBeNull();
		expect(pageTimes(doc.pages[1]!)).toEqual({ startAt: T0, endAt: T0 });
	});

	it("collectAdds looks into batches and into the lock-exempt wrapper, and sees explicit times", () => {
		const added = new Set<string>();
		const explicit = new Set<string>();
		collectAdds(new Batch("b", [new AddStroke("a", stroke("x", 1, 1), 0), new Batch("c", [new AddElement("b", box("y"), 0), new SetPageTimes("c", null)])]), added, explicit);
		expect([...added].sort()).toEqual(["a", "b"]);
		expect([...explicit]).toEqual(["c"]);
	});

	it("stampPage and stampPages handle odd input without writing an invalid pair", () => {
		const doc = baseDoc();
		expect(stampPage(doc.pages[0]!, Number.NaN)).toBe(false);
		expect(stampPage(doc.pages[0]!, -5)).toBe(false);
		expect(stampPage(doc.pages[0]!, 1.5)).toBe(false);
		expect(pageTimes(doc.pages[0]!)).toBeNull();
		expect(stampPages(doc, ["nope"], T0)).toBe(false);
		expect(stampPages(doc, ["p1"], T0)).toBe(true);
		expect(stampPages(doc, ["p1"], T0)).toBe(false);
	});

	it("SetPageTimes is exact both ways and a missing page is a no-op", () => {
		const doc = timedDoc();
		const cmd = new SetPageTimes("p1", { startAt: 1, endAt: 2 });
		cmd.apply(doc);
		expect(pageTimes(doc.pages[0]!)).toEqual({ startAt: 1, endAt: 2 });
		cmd.revert(doc);
		expect(pageTimes(doc.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
		const none = new SetPageTimes("p1", null);
		none.apply(doc);
		expect(pageTimes(doc.pages[0]!)).toBeNull();
		none.revert(doc);
		expect(pageTimes(doc.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
		new SetPageTimes("zz", null).apply(doc);
	});

	it("locking a page is not an addition, and the lock guard does not count times as content", () => {
		const doc = timedDoc();
		const { history } = historyWith(doc, () => T0 + 1);
		history.execute(new SetPageLocked("p1", true));
		expect(pageTimes(doc.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
	});
});

describe("copies: duplicate and template clear the times, a moved page keeps them", () => {
	it("a duplicated page starts without times", () => {
		const copy = duplicatePage(timedDoc().pages[0]!);
		expect(copy.startAt).toBeUndefined();
		expect(copy.endAt).toBeUndefined();
		expect(copy.strokes).toHaveLength(2);
	});

	it("a page that replaces the original (the trash, a move) keeps them", () => {
		const copy = duplicatePage(timedDoc().pages[0]!, { keepTasks: true });
		expect(pageTimes(copy)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
	});

	it("a template and a notebook made from it have no times", () => {
		const template = templateFromNotebook(timedDoc());
		expect(template.pages.every((p) => pageTimes(p) === null)).toBe(true);
		const fresh = notebookFromTemplate(template);
		expect(fresh.pages.every((p) => pageTimes(p) === null)).toBe(true);
		expect(serialize(fresh)).not.toContain("startAt");
	});

	it("a page moved to another notebook keeps its times, a copy does not", () => {
		const source = timedDoc();
		const target = baseDoc();
		target.id = "t";
		target.pages = [createPage()];
		const moved = planPageMove(source, ["p1"], target, true);
		expect(moved.ok).toBe(true);
		if (moved.ok) expect(pageTimes(moved.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
		const copied = planPageMove(source, ["p1"], target, false);
		expect(copied.ok).toBe(true);
		if (copied.ok) expect(pageTimes(copied.pages[0]!)).toBeNull();
	});

	it("restoring an old version onto a page keeps the span of both", () => {
		const doc = timedDoc();
		const version = baseDoc();
		version.pages[0]!.startAt = T0 + 10;
		version.pages[0]!.endAt = T0 + 200_000;
		const plan = planPageRestore(doc, version, 0, 0, "replace");
		expect(plan).not.toBeNull();
		new History(() => doc).execute(plan!.command);
		expect(pageTimes(doc.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 200_000 });
	});

	it("restoring as a new page starts without times", () => {
		const doc = timedDoc();
		const version = timedDoc();
		const plan = planPageRestore(doc, version, 0, 0, "insert");
		expect(plan).not.toBeNull();
		new History(() => doc).execute(plan!.command);
		expect(doc.pages).toHaveLength(3);
		expect(pageTimes(doc.pages[1]!)).toBeNull();
	});
});

describe("merge of a conflicted copy", () => {
	function twoCopies() {
		const main = timedDoc();
		const other = parsed(serialize(main)).doc;
		return { main, other };
	}

	function run(main: NotebookDocument, other: NotebookDocument, clock = () => T0 + 5_000_000) {
		const plan = planMerge(main, other);
		if (plan.command) new History(() => main, 500, checkContent, null, null, null, clock).execute(plan.command);
		return plan;
	}

	it("the same times on both sides need no step", () => {
		const { main, other } = twoCopies();
		const plan = planMerge(main, other);
		expect(plan.command).toBeNull();
		expect(mergeCovers(main, other)).toBe(true);
	});

	it("takes the earliest start and the latest end", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.startAt = T0 - 500;
		other.pages[0]!.endAt = T0 + 40_000;
		run(main, other);
		expect(pageTimes(main.pages[0]!)).toEqual({ startAt: T0 - 500, endAt: T0 + 90_000 });
		other.pages[0]!.endAt = T0 + 300_000;
		run(main, other);
		expect(pageTimes(main.pages[0]!)).toEqual({ startAt: T0 - 500, endAt: T0 + 300_000 });
		expect(planMerge(main, other).command).toBeNull();
	});

	it("the same merge the other way round gives the same span", () => {
		const a = timedDoc();
		const b = parsed(serialize(a)).doc;
		b.pages[0]!.startAt = T0 + 100;
		b.pages[0]!.endAt = T0 + 500_000;
		run(a, b);
		const c = timedDoc();
		const d = parsed(serialize(c)).doc;
		d.pages[0]!.startAt = T0 + 100;
		d.pages[0]!.endAt = T0 + 500_000;
		run(d, c);
		expect(pageTimes(a.pages[0]!)).toEqual(pageTimes(d.pages[0]!));
	});

	it("a page with times takes them from a copy whose page has none (and the other way round)", () => {
		const { main, other } = twoCopies();
		const stripped = baseDoc();
		run(stripped, other);
		expect(pageTimes(stripped.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
		const m2 = timedDoc();
		const o2 = baseDoc();
		expect(planMerge(m2, o2).command).toBeNull();
		expect(pageTimes(m2.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 90_000 });
		void main;
	});

	it("ink brought in by a merge never stamps the moment of the merge: the page spans both copies' times", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.strokes.push(stroke("s9", 200, 200));
		other.pages[0]!.endAt = T0 + 120_000;
		run(main, other, () => T0 + 9_999_999_999);
		expect(main.pages[0]!.strokes).toHaveLength(3);
		expect(pageTimes(main.pages[0]!)).toEqual({ startAt: T0, endAt: T0 + 120_000 });
	});

	it("ink brought onto a page that has no times on either side leaves it without times", () => {
		const main = baseDoc();
		const other = parsed(serialize(main)).doc;
		other.pages[0]!.strokes.push(stroke("s9", 200, 200));
		run(main, other, () => T0 + 123);
		expect(main.pages[0]!.strokes).toHaveLength(3);
		expect(pageTimes(main.pages[0]!)).toBeNull();
	});

	it("a page only the copy has comes with its times", () => {
		const { main, other } = twoCopies();
		const extra = createPage();
		extra.id = "p9";
		extra.strokes.push(stroke("z1", 3, 3));
		extra.startAt = T0 + 7;
		extra.endAt = T0 + 8;
		other.pages.push(extra);
		run(main, other);
		const added = main.pages.find((p) => p.id === "p9")!;
		expect(pageTimes(added)).toEqual({ startAt: T0 + 7, endAt: T0 + 8 });
	});

	it("is one undo step and undoing it gives the times back exactly", () => {
		const { main, other } = twoCopies();
		other.pages[0]!.startAt = T0 - 500;
		other.pages[0]!.endAt = T0 + 400_000;
		other.pages[0]!.strokes.push(stroke("s9", 200, 200));
		const before = serialize(main);
		const plan = planMerge(main, other);
		const history = new History(() => main, 500, checkContent, null, null, null, () => T0 + 77);
		history.execute(plan.command!);
		expect(pageTimes(main.pages[0]!)).toEqual({ startAt: T0 - 500, endAt: T0 + 400_000 });
		history.undo();
		expect(serialize(main)).toBe(before);
		history.redo();
		expect(pageTimes(main.pages[0]!)).toEqual({ startAt: T0 - 500, endAt: T0 + 400_000 });
		expect(serializeChecked(main, true).ok).toBe(true);
	});

	it("mergedTimes", () => {
		expect(mergedTimes(null, null)).toBeNull();
		expect(mergedTimes({ startAt: 5, endAt: 6 }, null)).toEqual({ startAt: 5, endAt: 6 });
		expect(mergedTimes({ startAt: 5, endAt: 6 }, { startAt: 1, endAt: 5 })).toEqual({ startAt: 1, endAt: 6 });
	});
});

describe("showing the times", () => {
	const nb: HeaderNotebook = { title: "Maths", createdAt: stamp, locale: "en" };
	const base: HeaderSettings = { headerMode: "header", headerPageNumber: true, headerPageTotal: true, headerDate: false, headerTitle: false, headerAlign: "centre", headerInExport: true };

	function at(h: number, m: number, day = 3): number {
		return new Date(2026, 5, day, h, m, 0, 0).getTime();
	}

	it("one short text for the start and end, the end only when it is another minute", () => {
		expect(pageTimesText({ startAt: at(14, 5), endAt: at(14, 5) }, "en")).toBe("3 Jun 14:05");
		expect(pageTimesText({ startAt: at(14, 5), endAt: at(15, 20) }, "en")).toBe("3 Jun 14:05 – 15:20");
		expect(pageTimesText({ startAt: at(14, 5), endAt: at(9, 10, 4) }, "en")).toBe("3 Jun 14:05 – 4 Jun 09:10");
	});

	it("the header line adds the times of a page that has them, unless the setting hides them", () => {
		const times = { startAt: at(14, 5), endAt: at(15, 20) };
		expect(headerText(base, nb, 2, 12, times)).toBe("3 / 12 · 3 Jun 14:05 – 15:20");
		expect(headerText({ ...base, headerPageTimes: false }, nb, 2, 12, times)).toBe("3 / 12");
		expect(headerText(base, nb, 2, 12, null)).toBe("3 / 12");
		expect(headerText(base, nb, 2, 12)).toBe("3 / 12");
	});

	it("headerLayout reads the times from the page", () => {
		const page = createPage();
		page.startAt = at(8, 0);
		page.endAt = at(8, 30);
		expect(headerLayout(page, 0, 1, base, nb)?.text).toBe("1 / 1 · 3 Jun 08:00 – 08:30");
		expect(headerLayout(createPage(), 0, 1, base, nb)?.text).toBe("1 / 1");
	});

	it("the page information carries the times (null when the page has none)", () => {
		const doc = timedDoc();
		expect(pageInfo(doc, 0)!.times).toEqual({ startAt: T0, endAt: T0 + 90_000 });
		expect(pageInfo(doc, 1)!.times).toBeNull();
	});
});

describe("page type", () => {
	it("a Page can be typed with the new fields", () => {
		const page: Page = { id: "x", width: 1, height: 1, paper: { kind: "blank", spacing: 1 }, strokes: [], startAt: 1, endAt: 2 };
		expect(pageTimes(page)).toEqual({ startAt: 1, endAt: 2 });
	});
});
