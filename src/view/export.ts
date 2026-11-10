import { normalizePath, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { layerFlags, planExport, type ExportFormat, type ExportLayers, type ExportScope } from "../ink/export-layers";
import { pagesToPdf, pagesToPdfYielding, type PdfCommentLabels, type PdfOptions, type PdfPlacedImage } from "../ink/export-pdf";
import { planSplit, type SplitSettings } from "../ink/export-tiles";
import { pageToSvg, type SvgPlacedImage } from "../ink/export-svg";
import { htmlHead, htmlPage, htmlTail, ImageBudget, pageHtmlLinks, type HtmlViewerLabels } from "../ink/export-html";
import type { FigureLabelSource } from "../ink/figure-text";
import type { BoxLabel } from "../ink/marker-render";
import type { HeaderLayout } from "../ink/page-header";
import { DEFAULT_PNG_SCALE } from "../model/export-pages";
import { cleanPagesForExport, resolveCleanOptions, type CleanExportOptions } from "../model/clean-export";
import { backgroundRect } from "../model/margins";
import { viewKey, viewOf } from "../model/pdf-view";
import { burnKey, burnPlan, withExcerptChains } from "../ink/redact";
import { countBoxes, type Redactions } from "../model/redact";
import { announceRedaction, withRedaction } from "./export-redact";
import { recordPluginWrite } from "../storage/plugin-written";
import type { Page } from "../model/types";
import { exportPngPages } from "./export-png";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { printPages } from "./print";

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
			// 0.26 (#285): the boxes of a redacted page are burned into its background picture, which is then the only picture of it in the file.
			const burn = burnPlan(page);
			const burnTag = burn ? `:burn:${burnKey(burn.boxes)}` : "";
			const jpeg = bg.kind === "pdf"
				// 0.28 (#76): the picture is the part of the PDF page the background shows, turned: the PDF is re-embedded as the page shows it.
				? await load(`pdf:${bg.asset}:${bg.page}:${viewKey(viewOf(bg))}${burnTag}`, () => media.pdfPageJpeg(bg.asset, bg.page, PDF_DPI, burn ?? undefined, viewOf(bg)))
				: await load(`img:${bg.asset}${burnTag}`, () => media.imageJpeg(bg.asset, burn ?? undefined));
			if (jpeg) list.push({ ...jpeg, ...backgroundRect(page), layer: "background" });
			else out.skipped++;
		}
		for (const el of flags.content ? page.elements ?? [] : []) {
			// v10: an excerpt is exported as its snapshot (exports are deterministic and never read another notebook).
			if (el.type === "excerpt") {
				const asset = el.asset;
				if (asset === undefined) continue;
				const jpeg = await load(`img:${asset}`, () => media.imageJpeg(asset));
				if (jpeg) list.push({ ...jpeg, x: el.x, y: el.y, width: el.width, height: el.height, rotation: 0, layer: "element" });
				else out.skipped++;
				continue;
			}
			if (el.type !== "image") continue;
			const jpeg = await load(`img:${el.asset}`, () => media.imageJpeg(el.asset));
			if (jpeg) list.push({ ...jpeg, x: el.x, y: el.y, width: el.width, height: el.height, rotation: el.rotation, ...(el.opacity !== undefined ? { opacity: el.opacity } : {}), layer: "element" });
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
	/** v9: runs before writing (typesets the equations that have no cached outline yet). */
	prepare?: (pages: readonly Page[]) => Promise<void>;
	/** v9: numbers of the numbered equations, counted over the whole notebook (a single page keeps its numbers). */
	equationNumbers?: ReadonlyMap<string, number>;
	/** wave 0.9 (381): ink only, background only or both (default). */
	layers?: ExportLayers;
	/** 0.15 (#75): the automatic page header or footer of a page (null: none); absent when the reader turned it off for exports. */
	header?: (page: Page) => HeaderLayout | null;
	/** 0.18 (#86): the margin comments as notes in a strip beside the pages that have them (PDF only); absent when the setting is off. */
	comments?: PdfCommentLabels;
	/** 0.18 (#178): split the infinite pages into sheets of paper (PDF and PNG); the other pages are exported as they are. */
	split?: SplitSettings;
	/**
	 * 0.26 (#285): the redaction boxes by page id. Every writer that puts pages into a file or a picture applies them first (`withRedaction`):
	 * what lies under a box is left out of the file, the box is drawn solid black. Absent: nothing is covered.
	 */
	redact?: Redactions;
	/**
	 * Review fix (P4): the notebook's redaction boxes could not be read on this device (and none are held in memory). Every writer then
	 * refuses to write (`withRedaction` throws), whatever the boxes would have covered: it is never known that nothing was covered.
	 */
	redactBlocked?: true;
	/** 0.28 (#76): with `redactBlocked`, the reason is not an unreadable store but a page turned or cropped after its boxes were drawn (the message says so). */
	redactStale?: true;
	/** Review fix (P10): how many boxes the notebook keeps switched off; non-dialog exports say once that they are off. */
	redactOff?: number;
	/**
	 * Review fix (U1): the document id of the notebook, so the boxes the export dialog hands over tell the excerpts of this notebook (left
	 * out while it has a box) from those of another (`withExcerptChains`). Absent: every excerpt is left out while there is a box.
	 */
	redactDoc?: string;
	/**
	 * 0.29 (#248) review fix (F1, F3): the figure numbers of THIS notebook, frozen when the options were made. Every writer resolves the
	 * captions and references of its pages against it (and redaction measures them in the same scope), never against another open view.
	 */
	figures?: FigureLabelSource;
}

