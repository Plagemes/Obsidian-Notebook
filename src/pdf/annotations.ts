/**
 * #155 Export PDF annotations to a Markdown note: highlighter strokes over PDF pages (with the PDF text
 * under them when the PDF has a text layer) and text boxes on PDF pages, each with a link to its
 * notebook page. Pure: no pdf.js, DOM or 'obsidian' import.
 */
import type { NotebookDocument, Page, Stroke } from "../model/types";
import type { TextBox } from "./text-items";

export interface AnnotationItem {
	kind: "highlight" | "comment";
	/** 1-based index of the notebook page. */
	notebookPage: number;
	/** Id of that page: links to it keep working when pages are reordered (wave 0.8, 388). */
	pageId: string;
	/** Asset id and 1-based page of the PDF under the item. */
	asset: string;
	pdfPage: number;
	/** Highlight: the PDF text under it ("" when none could be read); comment: the text box content. */
	text: string;
	/** Top-left of the item on its page, for reading order. */
	x: number;
	y: number;
}

/** Distance from (px, py) to the segment a-b. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeBox(s: Stroke): { minX: number; minY: number; maxX: number; maxY: number } {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of s.points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

/**
 * PDF text under a highlighter stroke. Each text run is split into equal-width character cells; a cell
 * is under the highlight when the middle of its height lies within half the stroke width of the stroke's
 * centre line. Selected characters are joined in content-stream order (runs separated by a space) and
 * whitespace is collapsed.
 */
