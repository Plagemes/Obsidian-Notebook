/**
 * 0.23 (#249) Automatic formula sheet: the pure side (no DOM, no 'obsidian'). Every equation element (#110) of a notebook is collected
 * in reading order (pages in order; on a page, rows top to bottom and left to right inside a row) and written as Markdown maths
 * (`$$…$$`) under a heading per page with a link back. The sheet is derived data: nothing is added to the document format and the
 * notebook file is never written. The Markdown sits between two owner markers (`<!-- notebook-formulas:start for=<path> id=<doc id> -->`
 * … `<!-- notebook-formulas:end -->`) and only that region is replaced on a rebuild, with the same ownership rules as the back-of-book
 * index (`src/model/book-index.ts`): a note that lost a marker is "unsafe", a note without markers is "appended" (the caller refuses; `pickFormulaNote` sends the sheet to the next free name),
 * a region that records another notebook is "other".
 */
import { escapeSearchText } from "./companion-search";
import { equationNumbers } from "./math-elements";
import type { EquationElement, Page } from "./types";
import { indexNoteIsMine, type IndexNoteSlot, type IndexReplaceContext } from "./book-index";

export const FORMULA_START = "<!-- notebook-formulas:start -->";
export const FORMULA_END = "<!-- notebook-formulas:end -->";
const FORMULA_START_RE = /<!-- notebook-formulas:start(?: for=([^\s>]*))?(?: id=([^\s>]*))? -->/;
/** Longest LaTeX source written for one formula (characters); a longer one is cut at a line end so the maths still closes. */
export const FORMULA_LATEX_MAX = 4000;

/** The start marker of the region written for the notebook at `owner` (and document id `id`); the plain marker without an owner. */
export function formulaStartMarker(owner?: string, id?: string): string {
	if (owner === undefined) return FORMULA_START;
	return `<!-- notebook-formulas:start for=${encodeURIComponent(owner)}${id ? ` id=${encodeURIComponent(id)}` : ""} -->`;
}

function decodeValue(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** What the note's formula region records (path/id, null: none); undefined without a complete region. */
export function formulaRegionOf(text: string): { path: string | null; id: string | null } | undefined {
	const m = FORMULA_START_RE.exec(text);
	if (!m || text.indexOf(FORMULA_END, m.index + m[0].length) < 0) return undefined;
	return { path: m[1] === undefined ? null : decodeValue(m[1]), id: m[2] === undefined ? null : decodeValue(m[2]) };
}

/** One formula of the sheet. */
export interface FormulaEntry {
	pageIndex: number;
	pageId: string;
	elementId: string;
	/** Normalised LaTeX source, without delimiters. */
	latex: string;
	/** The equation's "(n)" number when it is numbered. */
	number?: number;
	/** Top of the equation box, page points (where a tap scrolls to). */
	y: number;
}

function isEquation(e: unknown): e is EquationElement {
	return typeof e === "object" && e !== null && (e as { type?: unknown }).type === "equation" && typeof (e as { latex?: unknown }).latex === "string";
}

/**
 * The LaTeX of an equation made safe to sit alone between `$$` lines: line ends normalised, blank lines dropped (a blank line ends
 * Obsidian's maths block), every `$` escaped (`\$` stays; so is the `$` after a `\\` line break), `-->` cut so it cannot close the region, long sources cut at a line end.
 */
export function formulaLatex(raw: string): string {
	let s = raw.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/u, "")).filter((l) => l.trim() !== "").join("\n").trim();
	// A backslash and the character after it are read as a pair: `\$` stays, but the `$` after a line break `\\` is escaped.
	s = s.replace(/\\[\s\S]|\$/g, (m) => (m === "$" ? "\\$" : m)).replace(/-->/g, "-- >").replace(/<!--/g, "<! --");
	if (s.length > FORMULA_LATEX_MAX) {
		const cut = s.slice(0, FORMULA_LATEX_MAX);
		const nl = cut.lastIndexOf("\n");
		s = (nl > 0 ? cut.slice(0, nl) : cut).replace(/\\+$/u, "");
	}
	return s;
}

/** Every non-empty equation of the pages in reading order: page order; inside a page, rows top to bottom, then left to right. */
export function collectFormulas(pages: readonly Page[]): FormulaEntry[] {
	const numbers = equationNumbers(pages);
	const out: FormulaEntry[] = [];
	pages.forEach((page, pageIndex) => {
		const eqs = (Array.isArray(page.elements) ? page.elements : []).filter(isEquation).map((e, i) => ({ e, i }));
		eqs.sort((a, b) => {
			const ha = Number(a.e.height) || 0;
			const hb = Number(b.e.height) || 0;
			const ca = (Number(a.e.y) || 0) + ha / 2;
			const cb = (Number(b.e.y) || 0) + hb / 2;
			if (Math.abs(ca - cb) > Math.min(ha, hb) / 2) return ca - cb;
			return (Number(a.e.x) || 0) - (Number(b.e.x) || 0) || a.i - b.i;
		});
		for (const { e } of eqs) {
			const latex = formulaLatex(e.latex);
			if (latex === "") continue;
			const number = numbers.get(e.id);
			out.push({ pageIndex, pageId: page.id, elementId: e.id, latex, ...(number !== undefined ? { number } : {}), y: Number.isFinite(e.y) ? e.y : 0 });
		}
	});
	return out;
}

