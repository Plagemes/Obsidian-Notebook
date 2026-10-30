import { normalizePath, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { layerFlags, planExport, type ExportFormat, type ExportLayers, type ExportScope } from "../ink/export-layers";
import { pagesToPdf, type PdfPlacedImage } from "../ink/export-pdf";
import { pageToSvg, type SvgPlacedImage } from "../ink/export-svg";
import type { BoxLabel } from "../ink/marker-render";
import { backgroundRect } from "../model/margins";
import type { Page } from "../model/types";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";

/** Resolution of rasterised PDF pages in exports. */
const PDF_DPI = 200;

/** Path next to the notebook, adding " 2", " 3"… if taken. */
export function freePath(app: App, notebook: TFile, suffix: string, ext: string): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	let path = normalizePath(`${dir}${notebook.basename}${suffix}.${ext}`);
	for (let i = 2; app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}${notebook.basename}${suffix} ${i}.${ext}`);
	return path;
}

type Jpeg = { jpeg: Uint8Array; pixelWidth: number; pixelHeight: number };

/** Images each page needs in an export: its PDF/image background and its image elements, as JPEG. */
export interface PageImages {
	images: Map<Page, PdfPlacedImage[]>;
	/** Images that could not be produced (missing file...); the export goes on without them. */
	skipped: number;
}

/**
 * Rasterises what the writers cannot draw themselves. PDF pages become JPEG backgrounds at 200 dpi, images are
 * re-encoded as JPEG. The same asset on several pages shares one `Uint8Array`, so the writers embed it once.
 * Pages are processed one after the other to keep memory low.
 */
export async function collectPageImages(media: NotebookMedia | null, pages: readonly Page[], layers: ExportLayers = "both"): Promise<PageImages> {
	const out: PageImages = { images: new Map(), skipped: 0 };
	if (!media) return out;
	// wave 0.9 (381): what the export leaves out is not loaded either (an ink-only export never rasterises the PDF).
	const flags = layerFlags(layers);
	const cache = new Map<string, Promise<Jpeg | null>>();
	const load = (key: string, make: () => Promise<Jpeg>): Promise<Jpeg | null> => {
		let p = cache.get(key);
		if (!p) {
			p = make().catch((e) => {
				console.error("[notebook] export image", key, e);
				return null;
			});
			cache.set(key, p);
		}
		return p;
	};
	for (const page of pages) {
		const list: PdfPlacedImage[] = [];
		const bg = flags.background ? page.background : undefined;
		if (bg) {
			const jpeg = bg.kind === "pdf"
				? await load(`pdf:${bg.asset}:${bg.page}`, () => media.pdfPageJpeg(bg.asset, bg.page, PDF_DPI))
				: await load(`img:${bg.asset}`, () => media.imageJpeg(bg.asset));
			if (jpeg) list.push({ ...jpeg, ...backgroundRect(page), layer: "background" });
			else out.skipped++;
		}
		for (const el of flags.content ? page.elements ?? [] : []) {
			if (el.type !== "image") continue;
			const jpeg = await load(`img:${el.asset}`, () => media.imageJpeg(el.asset));
			if (jpeg) list.push({ ...jpeg, x: el.x, y: el.y, width: el.width, height: el.height, rotation: el.rotation, layer: "element" });
			else out.skipped++;
		}
		if (list.length > 0) out.images.set(page, list);
	}
	return out;
}

/** `data:image/jpeg;base64,…` for an SVG `href`. */
export function jpegDataUrl(jpeg: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < jpeg.length; i += CHUNK) binary += String.fromCharCode(...jpeg.subarray(i, i + CHUNK));
	return `data:image/jpeg;base64,${btoa(binary)}`;
}

function reportSkipped(skipped: number): void {
	if (skipped > 0) showNotice(t("export.skipped", { n: String(skipped) }), 8000);
}

/** v8: which hidden ink an export draws (default none: it is the solutions) and how boxes are labelled. */
export interface ExportOptions {
	hiddenInk?: (page: Page) => boolean;
	boxLabel?: BoxLabel;
	/** wave 0.9 (381): ink only, background only or both (default). */
	layers?: ExportLayers;
}

/** Writes a PDF of `pages` next to the notebook; `suffix` distinguishes single-page exports. */
export async function exportPdf(
	app: App, notebook: TFile, pages: readonly Page[], suffix = "", media: NotebookMedia | null = null, options: ExportOptions = {},
): Promise<void> {
	const working = showNotice(t("export.working"), 0);
	try {
		const { images, skipped } = await collectPageImages(media, pages, options.layers);
		const bytes = pagesToPdf(pages, {
			paper: true, title: notebook.basename, images: (p) => images.get(p) ?? [],
			...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}), ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
			...(options.layers ? { layers: options.layers } : {}),
		});
		const path = freePath(app, notebook, suffix, "pdf");
		await app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		showNotice(t("export.done", { path }));
		reportSkipped(skipped);
	} catch (e) {
		showNotice(t("export.failed", { error: (e as Error).message }));
	} finally {
		working.hide();
	}
}

/** SVG of one page: the text, the images it needs and the path it is written to. */
async function buildSvg(app: App, notebook: TFile, page: Page, suffix: string, media: NotebookMedia | null, options: ExportOptions): Promise<{ path: string; skipped: number }> {
	const { images, skipped } = await collectPageImages(media, [page], options.layers);
	const svgImages = (p: Page): SvgPlacedImage[] => (images.get(p) ?? []).map((img) => ({
		href: jpegDataUrl(img.jpeg), x: img.x, y: img.y, width: img.width, height: img.height,
		...(img.rotation !== undefined ? { rotation: img.rotation } : {}),
		...(img.layer !== undefined ? { layer: img.layer } : {}),
	}));
	const path = freePath(app, notebook, suffix, "svg");
	await app.vault.create(path, pageToSvg(page, {
		paper: true, images: svgImages, hiddenInk: options.hiddenInk?.(page) ?? false, ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
		...(options.layers ? { layers: options.layers } : {}),
	}));
	return { path, skipped };
}

export async function exportSvg(app: App, notebook: TFile, page: Page, suffix: string, media: NotebookMedia | null = null, options: ExportOptions = {}): Promise<void> {
	const working = showNotice(t("export.working"), 0);
	try {
		const { path, skipped } = await buildSvg(app, notebook, page, suffix, media, options);
		showNotice(t("export.done", { path }));
		reportSkipped(skipped);
	} catch (e) {
		showNotice(t("export.failed", { error: (e as Error).message }));
	} finally {
		working.hide();
	}
}

/** What the export dialog asks for (wave 0.9, 381). */
export interface ExportRequest {
	format: ExportFormat;
	scope: ExportScope;
	/** The page of a single-page export (0-based). */
	pageIndex: number;
	layers: ExportLayers;
}

/**
 * Writes the files an export dialog asked for next to the notebook: one PDF, or one SVG per page for a whole notebook.
 * Existing files are never overwritten (the name gets " 2", " 3"…).
 */
export async function runExport(app: App, notebook: TFile, pages: readonly Page[], request: ExportRequest, media: NotebookMedia | null, options: ExportOptions = {}): Promise<void> {
	const jobs = planExport(request.format, request.scope, request.pageIndex, pages.length, request.layers);
	const opts: ExportOptions = { ...options, layers: request.layers };
	if (jobs.length === 0) return;
	if (request.format === "pdf") {
		const job = jobs[0]!;
		await exportPdf(app, notebook, job.pages.map((i) => pages[i]!), job.suffix, media, opts);
		return;
	}
	if (jobs.length === 1) {
		await exportSvg(app, notebook, pages[jobs[0]!.pages[0]!]!, jobs[0]!.suffix, media, opts);
		return;
	}
	const working = showNotice(t("export.working"), 0);
	let skipped = 0;
	let written = 0;
	let last = "";
	try {
		for (const job of jobs) {
			const result = await buildSvg(app, notebook, pages[job.pages[0]!]!, job.suffix, media, opts);
			skipped += result.skipped;
			written++;
			last = result.path;
			working.setMessage(t("export.progress", { done: String(written), total: String(jobs.length) }));
		}
		showNotice(t("export.doneMany", { n: String(written), path: last }));
		reportSkipped(skipped);
	} catch (e) {
		showNotice(t("export.failedMany", { done: String(written), error: (e as Error).message }), 8000);
	} finally {
		working.hide();
	}
}
