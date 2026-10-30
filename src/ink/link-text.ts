import type { TextElement } from "../model/types";
import type { BBox } from "./hit-test";
import { estimateMeasure, layoutText, LINE_HEIGHT, textElementBounds, type MeasureText } from "./text-layout";

/**
 * Links written in text boxes (O8): `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`. Pure: no 'obsidian'. Nothing here is
 * persisted: a link is just text in a text element, so the file format is unchanged and the companion note (which copies
 * text boxes verbatim) shows the same links to Obsidian's graph and backlinks.
 *
 * An "ink link" (a note attached to handwriting) is a text element whose whole text is one link, placed directly above
 * the ink with enough empty lines under the label that its box covers the ink: the box is the tap area, and the existing
 * rule "ink written on an object moves with it" (ink/attach.ts) keeps ink and link together.
 */

export interface TextLink {
	/** Index of `[[` in the text (line endings normalised to `\n`) and one past the closing `]]`. */
	start: number;
	end: number;
	/** Text between the brackets, as written. */
	inner: string;
	/** Note path or name (trimmed), before `#` and `|`. Never empty. */
	target: string;
	/** What follows `#` (heading, `^block`, `p3`), without the `#`; empty when absent. */
	subpath: string;
	alias: string | null;
	/** What a reader sees: the alias, else the written target (with its subpath). */
	display: string;
}

/** `[[…]]` on one line, not an embed (`![[…]]`) and not containing brackets itself. */
const LINK_RE = /(!?)\[\[([^[\]\r\n]+?)\]\]/g;

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

/** Splits the inside of a link into target, subpath and alias; null when there is no note name (`[[#Heading]]`, `[[|x]]`). */
export function splitLinkInner(inner: string): { target: string; subpath: string; alias: string | null } | null {
	const bar = inner.indexOf("|");
	const path = bar < 0 ? inner : inner.slice(0, bar);
	const alias = bar < 0 ? null : inner.slice(bar + 1).trim() || null;
	const hash = path.indexOf("#");
	const target = (hash < 0 ? path : path.slice(0, hash)).trim();
	if (target === "") return null;
	return { target, subpath: hash < 0 ? "" : path.slice(hash + 1).trim(), alias };
}

/** The text Obsidian resolves: the link without its alias (`Note#Heading`). */
export function linktextOf(link: Pick<TextLink, "target" | "subpath">): string {
	return link.subpath ? `${link.target}#${link.subpath}` : link.target;
}

/** Every link in `text`, in order. */
export function parseLinks(text: string): TextLink[] {
	const src = normalize(text);
	if (!src.includes("[[")) return [];
	const out: TextLink[] = [];
	for (const m of src.matchAll(LINK_RE)) {
		if (m[1] === "!") continue;
		const inner = m[2]!;
		const parts = splitLinkInner(inner);
		if (!parts) continue;
		const start = m.index + m[1]!.length;
		const written = inner.slice(0, inner.indexOf("|") < 0 ? inner.length : inner.indexOf("|")).trim();
		out.push({ start, end: m.index + m[0].length, inner, ...parts, display: parts.alias ?? written });
	}
	return out;
}

/** `[[linktext]]` or `[[linktext|alias]]`; `|` and brackets are stripped from the alias. */
export function linkMarkup(linktext: string, alias?: string): string {
	const clean = (s: string) => s.replace(/[[\]|\r\n]+/g, " ").trim();
	const a = alias === undefined ? "" : clean(alias);
	return a && a !== linktext ? `[[${clean(linktext)}|${a}]]` : `[[${clean(linktext)}]]`;
}

/** The link when the text is only that (an "ink link" or a one-link text box), else null. */
export function soleLink(text: string): TextLink | null {
	const links = parseLinks(text);
	if (links.length !== 1) return null;
	const src = normalize(text);
	const l = links[0]!;
	return src.slice(0, l.start).trim() === "" && src.slice(l.end).trim() === "" ? l : null;
}

// ------------------------------------------------------------------- layout

export interface LineRun {
	text: string;
	link: TextLink | null;
}