/**
 * The bytes of a PDF of `pages` (images collected first, equations prepared). With `pause` the build lets the interface breathe between
 * two pages (0.17 #23: the automatic PDF copy); without it the build is synchronous, as it always was.
 */
export async function buildPdfBytes(
	title: string, pages: readonly Page[], media: NotebookMedia | null, options: ExportOptions = {}, pause?: () => Promise<void>,
): Promise<{ bytes: Uint8Array; skipped: number }> {
	const { images, skipped } = await collectPageImages(media, pages, options.layers);
	await options.prepare?.(pages);
	const pdfOptions: PdfOptions = {
		paper: true, title, images: (p) => images.get(p) ?? [],
		...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}), ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
		...(options.layers ? { layers: options.layers } : {}),
		...(options.header ? { header: options.header } : {}),
		...(options.comments ? { comments: options.comments } : {}),
		...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
		...(options.figures ? { figures: options.figures } : {}),
		...(options.split ? { split: (p: Page) => planSplit(p, options.split!) } : {}),
	};
	return { bytes: pause ? await pagesToPdfYielding(pages, pdfOptions, pause) : pagesToPdf(pages, pdfOptions), skipped };
}

/** Writes a PDF of `pages` next to the notebook; `suffix` distinguishes single-page exports. */
export async function exportPdf(
	app: App, notebook: TFile, allPages: readonly Page[], suffix = "", media: NotebookMedia | null = null, base: ExportOptions = {},
): Promise<void> {
	const working = showNotice(t("export.working"), 0);
	try {
		const { pages, options } = withRedaction(allPages, base); // 0.26 (#285)
		const { bytes, skipped } = await buildPdfBytes(notebook.basename, pages, media, options);
		const path = freePath(app, notebook, suffix, "pdf");
		recordPluginWrite(app, [path]); // before the write: the inbox must not offer the file the plugin is creating
		await app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		showNotice(t("export.done", { path }));
		announceRedaction(allPages, base);
		reportSkipped(skipped);
	} catch (e) {
		showNotice(t("export.failed", { error: (e as Error).message }));
	} finally {
		working.hide();
	}
}

