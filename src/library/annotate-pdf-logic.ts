// Pure logic of "Annotate in Notebook" for a PDF opened in Obsidian: which notebooks already annotate this PDF, and which
// notebook page to open. No 'obsidian' import: tested in Node.

/** What the search needs to know about one notebook (made from its document by `summarizeForAnnotate`). */
export interface AnnotateCandidate {
	path: string;
	name: string;
	/** Document modification time (ms). */
	modified: number;
	/** Per notebook page (index 0 = page 1): the PDF background of the page, absent when it has none. */
	backgrounds: Array<{ asset: string; page: number } | null>;
}

export interface Annotator {
	path: string;
	name: string;
	modified: number;
	/** Notebook pages that show a page of this PDF. */
	pdfPages: number;
	/** Notebook page (1-based) to open for the wanted PDF page. */
	openPage: number;
}

/** The structural part of a notebook document the summary reads (so tests need no full document). */
export interface AnnotateDocLike {
	modified?: number;
	pages: ReadonlyArray<{ background?: { kind: string; asset?: string; page?: number } | undefined }>;
}

export function summarizeForAnnotate(path: string, name: string, doc: AnnotateDocLike): AnnotateCandidate {
	return {
		path, name,
		modified: typeof doc.modified === "number" ? doc.modified : 0,
		backgrounds: doc.pages.map((p) => {
			const b = p.background;
			return b && b.kind === "pdf" && typeof b.asset === "string" && typeof b.page === "number" ? { asset: b.asset, page: b.page } : null;
		}),
	};
}

/** Notebook page (1-based) to open: the first page that shows PDF page `pdfPage`, else the first page of this PDF, else 1. */
export function notebookPageFor(backgrounds: AnnotateCandidate["backgrounds"], assetId: string, pdfPage: number | null): number {
	let firstOfPdf = 0;
	for (let i = 0; i < backgrounds.length; i++) {
		const b = backgrounds[i];
		if (!b || b.asset !== assetId) continue;
		if (pdfPage !== null && b.page === pdfPage) return i + 1;
		if (!firstOfPdf) firstOfPdf = i + 1;
	}
	return firstOfPdf || 1;
}

/** The notebooks that have at least one page on the PDF `assetId`, most recently changed first. */
export function findAnnotators(candidates: readonly AnnotateCandidate[], assetId: string, pdfPage: number | null): Annotator[] {
	const out: Annotator[] = [];
	for (const c of candidates) {
		const pdfPages = c.backgrounds.filter((b) => b !== null && b.asset === assetId).length;
		if (pdfPages === 0) continue;
		out.push({ path: c.path, name: c.name, modified: c.modified, pdfPages, openPage: notebookPageFor(c.backgrounds, assetId, pdfPage) });
	}
	return out.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}

/** Cheap pre-filter: a notebook file can only annotate the PDF when its text names the asset id. */
export function mayMentionAsset(notebookText: string, assetId: string): boolean {
	return assetId.length > 0 && notebookText.includes(assetId);
}

function walk(o: unknown, path: readonly string[]): unknown {
	let cur = o;
	for (const k of path) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Record<string, unknown>)[k];
	}
	return cur;
}

/**
 * The page Obsidian's PDF viewer shows, best effort: its internals are not public API, so every step is checked and any
 * surprise gives null (the caller then opens page 1). Reads `view.viewer.child.pdfViewer.pdfViewer.currentPageNumber`.
 */
export function viewerPageNumber(view: unknown): number | null {
	const paths = [
		["viewer", "child", "pdfViewer", "pdfViewer", "currentPageNumber"],
		["viewer", "child", "pdfViewer", "currentPageNumber"],
	];
	for (const p of paths) {
		const n = walk(view, p);
		if (typeof n === "number" && Number.isInteger(n) && n >= 1) return n;
	}
	return null;
}
