/** Pure logic of the instant board shot (no DOM, no 'obsidian'): where the photo and its time label go. */
import { elementBounds, type MeasureText } from "../ink/elements";
import { strokeBounds } from "../ink/hit-test";
import { growForInfinite } from "../ink/infinite";
import { LINE_HEIGHT } from "../ink/text-layout";
import type { ImageElement, Page, TextElement } from "../model/types";
import { fitInside } from "./view-helpers";

/** Space kept free at the page edges, pt. */
export const BOARD_MARGIN = 24;
/** Space between the last ink and the label, pt. */
export const BOARD_GAP = 12;
/** Space between the label and the photo, pt. */
export const LABEL_GAP = 4;
export const LABEL_FONT_SIZE = 10;
export const LABEL_WIDTH = 140;
export const LABEL_COLOR = "#6b7280";
/** The photo takes at most this part of the page height... */
export const PREFERRED_HEIGHT_FRACTION = 0.45;
/** ...and is squeezed into the room left below the ink only down to this height, pt. */
export const MIN_PHOTO_HEIGHT = 90;
/** Pixels of the photo to pt: 96 dpi, like every image the plugin places. */
const PX_TO_PT = 0.75;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Lowest point of the ink and elements of a page (0 when it is empty). The background and the paper do not count. */
export function contentBottom(page: Pick<Page, "strokes" | "elements">, measure?: MeasureText): number {
	let bottom = 0;
	for (const s of page.strokes) bottom = Math.max(bottom, strokeBounds(s).maxY);
	for (const el of page.elements ?? []) bottom = Math.max(bottom, elementBounds(el, measure).maxY);
	return Number.isFinite(bottom) ? bottom : 0;
}

export type BoardShotPlacement =
	/** Below the last ink, at the size wanted. */
	| "below-ink"
	/** Below the last ink, scaled down to the room left. */
	| "shrunk"
	/** Below the last ink on an infinite page that grows to make room. */
	| "grown-page"
	/** No room below the ink: centred in the visible part of the page, over what is there. */
	| "over-content";

export interface BoardShotInput {
	page: { width: number; height: number; infinite?: boolean };
	/** Lowest point of the writing on the page (`contentBottom`), 0 when empty. */
	contentBottom: number;
	/** Visible part of the page, page coordinates; null when it is not known. */
	visible: { minY: number; maxY: number } | null;
	/** Size of the photo in pixels. */
	imageWidth: number;
	imageHeight: number;
}

export interface BoardShotPlan {
	image: { x: number; y: number; width: number; height: number };
	label: { x: number; y: number; width: number };
	placement: BoardShotPlacement;
	/** New page height when the page has to grow (infinite pages only). */
	pageHeight?: number;
}

/**
 * Where the photo goes: horizontally centred, with the time label right above it, under the lowest ink of the
 * page (or under the top margin of an empty page). When the writing is scrolled out of view above, it starts at
 * the top of what is visible. If it does not fit it is scaled down (not below `MIN_PHOTO_HEIGHT`), or the infinite
 * page grows, or — last resort — it is centred in the visible area over the existing content.
 */
export function planBoardShot(input: BoardShotInput): BoardShotPlan {
	const { page, visible } = input;
	const labelHeight = LABEL_FONT_SIZE * LINE_HEIGHT;
	const availW = Math.max(40, page.width - 2 * BOARD_MARGIN);
	const preferredH = Math.max(MIN_PHOTO_HEIGHT, page.height * PREFERRED_HEIGHT_FRACTION);
	const wanted = fitInside(input.imageWidth * PX_TO_PT, input.imageHeight * PX_TO_PT, availW, preferredH, false);
	const header = labelHeight + LABEL_GAP;

	const make = (size: { width: number; height: number }, top: number, placement: BoardShotPlacement, pageHeight?: number): BoardShotPlan => {
		const x = round2(BOARD_MARGIN + (availW - size.width) / 2);
		const plan: BoardShotPlan = {
			image: { x, y: round2(top + header), width: size.width, height: size.height },
			label: { x, y: round2(top), width: Math.min(LABEL_WIDTH, Math.max(40, size.width)) },
			placement,
		};
		if (pageHeight !== undefined) plan.pageHeight = pageHeight;
		return plan;
	};

	let top = input.contentBottom > 0 ? input.contentBottom + BOARD_GAP : BOARD_MARGIN;
	if (visible && visible.minY + BOARD_MARGIN > top && visible.minY < page.height - BOARD_MARGIN) top = visible.minY + BOARD_MARGIN;

	const room = page.height - BOARD_MARGIN - top;
	if (header + wanted.height <= room) return make(wanted, top, "below-ink");

	if (page.infinite) {
		const grown = growForInfinite(page, { maxY: top + header + wanted.height });
		if (grown !== null && top + header + wanted.height <= grown - BOARD_MARGIN) return make(wanted, top, "grown-page", grown);
	}

	const squeezed = room - header;
	if (squeezed >= MIN_PHOTO_HEIGHT) return make(fitInside(wanted.width, wanted.height, availW, squeezed, false), top, "shrunk");

	// Over the content, centred on the visible part of the page (or on the page).
	const centre = visible ? (visible.minY + visible.maxY) / 2 : page.height / 2;
	const fitPage = fitInside(wanted.width, wanted.height, availW, Math.max(MIN_PHOTO_HEIGHT, page.height - 2 * BOARD_MARGIN - header), false);
	const block = header + fitPage.height;
	const maxTop = Math.max(0, page.height - block);
	return make(fitPage, Math.min(maxTop, Math.max(0, centre - block / 2)), "over-content");
}

/** "HH:MM" in local time. */
export function boardTime(date: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** The photo and its label as page elements (the label above the photo, the photo first so the label draws over it). */
export function boardShotElements(
	plan: BoardShotPlan, assetId: string, labelText: string, newId: () => string,
): { image: ImageElement; label: TextElement } {
	const image: ImageElement = {
		id: newId(), type: "image", asset: assetId,
		x: plan.image.x, y: plan.image.y, width: plan.image.width, height: plan.image.height, rotation: 0,
	};
	const label: TextElement = {
		id: newId(), type: "text", x: plan.label.x, y: plan.label.y, width: plan.label.width,
		text: labelText, fontSize: LABEL_FONT_SIZE, color: LABEL_COLOR,
	};
	return { image, label };
}
