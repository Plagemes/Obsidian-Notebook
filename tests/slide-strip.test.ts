/**
 * Slide strip (#417): for each slide, its page, the notes pages linked to it, the exercise page after it, the ink written
 * beside it (#226) or in its margin, and the questions on it (model/slide-strip.ts).
 */
import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { createPdfPages } from "../src/model/pages";
import { freezeStroke } from "../src/model/serialize";
import { linkStrokes } from "../src/model/slide-links";
import { buildSlideStrip, rowHasNotes } from "../src/model/slide-strip";
import type { Asset, MarkerElement, NotebookDocument, Page, Stroke } from "../src/model/types";

const ASSET = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const asset: Asset = { id: ASSET, kind: "pdf", path: `Notebooks/_assets/${ASSET}.pdf`, name: "Lecture 3.pdf", bytes: 10 };

function line(y: number, x0 = 100): Stroke {
	return freezeStroke(createStroke("#111111", 2, [[x0, y, 0.5], [x0 + 80, y, 0.5]]));
}

function question(id: string, x: number, y: number, extra: Partial<MarkerElement> = {}): MarkerElement {
	return { id, type: "marker", kind: "question", x, y, ...extra };
}

function link(doc: NotebookDocument, page: Page, strokes: Stroke[], source: string, slide: number, path?: string): void {
	const l = linkStrokes(doc, strokes, path ? { source, page: slide, path } : { source, page: slide });
	l.commands.forEach((c) => c.apply(doc));
	page.strokes.push(...l.strokes);
}

/** Three slide pages of one PDF, an exercise page after the second, notes in the margin of the first. */
function lectureDoc(): NotebookDocument {
	const doc = createDocument();
	doc.assets = { [ASSET]: asset };
	const slides = createPdfPages(asset, [{ width: 600, height: 400 }, { width: 600, height: 400 }, { width: 600, height: 400 }]);
	const exercise = createPage({ width: 600, height: 400 });
	doc.pages = [slides[0]!, slides[1]!, exercise, slides[2]!];
	doc.pages[0]!.margins = { left: 0, right: 200, bottom: 0 };
	doc.pages[0]!.width = 800;
	doc.pages[0]!.strokes.push(line(50, 650), line(80, 100)); // one in the right margin, one on the slide
	doc.pages[2]!.elements = [question("q-ex", 50, 50, { text: "Why the minus sign?" })];
	return doc;
}

describe("slide strip", () => {
	it("lists the slide pages of a PDF notebook with the exercise page after a slide and the margin note", () => {
		const sections = buildSlideStrip({ doc: lectureDoc(), links: [] });
		expect(sections).toHaveLength(1);
		expect(sections[0]!.name).toBe("Lecture 3");
		const rows = sections[0]!.rows;
		expect(rows.map((r) => [r.page, r.slidePage, r.exercise])).toEqual([[1, 0, null], [2, 1, 2], [3, 3, null]]);
		expect(rows[0]!.ink).toEqual([expect.objectContaining({ page: 0, strokes: 1, kind: "margin" })]);
		expect(rows[1]!.questions).toEqual([{ page: 2, id: "q-ex", text: "Why the minus sign?", done: false }]);
		expect(rows.map(rowHasNotes)).toEqual([true, true, false]);
	});

	it("puts questions on the slide page they are on, and open ones first", () => {
		const doc = lectureDoc();
		doc.pages[3]!.elements = [question("done", 10, 10, { done: true }), question("open", 10, 300)];
		const row = buildSlideStrip({ doc, links: [] })[0]!.rows[2]!;
		expect(row.questions.map((q) => [q.id, q.done])).toEqual([["open", false], ["done", true]]);
	});

	it("collects ink written beside a slide on any notes page, and the questions next to it", () => {
		const doc = createDocument();
		const notes = doc.pages[0]!;
		link(doc, notes, [line(100), line(115)], OTHER, 4, "Courses/Physics.pdf");
		link(doc, notes, [line(500)], OTHER, 5, "Courses/Physics.pdf");
		notes.elements = [question("near", 200, 110), question("far", 400, 700)];
		const sections = buildSlideStrip({ doc, links: [] });
		expect(sections).toHaveLength(1);
		expect(sections[0]!.name).toBe("Physics");
		const [four, five] = sections[0]!.rows;
		expect(four!.page).toBe(4);
		expect(four!.ink).toEqual([expect.objectContaining({ page: 0, strokes: 2, kind: "linked" })]);
		expect(four!.questions.map((q) => q.id)).toEqual(["near"]);
		expect(five!.ink[0]!.strokes).toBe(1);
		expect(five!.questions).toEqual([]);
	});

	it("adds the notes pages linked side by side, and a question on a page linked to one slide only", () => {
		const doc = createDocument();
		doc.pages.push(createPage(), createPage());
		const [a, b, c] = doc.pages;
		c!.elements = [question("q", 10, 10)];
		const links = [
			{ notesPage: b!.id, source: OTHER, page: 2, path: "P.pdf" },
			{ notesPage: c!.id, source: OTHER, page: 2, path: "P.pdf" },
			{ notesPage: a!.id, source: OTHER, page: 1, path: "P.pdf" },
			{ notesPage: "gone", source: OTHER, page: 3 },
		];
		const rows = buildSlideStrip({ doc, links })[0]!.rows;
		expect(rows.map((r) => [r.page, r.notes])).toEqual([[1, [0]], [2, [1, 2]]]);
		expect(rows[1]!.questions.map((q) => q.id)).toEqual(["q"]);
		expect(rows[1]!.exercise).toBeNull();
	});

	it("keeps one section per PDF and can show only the PDF beside the notes", () => {
		const doc = lectureDoc();
		link(doc, doc.pages[2]!, [line(200)], OTHER, 1, "Other.pdf");
		const all = buildSlideStrip({ doc, links: [] });
		expect(all.map((s) => s.source)).toEqual([ASSET, OTHER]);
		const only = buildSlideStrip({ doc, links: [], only: { source: OTHER, path: "Other.pdf" } });
		expect(only.map((s) => s.source)).toEqual([OTHER]);
		expect(only[0]!.rows[0]!.ink[0]!.page).toBe(2);
	});

	it("leaves out hidden ink when the caller says so", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const hidden = freezeStroke({ ...line(100), hidden: true });
		link(doc, page, [hidden], OTHER, 1);
		expect(buildSlideStrip({ doc, links: [] })[0]!.rows[0]!.ink).toHaveLength(1);
		expect(buildSlideStrip({ doc, links: [], visible: (p) => p.strokes.filter((s) => !s.hidden) })).toEqual([]);
	});

	it("is empty for a notebook without slides", () => {
		expect(buildSlideStrip({ doc: createDocument(), links: [] })).toEqual([]);
	});
});
