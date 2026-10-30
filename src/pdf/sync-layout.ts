/**
 * Layout rules of the PDF side pane (pure): which way the notebook view is split and how far the divider can move.
 *
 * The split is inside the notebook view, not a second Obsidian leaf: Obsidian on phones and tablets does not offer
 * split panes in the main area (a "split" opens a tab), so only an internal split works on every device.
 */

export type SplitOrientation = "row" | "column";

/** Fraction of the view the PDF pane takes, and the limits the divider keeps. */
export const DEFAULT_RATIO = 0.45;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

/** Below this width (CSS px) two panes side by side would be too narrow to write in. */
export const MIN_ROW_WIDTH = 700;

/** Side by side on a wide, landscape view (tablet held sideways, desktop); stacked otherwise (phone, tablet upright). */
export function splitOrientation(width: number, height: number): SplitOrientation {
	return width >= MIN_ROW_WIDTH && width >= height * 1.1 ? "row" : "column";
}

export function clampRatio(r: number): number {
	if (!Number.isFinite(r)) return DEFAULT_RATIO;
	return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

/** New pane fraction when the divider is dragged to `pointer` (CSS px along the split axis) inside a view of `extent` px starting at `origin`. */
export function ratioFromPointer(pointer: number, origin: number, extent: number): number {
	if (!(extent > 0)) return DEFAULT_RATIO;
	return clampRatio((pointer - origin) / extent);
}
