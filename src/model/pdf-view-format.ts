// 0.28 (#76, format v26): the file form of the rotation and crop of a PDF page background: what is valid. A leaf module (imports nothing), so the
// serializer can use it without a cycle; model/pdf-view.ts holds the geometry and re-exports these.

export const PDF_ROTATIONS = [90, 180, 270] as const;
export type PdfRotation = (typeof PDF_ROTATIONS)[number];

/** A part of a PDF page, in PDF points of the page as pdf.js draws it at scale 1 (top-left origin, y down). */
export interface PdfCrop {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Smallest side of a crop, pt (a sliver is a mistake, not a crop). */
export const PDF_CROP_MIN_SIDE = 16;
/** Largest value of a crop field, pt (a PDF page is at most 14400 pt, 200 in). */
export const PDF_CROP_MAX = 14400;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function isPdfRotation(v: unknown): v is PdfRotation {
	return v === 90 || v === 180 || v === 270;
}

/** Whether `v` is a well-formed crop (finite, not negative, sides at least PDF_CROP_MIN_SIDE, nothing beyond PDF_CROP_MAX). Not checked against any page. */
export function isPdfCrop(v: unknown): v is PdfCrop {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Record<string, unknown>;
	const ok = (n: unknown, min: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= PDF_CROP_MAX;
	return ok(c.x, 0) && ok(c.y, 0) && ok(c.width, PDF_CROP_MIN_SIDE) && ok(c.height, PDF_CROP_MIN_SIDE);
}

/** The crop as stored: rounded to 0.01 pt, only the four fields; undefined when it is not well-formed. */
export function normalizePdfCrop(c: unknown): PdfCrop | undefined {
	if (!isPdfCrop(c)) return undefined;
	const out = { x: round2(c.x), y: round2(c.y), width: round2(c.width), height: round2(c.height) };
	return isPdfCrop(out) ? out : undefined;
}
