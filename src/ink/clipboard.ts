import { createId } from "../model/document";
import { AddAsset, AddElement, AddStroke, Batch, type Command } from "../model/history";
import { elementAssetId, withElementAsset } from "../model/excerpts";
import { copyStroke as copyStrokeWithId } from "../model/pages";
import { freezeElement, freezeStroke } from "../model/serialize";
import type { Asset, Page, PageElement, Stroke } from "../model/types";
import { boundGraphId, BOUND_SEPARATOR } from "./attach";
import { elementBounds, transformElement } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { transformStroke } from "./lasso";
import { estimateMeasure, type MeasureText } from "./text-layout";
import { multiply, scaleAbout, translate } from "./transform";

/**
 * Copy, cut, paste and duplicate of a lasso selection (pure). A clip is a deep copy of strokes and elements
 * in page coordinates plus the asset records its images need; pasting gives every item a new id, so the same
 * clip can be pasted any number of times, on any page of any notebook.
 */

export interface ClipContent {
	strokes: Stroke[];
	elements: PageElement[];
	/** Records of the assets the image elements use (the bytes are kept by the caller). */
	assets: Asset[];
	/** Box around everything, page coordinates of the page it was copied from. */
	bounds: BBox;
}

/** Distance (pt) between a pasted or duplicated copy and the one before it. */
export const PASTE_STEP = 12;

/** v8: model/pages copyStroke keeps every stroke field (hidden ink stays hidden when pasted). */
const copyStroke = (s: Stroke): Stroke => copyStrokeWithId(s);

/** Deep copy of a selection. Null when it is empty. Image elements bring their asset records from `assets`. */
export function captureClip(
	strokes: readonly Stroke[], elements: readonly PageElement[], assets: Readonly<Record<string, Asset>> | undefined,
	measure: MeasureText = estimateMeasure,
): ClipContent | null {
	if (strokes.length === 0 && elements.length === 0) return null;
	const used = new Map<string, Asset>();
	for (const el of elements) {
		// Images and (v10) excerpt snapshots bring their asset records.
		const id = elementAssetId(el);
		const a = id !== null ? assets?.[id] : undefined;
		if (a) used.set(a.id, { ...a });
	}
	const boxes: BBox[] = [
		...strokes.map(strokeBounds),
		...elements.map((e) => elementBounds(e, measure)),
	];
	const bounds = boxes.reduce((a, b) => ({
		minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
	}));
	return {
		strokes: strokes.map(copyStroke),
		elements: elements.map((e) => ({ ...e })),
		assets: [...used.values()],
		bounds,
	};
}

/** Ids of the assets a clip still has to bring to a document: all of its images' assets (the caller checks the file). */
export function clipAssetIds(clip: ClipContent): string[] {
	const ids = new Set<string>();
	for (const e of clip.elements) {
		const id = elementAssetId(e);
		if (id !== null) ids.add(id);
	}
	return [...ids];
}

/**
 * Fresh strokes and elements (new ids, frozen) scaled by `scale` about the top-left corner of the clip's box (1: not
 * scaled) and then moved by (dx, dy). `assetMap` renames the asset an image uses (when storing its bytes in another
 * vault location gave it another id); an image whose asset is not in the map keeps its id. Ink bound to a graph of the
 * clip (`<graph id>~…`, ink/attach.ts) is bound to the copy of that graph, so it stays clipped to it and follows it.
 */
