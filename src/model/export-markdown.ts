// wave 0.9 (382): "Export as Markdown with page images", for people who do not use Obsidian. Pure: the Markdown text,
// the file names (never an existing one) and the size of the page renders. The view side (view/export-markdown.ts)
// draws the pages and writes the files through the vault API. No 'obsidian' import.
import { resolveFigureMarkers } from "../ink/figure-text";
import { outlineEntries } from "./bookmarks";
import { orderedNotes, repliesOf } from "./comments";
import { withFigureLabels } from "./figure-captions";
import { equationNumbers } from "./math-elements";
import type { CheckboxElement, EquationElement, NotebookMeta, Page, StickyElement, TextElement } from "./types";

/** Resolutions offered for the page images (dots per inch of the page at its real size). */
export const MARKDOWN_DPI = [100, 150, 200] as const;
export type MarkdownDpi = (typeof MARKDOWN_DPI)[number];
export const DEFAULT_MARKDOWN_DPI: MarkdownDpi = 150;

/** A page image is never larger than this on one side, nor than this many pixels (phones run out of memory first). */
export const MAX_RENDER_SIDE = 8192;
export const MAX_RENDER_PIXELS = 16_000_000;

export function isMarkdownDpi(v: unknown): v is MarkdownDpi {
	return typeof v === "number" && (MARKDOWN_DPI as readonly number[]).includes(v);
}

/** Pixels per pt for a page rendered at `dpi`, reduced for very large (infinite) pages. */
export function renderScale(page: { width: number; height: number }, dpi: number): number {
	const w = Math.max(1, page.width), h = Math.max(1, page.height);
	const wanted = Math.max(0.1, dpi) / 72;
	const bySide = MAX_RENDER_SIDE / Math.max(w, h);
	const byArea = Math.sqrt(MAX_RENDER_PIXELS / (w * h));
	return Math.min(wanted, bySide, byArea);
}

/** Pixel size of the image of `page` at `dpi` (at least 1×1). */
export function renderSize(page: { width: number; height: number }, dpi: number): { width: number; height: number; scale: number } {
	const scale = renderScale(page, dpi);
	return { width: Math.max(1, Math.round(page.width * scale)), height: Math.max(1, Math.round(page.height * scale)), scale };
}

/** `page-001.png`: the number has at least three digits, more when the notebook has more than 999 pages. */
export function pageImageName(index: number, count: number): string {
	const digits = Math.max(3, String(count).length);
	return `page-${String(index + 1).padStart(digits, "0")}.png`;
}

/**
 * A file name that `exists` does not know, in the style of Obsidian: `notebook.md`, then `notebook 2.md`, `notebook 3.md`…
 * `taken` also lists names chosen earlier in the same export.
 */
export function uniqueFileName(name: string, exists: (candidate: string) => boolean): string {
	if (!exists(name)) return name;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let i = 2; i < 100000; i++) {
		const candidate = `${stem} ${i}${ext}`;
		if (!exists(candidate)) return candidate;
	}
	throw new Error("no free file name");
}

/** The names of the files of one export inside `folder`: one image per page and the Markdown file, none existing yet. */
export function planMarkdownFiles(folder: string, count: number, exists: (path: string) => boolean): { images: string[]; markdown: string } {
	const dir = folder === "" || folder === "/" ? "" : `${folder.replace(/\/+$/, "")}/`;
	const chosen = new Set<string>();
	const taken = (name: string): boolean => chosen.has(name) || exists(`${dir}${name}`);
	const images: string[] = [];
	for (let i = 0; i < count; i++) {
		const name = uniqueFileName(pageImageName(i, count), taken);
		chosen.add(name);
		images.push(name);
	}
	const markdown = uniqueFileName("notebook.md", taken);
	return { images, markdown };
}