/** The formulas grouped by page (page order, entries already in reading order). */
export function groupByPage(entries: readonly FormulaEntry[]): Array<{ pageIndex: number; pageId: string; entries: FormulaEntry[] }> {
	const out: Array<{ pageIndex: number; pageId: string; entries: FormulaEntry[] }> = [];
	for (const e of entries) {
		const last = out[out.length - 1];
		if (last && last.pageIndex === e.pageIndex) last.entries.push(e);
		else out.push({ pageIndex: e.pageIndex, pageId: e.pageId, entries: [e] });
	}
	return out;
}

export interface FormulaSectionOptions {
	entries: readonly FormulaEntry[];
	/** The Markdown link to page `n` (1-based) of the notebook. */
	pageLink: (n: number, pageId: string) => string;
	intro: string;
	none: string;
	owner?: string;
	ownerId?: string;
}

/** The Markdown between the markers (markers included): an intro, then per page a heading with its link and a `$$` block per formula. Same input, same text. */
export function buildFormulaSection(o: FormulaSectionOptions): string {
	const lines: string[] = [formulaStartMarker(o.owner, o.ownerId), "", o.intro, ""];
	if (o.entries.length === 0) lines.push(escapeSearchText(o.none), "");
	for (const g of groupByPage(o.entries)) {
		lines.push(`### ${o.pageLink(g.pageIndex + 1, g.pageId)}`, "");
		for (const f of g.entries) lines.push("$$", f.number !== undefined ? `${f.latex}\n\\tag{${f.number}}` : f.latex, "$$", "");
	}
	lines.push(FORMULA_END);
	return lines.join("\n");
}

export type FormulaReplaceOutcome = "replaced" | "created" | "appended" | "unsafe" | "other";

/**
 * `existing` with the region between the markers replaced by `section`. Text outside is never changed. One marker without the other
 * is "unsafe" (returned unchanged, never written); a non-empty note without markers is "appended" (the caller asks before writing);
 * a region that records another notebook than `owner` is "other" (unchanged).
 */
export function replaceFormulaSection(existing: string, section: string, owner?: string, me?: IndexReplaceContext): { text: string; outcome: FormulaReplaceOutcome } {
	const m = FORMULA_START_RE.exec(existing);
	const start = m ? m.index : -1;
	const end = m ? existing.indexOf(FORMULA_END, start + m[0].length) : existing.indexOf(FORMULA_END);
	if (m && end >= 0) {
		const region = formulaRegionOf(existing);
		if (owner !== undefined && region && region.path !== null && !indexNoteIsMine({ owner: region.path, ownerId: region.id, ownerGone: me?.pathExists ? !me.pathExists(region.path) : false }, owner, me?.id)) return { text: existing, outcome: "other" };
		return { text: existing.slice(0, start) + section + existing.slice(end + FORMULA_END.length), outcome: "replaced" };
	}
	if (start >= 0 || end >= 0) return { text: existing, outcome: "unsafe" };
	if (existing.trim() === "") return { text: `${section}\n`, outcome: "created" };
	return { text: `${existing.replace(/\s+$/u, "")}\n\n${section}\n`, outcome: "appended" };
}

/** The text of a brand-new formula note: a title line, then the section. */
export function newFormulaNote(title: string, section: string): string {
	return `# ${title}\n\n${section}\n`;
}

/** How many names (`Formulas`, `Formulas (2)`, ...) are tried before giving up. */
export const FORMULA_NOTE_TRIES = 20;

/**
 * Which numbered name the formula note of the notebook at `notebookPath` should use (1 = plain), or null when none is usable.
 * A name is usable when it is free, when it is this notebook's own note, or (first name only) when its region has the plain marker with no
 * owner. A folder, a note of the user's with no complete region of ours (no markers, or one marker missing) and a note of another notebook
 * are skipped, so the sheet goes to the next free name (`Formulas (2)`): the note is never written to and the build is never a dead end.
 */
export async function pickFormulaNote(probe: (n: number) => Promise<IndexNoteSlot>, notebookPath: string, docId?: string): Promise<number | null> {
	for (let n = 1; n <= FORMULA_NOTE_TRIES; n++) {
		const slot = await probe(n);
		if (!slot.exists) return n;
		if (slot.folder) continue;
		if (typeof slot.owner === "string" && indexNoteIsMine({ owner: slot.owner, ownerId: slot.ownerId, ownerGone: slot.ownerGone }, notebookPath, docId)) return n;
		if (n === 1 && slot.owner === null) return n;
	}
	return null;
}
