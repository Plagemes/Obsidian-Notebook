/**
 * Format v12: ink remembers the slide beside the notes (#226) — the document table `slides`, the stroke field `slide`, the
 * v11 -> v12 migration, lenient read and strict write, pruning, staged loading, undo/redo of the link, copies and merge.
 */
import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { AddStroke, Batch, History } from "../src/model/history";
import { planMerge } from "../src/model/merge";
import { MIGRATIONS } from "../src/model/migrations";
import { copyStroke, duplicatePage } from "../src/model/pages";
import { checkContent, freezeStroke, parse, parseStaged, serialize, serializeChecked, StagedParse, STAGED_MIN_CHARS } from "../src/model/serialize";
import {
	AddSlideRef, findSlideRef, linkStrokes, newSlideId, sameSlide, slideInkGroups, slideMerger, slideOfStrokes, slideRefOf, slideTable,
} from "../src/model/slide-links";
import { stressDocument } from "../src/model/stress";
import { CURRENT_VERSION, FORMAT_ID, type NotebookDocument, type SlideRef, type Stroke } from "../src/model/types";
import { getAt, setAt, type Raw } from "./raw-json";

const stamp = "2026-10-31T10:00:00.000Z";
const SRC = "0123456789abcdef01234567";
const PDF = "Courses/Slides.pdf";

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function line(y: number, x0 = 100): Stroke {
	return freezeStroke(createStroke("#111111", 2, [[x0, y, 0.5], [x0 + 100, y, 0.5]]));
}

/** A notebook with one page, two strokes linked to slide 3 and one plain stroke. */
function linkedDoc(): NotebookDocument {
	const doc = createDocument(new Date(stamp));
	doc.id = "doc";
	const page = doc.pages[0]!;
	const linked = linkStrokes(doc, [line(100), line(120)], { source: SRC, page: 3, path: PDF }, seeded(1));
	for (const c of linked.commands) c.apply(doc);
	page.strokes.push(...linked.strokes, line(400));
	return doc;
}

function seeded(seed: number): () => number {
	let x = seed;
	return () => {
		x = (x * 1103515245 + 12345) % 2147483648;
		return x / 2147483648;
	};
}

function v11Raw(): Raw {
	return {
		format: FORMAT_ID, version: 11, id: "doc", createdAt: stamp, modifiedAt: stamp,
		meta: { tags: [], favorite: false, cover: "#3b82f6", bookmarks: [] },
		assets: {},
		pages: [{
			id: "p1", width: 600, height: 800, paper: { kind: "grid", spacing: 14.17 },
			strokes: [{ id: "s1", tool: "pen", color: "#111111", width: 2, render: 1, points: [[1, 2, 0.5], [3, 4, 0.5]] }],
		}],
	};
}

