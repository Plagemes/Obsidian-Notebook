/**
 * 0.19 (#213) "Look up later": the pure text side (no DOM, no 'obsidian'). A circled word becomes one line of a Markdown note,
 * `- [ ] ![[crop|150]] word — [[Notebook#p3&id=…|Notebook p. 3]] (2026-11-04)`; the same note is read back to list the entries of
 * one notebook. Lines are only ever appended (the rest of the note is never rewritten). Nothing here changes the document format.
 */
import { cleanTaskText, escapeTaskText } from "./selection-task";

export const LOOKUP_WIDTH_MIN = 80;
export const LOOKUP_WIDTH_MAX = 400;
export const LOOKUP_WIDTH_DEFAULT = 150;
export const LOOKUP_WIDTH_STEP = 10;
/** Most characters of the typed word kept. */
export const LOOKUP_WORD_MAX = 120;
/** Most entries read back from the note for the sheet. */
export const LOOKUP_MAX_ENTRIES = 500;

/** A width setting kept in range (anything that is not a finite number gives the default). */
export function clampLookUpWidth(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return LOOKUP_WIDTH_DEFAULT;
	return Math.min(LOOKUP_WIDTH_MAX, Math.max(LOOKUP_WIDTH_MIN, Math.round(value)));
}

/** The note the entries go to: the setting, or `<notebooks folder>/Look up later.md`; always a vault-relative `.md` path. */
export function lookUpNotePath(setting: string, notebooksFolder: string): string {
	let path = setting.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
	if (path === "") {
		const folder = notebooksFolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		path = folder === "" ? "Look up later" : `${folder}/Look up later`;
	}
	return /\.md$/iu.test(path) ? path : `${path}.md`;
}

/** File name of the crop: `<Notebook> lookup p<page>-<HHmmss>.png`. */
export function lookUpPictureName(notebook: string, pageNumber: number, stamp: string): string {
	return `${notebook} lookup p${pageNumber}-${stamp}.png`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of a local date. */
export function lookUpDate(date: Date): string {
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The typed word as one safe line of text: collapsed, cut to `LOOKUP_WORD_MAX`, escaped; a stray ` — ` cannot be told from the separator, so it becomes a plain dash. */
export function lookUpWord(text: string): string {
	const clean = cleanTaskText(text).slice(0, LOOKUP_WORD_MAX).replace(/\s—(?=\s|$)/g, " -").replace(/\(\d{4}-\d{2}-\d{2}\)\s*$/, "");
	return escapeTaskText(clean.trim());
}

export interface LookUpLineParts {
	/** The picture embed, already with its width; null when the picture could not be made. */
	image: string | null;
	/** What the user typed (optional, may be empty). */
	word: string;
	/** The link to the page (already in the user's link style). */
	pageLink: string;
	date: string;
}

/** `- [ ] ![[crop|150]] word — [[page]] (date)`. No line breaks inside. */
export function buildLookUpLine(p: LookUpLineParts): string {
	const lead = ["- [ ]", p.image ?? "", lookUpWord(p.word)].filter((s) => s !== "").join(" ");
	return `${lead} — ${p.pageLink} (${p.date})`;
}

/** The note's text with `line` added at the end; null when that very line is already there. Everything before is returned byte for byte. */
export function appendLookUpLine(text: string, line: string): string | null {
	if (text.split(/\r?\n/).some((l) => l.trim() === line.trim())) return null;
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const sep = text === "" || text.endsWith("\n") ? "" : eol;
	return `${text}${sep}${line}${eol}`;
}

/** One line of the note, understood. */
export interface LookUpEntry {
	/** 0-based line in the note. */
	line: number;
	done: boolean;
	/** The word the user typed, unescaped (empty when none). */
	word: string;
	/** Vault path or link name of the picture, or null. */
	imagePath: string | null;
	/** Link target of the page link (path or name, no subpath). */
	linkPath: string;
	/** The page link's subpath without `#`, e.g. `p3&id=abc`. */
	subpath: string;
	/** Page number named by the link (1-based) or null. */
	page: number | null;
	/** Page id named by the link, or null. */
	pageId: string | null;
	/** `YYYY-MM-DD` or empty. */
	date: string;
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Splits `path#sub` (the first `#`). */
function splitTarget(target: string): { path: string; sub: string } {
	const i = target.indexOf("#");
	return i < 0 ? { path: target, sub: "" } : { path: target.slice(0, i), sub: target.slice(i + 1) };
}

/** The page number and id a subpath names (`p3&id=abc`, `page=3`, `3`). */
export function lookUpSubpath(sub: string): { page: number | null; pageId: string | null } {
	let page: number | null = null;
	let pageId: string | null = null;
	for (const part of sub.split("&")) {
		const id = /^id=(.+)$/.exec(part);
		if (id) {
			pageId = safeDecode(id[1] ?? "");
			continue;
		}
		const p = /^(?:p|page)?\s*[=-]?\s*(\d{1,6})$/i.exec(part.trim());
		if (p && page === null) {
			const n = Number(p[1]);
			if (n >= 1) page = n;
		}
	}
	return { page, pageId };
}

/** The link at the end of `rest`: its target path, subpath and the text that precedes it. Wiki links and Markdown links. */
function trailingLink(rest: string): { before: string; path: string; sub: string } | null {
	const wiki = /\[\[([^\]]*)\]\]$/.exec(rest);
	if (wiki && rest[wiki.index - 1] !== "!") {
		const target = (wiki[1] ?? "").split("|")[0] ?? "";
		const { path, sub } = splitTarget(target);
		return { before: rest.slice(0, wiki.index), path: path.trim(), sub };
	}
	const md = /\[[^\]]*\]\((<[^>]*>|[^)]*)\)$/.exec(rest);
	if (md && rest[md.index - 1] !== "!") {
		const raw = (md[1] ?? "").trim();
		const dest = raw.startsWith("<") ? raw.slice(1, -1) : raw;
		const { path, sub } = splitTarget(dest);
		return { before: rest.slice(0, md.index), path: safeDecode(path).trim(), sub: safeDecode(sub) };
	}
	return null;
}

