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

// ------------------------------------------------------------------ cost control

/** PDFs larger than this are not read and hashed for "Annotate in Notebook" (the whole file is held in memory, also on Android). */
export const ANNOTATE_PDF_MAX_BYTES = 200 * 1024 * 1024;
/** More notebooks than this to read: a progress window with a cancel button is shown. */
export const SCAN_PROGRESS_FROM = 25;
const MAX_HASHES = 64;
const MAX_NOTEBOOKS = 4000;

/**
 * The asset ids a notebook's text names where asset ids live: the value of an `"asset"` field (a page background) and the keys
 * of the `assets` map. A superset of the PDFs it annotates, found without parsing it; other quoted hex strings are not kept.
 */
export function assetIdsInText(text: string): Set<string> {
	const ids = new Set<string>();
	for (const m of text.matchAll(/"asset"\s*:\s*"([0-9a-f]{24,64})"|"([0-9a-f]{24,64})"\s*:/g)) {
		const id = (m[1] ?? m[2])!;
		ids.add(id);
		ids.add(id.slice(0, 24));
	}
	return ids;
}

/** What identifies a file's content cheaply: its modification time and size. */
export function fileKey(stat: { mtime: number; size: number }): string {
	return `${stat.mtime}:${stat.size}`;
}

/**
 * Remembers, for this session only, the asset id of a PDF (by path + mtime + size, so it is not read and hashed again) and
 * the asset ids each notebook names (by path + mtime + size, so only a changed notebook is read again). Both are bounded;
 * the oldest entries go first. Nothing is written anywhere.
 */
export class AnnotateCache {
	private readonly hashes = new Map<string, { key: string; id: string }>();
	private readonly notebooks = new Map<string, { key: string; ids: ReadonlySet<string> }>();

	pdfId(path: string, key: string): string | null {
		const e = this.hashes.get(path);
		return e && e.key === key ? e.id : null;
	}

	setPdfId(path: string, key: string, id: string): void {
		this.hashes.delete(path);
		this.hashes.set(path, { key, id });
		while (this.hashes.size > MAX_HASHES) this.hashes.delete(this.hashes.keys().next().value as string);
	}

	notebookIds(path: string, key: string): ReadonlySet<string> | null {
		const e = this.notebooks.get(path);
		return e && e.key === key ? e.ids : null;
	}

	setNotebookIds(path: string, key: string, ids: ReadonlySet<string>): void {
		this.notebooks.delete(path);
		this.notebooks.set(path, { key, ids });
		while (this.notebooks.size > MAX_NOTEBOOKS) this.notebooks.delete(this.notebooks.keys().next().value as string);
	}

	get size(): { pdfs: number; notebooks: number } {
		return { pdfs: this.hashes.size, notebooks: this.notebooks.size };
	}
}

export interface ScanDeps<F> {
	path(f: F): string;
	key(f: F): string;
	/** The text of the notebook file (only called for a notebook the cache does not know). */
	read(f: F): Promise<string>;
	cache: AnnotateCache;
	/** Called with (done, total) before the first read and after each one; `total` counts only the notebooks that must be read. */
	progress?(done: number, total: number): void;
	cancelled?(): boolean;
	/** Lets the UI breathe now and then. */
	yieldNow?(): Promise<void>;
	/** A notebook that cannot be read is skipped (and reported here). */
	failed?(f: F, error: unknown): void;
}

/** The files whose text names `assetId`, using the cache so only new or changed notebooks are read; `cancelled` is true when stopped. */
export async function notebooksNaming<F>(files: readonly F[], assetId: string, deps: ScanDeps<F>): Promise<{ matches: F[]; cancelled: boolean }> {
	const { cache } = deps;
	const todo = files.filter((f) => cache.notebookIds(deps.path(f), deps.key(f)) === null);
	let done = 0;
	deps.progress?.(0, todo.length);
	for (const f of todo) {
		if (deps.cancelled?.()) return { matches: [], cancelled: true };
		try {
			cache.setNotebookIds(deps.path(f), deps.key(f), assetIdsInText(await deps.read(f)));
		} catch (e) {
			deps.failed?.(f, e);
		}
		done++;
		deps.progress?.(done, todo.length);
		if (done % 8 === 0) await deps.yieldNow?.();
	}
	if (deps.cancelled?.()) return { matches: [], cancelled: true };
	return { matches: files.filter((f) => assetId.length > 0 && cache.notebookIds(deps.path(f), deps.key(f))?.has(assetId) === true), cancelled: false };
}