export function instantiateClip(
	clip: ClipContent, dx: number, dy: number, assetMap?: ReadonlyMap<string, string>, measure: MeasureText = estimateMeasure,
	scale = 1,
): { strokes: Stroke[]; elements: PageElement[] } {
	const m = scale === 1 ? translate(dx, dy) : multiply(translate(dx, dy), scaleAbout(scale, scale, clip.bounds.minX, clip.bounds.minY));
	const newIds = new Map<string, string>();
	const elements = clip.elements.map((e) => {
		const moved = transformElement(e, m, measure);
		// Images and (v10) excerpt snapshots stored again under another id are renamed.
		const old = elementAssetId(moved);
		const base = old !== null ? withElementAsset(moved, assetMap?.get(old) ?? old) : moved;
		const id = createId();
		if (e.type === "graph") newIds.set(e.id, id);
		return freezeElement({ ...base, id });
	});
	const strokes = clip.strokes.map((s) => {
		const graph = boundGraphId(s);
		const owner = graph === null ? undefined : newIds.get(graph);
		return freezeStroke({ ...transformStroke(s, m), id: owner === undefined ? createId() : `${owner}${BOUND_SEPARATOR}${createId()}` });
	});
	return { strokes, elements };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** A clip is not scaled down below this factor to fit a page (the same floor as dragging a scale handle): it would be a speck. */
export const MIN_PASTE_SCALE = 0.05;

/**
 * Factor (at most 1) that makes a clip fit the page it is pasted on, uniformly: 1 when it already fits. An infinite
 * page only limits the width (it grows downwards). A clip taller than a sheet but not wider than it is scaled too: a
 * paste that lands mostly outside the page would be invisible, unselectable and left out of the exports.
 */
export function pasteScale(bounds: BBox, page: { width: number; height: number; infinite?: boolean }): number {
	const w = bounds.maxX - bounds.minX;
	const h = bounds.maxY - bounds.minY;
	let k = 1;
	if (w > page.width && w > 0) k = Math.min(k, page.width / w);
	if (!page.infinite && h > page.height && h > 0) k = Math.min(k, page.height / h);
	// Round down so the scaled box does not poke out of the page by a rounding error.
	return k < 1 ? Math.floor(k * 10000) / 10000 : 1;
}

/**
 * Offset that puts the clip's centre on `centre` (+ `nudge` steps of PASTE_STEP, so repeated pastes do not
 * hide each other), kept inside the page when the clip fits in it. `scale`: the factor the clip is pasted with
 * (`pasteScale`, `instantiateClip` scales about the top-left corner of the box).
 */
export function pasteOffset(
	bounds: BBox, page: { width: number; height: number }, centre: readonly [number, number], nudge = 0, scale = 1,
): [number, number] {
	const w = (bounds.maxX - bounds.minX) * scale;
	const h = (bounds.maxY - bounds.minY) * scale;
	const x = placeAxis(centre[0] - w / 2 + nudge * PASTE_STEP, w, page.width);
	const y = placeAxis(centre[1] - h / 2 + nudge * PASTE_STEP, h, page.height);
	return [round2(x - bounds.minX), round2(y - bounds.minY)];
}

/** Start of a box of `extent` wanted at `want`, inside [0, limit] when it fits, else at 0. */
function placeAxis(want: number, extent: number, limit: number): number {
	if (extent >= limit) return 0;
	return Math.min(limit - extent, Math.max(0, want));
}

/** Offset of a duplicate: down-right by PASTE_STEP, or up-left when that would leave the page. */
export function duplicateOffset(bounds: BBox, page: { width: number; height: number }): [number, number] {
	const dx = bounds.maxX + PASTE_STEP <= page.width ? PASTE_STEP : bounds.minX - PASTE_STEP >= 0 ? -PASTE_STEP : 0;
	const dy = bounds.maxY + PASTE_STEP <= page.height ? PASTE_STEP : bounds.minY - PASTE_STEP >= 0 ? -PASTE_STEP : 0;
	return [dx, dy];
}

/**
 * The single undo step that adds pasted strokes and elements to `page` (on top of what is there) and registers
 * the assets the document does not know yet.
 */
export function pasteCommand(
	page: Page, strokes: readonly Stroke[], elements: readonly PageElement[], newAssets: readonly Asset[], label = "Paste",
): Batch {
	const commands: Command[] = newAssets.map((a) => new AddAsset(a));
	strokes.forEach((s, i) => commands.push(new AddStroke(page.id, s, page.strokes.length + i)));
	const base = page.elements?.length ?? 0;
	elements.forEach((e, i) => commands.push(new AddElement(page.id, e, base + i)));
	return new Batch(label, commands);
}
