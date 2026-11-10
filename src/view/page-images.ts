// Draws pages to PNG images, one page at a time: shared by the Markdown export (382), the PNG export and printing (81).
// The pixels come from ink/page-raster.ts (same look as the PDF export, never the night colours); this file only loads
// the PDF page / pictures a page needs and encodes the canvas. Memory stays near one page: the canvas is shrunk to nothing
// after each page, and the decoded picture bitmaps kept between pages are bounded (a few, and a size budget; the ones the
// page being drawn uses are never freed); `close()` frees the rest.
import { layerFlags, type ExportLayers } from "../ink/export-layers";
import type { BoxLabel } from "../ink/marker-render";
import { BitmapCache, MAX_CACHED_BITMAP_BYTES, MAX_CACHED_BITMAPS } from "../ink/bitmap-cache";
import type { HeaderLayout } from "../ink/page-header";
import { drawPageRaster } from "../ink/page-raster";
import { burnPixelRects, burnPlan, type BurnPlan } from "../ink/redact";
import { elementAssetId } from "../model/excerpts";
import { renderSize } from "../model/export-markdown";
import { viewOf } from "../model/pdf-view";
import type { Page } from "../model/types";
import { burnedCanvas, sourceSize } from "./burn";
import type { NotebookMedia } from "./media";

export interface PageImageOptions {
	hiddenInk?: (page: Page) => boolean;
	boxLabel?: BoxLabel;
	/** v9: numbers of the numbered equations over the whole notebook. */
	equationNumbers?: ReadonlyMap<string, number>;
	/** wave 0.9 (381): ink only, background only or both (default). What is left out is not loaded either. */
	layers?: ExportLayers;
	/** 0.15 (#75): the automatic page header or footer of a page (null: none). */
	header?: (page: Page) => HeaderLayout | null;
}

export interface PageImage {
	blob: Blob;
	/** The page has a PDF/picture background or pictures that could not be drawn (the image is made without them). */
	skipped: number;
	width: number;
	height: number;
}

/** `picture` with the boxes of `plan` painted black, as a bitmap of its own (the caller closes it). */
async function burned(picture: CanvasImageSource, plan: BurnPlan): Promise<ImageBitmap> {
	const { width, height } = sourceSize(picture);
	const copy = burnedCanvas(picture, width, height, burnPixelRects(plan.boxes, plan.rect, width, height));
	try {
		return await createImageBitmap(copy);
	} finally {
		copy.width = 0;
		copy.height = 0;
	}
}

export class PageImageRenderer {
	/** Decoded pictures by asset (null: it could not be loaded, so it is not tried again); least recently used go first. */
	private readonly bitmaps = new BitmapCache<ImageBitmap | null>((bmp) => bmp?.close());

	constructor(private readonly media: NotebookMedia | null, private readonly options: PageImageOptions = {}) {}

	/** The PDF page or picture under `page` as a bitmap at `scale` px per pt, or null (and the reason is logged). */
	private async background(page: Page, scale: number): Promise<CanvasImageSource | null> {
		const bg = page.background;
		const media = this.media;
		if (!bg || !media) return null;
		// 0.26 (#285): a page with redaction boxes gets its background with the boxes burned in (a copy: the cached picture is not changed).
		// A background that cannot be burned is left out, never drawn as it is.
		const burn = burnPlan(page);
		try {
			if (bg.kind === "pdf") {
				const picture = await media.pdf.render(bg.asset, bg.page, scale, viewOf(bg));
				return burn ? await burned(picture, burn) : picture;
			}
			const bitmap = await createImageBitmap(new Blob([await media.readAsset(bg.asset)]));
			if (!burn) return bitmap;
			try {
				return await burned(bitmap, burn);
			} finally {
				bitmap.close();
			}
		} catch (e) {
			console.error("[notebook] page image background", e);
			return null;
		}
	}