/** The link target of a file name: spaces and the characters that end a Markdown link are percent-encoded. */
export function linkTarget(name: string): string {
	return name.replace(/[ ()<>%\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** A line of user text that Markdown would turn into a heading, quote or list is kept as plain text. */
export function escapeTextLine(line: string): string {
	return line.replace(/^(\s{0,3})([#>+\-*]|\d+[.)]|={2,}|-{2,})(?=\s|$)/, (_m, space: string, mark: string) => `${space}\\${mark}`);
}

/**
 * The punctuation Markdown and Obsidian give a meaning anywhere in a line: emphasis and code (`* _ \``), links and
 * embeds (`[[`, `![[`, `[]`), tags (`#tag`), maths (`$`), comments (`%%`), highlights and strikes (`==`, `~~`), block
 * ids (`^`), tables (`|`), HTML and entities (`< > &`), braces. Each is escaped with a backslash (CommonMark removes
 * the backslash before any ASCII punctuation, Obsidian too), so a text box always shows its own text.
 */
const INLINE_SYNTAX = /[\\`*_[\]#$%=~^|<>&{}!]/g;

/** A line of a text box as literal text: inline syntax escaped, then a line start that would make a block. */
export function escapeMarkdownLine(line: string): string {
	return escapeTextLine(line.replace(INLINE_SYNTAX, (c) => `\\${c}`));
}

/**
 * A v9 equation as Obsidian maths: `$$…$$` for display style (with `\tag{n}` when it is numbered), `$…$` inline. The
 * source is written as it is (a `$` in it would end the block, so it is escaped).
 */
export function equationMarkdown(e: EquationElement, number?: number): string {
	const latex = e.latex.replace(/\r\n?/g, "\n").trim().replace(/\\?\$/g, (m) => (m === "$" ? "\\$" : m));
	if (e.inline) return `$${latex.replace(/\s*\n\s*/g, " ")}$`;
	const tag = number !== undefined ? ` \\tag{${number}}` : "";
	return `$$\n${latex}${tag}\n$$`;
}

/**
 * The text boxes, (v9) the equations and (v15) the typed text of the sticky notes of a page as paragraphs, in reading order
 * (top to bottom, then left to right); a note is a block quote. Graphs and handwriting are in the page image.
 */
export function pageTexts(page: Pick<Page, "elements">, numbers: ReadonlyMap<string, number> = new Map()): string[] {
	const items = (page.elements ?? []).filter((e): e is TextElement | EquationElement | StickyElement | CheckboxElement =>
		(e.type === "text" && e.text.trim() !== "") || (e.type === "equation" && e.latex.trim() !== "") || (e.type === "sticky" && (e.text ?? "").trim() !== "")
		|| (e.type === "checkbox" && (e.label ?? "") !== ""));
	items.sort((a, b) => a.y - b.y || a.x - b.x);
	const lines = (text: string) => text.replace(/\r\n?/g, "\n").trim().split("\n");
	return items.map((e) => {
		// v17: a checkbox with a typed label is a task-list item (the handwritten label is in the page image).
		if (e.type === "checkbox") return `- [${e.checked === true ? "x" : " "}] ${escapeMarkdownLine(e.label ?? "")}`;
		if (e.type === "equation") return equationMarkdown(e, numbers.get(e.id));
		if (e.type === "sticky") return lines(e.text ?? "").map((l) => `> ${escapeMarkdownLine(l)}`).join("\n");
		return lines(resolveFigureMarkers(e.text)).map(escapeMarkdownLine).join("  \n");
	});
}

/** The words and the date format of the comments list (translated and localised by the view). */
export interface CommentLabels {
	/** The line above the list, e.g. "Comments". */
	heading: string;
	/** After the author of a resolved comment, e.g. "resolved". */
	resolved: string;
	/** In place of the text of a comment that is only a sketch, e.g. "(sketch)". */
	sketch: string;
	/** A time of a comment, as the reader's language writes it. */
	when: (ms: number) => string;
}

/**
 * v16 (#86): the margin comments of a page as a list, for the Markdown export: a bold line, then a numbered list (the number is
 * the one on the page's marker) with the author and time, "resolved" when it is, and the text; replies are a nested list.
 * Empty when the page has no comments. Text is escaped like text boxes, so it always shows as written.
 */
export function commentsMarkdown(page: Pick<Page, "comments">, labels: CommentLabels): string[] {
	const notes = orderedNotes(page as Page);
	if (notes.length === 0) return [];
	const body = (text: string, indent: string): string =>
		text.replace(/\r\n?/g, "\n").trim().split("\n").map((l, i) => (i === 0 ? escapeMarkdownLine(l) : `${indent}${escapeMarkdownLine(l)}`)).join("\n");
	const who = (c: { author: string; created: number }, tail = "") => `${escapeMarkdownLine(c.author || "?")}, ${escapeMarkdownLine(labels.when(c.created))}${tail}`;
	const lines: string[] = [`**${escapeMarkdownLine(labels.heading)}**`, ""];
	notes.forEach((n, k) => {
		const text = n.text.trim() === "" ? escapeMarkdownLine(labels.sketch) : body(n.text, "   ");
		lines.push(`${k + 1}. ${who(n, n.resolved ? ` (${escapeMarkdownLine(labels.resolved)})` : "")}: ${text}`);
		for (const r of repliesOf(page as Page, n.id)) lines.push(`   - ${who(r)}: ${body(r.text, "     ")}`);
	});
	return [lines.join("\n")];
}

export interface NotebookMarkdownInput {
	/** The notebook's title (its file name). */
	title: string;
	pages: readonly Page[];
	meta: NotebookMeta | undefined;
	/** File name of each page's image, in page order (see `planMarkdownFiles`). */
	images: readonly string[];
	/** Heading of a bookmark that has no title, e.g. "Page 3". */
	pageLabel: (pageNumber: number) => string;
	/** v16: when given, the margin comments of every page are listed below its text. */
	comments?: CommentLabels;
}

/**
 * `notebook.md`: the title, then every page as its image, with the text of its text boxes below it. A bookmarked page
 * starts with a heading (the bookmark's title, or "Page n"). Hidden ink is not part of it: the images are drawn without.
 */
export function buildNotebookMarkdown(input: NotebookMarkdownInput): string {
	// 0.29 (#248): a figure caption or reference is written with its current number.
	return withFigureLabels(input.pages, () => notebookMarkdownOf(input));
}

function notebookMarkdownOf(input: NotebookMarkdownInput): string {
	const title = input.title.replace(/\s+/g, " ").trim();
	const out: string[] = [`# ${title === "" ? "Notebook" : title.replace(/^#+\s*/, "")}`];
	const bookmarks = new Map(outlineEntries(input.pages, input.meta).map((e) => [e.pageId, e]));
	const numbers = equationNumbers(input.pages);
	input.pages.forEach((page, i) => {
		const bookmark = bookmarks.get(page.id);
		if (bookmark) {
			const heading = bookmark.title.replace(/\s+/g, " ").trim() || input.pageLabel(i + 1);
			out.push(`## ${heading}`);
		}
		const image = input.images[i];
		if (image !== undefined) out.push(`![](${linkTarget(image)})`);
		out.push(...pageTexts(page, numbers));
		if (input.comments) out.push(...commentsMarkdown(page, input.comments));
	});
	return out.join("\n\n") + "\n";
}
