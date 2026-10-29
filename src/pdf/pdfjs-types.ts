/**
 * The minimal slice of the pdf.js API the plugin uses (what Obsidian's `loadPdfJs()` returns).
 * Declared structurally so src/pdf has no dependency on pdf.js or on 'obsidian' and can be tested
 * with fakes. At scale 1 a viewport is in PDF points, which is our page unit (pt).
 */
export interface PdfViewport {
	width: number;
	height: number;
}

export interface PdfRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

export interface PdfPage {
	getViewport(params: { scale: number }): PdfViewport;
	render(params: { canvasContext: unknown; viewport: PdfViewport }): PdfRenderTask;
	/** Frees page-level resources (optional, present in real pdf.js). */
	cleanup?(): unknown;
}

export interface PdfDoc {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
	destroy(): Promise<void>;
}

export interface PdfLib {
	getDocument(params: { data: Uint8Array | ArrayBuffer }): { promise: Promise<PdfDoc> };
}
