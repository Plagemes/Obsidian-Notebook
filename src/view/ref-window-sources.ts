/**
 * 0.20 reference window (#107): what the floating window can show, behind one small interface. A page of a notebook (this one,
 * as it is now, or another one, read from the vault), a page of a PDF, a picture of the vault, or a Markdown note. Every
 * source is read only: nothing here writes a file or touches a document. Raster sources are drawn at the width the window asks
 * for; the window asks again only after a resize or a zoom has ended.
 */
import { Component, loadPdfJs, MarkdownRenderer, Platform, type App, type TFile } from "obsidian";
import { drawElement, drawTextElement } from "../ink/renderer";
import { renderThumbnail, thumbnailSize } from "../library/thumbnail";
import { backgroundRect } from "../model/margins";
import { viewOf } from "../model/pdf-view";
import { parse } from "../model/serialize";
import type { NotebookDocument, Page } from "../model/types";
import { assetIdFromHash, sha256Hex } from "../pdf/hash";
import type { PdfLib } from "../pdf/pdfjs-types";
import { PdfStore, type PageSize } from "../pdf/pdf-store";
import { NOTEBOOK_EXTENSIONS, readNotebookText } from "../storage/format";
import { NotebookMedia } from "./media";
import { referenceKind, requestedIndex, type ReferenceKind, type ReferenceRequest } from "./ref-window-logic";

/** A drawn page: the element to show and its height divided by its width. */
export interface DrawnPage {
	el: HTMLElement;
	aspect: number;
}

export interface RefSource {
	readonly kind: ReferenceKind;
	readonly file: TFile;
	/** "pages": a fixed-shape picture the window pans and zooms. "flow": a document that scrolls. */
	readonly layout: "pages" | "flow";
	/** Makes the page count known when it is not: a notebook whose lending pane went away is read from the file first. Optional. */
	prepare?(): Promise<void>;
	pageCount(): number;
	/** The 0-based page a request names. */
	indexFor(request: Pick<ReferenceRequest, "page" | "pageId">): number;
	/** Draws page `index` into `parent`, `pixelWidth` device pixels wide when it is a raster. */
	render(index: number, pixelWidth: number, parent: HTMLElement): Promise<DrawnPage>;
	/** Reads the file again (it was saved); true when the pages may have changed. */
	reload(): Promise<boolean>;
	destroy(): void;
}

/** What the view that hosts the window lends: its own document, as it is now, and the media it already holds. */
export interface LiveNotebook {
	doc(): NotebookDocument | null;
	media(): NotebookMedia | null;
	/** The document belongs to another pane: a save of the file is a change to show, drawn from the live document without reading the file. */
	redrawOnSave?: boolean;
}

export interface SourceDeps {
	app: App;
	/** The notebooks folder (assets of other notebooks are found through it). */
	folder(): string;
	/** The open document of this view when `file` is its notebook, else null. */
	live(file: TFile): LiveNotebook | null;
	/** A media source finished loading something: the window draws the page again. */
	changed(): void;
}

/** Opens a reference; throws when the file cannot be shown (the window says so). */
export async function openSource(deps: SourceDeps, file: TFile): Promise<RefSource> {
	const kind = referenceKind(file.extension, NOTEBOOK_EXTENSIONS);
	switch (kind) {
		case "notebook": return openNotebook(deps, file);
		case "pdf": return openPdf(deps.app, file);
		case "image": return openImage(deps.app, file);
		case "markdown": return openMarkdown(deps.app, file);
		default: throw new Error(`Cannot show .${file.extension} files`);
	}
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
	const c = createEl("canvas");
	c.width = width;
	c.height = height;
	return c;
}

/** Render scales are rounded to steps of √2 so a zoom does not draw again on every step. */
function quantize(s: number): number {
	return Math.pow(2, Math.round(Math.log2(Math.max(0.1, s)) * 2) / 2);
}

// ------------------------------------------------------------------------------------------------------------ notebook

