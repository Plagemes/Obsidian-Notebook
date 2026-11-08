/**
 * 0.26 (#422): handwritten pages related to a Markdown note, ranked with a short reason. Pure: no 'obsidian' import, no I/O.
 * Works from the library index entries only (page text, page tags, titled bookmarks) and from what the caller read of the note
 * (title, aliases, tags, headings), so it never opens a notebook.
 *
 * Reasons, best first: a page whose text links to the note (`[[Note]]`), a page that names the note's title or an alias, a page
 * tagged like the note, a page that names one of the note's headings, and (lowest) the first page of a notebook of the same
 * course. A page keeps its best reason; every further, different reason adds a little to its rank.
 */
import { foldText, normalizeText, type LibraryEntry } from "./index";
import { parseLinks } from "../ink/wikilink";
import { linkCovers, type ClassEntry } from "../timetable/schedule";

export type RelatedReason = "links" | "title" | "alias" | "tag" | "heading" | "course";

/** What the panel reads of the open Markdown note. */
export interface RelatedNote {
	/** Vault path of the note. */
	path: string;
	/** File name without extension. */
	title: string;
	aliases: readonly string[];
	/** With or without the leading `#`. */
	tags: readonly string[];
	headings: readonly string[];
}

export interface RelatedRow {
	path: string;
	/** Notebook name. */
	name: string;
	/** 0-based page. */
	page: number;
	reason: RelatedReason;
	/** What matched: the tag, the heading, the bookmark title, the course; empty for a plain link or a title. */
	detail: string;
	/** Other reasons the same page also has (best first). */
	also: RelatedReason[];
	score: number;
	modified: number;
}

export interface RelatedOptions {
	limit?: number;
	/** Add the first page of the notebooks of the note's course (default true). */
	course?: boolean;
	/** The timetable's classes, to find the note's course. */
	classes?: readonly ClassEntry[];
}

export const RELATED_LIMIT = 30;
const PER_NOTEBOOK = 5;
const COURSE_NOTEBOOKS = 6;
const MIN_TERM = 3;
const MIN_HEADING = 5;
const MAX_HEADINGS = 40;
const ALSO_BONUS = 8;

export const REASON_SCORE: Readonly<Record<RelatedReason, number>> = { links: 400, title: 220, alias: 190, tag: 150, heading: 100, course: 40 };

