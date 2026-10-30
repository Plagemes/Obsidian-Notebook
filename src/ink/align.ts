import type { PageElement, Stroke } from "../model/types";
import { elementBounds, type MeasureText } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { emptyPlacement, NO_OWNERSHIP, type InkOwnership, type Placement } from "./selection-transform";
import { estimateMeasure } from "./text-layout";
import { translate } from "./transform";

/**
 * Align and distribute the selection (roadmap 38). Pure.
 *
 * "As groups": the selection is not a heap of single strokes. Each element (picture, text box, equation, graph, box,
 * marker) is one item, and the strokes are gathered into items by proximity: strokes whose bounding boxes overlap or lie
 * within `GROUP_GAP` pt of each other are one item (a written word, a drawing), so aligning never tears handwriting
 * apart. Ink written on a selected object belongs to that object's item when "Ink follows objects" is on (`ownership`).
 * An item moves rigidly; its shape never changes.
 */

/** Strokes this close (pt) or overlapping are one group. */
export const GROUP_GAP = 6;

/** Movements smaller than this (pt) are noise from rounding to 0.01 and are not applied (so aligning twice does nothing). */
const EPSILON = 0.02;

export type AlignMode = "left" | "centre" | "right" | "top" | "middle" | "bottom";
export const ALIGN_MODES: readonly AlignMode[] = ["left", "centre", "right", "top", "middle", "bottom"];
export type DistributeAxis = "horizontal" | "vertical";

export interface AlignItem {
	/** Selected strokes of the item. */
	strokes: Stroke[];
	elements: PageElement[];
	/** Unselected ink written on the item's object: moves with it. */
	followers: Stroke[];
	bounds: BBox;
}

const union = (a: BBox, b: BBox): BBox => ({
	minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
});

/** Connected groups of strokes whose boxes, grown by half of `gap` on every side, touch. Order: top-left first. */
export function clusterStrokes(strokes: readonly Stroke[], gap = GROUP_GAP): Stroke[][] {
	const n = strokes.length;
	if (n === 0) return [];
	const boxes = strokes.map(strokeBounds);
	const half = gap / 2;
	const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.minX - boxes[b]!.minX);
	const parent = boxes.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]!]!;
			i = parent[i]!;
		}
		return i;
	};
	// Sweep along x: a box only has to be compared with the earlier boxes that still reach its left edge.
	const active: number[] = [];
	for (const i of order) {
		const bi = boxes[i]!;
		for (let k = active.length - 1; k >= 0; k--) {
			const j = active[k]!;
			const bj = boxes[j]!;
			if (bj.maxX + half < bi.minX - half) {
				active.splice(k, 1);
				continue;
			}
			if (bj.minY - half <= bi.maxY + half && bj.maxY + half >= bi.minY - half) parent[find(i)] = find(j);
		}
		active.push(i);
	}
	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		const g = groups.get(r);
		if (g) g.push(i);
		else groups.set(r, [i]);
	}
	const out = [...groups.values()].map((ids) => ({ ids, box: ids.map((i) => boxes[i]!).reduce(union) }));
	out.sort((a, b) => a.box.minY - b.box.minY || a.box.minX - b.box.minX);
	// Keep the page order of the strokes inside a group.
	return out.map((g) => g.ids.sort((a, b) => a - b).map((i) => strokes[i]!));
}