/** The picture embed at the start of `lead`: its target and the text after it. */
function leadingImage(lead: string): { imagePath: string | null; text: string } {
	const wiki = /^!\[\[([^\]]*)\]\]\s*/.exec(lead);
	if (wiki) return { imagePath: ((wiki[1] ?? "").split("|")[0] ?? "").trim() || null, text: lead.slice(wiki[0].length) };
	const md = /^!\[[^\]]*\]\((<[^>]*>|[^)]*)\)\s*/.exec(lead);
	if (md) {
		const raw = (md[1] ?? "").trim();
		return { imagePath: safeDecode(raw.startsWith("<") ? raw.slice(1, -1) : raw).trim() || null, text: lead.slice(md[0].length) };
	}
	return { imagePath: null, text: lead };
}

/** The backslash escapes of `escapeTaskText` removed. */
function unescapeText(text: string): string {
	return text.replace(/\\([\\`*_[\]<$%#>+\-.)(])/g, "$1");
}

/** One line of the note as an entry; null when it is not a task line with a link to a notebook page. */
export function parseLookUpLine(text: string, lineNo = 0): LookUpEntry | null {
	const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*?)\s*$/.exec(text);
	if (!m) return null;
	let rest = m[2] ?? "";
	let date = "";
	const d = /\s\((\d{4}-\d{2}-\d{2})\)$/.exec(rest);
	if (d) {
		date = d[1] ?? "";
		rest = rest.slice(0, d.index);
	}
	const link = trailingLink(rest.trimEnd());
	if (!link || link.path === "") return null;
	const lead = link.before.replace(/\s*—\s*$/, "").trim();
	const { imagePath, text: word } = leadingImage(lead);
	const { page, pageId } = lookUpSubpath(link.sub);
	return { line: lineNo, done: m[1] !== " ", word: unescapeText(word.trim()), imagePath, linkPath: link.path, subpath: link.sub, page, pageId, date };
}

/** Every entry of the note, in order (bounded). */
export function parseLookUpNote(text: string): LookUpEntry[] {
	const out: LookUpEntry[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length && out.length < LOOKUP_MAX_ENTRIES; i++) {
		const e = parseLookUpLine(lines[i] ?? "", i);
		if (e) out.push(e);
	}
	return out;
}

/** The entries that point at the notebook (`pointsAtNotebook` resolves a link path the way Obsidian does); open ones are counted by `openCount`. */
export function entriesOfNotebook(entries: readonly LookUpEntry[], pointsAtNotebook: (linkPath: string) => boolean): LookUpEntry[] {
	return entries.filter((e) => pointsAtNotebook(e.linkPath));
}

/** How many of the entries are not ticked off yet. */
export function openCount(entries: readonly LookUpEntry[]): number {
	return entries.reduce((n, e) => (e.done ? n : n + 1), 0);
}