	/** Bitmaps of the picture elements of `page`; the number of those that could not be loaded is added to `failed`. */
	private async elementImages(page: Page, failed: { n: number }): Promise<Map<string, CanvasImageSource>> {
		const out = new Map<string, CanvasImageSource>();
		const media = this.media;
		const needed = new Set<string>();
		for (const el of page.elements ?? []) {
			const id = elementAssetId(el);
			if (id !== null) needed.add(id);
		}
		// Pictures of earlier pages are freed before this page's are decoded, so a photo-heavy notebook never holds them all.
		this.bitmaps.trim(MAX_CACHED_BITMAPS, MAX_CACHED_BITMAP_BYTES, needed);
		for (const el of page.elements ?? []) {
			// Pictures and (v10) excerpt snapshots: an excerpt is drawn from its snapshot in every page image.
			const id = elementAssetId(el);
			if (id === null || out.has(id)) continue;
			let bmp = this.bitmaps.get(id);
			if (bmp === undefined) {
				try {
					if (!media) throw new Error("no media");
					bmp = await createImageBitmap(new Blob([await media.readAsset(id)]));
				} catch (e) {
					console.error("[notebook] page image picture", e);
					bmp = null;
				}
				this.bitmaps.set(id, bmp, bmp ? bmp.width * bmp.height * 4 : 0);
			}
			if (bmp) out.set(id, bmp);
			else failed.n++;
		}
		return out;
	}

	/** Draws `page` at `dpi` (reduced for huge pages, see `renderSize`) and encodes it as PNG. */
	async render(page: Page, dpi: number): Promise<PageImage> {
		const size = renderSize(page, dpi);
		const flags = layerFlags(this.options.layers);
		const canvas = createEl("canvas");
		canvas.width = size.width;
		canvas.height = size.height;
		try {
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Canvas 2D is not available");
			let skipped = 0;
			const background = flags.background ? await this.background(page, size.scale) : null;
			if (flags.background && page.background && !background) skipped++;
			const failed = { n: 0 };
			const images = flags.content ? await this.elementImages(page, failed) : new Map<string, CanvasImageSource>();
			skipped += failed.n;
			drawPageRaster(ctx, page, size.scale, {
				background, images, hiddenInk: this.options.hiddenInk?.(page) ?? false,
				...(this.options.boxLabel ? { boxLabel: this.options.boxLabel } : {}),
				...(this.options.layers ? { layers: this.options.layers } : {}),
				...(this.options.header ? { header: this.options.header(page) } : {}),
				...(this.options.equationNumbers ? { equationNumbers: this.options.equationNumbers } : {}),
			});
			if (background && "close" in background) (background as ImageBitmap).close();
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
			if (!blob) throw new Error("could not encode PNG");
			return { blob, skipped, width: size.width, height: size.height };
		} finally {
			// Frees the bitmap at once (a phone holds few of them).
			canvas.width = 0;
			canvas.height = 0;
		}
	}

	/**
	 * 0.16 (#90): draws parts of `page` (rectangles in pt) at `dpi`, each to its own PNG; the PDF page and the pictures are loaded
	 * once for all of them. `skipped` counts what could not be drawn, as in `render`.
	 */
	async renderRegions(page: Page, dpi: number, regions: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): Promise<{ blobs: Array<Blob | null>; skipped: number }> {
		const { scale } = renderSize(page, dpi);
		const flags = layerFlags(this.options.layers);
		let skipped = 0;
		const background = flags.background ? await this.background(page, scale) : null;
		if (flags.background && page.background && !background) skipped++;
		const failed = { n: 0 };
		const images = flags.content ? await this.elementImages(page, failed) : new Map<string, CanvasImageSource>();
		skipped += failed.n;
		const blobs: Array<Blob | null> = [];
		try {
			for (const region of regions) {
				const canvas = createEl("canvas");
				canvas.width = Math.max(1, Math.round(region.width * scale));
				canvas.height = Math.max(1, Math.round(region.height * scale));
				try {
					const ctx = canvas.getContext("2d");
					if (!ctx) throw new Error("Canvas 2D is not available");
					drawPageRaster(ctx, page, scale, {
						background, images, region, clipElements: page.elements ?? [], hiddenInk: this.options.hiddenInk?.(page) ?? false,
						...(this.options.boxLabel ? { boxLabel: this.options.boxLabel } : {}),
						...(this.options.layers ? { layers: this.options.layers } : {}),
						...(this.options.header ? { header: this.options.header(page) } : {}),
						...(this.options.equationNumbers ? { equationNumbers: this.options.equationNumbers } : {}),
					});
					blobs.push(await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")));
				} catch (e) {
					console.error("[notebook] page image region", e);
					blobs.push(null);
				} finally {
					canvas.width = 0;
					canvas.height = 0;
				}
			}
		} finally {
			if (background && "close" in background) (background as ImageBitmap).close();
		}
		return { blobs, skipped };
	}

	/** Closes the picture bitmaps kept between pages. */
	close(): void {
		this.bitmaps.clear();
	}
}
