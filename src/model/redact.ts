/**
 * 0.26 redact (#285): redaction before export. The model: the boxes the reader draws on pages to cover what must not leave the notebook.
 * Pure: no 'obsidian', no DOM. Boxes are NOT part of the notebook document (no format change): they are an export-time choice, kept
 * per notebook on this device in bounded local storage (see ui/redact-store.ts) and given to the exporters, which leave out whatever lies
 * under them (ink/redact.ts). A box is a rectangle in page coordinates (pt), keyed by the stable page id.
 *
 * 0.28 (#76): a box also remembers the turn and crop of the PDF page it was drawn on (`view`, the page background's `viewKey`; absent = the
 * whole page upright, which is also what every earlier box was drawn on). A box is in page coordinates, so when the page is turned or cropped
 * afterwards (an undo of a turn, another device's copy, a re-published slide) it no longer covers what it covered: exports REFUSE to write
 * such a page (`staleRedactionPages`, applied by `withRedaction` and by the export options) rather than write it unredacted, and the turn
 * and crop actions themselves refuse a page that has boxes.
 *
 * 0.29 (round-3 review Z2): a box also remembers where the background of its page was drawn and what it showed (`geo`, see
 * `backgroundGeometry`): the rectangle of the PDF page or picture on the page (a left margin, a page size or orientation, an infinite page
 * that grew, a page restore or a synced copy move or stretch it) and a hash of its asset, page, turn and crop ("Update PDF" puts another
 * slide there). An export refuses a page whose background is not where its boxes were drawn, whatever changed it (a command on this device
 * or a file synced from another one). Boxes stored before 0.29 have no `geo`: they are checked on their view as before, and adopt the
 * geometry of their page once (`adoptGeometry`, when the notebook is opened, and when the Redact dialog is confirmed). A box drawn on a page
 * without a background records none; a page whose background is gone is not stale (nothing it covered can show), one that shows another
 * background than the recorded one is.
 */
import { backgroundRect } from "./margins";
import { backgroundViewKey, viewKey, viewOf } from "./pdf-view";
import type { Page, PageBackground } from "./types";

export interface RedactBox {
	x: number;
	y: number;
	width: number;
	height: number;
	/** 0.28 (#76): the view (turn and crop) of the PDF page the box was drawn on; absent = upright and whole. */
	view?: string;
	/** 0.29 (round-3 review Z2): where the background of the page was and what it showed (`backgroundGeometry`); absent = unknown or no background. */
	geo?: string;
}

const VIEW_KEY = /^[A-Za-z0-9.,|_-]{1,160}$/;

/** What `backgroundGeometry` needs of a page (a `Page` fits). */
export type GeometryPage = Pick<Page, "background" | "width" | "height" | "margins">;

/** The view key of a page as a box records it: "" for a page that is not turned or cropped (no PDF background included). */
export function pageViewKey(page: Pick<Page, "background">): string {
	return viewKey(viewOf(page.background));
}

