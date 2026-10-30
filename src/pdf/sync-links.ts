/**
 * Synchronised PDF <-> notes view (#106): the link between a notes page and a PDF page.
 *
 * The notebook format has no field for it (no format change in this wave), so the mapping lives in a
 * sidecar JSON file in `<notebooks folder>/_meta/` (storage/pdf-links-store.ts) and is written only by explicit
 * link actions, never while scrolling. This module is pure: parsing, serialising, queries and the
 * follow decisions, testable in Node without Obsidian.
 *
 * A link says: page `page` of notebook `notebook` belongs to page `pdfPage` of the PDF identified by
 * `source`. `source` is the content-addressed id of the PDF (the first 24 hex chars of its SHA-256, the same
 * id a notebook uses for the asset), so the link survives renaming or moving the file and works the same for
 * a plain `.pdf` in the vault and for the PDF background of another notebook. `path` is only a hint for plain
 * vault PDFs: a PDF that is replaced by a new version in place (so its hash changed) is still recognised by it.
 */

export const LINKS_FORMAT = "obsidian-notebook-pdf-links";
export const LINKS_VERSION = 1;

/** One page of one PDF. */
export interface PdfRef {
	/** Content-addressed id of the PDF. */
	source: string;
	/** 1-based page number. */
	page: number;
	/** Vault path of a plain PDF (hint, see the module comment). */
	path?: string;
}

export interface PdfLink extends PdfRef {
	/** Id of the notes notebook (`document.id`). */
	notebook: string;
	/** Id of the notes page. */
	notesPage: string;
}

export interface LinksData {
	version: number;
	links: PdfLink[];
	/** Entries this version does not understand: kept and written back as they were. */
	unknown: unknown[];
}

export type LinksParse =
	| { ok: true; data: LinksData }
	| { ok: false; reason: "json" | "format" | "future"; message: string };

export type LinksOp =
	| { type: "set"; link: PdfLink }
	| { type: "remove"; notebook: string; notesPage: string };

export function emptyLinks(): LinksData {
	return { version: LINKS_VERSION, links: [], unknown: [] };
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readLink(v: unknown): PdfLink | null {
	if (!isObject(v)) return null;
	const { notebook, page, source, pdfPage, path } = v;
	if (typeof notebook !== "string" || notebook === "") return null;
	if (typeof page !== "string" || page === "") return null;
	if (typeof source !== "string" || source === "") return null;
	if (typeof pdfPage !== "number" || !Number.isInteger(pdfPage) || pdfPage < 1) return null;
	if (path !== undefined && typeof path !== "string") return null;
	const link: PdfLink = { notebook, notesPage: page, source, page: pdfPage };
	if (path !== undefined && path !== "") link.path = path;
	return link;
}

/** Reads the sidecar text. A file that is not ours or comes from a newer version is reported, never "fixed". */
export function parseLinks(text: string): LinksParse {
	if (text.trim() === "") return { ok: true, data: emptyLinks() };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== LINKS_FORMAT || typeof raw.version !== "number" || !Array.isArray(raw.links)) {
		return { ok: false, reason: "format", message: "not a Notebook PDF links file" };
	}
	if (raw.version > LINKS_VERSION) {
		return { ok: false, reason: "future", message: `links file version ${raw.version} is newer than this plugin supports` };
	}
	const data = emptyLinks();
	for (const entry of raw.links) {
		const link = readLink(entry);
		if (link) data.links.push(link);
		else data.unknown.push(entry);
	}
	return { ok: true, data };
}

function linkJson(l: PdfLink): string {
	const o: Record<string, unknown> = { notebook: l.notebook, page: l.notesPage, source: l.source, pdfPage: l.page };
	if (l.path) o.path = l.path;
	return JSON.stringify(o);
}

