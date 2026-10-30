import type { NewPageContent, PageContentChange, PageContentPlan } from "../model/page-content";
import { freezeStroke } from "../model/serialize";
import type { Asset, PageElement, Stroke } from "../model/types";
import { elementBounds, transformElement, type MeasureText } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { transformStroke } from "./lasso";
import { estimateMeasure } from "./text-layout";
import { translate } from "./transform";

/**
 * Heavy page warning (roadmap 380): when a page holds more than these, drawing and saving it get slow and the
 * view offers to split it. Pure logic; the banner is in view/heavy-page-banner.ts.
 */
export interface HeavyLimits {
	/** Strokes on the page. */
	strokes: number;
	/** Points of all its strokes together. */
	points: number;
	/** Bytes of the image files the page uses (image elements and an image background; a PDF is shared by its pages and not counted). */
	assetBytes: number;
}

export const HEAVY_LIMITS: Readonly<HeavyLimits> = {
	strokes: 3000,
	points: 120_000,
	assetBytes: 20 * 1024 * 1024,
};

export type HeavyReason = "strokes" | "points" | "assets";

/** What the thresholds look at. */
export interface PageLoad {
	strokes: number;
	points: number;
	assetBytes: number;
}

/** What `pageLoad` needs of a page (a `Page` fits). */
export interface LoadPage {
	strokes: ReadonlyArray<Pick<Stroke, "points">>;
	elements?: readonly PageElement[];
	background?: { kind: "pdf" | "image"; asset: string };
}

/** Counts a page: strokes, points, and the bytes of the distinct image assets it shows. */
export function pageLoad(page: LoadPage, assets: Readonly<Record<string, Pick<Asset, "bytes">>> | undefined): PageLoad {
	let points = 0;
	for (const s of page.strokes) points += s.points.length;
	const used = new Set<string>();
	for (const el of page.elements ?? []) if (el.type === "image") used.add(el.asset);
	if (page.background?.kind === "image") used.add(page.background.asset);
	let assetBytes = 0;
	for (const id of used) assetBytes += assets?.[id]?.bytes ?? 0;
	return { strokes: page.strokes.length, points, assetBytes };
}

/** Which limits the load exceeds (strictly above). */
export function heavyReasons(load: PageLoad, limits: Readonly<HeavyLimits> = HEAVY_LIMITS): HeavyReason[] {
	const out: HeavyReason[] = [];
	if (load.strokes > limits.strokes) out.push("strokes");
	if (load.points > limits.points) out.push("points");
	if (load.assetBytes > limits.assetBytes) out.push("assets");
	return out;
}

/** What `planPageSplit` needs of a page (a `Page` fits). */
export interface SplitPage extends LoadPage {
	id: string;
	strokes: readonly Stroke[];
	/** A PDF or scanned page: its ink annotates that background, so it is not split. */
	background?: { kind: "pdf" | "image"; asset: string; page?: number };
}

export interface SplitPlan extends PageContentPlan {
	/** Items (strokes and elements) that stay and that go to the new page. */
	staying: number;
	moved: number;
	/** Where the page was cut, in page coordinates (the middle of the gap between the two parts when there is one). */
	splitY: number;
	/** Whether the two parts are separated by blank space (no stroke or element crosses `splitY`). */
	clean: boolean;
	/** The move applied to the content of the new page: horizontal 0, vertical `dy` <= 0. */
	dy: number;
}

/** The moved content starts this far (pt) from the top of the new page, unless it is already higher. */
export const SPLIT_TOP_MARGIN = 36;
/** The cut is looked for where the lower part holds between these shares of the page's weight. */
const WINDOW_MIN = 0.35;
const WINDOW_MAX = 0.65;
/** Weight of a text box, and the least weight of an image, in "points". */
const TEXT_WEIGHT = 40;
const IMAGE_MIN_WEIGHT = 200;

interface Item {
	stroke?: Stroke;
	element?: PageElement;
	/** Index in its array (stroke or element order on the page). */
	index: number;
	minY: number;
	maxY: number;
	centre: number;
	weight: number;
}

/**
 * Plan for moving the lower half of a page's content to a new page right after it (apply with
 * `pageContentCommand(doc, plan, label)`: one undo step). The content is cut where the lower part holds about half
 * of the load (points, with text boxes and images weighing a fixed amount or their size), at the widest blank
 * gap between the two parts when there is one. Every stroke and element goes whole to the side its middle is on.
 * The moved content keeps its x positions and its distances to each other; it is only moved up so that it
 * starts `SPLIT_TOP_MARGIN` from the top of the new page, which has the size and paper of this page.
 * Null when there is nothing to split (fewer than two items) or the page has a background.
 */