/** 53-bit string hash (cyrb53), as 14 hex digits. */
export function hash53(s: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** What a background shows, as a text: the PDF asset, page, turn and crop, or the picture; "" without a background. */
export function backgroundKey(bg: PageBackground | undefined): string {
	if (!bg) return "";
	return bg.kind === "pdf" ? `pdf|${backgroundViewKey(bg)}` : `${bg.kind}|${bg.asset}`;
}

/**
 * Round-3 review (Z2): the geometry of the background of `page` as a box records it: `g<x>,<y>,<width>,<height>|<hash of what it shows>`
 * (the rectangle in page coordinates, pt, rounded to 0.01). "" for a page without a background.
 */
export function backgroundGeometry(page: GeometryPage): string {
	if (!page.background) return "";
	const r = backgroundRect(page);
	return `g${round2(r.x)},${round2(r.y)},${round2(r.width)},${round2(r.height)}|${hash53(backgroundKey(page.background))}`;
}

/** Whether `box` no longer covers what it covered on `page`: drawn on another turn or crop, or (Z2) on another background geometry. */
function boxIsStale(box: RedactBox, view: string, geo: string): boolean {
	if ((box.view ?? "") !== view) return true;
	// A box that does not know its geometry (stored before 0.29) is checked on its view only; a page whose background is gone shows
	// nothing the box covered (its ink is where it was).
	return box.geo !== undefined && geo !== "" && box.geo !== geo;
}

/**
 * Pages (by id) that have a box drawn on another turn or crop of their PDF page than the one they show now, or (round-3 review Z2) with their
 * background somewhere else, of another size or showing something else: those boxes are in the wrong place.
 */
export function staleRedactionPages(pages: readonly (Pick<Page, "id"> & GeometryPage)[], redactions: Redactions | undefined): string[] {
	if (!redactions) return [];
	const out: string[] = [];
	for (const p of pages) {
		const list = Object.prototype.hasOwnProperty.call(redactions, p.id) ? redactions[p.id] : undefined;
		if (!list || list.length === 0) continue;
		const view = pageViewKey(p);
		const geo = backgroundGeometry(p);
		if (list.some((b) => boxIsStale(b, view, geo))) out.push(p.id);
	}
	return out;
}

/**
 * `boxes` with the boxes drawn now (those not in `before`) tagged with the view and (Z2) the background geometry of their page; boxes that
 * were already there keep what they had, except that a box without a geometry whose view is the page's adopts the page's geometry
 * (`adoptGeometry`): confirming the Redact dialog confirms the boxes where they are.
 */
export function tagNewBoxes(boxes: Redactions, before: Redactions | undefined, pages: readonly (Pick<Page, "id"> & GeometryPage)[]): Redactions {
	const out: Redactions = {};
	const sameRect = (a: RedactBox, b: RedactBox): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
	for (const [id, list] of Object.entries(boxes)) {
		const page = pages.find((p) => p.id === id);
		const key = page ? pageViewKey(page) : "";
		const geo = page ? backgroundGeometry(page) : "";
		const had = Object.prototype.hasOwnProperty.call(before ?? {}, id) ? before![id]! : [];
		out[id] = list.map((b) => {
			if (b.view !== undefined || had.some((h) => sameRect(h, b))) return adoptOne(b, key, geo);
			const tagged: RedactBox = { ...b };
			if (key !== "") tagged.view = key;
			if (geo !== "") tagged.geo = geo;
			return tagged.view === b.view && tagged.geo === b.geo ? b : tagged;
		});
	}
	return out;
}

/** `box` with the geometry `geo` when it has none and is not stale by its view (`key`: the view of its page now); else the same box. */
function adoptOne(box: RedactBox, key: string, geo: string): RedactBox {
	return box.geo !== undefined || geo === "" || (box.view ?? "") !== key ? box : { ...box, geo };
}

/**
 * Round-3 review (Z2): the boxes stored before 0.29 (no `geo`) adopt the background geometry of their page as it is now, once. A box that is
 * already stale by its view, or whose page is not in `pages` or has no background, is left as it is. The same object when nothing changed.
 */
export function adoptGeometry(boxes: Redactions, pages: readonly (Pick<Page, "id"> & GeometryPage)[]): Redactions {
	let changed = false;
	const out: Redactions = {};
	for (const [id, list] of Object.entries(boxes)) {
		const page = pages.find((p) => p.id === id);
		if (!page) {
			out[id] = list;
			continue;
		}
		const key = pageViewKey(page);
		const geo = backgroundGeometry(page);
		out[id] = list.map((b) => {
			const next = adoptOne(b, key, geo);
			if (next !== b) changed = true;
			return next;
		});
	}
	return changed ? out : boxes;
}

/** The boxes of a notebook by page id (a page without boxes has no entry). */
export type Redactions = Record<string, RedactBox[]>;

/** The smallest side of a box, pt: a drag shorter than this adds nothing (it was a tap). */
export const REDACT_MIN_SIDE = 6;
/** Most boxes on one page, most pages with boxes and most boxes in a notebook: what a drawn set and what local storage can hold. */
export const REDACT_MAX_PER_PAGE = 60;
export const REDACT_MAX_PAGES = 400;
export const REDACT_MAX_TOTAL = 800;
/** Page coordinates stay within this magnitude (a stored value outside it is not a box). */
const COORD_LIMIT = 1_000_000;
const PAGE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function isPageId(v: unknown): v is string {
	return typeof v === "string" && PAGE_ID.test(v) && v !== "__proto__" && v !== "constructor" && v !== "prototype";
}

/** A stored value as a box, or null when it is not a usable one (not finite, too small, out of range). */
export function cleanBox(v: unknown): RedactBox | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v as Record<string, unknown>;
	const { x, y, width, height } = o;
	if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return null;
	if (![x, y, width, height].every((n) => Number.isFinite(n) && Math.abs(n) <= COORD_LIMIT)) return null;
	if (width < REDACT_MIN_SIDE || height < REDACT_MIN_SIDE) return null;
	const box: RedactBox = { x: round2(x), y: round2(y), width: round2(width), height: round2(height) };
	// A view key that is not one of ours is dropped (the box is then read as drawn on the upright page, which an export checks against the page).
	if (typeof o.view === "string" && VIEW_KEY.test(o.view)) box.view = o.view;
	// Round-3 review (Z2): likewise a geometry that is not one of ours (the box is then checked on its view, and adopts one when it can).
	if (typeof o.geo === "string" && VIEW_KEY.test(o.geo)) box.geo = o.geo;
	return box;
}

/**
 * Whatever was stored, as a valid and bounded set: bad page ids and boxes are dropped, duplicates are merged away, the limits hold.
 * With `pageIds` the boxes of pages that are not there any more are dropped too.
 */
