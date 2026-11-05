/**
 * Visual version diff (0.20, roadmap #121): which pages, strokes and elements differ between two versions of a notebook.
 * Pure, no Obsidian imports, nothing is ever written. Pages are matched by page id, strokes and elements by their ids; a
 * stroke or element present on both sides is compared by geometry and style ("moved" when only its place changed). Drawing
 * of the result is in ink/diff-render.ts, the dialog in view/version-diff-dialog.ts.
 *
 * Work is capped: `maxItems` bounds the strokes and elements compared in one diff, so a very large notebook gives an answer
 * quickly; the pages beyond the cap are reported as "unchecked" (never as unchanged) and the diff says it was truncated.
 */
import type { NotebookDocument, Page, PageElement, Stroke } from "./types";

/** Strokes and elements (of both sides) compared in one diff before the remaining pages are left unchecked. */
export const DIFF_MAX_ITEMS = 120_000;

export type ItemChange = "added" | "removed" | "changed" | "moved";
export type ItemKind = "stroke" | "element";

export interface ItemDiff {
	kind: ItemKind;
	id: string;
	change: ItemChange;
}

export type PageStatus = "added" | "removed" | "modified" | "unchanged" | "unchecked";

/** Properties of a page, other than its ink and elements, that can differ. */
export const PAGE_PROPS = ["size", "paper", "background", "margins", "infinite", "tags", "states", "comments", "locked"] as const;
export type PageProp = (typeof PAGE_PROPS)[number];

export interface ChangeCounts {
	added: number;
	removed: number;
	changed: number;
	moved: number;
}

export interface PageDiff {
	/** The page id (the same on both sides when the page is on both). */
	id: string;
	status: PageStatus;
	/** Index in the earlier version, -1 when the page is only in the later one. */
	beforeIndex: number;
	/** Index in the later version, -1 when the page is only in the earlier one. */
	afterIndex: number;
	/** The page is on both sides but not at the same place among the pages that are. */
	reordered: boolean;
	/** Ink and element differences (empty for an added, removed or unchecked page: the whole page is the difference). */
	items: ItemDiff[];
	/** Counts of strokes and elements together; for an added or removed page, everything on it. */
	counts: ChangeCounts;
	/** Other things that differ (paper, margins, comments, …). */
	props: PageProp[];
}

export interface DiffSummary {
	pagesAdded: number;
	pagesRemoved: number;
	pagesModified: number;
	pagesUnchanged: number;
	pagesUnchecked: number;
	pagesReordered: number;
	counts: ChangeCounts;
}

export interface DocDiff {
	/** In reading order of the later version, a removed page just after the page that preceded it. */
	pages: PageDiff[];
	summary: DiffSummary;
	/** Some pages were left unchecked because the notebook is larger than the cap. */
	truncated: boolean;
}

export interface DiffOptions {
	maxItems?: number;
}

const EPS = 1e-6;
const MOVE_EPS = 0.01;

const emptyCounts = (): ChangeCounts => ({ added: 0, removed: 0, changed: 0, moved: 0 });

/** Deep equality of plain JSON-like values (key order does not matter); `skip` names top-level keys to leave out. */
export function sameValue(a: unknown, b: unknown, skip?: ReadonlySet<string>): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
		return true;
	}
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	const ka = Object.keys(ra).filter((k) => ra[k] !== undefined && !skip?.has(k));
	const kb = Object.keys(rb).filter((k) => rb[k] !== undefined && !skip?.has(k));
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (!Object.prototype.hasOwnProperty.call(rb, k) || !sameValue(ra[k], rb[k])) return false;
	}
	return true;
}

/** How a stroke on both sides differs: "same", "moved" (the same ink, shifted as a whole) or "changed" (shape or style). */
export function compareStroke(a: Stroke, b: Stroke): "same" | "moved" | "changed" {
	if (a.tool !== b.tool || a.color !== b.color || a.width !== b.width || a.render !== b.render || !!a.hidden !== !!b.hidden || a.slide !== b.slide) return "changed";
	const pa = a.points;
	const pb = b.points;
	if (pa.length !== pb.length) return "changed";
	if (pa.length === 0) return "same";
	let same = true;
	for (let i = 0; i < pa.length; i++) {
		const p = pa[i]!;
		const q = pb[i]!;
		if (Math.abs(p[0] - q[0]) > EPS || Math.abs(p[1] - q[1]) > EPS || Math.abs(p[2] - q[2]) > EPS) {
			same = false;
			break;
		}
	}
	if (same) return "same";
	const dx = pb[0]![0] - pa[0]![0];
	const dy = pb[0]![1] - pa[0]![1];
	for (let i = 0; i < pa.length; i++) {
		const p = pa[i]!;
		const q = pb[i]!;
		if (Math.abs(q[0] - p[0] - dx) > MOVE_EPS || Math.abs(q[1] - p[1] - dy) > MOVE_EPS || Math.abs(p[2] - q[2]) > EPS) return "changed";
	}
	return "moved";
}