describe("format v12: slide links", () => {
	it("is at version 12 with a v11 step", () => {
		expect(CURRENT_VERSION).toBe(12);
		expect(MIGRATIONS[11]).toBeTypeOf("function");
	});

	it("reads a v11 file unchanged apart from the version", () => {
		const r = parsed(JSON.stringify(v11Raw()));
		expect(r.migratedFrom).toBe(11);
		expect(r.doc.version).toBe(12);
		expect(r.doc.slides).toBeUndefined();
		expect(r.doc.pages[0]!.strokes[0]!.slide).toBeUndefined();
		expect(r.dropped).toBeUndefined();
	});

	it("drops v12 keys found in a v11 file (never ours, never had an effect), without counting them", () => {
		const raw = v11Raw();
		raw.slides = [{ id: "a", source: SRC, page: 1 }];
		setAt(raw, ["pages", 0, "strokes", 0, "slide"], "a");
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.slides).toBeUndefined();
		expect(r.doc.pages[0]!.strokes[0]!.slide).toBeUndefined();
		expect(r.dropped).toBeUndefined();
		expect(serialize(r.doc)).not.toContain("slide");
	});

	it("round-trips the table and the stroke field, byte for byte", () => {
		const doc = linkedDoc();
		const text = serialize(doc);
		expect(text).toContain(`"slides": [`);
		expect(text).toContain(`"path":"${PDF}"`);
		const back = parsed(text).doc;
		expect(serialize(back)).toBe(text);
		expect(back.slides).toHaveLength(1);
		const ref = back.slides![0]!;
		expect(ref).toMatchObject({ source: SRC, page: 3, path: PDF });
		const strokes = back.pages[0]!.strokes;
		expect(strokes.filter((s) => s.slide === ref.id)).toHaveLength(2);
		expect(strokes[2]!.slide).toBeUndefined();
		const checked = serializeChecked(back);
		expect(checked.ok && checked.text === text).toBe(true);
	});

	it("writes the slide after hidden and before the points (fixed key order)", () => {
		const doc = linkedDoc();
		const s = doc.pages[0]!.strokes[0]!;
		doc.pages[0]!.strokes[0] = freezeStroke({ ...s, hidden: true });
		const text = serialize(doc);
		expect(text).toMatch(/"render":1,"hidden":true,"slide":"[0-9a-z]{8}","points":/);
		expect(serialize(parsed(text).doc)).toBe(text);
	});

	it("does not write entries no stroke refers to", () => {
		const doc = linkedDoc();
		doc.slides!.push({ id: "unused", source: SRC, page: 9 });
		const text = serialize(doc);
		expect(text).not.toContain(`"unused"`);
		expect(serializeChecked(doc).ok).toBe(true);
		// No linked stroke at all: no table.
		doc.pages[0]!.strokes = doc.pages[0]!.strokes.filter((s) => s.slide === undefined);
		expect(serialize(doc)).not.toContain(`"slides"`);
	});

	it("writes ink whose slide names no entry (pasted from another notebook) without it, and the guard accepts it", () => {
		const doc = createDocument(new Date(stamp));
		const pasted = freezeStroke({ ...line(50), slide: "elsewhere" });
		doc.pages[0]!.strokes.push(pasted);
		expect(checkContent(doc)).toBeNull();
		const checked = serializeChecked(doc);
		expect(checked.ok).toBe(true);
		if (checked.ok) {
			expect(checked.text).not.toContain("slide");
			expect(parsed(checked.text).doc.pages[0]!.strokes[0]!.id).toBe(pasted.id);
		}
		// The ink in memory is untouched.
		expect(doc.pages[0]!.strokes[0]!.slide).toBe("elsewhere");
	});

	it("reads leniently: a bad entry, a duplicate id and a stroke naming no entry are dropped and counted, the ink stays", () => {
		const raw = JSON.parse(serialize(linkedDoc())) as Raw;
		const id = getAt<string>(raw, ["slides", 0, "id"]);
		(raw.slides as unknown[]).push({ id, source: SRC, page: 4 }, { id: "bad", source: SRC, page: 0 });
		setAt(raw, ["pages", 0, "strokes", 2, "slide"], "nowhere");
		const r = parsed(JSON.stringify(raw));
		expect(r.dropped).toBe(3);
		expect(r.doc.slides).toHaveLength(1);
		expect(r.doc.pages[0]!.strokes).toHaveLength(3);
		expect(r.doc.pages[0]!.strokes[2]!.slide).toBeUndefined();
		expect(r.doc.pages[0]!.strokes[0]!.slide).toBe(id);
	});

	it("reads a table that is not an array as no table (counted), keeping the ink", () => {
		const raw = JSON.parse(serialize(linkedDoc())) as Raw;
		raw.slides = { nope: true };
		const r = parsed(JSON.stringify(raw));
		expect(r.doc.slides).toBeUndefined();
		expect(r.doc.pages[0]!.strokes.every((s) => s.slide === undefined)).toBe(true);
		expect(r.dropped).toBe(3); // the table, then the two strokes' slides
	});

	it("is refused by older readers as a newer format (never read, never overwritten)", () => {
		const text = serialize(linkedDoc()).replace(`"version": ${CURRENT_VERSION}`, `"version": ${CURRENT_VERSION + 1}`);
		const r = parse(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("future-version");
	});

	it("stages a large v11 file, ignoring stray slide keys page by page", () => {
		const doc = stressDocument(6000, 3, 7);
		const v11 = serialize(doc).replace(`"version": ${CURRENT_VERSION}`, `"version": 11`)
			.replace(`"render":1,"points"`, `"render":1,"slide":"x","points"`);
		expect(v11.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(v11, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.migratedFrom).toBe(11);
			expect(r.doc.version).toBe(CURRENT_VERSION);
			expect(r.doc.pages.every((p) => p.strokes.every((s) => s.slide === undefined))).toBe(true);
			expect(r.dropped).toBeUndefined();
		}
	});

	it("stages a large v12 file with its links", () => {
		const doc = stressDocument(6000, 3, 7);
		const linked = linkStrokes(doc, doc.pages[2]!.strokes.slice(0, 5), { source: SRC, page: 2 }, seeded(3));
		for (const c of linked.commands) c.apply(doc);
		doc.pages[2]!.strokes.splice(0, 5, ...linked.strokes);
		const text = serialize(doc);
		expect(text.length).toBeGreaterThan(STAGED_MIN_CHARS);
		const staged = parseStaged(text, 1);
		expect(staged).toBeInstanceOf(StagedParse);
		const r = (staged as StagedParse).finish();
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.doc.slides).toHaveLength(1);
			expect(r.doc.pages[2]!.strokes.filter((s) => s.slide !== undefined)).toHaveLength(5);
			expect(serialize(r.doc)).toBe(text);
		}
	});

	it("checks the slide references of a large document before writing", () => {
		const doc = stressDocument(6000, 3, 7);
		const linked = linkStrokes(doc, [doc.pages[0]!.strokes[0]!], { source: SRC, page: 1 }, seeded(5));
		for (const c of linked.commands) c.apply(doc);
		doc.pages[0]!.strokes[0] = linked.strokes[0]!;
		expect(serializeChecked(doc).ok).toBe(true);
		doc.slides![0] = { ...doc.slides![0]!, page: 0 };
		const bad = serializeChecked(doc);
		expect(bad.ok).toBe(false);
	});
});