async function openNotebook(deps: SourceDeps, file: TFile): Promise<RefSource> {
	const { app } = deps;
	const live = deps.live(file);
	const read = async (): Promise<NotebookDocument> => {
		const parsed = parse(readNotebookText(file.extension, await app.vault.read(file)));
		if (!parsed.ok) throw new Error(parsed.message);
		return parsed.doc;
	};
	let stored: NotebookDocument | null = live?.doc() ? null : await read();
	const current = (): NotebookDocument => {
		const doc = live?.doc() ?? stored;
		if (!doc) throw new Error("The notebook is not available");
		return doc;
	};
	/** The pane that lent its document may close: then the file is read once, like for a notebook nobody has open. */
	const ensureDocument = async (): Promise<void> => {
		if (!live?.doc() && !stored) stored = await read();
	};
	const pagesNow = (): NotebookDocument["pages"] => (live?.doc() ?? stored)?.pages ?? [];
	const ownMedia = live?.media() ?? null;
	const media = ownMedia ?? new NotebookMedia(app, () => live?.doc() ?? stored, () => deps.folder(), () => deps.changed());

	/** Background (PDF page or picture) and pictures and texts of a page, drawn from what is already loaded. */
	const drawMedia = (ctx: CanvasRenderingContext2D, page: Page): void => {
		const bg = page.background;
		if (bg) {
			const img = bg.kind === "image" ? media.image(bg.asset) : ((media.pdf.peek(bg.asset, bg.page, undefined, viewOf(bg))?.canvas as CanvasImageSource | undefined) ?? null);
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
		layout: "pages",
		prepare: async () => {
			try {
				await ensureDocument();
			} catch {
				// Unreadable now: render() reports it, and the window keeps the page it was on.
			}
		},
		pageCount: () => pagesNow().length,
		indexFor: (request) => requestedIndex(pagesNow().length, pagesNow().map((p) => p.id), request),
		async render(index, pixelWidth, parent) {
			await ensureDocument();
			const page = current().pages[index];
			if (!page) throw new RangeError(`page ${index + 1} out of range`);
			const bg = page.background;
			// The PDF page is loaded first so the synchronous drawing finds it.
			if (bg?.kind === "pdf") await media.pdf.render(bg.asset, bg.page, quantize(pixelWidth / page.width), viewOf(bg)).catch(() => undefined);
			const url = renderThumbnail(page, pixelWidth, { mime: "image/jpeg", quality: 0.9, drawBackground: (ctx, p) => drawMedia(ctx, p) });
			const size = thumbnailSize(page, pixelWidth);
			const img = parent.createEl("img", { cls: "nb-refwin-img", attr: { src: url, alt: "", draggable: "false", decoding: "async" } });
			return { el: img, aspect: size.height / size.width };
		},
		async reload() {
			// The open document is read as it is, at every drawing, so there is nothing to read. The view's own notebook is not
			// redrawn by a save; another pane's notebook is (its saves are the changes this window should show).
			if (live?.doc()) return live.redrawOnSave === true;
			try {
				stored = await read();
				return true;
			} catch {
				return false; // mid-write or damaged: keep showing what was read last
			}
		},
		destroy() {
			if (!ownMedia) media.destroy();
		},
	};
}

// ------------------------------------------------------------------------------------------------------------------ PDF

async function openPdf(app: App, file: TFile): Promise<RefSource> {
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
		layout: "pages",
		pageCount: () => sizes.length,
		indexFor: (request) => requestedIndex(sizes.length, null, request),
		async render(index, pixelWidth, parent) {
			const size = sizes[index];
			if (!size) throw new RangeError(`page ${index + 1} out of range`);
			const canvas = await store.render(id, index + 1, quantize(pixelWidth / size.width));
			// The store keeps its canvas: it is moved into the window and shown at the window's width.
			const el = canvas as HTMLElement;
			el.classList.add("nb-refwin-img");
			parent.appendChild(el);
			return { el, aspect: size.height / size.width };
		},
		reload: () => Promise.resolve(false),
		destroy: () => store.clear(),
	};
}

// ----------------------------------------------------------------------------------------------------------------- image

function openImage(app: App, file: TFile): Promise<RefSource> {
	return Promise.resolve({
		kind: "image",
		file,
		layout: "pages",
		pageCount: () => 1,
		indexFor: () => 0,
		async render(_index, _pixelWidth, parent) {
			const img = parent.createEl("img", { cls: "nb-refwin-img", attr: { src: app.vault.getResourcePath(file), alt: file.basename, draggable: "false", decoding: "async" } });
			try {
				await img.decode();
			} catch {
				throw new Error("The picture could not be decoded");
			}
			const aspect = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalHeight / img.naturalWidth : 1;
			return { el: img, aspect };
		},
		reload: () => Promise.resolve(true),
		destroy: () => undefined,
	});
}

// -------------------------------------------------------------------------------------------------------------- Markdown

function openMarkdown(app: App, file: TFile): Promise<RefSource> {
	const component = new Component();
	component.load();
	return Promise.resolve({
		kind: "markdown",
		file,
		layout: "flow",
		pageCount: () => 1,
		indexFor: () => 0,
		async render(_index, _pixelWidth, parent) {
			const text = await app.vault.cachedRead(file);
			const holder = parent.createDiv({ cls: "nb-refwin-md markdown-preview-view markdown-rendered" });
			await MarkdownRenderer.render(app, text, holder, file.path, component);
			return { el: holder, aspect: 0 };
		},
		reload: () => Promise.resolve(true),
		destroy: () => component.unload(),
	});
}