/** SVG of one page: the text, the images it needs and the path it is written to. */
async function buildSvg(app: App, notebook: TFile, source: Page, suffix: string, media: NotebookMedia | null, base: ExportOptions): Promise<{ path: string; skipped: number }> {
	const redacted = withRedaction([source], base); // 0.26 (#285)
	const page = redacted.pages[0]!;
	const options = redacted.options;
	const { images, skipped } = await collectPageImages(media, [page], options.layers);
	await options.prepare?.([page]);
	const svgImages = (p: Page): SvgPlacedImage[] => (images.get(p) ?? []).map((img) => ({
		href: jpegDataUrl(img.jpeg), x: img.x, y: img.y, width: img.width, height: img.height,
		...(img.rotation !== undefined ? { rotation: img.rotation } : {}),
		...(img.opacity !== undefined ? { opacity: img.opacity } : {}),
		...(img.layer !== undefined ? { layer: img.layer } : {}),
	}));
	const path = freePath(app, notebook, suffix, "svg");
	await app.vault.create(path, pageToSvg(page, {
		paper: true, images: svgImages, hiddenInk: options.hiddenInk?.(page) ?? false, ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
		...(options.header ? { header: options.header(page) } : {}),
		...(options.layers ? { layers: options.layers } : {}),
		...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
		...(options.figures ? { figures: options.figures } : {}),
	}));
	return { path, skipped };
}

export async function exportSvg(app: App, notebook: TFile, page: Page, suffix: string, media: NotebookMedia | null = null, options: ExportOptions = {}): Promise<void> {
	const working = showNotice(t("export.working"), 0);
	try {
		const { path, skipped } = await buildSvg(app, notebook, page, suffix, media, options);
		showNotice(t("export.done", { path }));
		announceRedaction([page], options);
		reportSkipped(skipped);
	} catch (e) {
		showNotice(t("export.failed", { error: (e as Error).message }));
	} finally {
		working.hide();
	}
}

/** 0.21 (#164): the viewer's own text, in the language of the interface. */
function htmlLabels(): HtmlViewerLabels {
	return {
		page: t("export.html.page"), of: t("export.html.of"), fit: t("export.html.fit"), zoomIn: t("export.html.zoomIn"),
		zoomOut: t("export.html.zoomOut"), prev: t("export.html.prev"), next: t("export.html.next"), pages: t("export.html.pages"),
	};
}

/** Lets the interface breathe between two pages of a long export. */
const breathe = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

/**
 * 0.21 (#164): writes ONE self-contained .html file next to the notebook with the pages (the SVG of each page, so the drawing is the
 * one of the SVG export, a viewer in a few lines of script, no network). Pictures are embedded up to a size cap; the rest are left out
 * with a notice. The file is built one page at a time (the interface breathes between pages) and never replaces an existing file.
 */
