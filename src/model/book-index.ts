/**
 * 0.21 (#187) Back-of-book index: the pure side (no DOM, no 'obsidian'). An index term is an ordinary marker (kind "star") whose
 * label starts with a configurable prefix (default `#idx`): `#idx Photosynthesis`, `#idx Cell / Nucleus`. The index is derived
 * from the markers on demand; nothing is added to the document format. The terms are grouped by their first letter (A-Z sections),
 * sorted with the locale's collation (accents and case ignored), equal terms merge, "term / subterm" nests (up to three levels), and
 * every term lists the pages it is marked on. `buildIndexSection` writes the Markdown between two comment markers and
 * `replaceIndexSection` puts it into a note, replacing only what is between the markers (the same rules as the highlights digest).
 */
import { escapeSearchText } from "./companion-search";
import { cleanMarkerText } from "./markers";
import { MARKER_TEXT_MAX, type MarkerElement, type Page } from "./types";

/** The default label prefix of an index marker. */
export const DEFAULT_INDEX_PREFIX = "#idx";
/** The longest prefix (characters). */
export const INDEX_PREFIX_MAX = 16;
/** Deepest "term / subterm / sub-subterm" nesting. */
export const INDEX_MAX_DEPTH = 3;
export const INDEX_START = "<!-- notebook-index:start -->";
export const INDEX_END = "<!-- notebook-index:end -->";
/** The start marker with or without the notebook it belongs to (`for=<encoded path>`, review W21 D8). */
const INDEX_START_RE = /<!-- notebook-index:start(?: for=([^\s>]*))?(?: id=([^\s>]*))? -->/;

/**
 * The start marker of the region written for the notebook at `owner` (and with document id `id`, which survives a rename or move,
 * review W21 N1); the plain marker when there is no owner.
 */
export function indexStartMarker(owner?: string, id?: string): string {
	if (owner === undefined) return INDEX_START;
	return `<!-- notebook-index:start for=${encodeURIComponent(owner)}${id ? ` id=${encodeURIComponent(id)}` : ""} -->`;
}

function decodeMarkerValue(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** What the note's index region records: the notebook path (null: none) and document id (null: none); undefined without a complete region. */
export function indexRegionOf(text: string): { path: string | null; id: string | null } | undefined {
	const m = INDEX_START_RE.exec(text);
	if (!m || text.indexOf(INDEX_END, m.index + m[0].length) < 0) return undefined;
	return { path: m[1] === undefined ? null : decodeMarkerValue(m[1]), id: m[2] === undefined ? null : decodeMarkerValue(m[2]) };
}

/** What a note's region records, plus whether the recorded path still exists in the vault. */
export interface IndexOwnerClaim {
	owner: string;
	ownerId?: string | null;
	ownerGone?: boolean;
}

/**
 * Whether a region that records `claim` belongs to the notebook at `path` with document id `docId`. The same document id wins even
 * after a rename or move; a different recorded id never matches; a path-only marker matches its own path, or any path that no longer
 * exists (the notebook was moved: the note sits at this notebook's own index name).
 */
export function indexNoteIsMine(claim: IndexOwnerClaim, path: string, docId?: string): boolean {
	const idKnown = typeof claim.ownerId === "string" && claim.ownerId !== "" && docId !== undefined && docId !== "";
	if (idKnown) return claim.ownerId === docId;
	return claim.owner === path || claim.ownerGone === true;
}

/**
 * The notebook path recorded in the note's index region: the path, null for a region without one (a plain marker), undefined
 * when the note has no complete region.
 */
export function indexOwnerOf(text: string): string | null | undefined {
	const m = INDEX_START_RE.exec(text);
	if (!m || text.indexOf(INDEX_END, m.index + m[0].length) < 0) return undefined;
	if (m[1] === undefined) return null;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return m[1];
	}
}

/** A usable prefix: one word without spaces (trimmed, at most INDEX_PREFIX_MAX characters); the default when empty. */
export function normalizeIndexPrefix(raw: unknown): string {
	if (typeof raw !== "string") return DEFAULT_INDEX_PREFIX;
	const word = Array.from(raw.trim().split(/\s+/u)[0] ?? "").slice(0, INDEX_PREFIX_MAX).join("");
	return word === "" ? DEFAULT_INDEX_PREFIX : word;
}