/**
 * The wrapped `lines` of `text` (from `layoutText`) cut into plain and linked runs. Wrapping only drops spaces and
 * breaks inside words, so every line is a substring of the text, found in order.
 */
export function lineRuns(text: string, lines: readonly string[], links: readonly TextLink[]): LineRun[][] {
	const src = normalize(text);
	let cursor = 0;
	return lines.map((line) => {
		const found = line === "" ? cursor : src.indexOf(line, cursor);
		const from = found < 0 ? cursor : found;
		const to = from + line.length;
		cursor = to;
		const runs: LineRun[] = [];
		let at = from;
		for (const link of links) {
			const a = Math.max(from, link.start);
			const b = Math.min(to, link.end);
			if (b <= a) continue;
			if (a > at) runs.push({ text: src.slice(at, a), link: null });
			runs.push({ text: src.slice(a, b), link });
			at = b;
		}
		if (at < to || runs.length === 0) runs.push({ text: src.slice(at, to), link: null });
		return runs;
	});
}

export interface LinkRect {
	link: TextLink;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Where each link of a text box is on the page: one rectangle per wrapped line it covers. */
export function linkRects(el: TextElement, measure: MeasureText = estimateMeasure): LinkRect[] {
	const links = parseLinks(el.text);
	if (links.length === 0) return [];
	const m = (s: string) => measure(s, el.fontSize);
	const layout = layoutText(el.text, el.fontSize, el.width, m);
	const out: LinkRect[] = [];
	lineRuns(el.text, layout.lines, links).forEach((runs, i) => {
		let x = el.x;
		for (const run of runs) {
			const w = m(run.text);
			if (run.link) out.push({ link: run.link, x, y: el.y + i * layout.lineHeight, width: w, height: layout.lineHeight });
			x += w;
		}
	});
	return out;
}

export interface LinkHit {
	element: TextElement;
	link: TextLink;
	/** The element is only a link (an ink link): its whole box is the tap area. */
	whole: boolean;
}

function inside(b: BBox, x: number, y: number, tol: number): boolean {
	return x >= b.minX - tol && x <= b.maxX + tol && y >= b.minY - tol && y <= b.maxY + tol;
}

/** The link under (x, y), topmost text first; `tol` pt of slack around links. */
export function hitLink(elements: readonly unknown[], x: number, y: number, tol: number, measure: MeasureText = estimateMeasure): LinkHit | null {
	for (let i = elements.length - 1; i >= 0; i--) {
		const el = elements[i] as TextElement;
		if (!el || el.type !== "text" || typeof el.text !== "string" || !el.text.includes("[[")) continue;
		const sole = soleLink(el.text);
		if (sole) {
			if (inside(textElementBounds(el, measure), x, y, tol)) return { element: el, link: sole, whole: true };
			continue;
		}
		for (const r of linkRects(el, measure)) {
			if (x >= r.x - tol && x <= r.x + r.width + tol && y >= r.y - tol && y <= r.y + r.height + tol) {
				return { element: el, link: r.link, whole: false };
			}
		}
	}
	return null;
}

/** All links of the text elements, in reading order (for the companion note and "Open link" lists). */
export function pageLinks(elements: readonly unknown[]): TextLink[] {
	const texts = elements.filter((e): e is TextElement => typeof e === "object" && e !== null && (e as TextElement).type === "text");
	return texts.flatMap((e) => (typeof e.text === "string" ? parseLinks(e.text) : []));
}

// ------------------------------------------------------------------- ink links

/** Label size of an ink link, in pt. */
export const INK_LINK_FONT_SIZE = 10;
/** Most empty lines under the label: bounds the box of a link on a huge region. */
const MAX_COVER_LINES = 120;
const MIN_LABEL_WIDTH = 60;

/**
 * The text element for a note attached to the ink inside `region`: the label sits directly above the region (on it when
 * the region touches the top of the page) and empty lines below the label stretch the box down over the ink, so
 * the box is the tap area and ink written on it floats with it.
 */
export function inkLinkElement(
	id: string, region: BBox, linktext: string, page: { width: number; height: number }, color: string,
	measure: MeasureText = estimateMeasure, fontSize = INK_LINK_FONT_SIZE,
): TextElement {
	const markup = linkMarkup(linktext);
	const lineHeight = fontSize * LINE_HEIGHT;
	const labelWidth = measure(markup, fontSize) + 2;
	const width = Math.min(page.width, Math.max(MIN_LABEL_WIDTH, region.maxX - region.minX, labelWidth));
	const x = Math.max(0, Math.min(region.minX, page.width - width));
	const y = Math.max(0, Math.min(region.minY - lineHeight - 2, page.height - lineHeight));
	const lines = Math.min(MAX_COVER_LINES, Math.max(1, Math.ceil((Math.min(region.maxY, page.height) - y) / lineHeight)));
	const round2 = (v: number) => Math.round(v * 100) / 100;
	return { id, type: "text", x: round2(x), y: round2(y), width: round2(width), text: markup + "\n".repeat(lines - 1), fontSize, color };
}

// ------------------------------------------------------------------- typing `[[`

export interface LinkTrigger {
	/** Index where the typed link text starts (just after `[[`). */
	start: number;
	/** What was typed after `[[`, up to the cursor. */
	query: string;
}

/**
 * The link being typed at `cursor`: an unclosed `[[` earlier on the same line, with no bracket after it. `|` ends the
 * suggestions (the alias is free text).
 */
export function linkTrigger(text: string, cursor: number): LinkTrigger | null {
	const before = text.slice(0, cursor);
	const open = before.lastIndexOf("[[");
	if (open < 0) return null;
	const query = before.slice(open + 2);
	if (/[\]\n\r|]/.test(query) || query.includes("[")) return null;
	return { start: open + 2, query };
}

