// 0.28 (#76, format v26): rotate and crop of an imported PDF page. Pure data and geometry: no 'obsidian', no DOM.
//
// A page whose background is a PDF page may carry two optional fields on that background:
//   - `rotate`: 90, 180 or 270 (degrees clockwise, ON TOP of the PDF page's own /Rotate, which pdf.js already applies);
//   - `crop`: the part of the PDF page that is shown, `{x, y, width, height}` in PDF points (the unrotated page as pdf.js
//     draws it at scale 1: origin top-left, y down). The crop is applied first, then the rotation.
// Absent fields = today's look (the whole page, upright). The app never writes `rotate: 0`.
//
// The "source" of everything below is the PDF page at scale 1 (what `PdfStore.pageSizes` returns). The "view" is what the
// page shows: the cropped part, turned. The ink keeps page coordinates; a change of view maps them in ONE History step
// (`SetPdfView`, see model/history.ts) with the rigid matrix that `planPdfView` computes, so ink, elements and areas stay on
// the same part of the PDF.
import type { Matrix } from "../ink/transform";
import { invert, multiply, scaleAbout, translate } from "../ink/transform";
import { backgroundRect, normalizeMargins, type Rect } from "./margins";
import type { Page, PageBackground, PageMargins } from "./types";
import { isPdfCrop, isPdfRotation, normalizePdfCrop, PDF_CROP_MAX, PDF_CROP_MIN_SIDE, PDF_ROTATIONS, type PdfCrop, type PdfRotation } from "./pdf-view-format";

export { isPdfCrop, isPdfRotation, normalizePdfCrop, PDF_CROP_MAX, PDF_CROP_MIN_SIDE, PDF_ROTATIONS, type PdfCrop, type PdfRotation };

/** What a page shows of its PDF page. An empty view is the whole page, upright. */
export interface PdfView {
	rotate?: PdfRotation;
	crop?: PdfCrop;
}

export type PdfBackground = Extract<PageBackground, { kind: "pdf" }>;

