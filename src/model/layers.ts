/**
 * Layer order (roadmap 357). Pure planning of "bring to front / forward / backward / send to back" for the selected
 * strokes and elements of a page; the undoable command is `ReorderLayer` in history.ts. No format change: the order is
 * the order of the page's `strokes` and `elements` arrays, which are saved as they are.
 *
 * What "layer" means here (documented in docs/architecture.md):
 * - Strokes are drawn in array order, so they can be reordered among themselves (e.g. send a highlighter behind the
 *   pen ink, or bring a correction in front of a fill).
 * - Elements are drawn in array order inside their kind, and the kinds have a fixed stacking: images, then boxes,
 *   then text boxes, all under the ink; marker badges above the ink. Reordering therefore works among elements of
 *   the same kind (two overlapping images, two text boxes); an element never jumps across kinds, and ink never goes
 *   under an element.
 * - A selection that holds both reorders each group within its own layer, as one undo step.
 */
import { elementBounds, type MeasureText } from "../ink/elements";
import { strokeBounds, type BBox } from "../ink/hit-test";
import { Batch, ReorderLayer, type Command } from "./history";
import type { Page, PageElement, Stroke } from "./types";

export type LayerMove = "front" | "forward" | "backward" | "back";
export const LAYER_MOVES: readonly LayerMove[] = ["front", "forward", "backward", "back"];

/** Stacking band of an element, as the renderer draws them (ink/renderer.ts drawElements / drawMarkers). Higher is on top. */
export function elementBand(el: PageElement): number {
	switch (el.type) {
		case "image": return 0;
		case "box": return 1;
		case "text": return 2;
		case "marker": return 3;
	}
}

export interface ReorderOptions<T> {
	/** Items of different bands never trade places (default: one band). */
	band?: (item: T) => number;
	/** Forward / backward only step past an item that overlaps (default: any neighbour). */
	overlaps?: (a: T, b: T) => boolean;
}

/** `a` and `b` share some area. */
export function boxesOverlap(a: BBox, b: BBox): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Steps each selected item (top first) past the nearest overlapping unselected item above it, never past a selected item above. */
function stepForward<T>(list: readonly T[], selected: ReadonlySet<T>, overlaps: (a: T, b: T) => boolean): T[] {
	const out = [...list];
	const picked = out.filter((x) => selected.has(x));
	let ceiling: T | null = null;
	for (let k = picked.length - 1; k >= 0; k--) {
		const item = picked[k]!;
		const from = out.indexOf(item);
		const stop = ceiling === null ? out.length : out.indexOf(ceiling);
		let target = -1;
		for (let j = from + 1; j < stop; j++) {
			const other = out[j]!;
			if (!selected.has(other) && overlaps(item, other)) {
				target = j;
				break;
			}
		}
		if (target >= 0) {
			out.splice(from, 1);
			out.splice(target, 0, item);
		}
		ceiling = item;
	}
	return out;
}

/** Mirror of stepForward: each selected item (bottom first) steps below the nearest overlapping unselected item under it. */
function stepBackward<T>(list: readonly T[], selected: ReadonlySet<T>, overlaps: (a: T, b: T) => boolean): T[] {
	const out = [...list];
	const picked = out.filter((x) => selected.has(x));
	let floor: T | null = null;
	for (const item of picked) {
		const from = out.indexOf(item);
		const stop = floor === null ? -1 : out.indexOf(floor);
		let target = -1;
		for (let j = from - 1; j > stop; j--) {
			const other = out[j]!;
			if (!selected.has(other) && overlaps(item, other)) {
				target = j;
				break;
			}
		}
		if (target >= 0) {
			out.splice(from, 1);
			out.splice(target, 0, item);
		}
		floor = item;
	}
	return out;
}

function reorderBand<T>(list: readonly T[], selected: ReadonlySet<T>, move: LayerMove, overlaps: (a: T, b: T) => boolean): T[] {
	if (move === "front") return [...list.filter((x) => !selected.has(x)), ...list.filter((x) => selected.has(x))];
	if (move === "back") return [...list.filter((x) => selected.has(x)), ...list.filter((x) => !selected.has(x))];
	return move === "forward" ? stepForward(list, selected, overlaps) : stepBackward(list, selected, overlaps);
}

/**
 * The new order of `list` after `move` applied to the `selected` items, keeping their relative order; null when nothing
 * would change. Only items of `list` count (a selected item that is not in it is ignored).
 */
export function reorder<T>(list: readonly T[], selected: ReadonlySet<T>, move: LayerMove, opts: ReorderOptions<T> = {}): T[] | null {
	const overlaps = opts.overlaps ?? (() => true);
	let result: T[];
	if (!opts.band) {
		result = reorderBand(list, selected, move, overlaps);
	} else {
		// Each band is reordered on its own and written back into the slots it already occupies.
		const bands = new Map<number, number[]>();
		list.forEach((item, i) => {
			const b = opts.band!(item);
			const slots = bands.get(b);
			if (slots) slots.push(i);
			else bands.set(b, [i]);
		});
		result = [...list];
		for (const slots of bands.values()) {
			const items = slots.map((i) => list[i]!);
			if (!items.some((x) => selected.has(x))) continue;
			const next = reorderBand(items, selected, move, overlaps);
			slots.forEach((slot, k) => {
				result[slot] = next[k]!;
			});
		}
	}
	return result.some((x, i) => x !== list[i]) ? result : null;
}

/** Bounding boxes of the items of one page (the view passes the renderer's cached stroke bounds). */
export interface LayerBounds {
	stroke?: (stroke: Stroke) => BBox;
	element?: (element: PageElement) => BBox;
	measure?: MeasureText;
}

/**
 * One undo step that moves the selected strokes and elements of `page` in the layer order, or null when nothing would
 * change (already at the end, or nothing selected on this page). Forward and backward step past one overlapping
 * neighbour at a time; front and back go to the very end.
 */
export function layerCommand(
	page: Page, selection: { strokes: readonly Stroke[]; elements: readonly PageElement[] }, move: LayerMove, bounds: LayerBounds = {},
): Command | null {
	const commands: Command[] = [];
	const strokeBox = memo(bounds.stroke ?? strokeBounds);
	const strokes = reorder(page.strokes, new Set(selection.strokes), move, {
		overlaps: (a, b) => boxesOverlap(strokeBox(a), strokeBox(b)),
	});
	if (strokes) commands.push(new ReorderLayer(page.id, "strokes", page.strokes, strokes));
	const elements = page.elements ?? [];
	const elementBox = memo(bounds.element ?? ((el: PageElement) => elementBounds(el, bounds.measure)));
	const ordered = reorder(elements, new Set(selection.elements), move, {
		band: elementBand,
		overlaps: (a, b) => boxesOverlap(elementBox(a), elementBox(b)),
	});
	if (ordered) commands.push(new ReorderLayer(page.id, "elements", elements, ordered));
	if (commands.length === 0) return null;
	return commands.length === 1 ? commands[0]! : new Batch("Change layer order", commands);
}

function memo<K extends object, V>(fn: (key: K) => V): (key: K) => V {
	const cache = new WeakMap<K, V>();
	return (key) => {
		let v = cache.get(key);
		if (v === undefined) {
			v = fn(key);
			cache.set(key, v);
		}
		return v;
	};
}
