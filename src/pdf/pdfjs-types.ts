/**
 * The minimal slice of the pdf.js API the plugin uses (what Obsidian's `loadPdfJs()` returns).
 * Declared structurally so src/pdf has no dependency on pdf.js or on 'obsidian' and can be tested
 * with fakes. At scale 1 a viewport is in PDF points, which is our page unit (pt).
 */
export interface PdfViewport {
	width: number;
	height: number;
	/** PDF user space → viewport (y down), `[a, b, c, d, e, f]`. Present in real pdf.js. */
	transform?: number[];
}

/** What `getTextContent()` resolves to; items are read defensively (see pdf/text-items.ts). */
export interface PdfTextContent {
	items: unknown[];
	/** Font name to style (`fontFamily`), used to measure the characters of a run. */
	styles?: unknown;
}

export interface PdfRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

export interface PdfPage {
	/**
	 * `rotation` (degrees, the WHOLE rotation: pdf.js defaults it to the page's own) and `offsetX` / `offsetY` (device px added to the viewport transform) are
	 * used for a rotated or cropped page background (0.28, #76); a fake that ignores them draws the page as it is.
	 */
	getViewport(params: { scale: number; rotation?: number; offsetX?: number; offsetY?: number }): PdfViewport;
	/** The page's own rotation in degrees (the /Rotate entry), already part of every default viewport. Present in real pdf.js. */
	rotate?: number;
	render(params: { canvasContext: unknown; viewport: PdfViewport }): PdfRenderTask;
	/** Frees page-level resources (optional, present in real pdf.js). */
	cleanup?(): unknown;
	/** Text runs with their positions (optional, present in real pdf.js). */
	getTextContent?(): Promise<PdfTextContent>;
	/** 0.16: the annotations of the page, links among them (optional, present in real pdf.js). */
	getAnnotations?(params?: { intent?: string }): Promise<unknown[]>;
}

export interface PdfDoc {
	numPages: number;
	/** 0.16: the outline (bookmarks) of the PDF as pdf.js gives it; null when it has none (optional, present in real pdf.js). */
	getOutline?(): Promise<unknown>;
	/** 0.16: an explicit destination array for a named destination (optional). */
	getDestination?(id: string): Promise<unknown>;
	/** 0.16: the 0-based index of the page a destination page reference points at (optional). */
	getPageIndex?(ref: unknown): Promise<number>;
	getPage(pageNumber: number): Promise<PdfPage>;
	destroy(): Promise<void>;
}

export interface PdfLib {
	getDocument(params: { data: Uint8Array | ArrayBuffer }): { promise: Promise<PdfDoc> };
}