interface Size {
	width: number;
	height: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The rotation and crop a page background carries; undefined for an image, no background, or a PDF page shown whole and upright. */
export function viewOf(bg: PageBackground | undefined): PdfView | undefined {
	if (bg?.kind !== "pdf") return undefined;
	if (bg.rotate === undefined && bg.crop === undefined) return undefined;
	const view: PdfView = {};
	if (bg.rotate !== undefined) view.rotate = bg.rotate;
	if (bg.crop !== undefined) view.crop = { ...bg.crop };
	return view;
}

/** Whether the view changes anything (no rotation, no crop: it does not). */
export function isIdentityView(view: PdfView | undefined): boolean {
	return !view || (view.rotate === undefined && view.crop === undefined);
}

/** The same background with `view` instead of its own (cleared when `view` is empty); the other fields are kept. */
export function withView(bg: PdfBackground, view: PdfView | undefined): PdfBackground {
	const out: PdfBackground = { kind: "pdf", asset: bg.asset, page: bg.page };
	const rotate = view?.rotate;
	if (isPdfRotation(rotate)) out.rotate = rotate;
	const crop = normalizePdfCrop(view?.crop);
	if (crop) out.crop = crop;
	return out;
}

/** A stable text for the view of a background (cache keys): "" for the whole page upright. */
export function viewKey(view: PdfView | undefined): string {
	if (isIdentityView(view)) return "";
	const c = view!.crop;
	return `r${view!.rotate ?? 0}${c ? `c${c.x},${c.y},${c.width},${c.height}` : ""}`;
}

/** The key of a page background for caches of what is drawn from it: asset, page and view. Empty for no PDF background. */
export function backgroundViewKey(bg: PageBackground | undefined): string {
	return bg?.kind === "pdf" ? `${bg.asset}|${bg.page}|${viewKey(viewOf(bg))}` : "";
}

/** The rotation of a view in degrees clockwise, 0 when none. */
export function rotationOf(view: PdfView | undefined): 0 | PdfRotation {
	return view?.rotate ?? 0;
}

/**
 * The crop clamped to the PDF page (`source`, pt); the whole page when the view has no crop or what is left after clamping is
 * smaller than PDF_CROP_MIN_SIDE on a side (a crop saved for another version of the PDF never shows nothing).
 */
export function effectiveCrop(view: PdfView | undefined, source: Size): PdfCrop {
	const whole: PdfCrop = { x: 0, y: 0, width: source.width, height: source.height };
	const c = view?.crop;
	if (!c) return whole;
	const x = Math.min(Math.max(0, c.x), source.width);
	const y = Math.min(Math.max(0, c.y), source.height);
	const width = Math.min(c.width, source.width - x);
	const height = Math.min(c.height, source.height - y);
	if (width < Math.min(PDF_CROP_MIN_SIDE, source.width) || height < Math.min(PDF_CROP_MIN_SIDE, source.height) || !(width > 0) || !(height > 0)) return whole;
	return { x, y, width, height };
}

/** The size, pt at scale 1, of what the view shows (the crop turned: the sides swap for a quarter turn). */
export function viewSize(view: PdfView | undefined, source: Size): Size {
	const c = effectiveCrop(view, source);
	const r = rotationOf(view);
	return r === 90 || r === 270 ? { width: c.height, height: c.width } : { width: c.width, height: c.height };
}

/** The matrix from the PDF page (pt, scale 1) to the view (pt, origin at the top-left of what is shown). */
export function sourceToView(view: PdfView | undefined, source: Size): Matrix {
	const c = effectiveCrop(view, source);
	const r = rotationOf(view);
	const w = c.width, h = c.height;
	const turn: Matrix = r === 90 ? [0, 1, -1, 0, h, 0] : r === 180 ? [-1, 0, 0, -1, w, h] : r === 270 ? [0, -1, 1, 0, 0, w] : [1, 0, 0, 1, 0, 0];
	return multiply(turn, translate(-c.x, -c.y));
}

/** The matrix from the view back to the PDF page. */
export function viewToSource(view: PdfView | undefined, source: Size): Matrix {
	return invert(sourceToView(view, source));
}

/** The view turned by `quarterTurns` quarter turns clockwise (negative: anticlockwise); the crop, in PDF coordinates, stays. */
export function rotateView(view: PdfView | undefined, quarterTurns: number): PdfView | undefined {
	const turns = ((Math.round(quarterTurns) % 4) + 4) % 4;
	const degrees = ((rotationOf(view) + turns * 90) % 360) as 0 | PdfRotation;
	const out: PdfView = {};
	if (degrees !== 0) out.rotate = degrees;
	if (view?.crop) out.crop = { ...view.crop };
	return isIdentityView(out) ? undefined : out;
}

/** The view with another crop (undefined: no crop); the rotation stays. */
export function cropView(view: PdfView | undefined, crop: PdfCrop | undefined): PdfView | undefined {
	const out: PdfView = {};
	if (view?.rotate !== undefined) out.rotate = view.rotate;
	const c = normalizePdfCrop(crop);
	if (c) out.crop = c;
	return isIdentityView(out) ? undefined : out;
}

/** Whether two views show the same thing. */
export function sameView(a: PdfView | undefined, b: PdfView | undefined): boolean {
	return viewKey(a) === viewKey(b);
}

/** A rectangle given in the PDF page's coordinates, as the rectangle (axis aligned) it covers in the view. */
export function mapRect(m: Matrix, r: Rect): Rect {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const [x, y] of [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]] as const) {
		xs.push(m[0] * x + m[2] * y + m[4]);
		ys.push(m[1] * x + m[3] * y + m[5]);
	}
	const x = Math.min(...xs), y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** What a page needs to know about itself to be re-viewed: its size, margins and the box the background is drawn in. */
export interface ViewFrame {
	/** Pt per PDF pt (the box width over the view's width: 1 for a page made from the PDF). */
	scale: number;
	box: Rect;
	margins: PageMargins | undefined;
}

/** The result of a change of view: the new background, the new size and margins of the page and the matrix that carries the old page coordinates to the new. */
export interface PdfViewPlan {
	background: PdfBackground;
	width: number;
	height: number;
	margins: PageMargins | undefined;
	/** Old page coordinates → new page coordinates (rigid: a multiple of a quarter turn and a translation). */
	matrix: Matrix;
	/** The margins grew (left, right, bottom) so that nothing that was on the page ends up beyond its edge. */
	grown: { left: number; right: number; bottom: number };
	/** Items that would end up above the top edge (the page has no top margin): the change is refused while there are any. */
	above: number;
}

/** The part of a page that carries content, as bounds of each item in the OLD frame. */
export interface ContentBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