const cleanTag = (tag: string): string => normalizeText(tag.trim().replace(/^#/u, ""));

/** Two tags relate when equal or one is a parent of the other (`physics` and `physics/optics`). */
export function tagsRelate(a: string, b: string): boolean {
	if (!a || !b) return false;
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** True when `folded` has `phrase` as a whole word or phrase (both already folded). */
export function containsPhrase(folded: string, phrase: string): boolean {
	if (phrase.length < MIN_TERM) return false;
	let from = 0;
	for (;;) {
		const at = folded.indexOf(phrase, from);
		if (at < 0) return false;
		const before = at === 0 ? "" : folded[at - 1]!;
		const after = folded[at + phrase.length] ?? "";
		const word = /[\p{L}\p{N}]/u;
		if (!(before && word.test(before)) && !(after && word.test(after))) return true;
		from = at + 1;
	}
}

/** Whether a wikilink target names the note: by name (folders ignored) or by its full path, case and accents ignored. */
export function linkNamesNote(target: string, note: Pick<RelatedNote, "path" | "title">): boolean {
	const t = normalizeText(target.trim().replace(/^\/+/u, "").replace(/\.md$/iu, ""));
	if (!t) return false;
	if (t === normalizeText(note.path.replace(/\.md$/iu, ""))) return true;
	const name = t.slice(t.lastIndexOf("/") + 1);
	return name === normalizeText(note.title);
}

/** The timetable classes (courses) the note belongs to: it lies in a linked course folder, or its title, an alias or a tag is the course name. */
export function coursesOfNote(note: RelatedNote, classes: readonly ClassEntry[]): ClassEntry[] {
	const names = new Set([note.title, ...note.aliases].map(normalizeText));
	for (const tag of note.tags) {
		const parts = cleanTag(tag).split("/");
		for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join("/"));
	}
	return classes.filter((c) => (!!c.notebook && linkCovers(c.notebook, note.path)) || (!!c.course.trim() && names.has(normalizeText(c.course.trim()))));
}

interface Seg { page: number; text: string; folded: string }

function segmentsOf(e: LibraryEntry): Seg[] {
	const pages = e.textPages;
	if (!e.text || !pages || pages.length < 2) return [];
	const folded = foldText(e.text);
	const out: Seg[] = [];
	for (let k = 0; k + 1 < pages.length; k += 2) {
		const start = pages[k + 1]!;
		const end = k + 3 < pages.length ? pages[k + 3]! : e.text.length;
		out.push({ page: pages[k]!, text: e.text.slice(start, end), folded: folded.slice(start, end) });
	}
	return out;
}

interface Cand { row: RelatedRow; reasons: Map<RelatedReason, number> }

/** Pages related to `note`, best first (at most `limit`). Empty when nothing relates. */
export function relatedPages(entries: readonly LibraryEntry[], note: RelatedNote, opts: RelatedOptions = {}): RelatedRow[] {
	const limit = Math.max(1, opts.limit ?? RELATED_LIMIT);
	const cands = new Map<string, Cand>();
	const perNotebook = new Map<string, number>();
	const add = (e: LibraryEntry, page: number, reason: RelatedReason, detail: string, bonus = 0): void => {
		const key = `${e.path}\u0000${page}`;
		const score = REASON_SCORE[reason] + bonus;
		const have = cands.get(key);
		if (!have) {
			const n = perNotebook.get(e.path) ?? 0;
			if (reason !== "links" && n >= PER_NOTEBOOK) return;
			perNotebook.set(e.path, n + 1);
			cands.set(key, { row: { path: e.path, name: e.name, page, reason, detail, also: [], score, modified: e.modified }, reasons: new Map([[reason, score]]) });
			return;
		}
		const prev = have.reasons.get(reason);
		if (prev === undefined || score > prev) have.reasons.set(reason, score);
		if (score > have.row.score) {
			have.row.score = score;
			have.row.reason = reason;
			have.row.detail = detail;
		}
	};

	const title = normalizeText(note.title.trim());
	const aliases = note.aliases.map((a) => normalizeText(a.trim())).filter((a) => a.length >= MIN_TERM && a !== title);
	const tags = [...new Set(note.tags.map(cleanTag).filter(Boolean))];
	const headings = [...new Set(note.headings.map((h) => normalizeText(h.trim())).filter((h) => h.length >= MIN_HEADING && h !== title))].slice(0, MAX_HEADINGS);

	for (const e of entries) {
		if (e.pages <= 0) continue;
		const name = normalizeText(e.name);
		if (title.length >= MIN_TERM && name === title) add(e, 0, "title", "");
		else if (aliases.includes(name)) add(e, 0, "alias", e.name);
		for (const seg of segmentsOf(e)) {
			if (seg.folded.includes("[[")) {
				for (const l of parseLinks(seg.text)) {
					if (linkNamesNote(l.target, note)) {
						add(e, seg.page, "links", "");
						break;
					}
				}
			}
			if (title.length >= MIN_TERM && containsPhrase(seg.folded, title)) add(e, seg.page, "title", note.title.trim());
			for (const a of aliases) if (containsPhrase(seg.folded, a)) {
				add(e, seg.page, "alias", a);
				break;
			}
			for (const h of headings) if (containsPhrase(seg.folded, h)) {
				add(e, seg.page, "heading", note.headings.find((x) => normalizeText(x.trim()) === h)?.trim() ?? h);
				break;
			}
		}
		for (const b of e.bookmarks ?? []) {
			const bt = normalizeText(b.title.trim());
			if (!bt) continue;
			if (title.length >= MIN_TERM && bt === title) add(e, b.page, "title", b.title);
			else if (aliases.includes(bt)) add(e, b.page, "alias", b.title);
			else if (headings.includes(bt)) add(e, b.page, "heading", b.title, 20);
		}
		if (tags.length > 0) {
			for (const pt of e.pageTags ?? []) {
				const hit = pt.tags.find((x) => tags.some((nt) => tagsRelate(cleanTag(x), nt)));
				if (hit) add(e, pt.page, "tag", `#${hit.replace(/^#/u, "")}`);
			}
			const nbTag = e.tags.find((x) => tags.some((nt) => tagsRelate(cleanTag(x), nt)));
			if (nbTag && e.pages > 0) add(e, 0, "tag", `#${nbTag.replace(/^#/u, "")}`, -90);
		}
	}

	if (opts.course !== false && opts.classes) {
		const courses = coursesOfNote(note, opts.classes);
		if (courses.length > 0) {
			const seen = new Set([...cands.values()].map((c) => c.row.path));
			const mine = entries.filter((e) => !seen.has(e.path) && e.pages > 0).map((e) => ({ e, c: courses.find((c) => linkCovers(c.notebook, e.path)) })).filter((x): x is { e: LibraryEntry; c: ClassEntry } => !!x.c);
			mine.sort((a, b) => b.e.modified - a.e.modified || a.e.path.localeCompare(b.e.path));
			for (const { e, c } of mine.slice(0, COURSE_NOTEBOOKS)) add(e, 0, "course", c.course.trim());
		}
	}

	const rows: RelatedRow[] = [];
	for (const { row, reasons } of cands.values()) {
		const others = [...reasons].filter(([r]) => r !== row.reason).sort((a, b) => b[1] - a[1]).map(([r]) => r);
		rows.push({ ...row, also: others, score: row.score + others.length * ALSO_BONUS });
	}
	rows.sort((a, b) => b.score - a.score || b.modified - a.modified || a.name.localeCompare(b.name) || a.page - b.page);
	return rows.slice(0, limit);
}

/** The aliases of a note from its frontmatter (`aliases` or `alias`, a list or a comma-separated string), without blanks or repeats. */
export function aliasesOf(frontmatter: unknown): string[] {
	if (typeof frontmatter !== "object" || frontmatter === null) return [];
	const fm = frontmatter as Record<string, unknown>;
	const raw = fm.aliases ?? fm.alias;
	const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
	const out: string[] = [];
	for (const item of list) {
		const s = typeof item === "string" ? item.trim() : typeof item === "number" ? String(item) : "";
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}
