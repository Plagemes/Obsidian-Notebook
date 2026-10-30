import { loadPdfJs, Platform, type App, type TFile } from "obsidian";
import { renderThumbnail } from "../library/thumbnail";
import { drawElement, drawTextElement } from "../ink/renderer";
import { backgroundRect } from "../model/margins";
import { parse } from "../model/serialize";
import type { NotebookDocument, Page } from "../model/types";
import { assetIdFromHash, sha256Hex } from "../pdf/hash";
import type { PdfLib } from "../pdf/pdfjs-types";
import { PdfStore, type PageSize } from "../pdf/pdf-store";
import { sameSource, type PdfRef } from "../pdf/sync-links";
import { readNotebookText } from "../storage/format";
import { NotebookMedia } from "./media";

/**
 * What the PDF side pane shows (#106): a plain `.pdf` of the vault, or the pages of another notebook (whose pages
 * may have PDF backgrounds, with the ink drawn on them). Either way every page can be identified as "page N of
 * the PDF with this id" (`refAt`), which is what the links refer to.
 */
export interface ReferenceSource {
	readonly kind: "pdf" | "notebook";
	readonly file: TFile;
	readonly title: string;
	pageCount(): number;
	/** The PDF page shown at `index` (0-based), or null (a notebook page without a PDF background). */
	refAt(index: number): PdfRef | null;
	/** Index of the first page showing `ref`, or -1. */
	indexOf(ref: PdfRef): number;
	/** The page at `index` as an element that scales to the width of its container. */
	render(index: number, cssWidth: number, dpr: number): Promise<HTMLElement>;
	/** Reads the file again (a notebook that was saved); true if the pages may have changed. */
	reload(): Promise<boolean>;
	destroy(): void;
}

/** Render scales are rounded to steps of √2 so resizing the pane does not render again on every pixel. */
function quantizeScale(s: number): number {
	return Math.pow(2, Math.round(Math.log2(Math.max(0.1, s)) * 2) / 2);
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
	const c = createEl("canvas");
	c.width = width;
	c.height = height;
	return c;
}

/** A plain PDF in the vault, read-only. Its id is the content hash, like a notebook's PDF asset. */
export async function openPdfReference(app: App, file: TFile): Promise<ReferenceSource> {
	const id = assetIdFromHash(await sha256Hex(await app.vault.readBinary(file)));
	const store = new PdfStore({
		loadPdfJs: () => loadPdfJs() as Promise<PdfLib>,
		readAsset: () => app.vault.readBinary(file),
		createCanvas,
		memoryBudgetBytes: (Platform.isMobile ? 64 : 128) * 1024 * 1024,
		maxOpenDocs: 1,
	});
	let sizes: PageSize[];
	try {
		sizes = await store.pageSizes(id);
	} catch (e) {
		store.clear();
		throw e;
	}
	return {
		kind: "pdf",
		file,
		get title() {
			return file.basename;
		},
		pageCount: () => sizes.length,
		refAt: (index) => (index >= 0 && index < sizes.length ? { source: id, page: index + 1, path: file.path } : null),
		indexOf: (ref) => (ref.page >= 1 && ref.page <= sizes.length && sameSource(ref, { source: id, path: file.path }) ? ref.page - 1 : -1),
		async render(index, cssWidth, dpr) {
			const size = sizes[index];
			if (!size) throw new RangeError(`page ${index + 1} out of range`);
			const canvas = await store.render(id, index + 1, quantizeScale((cssWidth * dpr) / size.width));
			return canvas as HTMLElement;
		},
		reload: () => Promise.resolve(false),
		destroy: () => store.clear(),
	};
}

/** Another notebook: its pages as the reader would see them (PDF background, images, text, ink), read-only. */
export async function openNotebookReference(app: App, file: TFile, notebooksFolder: string, changed: () => void): Promise<ReferenceSource> {
	const read = async (): Promise<NotebookDocument> => {
		const parsed = parse(readNotebookText(file.extension, await app.vault.read(file)));
		if (!parsed.ok) throw new Error(parsed.message);
		return parsed.doc;
	};
	let doc = await read();
	const media = new NotebookMedia(app, () => doc, () => notebooksFolder, changed);

	const refAt = (index: number): PdfRef | null => {
		const bg = doc.pages[index]?.background;
		return bg?.kind === "pdf" ? { source: bg.asset, page: bg.page } : null;
	};

	/** Background (PDF page or image) and elements of a page, drawn synchronously from what is already loaded. */
	const drawMedia = (ctx: CanvasRenderingContext2D, page: Page): void => {
		const bg = page.background;
		if (bg) {
			const img = bg.kind === "image" ? media.image(bg.asset) : ((media.pdf.peek(bg.asset, bg.page)?.canvas as CanvasImageSource | undefined) ?? null);
			const r = backgroundRect(page);
			if (img) ctx.drawImage(img, r.x, r.y, r.width, r.height);
			else {
				ctx.fillStyle = "#f1f5f9";
				ctx.fillRect(r.x, r.y, r.width, r.height);
			}
		}
		const elements = page.elements ?? [];
		for (const el of elements) if (el.type === "image") drawElement(ctx, el, media.image(el.asset));
		for (const el of elements) if (el.type === "text") drawTextElement(ctx, el);
	};

	return {
		kind: "notebook",
		file,
		get title() {
			return file.basename;
		},
		pageCount: () => doc.pages.length,
		refAt,
		indexOf(ref) {
			for (let i = 0; i < doc.pages.length; i++) {
				const r = refAt(i);
				if (r && r.page === ref.page && sameSource(r, ref)) return i;
			}
			return -1;
		},
		async render(index, cssWidth, dpr) {
			const page = doc.pages[index];
			if (!page) throw new RangeError(`page ${index + 1} out of range`);
			const pixels = Math.round(cssWidth * dpr);
			const bg = page.background;
			// Load the PDF page first so the synchronous drawing below finds it.
			if (bg?.kind === "pdf") await media.pdf.render(bg.asset, bg.page, quantizeScale(pixels / page.width)).catch(() => undefined);
			const img = createEl("img");
			img.src = renderThumbnail(page, pixels, { mime: "image/jpeg", quality: 0.9, drawBackground: (ctx, p) => drawMedia(ctx, p) });
			return img;
		},
		async reload() {
			try {
				doc = await read();
				return true;
			} catch {
				return false; // mid-write or damaged: keep showing what was read last
			}
		},
		destroy: () => media.destroy(),
	};
}