const roundMatrix = (m: Matrix): Matrix => [Math.round(m[0]), Math.round(m[1]), Math.round(m[2]), Math.round(m[3]), round2(m[4]), round2(m[5])];

function applyBox(m: Matrix, b: ContentBox): ContentBox {
	const r = mapRect(m, { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY });
	return { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height };
}

/**
 * The change of view of `page` to `next` (undefined = whole page, upright), given the size of the PDF page (`source`, pt) and the
 * bounds of every item that lives on the page (strokes, elements; used to keep them on the page).
 *
 * Geometry: the background box keeps its place (x = left margin, y = 0) and the margins stay; the box takes the size of the new view
 * (times the page's scale). The matrix carries a page point to the same PDF point in the new view: through the old view back to the
 * PDF page, then forward through the new view. It is rigid, so ink keeps its size and shape.
 *
 * Items that would end up beyond the left, right or bottom edge make the margins grow just enough to hold them, so they stay on the
 * page, visible and editable, next to the PDF (the matrix then also shifts everything right by the growth of the left margin).
 * Items that would end up above the top edge cannot be kept (a page has no top margin): `above` counts them and the caller refuses the
 * change. Items that were wholly outside the page before are left alone. Null when `page` has no PDF background.
 */
export function planPdfView(page: Pick<Page, "width" | "height" | "margins" | "background">, source: Size, next: PdfView | undefined, items: readonly ContentBox[] = []): PdfViewPlan | null {
	const bg = page.background;
	if (bg?.kind !== "pdf" || !(source.width > 0) || !(source.height > 0)) return null;
	const current = viewOf(bg);
	const before = viewSize(current, source);
	const box = backgroundRect(page);
	const k = box.width / before.width;
	if (!(k > 0) || !Number.isFinite(k)) return null;
	const after = viewSize(next, source);
	const toLocal = multiply(scaleAbout(1 / k, 1 / k, 0, 0), translate(-box.x, -box.y));
	const toPage = multiply(translate(box.x, box.y), scaleAbout(k, k, 0, 0));
	const base = roundMatrix(multiply(toPage, multiply(sourceToView(next, source), multiply(viewToSource(current, source), toLocal))));
	const m = normalizeMargins(page.margins) ?? { left: 0, right: 0, bottom: 0 };
	const width = round2(after.width * k + m.left + m.right);
	const height = round2(after.height * k + m.bottom);
	const background = withView(bg, next);

	// Where the items go, and how far beyond the new page they stray.
	let left = 0, right = 0, bottom = 0, above = 0;
	const oldW = page.width, oldH = page.height;
	const eps = 0.5;
	for (const item of items) {
		if (item.maxX < 0 || item.maxY < 0 || item.minX > oldW || item.minY > oldH) continue;
		const b = applyBox(base, item);
		if (b.minY < -eps) above++;
		left = Math.max(left, -b.minX);
		right = Math.max(right, b.maxX - width);
		bottom = Math.max(bottom, b.maxY - height);
	}
	const grow = (n: number): number => (n > eps ? Math.ceil(n) : 0);
	const grown = { left: grow(left), right: grow(right), bottom: grow(bottom) };
	const margins = normalizeMargins({ left: m.left + grown.left, right: m.right + grown.right, bottom: m.bottom + grown.bottom });
	const matrix: Matrix = grown.left ? roundMatrix(multiply(translate(grown.left, 0), base)) : base;
	return {
		background, margins, matrix, grown, above,
		width: round2(width + grown.left + grown.right),
		height: round2(height + grown.bottom),
	};
}

/** Whether the plan changes nothing about the page (same view, nothing moves). */
export function isNoopPlan(plan: PdfViewPlan, page: Pick<Page, "width" | "height" | "background">): boolean {
	return sameView(viewOf(plan.background), viewOf(page.background)) && plan.width === page.width && plan.height === page.height;
}

/**
 * The part of the view that a point of the PDF page (pt, scale 1) lands on, in the PAGE's coordinates: the matrix from the PDF page
 * to the page, for text boxes and links (`box` = the background box of the page).
 */
export function sourceToPage(view: PdfView | undefined, source: Size, box: Rect): Matrix {
	const size = viewSize(view, source);
	const k = box.width / size.width;
	return multiply(translate(box.x, box.y), multiply(scaleAbout(k, k, 0, 0), sourceToView(view, source)));
}
