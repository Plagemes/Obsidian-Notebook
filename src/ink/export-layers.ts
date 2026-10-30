// wave 0.9 (381): what an export draws. The background is the white sheet, the PDF or picture under the page and the
// paper pattern; the ink is everything written or placed on the page (strokes, text boxes, pictures, boxes, markers).
// Pure: used by the PDF and SVG writers and by the export dialog. Hidden ink still follows its own rule (exports draw it
// only where the solutions are shown).

export type ExportLayers = "both" | "ink" | "background";
export const EXPORT_LAYERS: readonly ExportLayers[] = ["both", "ink", "background"];

export interface LayerFlags {
	/** White sheet, PDF/picture background and paper pattern. */
	background: boolean;
	/** Strokes, text, picture elements, boxes and markers. */
	content: boolean;
}

export function isExportLayers(v: unknown): v is ExportLayers {
	return v === "both" || v === "ink" || v === "background";
}

export function layerFlags(layers: ExportLayers | undefined): LayerFlags {
	const l = layers ?? "both";
	return { background: l !== "ink", content: l !== "background" };
}

/** File name part that tells the layers apart (empty for "both"). */
export function layersSuffix(layers: ExportLayers | undefined): string {
	return layers === "ink" ? " ink" : layers === "background" ? " background" : "";
}

export type ExportFormat = "pdf" | "svg";
export type ExportScope = "page" | "notebook";

/** One file to write: the pages (0-based indices) it holds and the name part after the notebook name. */
export interface ExportJob {
	format: ExportFormat;
	pages: number[];
	suffix: string;
}

/**
 * Files an export writes. A PDF holds the pages it is asked for; an SVG holds one page, so a whole notebook is one
 * SVG per page (` p1`, ` p2`…). `pageIndex` is the page of a single-page export.
 */
export function planExport(format: ExportFormat, scope: ExportScope, pageIndex: number, pageCount: number, layers: ExportLayers = "both"): ExportJob[] {
	const tail = layersSuffix(layers);
	if (scope === "page") return pageIndex >= 0 && pageIndex < pageCount ? [{ format, pages: [pageIndex], suffix: ` p${pageIndex + 1}${tail}` }] : [];
	if (format === "pdf") return pageCount > 0 ? [{ format, pages: Array.from({ length: pageCount }, (_, i) => i), suffix: tail }] : [];
	return Array.from({ length: pageCount }, (_, i) => ({ format, pages: [i], suffix: ` p${i + 1}${tail}` }));
}
