/**
 * Format v8: markers (#201, #202, #203, #209), structured boxes (#204) and invisible ink (#100); the v7 -> v8
 * migration; lenient read and strict write; and every path that copies pages or ink (duplicate, page restore, page
 * trash, move to notebook, clipboard, templates, lecture and exercise pages, conflicted-copy merge, repair) keeping
 * the new data. Also the companion note output, the panel helpers and the exports.
 */
import { describe, expect, it } from "vitest";
import { captureClip, instantiateClip } from "../src/ink/clipboard";
import { elementBounds, hitElement, transformElement } from "../src/ink/elements";
import { eraseAreaCommand } from "../src/ink/erase-area";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { translate } from "../src/ink/transform";
import { planPageMove } from "../src/library/page-move";
import { companionContent } from "../src/model/companion-content";
import { createDocument, createPage } from "../src/model/document";
import { AddElement, History, ReplaceElement } from "../src/model/history";
import { exercisePage } from "../src/model/lecture-pack";
import { SetMarkerDone } from "../src/model/marker-commands";
import {
	cleanMarkerText, collectMarkers, createBox, createMarker, editMarker, groupMarkers, hasHiddenInk, isIsoDate, lectureRange, markerAt,
	MARKER_BADGE, openCount, tapMarker, visibleStrokes, withoutHiddenInk,
} from "../src/model/markers";
import { mergeChangeCount, mergeCovers, planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { planPageRestore } from "../src/model/page-restore";
import { makeEntry, planPageTrashRestore } from "../src/model/page-trash";
import { copyStroke, duplicatePage } from "../src/model/pages";
import { repairNotebookText } from "../src/model/repair";
import { FULL_CHECK_LIMIT, parse, serialize, serializeChecked, StagedParse } from "../src/model/serialize";
import { stressDocument } from "../src/model/stress";
import { documentFromTemplate, pageFromTemplate, templateDocument } from "../src/model/templates";
import {
	CURRENT_VERSION, FORMAT_ID, MARKER_TEXT_MAX,
	type BoxElement, type MarkerElement, type NotebookDocument, type Page, type PageElement, type Stroke,
} from "../src/model/types";
import { buildLecturePage } from "../src/view/lecture-logic";
import { line } from "./helpers";

const stamp = "2026-10-29T10:00:00.000Z";
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function roundTrip(doc: NotebookDocument): NotebookDocument {
	return parsed(serialize(doc)).doc;
}

function hiddenLine(x0: number, y0: number, x1: number, y1: number): Stroke {
	return { ...line(x0, y0, x1, y1), hidden: true };
}

const gap: MarkerElement = { id: "m-gap", type: "marker", kind: "gap", x: 40, y: 50, at: "2026-10-29T10:05:00.000Z", slide: 7 };
const question: MarkerElement = { id: "m-q", type: "marker", kind: "question", x: 300, y: 60, width: 120, height: 40, text: "Why is it convex?" };
const homework: MarkerElement = { id: "m-hw", type: "marker", kind: "homework", x: 40, y: 400, due: "2026-11-05", text: "Exercises 3.1-3.4", done: true };
const star: MarkerElement = { id: "m-star", type: "marker", kind: "star", x: 500, y: 700 };
const theorem: BoxElement = { id: "b-thm", type: "box", kind: "theorem", x: 30, y: 120, width: 400, height: 150, title: "Pythagoras" };

/** Page p1 with every kind of v8 data, page p2 plain. */
function v8Doc(): NotebookDocument {
	// Fixed ids: two calls give the same notebook (merges compare by id).
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const p1 = doc.pages[0]!;
	p1.id = "p1";
	p1.strokes.push({ ...line(10, 10, 100, 100), id: "s1" }, { ...hiddenLine(50, 200, 300, 220), id: "s2" });
	p1.elements = [gap, question, homework, star, theorem];
	const p2 = createPage();
	p2.id = "p2";
	p2.strokes.push({ ...line(20, 20, 80, 80), id: "s3" });
	doc.pages.push(p2);
	return doc;
}

function v7Doc(): Raw {
	return {
		format: FORMAT_ID, version: 7, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [
			{
				id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
				elements: [{ id: "t1", type: "text", x: 1, y: 2, width: 100, text: "hi", fontSize: 12, color: "#000000" }],
				strokes: [{ id: "s1", tool: "pen", color: "#112233", width: 2, render: 1, points: [[10, 20, 0.5]] }],
			},
		],
	};
}

/** The v8 data of a page, ids left out (copies get new ids). */
function v8Content(page: Page): unknown {
	const strip = <T extends { id: string }>(x: T) => {
		const { id: _id, ...rest } = x;
		void _id;
		return rest;
	};
	return {
		hidden: page.strokes.filter((s) => s.hidden).map((s) => s.points),
		elements: (page.elements ?? []).filter((e) => e.type === "marker" || e.type === "box").map(strip),
	};
}

describe("format v8", () => {
	it("is at version 8 with a v7 step", () => {
		expect(CURRENT_VERSION).toBeGreaterThanOrEqual(8);
		expect(MIGRATIONS[7]).toBeTypeOf("function");
	});

	it("migrates a v7 file unchanged apart from the version, dropping a stroke `hidden` key a v7 reader ignored", () => {
		const raw = v7Doc();
		raw.pages[0].strokes[0].hidden = true;
		const r = parsed(JSON.stringify(raw));
		expect(r.migratedFrom).toBe(7);
		expect(r.doc.version).toBe(CURRENT_VERSION);
		expect(r.doc.pages[0]!.strokes[0]!.hidden).toBeUndefined();
		expect(r.doc.pages[0]!.elements).toHaveLength(1);
		expect(r.dropped).toBeUndefined();
	});

	it("rejects a pre-v8 file with a marker or box (no version of the plugin wrote it)", () => {
		for (const el of [{ id: "m", type: "marker", kind: "star", x: 1, y: 1 }, { id: "b", type: "box", kind: "proof", x: 1, y: 1, width: 5, height: 5 }]) {
			const raw = v7Doc();
			raw.pages[0].elements.push(el);
			const r = parse(JSON.stringify(raw));
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toBe("invalid");
		}
	});

	it("serializes markers, boxes and hidden ink deterministically, with optional fields only when present", () => {
		const text = serialize(v8Doc());
		const lines = text.split("\n");
		expect(lines).toContain(`\t\t\t\t{"id":"m-gap","type":"marker","kind":"gap","x":40,"y":50,"at":"2026-10-29T10:05:00.000Z","slide":7},`);
		expect(lines).toContain(`\t\t\t\t{"id":"m-q","type":"marker","kind":"question","x":300,"y":60,"width":120,"height":40,"text":"Why is it convex?"},`);
		expect(lines).toContain(`\t\t\t\t{"id":"m-hw","type":"marker","kind":"homework","x":40,"y":400,"done":true,"due":"2026-11-05","text":"Exercises 3.1-3.4"},`);
		expect(lines).toContain(`\t\t\t\t{"id":"m-star","type":"marker","kind":"star","x":500,"y":700},`);
		expect(lines).toContain(`\t\t\t\t{"id":"b-thm","type":"box","kind":"theorem","x":30,"y":120,"width":400,"height":150,"title":"Pythagoras"}`);
		expect(lines.some((l) => /"render":1,"hidden":true,"points":/.test(l))).toBe(true);
		expect(lines.filter((l) => l.includes('"hidden"'))).toHaveLength(1);
		expect(serialize(parsed(text).doc)).toBe(text);
		expect(serializeChecked(v8Doc()).ok).toBe(true);
	});

	it("normalises labels on write, so the round trip is exact", () => {
		const doc = v8Doc();
		doc.pages[0]!.elements = [{ ...star, text: "  two \n lines  " }, { ...theorem, title: "   " }];
		const text = serialize(doc);
		expect(text).toContain(`"kind":"star","x":500,"y":700,"text":"two lines"}`);
		expect(text).not.toContain('"title"');
		expect(serialize(parsed(text).doc)).toBe(text);
		expect(cleanMarkerText("x".repeat(MARKER_TEXT_MAX + 50))).toHaveLength(MARKER_TEXT_MAX);
	});

	it("reads invalid optional details leniently: each is dropped and counted, the rest stays", () => {
		const raw = JSON.parse(serialize(v8Doc())) as Raw;
		const els = raw.pages[0].elements as Raw;
		els[0].slide = 0; // gap: bad slide
		delete els[1].height; // question: region with a width only
		els[2].due = "2026-02-30"; // homework: not a date
		els[2].done = false; // only true is stored
		els[3].text = 42; // star: label not a string
		els[4].title = ["x"]; // box: bad title
		raw.pages[0].strokes[1].hidden = "yes";
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(7);
		const page = r.doc.pages[0]!;
		expect(page.elements).toHaveLength(5);
		expect(page.elements![0]).toEqual({ id: "m-gap", type: "marker", kind: "gap", x: 40, y: 50, at: gap.at });
		expect(page.elements![1]).toEqual({ id: "m-q", type: "marker", kind: "question", x: 300, y: 60, text: question.text });
		expect(page.elements![2]).toEqual({ id: "m-hw", type: "marker", kind: "homework", x: 40, y: 400, text: homework.text });
		expect(page.strokes[1]!.hidden).toBeUndefined();
		// The check before writing is strict: what is written always reads back without drops.
		expect(serializeChecked(r.doc).ok).toBe(true);
	});

	it("drops (and counts) a marker or box whose kind or frame is invalid; a duplicate id still fails the file", () => {
		const raw = JSON.parse(serialize(v8Doc())) as Raw;
		raw.pages[0].elements[3].kind = "smiley";
		raw.pages[0].elements[4].width = -1;
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(2);
		expect(r.doc.pages[0]!.elements!.map((e) => e.id)).toEqual(["m-gap", "m-q", "m-hw"]);
		const dup = JSON.parse(serialize(v8Doc())) as Raw;
		dup.pages[0].elements[3].id = "m-gap";
		expect(parse(JSON.stringify(dup)).ok).toBe(false);
	});

	it("never writes an invalid marker, box or hidden flag (strict write)", () => {
		const bad: PageElement[] = [
			{ ...star, kind: "smiley" as never },
			{ ...gap, slide: 1.5 },
			{ ...homework, due: "tomorrow" },
			{ ...question, height: undefined },
			{ ...theorem, width: 0 },
		];
		for (const el of bad) {
			const doc = v8Doc();
			doc.pages[0]!.elements = [el];
			expect(serializeChecked(doc).ok).toBe(false);
		}
		const doc = v8Doc();
		doc.pages[0]!.strokes.push({ ...line(1, 1, 2, 2), hidden: false as never });
		expect(serializeChecked(doc).ok).toBe(false);
	});

	it("checks markers and hidden ink on the incremental save path too", () => {
		const doc = stressDocument(6000, 4);
		doc.pages[0]!.elements = [gap];
		doc.pages[1]!.strokes.push(hiddenLine(5, 5, 50, 50));
		const ok = serializeChecked(doc);
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.text.length).toBeGreaterThan(FULL_CHECK_LIMIT);
		doc.pages[0]!.elements = [{ ...gap, slide: -3 }];
		expect(serializeChecked(doc).ok).toBe(false);
	});

	it("a file of a later version is a future version (opens read-only)", () => {
		const r = parse(serialize(v8Doc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("staged loading counts the details dropped on pages read later", () => {
		const raw = JSON.parse(serialize(v8Doc())) as Raw;
		raw.pages[0].elements[0].slide = "seven";
		raw.pages[1].strokes[0].hidden = 1;
		const staged = StagedParse.create(raw, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.dropped).toBe(2);
		// Exactly what the full lenient parse keeps and drops.
		const full = parsed(JSON.stringify(raw));
		if (r.ok) {
			expect(r.dropped).toBe(full.dropped);
			expect(serialize(r.doc)).toBe(serialize(full.doc));
		}
	});
});

describe("paths that copy pages keep the v8 data", () => {
	const p1 = () => v8Doc().pages[0]!;

	it("duplicatePage and copyStroke (new ids, same markers, boxes and hidden ink)", () => {
		const page = p1();
		const copy = duplicatePage(page);
		expect(v8Content(copy)).toEqual(v8Content(page));
		expect(copy.elements!.every((e, i) => e.id !== page.elements![i]!.id)).toBe(true);
		expect(copyStroke(page.strokes[1]!, "x").hidden).toBe(true);
		expect(copyStroke(page.strokes[0]!, "y").hidden).toBeUndefined();
	});

	it("page restore, replace and insert", () => {
		const doc = v8Doc();
		const version = roundTrip(doc);
		const current = roundTrip(doc);
		current.pages[0]!.elements = [];
		current.pages[0]!.strokes = [];
		for (const mode of ["replace", "insert"] as const) {
			const target = roundTrip(current);
			const plan = planPageRestore(target, version, 0, 0, mode)!;
			plan.command.apply(target);
			expect(v8Content(target.pages[plan.pageIndex]!)).toEqual(v8Content(version.pages[0]!));
			expect(serializeChecked(target).ok).toBe(true);
		}
	});

	it("page trash: the entry and its restore (ids kept, or new ids on a clash)", () => {
		const doc = v8Doc();
		const entry = makeEntry(doc, doc.pages[0]!, 0, Date.parse(stamp));
		const without = roundTrip(doc);
		without.pages.splice(0, 1);
		const plan = planPageTrashRestore(without, entry)!;
		plan.command.apply(without);
		expect(v8Content(without.pages[plan.pageIndex]!)).toEqual(v8Content(doc.pages[0]!));
		// The page is still there: restoring again needs new ids, the data stays.
		const clash = planPageTrashRestore(without, entry)!;
		clash.command.apply(without);
		expect(v8Content(without.pages[clash.pageIndex]!)).toEqual(v8Content(doc.pages[0]!));
		expect(serializeChecked(without).ok).toBe(true);
	});

	it("move to notebook", () => {
		const source = v8Doc();
		const target = createDocument(new Date(stamp));
		const plan = planPageMove(source, ["p1"], target);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(v8Content(plan.pages[0]!)).toEqual(v8Content(source.pages[0]!));
	});

	it("clipboard: copy and paste keep hidden ink and every marker field", () => {
		const page = p1();
		const clip = captureClip(page.strokes, page.elements!, {})!;
		const made = instantiateClip(clip, 10, 0);
		expect(made.strokes.filter((s) => s.hidden)).toHaveLength(1);
		const hw = made.elements.find((e) => e.type === "marker" && e.kind === "homework") as MarkerElement;
		expect(hw).toMatchObject({ due: "2026-11-05", done: true, text: homework.text, x: 50, y: 400 });
		const q = made.elements.find((e) => e.type === "marker" && e.kind === "question") as MarkerElement;
		expect(q).toMatchObject({ x: 310, y: 60, width: 120, height: 40 });
		const box = made.elements.find((e) => e.type === "box") as BoxElement;
		expect(box).toMatchObject({ kind: "theorem", title: "Pythagoras", x: 40, width: 400, height: 150 });
	});

	it("templates: saving a page as a template and using it", () => {
		const doc = v8Doc();
		const template = roundTrip(templateDocument(doc, doc.pages[0]!));
		expect(v8Content(template.pages[0]!)).toEqual(v8Content(doc.pages[0]!));
		expect(v8Content(pageFromTemplate(template)!.page)).toEqual(v8Content(doc.pages[0]!));
		expect(v8Content(documentFromTemplate(template).pages[0]!)).toEqual(v8Content(doc.pages[0]!));
	});

	it("lecture and exercise pages are valid v8 pages and start or continue a lecture", () => {
		const doc = v8Doc();
		const lecture = buildLecturePage(doc.pages[1], "Analysis", new Date(2026, 9, 29, 12));
		const exercise = exercisePage(doc.pages[1]!, "grid");
		doc.pages.push(lecture, exercise);
		expect(serializeChecked(doc).ok).toBe(true);
		expect(lectureRange(doc.pages, 3)).toEqual({ from: 2, to: 4 });
		expect(lectureRange(doc.pages, 0)).toEqual({ from: 0, to: 2 });
	});
});

describe("conflicted-copy merge with v8 data", () => {
	it("adds markers, boxes and hidden ink of the copy, is covered and idempotent", () => {
		const main = roundTrip(v8Doc());
		main.pages[0]!.elements = [];
		main.pages[0]!.strokes = main.pages[0]!.strokes.filter((s) => !s.hidden);
		const other = roundTrip(v8Doc());
		const plan = planMerge(main, other);
		expect(plan.summary.elementsAdded).toBe(5);
		expect(plan.summary.strokesAdded).toBe(1);
		plan.command!.apply(main);
		const result = roundTrip(main);
		expect(v8Content(result.pages[0]!)).toEqual(v8Content(other.pages[0]!));
		expect(mergeCovers(result, other)).toBe(true);
		expect(mergeChangeCount(planMerge(result, other).summary)).toBe(0);
	});

	it("the same ink hidden on one side and shown on the other is kept twice (nothing is revealed or lost)", () => {
		const main = roundTrip(v8Doc());
		const other = roundTrip(v8Doc());
		const s = other.pages[0]!.strokes[1]!;
		const { hidden: _h, ...shown } = s;
		void _h;
		other.pages[0]!.strokes[1] = shown;
		const plan = planMerge(main, other);
		expect(plan.summary.strokesCopied).toBe(1);
		plan.command!.apply(main);
		expect(mergeCovers(roundTrip(main), other)).toBe(true);
		// A result that lost the hidden flag does not cover a copy with hidden ink.
		const lost = roundTrip(v8Doc());
		lost.pages[0]!.strokes = lost.pages[0]!.strokes.map((x) => ({ ...x, hidden: undefined }) as Stroke).map((x) => {
			const { hidden: _x, ...rest } = x;
			void _x;
			return rest;
		});
		expect(mergeCovers(lost, v8Doc())).toBe(false);
	});

	it("a marker resolved in the copy only is resolved in the result, never added twice", () => {
		const main = roundTrip(v8Doc());
		const other = roundTrip(v8Doc());
		other.pages[0]!.elements = other.pages[0]!.elements!.map((e) => (e.id === "m-q" ? { ...e, done: true } : e));
		expect(mergeCovers(main, other)).toBe(false);
		const plan = planMerge(main, other);
		expect(plan.summary.markersResolved).toBe(1);
		expect(plan.summary.elementsAdded + plan.summary.elementsCopied).toBe(0);
		plan.command!.apply(main);
		const result = roundTrip(main);
		expect((result.pages[0]!.elements!.find((e) => e.id === "m-q") as MarkerElement).done).toBe(true);
		expect(result.pages[0]!.elements).toHaveLength(5);
		expect(mergeCovers(result, other)).toBe(true);
		expect(mergeChangeCount(planMerge(result, other).summary)).toBe(0);
		// Resolved in the main notebook only: it stays resolved, nothing to do.
		expect(mergeChangeCount(planMerge(result, roundTrip(v8Doc())).summary)).toBe(0);
	});

	it("an edited marker label is content: the copy's version is kept as well", () => {
		const main = roundTrip(v8Doc());
		const other = roundTrip(v8Doc());
		other.pages[0]!.elements = other.pages[0]!.elements!.map((e) => (e.id === "m-q" ? { ...e, text: "Other question" } : e));
		const plan = planMerge(main, other);
		expect(plan.summary.elementsCopied).toBe(1);
		plan.command!.apply(main);
		expect(mergeCovers(roundTrip(main), other)).toBe(true);
	});
});

describe("repair keeps the v8 data", () => {
	it("recovers markers, boxes and hidden ink after a damaged region", () => {
		const doc = v8Doc();
		const text = serialize(doc);
		const lines = text.split("\n");
		// Damage the first stroke line: the JSON is no longer complete.
		const at = lines.findIndex((l) => l.startsWith("\t\t\t\t{") && l.includes('"points"'));
		lines[at] = lines[at]!.slice(0, 30);
		const r = repairNotebookText(lines.join("\n"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.summary.damaged).toBe(true);
		expect(v8Content(r.doc.pages[0]!)).toEqual(v8Content(doc.pages[0]!));
		expect(r.summary.unknownFields).toBe(0);
	});

	it("keeps the valid fields of a damaged marker and the hidden flag of a damaged stroke", () => {
		const raw = JSON.parse(serialize(v8Doc())) as Raw;
		raw.pages[0].elements[2].due = 20261105;
		raw.pages[0].strokes[1].points.push([NaN]);
		raw.pages[0].strokes[1].color = "blue";
		raw.pages[0].elements.push({ id: "m-bad", type: "marker", kind: "nope", x: 1, y: 1 });
		const r = repairNotebookText(JSON.stringify(raw).replace("[null]", "[\"x\"]"));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const page = r.doc.pages[0]!;
		const hw = page.elements!.find((e) => e.id === "m-hw") as MarkerElement;
		expect(hw).toEqual({ id: "m-hw", type: "marker", kind: "homework", x: 40, y: 400, done: true, text: homework.text });
		expect(page.strokes.filter((s) => s.hidden)).toHaveLength(1);
		expect(page.elements!.some((e) => e.id === "m-bad")).toBe(false);
	});
});

describe("companion note", () => {
	it("turns boxes into callouts with a region embed and homework into tasks; nothing else changes", () => {
		const doc = v8Doc();
		doc.pages[0]!.elements!.push({ ...homework, id: "m-hw2", y: 500, done: undefined, due: undefined, text: undefined } as MarkerElement);
		const c = companionContent(doc, { notebookPath: "Courses/Analysis.notebook", pageUri: (n) => `obsidian://x?page=${n}` });
		expect(c.text).toBe([
			"### p. 1",
			"[↗ p. 1](obsidian://x?page=1)",
			"",
			"> [!theorem] Pythagoras",
			"> ![[Courses/Analysis.notebook#p1&id=p1&r=30,120,400,150]]",
			"",
			"- [x] Exercises 3.1-3.4 📅 2026-11-05 ^nb-m-hw",
			"- [ ] Homework ^nb-m-hw2",
		].join("\n"));
		const plain = createDocument(new Date(stamp));
		expect(companionContent(plain, { notebookPath: "a.notebook", pageUri: () => "u" }).text).toBe("");
	});
});

describe("marker helpers", () => {
	it("taps: questions and gaps toggle, importance cycles, homework opens its dialog", () => {
		expect(tapMarker(question)?.done).toBe(true);
		expect(tapMarker({ ...question, done: true })?.done).toBeUndefined();
		expect(tapMarker({ ...star, kind: "important" })?.kind).toBe("critical");
		expect(tapMarker({ ...star, kind: "critical" })?.kind).toBe("star");
		expect(tapMarker(star)?.kind).toBe("important");
		expect(tapMarker(homework)).toBeNull();
	});

	it("creates point and region markers, edits them, finds a badge under a tap", () => {
		const m = createMarker("question", 100, 100, { at: stamp, text: "  q  " });
		expect(m).toMatchObject({ x: 100 - MARKER_BADGE / 2, y: 100 - MARKER_BADGE / 2, at: stamp, text: "q" });
		expect(m.width).toBeUndefined();
		const r = createMarker("gap", 0, 0, { region: { x: 10, y: 20, width: 50, height: 30 }, slide: 3 });
		expect(r).toMatchObject({ x: 10, y: 20, width: 50, height: 30, slide: 3 });
		expect(createMarker("gap", 5, 5, { region: { x: 0, y: 0, width: 2, height: 2 } }).width).toBeUndefined();
		const e = editMarker(homework, { due: "bad", text: "", done: false });
		expect(e.due).toBeUndefined();
		expect(e.text).toBeUndefined();
		expect(e.done).toBeUndefined();
		expect(markerAt([theorem, gap], gap.x + 2, gap.y + 2)).toBe(gap);
		expect(markerAt([theorem, gap], theorem.x + 5, theorem.y - 5)).toBe(theorem);
		expect(markerAt([theorem, gap], 590, 790)).toBeNull();
		expect(isIsoDate("2024-02-29")).toBe(true);
		expect(isIsoDate("2025-02-29")).toBe(false);
	});

	it("collects and groups the markers of a lecture for the panel", () => {
		const doc = v8Doc();
		const entries = collectMarkers(doc);
		expect(entries.map((e) => e.element.id)).toEqual(["m-gap", "m-q", "b-thm", "m-hw", "m-star"]);
		const g = groupMarkers(entries);
		expect(g.questions).toHaveLength(1);
		expect(g.gaps).toHaveLength(1);
		expect(g.homework).toHaveLength(1);
		expect(g.importance).toHaveLength(1);
		expect(g.boxes).toHaveLength(1);
		expect(openCount(entries)).toBe(2);
		expect(collectMarkers(doc, { from: 1, to: 2 })).toHaveLength(0);
	});

	it("SetMarkerDone finds the marker by id, is undoable and a no-op when missing", () => {
		const doc = v8Doc();
		const history = new History(() => doc);
		history.execute(new SetMarkerDone("p1", "m-q", true));
		expect((doc.pages[0]!.elements![1] as MarkerElement).done).toBe(true);
		history.undo();
		expect((doc.pages[0]!.elements![1] as MarkerElement).done).toBeUndefined();
		const before = serialize(doc);
		new SetMarkerDone("p1", "missing", true).apply(doc);
		new SetMarkerDone("p1", "m-hw", true).apply(doc);
		expect(serialize(doc)).toBe(before);
	});

	it("adding and editing markers are ordinary element commands", () => {
		const doc = v8Doc();
		const history = new History(() => doc);
		const box = createBox("definition", { x: 1, y: 20, width: 30, height: 40 }, "Group");
		history.execute(new AddElement("p2", box, 0));
		history.execute(new ReplaceElement("p1", star, tapMarker(star)!));
		expect(roundTrip(doc).pages[1]!.elements![0]).toEqual(box);
		history.undo();
		history.undo();
		expect(serialize(doc)).toBe(serialize(v8Doc()));
	});
});

describe("geometry, erasing and exports", () => {
	it("bounds, hits and transforms of markers and boxes", () => {
		expect(elementBounds(gap)).toEqual({ minX: 40, minY: 50, maxX: 40 + MARKER_BADGE, maxY: 50 + MARKER_BADGE });
		expect(elementBounds(question)).toEqual({ minX: 300, minY: 60, maxX: 420, maxY: 100 });
		expect(elementBounds(theorem).minY).toBeLessThan(theorem.y);
		expect(hitElement([theorem], 200, 200, 0)).toBe(theorem);
		expect(transformElement(gap, translate(10, -5))).toMatchObject({ x: 50, y: 45, slide: 7, at: gap.at });
		expect(transformElement(theorem, translate(5, 5))).toMatchObject({ x: 35, y: 125, width: 400, height: 150, title: "Pythagoras" });
	});

	it("hidden ink: visible strokes, the area eraser leaves it alone", () => {
		const page = v8Doc().pages[0]!;
		expect(visibleStrokes(page.strokes, false)).toHaveLength(1);
		expect(visibleStrokes(page.strokes, true)).toBe(page.strokes);
		expect(hasHiddenInk(v8Doc())).toBe(true);
		expect(withoutHiddenInk(page).strokes).toHaveLength(1);
		const all: Array<[number, number]> = [[0, 0], [600, 0], [600, 900], [0, 900]];
		const filter = { kind: "all" as const, color: "#000000" };
		const skip = (s: Stroke) => !!s.hidden;
		const cmd = eraseAreaCommand(page, all, { filter, includeElements: false, skip });
		cmd!.apply({ ...v8Doc(), pages: [page] });
		expect(page.strokes).toHaveLength(1);
		expect(page.strokes[0]!.hidden).toBe(true);
	});

	it("SVG and PDF exports leave hidden ink out unless asked, and draw markers and boxes", () => {
		const page = v8Doc().pages[0]!;
		const svg = pageToSvg(page, { paper: false });
		const svgAll = pageToSvg(page, { paper: false, hiddenInk: true });
		expect(svgAll.split("<path").length).toBe(svg.split("<path").length + 1);
		expect(svg).toContain(">Theorem · Pythagoras<");
		expect(svg).toContain("<circle");
		expect(svg).toContain(">?<");
		expect(pageToSvg(page, { boxLabel: () => "Teorema" })).toContain(">Teorema<");
		const dec = new TextDecoder();
		const pdf = dec.decode(pagesToPdf([page], { paper: false }));
		const pdfAll = dec.decode(pagesToPdf([page], { paper: false, hiddenInk: (p) => p.id === "p1" }));
		expect(pdfAll.length).toBeGreaterThan(pdf.length);
		expect(pdf).toBe(dec.decode(pagesToPdf([withoutHiddenInk(page)], { paper: false, hiddenInk: true })));
		expect(pdf).toContain("(Theorem");
	});
});

describe("canvas drawing of markers and boxes", () => {
	/** A 2D context that records calls; every method exists, every property can be set. */
	function recordingContext(): { ctx: CanvasRenderingContext2D; calls: string[] } {
		const calls: string[] = [];
		const ctx = new Proxy({} as Record<string, unknown>, {
			get: (target, key) => (key in target ? target[key as string] : (...args: unknown[]) => {
				calls.push(String(key));
				void args;
			}),
			set: (target, key, value) => {
				target[key as string] = value;
				return true;
			},
		});
		return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
	}

	it("draws every kind and state with balanced save/restore", async () => {
		const { drawBox, drawMarker } = await import("../src/ink/marker-render");
		const { ctx, calls } = recordingContext();
		for (const kind of ["gap", "question", "important", "critical", "star", "homework"] as const) {
			drawMarker(ctx, { ...gap, kind });
			drawMarker(ctx, { ...question, kind, done: true });
		}
		for (const kind of ["definition", "theorem", "example", "proof", "remark"] as const) drawBox(ctx, { ...theorem, kind });
		expect(calls.filter((c) => c === "save").length).toBe(calls.filter((c) => c === "restore").length);
		expect(calls).toContain("fillText");
		expect(calls).toContain("arc");
		expect(calls).toContain("strokeRect");
	});
});
