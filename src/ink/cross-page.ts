import type { Command } from "../model/history";
import { createId } from "../model/document";
import { groupedItem, ungroupedItem, type PageItem } from "../model/groups";
import { AddElement, AddStroke, Batch, RemoveElement, ReplaceElement, ReplaceStroke } from "../model/history";
import { freezeElement, freezeStroke } from "../model/serialize";
import type { Asset, Page, PageElement, Stroke } from "../model/types";
import { attachedInk, boundGraphId, inkOwner, pinnedInk, withPinnedInk } from "./attach";
import { captureClip, type ClipContent } from "./clipboard";
import { elementBounds, elementsInLasso, transformElement } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { strokesInLasso, transformStroke, type Polygon } from "./lasso";
import type { PageBox } from "./layout";
import type { MeasureText } from "./text-layout";
import { estimateMeasure } from "./text-layout";
import { multiply, partMatrix, translate, type Matrix } from "./transform";

/**
 * wave 0.10 (359): lasso selection across page boundaries (pure geometry and command planning, no view).
 *
 * Pages are stacked (or, in page mode, set side by side) in document space; every page has its own coordinate frame, an
 * offset of its box. A selection that reaches several pages is described in the frame of one of them, the *primary* page:
 * the lasso polygon, the selection bounds and the dragged matrix are all in that frame, and the items of another page are
 * moved into it by the offset between the two boxes. Strokes and elements stay in the page they are stored in until the
 * move is committed; then every item goes to the page under it (see `planCrossPageTransform`).
 */

/** The items of one page that are part of a selection. */
export interface PagePart {
	pageIndex: number;
	strokes: Stroke[];
	elements: PageElement[];
}

/** What a point of page `to` adds up to in the frame of page `from`: `fromLocal = toLocal + frameOffset(from, to)`. */
export function frameOffset(boxes: readonly PageBox[], from: number, to: number): [number, number] {
	const a = boxes[from];
	const b = boxes[to];
	if (!a || !b) return [0, 0];
	return [b.x - a.x, b.y - a.y];
}

/** The polygon (points in the frame of page `from`) in the frame of page `to`. */
export function polygonInFrame(poly: Polygon, boxes: readonly PageBox[], from: number, to: number): Array<[number, number]> {
	const [ox, oy] = frameOffset(boxes, from, to);
	return poly.map(([x, y]) => [x - ox, y - oy]);
}

/** Indices of the pages whose box meets the bounding box of the polygon (points in the frame of page `origin`). */
export function pagesTouchedBy(boxes: readonly PageBox[], poly: Polygon, origin: number): number[] {
	const o = boxes[origin];
	if (!o || poly.length === 0) return [];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of poly) {
		minX = Math.min(minX, x + o.x);
		maxX = Math.max(maxX, x + o.x);
		minY = Math.min(minY, y + o.y);
		maxY = Math.max(maxY, y + o.y);
	}
	const out: number[] = [];
	boxes.forEach((b, i) => {
		if (b.x <= maxX && b.x + b.width >= minX && b.y <= maxY && b.y + b.height >= minY) out.push(i);
	});
	return out;
}

export interface CrossPageSelectInput {
	boxes: readonly PageBox[];
	/** Page whose frame the polygon is in (the page the lasso started on). */
	origin: number;
	polygon: Polygon;
	/** The ink that can be selected on a page (the caller leaves out hidden ink). */
	strokesOf(pageIndex: number): readonly Stroke[];
	elementsOf(pageIndex: number): readonly PageElement[];
	measure?: MeasureText;
}

/**
 * What a lasso encloses on every page it touches, as one part per page that has anything. The origin page comes first when
 * it has something, the others follow in page order. Empty when nothing is inside.
 */
export function selectAcrossPages(input: CrossPageSelectInput): PagePart[] {
	const measure = input.measure ?? estimateMeasure;
	const parts: PagePart[] = [];
	for (const pageIndex of pagesTouchedBy(input.boxes, input.polygon, input.origin)) {
		const poly = pageIndex === input.origin ? input.polygon : polygonInFrame(input.polygon, input.boxes, input.origin, pageIndex);
		const strokes = strokesInLasso(input.strokesOf(pageIndex), poly);
		const elements = elementsInLasso(input.elementsOf(pageIndex), poly, measure);
		if (strokes.length > 0 || elements.length > 0) parts.push({ pageIndex, strokes, elements });
	}
	parts.sort((a, b) => (a.pageIndex === input.origin ? -1 : b.pageIndex === input.origin ? 1 : a.pageIndex - b.pageIndex));
	return parts;
}