/** Derived data an element carries that does not count as a change (a cached outline). */
const ELEMENT_CACHE = new Set(["outline"]);
const ELEMENT_PLACE = new Set(["outline", "x", "y"]);

/** How an element on both sides differs: "same", "moved" (only x and y differ) or "changed". */
export function compareElement(a: PageElement, b: PageElement): "same" | "moved" | "changed" {
	if (a.type !== b.type) return "changed";
	if (sameValue(a, b, ELEMENT_CACHE)) return "same";
	return sameValue(a, b, ELEMENT_PLACE) ? "moved" : "changed";
}

/** The properties of two pages that differ. */
export function differingProps(a: Page, b: Page): PageProp[] {
	const out: PageProp[] = [];
	if (a.width !== b.width || a.height !== b.height) out.push("size");
	if (!sameValue(a.paper, b.paper)) out.push("paper");
	if (!sameValue(a.background, b.background)) out.push("background");
	if (!sameValue(a.margins, b.margins)) out.push("margins");
	if (!!a.infinite !== !!b.infinite) out.push("infinite");
	if (!sameValue(a.tags ?? [], b.tags ?? [])) out.push("tags");
	if (!sameValue(a.states, b.states)) out.push("states");
	if (!sameValue(a.comments ?? [], b.comments ?? [])) out.push("comments");
	if (!!a.locked !== !!b.locked) out.push("locked");
	return out;
}

function pageCost(p: Page): number {
	return p.strokes.length + (p.elements?.length ?? 0);
}

function bump(c: ChangeCounts, change: ItemChange): void {
	c[change]++;
}

/** Differences in the ink and elements of one page present on both sides. */
export function diffPageContent(before: Page, after: Page): { items: ItemDiff[]; counts: ChangeCounts } {
	const items: ItemDiff[] = [];
	const counts = emptyCounts();
	const push = (kind: ItemKind, id: string, change: ItemChange) => {
		items.push({ kind, id, change });
		bump(counts, change);
	};
	const strokesBefore = new Map<string, Stroke>();
	for (const s of before.strokes) strokesBefore.set(s.id, s);
	const seen = new Set<string>();
	for (const s of after.strokes) {
		const old = strokesBefore.get(s.id);
		if (!old || seen.has(s.id)) {
			if (!old) push("stroke", s.id, "added");
			continue;
		}
		seen.add(s.id);
		const r = compareStroke(old, s);
		if (r !== "same") push("stroke", s.id, r);
	}
	const strokesAfter = new Set<string>();
	for (const s of after.strokes) strokesAfter.add(s.id);
	for (const s of before.strokes) if (!strokesAfter.has(s.id)) push("stroke", s.id, "removed");
	const elementsBefore = new Map<string, PageElement>();
	for (const e of before.elements ?? []) elementsBefore.set(e.id, e);
	const seenEl = new Set<string>();
	for (const e of after.elements ?? []) {
		const old = elementsBefore.get(e.id);
		if (!old) {
			push("element", e.id, "added");
			continue;
		}
		seenEl.add(e.id);
		const r = compareElement(old, e);
		if (r !== "same") push("element", e.id, r);
	}
	for (const e of before.elements ?? []) if (!seenEl.has(e.id)) push("element", e.id, "removed");
	return { items, counts };
}

/** Indexes (into `seq`) of one longest increasing subsequence; those pages keep their place, the others moved. */
export function longestIncreasing(seq: readonly number[]): Set<number> {
	const tails: number[] = [];
	const prev: number[] = new Array<number>(seq.length).fill(-1);
	for (let i = 0; i < seq.length; i++) {
		const v = seq[i]!;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (seq[tails[mid]!]! < v) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1]!;
		tails[lo] = i;
	}
	const keep = new Set<number>();
	let k = tails.length > 0 ? tails[tails.length - 1]! : -1;
	while (k >= 0) {
		keep.add(k);
		k = prev[k]!;
	}
	return keep;
}