describe("linking ink to a slide (#226)", () => {
	it("adds one entry per slide and reuses it", () => {
		const doc = createDocument(new Date(stamp));
		const a = linkStrokes(doc, [line(10)], { source: SRC, page: 1 }, seeded(1));
		expect(a.commands).toHaveLength(1);
		a.commands[0]!.apply(doc);
		const b = linkStrokes(doc, [line(30)], { source: SRC, page: 1 }, seeded(1));
		expect(b.commands).toHaveLength(0);
		expect(b.strokes[0]!.slide).toBe(a.strokes[0]!.slide);
		const c = linkStrokes(doc, [line(50)], { source: SRC, page: 2 }, seeded(1));
		expect(c.commands).toHaveLength(1);
		expect(c.strokes[0]!.slide).not.toBe(a.strokes[0]!.slide);
		expect(Object.isFrozen(c.strokes[0])).toBe(true);
		expect(c.strokes[0]!.points).toEqual(line(50).points);
	});

	it("is one undo step with the ink: undo removes ink and entry, redo puts both back", () => {
		const doc = createDocument(new Date(stamp));
		const page = doc.pages[0]!;
		const history = new History(() => doc, 500, checkContent);
		const linked = linkStrokes(doc, [line(10), line(30)], { source: SRC, page: 5, path: PDF });
		const cmd = new Batch("Draw", [...linked.commands, ...linked.strokes.map((s, i) => new AddStroke(page.id, s, i))]);
		expect(history.execute(cmd)).toBe(true);
		expect(doc.slides).toHaveLength(1);
		expect(serialize(doc)).toContain(`"page":5`);
		history.undo();
		expect(page.strokes).toHaveLength(0);
		expect(doc.slides).toBeUndefined();
		history.redo();
		expect(page.strokes).toHaveLength(2);
		expect(slideRefOf(doc, page.strokes[0]!)).toMatchObject({ source: SRC, page: 5, path: PDF });
		const text = serialize(doc);
		expect(serialize(parsed(text).doc)).toBe(text);
	});

	it("AddSlideRef leaves an entry that was already there", () => {
		const doc = createDocument(new Date(stamp));
		const ref: SlideRef = { id: "abc", source: SRC, page: 1 };
		doc.slides = [ref];
		const cmd = new AddSlideRef({ ...ref });
		cmd.apply(doc);
		cmd.revert(doc);
		expect(doc.slides).toEqual([ref]);
	});

	it("finds an entry by source, page and path; tells slides and sources apart", () => {
		const doc = linkedDoc();
		expect(findSlideRef(doc, { source: SRC, page: 3, path: PDF })).not.toBeNull();
		expect(findSlideRef(doc, { source: SRC, page: 3 })).toBeNull();
		expect(sameSlide({ source: SRC, page: 3 }, { source: "other", page: 3, path: PDF })).toBe(false);
		expect(sameSlide({ source: SRC, page: 3, path: PDF }, { source: "other", page: 3, path: PDF })).toBe(true);
		// A notebook path is not a PDF: two PDFs shown from one notebook are different sources.
		expect(sameSlide({ source: "a", page: 1, path: "N.notebook" }, { source: "b", page: 1, path: "N.notebook" })).toBe(false);
	});

	it("makes new ids of 8 base-36 characters that are not taken", () => {
		const id = newSlideId(new Set());
		expect(id).toMatch(/^[0-9a-z]{8}$/);
		const fixed = seeded(9);
		const first = newSlideId(new Set(), seeded(9));
		expect(newSlideId(new Set([first]), fixed)).not.toBe(first);
	});

	it("names the slide most of a selection was written beside", () => {
		const doc = createDocument(new Date(stamp));
		const a = linkStrokes(doc, [line(10), line(20)], { source: SRC, page: 1 }, seeded(1));
		a.commands.forEach((c) => c.apply(doc));
		const b = linkStrokes(doc, [line(30)], { source: SRC, page: 2 }, seeded(2));
		b.commands.forEach((c) => c.apply(doc));
		expect(slideOfStrokes(doc, [...a.strokes, ...b.strokes])?.page).toBe(1);
		expect(slideOfStrokes(doc, [b.strokes[0]!, line(5)])?.page).toBe(2);
		expect(slideOfStrokes(doc, [line(5)])).toBeNull();
	});

	it("groups linked ink that is close together, one group per slide and place", () => {
		const doc = createDocument(new Date(stamp));
		const s1 = linkStrokes(doc, [line(100), line(115), line(600)], { source: SRC, page: 1 }, seeded(1));
		s1.commands.forEach((c) => c.apply(doc));
		const s2 = linkStrokes(doc, [line(130)], { source: SRC, page: 2 }, seeded(2));
		s2.commands.forEach((c) => c.apply(doc));
		const groups = slideInkGroups(slideTable(doc), [...s1.strokes, ...s2.strokes, line(300)]);
		expect(groups.map((g) => [g.ref.page, g.strokes])).toEqual([[1, 2], [2, 1], [1, 1]]);
		expect(groups[0]!.bounds.minY).toBeLessThan(groups[1]!.bounds.minY);
	});

	it("merges two groups of one slide that a later stroke joins", () => {
		const doc = createDocument(new Date(stamp));
		const s = linkStrokes(doc, [line(100), line(190), line(145)], { source: SRC, page: 1 }, seeded(1));
		s.commands.forEach((c) => c.apply(doc));
		const groups = slideInkGroups(slideTable(doc), s.strokes);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.strokes).toBe(3);
	});
});

