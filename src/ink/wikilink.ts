/**
 * Wikilinks in the text of a text box (`[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`): finding them, and the text a reader
 * sees instead of the markup. Pure: no 'obsidian', and no layout code, so `text-layout.ts` can use it without a cycle.
 * Nothing here is persisted: a link is just text in a text element, so the file format is unchanged.
 */
import { captionShown, figureLabel, figureTokens, FIGURE_TARGET_PREFIX, hasFigureTokens, type FigureToken } from "./figure-text";

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

// ------------------------------------------------------------------- what is shown

/** File extensions dropped from a note name shown as a link label. */
const SHOWN_EXTENSIONS = /\.(notebook|md|pdf|png|jpe?g|webp|gif|canvas|base)$/i;

/**
 * What a link without an alias shows: the name of the target without its folders and extension, then the place in it. A page
 * reference (`#p14&id=…`) becomes `p. 14`, a heading `› Heading`; a block reference (`#^id`) adds nothing.
 */
export function linkLabel(link: Pick<TextLink, "target" | "subpath" | "alias">): string {
	if (link.alias) return link.alias;
	const slash = link.target.lastIndexOf("/");
	const name = (slash < 0 ? link.target : link.target.slice(slash + 1)).replace(SHOWN_EXTENSIONS, "").trim() || link.target;
	const sub = link.subpath;
	if (sub === "" || sub.startsWith("^")) return name;
	const page = /^p(\d+)(?:&|$)/.exec(sub);
	if (page) return `${name} p. ${page[1]}`;
	return `${name} › ${sub}`;
}

/** The text of a box as it is read, and where each link is in it. */
export interface ShownText {
	text: string;
	/** The links with `start` and `end` in `text` (all other fields as written). */
	links: TextLink[];
}

/**
 * The text a reader sees for the markup `text`: every link replaced by its label (the alias, else a short name). The layout,
 * the drawing, the exports, the thumbnails and the tap areas of a text box all work on this; the editor and the file keep
 * the raw markup. Text without a link comes back as it is (line endings normalised to `\n`).
 */
export function shownText(text: string): ShownText {
	const src = normalize(text);
	const links = parseLinks(src);
	// 0.29 (#248): figure markers inside a link are part of the link; the others show the figure's current number.
	const tokens = hasFigureTokens(src) ? figureTokens(src).filter((t) => !links.some((l) => t.start >= l.start && t.start < l.end)) : [];
	if (links.length === 0 && tokens.length === 0) return { text: src, links: [] };
	interface Piece { start: number; end: number; link?: TextLink; token?: FigureToken }
	const pieces: Piece[] = [
		...links.map((link): Piece => ({ start: link.start, end: link.end, link })),
		...tokens.map((token): Piece => ({ start: token.start, end: token.end, token })),
	].sort((a, b) => a.start - b.start);
	let out = "";
	let at = 0;
	const shown: TextLink[] = [];
	for (const piece of pieces) {
		out += src.slice(at, piece.start);
		if (piece.link) {
			const label = linkLabel(piece.link);
			shown.push({ ...piece.link, start: out.length, end: out.length + label.length });
			out += label;
		} else if (piece.token && piece.token.kind === "cap") {
			out += captionShown(piece.token.id, src.slice(piece.end));
		} else if (piece.token) {
			const label = figureLabel(piece.token.id);
			shown.push({
				start: out.length, end: out.length + label.length, inner: piece.token.id, target: FIGURE_TARGET_PREFIX + piece.token.id,
				subpath: "", alias: label, display: label,
			});
			out += label;
		}
		at = piece.end;
	}
	return { text: out + src.slice(at), links: shown };
}