/** Diffs two versions of a notebook: `before` is the earlier (or the one compared against), `after` the later. */
export function diffDocuments(before: NotebookDocument, after: NotebookDocument, options: DiffOptions = {}): DocDiff {
	const cap = Math.max(0, options.maxItems ?? DIFF_MAX_ITEMS);
	const beforeById = new Map<string, number>();
	before.pages.forEach((p, i) => {
		if (!beforeById.has(p.id)) beforeById.set(p.id, i);
	});
	const matched = new Set<string>();
	const pages: PageDiff[] = [];
	const commonOrder: number[] = []; // before index of each matched page, in the later version's order
	const commonAt: number[] = []; // position in `pages` of each of them
	let budget = cap;
	let truncated = false;
	after.pages.forEach((page, afterIndex) => {
		const bi = beforeById.get(page.id);
		if (bi === undefined || matched.has(page.id)) {
			const counts = emptyCounts();
			counts.added = pageCost(page);
			pages.push({ id: page.id, status: "added", beforeIndex: -1, afterIndex, reordered: false, items: [], counts, props: [] });
			return;
		}
		matched.add(page.id);
		const old = before.pages[bi]!;
		commonOrder.push(bi);
		commonAt.push(pages.length);
		const cost = pageCost(old) + pageCost(page);
		if (cost > budget) {
			truncated = true;
			pages.push({ id: page.id, status: "unchecked", beforeIndex: bi, afterIndex, reordered: false, items: [], counts: emptyCounts(), props: [] });
			return;
		}
		budget -= cost;
		const { items, counts } = diffPageContent(old, page);
		const props = differingProps(old, page);
		const status: PageStatus = items.length > 0 || props.length > 0 ? "modified" : "unchanged";
		pages.push({ id: page.id, status, beforeIndex: bi, afterIndex, reordered: false, items, counts, props });
	});
	const keep = longestIncreasing(commonOrder);
	commonAt.forEach((at, k) => {
		if (!keep.has(k)) pages[at]!.reordered = true;
	});
	// Pages only in the earlier version, each just after the page that preceded it there (or first).
	const removedAfter = new Map<string, PageDiff[]>(); // anchor page id ("" = start) -> removed pages in order
	let anchor = "";
	for (let i = 0; i < before.pages.length; i++) {
		const p = before.pages[i]!;
		if (beforeById.get(p.id) === i && matched.has(p.id)) {
			anchor = p.id;
			continue;
		}
		if (beforeById.get(p.id) !== i) continue; // a duplicate id on the earlier side: only its first copy counts
		const counts = emptyCounts();
		counts.removed = pageCost(p);
		const list = removedAfter.get(anchor) ?? [];
		list.push({ id: p.id, status: "removed", beforeIndex: i, afterIndex: -1, reordered: false, items: [], counts, props: [] });
		removedAfter.set(anchor, list);
	}
	const ordered: PageDiff[] = [...(removedAfter.get("") ?? [])];
	for (const pd of pages) {
		ordered.push(pd);
		if (pd.status !== "added") ordered.push(...(removedAfter.get(pd.id) ?? []));
	}
	// A matched page that was not emitted because its anchor chain broke cannot happen: anchors are matched pages only.
	const summary: DiffSummary = {
		pagesAdded: 0, pagesRemoved: 0, pagesModified: 0, pagesUnchanged: 0, pagesUnchecked: 0, pagesReordered: 0, counts: emptyCounts(),
	};
	for (const pd of ordered) {
		if (pd.status === "added") summary.pagesAdded++;
		else if (pd.status === "removed") summary.pagesRemoved++;
		else if (pd.status === "modified") summary.pagesModified++;
		else if (pd.status === "unchecked") summary.pagesUnchecked++;
		else summary.pagesUnchanged++;
		if (pd.reordered) summary.pagesReordered++;
		summary.counts.added += pd.counts.added;
		summary.counts.removed += pd.counts.removed;
		summary.counts.changed += pd.counts.changed;
		summary.counts.moved += pd.counts.moved;
	}
	return { pages: ordered, summary, truncated };
}

/** Whether the page differs at all between the two versions (content, properties, position, or not compared). */
export function isChangedPage(pd: PageDiff): boolean {
	return pd.status !== "unchanged" || pd.reordered;
}

/** Number of pages that differ (the "N changed" count of the page list). */
export function changedPageCount(diff: DocDiff): number {
	let n = 0;
	for (const pd of diff.pages) if (isChangedPage(pd)) n++;
	return n;
}

/** Total strokes and elements that differ on one page, all kinds of change together. */
export function totalChanges(c: ChangeCounts): number {
	return c.added + c.removed + c.changed + c.moved;
}
