/**
 * Bulk import (0.16, roadmap #80): the sequential runner. One notebook at a time, one file at a time, giving the UI thread
 * back between steps so a big batch never freezes the window. Nothing here knows Obsidian: the host injects how a file is
 * stored, measured and created, so the flow is tested in Node with a fake vault.
 *
 * Rules: a file that cannot be read, decoded or measured is skipped with a reason and the rest go on; a notebook is
 * never written over (the host's `create` picks a free name); cancelling stops after the file in progress; the source files
 * are never touched.
 */
import { createDocument } from "../model/document";
import { serializeChecked } from "../model/serialize";
import { PAGE_SIZES, PAPER_SPACING, type Asset, type NotebookDocument, type Page, type PaperKind } from "../model/types";
import type { CoverFamily } from "../model/cover-family";
import { scannedPage } from "../scan/pages";
import { applyNotebookMeta } from "../view/create-logic";
import { buildPdfDocument, type PageSizePt } from "./import-pdf";
import { bulkLimit, bulkLimitMb, type BulkKind, type BulkOutcome, type BulkSource, type SkipReason } from "./bulk-import-logic";

/** What every notebook of the run looks like. */
export interface BulkLook {
	/** The paper drawn on every page (over the PDF or photo); "blank" leaves the page as it is. */
	paper: PaperKind;
	/** Cover colour `#rrggbb` with generated art, or null to leave the cover automatic (as a single import does). */
	cover: string | null;
}

/** A file refused in the middle of the run, with the reason to show. */
export class BulkSkipError extends Error {
	constructor(readonly reason: SkipReason, detail?: string) {
		super(detail ?? reason);
		this.name = "BulkSkipError";
	}
}

/** A notebook to make. */
export interface BulkJob {
	key: string;
	kind: BulkKind;
	/** The planned name (unique at planning time; `create` still never overwrites). */
	name: string;
	/** The files that become its pages, in order. */
	files: Array<{ fileName: string; source: BulkSource }>;
}

export interface BulkRunDeps<F> {
	store(bytes: ArrayBuffer, name: string, kind: BulkKind): Promise<Asset>;
	/**
	 * Removes the stored copy of a file that turned out unusable (a damaged PDF) or whose notebook could not be made. Called only
	 * for assets no notebook of this run uses; the host removes it only if this run created it (never a file that was already there).
	 */
	discard?(asset: Asset): Promise<void>;
	pdfSizes(assetId: string): Promise<PageSizePt[]>;
	/** Pixel size of an image; throws `BulkSkipError("heic")` for a photo the WebView cannot decode, anything else for a broken one. */
	imageSize(bytes: ArrayBuffer, name: string, type: string): Promise<{ width: number; height: number }>;
	create(folder: string, name: string, doc: NotebookDocument): Promise<{ file: F; path: string }>;
	/** The art style the generated cover of a notebook with this name gets. */
	artStyle(name: string): CoverFamily;
	/** Gives the UI thread back (a timer tick, not a microtask). */
	yieldToUi(): Promise<void>;
}

export interface BulkProgress {
	/** Source files handled so far. */
	done: number;
	total: number;
	/** The notebook in progress and the file being read. */
	notebook: string;
	file: string;
	/** 1-based position of the notebook among the jobs. */
	job: number;
	jobs: number;
}

export interface BulkControl {
	cancelled(): boolean;
	onProgress(p: BulkProgress): void;
}

export interface BulkRunResult<F> {
	outcomes: BulkOutcome[];
	/** The notebook files made, by job key. */
	files: Map<string, F>;
	notStarted: number;
	cancelled: boolean;
}

/** Sets the paper and the cover of a freshly built notebook. */
export function applyLook(doc: NotebookDocument, look: BulkLook, name: string, style: CoverFamily): void {
	if (look.paper !== "blank") {
		for (const page of doc.pages) page.paper = { kind: look.paper, spacing: PAPER_SPACING[look.paper] };
	}
	if (look.cover !== null) applyNotebookMeta(doc, { color: look.cover, description: "", art: { style, seed: name } });
	else if (doc.meta) delete doc.meta.coverArt;
}