/** The label of an index marker for `term`: the prefix, a space, the term (cut to the marker's label limit). */
export function indexLabel(term: string, prefix: string): string | undefined {
	const clean = term.replace(/\s+/gu, " ").trim();
	if (clean === "") return undefined;
	const p = normalizeIndexPrefix(prefix);
	const room = MARKER_TEXT_MAX - Array.from(p).length - 1;
	return cleanMarkerText(`${p} ${Array.from(clean).slice(0, Math.max(1, room)).join("")}`);
}

/** The term a marker label spells (`#idx Cell / Nucleus` -> `Cell / Nucleus`), or null when the label is not an index label or has no term. */
export function indexTermOf(text: string | undefined, prefix: string): string | null {
	const label = cleanMarkerText(text);
	if (!label) return null;
	const p = normalizeIndexPrefix(prefix);
	if (label.length < p.length + 2) return null;
	if (label.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return null;
	if (!/\s/u.test(label.charAt(p.length))) return null;
	const term = label.slice(p.length).trim();
	return term === "" ? null : term;
}

/** "Cell / Nucleus" -> ["Cell", "Nucleus"]: trimmed levels, empty ones dropped, at most INDEX_MAX_DEPTH (the rest stays in the last). */
export function splitTerm(term: string): string[] {
	const parts = term.split("/").map((s) => s.replace(/\s+/gu, " ").trim()).filter((s) => s !== "");
	if (parts.length <= INDEX_MAX_DEPTH) return parts;
	return [...parts.slice(0, INDEX_MAX_DEPTH - 1), parts.slice(INDEX_MAX_DEPTH - 1).join(" / ")];
}

/** Comparison key: lower case, accents removed ("Élan" and "elan" are one term). */
export function indexKey(s: string): string {
	return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The section a term belongs to: its first letter, upper case and without accent; "#" for a digit, a symbol or anything else. */
export function sectionLetter(name: string): string {
	const first = Array.from(indexKey(name).trim())[0] ?? "";
	return /^\p{L}$/u.test(first) ? first.toUpperCase() : "#";
}

export interface IndexRef {
	pageIndex: number;
	pageId: string;
	markerId: string;
	/** Top of the marked spot, page points: where a tap on the reference scrolls to. */
	y: number;
}

export interface IndexEntry {
	path: string[];
	ref: IndexRef;
}

export interface IndexTerm {
	name: string;
	/** The pages the term is marked on (one reference per page, the first mark in reading order), in page order. */
	refs: IndexRef[];
	children: IndexTerm[];
}

export interface IndexSection {
	letter: string;
	terms: IndexTerm[];
}

function isIndexMarker(e: unknown): e is MarkerElement {
	return typeof e === "object" && e !== null && (e as { type?: unknown }).type === "marker";
}

/** Every index marker of the pages, in page and reading order (top to bottom, left to right). */
export function collectIndexEntries(pages: readonly Page[], prefix: string): IndexEntry[] {
	const out: IndexEntry[] = [];
	pages.forEach((page, pageIndex) => {
		const els = Array.isArray(page.elements) ? page.elements.filter(isIndexMarker) : [];
		const sorted = els.map((e, i) => ({ e, i })).sort((a, b) =>
			(Number(a.e.y) || 0) - (Number(b.e.y) || 0) || (Number(a.e.x) || 0) - (Number(b.e.x) || 0) || a.i - b.i);
		for (const { e } of sorted) {
			const term = indexTermOf(e.text, prefix);
			if (!term) continue;
			const path = splitTerm(term);
			if (path.length === 0) continue;
			out.push({ path, ref: { pageIndex, pageId: page.id, markerId: e.id, y: Number.isFinite(e.y) ? e.y : 0 } });
		}
	});
	return out;
}

interface Node {
	name: string;
	refs: IndexRef[];
	children: Map<string, Node>;
}

function newNode(name: string): Node {
	return { name, refs: [], children: new Map() };
}

/**
 * The index of `entries`: sections by first letter ("#" first, then the locale's order), terms sorted with `Intl.Collator`
 * (accents and case ignored, numbers by value), equal terms merged (the first spelling is kept), sub-terms nested under their term
 * (a sub-term whose parent was never marked still gets a parent line with no pages). One reference per page.
 */
export function buildIndex(entries: readonly IndexEntry[], locale?: string): IndexSection[] {
	let collator: Intl.Collator;
	try {
		collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
	} catch {
		collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	}
	const root = new Map<string, Node>();
	for (const entry of entries) {
		let level = root;
		let node: Node | null = null;
		for (const part of entry.path) {
			const key = indexKey(part);
			let next = level.get(key);
			if (!next) {
				next = newNode(part);
				level.set(key, next);
			}
			node = next;
			level = next.children;
		}
		if (node && !node.refs.some((r) => r.pageIndex === entry.ref.pageIndex)) node.refs.push(entry.ref);
	}
	const finish = (map: Map<string, Node>): IndexTerm[] =>
		[...map.values()]
			.sort((a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
			.map((n) => ({ name: n.name, refs: n.refs.slice().sort((a, b) => a.pageIndex - b.pageIndex), children: finish(n.children) }));
	const sections = new Map<string, IndexTerm[]>();
	for (const term of finish(root)) {
		const letter = sectionLetter(term.name);
		const list = sections.get(letter);
		if (list) list.push(term);
		else sections.set(letter, [term]);
	}
	return [...sections.entries()]
		.sort((a, b) => (a[0] === "#" ? -1 : b[0] === "#" ? 1 : collator.compare(a[0], b[0])))
		.map(([letter, terms]) => ({ letter, terms }));
}

/** How many terms (counting sub-terms) the index lists, and how many distinct pages carry a mark. */
export function indexCounts(sections: readonly IndexSection[]): { terms: number; pages: number } {
	const pages = new Set<number>();
	let terms = 0;
	const walk = (t: IndexTerm) => {
		terms++;
		for (const r of t.refs) pages.add(r.pageIndex);
		t.children.forEach(walk);
	};
	sections.forEach((s) => s.terms.forEach(walk));
	return { terms, pages: pages.size };
}

/** The terms whose name, or the name of a parent, contains `query` (accents and case ignored); an empty query keeps everything. */
export function filterIndex(sections: readonly IndexSection[], query: string): IndexSection[] {
	const q = indexKey(query.trim());
	if (q === "") return sections.slice();
	const keep = (t: IndexTerm, parentHit: boolean): IndexTerm | null => {
		const hit = parentHit || indexKey(t.name).includes(q);
		const children = t.children.map((c) => keep(c, hit)).filter((c): c is IndexTerm => c !== null);
		return hit || children.length > 0 ? { name: t.name, refs: t.refs, children } : null;
	};
	return sections
		.map((s) => ({ letter: s.letter, terms: s.terms.map((t) => keep(t, false)).filter((t): t is IndexTerm => t !== null) }))
		.filter((s) => s.terms.length > 0);
}

export interface IndexSectionOptions {
	sections: readonly IndexSection[];
	/** The Markdown link to page `n` (1-based) of the notebook. */
	pageLink: (n: number, pageId: string) => string;
	intro: string;
	none: string;
	/** Path of the notebook the section is written for; recorded in the start marker so another notebook never rewrites it. */
	owner?: string;
	/** The notebook's document id, recorded too: it survives a rename or move (review W21 N1). */
	ownerId?: string;
}

/** The Markdown between the two markers (markers included): an intro line, then a heading per letter and a nested list per term. Same input, same text. */
export function buildIndexSection(o: IndexSectionOptions): string {
	const lines: string[] = [indexStartMarker(o.owner, o.ownerId), "", o.intro, ""];
	if (o.sections.length === 0) lines.push(o.none, "");
	for (const s of o.sections) {
		lines.push(`### ${s.letter === "#" ? "\\#" : escapeSearchText(s.letter)}`, "");
		const emit = (t: IndexTerm, depth: number) => {
			const pages = t.refs.map((r) => o.pageLink(r.pageIndex + 1, r.pageId)).join(", ");
			lines.push(`${"  ".repeat(depth)}- ${escapeSearchText(t.name)}${pages ? ` — ${pages}` : ""}`);
			t.children.forEach((c) => emit(c, depth + 1));
		};
		s.terms.forEach((t) => emit(t, 0));
		lines.push("");
	}
	lines.push(INDEX_END);
	return lines.join("\n");
}

export type IndexReplaceOutcome = "replaced" | "created" | "appended" | "unsafe" | "other";

/** What the caller knows about the notebook that writes: its document id and whether a recorded path still exists. */
export interface IndexReplaceContext {
	id?: string;
	pathExists?: (path: string) => boolean;
}

/**
 * `existing` with the section between the markers replaced by `section`. Text outside the markers is never changed. A note with
 * one marker but not the other is "unsafe" (returned unchanged, must not be written). A non-empty note without markers is
 * "appended": the caller asks (or refuses) before writing. A region that records another notebook than `owner` is "other"
 * (returned unchanged): it belongs to that notebook.
 */
export function replaceIndexSection(existing: string, section: string, owner?: string, me?: IndexReplaceContext): { text: string; outcome: IndexReplaceOutcome } {
	const m = INDEX_START_RE.exec(existing);
	const start = m ? m.index : -1;
	const end = m ? existing.indexOf(INDEX_END, start + m[0].length) : existing.indexOf(INDEX_END);
	if (m && end >= 0) {
		const region = indexRegionOf(existing);
		if (owner !== undefined && region && region.path !== null && !indexNoteIsMine({ owner: region.path, ownerId: region.id, ownerGone: me?.pathExists ? !me.pathExists(region.path) : false }, owner, me?.id)) return { text: existing, outcome: "other" };
		return { text: existing.slice(0, start) + section + existing.slice(end + INDEX_END.length), outcome: "replaced" };
	}
	if (start >= 0 || end >= 0) return { text: existing, outcome: "unsafe" };
	if (existing.trim() === "") return { text: `${section}\n`, outcome: "created" };
	return { text: `${existing.replace(/\s+$/u, "")}\n\n${section}\n`, outcome: "appended" };
}

/** The text of a brand-new index note: a title line, then the section. */
export function newIndexNote(title: string, section: string): string {
	return `# ${title}\n\n${section}\n`;
}

/** What is at one candidate name of the index note. */
export interface IndexNoteSlot {
	exists: boolean;
	/** A folder is there (never written to). */
	folder?: boolean;
	/** `indexOwnerOf` of the note's text (when it is a note). */
	owner?: string | null | undefined;
	/** The document id the region records (null: none). */
	ownerId?: string | null;
	/** The recorded path no longer exists in the vault. */
	ownerGone?: boolean;
}

/** How many names (`Index`, `Index (2)`, ...) are tried before giving up. */
export const INDEX_NOTE_TRIES = 20;

/**
 * Which numbered name the index note of the notebook at `notebookPath` should use (1 = the plain name), or null when none is
 * usable. The first name is used when it is free, when it is a note of this notebook, or when it is not an index note at all
 * or a plain-marker one (the caller reports that it is left untouched). A note that records another notebook is skipped, and so
 * is anything at a numbered name that is not this notebook's own index note: a numbered name is only reused for its own notebook.
 * Review W21 D8: two notebooks whose names collapse to the same text never rewrite each other's index.
 */
export async function pickIndexNote(probe: (n: number) => Promise<IndexNoteSlot>, notebookPath: string, docId?: string): Promise<number | null> {
	for (let n = 1; n <= INDEX_NOTE_TRIES; n++) {
		const slot = await probe(n);
		if (!slot.exists) return n;
		if (slot.folder) {
			if (n === 1) return n;
			continue;
		}
		if (typeof slot.owner === "string" && indexNoteIsMine({ owner: slot.owner, ownerId: slot.ownerId, ownerGone: slot.ownerGone }, notebookPath, docId)) return n;
		if (n === 1 && (slot.owner === undefined || slot.owner === null)) return n;
	}
	return null;
}
