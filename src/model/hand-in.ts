// 0.24 handin (#334): "Hand in…": which pages go into the PDF, what is still open on them, and the cover page that opens the file.
// Pure rules, no DOM and no 'obsidian'. Nothing here touches the notebook: the pre-flight only reads pages, and the cover is a
// throw-away page built for the export (never added to the document).
import { layoutText } from "../ink/text-layout";
import { helveticaWidth } from "../pdf/helvetica";
import { boxBounds } from "./markers";
import { createId, createStroke, quantizePoint } from "./document";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, type Page, type PageElement, type Stroke, type TextElement } from "./types";

// --- which pages ---

/**
 * The pages the dialog starts with: the pages picked in the page panel when there are some, else the current page.
 * Indices are 0-based, ascending, unique and inside the notebook; never empty for a notebook with pages.
 */
export function defaultHandInPages(pageCount: number, current: number, picked: readonly number[] = []): number[] {
	if (pageCount <= 0) return [];
	const valid = [...new Set(picked.filter((i) => Number.isInteger(i) && i >= 0 && i < pageCount))].sort((a, b) => a - b);
	if (valid.length > 0) return valid;
	return [Math.min(pageCount - 1, Math.max(0, Math.trunc(current) || 0))];
}

/** `chosen` after flipping page `index`. */
export function togglePage(chosen: readonly number[], index: number): number[] {
	const set = new Set(chosen);
	if (set.has(index)) set.delete(index);
	else set.add(index);
	return [...set].sort((a, b) => a - b);
}

/** Every page of the notebook, or none. */
export function allPages(pageCount: number): number[] {
	return Array.from({ length: Math.max(0, pageCount) }, (_, i) => i);
}

// --- pre-flight ---

export const OPEN_KINDS = ["gap", "question", "homework", "checkbox", "todo", "emptyBox"] as const;
export type OpenKind = (typeof OPEN_KINDS)[number];

/** One kind of open thing on one page. `sample` is a short text of the first one (a question, a box title, the TODO line). */
export interface OpenFinding {
	/** 0-based page index. */
	page: number;
	kind: OpenKind;
	count: number;
	sample?: string;
}

export interface HandInCheck {
	/** 0-based indices of the chosen pages that have nothing on them. */
	blank: number[];
	open: OpenFinding[];
	/** Nothing to report. */
	clean: boolean;
}

/** Text that marks work still to do. */
const TODO_TEXT = /\b(?:TODO|FIXME|TBD|XXX)\b|\?\?\?/i;
const SAMPLE_MAX = 60;

const clip = (s: string): string => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > SAMPLE_MAX ? `${one.slice(0, SAMPLE_MAX - 1)}…` : one;
};

/** A page nothing was written or put on (ink that is hidden does not count as written), with no PDF or picture under it. */
export function isBlankForHandIn(page: Page): boolean {
	// 0.29 (#10, review fix T7): study tapes are left out of what is handed in, so a page that holds only tapes is blank.
	return !page.strokes.some((s) => !s.hidden) && !(page.elements ?? []).some((e) => e.type !== "tape") && !page.background;
}

/** A structured box (a template box) with nothing inside it: no visible ink touching it and no other element over it. */
function emptyBoxes(page: Page): PageElement[] {
	const boxes = (page.elements ?? []).filter((e) => e.type === "box");
	if (boxes.length === 0) return [];
	const others = (page.elements ?? []).filter((e) => e.type !== "box" && e.type !== "marker");
	return boxes.filter((b) => {
		if (b.type !== "box") return false;
		const r = boxBounds(b);
		const hits = (minX: number, minY: number, maxX: number, maxY: number): boolean => maxX >= r.minX && minX <= r.maxX && maxY >= r.minY && minY <= r.maxY;
		for (const s of page.strokes) {
			if (s.hidden) continue;
			for (const [x, y] of s.points) if (x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY) return false;
		}
		for (const e of others) {
			const bb = elementRect(e);
			if (bb && hits(bb.minX, bb.minY, bb.maxX, bb.maxY)) return false;
		}
		return true;
	});
}

/** The rectangle of an element that has a plain one (text is approximated by its first line). */
function elementRect(e: PageElement): { minX: number; minY: number; maxX: number; maxY: number } | null {
	switch (e.type) {
		case "text": return { minX: e.x, minY: e.y, maxX: e.x + e.width, maxY: e.y + e.fontSize * 1.25 };
		case "checkbox": return { minX: e.x, minY: e.y, maxX: e.x + e.size, maxY: e.y + e.size };
		case "image": case "equation": case "graph": case "excerpt": case "sticky": case "area": return { minX: e.x, minY: e.y, maxX: e.x + e.width, maxY: e.y + e.height };
		default: return null;
	}
}

/** What is still open on one page, by kind (kinds in the order of OPEN_KINDS). */
export function openOnPage(page: Page, index: number): OpenFinding[] {
	const counts = new Map<OpenKind, { count: number; sample?: string }>();
	const add = (kind: OpenKind, sample?: string): void => {
		const row = counts.get(kind);
		if (row) row.count++;
		else counts.set(kind, { count: 1, ...(sample ? { sample: clip(sample) } : {}) });
	};
	for (const e of page.elements ?? []) {
		if (e.type === "marker") {
			if ((e.kind === "gap" || e.kind === "question" || e.kind === "homework") && !e.done) add(e.kind, e.text);
		} else if (e.type === "checkbox") {
			if (!e.checked) add("checkbox", e.label);
		} else if (e.type === "text") {
			const m = TODO_TEXT.exec(e.text);
			if (m) {
				const line = e.text.split("\n").find((l) => TODO_TEXT.test(l)) ?? e.text;
				add("todo", line);
			}
		}
	}
	for (const b of emptyBoxes(page)) add("emptyBox", b.type === "box" ? b.title : undefined);
	return OPEN_KINDS.filter((k) => counts.has(k)).map((kind) => {
		const row = counts.get(kind)!;
		return { page: index, kind, count: row.count, ...(row.sample ? { sample: row.sample } : {}) };
	});
}