export function normaliseRedactions(data: unknown, pageIds?: ReadonlySet<string>): Redactions {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const out: Redactions = {};
	let pages = 0;
	let total = 0;
	for (const [id, list] of Object.entries(data as Record<string, unknown>)) {
		if (!isPageId(id) || !Array.isArray(list) || (pageIds && !pageIds.has(id))) continue;
		if (pages >= REDACT_MAX_PAGES || total >= REDACT_MAX_TOTAL) break;
		const boxes: RedactBox[] = [];
		const seen = new Set<string>();
		for (const raw of list) {
			if (boxes.length >= REDACT_MAX_PER_PAGE || total + boxes.length >= REDACT_MAX_TOTAL) break;
			const box = cleanBox(raw);
			if (!box) continue;
			const key = `${box.x}|${box.y}|${box.width}|${box.height}|${box.view ?? ""}|${box.geo ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			boxes.push(box);
		}
		if (boxes.length === 0) continue;
		out[id] = boxes;
		pages++;
		total += boxes.length;
	}
	return out;
}

export function countBoxes(r: Redactions | undefined): number {
	if (!r) return 0;
	let n = 0;
	for (const list of Object.values(r)) n += list.length;
	return n;
}

/** How many pages have at least one box. */
export function countPages(r: Redactions | undefined): number {
	return r ? Object.values(r).filter((list) => list.length > 0).length : 0;
}

export function boxesOf(r: Redactions | undefined, pageId: string): readonly RedactBox[] {
	return (r && Object.prototype.hasOwnProperty.call(r, pageId) ? r[pageId] : undefined) ?? [];
}

/** The set with `box` added to the page (a new object; the same one when the box is not usable, a duplicate, or over a limit). */
export function addBox(r: Redactions, pageId: string, box: RedactBox): Redactions {
	const clean = cleanBox(box);
	if (!clean || !isPageId(pageId)) return r;
	const have = boxesOf(r, pageId);
	if (have.length >= REDACT_MAX_PER_PAGE || countBoxes(r) >= REDACT_MAX_TOTAL) return r;
	if (have.length === 0 && countPages(r) >= REDACT_MAX_PAGES) return r;
	if (have.some((b) => b.x === clean.x && b.y === clean.y && b.width === clean.width && b.height === clean.height && b.view === clean.view && b.geo === clean.geo)) return r;
	return { ...r, [pageId]: [...have, clean] };
}

/** The set without the box at `index` of the page (the page entry goes when it was the last one). */
export function removeBox(r: Redactions, pageId: string, index: number): Redactions {
	const have = boxesOf(r, pageId);
	if (index < 0 || index >= have.length) return r;
	const rest = have.filter((_, i) => i !== index);
	const next = { ...r };
	if (rest.length === 0) delete next[pageId];
	else next[pageId] = rest;
	return next;
}

export function clearPage(r: Redactions, pageId: string): Redactions {
	if (boxesOf(r, pageId).length === 0) return r;
	const next = { ...r };
	delete next[pageId];
	return next;
}

/** The last box added to the page removed (undo of a drag). */
export function removeLast(r: Redactions, pageId: string): Redactions {
	return removeBox(r, pageId, boxesOf(r, pageId).length - 1);
}

/** The box a drag from `a` to `b` (page coordinates) makes, cut at the page edges; null when it is too small to be one. */
export function boxFromDrag(a: readonly [number, number], b: readonly [number, number], page: { width: number; height: number }): RedactBox | null {
	if (![a[0], a[1], b[0], b[1], page.width, page.height].every(Number.isFinite)) return null;
	const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
	const x0 = clamp(Math.min(a[0], b[0]), page.width);
	const x1 = clamp(Math.max(a[0], b[0]), page.width);
	const y0 = clamp(Math.min(a[1], b[1]), page.height);
	const y1 = clamp(Math.max(a[1], b[1]), page.height);
	return cleanBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

/** A screen point as page coordinates inside a preview whose on-screen rectangle is `shown` (the whole page fills it). */
export function pointToPage(clientX: number, clientY: number, shown: { left: number; top: number; width: number; height: number }, page: { width: number; height: number }): [number, number] {
	const w = shown.width > 0 ? shown.width : 1;
	const h = shown.height > 0 ? shown.height : 1;
	return [((clientX - shown.left) / w) * page.width, ((clientY - shown.top) / h) * page.height];
}

/** Whether two rectangles overlap (touching edges do not count). */
export function rectsOverlap(a: RedactBox, b: RedactBox): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Page ids that have boxes, in the order of `pageIds` (the ones that are not in the list are left out). */
export function pagesWithBoxes(r: Redactions | undefined, pageIds: readonly string[]): string[] {
	return pageIds.filter((id) => boxesOf(r, id).length > 0);
}

/** What is stored per notebook on this device: the boxes and whether exports apply them. */
export interface RedactState {
	on: boolean;
	boxes: Redactions;
	/** Review fix (P4): what was stored for this notebook could not be read (exports refuse to write until it is set again). */
	unreadable?: true;
}

export const EMPTY_REDACT_STATE: RedactState = { on: false, boxes: {} };

/** Whether exports will cover anything: switched on and at least one box. */
export function isArmed(state: RedactState): boolean {
	return state.on && countBoxes(state.boxes) > 0;
}