export function planPageSplit(
	page: SplitPage, pageIndex: number, assets?: Readonly<Record<string, Pick<Asset, "bytes">>>,
	measure: MeasureText = estimateMeasure, boundsOf: (s: Stroke) => BBox = strokeBounds,
): SplitPlan | null {
	if (page.background) return null;
	const items: Item[] = [];
	page.strokes.forEach((stroke, index) => {
		const b = boundsOf(stroke);
		items.push({ stroke, index, minY: b.minY, maxY: b.maxY, centre: (b.minY + b.maxY) / 2, weight: Math.max(1, stroke.points.length) });
	});
	(page.elements ?? []).forEach((element, index) => {
		const b = elementBounds(element, measure);
		const weight = element.type === "image" ? Math.max(IMAGE_MIN_WEIGHT, Math.round((assets?.[element.asset]?.bytes ?? 0) / 256)) : TEXT_WEIGHT;
		items.push({ element, index, minY: b.minY, maxY: b.maxY, centre: (b.minY + b.maxY) / 2, weight });
	});
	const n = items.length;
	if (n < 2) return null;
	// Stable by centre, then by original order (strokes before elements), so the plan is deterministic.
	const sorted = items.map((it, order) => ({ it, order })).sort((a, b) => a.it.centre - b.it.centre || a.order - b.order).map((e) => e.it);

	const total = sorted.reduce((sum, it) => sum + it.weight, 0);
	// aboveMax[k]: lowest edge among sorted[0..k-1]; belowMin[k]: highest edge among sorted[k..].
	const aboveMax = new Array<number>(n + 1).fill(-Infinity);
	const belowMin = new Array<number>(n + 1).fill(Infinity);
	for (let k = 1; k <= n; k++) aboveMax[k] = Math.max(aboveMax[k - 1]!, sorted[k - 1]!.maxY);
	for (let k = n - 1; k >= 0; k--) belowMin[k] = Math.min(belowMin[k + 1]!, sorted[k]!.minY);

	let upper = 0;
	let best = -1;
	let bestGap = -Infinity;
	let bestDistance = Infinity;
	let fallback = 1;
	let fallbackDistance = Infinity;
	for (let k = 1; k < n; k++) {
		upper += sorted[k - 1]!.weight;
		const lowerShare = 1 - upper / total;
		const distance = Math.abs(lowerShare - 0.5);
		if (distance < fallbackDistance) {
			fallbackDistance = distance;
			fallback = k;
		}
		if (lowerShare < WINDOW_MIN || lowerShare > WINDOW_MAX) continue;
		const gap = belowMin[k]! - aboveMax[k]!;
		if (gap > bestGap + 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && distance < bestDistance)) {
			best = k;
			bestGap = gap;
			bestDistance = distance;
		}
	}
	const cut = best >= 0 ? best : fallback;
	const gap = belowMin[cut]! - aboveMax[cut]!;
	const clean = gap > 0;
	const splitY = clean ? (belowMin[cut]! + aboveMax[cut]!) / 2 : sorted[cut]!.centre;

	const moving = new Set<Item>(sorted.slice(cut));
	const movedMinY = Math.min(...sorted.slice(cut).map((it) => it.minY));
	const dy = Math.min(0, SPLIT_TOP_MARGIN - movedMinY);
	const m = translate(0, dy);

	const stayStrokes: Stroke[] = [];
	const stayElements: PageElement[] = [];
	const goStrokes: Stroke[] = [];
	const goElements: PageElement[] = [];
	for (const it of items) {
		if (it.stroke) {
			if (!moving.has(it)) stayStrokes.push(it.stroke);
			else goStrokes.push(dy === 0 ? it.stroke : freezeStroke(transformStroke(it.stroke, m)));
		} else if (!moving.has(it)) {
			stayElements.push(it.element!);
		} else {
			goElements.push(dy === 0 ? it.element! : transformElement(it.element!, m, measure));
		}
	}
	const change: PageContentChange = {
		pageId: page.id,
		strokes: stayStrokes,
		elements: stayElements.length > 0 ? stayElements : undefined,
	};
	const appended: NewPageContent = { strokes: goStrokes, elements: goElements };
	return {
		changes: [change],
		appended: [appended],
		insertAt: pageIndex + 1,
		staying: stayStrokes.length + stayElements.length,
		moved: goStrokes.length + goElements.length,
		splitY,
		clean,
		dy,
	};
}
