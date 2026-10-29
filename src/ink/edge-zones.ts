/**
 * Edge rejection zones: a touch that starts this close to an edge of the drawing area is ignored
 * (neither draws nor pans), so a palm resting on the screen edge does nothing. Pure logic.
 */
export interface EdgeZones {
	enabled: boolean;
	/** Width of the zone in CSS px. */
	widthPx: number;
	left: boolean;
	right: boolean;
	top: boolean;
	bottom: boolean;
}

export const EDGE_WIDTH_MIN = 4;
export const EDGE_WIDTH_MAX = 80;

/** The zone never takes more than this share of the shortest side, so the middle always stays usable. */
const MAX_SHARE = 1 / 3;

/** Effective zone width (CSS px) for an area of `width` × `height`. */
export function effectiveEdgeWidth(zones: Pick<EdgeZones, "widthPx">, width: number, height: number): number {
	const w = Number.isFinite(zones.widthPx) ? Math.max(0, zones.widthPx) : 0;
	return Math.min(w, Math.max(0, Math.min(width, height)) * MAX_SHARE);
}

/**
 * Is the point (x, y), in CSS px relative to the top-left of a `width` × `height` area, inside an
 * enabled edge zone?
 */
export function inEdgeZone(zones: EdgeZones | undefined, x: number, y: number, width: number, height: number): boolean {
	if (!zones || !zones.enabled || !(width > 0) || !(height > 0)) return false;
	const m = effectiveEdgeWidth(zones, width, height);
	if (m <= 0) return false;
	return (zones.left && x < m) || (zones.right && x > width - m) || (zones.top && y < m) || (zones.bottom && y > height - m);
}
