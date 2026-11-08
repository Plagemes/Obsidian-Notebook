/**
 * Sizes that floating pieces of the page area publish to each other (0.22 review fix). The contextual bar is centred at the bottom and
 * can be as wide as the screen; a minimap parked at the bottom left takes that corner. The pills that live there (minimap, colour
 * filter, lecture header) read these two custom properties of `.notebook-body` in styles.css instead of guessing sizes:
 *   --nb-ctx-lift  height of the contextual bar plus its gap (0 when it is hidden), the bottom offset the others add;
 *   --nb-map-bl    width of a minimap parked at the bottom left plus a gap (0 otherwise), the left offset the others add.
 */
export const CTX_LIFT_VAR = "--nb-ctx-lift";
export const MAP_BL_VAR = "--nb-map-bl";

/** Gap kept between the bar and what sits above it, px. The bar itself stands 14px from the bottom. */
export const CTX_LIFT_GAP = 14 + 8;
/** Gap between a parked minimap and the pieces to its right, px. */
export const MAP_BL_GAP = 8;

/** The lift for a bar of this height; 0 for a bar that is not shown. */
export function contextLift(barHeight: number): number {
	return barHeight > 0 ? Math.ceil(barHeight) + CTX_LIFT_GAP : 0;
}

/** The left offset for a minimap of this width parked at `corner`; 0 when it is hidden or elsewhere. */
export function mapOffset(corner: string, shown: boolean, width: number): number {
	return shown && corner === "bl" && width > 0 ? Math.ceil(width) + MAP_BL_GAP : 0;
}

/** Calls `fn` now and whenever the box of `el` changes (ResizeObserver where there is one). Returns the stop function. */
export function watchBox(el: HTMLElement, fn: () => void): () => void {
	fn();
	if (typeof ResizeObserver === "undefined") return () => undefined;
	const ro = new ResizeObserver(() => fn());
	ro.observe(el);
	return () => ro.disconnect();
}

/** Sets (or, with 0, clears) one of the variables on the page area. */
export function publish(parent: HTMLElement | null, name: string, px: number): void {
	if (!parent) return;
	if (px > 0) parent.setCssProps({ [name]: `${px}px` });
	else parent.style.removeProperty(name);
}
