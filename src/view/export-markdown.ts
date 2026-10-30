// wave 0.9 (382): "Export as Markdown with page images". Draws every page to a PNG at the chosen resolution and writes
// the PNGs and notebook.md into a vault folder through the vault API. Nothing is ever overwritten: a name that exists gets
// " 2", " 3"… The notebook.md is written last, so it only exists when every image does. The format of the notebook is not
// touched.
import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { t } from "../i18n";
import { drawPageRaster } from "../ink/page-raster";
import type { BoxLabel } from "../ink/marker-render";
import { buildNotebookMarkdown, planMarkdownFiles, renderSize, type MarkdownDpi } from "../model/export-markdown";
import type { NotebookDocument, Page } from "../model/types";
import { ensureFolder } from "../storage/vault-io";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";

export interface MarkdownExportOptions {
	/** Vault folder the files go in (created when missing). */
	folder: string;
	dpi: MarkdownDpi;
	hiddenInk?: (page: Page) => boolean;
	boxLabel?: BoxLabel;
}

/** The folder suggested for the export of `notebook`: next to it, named after it. */
export function defaultMarkdownFolder(notebook: TFile): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	return normalizePath(`${dir}${notebook.basename} (Markdown)`);
}

/** Why a folder path cannot be used, or null. */
export function folderProblem(app: App, folder: string): string | null {
	const path = normalizePath(folder.trim());
	if (path === "" || path === "/") return null;
	if (path.split("/").some((part) => part === "." || part === "..")) return t("export.markdown.badFolder");
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) return t("export.markdown.folderIsFile");
	return null;
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("could not encode PNG");
	return blob.arrayBuffer();
}

/** The PDF page or picture under `page` as a bitmap at `scale` px per pt, or null (and the reason is logged). */
async function backgroundBitmap(media: NotebookMedia | null, page: Page, scale: number): Promise<CanvasImageSource | null> {
	const bg = page.background;
	if (!bg || !media) return null;
	try {
		if (bg.kind === "pdf") return await media.pdf.render(bg.asset, bg.page, scale);
		return await createImageBitmap(new Blob([await media.readAsset(bg.asset)]));
	} catch (e) {
		console.error("[notebook] markdown export background", e);
		return null;
	}
}

async function elementBitmaps(media: NotebookMedia | null, page: Page, cache: Map<string, ImageBitmap | null>): Promise<Map<string, CanvasImageSource>> {
	const out = new Map<string, CanvasImageSource>();
	if (!media) return out;
	for (const el of page.elements ?? []) {
		if (el.type !== "image" || out.has(el.asset)) continue;
		let bmp = cache.get(el.asset);
		if (bmp === undefined) {
			try {
				bmp = await createImageBitmap(new Blob([await media.readAsset(el.asset)]));
			} catch (e) {
				console.error("[notebook] markdown export image", e);
				bmp = null;
			}
			cache.set(el.asset, bmp);
		}
		if (bmp) out.set(el.asset, bmp);
	}
	return out;
}

/**
 * Writes the export and reports the result with a notice. Returns the path of notebook.md, or null when it failed.
 * Pages are rendered one after the other, so memory stays at one page.
 */
export async function exportMarkdown(app: App, notebook: TFile, doc: NotebookDocument, media: NotebookMedia | null, options: MarkdownExportOptions): Promise<string | null> {
	const working = showNotice(t("export.working"), 0);
	let written = 0;
	const bitmaps = new Map<string, ImageBitmap | null>();
	try {
		const folder = normalizePath(options.folder.trim() || ".");
		const dir = folder === "." || folder === "/" ? "" : folder;
		if (dir) await ensureFolder(app, dir);
		const target = dir ? app.vault.getAbstractFileByPath(dir) : app.vault.getRoot();
		const present = new Set<string>();
		if (target instanceof TFolder) for (const child of target.children) present.add(child.name.toLowerCase());
		const names = planMarkdownFiles(dir, doc.pages.length, (path) => present.has(path.slice(dir ? dir.length + 1 : 0).toLowerCase()) || !!app.vault.getAbstractFileByPath(normalizePath(path)));
		const prefix = dir ? `${dir}/` : "";
		let skipped = 0;
		for (let i = 0; i < doc.pages.length; i++) {
			const page = doc.pages[i]!;
			working.setMessage(t("export.progress", { done: String(i), total: String(doc.pages.length) }));
			const size = renderSize(page, options.dpi);
			const canvas = activeDocument.createEl("canvas");
			canvas.width = size.width;
			canvas.height = size.height;
			try {
				const ctx = canvas.getContext("2d");
				if (!ctx) throw new Error("Canvas 2D is not available");
				const background = await backgroundBitmap(media, page, size.scale);
				if (page.background && !background) skipped++;
				const images = await elementBitmaps(media, page, bitmaps);
				drawPageRaster(ctx, page, size.scale, {
					background, images, hiddenInk: options.hiddenInk?.(page) ?? false,
					...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
				});
				if (background && "close" in background) (background as ImageBitmap).close();
				await app.vault.createBinary(normalizePath(`${prefix}${names.images[i]!}`), await canvasPng(canvas));
				written++;
			} finally {
				// Frees the bitmap at once (a phone holds few of them).
				canvas.width = 0;
				canvas.height = 0;
			}
		}
		const text = buildNotebookMarkdown({
			title: notebook.basename, pages: doc.pages, meta: doc.meta, images: names.images,
			pageLabel: (n) => t("export.markdown.pageHeading", { n: String(n) }),
		});
		const path = normalizePath(`${prefix}${names.markdown}`);
		await app.vault.create(path, text);
		showNotice(t("export.markdown.done", { n: String(written), path }), 8000);
		if (skipped > 0) showNotice(t("export.skipped", { n: String(skipped) }), 8000);
		return path;
	} catch (e) {
		showNotice(t("export.markdown.failed", { done: String(written), error: (e as Error).message }), 10000);
		return null;
	} finally {
		for (const bmp of bitmaps.values()) bmp?.close();
		working.hide();
	}
}