describe("copies and merge keep the link", () => {
	it("copyStroke keeps, replaces or drops the slide", () => {
		const s = freezeStroke({ ...line(10), slide: "a" });
		expect(copyStroke(s).slide).toBe("a");
		expect(copyStroke(s, "x", "b").slide).toBe("b");
		expect(copyStroke(s, "x", null).slide).toBeUndefined();
		expect(copyStroke(freezeStroke({ ...line(10), hidden: true })).hidden).toBe(true);
	});

	it("a duplicated page keeps its links (same table)", () => {
		const doc = linkedDoc();
		const copy = duplicatePage(doc.pages[0]!);
		doc.pages.push(copy);
		const text = serialize(doc);
		expect(parsed(text).doc.pages[1]!.strokes.filter((s) => s.slide !== undefined)).toHaveLength(2);
	});

	it("merging a conflicted copy brings its linked ink and its entries", () => {
		const main = createDocument(new Date(stamp));
		main.id = "doc";
		const other: NotebookDocument = JSON.parse(JSON.stringify(main)) as NotebookDocument;
		const linked = linkStrokes(other, [line(10)], { source: SRC, page: 7 }, seeded(4));
		linked.commands.forEach((c) => c.apply(other));
		other.pages[0]!.strokes.push(...linked.strokes);
		const plan = planMerge(main, other);
		expect(plan.command).not.toBeNull();
		plan.command!.apply(main);
		expect(main.slides).toHaveLength(1);
		expect(slideRefOf(main, main.pages[0]!.strokes[0]!)).toMatchObject({ source: SRC, page: 7 });
		expect(serializeChecked(main).ok).toBe(true);
		plan.command!.revert(main);
		expect(main.slides).toBeUndefined();
	});

	it("maps the copy's ids: same entry, an equal entry under another id, or a fresh id when the id is taken", () => {
		const main = createDocument(new Date(stamp));
		main.slides = [{ id: "a", source: SRC, page: 1 }, { id: "b", source: SRC, page: 9 }];
		const other = createDocument(new Date(stamp));
		other.slides = [{ id: "a", source: SRC, page: 1 }, { id: "z", source: SRC, page: 9 }, { id: "b", source: SRC, page: 2 }];
		const m = slideMerger(main, other);
		expect(m.map("a")).toBe("a");
		expect(m.map("z")).toBe("b");
		const fresh = m.map("b");
		expect(fresh).not.toBe("b");
		expect(fresh).not.toBeNull();
		expect(m.map("missing")).toBeNull();
		const cmds = m.commands();
		expect(cmds).toHaveLength(1);
		cmds[0]!.apply(main);
		expect(main.slides?.find((r) => r.id === fresh)).toMatchObject({ source: SRC, page: 2 });
	});

	it("keeps a page made with createPage free of slides", () => {
		expect(createPage().strokes).toEqual([]);
	});
});