/** Replaces the typed `[[query` (and a `]]` right after the cursor) with a finished `[[linktext]]`; returns the new text and cursor. */
export function completeLink(text: string, trigger: LinkTrigger, cursor: number, linktext: string): { text: string; cursor: number } {
	const closed = text.slice(cursor, cursor + 2) === "]]";
	const head = text.slice(0, trigger.start) + linktext + "]]";
	return { text: head + text.slice(cursor + (closed ? 2 : 0)), cursor: head.length };
}

// ------------------------------------------------------------------- ranking

export interface NoteEntry {
	path: string;
	basename: string;
	mtime: number;
}

function subsequence(needle: string, hay: string): boolean {
	let i = 0;
	for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
	return needle.length === 0;
}

/** Match quality of `query` against a note (0 = no match). Name matches beat folder matches; earlier and tighter beat later. */
export function noteScore(query: string, note: NoteEntry): number {
	const q = query.trim().toLowerCase();
	if (q === "") return 1;
	const name = note.basename.toLowerCase();
	if (name === q) return 100;
	if (name.startsWith(q)) return 80;
	if (name.split(/[\s\-_/.]+/).some((w) => w.startsWith(q))) return 60;
	if (name.includes(q)) return 50;
	if (note.path.toLowerCase().includes(q)) return 30;
	return subsequence(q.replace(/\s+/g, ""), name) ? 10 : 0;
}

/** Notes matching `query`, best first (an empty query lists the most recently modified); at most `limit`. */
export function rankNotes(query: string, notes: readonly NoteEntry[], limit = 40): NoteEntry[] {
	return notes
		.map((n) => ({ n, s: noteScore(query, n) }))
		.filter((x) => x.s > 0)
		.sort((a, b) => b.s - a.s || (a.s === 1 ? b.n.mtime - a.n.mtime : a.n.basename.length - b.n.basename.length) || a.n.path.localeCompare(b.n.path))
		.slice(0, limit)
		.map((x) => x.n);
}

/** Headings of a note that match `query` (empty: all), in document order, at most `limit`. */
export function rankHeadings(query: string, headings: readonly string[], limit = 40): string[] {
	const q = query.trim().toLowerCase();
	return headings.filter((h) => q === "" || h.toLowerCase().includes(q)).slice(0, limit);
}

// ------------------------------------------------------------------- new notes