/** Deterministic text, one link per line (small diffs, easy for sync tools to merge). */
export function serializeLinks(data: LinksData): string {
	const lines = [...data.links.map(linkJson), ...data.unknown.map((u) => JSON.stringify(u))];
	const body = lines.length ? `\n${lines.join(",\n")}\n` : "";
	return `{"format":"${LINKS_FORMAT}","version":${LINKS_VERSION},"links":[${body}]}\n`;
}

/** The data after one operation. `set` replaces the link of the same notes page (a page has one link). */
export function applyLinkOp(data: LinksData, op: LinksOp): LinksData {
	const same = (l: PdfLink, notebook: string, notesPage: string) => l.notebook === notebook && l.notesPage === notesPage;
	if (op.type === "remove") {
		return { ...data, links: data.links.filter((l) => !same(l, op.notebook, op.notesPage)) };
	}
	const at = data.links.findIndex((l) => same(l, op.link.notebook, op.link.notesPage));
	const links = data.links.slice();
	if (at >= 0) links[at] = op.link;
	else links.push(op.link);
	return { ...data, links };
}

/** Same PDF: equal content id, or (plain vault PDFs) equal path, which covers a file replaced by a new version. */
export function sameSource(a: { source: string; path?: string }, b: { source: string; path?: string }): boolean {
	return a.source === b.source || (!!a.path && a.path === b.path);
}

/** The link of a notes page, if it has one. */
export function linkOf(data: LinksData, notebook: string, notesPage: string): PdfLink | null {
	return data.links.find((l) => l.notebook === notebook && l.notesPage === notesPage) ?? null;
}

/** Indices (document order) of the notes pages linked to `ref`; links to pages that no longer exist are ignored. */
export function notesPagesFor(data: LinksData, notebook: string, ref: PdfRef, pageIds: readonly string[]): number[] {
	const out: number[] = [];
	pageIds.forEach((id, i) => {
		const l = linkOf(data, notebook, id);
		if (l && l.page === ref.page && sameSource(l, ref)) out.push(i);
	});
	return out;
}

/** What to do with the notes side when the PDF side shows `ref`. */
export type FollowFromPdf =
	| { kind: "stay" }
	| { kind: "go"; index: number }
	| { kind: "none" };

/** `stay`: the notes page in view is already linked to it; `go`: show the first linked page; `none`: offer to add one. */
export function decideFromPdf(data: LinksData, notebook: string, ref: PdfRef, pageIds: readonly string[], currentIndex: number): FollowFromPdf {
	const linked = notesPagesFor(data, notebook, ref, pageIds);
	if (linked.length === 0) return { kind: "none" };
	if (linked.includes(currentIndex)) return { kind: "stay" };
	return { kind: "go", index: linked[0]! };
}

export type LinkState = "here" | "elsewhere" | "none";

/** `here`: linked to `ref`; `elsewhere`: linked to another PDF page; `none`: no link. Drives the link / unlink button. */
export function linkState(data: LinksData, notebook: string, notesPage: string, ref: PdfRef): LinkState {
	const l = linkOf(data, notebook, notesPage);
	if (!l) return "none";
	return l.page === ref.page && sameSource(l, ref) ? "here" : "elsewhere";
}

/**
 * Where a new notes page for `ref` goes so the notes stay in slide order: after the last page linked to this PDF at or
 * before `ref.page`; otherwise before the first page linked to a later page; otherwise after the page in view.
 */
export function insertionIndex(data: LinksData, notebook: string, ref: PdfRef, pageIds: readonly string[], currentIndex: number): number {
	let after = -1;
	let before = -1;
	pageIds.forEach((id, i) => {
		const l = linkOf(data, notebook, id);
		if (!l || !sameSource(l, ref)) return;
		if (l.page <= ref.page) after = i;
		else if (before < 0) before = i;
	});
	if (after >= 0) return after + 1;
	if (before >= 0) return before;
	return Math.min(pageIds.length, Math.max(0, currentIndex + 1));
}
