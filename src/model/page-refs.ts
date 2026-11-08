/**
 * 0.22 (#179) Two-way page references, the pure side (no DOM, no 'obsidian'). A reference is a wikilink in a text box or a sticky
 * note of one page that names another page of the SAME notebook (`[[Physics.notebook#p7&id=...]]`). The index is derived data: nothing
 * is stored, the document format is unchanged. Page targets are resolved by page id when the link has one (reordering pages keeps the
 * references), else by the page number written in it, at the time of the question.
 *
 * Links to pages of OTHER notebooks are not indexed: that would need every notebook's file read. Only the notebook that is open is
 * known, so "referenced from <Notebook> p. N" is not offered.
 *
 * `PageRefIndex` keeps one outgoing list per page and rescans a page only when its elements changed (identity of the element array,
 * then a cheap signature of the link texts), and `warm` works in time slices, so a big notebook never blocks a frame.
 */
import { parseLinks } from "../ink/wikilink";
import { pageTargetFromSubpath, resolvePageTarget, type PageTarget } from "../integration/page-links";
import type { Page } from "./types";

/** More links than this on one page are ignored (a pasted wall of links is not a reference list). */
export const MAX_LINKS_PER_PAGE = 300;
/** The longest list of referencing pages that is returned for one page. */
export const MAX_SOURCES = 200;

/** One outgoing page link as written. */
export interface OutLink {
	target: PageTarget;
}

/** Whether a link target (`Physics`, `Physics.notebook`, `Notebooks/Physics.notebook`) names the notebook at `ownerPath`. */
export function targetsNotebook(linkTarget: string, ownerPath: string): boolean {
	const norm = (s: string) => s.trim().replace(/\\/g, "/").toLowerCase();
	const strip = (s: string) => s.replace(/\.notebook$/, "");
	const a = strip(norm(linkTarget));
	const b = strip(norm(ownerPath));
	if (a === "" || b === "") return false;
	if (a === b) return true;
	// A name without folders is how Obsidian writes a link to a unique file.
	return !a.includes("/") && b.endsWith(`/${a}`);
}

/** The page links written in `text` that name a page of the notebook at `ownerPath`, in order. */
export function pageLinksIn(text: string, ownerPath: string): OutLink[] {
	if (!text.includes("[[")) return [];
	const out: OutLink[] = [];
	for (const link of parseLinks(text)) {
		if (link.subpath === "" || !targetsNotebook(link.target, ownerPath)) continue;
		const target = pageTargetFromSubpath(link.subpath);
		if (target) out.push({ target });
		if (out.length >= MAX_LINKS_PER_PAGE) break;
	}
	return out;
}

/** The link-carrying text of a page: text boxes and sticky notes. */
function pageTexts(page: Page): string[] {
	const out: string[] = [];
	for (const e of page.elements ?? []) {
		if ((e.type === "text" || e.type === "sticky") && typeof e.text === "string") out.push(e.text);
	}
	return out;
}

/** The outgoing page links of a page. */
export function outgoingLinks(page: Page, ownerPath: string): OutLink[] {
	const out: OutLink[] = [];
	for (const text of pageTexts(page)) {
		for (const l of pageLinksIn(text, ownerPath)) {
			out.push(l);
			if (out.length >= MAX_LINKS_PER_PAGE) return out;
		}
	}
	return out;
}

/** A page that refers to another one. */
export interface PageRef {
	/** 0-based position of the referencing page, and its id. */
	index: number;
	pageId: string;
	/** How many links on it point at the page. */
	count: number;
}

interface Entry {
	elements: Page["elements"];
	signature: string;
	links: OutLink[];
}

/** The texts that hold a link, joined: equal when nothing a link could depend on changed. */
function signatureOf(page: Page): string {
	let s = "";
	for (const t of pageTexts(page)) if (t.includes("[[")) s += `${t.length}:${t}\u0001`;
	return s;
}

