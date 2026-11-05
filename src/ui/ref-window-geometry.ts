// 0.20 reference window (#107): the geometry of the floating window that shows a reference over the canvas. Pure numbers, no
// DOM and no 'obsidian': the window is kept inside the view (also after a rotation or a resize of the pane), snaps to the
// edges when it is dropped near them, and its place is remembered per device as fractions of the view, so another screen size
// or the other orientation finds it again in a sensible place. The remembered place is a small fixed structure: bounded.

export interface Size {
	width: number;
	height: number;
}

export interface Rect extends Size {
	x: number;
	y: number;
}

/** Space kept free between the window and the edge of the view (CSS px). */
export const EDGE_GAP = 8;
/** Smallest window (CSS px); a smaller view gets a smaller minimum so the window always fits. */
export const MIN_WINDOW: Size = { width: 200, height: 160 };
/** A dropped window within this distance of an edge is pulled onto it (CSS px). */
export const SNAP_DISTANCE = 18;
/** The minimised chip. */
export const CHIP_SIZE: Size = { width: 184, height: 40 };
/** Window opacity range. */
export const MIN_OPACITY = 0.35;
export const MAX_OPACITY = 1;
export const DEFAULT_OPACITY = 0.96;

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The room the window may use in a view. */
export function usable(view: Size): Size {
	return { width: Math.max(1, view.width - 2 * EDGE_GAP), height: Math.max(1, view.height - 2 * EDGE_GAP) };
}

/** The smallest the window may be in this view. */
export function minSize(view: Size): Size {
	const room = usable(view);
	return { width: Math.min(MIN_WINDOW.width, room.width), height: Math.min(MIN_WINDOW.height, room.height) };
}

/** `rect` with its size within the limits of the view and its place fully inside the view (keeping the gap). */
export function clampRect(rect: Rect, view: Size): Rect {
	const room = usable(view);
	const min = minSize(view);
	const width = clamp(finite(rect.width) ? rect.width : min.width, min.width, room.width);
	const height = clamp(finite(rect.height) ? rect.height : min.height, min.height, room.height);
	const x = clamp(finite(rect.x) ? rect.x : EDGE_GAP, EDGE_GAP, EDGE_GAP + room.width - width);
	const y = clamp(finite(rect.y) ? rect.y : EDGE_GAP, EDGE_GAP, EDGE_GAP + room.height - height);
	return { x, y, width, height };
}

/** Where a new window opens: the bottom-right corner, about 40% of the width and 45% of the height. */
export function defaultRect(view: Size): Rect {
	const room = usable(view);
	const width = clamp(Math.round(room.width * 0.4), Math.min(280, room.width), Math.min(420, room.width));
	const height = clamp(Math.round(room.height * 0.45), Math.min(240, room.height), Math.min(560, room.height));
	return clampRect({ x: EDGE_GAP + room.width - width, y: EDGE_GAP + room.height - height, width, height }, view);
}

/** The window dragged by (dx, dy), kept inside the view. */
export function moveRect(rect: Rect, dx: number, dy: number, view: Size): Rect {
	return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, view);
}

/** The window resized from its bottom-right corner by (dx, dy): the top-left corner stays, the size stays within limits. */
export function resizeRect(rect: Rect, dx: number, dy: number, view: Size): Rect {
	const min = minSize(view);
	const room = { width: view.width - EDGE_GAP - rect.x, height: view.height - EDGE_GAP - rect.y };
	const width = Math.max(min.width, Math.min(rect.width + dx, room.width));
	const height = Math.max(min.height, Math.min(rect.height + dy, room.height));
	return clampRect({ ...rect, width, height }, view);
}

/** Each edge within `distance` of the matching edge of the view is pulled onto it (the size is kept). */
export function snapRect(rect: Rect, view: Size, distance: number = SNAP_DISTANCE): Rect {
	const r = clampRect(rect, view);
	const right = view.width - EDGE_GAP - (r.x + r.width);
	const bottom = view.height - EDGE_GAP - (r.y + r.height);
	let { x, y } = r;
	if (Math.abs(r.x - EDGE_GAP) <= distance) x = EDGE_GAP;
	else if (Math.abs(right) <= distance) x = view.width - EDGE_GAP - r.width;
	if (Math.abs(r.y - EDGE_GAP) <= distance) y = EDGE_GAP;
	else if (Math.abs(bottom) <= distance) y = view.height - EDGE_GAP - r.height;
	return clampRect({ ...r, x, y }, view);
}