function shift(b: BBox, ox: number, oy: number): BBox {
	return { minX: b.minX + ox, minY: b.minY + oy, maxX: b.maxX + ox, maxY: b.maxY + oy };
}

function union(a: BBox, b: BBox): BBox {
	return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

/** Bounds of all the parts in the frame of page `primary`; null when there is nothing. */
export function partsBounds(boxes: readonly PageBox[], parts: readonly PagePart[], primary: number, measure: MeasureText = estimateMeasure): BBox | null {
	let out: BBox | null = null;
	for (const part of parts) {
		const [ox, oy] = frameOffset(boxes, primary, part.pageIndex);
		for (const s of part.strokes) out = out ? union(out, shift(strokeBounds(s), ox, oy)) : shift(strokeBounds(s), ox, oy);
		for (const e of part.elements) out = out ? union(out, shift(elementBounds(e, measure), ox, oy)) : shift(elementBounds(e, measure), ox, oy);
	}
	return out;
}

/** The transform of the primary frame as seen from another page: its part moves exactly like the rest (ink/transform.ts). */
export { partMatrix };

/** Index of the page whose box contains the document point, or -1. */
export function pageUnder(boxes: readonly PageBox[], x: number, y: number): number {
	return boxes.findIndex((b) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
}

/** A stroke that is not moved on its own but with the object it belongs to. */
export interface InkFollower {
	stroke: Stroke;
	owner: PageElement;
}

/**
 * The ink that goes where an object of `part` goes (pure): the ink bound to a selected graph (always: it is clipped to its
 * graph and meaningless without it), the ink a selected collapsed note keeps hidden (always) and, with `geometric`, the
 * ink written on a selected object (setting "Ink follows objects", ink/attach.ts). A selected stroke that is bound to a selected graph is a follower too, so it cannot be left on
 * another page than its graph; any other selected stroke moves on its own.
 */
export function inkFollowers(page: Page, part: PagePart, geometric: boolean, measure: MeasureText = estimateMeasure): InkFollower[] {
	const elements = page.elements ?? [];
	if (part.elements.length === 0 || elements.length === 0) return [];
	const selected = new Set(part.strokes);
	// 0.17 (H2): the ink a selected collapsed note keeps hidden follows it whatever the setting says (it is not written on the note).
	const pinned = new Set(pinnedInk(page.strokes, part.elements));
	const out: InkFollower[] = [];
	for (const stroke of attachedInk(page.strokes, elements, part.elements, new Set(), measure)) {
		if (boundGraphId(stroke) === null && !pinned.has(stroke) && (!geometric || selected.has(stroke))) continue;
		const owner = inkOwner(stroke, elements, measure);
		if (owner && part.elements.includes(owner)) out.push({ stroke, owner });
	}
	return out;
}

export interface CrossPageTransformInput {
	boxes: readonly PageBox[];
	pages: readonly Page[];
	/** Page whose frame `matrix` is in. */
	primary: number;
	parts: readonly PagePart[];
	matrix: Matrix;
	measure?: MeasureText;
	/** Setting "Ink follows objects": ink written on a moved object goes to the page the object goes to. Bound graph ink always does. */
	followInk?: boolean;
	/** Makes the id of a group that is formed again on another page (tests pass a counter). */
	newGroupId?: () => string;
}

export interface CrossPageTransformPlan {
	/** One undo step. */
	command: Batch;
	/** The moved items, grouped by the page they now belong to (the primary page's part first when it has items). */
	parts: PagePart[];
	/** How many items ended on another page than the one they came from. */
	reparented: number;
}

/**
 * The single undo step that applies `matrix` to a selection spread over several pages. An item whose centre ends inside
 * another page is moved there (removed from the page it was on and added, at the end, to the page under it, in that
 * page's coordinates); one that ends outside every page stays on its own page. Strokes and elements that are no longer on
 * their page are skipped. Null when there is nothing to move.
 *
 * v18: items that leave a group behind do not keep its id (see "a group never stays whole" below): members that arrive together
 * on another page form a new group there, a lone one is released.
 *
 * Order of the commands: in-place replacements, additions (appended, so no index shifts), removals by descending index
 * (so that undo puts everything back where it was).
 */
export function planCrossPageTransform(input: CrossPageTransformInput): CrossPageTransformPlan | null {
	const { boxes, pages, primary, matrix } = input;
	const measure = input.measure ?? estimateMeasure;
	const replace: Command[] = [];
	const add: Command[] = [];
	const removals: Array<{ page: number; index: number; command: Command }> = [];
	const lengthOf = new Map<number, number>();
	const elementLengthOf = new Map<number, number>();
	const regrouped = new Map<number, PagePart>();
	let reparented = 0;
	let count = 0;

	const target = (from: number, bounds: BBox): number => {
		const box = boxes[from]!;
		const t = pageUnder(boxes, box.x + (bounds.minX + bounds.maxX) / 2, box.y + (bounds.minY + bounds.maxY) / 2);
		return t < 0 ? from : t;
	};
	const partFor = (pageIndex: number): PagePart => {
		let p = regrouped.get(pageIndex);
		if (!p) regrouped.set(pageIndex, (p = { pageIndex, strokes: [], elements: [] }));
		return p;
	};

	// First pass: where every item ends up (so the groups can be settled before anything is built).
	interface Prepared {
		part: PagePart;
		page: Page;
		m: Matrix;
		placed: Map<PageElement, { inPlace: PageElement; to: number }>;
		strokes: Array<{ stroke: Stroke; selected: boolean; index: number; inPlace: Stroke; to: number }>;
	}
	const prepared: Prepared[] = [];
	/** v18: per source page and group, how many members leave the page, and how many of them go to the same page. */
	const away = new Map<string, number>();
	const together = new Map<string, number>();
	const tally = (item: PageItem, from: number, to: number): void => {
		if (item.group === undefined || to === from) return;
		const k = `${from}\u0000${item.group}`;
		away.set(k, (away.get(k) ?? 0) + 1);
		together.set(`${k}\u0000${to}`, (together.get(`${k}\u0000${to}`) ?? 0) + 1);
	};
	for (const part of input.parts) {
		const page = pages[part.pageIndex];
		if (!page || !boxes[part.pageIndex]) continue;
		const [ox, oy] = frameOffset(boxes, primary, part.pageIndex);
		const m = partMatrix(matrix, ox, oy);
		// Where each object ends up, so the ink that belongs to it can follow (decided before the strokes are placed).
		const placed = new Map<PageElement, { inPlace: PageElement; to: number }>();
		for (const el of part.elements) {
			if (!page.elements?.includes(el)) continue;
			const inPlace = transformElement(el, m, measure);
			const to = target(part.pageIndex, elementBounds(inPlace, measure));
			placed.set(el, { inPlace, to });
			tally(el, part.pageIndex, to);
		}
		const followers = inkFollowers(page, part, input.followInk === true, measure);
		const followerOwner = new Map<Stroke, PageElement>(followers.map((f) => [f.stroke, f.owner]));
		const own = new Set(part.strokes);
		const strokes: Prepared["strokes"] = [];
		const list = [...part.strokes.map((stroke) => ({ stroke, selected: true })), ...followers.filter((f) => !own.has(f.stroke)).map((f) => ({ stroke: f.stroke, selected: false }))];
		for (const { stroke, selected } of list) {
			const index = page.strokes.indexOf(stroke);
			if (index < 0) continue;
			const inPlace = freezeStroke(transformStroke(stroke, m));
			const owner = followerOwner.get(stroke);
			const to = owner ? (placed.get(owner)?.to ?? part.pageIndex) : target(part.pageIndex, strokeBounds(inPlace));
			strokes.push({ stroke, selected, index, inPlace, to });
			tally(stroke, part.pageIndex, to);
		}
		prepared.push({ part, page, m, placed, strokes });
	}

	/**
	 * v18: a group never stays whole across pages. Members that go to the same other page together (two or more) form a new group
	 * there (a fresh id: ids are scoped to a page); a member that goes alone leaves its group; members left behind keep the group
	 * only while two remain. Items of a group that is not selected whole are treated the same way.
	 */
	const newGroupId = input.newGroupId ?? createId;
	const fresh = new Map<string, string>();
	const sizes = new Map<number, Map<string, number>>();
	const groupSize = (pageIndex: number, group: string): number => {
		let counts = sizes.get(pageIndex);
		if (!counts) {
			counts = new Map();
			for (const item of [...pages[pageIndex]!.strokes, ...(pages[pageIndex]!.elements ?? [])]) {
				if (item.group !== undefined) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
			}
			sizes.set(pageIndex, counts);
		}
		return counts.get(group) ?? 0;
	};
	const arrived = <T extends PageItem>(item: T, from: number, to: number): T => {
		if (item.group === undefined) return item;
		const k = `${from}\u0000${item.group}\u0000${to}`;
		if ((together.get(k) ?? 0) < 2) return ungroupedItem(item);
		let id = fresh.get(k);
		if (id === undefined) fresh.set(k, (id = newGroupId()));
		return groupedItem(item, id);
	};
	const remained = <T extends PageItem>(item: T, from: number): T => {
		if (item.group === undefined) return item;
		const left = groupSize(from, item.group) - (away.get(`${from}\u0000${item.group}`) ?? 0);
		return left < 2 ? ungroupedItem(item) : item;
	};

	for (const { part, page, m, placed, strokes } of prepared) {
		for (const { stroke, selected, index, inPlace, to } of strokes) {
			count++;
			if (to === part.pageIndex) {
				const kept = remained(inPlace, to);
				const final = kept === inPlace ? inPlace : freezeStroke(kept);
				replace.push(new ReplaceStroke(page.id, stroke, [final], index));
				if (selected) partFor(to).strokes.push(final);
				continue;
			}
			const [tx, ty] = frameOffset(boxes, to, part.pageIndex);
			const moved = freezeStroke(arrived(transformStroke(stroke, multiply(translate(tx, ty), m)), part.pageIndex, to));
			const dest = pages[to]!;
			const at = lengthOf.get(to) ?? dest.strokes.length;
			lengthOf.set(to, at + 1);
			add.push(new AddStroke(dest.id, moved, at));
			removals.push({ page: part.pageIndex, index, command: new ReplaceStroke(page.id, stroke, [], index) });
			if (selected) partFor(to).strokes.push(moved);
			reparented++;
		}
		for (const el of part.elements) {
			const done = placed.get(el);
			if (!done) continue;
			count++;
			const { inPlace, to } = done;
			if (to === part.pageIndex) {
				const final = remained(inPlace, to);
				replace.push(new ReplaceElement(page.id, el, final));
				partFor(to).elements.push(final);
				continue;
			}
			const [tx, ty] = frameOffset(boxes, to, part.pageIndex);
			const moved = freezeElement(arrived(transformElement(el, multiply(translate(tx, ty), m), measure), part.pageIndex, to));
			const dest = pages[to]!;
			const at = elementLengthOf.get(to) ?? dest.elements?.length ?? 0;
			elementLengthOf.set(to, at + 1);
			add.push(new AddElement(dest.id, moved, at));
			// Elements are found by identity, so the removal needs no index; it still goes last.
			removals.push({ page: part.pageIndex, index: Number.MAX_SAFE_INTEGER, command: new RemoveElement(page.id, el) });
			partFor(to).elements.push(moved);
			reparented++;
		}
	}
	if (count === 0) return null;
	removals.sort((a, b) => b.index - a.index);
	const parts = [...regrouped.values()].sort((a, b) => (a.pageIndex === primary ? -1 : b.pageIndex === primary ? 1 : a.pageIndex - b.pageIndex));
	return { command: new Batch("Transform selection", [...replace, ...add, ...removals.map((r) => r.command)]), parts, reparented };
}

/**
 * A clip of the whole selection, every item in the frame of page `primary` (so it pastes as one piece), or null when
 * nothing is left on the pages. Images bring their asset records, like a single-page copy.
 */
export function captureCrossPageClip(
	boxes: readonly PageBox[], pages: readonly Page[], parts: readonly PagePart[], primary: number,
	assets: Readonly<Record<string, Asset>> | undefined, measure: MeasureText = estimateMeasure,
): ClipContent | null {
	const strokes: Stroke[] = [];
	const elements: PageElement[] = [];
	for (const part of parts) {
		const page = pages[part.pageIndex];
		if (!page) continue;
		const [ox, oy] = frameOffset(boxes, primary, part.pageIndex);
		const m = translate(ox, oy);
		const here = part.elements.filter((e) => page.elements?.includes(e));
		// 0.17: the ink a collapsed note keeps hidden goes with the note.
		for (const s of withPinnedInk(page.strokes, part.strokes.filter((s) => page.strokes.includes(s)), here)) strokes.push(ox === 0 && oy === 0 ? s : transformStroke(s, m));
		for (const e of here) elements.push(ox === 0 && oy === 0 ? e : transformElement(e, m, measure));
	}
	return captureClip(strokes, elements, assets, measure);
}