/** Characters a note name cannot contain in Obsidian (they would also break links). */
const BAD_NAME = /[\\:*?"<>|#^[\]]/;

/**
 * Vault path for a note created from an unresolved link: a name with folders (`a/b`) is taken from the vault root, a bare
 * name goes to `defaultFolder` (Obsidian's "new note" location). Null when the name cannot be a file name.
 */
export function newNotePath(target: string, defaultFolder: string): { path: string; folder: string; name: string } | null {
	const clean = target.trim().replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "");
	if (clean === "") return null;
	const parts = clean.split("/");
	if (parts.some((p) => p.trim() === "" || p === "." || p === ".." || BAD_NAME.test(p))) return null;
	const name = parts[parts.length - 1]!;
	const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : defaultFolder.replace(/^\/+|\/+$/g, "");
	return { path: folder ? `${folder}/${name}.md` : `${name}.md`, folder, name };
}

// ------------------------------------------------------------------- drawing

/** Link colour on the paper, and the badge fill. Fixed: pages are paper, not theme. */
export const LINK_COLOR = "#2563eb";

/** Tells whether a note exists; the view installs it. Unresolved links are drawn dimmed. Null: everything counts as resolved. */
export type LinkResolver = (target: string) => boolean;

let resolver: LinkResolver | null = null;

export function setLinkResolver(fn: LinkResolver | null): void {
	resolver = fn;
}

export function currentLinkResolver(): LinkResolver | null {
	return resolver;
}

/**
 * Draws the wrapped lines of a text box that contains links: links in the link colour, underlined, dimmed when the note
 * does not exist; an ink link also gets a small badge after its label and a faint tint over its box.
 * The text keeps its exact layout (the brackets stay visible), so wrapping, bounds and the editor never disagree.
 */
export function drawLinkedLines(
	ctx: CanvasRenderingContext2D, el: TextElement, lines: readonly string[], lineHeight: number, links: readonly TextLink[],
): void {
	const runs = lineRuns(el.text, lines, links);
	const resolves = resolver;
	const sole = soleLink(el.text);
	if (sole && lines.length > 1) {
		ctx.save();
		ctx.globalAlpha = 0.07;
		ctx.fillStyle = LINK_COLOR;
		ctx.fillRect(el.x, el.y, el.width, lines.length * lineHeight);
		ctx.restore();
	}
	runs.forEach((line, i) => {
		const top = el.y + i * lineHeight + (lineHeight - el.fontSize) / 2;
		let x = el.x;
		for (const run of line) {
			const w = ctx.measureText(run.text).width;
			if (run.link) {
				const ok = resolves ? resolves(run.link.target) : true;
				ctx.save();
				ctx.globalAlpha = ok ? 1 : 0.45;
				ctx.fillStyle = LINK_COLOR;
				ctx.fillText(run.text, x, top);
				const y = top + el.fontSize * 1.05;
				ctx.strokeStyle = LINK_COLOR;
				ctx.lineWidth = Math.max(0.5, el.fontSize / 14);
				if (!ok) ctx.setLineDash([el.fontSize / 4, el.fontSize / 4]);
				ctx.beginPath();
				ctx.moveTo(x, y);
				ctx.lineTo(x + w, y);
				ctx.stroke();
				ctx.restore();
			} else {
				ctx.fillText(run.text, x, top);
			}
			x += w;
		}
		if (sole && i === 0) drawBadge(ctx, x, el.y + lineHeight / 2, el.fontSize, resolves ? resolves(sole.target) : true);
	});
}

/** A small round badge with an arrow: this label is a link to a note. */
function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, fontSize: number, ok: boolean): void {
	const r = fontSize * 0.55;
	ctx.save();
	ctx.globalAlpha = ok ? 0.9 : 0.4;
	ctx.fillStyle = LINK_COLOR;
	ctx.beginPath();
	ctx.arc(x + r + 3, y, r, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = Math.max(0.6, fontSize / 10);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	const c = x + r + 3;
	const k = r * 0.42;
	ctx.beginPath();
	ctx.moveTo(c - k, y + k);
	ctx.lineTo(c + k, y - k);
	ctx.moveTo(c - k * 0.1, y - k);
	ctx.lineTo(c + k, y - k);
	ctx.lineTo(c + k, y + k * 0.1);
	ctx.stroke();
	ctx.restore();
}