function sameLinks(a: readonly OutLink[], b: readonly OutLink[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((l, i) => l.target.page === b[i]!.target.page && l.target.pageId === b[i]!.target.pageId);
}

/** Keeps the outgoing links of every page of one notebook. One instance per open notebook. */
export class PageRefIndex {
	private readonly entries = new Map<string, Entry>();
	private owner = "";
	/** Pages scanned since `resetCount` (tests). */
	scanned = 0;
	/** Bumped whenever an outgoing list changed, so a caller can tell cheaply that a cached answer is out of date. */
	version = 0;

	resetCount(): void {
		this.scanned = 0;
	}

	/** The notebook's path (renamed or moved: links are matched against the new one). */
	setOwner(path: string): void {
		if (path === this.owner) return;
		this.owner = path;
		this.entries.clear();
		this.version++;
	}

	private stale(page: Page): boolean {
		const have = this.entries.get(page.id);
		if (!have) return true;
		if (have.elements === page.elements) return false;
		return have.signature !== signatureOf(page);
	}

	private scan(page: Page): void {
		const have = this.entries.get(page.id);
		const signature = signatureOf(page);
		if (have && have.signature === signature) {
			have.elements = page.elements;
			return;
		}
		const links = signature === "" ? [] : outgoingLinks(page, this.owner);
		this.scanned++;
		if (!have || !sameLinks(have.links, links)) this.version++;
		this.entries.set(page.id, { elements: page.elements, signature, links });
	}

	/** Pages whose links have not been read since they changed. */
	pending(pages: readonly Page[]): number {
		let n = 0;
		for (const p of pages) if (this.stale(p)) n++;
		return n;
	}

	/** Scans stale pages until `budgetMs` is used up (at least one per call). Returns how many are still stale. */
	warm(pages: readonly Page[], budgetMs: number, now: () => number = () => Date.now()): number {
		const start = now();
		let left = 0;
		let done = 0;
		for (const page of pages) {
			if (!this.stale(page)) continue;
			if (done > 0 && now() - start >= budgetMs) {
				left++;
				continue;
			}
			this.scan(page);
			done++;
		}
		this.forget(pages);
		return left;
	}

	/** The pages that refer to page `pageId`, in page order. Self-references are left out, and a link to a deleted page matches nothing. */
	referencedFrom(pages: readonly Page[], pageId: string): PageRef[] {
		for (const p of pages) if (this.stale(p)) this.scan(p);
		const out: PageRef[] = [];
		pages.forEach((page, index) => {
			if (page.id === pageId || out.length >= MAX_SOURCES) return;
			const links = this.entries.get(page.id)?.links;
			if (!links || links.length === 0) return;
			let count = 0;
			for (const l of links) {
				const r = resolvePageTarget(pages, l.target);
				if ("index" in r && pages[r.index]?.id === pageId) count++;
			}
			if (count > 0) out.push({ index, pageId: page.id, count });
		});
		this.forget(pages);
		return out;
	}

	/** Page id -> number of other pages that refer to it, for every page that is referred to (one pass over all links). */
	referencedCounts(pages: readonly Page[]): Map<string, number> {
		for (const p of pages) if (this.stale(p)) this.scan(p);
		const out = new Map<string, number>();
		for (const page of pages) {
			const links = this.entries.get(page.id)?.links;
			if (!links) continue;
			const seen = new Set<string>();
			for (const l of links) {
				const r = resolvePageTarget(pages, l.target);
				if (!("index" in r)) continue;
				const target = pages[r.index];
				if (!target || target.id === page.id || seen.has(target.id)) continue;
				seen.add(target.id);
				out.set(target.id, (out.get(target.id) ?? 0) + 1);
			}
		}
		return out;
	}

	private forget(pages: readonly Page[]): void {
		if (this.entries.size <= pages.length) return;
		const ids = new Set(pages.map((p) => p.id));
		for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.entries.delete(id);
	}
}

/** The page numbers a short label lists ("p. 3, p. 12") and how many more there are. */
export function refsSummary(refs: readonly PageRef[], limit = 3): { shown: number[]; more: number } {
	const shown = refs.slice(0, limit).map((r) => r.index + 1);
	return { shown, more: Math.max(0, refs.length - shown.length) };
}
