/**
 * 0.18 (#59) Selection into a Markdown note: the pure text side (no DOM, no 'obsidian'). A region of a page is drawn as a picture
 * (PNG, or a cropped SVG of the page) and its embed `![[picture|400]]`, with an optional link back to the page, is put into a note.
 * Nothing here changes the document format.
 */
import { embedWithWidth } from "./selection-task";

export const INSERT_WIDTH_MIN = 100;
export const INSERT_WIDTH_MAX = 1600;
export const INSERT_WIDTH_DEFAULT = 400;
export const INSERT_WIDTH_STEP = 50;

export type InsertBackground = "transparent" | "paper";
export type InsertKind = "png" | "svg";

/** A width setting kept in range (anything that is not a finite number gives the default). */
export function clampInsertWidth(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return INSERT_WIDTH_DEFAULT;
	return Math.min(INSERT_WIDTH_MAX, Math.max(INSERT_WIDTH_MIN, Math.round(value)));
}

export function isInsertBackground(v: unknown): v is InsertBackground {
	return v === "transparent" || v === "paper";
}

/** File name of the picture: `<Notebook> p<page>-<HHmmss>.png|svg`. */
export function insertPictureName(notebook: string, pageNumber: number, stamp: string, kind: InsertKind): string {
	return `${notebook} p${pageNumber}-${stamp}.${kind}`;
}

export interface InsertParts {
	/** The embed Obsidian generated for the stored picture (`![[x.png]]` or `![](x.png)`). */
	embed: string;
	width: number;
	/** The link to the page (already in the user's link style), or null for no link back. */
	pageLink: string | null;
	/** The text of the link back (`↩` for a wikilink alias is built by the caller). */
}

/** The inserted text: the picture, then (when asked) the link back after a space. No line breaks inside. */
export function buildInsertLine(parts: InsertParts): string {
	const image = embedWithWidth(parts.embed, parts.width);
	return parts.pageLink ? `${image} ${parts.pageLink}` : image;
}

/**
 * The text put at a cursor: a block of its own, so the picture never lands in the middle of a sentence. `before` is the text on
 * the cursor's line before it, `after` the text after it.
 */
export function insertionAtCursor(line: string, before: string, after: string): string {
	const lead = before === "" ? "" : "\n";
	const tail = after === "" ? "" : "\n";
	return `${lead}${line}${tail}`;
}

/** `current` with `line` added as a block at the end (a blank line apart; the note's own ending is kept). */
export function appendInsertBlock(current: string, line: string): string {
	if (current === "") return `${line}\n`;
	const end = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
	return `${current}${end}${line}\n`;
}

const PT_TO_MM = 25.4 / 72;
const num = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * `svg` (a page written by pageToSvg) shown through a window: only the root element's size and viewBox change, so the ink,
 * the paper and the pictures stay as they are and what lies outside the window is clipped by the viewer.
 * Returns null when the text does not start like a page SVG.
 */
export function cropSvg(svg: string, rect: { x: number; y: number; width: number; height: number }): string | null {
	const m = /^<svg\b[^>]*>/.exec(svg);
	if (!m) return null;
	const root = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(rect.width * PT_TO_MM)}mm" height="${num(rect.height * PT_TO_MM)}mm" viewBox="${num(rect.x)} ${num(rect.y)} ${num(rect.width)} ${num(rect.height)}">`;
	return root + svg.slice(m[0].length);
}

export interface InsertPoint {
	line: number;
	ch: number;
	/** The text on that line before the point / after it (what `insertionAtCursor` needs). */
	before: string;
	after: string;
}

/**
 * Where the block goes for a cursor. A cursor inside the front matter (its closing `---` is on line `frontmatterEnd`, 0-based, or
 * null when the note has none) would break the properties, so the block goes on the first line after it instead (at the end of the
 * last line when the front matter is the whole note). `getLine` reads a line of the note, `lastLine` is the index of its last line.
 */
export function insertPoint(
	cursor: { line: number; ch: number }, frontmatterEnd: number | null, getLine: (line: number) => string, lastLine: number,
): InsertPoint {
	const inside = frontmatterEnd !== null && cursor.line <= frontmatterEnd;
	if (!inside) {
		const text = getLine(cursor.line);
		return { line: cursor.line, ch: cursor.ch, before: text.slice(0, cursor.ch), after: text.slice(cursor.ch) };
	}
	const next = (frontmatterEnd ?? 0) + 1;
	if (next > lastLine) {
		const text = getLine(lastLine);
		return { line: lastLine, ch: text.length, before: text, after: "" };
	}
	return { line: next, ch: 0, before: "", after: getLine(next) };
}

/** Whether the editor picked before the (async) drawing still shows the note the block is for, in source mode; if not, the block is appended to the note instead. */
export function editorStillTargets(viewPath: string | undefined, notePath: string, mode: string): boolean {
	return viewPath === notePath && mode === "source";
}