/** The pre-flight of the chosen pages (`pages` is the whole notebook as exported; `chosen` are 0-based indices). */
export function handInCheck(pages: readonly Page[], chosen: readonly number[]): HandInCheck {
	const order = [...new Set(chosen)].filter((i) => i >= 0 && i < pages.length).sort((a, b) => a - b);
	const blank: number[] = [];
	const open: OpenFinding[] = [];
	for (const i of order) {
		const page = pages[i]!;
		if (isBlankForHandIn(page)) blank.push(i);
		else open.push(...openOnPage(page, i));
	}
	return { blank, open, clean: blank.length === 0 && open.length === 0 };
}

/** Drops pages from the choice (the "leave out" button of a blank page). */
export function withoutPages(chosen: readonly number[], drop: readonly number[]): number[] {
	const gone = new Set(drop);
	return chosen.filter((i) => !gone.has(i));
}

// --- cover ---

export interface CoverFields {
	name: string;
	course: string;
	title: string;
	/** Already written the way the reader reads dates. */
	date: string;
	/** Small line at the foot ("5 pages"); empty: none. */
	footer?: string;
}

export const COVER_FIELD_MAX = 120;

/** A field as typed, cleaned to one line of bounded length. */
export function cleanCoverField(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, COVER_FIELD_MAX);
}

export interface CoverBlock {
	kind: "title" | "label" | "value" | "footer";
	text: string;
	x: number;
	y: number;
	width: number;
	size: number;
	/** Height the block takes, pt. */
	height: number;
}

export const COVER_INK = "#1e1e1e";
export const COVER_MUTED = "#6a6f7a";
const MARGIN_SHARE = 0.14;
const TITLE_SIZE = 30;
const LABEL_SIZE = 10;
const VALUE_SIZE = 17;
const FOOTER_SIZE = 10;
const LINE = 1.25;

/**
 * Where the pieces of the cover go on a page of `size`: the title, a rule, then name, course and date, each as a small label
 * over its value; empty fields are left out. Blocks never overlap and stay inside the margins.
 */
export function coverBlocks(fields: CoverFields, size: { width: number; height: number }): CoverBlock[] {
	const x = Math.round(size.width * MARGIN_SHARE);
	const width = size.width - 2 * x;
	const height = (text: string, fontSize: number): number => layoutText(text, fontSize, width, (s) => helveticaWidth(s, fontSize)).lines.length * fontSize * LINE;
	const blocks: CoverBlock[] = [];
	let y = Math.round(size.height * 0.22);
	const title = cleanCoverField(fields.title);
	if (title) {
		const h = height(title, TITLE_SIZE);
		blocks.push({ kind: "title", text: title, x, y, width, size: TITLE_SIZE, height: h });
		y += h + 40;
	} else {
		y += 24;
	}
	const rows: [string, string][] = [["name", fields.name], ["course", fields.course], ["date", fields.date]];
	for (const [label, raw] of rows) {
		const value = cleanCoverField(raw);
		if (!value) continue;
		const lh = LABEL_SIZE * LINE;
		blocks.push({ kind: "label", text: label, x, y, width, size: LABEL_SIZE, height: lh });
		y += lh + 3;
		const vh = height(value, VALUE_SIZE);
		blocks.push({ kind: "value", text: value, x, y, width, size: VALUE_SIZE, height: vh });
		y += vh + 20;
	}
	const footer = cleanCoverField(fields.footer ?? "");
	if (footer) {
		const h = height(footer, FOOTER_SIZE);
		blocks.push({ kind: "footer", text: footer, x, y: Math.round(size.height - x * 0.8 - h), width, size: FOOTER_SIZE, height: h });
	}
	return blocks;
}

/** Y of the rule under the title (or where the title would be), pt; the cover draws it between the title and the first field. */
export function coverRuleY(blocks: readonly CoverBlock[], size: { width: number; height: number }): number {
	const title = blocks.find((b) => b.kind === "title");
	return title ? title.y + title.height + 18 : Math.round(size.height * 0.22) + 8;
}

/**
 * The cover as a page. `labels` are the words of the small captions (name, course, date), supplied translated by the caller.
 * Plain text boxes and one rule: it goes through the ordinary PDF export, so it looks like every other page of the file.
 */
export function coverPage(fields: CoverFields, labels: { name: string; course: string; date: string }, like?: { width: number; height: number; infinite?: boolean }): Page {
	const size = like && !like.infinite && like.width > 0 && like.height > 0 ? { width: like.width, height: like.height } : { width: A4_WIDTH, height: A4_HEIGHT };
	const blocks = coverBlocks(fields, size);
	const words: Record<string, string> = labels;
	const elements: TextElement[] = blocks.map((b) => ({
		id: createId(), type: "text", x: b.x, y: b.y, width: b.width, fontSize: b.size,
		text: b.kind === "label" ? (words[b.text] ?? b.text).toUpperCase() : b.text,
		color: b.kind === "label" || b.kind === "footer" ? COVER_MUTED : COVER_INK,
	}));
	const x = Math.round(size.width * MARGIN_SHARE);
	const ry = coverRuleY(blocks, size);
	const rule: Stroke = createStroke(COVER_INK, 1.5, [quantizePoint(x, ry, 0.5), quantizePoint(x + 64, ry, 0.5)], "pen");
	return { id: createId(), width: size.width, height: size.height, paper: { kind: "blank", spacing: PAPER_SPACING.blank }, strokes: [rule], elements };
}
