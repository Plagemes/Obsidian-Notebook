// Draws pages to PNG images, one page at a time: shared by the Markdown export (382), the PNG export and printing (81).
// The pixels come from ink/page-raster.ts (same look as the PDF export, never the night colours); this file only loads
// the PDF page / pictures a page needs and encodes the canvas. Memory stays at one page: the canvas is shrunk to nothing
// after each page and the picture bitmaps are closed by `close()`.
import { layerFlags, type ExportLayers } from "../ink/export-layers";
import type { BoxLabel } from "../ink/marker-render";
import { drawPageRaster } from "../ink/page-raster";
import { renderSize } from "../model/export-markdown";
import type { Page } from "../model/types";
import type { NotebookMedia } from "./media";

export interface PageImageOptions {
	hiddenInk?: (page: Page) => boolean;
	boxLabel?: BoxLabel;
	/** v9: numbers of the numbered equations over the whole notebook. */
	equationNumbers?: ReadonlyMap<string, number>;
	/** wave 0.9 (381): ink only, background only or both (default). What is left out is not loaded either. */
	layers?: ExportLayers;
}

export interface PageImage {
	blob: Blob;
	/** The page has a PDF/picture background or pictures that could not be drawn (the image is made without them). */
	skipped: number;
	width: number;
	height: number;
}

export class PageImageRenderer {
	private readonly bitmaps = new Map<string, ImageBitmap | null>();

	constructor(private readonly media: NotebookMedia | null, private readonly options: PageImageOptions = {}) {}

	/** The PDF page or picture under `page` as a bitmap at `scale` px per pt, or null (and the reason is logged). */
	private async background(page: Page, scale: number): Promise<CanvasImageSource | null> {
		const bg = page.background;
		const media = this.media;
		if (!bg || !media) return null;
		try {
			if (bg.kind === "pdf") return await media.pdf.render(bg.asset, bg.page, scale);
			return await createImageBitmap(new Blob([await media.readAsset(bg.asset)]));
		} catch (e) {
			console.error("[notebook] page image background", e);
			return null;
		}
	}

	/** Bitmaps of the picture elements of `page`; the number of those that could not be loaded is added to `failed`. */
	private async elementImages(page: Page, failed: { n: number }): Promise<Map<string, CanvasImageSource>> {
		const out = new Map<string, CanvasImageSource>();
		const media = this.media;
		for (const el of page.elements ?? []) {
			if (el.type !== "image" || out.has(el.asset)) continue;
			let bmp = this.bitmaps.get(el.asset);
			if (bmp === undefined) {
				try {
					if (!media) throw new Error("no media");
					bmp = await createImageBitmap(new Blob([await media.readAsset(el.asset)]));
				} catch (e) {
					console.error("[notebook] page image picture", e);
					bmp = null;
				}
				this.bitmaps.set(el.asset, bmp);
			}
			if (bmp) out.set(el.asset, bmp);
			else failed.n++;
		}
		return out;
	}

	/** Draws `page` at `dpi` (reduced for huge pages, see `renderSize`) and encodes it as PNG. */
	async render(page: Page, dpi: number): Promise<PageImage> {
		const size = renderSize(page, dpi);
		const flags = layerFlags(this.options.layers);
		const canvas = activeDocument.createEl("canvas");
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

	/** Closes the picture bitmaps kept between pages. */
	close(): void {
		for (const bmp of this.bitmaps.values()) bmp?.close();
		this.bitmaps.clear();
	}
}
