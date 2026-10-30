// wave 0.9 (381): what an export draws. The background is the white sheet, the PDF or picture under the page and the
// paper pattern; the ink is everything written or placed on the page (strokes, text boxes, pictures, boxes, markers).
// Pure: used by the PDF and SVG writers and by the export dialog. Hidden ink still follows its own rule (exports draw it
// only where the solutions are shown).

import { formatPageRange } from "../model/page-range";

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

/** `png` (wave 0.10, 81) writes one image per page into a vault folder; `print` writes nothing: it opens the system print dialog. */
export type ExportFormat = "pdf" | "svg" | "png" | "print";
/** `range` (wave 0.10): the pages the user typed, passed to `planExport` as `range`. */
export type ExportScope = "page" | "notebook" | "range";

/** One file to write: the pages (0-based indices) it holds and the name part after the notebook name. */
export interface ExportJob {
	format: ExportFormat;
	pages: number[];
	suffix: string;
}

/** The part of a file name that tells a range apart: ` p2-5`, ` p1-3+5`, or ` selection` when that gets long. */
function rangeSuffix(pages: readonly number[]): string {
	const label = formatPageRange(pages).replace(/, /g, "+");
	return label.length <= 40 ? ` p${label}` : " selection";
}

/**
 * Files an export writes. A PDF holds the pages it is asked for; an SVG holds one page, so a whole notebook (or a range)
 * is one SVG per page (` p1`, ` p2`…). PNG images and printing are one job holding every page (the PNG files are named
 * by the page number, see `planPageImages`). `pageIndex` is the page of a single-page export, `range` the 0-based pages
 * of a range (anything out of the notebook is dropped).
 */
export function planExport(
	format: ExportFormat, scope: ExportScope, pageIndex: number, pageCount: number, layers: ExportLayers = "both", range: readonly number[] = [],
): ExportJob[] {
	const tail = layersSuffix(layers);
	const pages = scope === "page" ? (pageIndex >= 0 && pageIndex < pageCount ? [pageIndex] : [])
		: scope === "range" ? [...new Set(range)].filter((i) => Number.isInteger(i) && i >= 0 && i < pageCount).sort((a, b) => a - b)
		: Array.from({ length: pageCount }, (_, i) => i);
	if (pages.length === 0) return [];
	if (format === "png" || format === "print") return [{ format, pages, suffix: "" }];
	if (format === "pdf") {
		const suffix = scope === "page" ? ` p${pageIndex + 1}${tail}` : scope === "range" ? `${rangeSuffix(pages)}${tail}` : tail;
		return [{ format, pages, suffix }];
	}
	return pages.map((i) => ({ format, pages: [i], suffix: ` p${i + 1}${tail}` }));
}
