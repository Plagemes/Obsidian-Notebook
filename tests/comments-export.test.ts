/**
 * Margin comments (#86) in the exports: the Markdown list and the PDF margin notes (an optional strip beside each page that has
 * comments), plus the registry entries and the settings that go with them.
 */
import { describe, expect, it } from "vitest";
import { pagesToPdf, PDF_NOTES_STRIP, type PdfCommentLabels } from "../src/ink/export-pdf";
import { actionById, baseContext, isEnabled, isRelevant } from "../src/ui/actions";
import { addCommentCommand, addReplyCommand, createComment, createReply, resolvedComment } from "../src/model/comments";
import { createDocument, createPage } from "../src/model/document";
import { buildNotebookMarkdown, commentsMarkdown, type CommentLabels } from "../src/model/export-markdown";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import type { Page, PageComment } from "../src/model/types";

const T0 = Date.UTC(2026, 10, 4, 10, 0, 0);
const labels: CommentLabels = { heading: "Comments", resolved: "resolved", sketch: "(sketch)", when: (ms) => `t${ms - T0}` };

function commented(): Page {
	const doc = createDocument(new Date(T0));
	const page = doc.pages[0]!;
	const one = createComment(page, { region: { x: 40, y: 100, width: 120, height: 40 }, text: "Check this *line*\nsecond line", author: "Tablet", now: T0 })!;
	page.comments = [one];
	page.comments = [one, createReply(page, one.id, "Done # see next page", "Phone", T0 + 1000)!];
	const two = createComment(page, { region: { x: 40, y: 400, width: 100, height: 30 }, text: "", sketch: { strokes: [[10, 10, 100, 60]] }, author: "Tablet", now: T0 + 2000 })!;
	page.comments = [...page.comments, resolvedComment(two, true, T0 + 3000)!];
	return page;
}

describe("comments: Markdown export", () => {
	it("lists the comments of a page numbered like their markers, with author, time, state, text and nested replies", () => {
		const [block] = commentsMarkdown(commented(), labels);
		expect(block).toBe([
			"**Comments**",
			"",
			"1. Tablet, t0: Check this \\*line\\*",
			"   second line",
			"   - Phone, t1000: Done \\# see next page",
			"2. Tablet, t2000 (resolved): (sketch)",
		].join("\n"));
	});

	it("writes nothing for a page without comments", () => {
		expect(commentsMarkdown(createPage(), labels)).toEqual([]);
	});

	it("puts the list below the page's image and text in the notebook file, only when asked", () => {
		const page = commented();
		const base = { title: "Notes", pages: [page], meta: undefined, images: ["page-001.png"], pageLabel: (n: number) => `Page ${n}` };
		expect(buildNotebookMarkdown(base)).not.toContain("Comments");
		const text = buildNotebookMarkdown({ ...base, comments: labels });
		expect(text).toContain("![](page-001.png)\n\n**Comments**");
		expect(text.indexOf("**Comments**")).toBeGreaterThan(text.indexOf("![]("));
	});
});

describe("comments: PDF margin notes", () => {
	const pdfLabels: PdfCommentLabels = { resolved: "resolved", sketch: "(sketch)", more: (n) => `+${n} more`, when: () => "4 Nov 2026" };
	const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

	it("widens only the pages that have comments, by the strip, and writes the notes in it", () => {
		const withComments = commented();
		const plain = createPage();
		const text = latin1(pagesToPdf([withComments, plain], { comments: pdfLabels }));
		expect(text).toContain(`/MediaBox [0 0 ${Math.round((withComments.width + PDF_NOTES_STRIP) * 100) / 100} ${withComments.height}]`);
		expect(text).toContain(`/MediaBox [0 0 ${plain.width} ${plain.height}]`);
		expect(text).toContain("(Tablet, 4 Nov 2026)");
		expect(text).toContain("(Check this");
		expect(text).toContain("(Phone, 4 Nov 2026)");
		expect(text).toContain("\\(sketch\\)");
		expect(text).toContain("(Tablet, 4 Nov 2026 \\(resolved\\))");
	});

	it("exports the pages as they are when the notes are not asked for", () => {
		const page = commented();
		const text = latin1(pagesToPdf([page]));
		expect(text).toContain(`/MediaBox [0 0 ${page.width} ${page.height}]`);
		expect(text).not.toContain("Tablet");
	});

	it("says how many comments did not fit beside the page instead of running off it", () => {
		const doc = createDocument(new Date(T0));
		const page = doc.pages[0]!;
		const list: PageComment[] = [];
		for (let i = 0; i < 40; i++) {
			list.push(createComment({ ...page, comments: list }, { region: { x: 20, y: 10 + i * 4, width: 30, height: 10 }, text: `note ${i}`.repeat(6), author: "T", now: T0 + i })!);
		}
		page.comments = list;
		const text = latin1(pagesToPdf([page], { comments: pdfLabels }));
		expect(text).toMatch(/\(\+\d+ more\)/);
	});

	it("leaves the notes out of a background-only export", () => {
		const text = latin1(pagesToPdf([commented()], { comments: pdfLabels, layers: "background" }));
		expect(text).not.toContain("Tablet");
	});
});

describe("comments: registry and settings", () => {
	it("registers Comment on a selection, on a region, the panel and the next-comment command", () => {
		for (const id of ["comment-selection", "comment-region", "comments-panel", "comment-next"]) expect(actionById(id), id).toBeDefined();
		const sel = baseContext({ selection: { strokes: 1, elements: 0, images: 0 } });
		expect(isRelevant(actionById("comment-selection")!, sel)).toBe(true);
		expect(isRelevant(actionById("comment-selection")!, baseContext())).toBe(false);
	});

	it("a locked page cannot be commented on, but the panel still opens", () => {
		const locked = baseContext({ selection: { strokes: 1, elements: 0, images: 0 }, page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, locked: true } });
		expect(isEnabled(actionById("comment-selection")!, locked)).toBe(false);
		expect(isEnabled(actionById("comments-panel")!, locked)).toBe(true);
		const readOnly = baseContext({ editable: false });
		expect(isEnabled(actionById("comments-panel")!, readOnly)).toBe(true);
		expect(isEnabled(actionById("comment-region")!, readOnly)).toBe(false);
	});

	it("has the two settings: markers on, notes in the PDF off, and reads them back", () => {
		expect(DEFAULT_SETTINGS.commentMarkers).toBe(true);
		expect(DEFAULT_SETTINGS.commentsInPdf).toBe(false);
		const s = readSettings({ commentMarkers: false, commentsInPdf: true });
		expect(s.commentMarkers).toBe(false);
		expect(s.commentsInPdf).toBe(true);
		expect(readSettings({ commentMarkers: "yes" }).commentMarkers).toBe(true);
	});
});

describe("comments: commands stay one step each", () => {
	it("adds a comment and a reply as separate commands", () => {
		const doc = createDocument(new Date(T0));
		const page = doc.pages[0]!;
		const note = createComment(page, { region: { x: 1, y: 1, width: 40, height: 40 }, text: "x", author: "a", now: T0 })!;
		const add = addCommentCommand(page, note)!;
		add.apply(doc);
		const reply = createReply(page, note.id, "y", "a", T0 + 1)!;
		const more = addReplyCommand(page, reply)!;
		more.apply(doc);
		more.revert(doc);
		expect(page.comments).toEqual([note]);
	});
});