/** A notebook with one page per image (page size from the picture's shape), their files as assets. */
export function buildImagesDocument(pages: readonly Page[], assets: readonly Asset[], now: Date = new Date()): NotebookDocument {
	if (pages.length === 0) throw new Error("no images");
	const doc = createDocument(now, PAGE_SIZES.a4, { kind: "blank", spacing: PAPER_SPACING.blank });
	doc.pages = [...pages];
	doc.assets = Object.fromEntries(assets.map((a) => [a.id, a]));
	return doc;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs the jobs one after the other. Never throws: every problem is part of the outcomes. */
export async function runBulkImport<F>(
	jobs: readonly BulkJob[], folder: string, look: BulkLook, deps: BulkRunDeps<F>, ctl: BulkControl, now: Date = new Date(),
): Promise<BulkRunResult<F>> {
	const outcomes: BulkOutcome[] = [];
	const files = new Map<string, F>();
	const total = jobs.reduce((n, j) => n + j.files.length, 0);
	let done = 0;
	let started = 0;
	let cancelled = false;
	// Assets that a notebook of this run (made, or being made) holds; a copy no notebook holds can be dropped again.
	const kept = new Set<string>();
	const drop = async (asset: Asset): Promise<void> => {
		if (kept.has(asset.id) || !deps.discard) return;
		try {
			await deps.discard(asset);
		} catch (e) {
			console.error("[notebook] bulk import: could not remove an unused copy", e);
		}
	};

	for (const [index, job] of jobs.entries()) {
		if (ctl.cancelled()) {
			cancelled = true;
			break;
		}
		started++;
		const out: BulkOutcome = { key: job.key, name: job.name, path: null, pages: 0, skipped: [], failed: null, partial: false };
		outcomes.push(out);
		const pages: Page[] = [];
		const assets: Asset[] = [];
		const stored: Asset[] = []; // every copy this job stored and still holds
		let pdfDoc: NotebookDocument | null = null;

		for (const item of job.files) {
			if (ctl.cancelled()) {
				cancelled = true;
				break;
			}
			ctl.onProgress({ done, total, notebook: job.name, file: item.fileName, job: index + 1, jobs: jobs.length });
			await deps.yieldToUi();
			try {
				const bytes = await item.source.read().catch(() => {
					throw new BulkSkipError("unreadable");
				});
				if (bytes.byteLength === 0) throw new BulkSkipError("empty");
				// The size is checked again on the bytes: the list only knew what the platform reported.
				if (bytes.byteLength > bulkLimit(job.kind)) throw new BulkSkipError("tooBig", String(bulkLimitMb(job.kind)));
				if (job.kind === "pdf") {
					const asset = await deps.store(bytes, item.fileName, "pdf");
					let sizes: PageSizePt[];
					try {
						sizes = await deps.pdfSizes(asset.id);
					} catch (e) {
						await drop(asset); // the copy just stored is of no use: do not leave it in the assets folder
						throw new BulkSkipError("corrupt", messageOf(e));
					}
					if (sizes.length === 0) {
						await drop(asset);
						throw new BulkSkipError("empty");
					}
					pdfDoc = buildPdfDocument(asset, sizes, now);
					stored.push(asset);
				} else {
					const size = await deps.imageSize(bytes, item.fileName, item.source.type).catch((e: unknown) => {
						throw e instanceof BulkSkipError ? e : new BulkSkipError("corrupt", messageOf(e));
					});
					const asset = await deps.store(bytes, item.fileName, "image");
					assets.push(asset);
					stored.push(asset);
					pages.push(scannedPage(asset, size.width, size.height));
				}
			} catch (e) {
				if (e instanceof BulkSkipError) out.skipped.push({ file: item.fileName, reason: e.reason, ...(e.message !== e.reason ? { detail: e.message } : {}) });
				else out.skipped.push({ file: item.fileName, reason: "unreadable", detail: messageOf(e) });
			}
			done++;
			await deps.yieldToUi();
		}

		const doc = job.kind === "pdf" ? pdfDoc : pages.length > 0 ? buildImagesDocument(pages, assets, now) : null;
		if (cancelled && doc === null && out.skipped.length === 0) {
			// Cancelled before this notebook got anywhere: it was never started.
			outcomes.pop();
			started--;
			break;
		}
		out.partial = cancelled && job.kind === "image" && pages.length + out.skipped.length < job.files.length;
		if (doc === null) {
			if (out.skipped.length === 0) out.failed = "nothing to import";
			if (cancelled) break;
			continue;
		}
		try {
			applyLook(doc, look, job.name, deps.artStyle(job.name));
			const checked = serializeChecked(doc);
			if (!checked.ok) throw new Error(checked.message);
			const made = await deps.create(folder, job.name, doc);
			out.path = made.path;
			out.pages = doc.pages.length;
			files.set(job.key, made.file);
			for (const a of stored) kept.add(a.id);
		} catch (e) {
			out.failed = messageOf(e);
			for (const a of stored) await drop(a); // no notebook holds these copies
		}
		await deps.yieldToUi();
		if (cancelled) break;
	}
	return { outcomes, files, notStarted: jobs.length - started, cancelled };
}