/** The chip that stands for a minimised window: at the window's corner, inside the view. */
export function chipRect(rect: Rect, view: Size): Rect {
	const w = Math.min(CHIP_SIZE.width, usable(view).width);
	const h = Math.min(CHIP_SIZE.height, usable(view).height);
	return clampRect({ x: rect.x, y: rect.y, width: w, height: h }, view);
}

/** The chip dragged is not supported; this keeps the restored window where the chip is (the corner it came from). */
export function restoredRect(rect: Rect, chip: Rect, view: Size): Rect {
	return clampRect({ ...rect, x: chip.x, y: chip.y }, view);
}

// ---------------------------------------------------------------------------------------------------- remembered place

export type Orientation = "landscape" | "portrait";

export function orientationOf(view: Size): Orientation {
	return view.width >= view.height ? "landscape" : "portrait";
}

/** A window place as fractions of the view, so it follows a change of the view's size. */
export interface Placement {
	fx: number;
	fy: number;
	fw: number;
	fh: number;
	minimised: boolean;
}

/** What is kept on the device: one place per orientation, and the opacity. A fixed shape, so it cannot grow. */
export interface WindowMemory {
	landscape: Placement | null;
	portrait: Placement | null;
	opacity: number;
}

export const EMPTY_MEMORY: WindowMemory = { landscape: null, portrait: null, opacity: DEFAULT_OPACITY };

export function clampOpacity(value: unknown): number {
	return finite(value) ? clamp(value, MIN_OPACITY, MAX_OPACITY) : DEFAULT_OPACITY;
}

export function toPlacement(rect: Rect, view: Size, minimised: boolean): Placement {
	const w = Math.max(1, view.width);
	const h = Math.max(1, view.height);
	return { fx: rect.x / w, fy: rect.y / h, fw: rect.width / w, fh: rect.height / h, minimised };
}

/** The window of a remembered place in this view (fitted into it). */
export function fromPlacement(p: Placement, view: Size): Rect {
	return clampRect({ x: p.fx * view.width, y: p.fy * view.height, width: p.fw * view.width, height: p.fh * view.height }, view);
}

function normalisePlacement(data: unknown): Placement | null {
	if (typeof data !== "object" || data === null) return null;
	const o = data as Record<string, unknown>;
	if (![o.fx, o.fy, o.fw, o.fh].every(finite)) return null;
	const fx = o.fx as number, fy = o.fy as number, fw = o.fw as number, fh = o.fh as number;
	if (fw <= 0 || fh <= 0 || fw > 1 || fh > 1 || fx < -1 || fy < -1 || fx > 2 || fy > 2) return null;
	return { fx, fy, fw, fh, minimised: o.minimised === true };
}

/** Whatever was stored, as a valid memory: unusable parts are dropped (corrupt storage means "nothing remembered"). */
export function normaliseMemory(data: unknown): WindowMemory {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return EMPTY_MEMORY;
	const o = data as Record<string, unknown>;
	return { landscape: normalisePlacement(o.landscape), portrait: normalisePlacement(o.portrait), opacity: clampOpacity(o.opacity) };
}

/** The memory after the window was left at `rect` in a view of this size. */
export function remember(memory: WindowMemory, rect: Rect, view: Size, minimised: boolean): WindowMemory {
	const key = orientationOf(view);
	return { ...memory, [key]: toPlacement(rect, view, minimised) };
}

/** The place for this view: the one of its orientation, else the other orientation's fractions, else null. */
export function placementFor(memory: WindowMemory, view: Size): Placement | null {
	const key = orientationOf(view);
	return memory[key] ?? memory[key === "landscape" ? "portrait" : "landscape"];
}

/** Where the window opens in this view: the remembered place, or the default. */
export function initialRect(memory: WindowMemory, view: Size): Rect {
	const p = placementFor(memory, view);
	return p ? fromPlacement(p, view) : defaultRect(view);
}
