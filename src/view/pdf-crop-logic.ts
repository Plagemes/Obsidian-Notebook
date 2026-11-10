// 0.28 (#76): the geometry of the "Crop PDF page" dialog. Pure: no 'obsidian' import, tested in Node.
// The dialog shows the whole PDF page turned as it is going to be, with a frame on it (the part to keep). The frame lives in the
// shown page's own coordinates (pt at scale 1, top-left origin); it is stored as a crop of the PDF page itself (the unrotated page),
// so a later turn of the page keeps it on the same part.
import { mapRect, normalizePdfCrop, PDF_CROP_MIN_SIDE, sourceToView, viewToSource, type PdfCrop } from "../model/pdf-view";

export interface Frame {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CropHandle = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

/** All the handles, corners last (they sit on top of the edge handles). */
export const CROP_HANDLES: readonly CropHandle[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

interface Size {
	width: number;
	height: number;
}

/**
 * The frame after dragging `handle` by (`dx`, `dy`) from `start`: an edge handle moves that edge, a corner two edges, "move" the whole
 * frame. The frame stays inside `bounds` (the shown page) and keeps at least `minSide` on each side.
 */
export function dragFrame(start: Frame, handle: CropHandle, dx: number, dy: number, bounds: Size, minSide = PDF_CROP_MIN_SIDE): Frame {
	const min = Math.min(minSide, bounds.width, bounds.height);
	if (handle === "move") {
		const x = Math.min(Math.max(0, start.x + dx), Math.max(0, bounds.width - start.width));
		const y = Math.min(Math.max(0, start.y + dy), Math.max(0, bounds.height - start.height));
		return { x, y, width: start.width, height: start.height };
	}
	let left = start.x, top = start.y, right = start.x + start.width, bottom = start.y + start.height;
	if (handle.includes("w")) left = Math.min(Math.max(0, left + dx), right - min);
	if (handle.includes("e")) right = Math.max(Math.min(bounds.width, right + dx), left + min);
	if (handle.includes("n")) top = Math.min(Math.max(0, top + dy), bottom - min);
	if (handle.includes("s")) bottom = Math.max(Math.min(bounds.height, bottom + dy), top + min);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The frame that holds the whole shown page. */
export function wholeFrame(shown: Size): Frame {
	return { x: 0, y: 0, width: shown.width, height: shown.height };
}

/** The frame (in the page as shown with `rotate`) of a crop of the PDF page; the whole page without a crop. */
export function cropToFrame(crop: PdfCrop | undefined, rotate: 0 | 90 | 180 | 270, source: Size): Frame {
	const view = rotate === 0 ? undefined : { rotate };
	const whole = { x: 0, y: 0, width: source.width, height: source.height };
	const r = mapRect(sourceToView(view, source), crop ?? whole);
	return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** The crop of the PDF page a frame in the page shown with `rotate` stands for; null when the frame is (within a point) the whole page, undefined when it is too small to be a crop. */
export function frameToCrop(frame: Frame, rotate: 0 | 90 | 180 | 270, source: Size): PdfCrop | null | undefined {
	const view = rotate === 0 ? undefined : { rotate };
	const r = mapRect(viewToSource(view, source), frame);
	const x = Math.max(0, r.x), y = Math.max(0, r.y);
	const width = Math.min(source.width - x, r.width), height = Math.min(source.height - y, r.height);
	if (x < 1 && y < 1 && width > source.width - 1 && height > source.height - 1) return null;
	// undefined: the frame cannot be stored as a crop (a side under the smallest crop): the caller refuses it, it is NOT "no crop" (review Q12).
	return normalizePdfCrop({ x, y, width, height });
}

/** Whether two frames are the same to the hundredth of a point. */
export function sameFrame(a: Frame, b: Frame): boolean {
	const eq = (p: number, q: number): boolean => Math.abs(p - q) < 0.005;
	return eq(a.x, b.x) && eq(a.y, b.y) && eq(a.width, b.width) && eq(a.height, b.height);
}