export async function exportHtml(app: App, notebook: TFile, allPages: readonly Page[], indices: readonly number[], suffix: string, media: NotebookMedia | null, base: ExportOptions = {}): Promise<void> {
	const working = showNotice(t("export.working"), 0);
	try {
		const { pages, options } = withRedaction(allPages, base); // 0.26 (#285): the SVG of each page, its links and its pictures are those of the redacted page
		const budget = new ImageBudget();
		const labels = htmlLabels();
		const parts: string[] = [htmlHead({ title: notebook.basename, labels, lang: activeDocument.documentElement.lang || "en" })];
		let skipped = 0;
		for (let i = 0; i < pages.length; i++) {
			const page = pages[i]!;
			// One page at a time: its pictures are collected, drawn into its SVG and let go (the same asset shares one array).
			const collected = await collectPageImages(media, [page], options.layers);
			skipped += collected.skipped;
			await options.prepare?.([page]);
			const svgImages = (p: Page): SvgPlacedImage[] => (collected.images.get(p) ?? []).flatMap((img) => {
				const href = jpegDataUrl(img.jpeg);
				if (!budget.take(href)) return [];
				return [{
					href, x: img.x, y: img.y, width: img.width, height: img.height,
					...(img.rotation !== undefined ? { rotation: img.rotation } : {}),
					...(img.opacity !== undefined ? { opacity: img.opacity } : {}),
					...(img.layer !== undefined ? { layer: img.layer } : {}),
				}];
			});
			const svg = pageToSvg(page, {
				paper: true, images: svgImages, hiddenInk: options.hiddenInk?.(page) ?? false, ...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
				...(options.header ? { header: options.header(page) } : {}),
				...(options.layers ? { layers: options.layers } : {}),
				...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
				...(options.figures ? { figures: options.figures } : {}),
			});
			const label = `${labels.page} ${i + 1}`;
			parts.push(htmlPage(i, pages.length, svg, label, pageHtmlLinks(page, notebook.basename, (n) => { const at = indices.indexOf(n - 1); return at < 0 ? null : at; })));
			working.setMessage(t("export.progress", { done: String(i + 1), total: String(pages.length) }));
			await breathe();
		}
		parts.push(htmlTail(labels));
		const path = freePath(app, notebook, suffix, "html");
		recordPluginWrite(app, [path]); // before the write: the inbox must not offer the file the plugin is creating
		await app.vault.create(path, parts.join(""));
		showNotice(t("export.done", { path }));
		announceRedaction(allPages, base);
		reportSkipped(skipped);
		if (budget.omitted > 0) showNotice(t("export.html.imagesOmitted", { n: String(budget.omitted) }), 8000);
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
	/** wave 0.10: the pages of a "range" scope (0-based). */
	range?: readonly number[];
	/** wave 0.10 (81), PNG images: the vault folder (created when missing) and the pixels per pt. */
	folder?: string;
	scale?: number;
	/** 0.18 (#178), PDF and PNG: split the infinite pages into sheets of paper. */
	split?: SplitSettings;
	/** 0.19 (#239), every format: a clean copy, without the study and working layers (absent: the export as it always was). */
	clean?: CleanExportOptions;
	/**
	 * 0.26 (#285), every format: the redaction boxes of this export (the dialog's choice: absent means none, whatever the notebook remembers).
	 * What lies under them is left out of the files, not painted over.
	 */
	redact?: Redactions;
}

/**
 * Writes the files an export dialog asked for next to the notebook: one PDF, or one SVG per page for a whole notebook or a
 * range; PNG images go to a vault folder; Print writes nothing and opens the system print dialog (wave 0.10, 81).
 * Existing files are never overwritten (the name gets " 2", " 3"…).
 */
export async function runExport(app: App, notebook: TFile, allPages: readonly Page[], request: ExportRequest, media: NotebookMedia | null, options: ExportOptions = {}): Promise<void> {
	// 0.19 (#239): a clean copy draws filtered copies of the pages (same ids and order; the document is untouched) and no comment notes.
	const clean = request.clean;
	const pages = clean ? cleanPagesForExport(allPages, clean) : allPages;
	const jobs = planExport(request.format, request.scope, request.pageIndex, pages.length, request.layers, request.range);
	const splits = (request.format === "pdf" || request.format === "png") && request.split;
	const base: ExportOptions = { ...options };
	if (clean && resolveCleanOptions(clean).comments) delete base.comments;
	// 0.26 (#285): the dialog decides what is covered; each writer applies it to the pages it is given (`withRedaction`).
	// Its choice is the one the reader saw: no hint about switched-off boxes; boxes it holds are readable (in memory at least).
	delete base.redactOff;
	if (request.redact && countBoxes(request.redact) > 0) {
		// Review fix (R5): excerpt chains over every page of the notebook, also when only a range is exported.
		base.redact = withExcerptChains(allPages, request.redact, options.redactDoc) ?? request.redact;
		delete base.redactBlocked;
		delete base.redactStale;
	} else delete base.redact;
	const opts: ExportOptions = { ...base, layers: request.layers, ...(splits ? { split: request.split! } : {}) };
	if (jobs.length === 0) return;
	if (request.format === "png") {
		await exportPngPages(app, pages, { folder: request.folder ?? "", scale: request.scale ?? DEFAULT_PNG_SCALE, pages: jobs[0]!.pages }, media, opts);
		return;
	}
	if (request.format === "print") {
		await printPages(pages, jobs[0]!.pages, media, opts);
		return;
	}
	if (request.format === "html") {
		const job = jobs[0]!;
		await exportHtml(app, notebook, job.pages.map((i) => pages[i]!), job.pages, job.suffix, media, opts);
		return;
	}
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
		announceRedaction(jobs.map((j) => pages[j.pages[0]!]!), opts);
		reportSkipped(skipped);
	} catch (e) {
		showNotice(t("export.failedMany", { done: String(written), error: (e as Error).message }), 8000);
	} finally {
		working.hide();
	}
}