export function textUnderStroke(stroke: Stroke, boxes: readonly TextBox[]): string {
	const pts = stroke.points;
	if (pts.length === 0) return "";
	const reach = Math.max(1, stroke.width / 2);
	const b = strokeBox(stroke);
	const parts: string[] = [];
	for (const box of boxes) {
		if (box.x > b.maxX + reach || box.x + box.width < b.minX - reach) continue;
		if (box.y > b.maxY + reach || box.y + box.height < b.minY - reach) continue;
		const chars = [...box.str];
		const n = chars.length;
		if (n === 0) continue;
		const cy = box.y + box.height / 2;
		let run = "";
		for (let k = 0; k < n; k++) {
			const cx = box.x + ((k + 0.5) * box.width) / n;
			let hit = false;
			if (pts.length === 1) hit = Math.hypot(cx - pts[0]![0], cy - pts[0]![1]) <= reach;
			for (let i = 1; i < pts.length && !hit; i++) {
				const p = pts[i - 1]!;
				const q = pts[i]!;
				if (segmentDistance(cx, cy, p[0], p[1], q[0], q[1]) <= reach) hit = true;
			}
			if (hit) run += chars[k];
			else if (run) {
				parts.push(run);
				run = "";
			}
		}
		if (run) parts.push(run);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Whether the page has something the export would list. */
function annotated(page: Page): boolean {
	return page.background?.kind === "pdf"
		&& (page.strokes.some((s) => s.tool === "highlighter") || (page.elements ?? []).some((e) => e.type === "text" && e.text.trim() !== ""));
}

/** Pages whose PDF text the export needs (PDF pages with at least one highlight). */
export function pagesNeedingText(doc: NotebookDocument): Page[] {
	return doc.pages.filter((p) => p.background?.kind === "pdf" && p.strokes.some((s) => s.tool === "highlighter"));
}

export function hasPdfAnnotations(doc: NotebookDocument): boolean {
	return doc.pages.some(annotated);
}

/**
 * Highlights and text boxes of every PDF page, page by page, top to bottom then left to right on a page.
 * `textOf` gives the text boxes of a page in page coordinates (boxesOnPage), or null when the PDF text
 * could not be read; highlights then have empty text.
 */
export function collectAnnotations(doc: NotebookDocument, textOf: (page: Page) => readonly TextBox[] | null): AnnotationItem[] {
	const out: AnnotationItem[] = [];
	doc.pages.forEach((page, i) => {
		const bg = page.background;
		if (bg?.kind !== "pdf" || !annotated(page)) return;
		const items: AnnotationItem[] = [];
		const highlights = page.strokes.filter((s) => s.tool === "highlighter");
		const boxes = highlights.length > 0 ? textOf(page) : null;
		for (const s of highlights) {
			const box = strokeBox(s);
			items.push({ kind: "highlight", notebookPage: i + 1, pageId: page.id, asset: bg.asset, pdfPage: bg.page, text: boxes ? textUnderStroke(s, boxes) : "", x: box.minX, y: box.minY });
		}
		for (const el of page.elements ?? []) {
			if (el.type !== "text" || el.text.trim() === "") continue;
			items.push({ kind: "comment", notebookPage: i + 1, pageId: page.id, asset: bg.asset, pdfPage: bg.page, text: el.text.trim(), x: el.x, y: el.y });
		}
		items.sort((a, b) => a.y - b.y || a.x - b.x);
		out.push(...items);
	});
	return out;
}

/** Text that is shown literally in Markdown (no emphasis, links, tags, HTML or tables). */
export function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_[\]<>|#~=$])/g, "\\$1");
}

export interface AnnotationLabels {
	/** Document heading, e.g. "Annotations: {name}". */
	title: string;
	source: string;
	exported: string;
	/** "{pdf}, page {n}" heading of a notebook page. */
	pageHeading: (pdfName: string, pdfPage: number, notebookPage: number) => string;
	highlight: string;
	comment: string;
	/** Shown for a highlight without readable PDF text. */
	noText: string;
	/** Text of each item's link to its notebook page. */
	openPage: (notebookPage: number) => string;
}

export interface AnnotationNoteInput {
	items: readonly AnnotationItem[];
	/** Wikilink to the notebook, e.g. `[[Notebooks/Physics.notebook|Physics]]`. */
	notebookLink: string;
	/** Date shown under the title (already formatted). */
	date: string;
	/** Display name of an asset (its original file name). */
	pdfName: (asset: string) => string;
	/** URL that opens the notebook at a page (`obsidian://notebook?…`, see integration/links.ts). */
	pageUrl: (notebookPage: number, pageId?: string) => string;
	labels: AnnotationLabels;
}

/** Callout lines: every line of `text` quoted. */
function quoted(text: string): string[] {
	return text.split(/\r?\n/).map((l) => (l.trim() === "" ? ">" : `> ${l}`));
}

/** The Markdown note: one section per annotated notebook page, one callout per item, each with a link to its page. */
export function annotationsMarkdown(input: AnnotationNoteInput): string {
	const { labels } = input;
	const lines: string[] = [`# ${labels.title}`, "", `${labels.source}: ${input.notebookLink}`, `${labels.exported}: ${input.date}`];
	let current = -1;
	for (const it of input.items) {
		if (it.notebookPage !== current) {
			current = it.notebookPage;
			lines.push("", `## ${escapeMarkdown(labels.pageHeading(input.pdfName(it.asset), it.pdfPage, it.notebookPage))}`);
		}
		lines.push("");
		if (it.kind === "highlight") {
			lines.push(`> [!quote] ${labels.highlight}`);
			lines.push(...quoted(it.text ? escapeMarkdown(it.text) : `*${labels.noText}*`));
		} else {
			lines.push(`> [!note] ${labels.comment}`);
			lines.push(...quoted(it.text));
		}
		// Parentheses would end the Markdown link early (encodeURIComponent keeps them).
		const url = input.pageUrl(it.notebookPage, it.pageId).replace(/\(/g, "%28").replace(/\)/g, "%29");
		lines.push(">", `> [${labels.openPage(it.notebookPage)}](${url})`);
	}
	lines.push("");
	return lines.join("\n");
}

/** `<dir>/<base>.<ext>`, or `<base> 2`, `<base> 3`… when taken: an existing note is never overwritten. */
export function uniquePath(exists: (path: string) => boolean, dir: string, base: string, ext: string): string {
	const prefix = dir && dir !== "/" ? `${dir.replace(/\/+$/, "")}/` : "";
	const clean = base.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim() || "Annotations";
	let path = `${prefix}${clean}.${ext}`;
	for (let i = 2; exists(path); i++) path = `${prefix}${clean} ${i}.${ext}`;
	return path;
}
