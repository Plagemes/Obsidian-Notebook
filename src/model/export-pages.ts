// wave 0.10 (81): PNG images of chosen pages. Pure: the scale choices and the file names. The pixels are drawn by
// ink/page-raster.ts and written by view/export-png.ts. Size limits are the ones of the Markdown export (renderSize).
import { pageImageName, uniqueFileName } from "./export-markdown";

/** Pixels per pt of the page (1 = the 72 dpi of a PDF page, an A4 page is then 595 x 842 px). */
export const PNG_SCALES = [1, 1.5, 2, 3, 4] as const;
export type PngScale = (typeof PNG_SCALES)[number];
export const DEFAULT_PNG_SCALE: PngScale = 2;

export function isPngScale(v: unknown): v is PngScale {
	return typeof v === "number" && (PNG_SCALES as readonly number[]).includes(v);
}

/** The resolution `renderSize` takes for a scale. */
export function scaleDpi(scale: number): number {
	return scale * 72;
}

/**
 * File names of the images of the pages `indices` (0-based) of a notebook with `count` pages: `page-003.png` for page 3,
 * so a range keeps the real page numbers. A name that `exists` (a path in the folder) or was chosen earlier in the same
 * export gets " 2", " 3"…; nothing is ever replaced. Returned in the order of `indices`.
 */
export function planPageImages(folder: string, indices: readonly number[], count: number, exists: (path: string) => boolean): string[] {
	const dir = folder === "" || folder === "/" ? "" : `${folder.replace(/\/+$/, "")}/`;
	const chosen = new Set<string>();
	const taken = (name: string): boolean => chosen.has(name) || exists(`${dir}${name}`);
	return indices.map((i) => {
		const name = uniqueFileName(pageImageName(i, count), taken);
		chosen.add(name);
		return name;
	});
}
