/**
 * 0.28 (#205) Automatic numbering of structured boxes ("Def. 3.2") and the index of a notebook's definitions and theorems.
 * Pure: no DOM, no 'obsidian'. Numbers are derived from the document every time and never stored (no format change).
 *
 * Order: pages in order; inside a page by position (top to bottom, then left to right; the stored order breaks ties). Two-page
 * spread is irrelevant (it is a view mode). Proofs are never numbered. A "chapter" is the n-th top-level heading of the notebook
 * (the headings index, level 1); a box belongs to the chapter of the last such heading above it, and counters restart in each
 * chapter. Boxes above the first heading (or in a notebook without headings) carry no chapter prefix.
 */
import { escapeSearchText } from "./companion-search";
import type { BoxElement, BoxKind, Page } from "./types";
import { indexNoteIsMine, type IndexNoteSlot, type IndexReplaceContext } from "./book-index";

/** The kinds that get a number (a proof belongs to its theorem and is not numbered). */
export const NUMBERED_KINDS: readonly BoxKind[] = ["definition", "theorem", "example", "remark"];

export interface BoxNumberOptions {
	/** Prefix the number with the chapter ("3.2"). */
	chapter: boolean;
	/** One counter for all kinds (Def. 1, Thm. 2, Ex. 3) instead of one per kind. */
	shared: boolean;
}

export const DEFAULT_BOX_NUMBER_OPTIONS: Readonly<BoxNumberOptions> = { chapter: true, shared: false };

/** Where a top-level heading is: page index (0-based) and its top on the page (pt). */
export interface ChapterMark {
	pageIndex: number;
	y: number;
}

export interface NumberedBox {
	id: string;
	kind: BoxKind;
	pageIndex: number;
	pageId: string;
	/** Top of the box (pt). */
	y: number;
	/** Chapter (1-based) or 0 when above the first heading / no headings / prefix off. */
	chapter: number;
	/** The n-th box of its kind (or of all kinds when shared) in its chapter. */
	n: number;
	/** "3.2" or "2". */
	number: string;
	title?: string;
}