/** The items of a selection (see the file comment). */
export function alignItems(
	strokes: readonly Stroke[], elements: readonly PageElement[], ownership: InkOwnership = NO_OWNERSHIP,
	measure: MeasureText = estimateMeasure, gap = GROUP_GAP,
): AlignItem[] {
	const byElement = new Map<PageElement, AlignItem>();
	const items: AlignItem[] = [];
	for (const e of elements) {
		const item: AlignItem = { strokes: [], elements: [e], followers: [], bounds: elementBounds(e, measure) };
		byElement.set(e, item);
		items.push(item);
	}
	const free: Stroke[] = [];
	for (const s of strokes) {
		const item = ownership.owner.has(s) ? byElement.get(ownership.owner.get(s)!) : undefined;
		if (item) {
			item.strokes.push(s);
			item.bounds = union(item.bounds, strokeBounds(s));
		} else {
			free.push(s);
		}
	}
	for (const s of ownership.followers) {
		const item = byElement.get(ownership.owner.get(s)!);
		if (!item) continue;
		item.followers.push(s);
		item.bounds = union(item.bounds, strokeBounds(s));
	}
	for (const group of clusterStrokes(free, gap)) {
		items.push({ strokes: group, elements: [], followers: [], bounds: group.map(strokeBounds).reduce(union) });
	}
	return items;
}

function extent(items: readonly AlignItem[]): BBox {
	return items.map((i) => i.bounds).reduce(union);
}

/** The movement of every item that aligns them on `mode` (the edge or centre of the whole selection). */
export function alignDeltas(items: readonly AlignItem[], mode: AlignMode): Array<[number, number]> {
	if (items.length < 2) return items.map(() => [0, 0]);
	const u = extent(items);
	return items.map((it): [number, number] => {
		const b = it.bounds;
		switch (mode) {
			case "left": return [u.minX - b.minX, 0];
			case "centre": return [(u.minX + u.maxX) / 2 - (b.minX + b.maxX) / 2, 0];
			case "right": return [u.maxX - b.maxX, 0];
			case "top": return [0, u.minY - b.minY];
			case "middle": return [0, (u.minY + u.maxY) / 2 - (b.minY + b.maxY) / 2];
			case "bottom": return [0, u.maxY - b.maxY];
		}
	});
}

/**
 * The movement of every item that spaces them so that the gaps between neighbours are equal, between the left (top)
 * edge and the right (bottom) edge of the whole selection. The order is the order of the item centres. Needs three items.
 */
export function distributeDeltas(items: readonly AlignItem[], axis: DistributeAxis): Array<[number, number]> {
	const n = items.length;
	const zero = items.map((): [number, number] => [0, 0]);
	if (n < 3) return zero;
	const horizontal = axis === "horizontal";
	const lo = (b: BBox) => (horizontal ? b.minX : b.minY);
	const hi = (b: BBox) => (horizontal ? b.maxX : b.maxY);
	const u = extent(items);
	const order = items.map((_, i) => i).sort((a, b) => lo(items[a]!.bounds) + hi(items[a]!.bounds) - lo(items[b]!.bounds) - hi(items[b]!.bounds) || a - b);
	const total = items.reduce((sum, it) => sum + hi(it.bounds) - lo(it.bounds), 0);
	const gap = (hi(u) - lo(u) - total) / (n - 1);
	let pos = lo(u);
	for (const i of order) {
		const b = items[i]!.bounds;
		const d = pos - lo(b);
		zero[i] = horizontal ? [d, 0] : [0, d];
		pos += hi(b) - lo(b) + gap;
	}
	return zero;
}

/** The placement that moves every item by its delta; null when nobody moves (already aligned). */
export function placementOf(items: readonly AlignItem[], deltas: ReadonlyArray<readonly [number, number]>): Placement | null {
	const p = emptyPlacement();
	let moved = false;
	items.forEach((it, i) => {
		const [dx, dy] = deltas[i]!;
		if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return;
		moved = true;
		const m = translate(dx, dy);
		for (const s of it.strokes) p.strokes.set(s, m);
		for (const s of it.followers) p.strokes.set(s, m);
		for (const e of it.elements) p.elements.set(e, m);
	});
	return moved ? p : null;
}

export function alignPlacement(items: readonly AlignItem[], mode: AlignMode): Placement | null {
	return items.length < 2 ? null : placementOf(items, alignDeltas(items, mode));
}

export function distributePlacement(items: readonly AlignItem[], axis: DistributeAxis): Placement | null {
	return items.length < 3 ? null : placementOf(items, distributeDeltas(items, axis));
}
