/**
 * The outline of a PDF placed on the pages of a notebook (0.16, roadmap #46). Pure: no 'obsidian' import.
 *
 * A notebook shows a PDF's pages as it was imported: all of them, or only a range, and the pages may have been moved or
 * deleted since. The outline of the PDF talks about the PDF's own pages, so each entry is mapped by *source page*: the
 * notebook page whose background is that page of that PDF (the first one, when a page appears twice). An entry whose page
 * is not in the notebook goes to the next page that is, as long as no later entry of the outline begins at or before that
 * page (otherwise it would take the place of that entry); otherwise it is left out.
 */
import type { Page } from "./types";

/** What the mapping needs of an outline entry (see pdf/pdf-outline.ts). */
export interface OutlineEntryLike {
	title: string;
	level: number;
	/** 1-based page of the PDF; 0: unknown. */
	page: number;
}

export interface MappedPdfEntry {
	/** Position in the PDF's outline (keeps the key of the row stable). */
	n: number;
	title: string;
	level: number;
	/** 1-based page of the PDF the entry points at. */
	sourcePage: number;
	/** 0-based index of the notebook page it goes to. */
	index: number;
	/** The notebook shows the page the entry points at (false: it goes to the next page that is shown). */
	exact: boolean;
}

/** The first notebook page (index) of every page of `asset`, by the PDF's own page number. */
export function sourcePageIndex(pages: readonly Page[], asset: string): Map<number, number> {
	const map = new Map<number, number>();
	pages.forEach((page, index) => {
		const bg = page.background;
		if (bg?.kind === "pdf" && bg.asset === asset && !map.has(bg.page)) map.set(bg.page, index);
	});
	return map;
}

/** The entries of `asset`'s outline that can be shown in this notebook, with the notebook page each goes to. */
export function mapPdfOutline(pages: readonly Page[], asset: string, entries: readonly OutlineEntryLike[]): MappedPdfEntry[] {
	const byPage = sourcePageIndex(pages, asset);
	if (byPage.size === 0 || entries.length === 0) return [];
	const kept = [...byPage.keys()].sort((a, b) => a - b);
	const starts = [...new Set(entries.filter((e) => e.page > 0).map((e) => e.page))].sort((a, b) => a - b);
	const out: MappedPdfEntry[] = [];
	entries.forEach((e, n) => {
		if (e.page <= 0) return;
		const exact = byPage.get(e.page);
		if (exact !== undefined) {
			out.push({ n, title: e.title, level: e.level, sourcePage: e.page, index: exact, exact: true });
			return;
		}
		const next = kept.find((k) => k > e.page);
		if (next === undefined) return;
		const laterStart = starts.find((s) => s > e.page);
		if (laterStart !== undefined && laterStart <= next) return;
		out.push({ n, title: e.title, level: e.level, sourcePage: e.page, index: byPage.get(next)!, exact: false });
	});
	return out;
}