function isBox(e: unknown): e is BoxElement {
	if (typeof e !== "object" || e === null) return false;
	const b = e as Partial<BoxElement>;
	return b.type === "box" && typeof b.id === "string" && typeof b.kind === "string";
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Marks sorted in reading order. */
function sortedMarks(marks: readonly ChapterMark[]): ChapterMark[] {
	return marks.slice().sort((a, b) => a.pageIndex - b.pageIndex || a.y - b.y);
}

/** Numbers the boxes of `pages` (reading order). `marks`: the notebook's top-level headings. */
export function numberBoxes(pages: readonly Page[], marks: readonly ChapterMark[], options: BoxNumberOptions = DEFAULT_BOX_NUMBER_OPTIONS): NumberedBox[] {
	const ms = options.chapter ? sortedMarks(marks) : [];
	const out: NumberedBox[] = [];
	const counters = new Map<string, number>();
	let lastChapter = -1;
	pages.forEach((page, pageIndex) => {
		const boxes = (Array.isArray(page.elements) ? page.elements : []).filter(isBox).map((b, i) => ({ b, i }));
		boxes.sort((p, q) => num(p.b.y) - num(q.b.y) || num(p.b.x) - num(q.b.x) || p.i - q.i);
		for (const { b } of boxes) {
			if (!NUMBERED_KINDS.includes(b.kind)) continue;
			// Chapter: how many headings are above this box (same page: heading top at or above the box top).
			let chapter = 0;
			for (const m of ms) {
				if (m.pageIndex < pageIndex || (m.pageIndex === pageIndex && m.y <= num(b.y))) chapter++;
				else break;
			}
			if (chapter !== lastChapter) {
				counters.clear();
				lastChapter = chapter;
			}
			const key = options.shared ? "*" : b.kind;
			const n = (counters.get(key) ?? 0) + 1;
			counters.set(key, n);
			out.push({
				id: b.id, kind: b.kind, pageIndex, pageId: page.id, y: num(b.y), chapter, n,
				number: chapter > 0 ? `${chapter}.${n}` : String(n),
				...(typeof b.title === "string" && b.title !== "" ? { title: b.title } : {}),
			});
		}
	});
	return out;
}

/** The numbers by box id. */
export function numberMap(items: readonly NumberedBox[]): Map<string, string> {
	return new Map(items.map((i) => [i.id, i.number]));
}

/** Abbreviation written before the number ("Def.", "Thm.", "Ex.", "Rem."); the view passes the translated ones. */
export type BoxAbbreviations = Readonly<Record<BoxKind, string>>;

export const EN_ABBREVIATIONS: BoxAbbreviations = { definition: "Def.", theorem: "Thm.", example: "Ex.", proof: "Proof", remark: "Rem." };

/** "Def. 3.2". */
export function numberLabel(kind: BoxKind, number: string, abbr: BoxAbbreviations = EN_ABBREVIATIONS): string {
	return `${abbr[kind]} ${number}`;
}

/**
 * The label drawn on a box: "Def. 3.2 · Title", "Def. 3.2" or, for an unnumbered box, the plain kind name with its title.
 * `names` are the full kind names, `abbr` the abbreviations.
 */
export function numberedBoxLabel(
	box: BoxElement, number: string | undefined, names: Readonly<Record<BoxKind, string>>, abbr: BoxAbbreviations,
): string {
	if (number === undefined) return box.title ? `${names[box.kind]} · ${box.title}` : names[box.kind];
	const head = numberLabel(box.kind, number, abbr);
	return box.title ? `${head} · ${box.title}` : head;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The Markdown index note (same ownership rules as the formula sheet and the back-of-book index).

export const BOXES_START = "<!-- notebook-boxes:start -->";
export const BOXES_END = "<!-- notebook-boxes:end -->";
const BOXES_START_RE = /<!-- notebook-boxes:start(?: for=([^\s>]*))?(?: id=([^\s>]*))? -->/;

export function boxesStartMarker(owner?: string, id?: string): string {
	if (owner === undefined) return BOXES_START;
	return `<!-- notebook-boxes:start for=${encodeURIComponent(owner)}${id ? ` id=${encodeURIComponent(id)}` : ""} -->`;
}

function decodeValue(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** What the note's region records (path/id, null: none); undefined without a complete region. */
export function boxesRegionOf(text: string): { path: string | null; id: string | null } | undefined {
	const m = BOXES_START_RE.exec(text);
	if (!m || text.indexOf(BOXES_END, m.index + m[0].length) < 0) return undefined;
	return { path: m[1] === undefined ? null : decodeValue(m[1]), id: m[2] === undefined ? null : decodeValue(m[2]) };
}

export interface BoxesSectionOptions {
	items: readonly NumberedBox[];
	/** Full kind names (translated) and abbreviations. */
	names: Readonly<Record<BoxKind, string>>;
	abbr: BoxAbbreviations;
	/** The Markdown link to page `n` (1-based) of the notebook. */
	pageLink: (n: number, pageId: string) => string;
	intro: string;
	none: string;
	owner?: string;
	ownerId?: string;
}

/** The Markdown between the markers (markers included): one bullet per numbered box, in reading order. Same input, same text. */
export function buildBoxesSection(o: BoxesSectionOptions): string {
	const lines: string[] = [boxesStartMarker(o.owner, o.ownerId), "", o.intro, ""];
	if (o.items.length === 0) lines.push(escapeSearchText(o.none), "");
	for (const it of o.items) {
		const title = it.title ? ` — ${escapeSearchText(it.title)}` : "";
		lines.push(`- **${numberLabel(it.kind, it.number, o.abbr)}**${title} (${o.pageLink(it.pageIndex + 1, it.pageId)})`);
	}
	if (o.items.length > 0) lines.push("");
	lines.push(BOXES_END);
	return lines.join("\n");
}

export type BoxesReplaceOutcome = "replaced" | "created" | "appended" | "unsafe" | "other";

/** `existing` with the region between the markers replaced by `section`; text outside is never changed. Same outcomes as the formula sheet. */
export function replaceBoxesSection(existing: string, section: string, owner?: string, me?: IndexReplaceContext): { text: string; outcome: BoxesReplaceOutcome } {
	const m = BOXES_START_RE.exec(existing);
	const start = m ? m.index : -1;
	const end = m ? existing.indexOf(BOXES_END, start + m[0].length) : existing.indexOf(BOXES_END);
	if (m && end >= 0) {
		const region = boxesRegionOf(existing);
		if (owner !== undefined && region && region.path !== null && !indexNoteIsMine({ owner: region.path, ownerId: region.id, ownerGone: me?.pathExists ? !me.pathExists(region.path) : false }, owner, me?.id)) return { text: existing, outcome: "other" };
		return { text: existing.slice(0, start) + section + existing.slice(end + BOXES_END.length), outcome: "replaced" };
	}
	if (start >= 0 || end >= 0) return { text: existing, outcome: "unsafe" };
	if (existing.trim() === "") return { text: `${section}\n`, outcome: "created" };
	return { text: `${existing.replace(/\s+$/u, "")}\n\n${section}\n`, outcome: "appended" };
}

export function newBoxesNote(title: string, section: string): string {
	return `# ${title}\n\n${section}\n`;
}

export const BOXES_NOTE_TRIES = 20;

/** Which numbered note name (1 = plain) this notebook's index note should use; null when none is usable. Same rules as `pickFormulaNote`. */
export async function pickBoxesNote(probe: (n: number) => Promise<IndexNoteSlot>, notebookPath: string, docId?: string): Promise<number | null> {
	for (let n = 1; n <= BOXES_NOTE_TRIES; n++) {
		const slot = await probe(n);
		if (!slot.exists) return n;
		if (slot.folder) continue;
		if (typeof slot.owner === "string" && indexNoteIsMine({ owner: slot.owner, ownerId: slot.ownerId, ownerGone: slot.ownerGone }, notebookPath, docId)) return n;
		if (n === 1 && slot.owner === null) return n;
	}
	return null;
}
