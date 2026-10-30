/**
 * Merge of a conflicted copy into the main notebook (roadmap #122). Pure, no Obsidian imports.
 *
 * Rules (nothing disappears):
 * - union of pages, strokes, elements and assets by id;
 * - the same id with different content on the two sides: the main notebook keeps its version and
 *   the other one is added as a copy with a new id (unless that page already has identical content,
 *   which makes the merge idempotent);
 * - deletions are not inferred: an item missing on one side is never removed from the other;
 * - page settings (size, paper, background, infinite, margins) and the cover colour of the main notebook
 *   are kept; differences are counted in the summary. Tags and bookmarks are united, favourite is "either";
 * - v7: page tags of a common page are united (main first); bookmark details (title, colour, category) are
 *   merged field by field: the main notebook's value of each field wins, fields it lacks are filled in from
 *   the copy, and fields set to a different value on the two sides are counted in the summary; the reading
 *   position of the main notebook is kept (it is not content, and the next save writes the current one);
 * - v8: hidden (invisible) ink is part of a stroke's content; markers and boxes are elements like the others, except
 *   that a marker's resolved state is not content: the same marker resolved on one side only is resolved in the
 *   result (counted in `markersResolved`), never added twice;
 * - v6 margins: a left margin shifts the whole page content by its width, so when a common page has a
 *   different left margin in the copy, the copy's strokes and elements are first moved into the main
 *   page's frame (by the difference of the left margins). Ink that is the same relative to the
 *   background is then recognised as the same, and new ink lands where it was drawn on the background.
 *   When new ink of the copy would then fall off the main page (left of it because the copy has a
 *   wider left margin, or beyond its right or bottom edge, also with equal margins), the main page grows
 *   just enough in the same step so it stays visible: wider margins on a page with a background
 *   (`SetPageMargins`: its own ink moves with the background), a larger plain page, or more height on an
 *   infinite page (`SetPageSize`, which follows the margin rule).
 *
 * Both documents must come from `parse()`, so whatever version the copy was written in, it has gone
 * through the regular migrations first. The result is one `Batch` (one undo step) for the main
 * notebook's history; it is planned against the current state of `main` and must be applied to it.
 */
import { cloneMeta, createId } from "./document";
import { growForInfinite } from "../ink/infinite";
import { textElementBounds } from "../ink/text-layout";
import { AddAsset, AddElement, AddPage, AddStroke, Batch, SetMeta, SetPageMargins, SetPageSize, type Command } from "./history";
import { SetMarkerDone } from "./marker-commands";
import { boxBounds, markerBounds } from "./markers";
import { stableStringify } from "./math-elements";
import { marginsEqual, marginsOf, normalizeMargins, translateElement, translateStroke } from "./margins";
import { normalizeBookmarkInfo } from "./bookmarks";
import { SetPageTags, unionPageTags } from "./page-tags";
import { copyStroke as copyStrokeWithId } from "./pages";
import { freezeElement } from "./serialize";
import { DEFAULT_META, type BookmarkInfo, type MarkerElement, type NotebookDocument, type NotebookMeta, type Page, type PageElement, type PageMargins, type Stroke } from "./types";

export interface MergeSummary {
	/** Pages only in the copy, added. */
	pagesAdded: number;
	/** Strokes only in the copy, added. */
	strokesAdded: number;
	/** Strokes with the same id but different content: the copy's version added with a new id. */
	strokesCopied: number;
	elementsAdded: number;
	elementsCopied: number;
	assetsAdded: number;
	tagsAdded: number;
	bookmarksAdded: number;
	/** v7: bookmark detail fields (title, colour, category) taken from the copy because the main notebook had none set. */
	bookmarkInfoAdded: number;
	/** v7: bookmark detail fields set to a different value in the copy: the main notebook's value is kept. */
	bookmarkInfoDiffer: number;
	/** v7: page tags of the copy added to common pages (tags of pages only in the copy come with the page). */
	pageTagsAdded: number;
	/** Strokes and elements present on both sides with identical content (nothing to do). */
	identical: number;
	/** Common pages whose settings differ: the main notebook's settings are kept. */
	pageSettingsDiffer: number;
	/**
	 * Common pages whose margins differ (also counted in `pageSettingsDiffer`): the main margins are
	 * kept and the copy's content was moved into them before comparing and adding.
	 */
	marginsDiffer: number;
	/** Common pages enlarged (wider margins, or a larger or taller page) so that ink of the copy stays on the page. */
	pagesEnlarged: number;
	/** Items of the main notebook missing from the copy (kept: deletions are not inferred). */
	onlyInMain: number;
	/** v8: markers resolved in the copy only, resolved in the main notebook too ("either", like favourite). */
	markersResolved: number;
}

export interface MergePlan {
	summary: MergeSummary;
	/** Null when there is nothing to add. */
	command: Command | null;
}

export function strokeContentKey(s: Stroke): string {
	// v8: hidden ink differs from the same ink shown.
	return s.hidden ? JSON.stringify([s.tool, s.color, s.width, s.render, s.points, true]) : JSON.stringify([s.tool, s.color, s.width, s.render, s.points]);
}

export function elementContentKey(e: PageElement): string {
	const { id: _id, ...rest } = e;
	void _id;
	// v8: whether a marker is resolved is its state, not its content (see planMerge).
	if (rest.type === "marker") delete (rest as Partial<MarkerElement>).done;
	// v9: graphs nest objects (viewport, functions): keys sorted at every level, none dropped. The cached outline of an
	// equation is how it looks, not what it is: the same LaTeX typeset on two devices is the same equation.
	// v10: an excerpt nests its source; its snapshot asset is how it looks, not what it shows (the same region excerpted on
	// two devices is the same excerpt even if the snapshots differ by a pixel).
	if (rest.type === "graph") return stableStringify(rest);
	if (rest.type === "excerpt") {
		const { asset: _a, ...ex } = rest;
		void _a;
		return stableStringify(ex);
	}
	if (rest.type === "equation") {
		const { outline: _o, ...eq } = rest;
		void _o;
		return stableStringify(eq);
	}
	return JSON.stringify(rest, Object.keys(rest).sort());
}

function pageSettingsKey(p: Page): string {
	return JSON.stringify([p.width, p.height, p.paper.kind, p.paper.spacing, p.background ?? null, p.infinite ?? false, normalizeMargins(p.margins) ?? null]);
}

/**
 * Horizontal shift that brings content of `from` into the frame of `into` (the same page in another
 * copy): adding a left margin moves the content right by its width, so the difference of the left margins.
 */
function frameShift(into: Page, from: Page): number {
	return Math.round((marginsOf(into).left - marginsOf(from).left) * 100) / 100;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const ceil2 = (n: number): number => Math.ceil(Math.round(n * 1e6) / 1e4) / 100;

interface Fit {
	/** New margins of the main page (a page with a background or margins), or null to keep them. */
	margins: PageMargins | null;
	/** Size of the main page after the new margins, and the size it must grow to, or null to keep it. */
	size: { before: { width: number; height: number }; after: { width: number; height: number } } | null;
}

/**
 * How the main page `target` has to grow so that every new item of the copy (`fresh`, already in
 * `target`'s frame) lies on it. A page with a background (or margins) widens its margins, the background
 * keeping its box: the left one to the copy's when an item lies left of the page (the copy has the wider
 * left margin), the right and bottom ones by what lies beyond the page. A plain page grows instead. An
 * infinite page grows its height in its usual steps (`SetPageSize`, which follows the margin rule).
 * Text boxes count with the height of their wrapped text (estimated measure). Null when everything fits.
 */
function fitOnPage(target: Page, copy: Page, fresh: { strokes: readonly Stroke[]; elements: readonly PageElement[] }): Fit | null {
	let minX = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of fresh.strokes) {
		for (const [x, y] of s.points) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
	}
	for (const e of fresh.elements) {
		if (e.type === "marker" || e.type === "box" || e.type === "equation" || e.type === "graph" || e.type === "excerpt") {
			const b = e.type === "marker" ? markerBounds(e) : e.type === "box" ? boxBounds(e) : { minX: e.x, maxX: e.x + e.width, maxY: e.y + e.height };
			minX = Math.min(minX, b.minX);
			maxX = Math.max(maxX, b.maxX);
			maxY = Math.max(maxY, b.maxY);
			continue;
		}
		const bottom = e.type === "image" ? e.y + e.height : textElementBounds(e).maxY;
		minX = Math.min(minX, e.x);
		maxX = Math.max(maxX, e.x + e.width);
		maxY = Math.max(maxY, bottom);
	}
	if (minX === Infinity) return null;
	const m = marginsOf(target);
	const copyLeft = marginsOf(copy).left;
	const left = minX < 0 && copyLeft > m.left ? copyLeft : m.left;
	// Moving the left edge moves the items and the right edge alike: only what lies beyond the page counts.
	const overRight = Math.max(0, ceil2(maxX - target.width));
	const overBottom = Math.max(0, ceil2(maxY - target.height));
	const withMargins = target.background !== undefined || target.margins !== undefined || left !== m.left;
	let margins: PageMargins | null = null;
	let width = target.width;
	if (withMargins) {
		const next = { left, right: round2(m.right + overRight), bottom: target.infinite ? m.bottom : round2(m.bottom + overBottom) };
		if (next.left !== m.left || next.right !== m.right || next.bottom !== m.bottom) {
			margins = next;
			width = round2(target.width + (next.left - m.left) + (next.right - m.right));
		}
	}
	const before = { width, height: target.height };
	let after = { width: withMargins ? width : round2(width + overRight), height: target.height };
	if (overBottom > 0 && (target.infinite || !withMargins)) {
		const grown = target.infinite ? growForInfinite({ width: after.width, height: target.height, infinite: true }, { maxY }) : null;
		after = { width: after.width, height: grown !== null && grown >= maxY ? grown : round2(target.height + overBottom) };
	}
	const size = after.width !== before.width || after.height !== before.height ? { before, after } : null;
	return margins || size ? { margins, size } : null;
}

/** Strokes and elements of `page` moved by `dx` (the same objects when `dx` is 0). */
function inFrame(page: Page, dx: number): { strokes: readonly Stroke[]; elements: readonly PageElement[] } {
	const elements = page.elements ?? [];
	if (dx === 0) return { strokes: page.strokes, elements };
	return { strokes: page.strokes.map((s) => translateStroke(s, dx)), elements: elements.map((e) => translateElement(e, dx)) };
}

function copyStroke(s: Stroke, id: string): Stroke {
	return copyStrokeWithId(s, id);
}

function copyElement(e: PageElement, id: string): PageElement {
	return freezeElement({ ...e, id });
}

/** The changes that bring everything of `other` into `main`. Does not modify either document. */
export function planMerge(main: NotebookDocument, other: NotebookDocument): MergePlan {
	const summary: MergeSummary = {
		pagesAdded: 0, strokesAdded: 0, strokesCopied: 0, elementsAdded: 0, elementsCopied: 0, assetsAdded: 0,
		tagsAdded: 0, bookmarksAdded: 0, bookmarkInfoAdded: 0, bookmarkInfoDiffer: 0, pageTagsAdded: 0, identical: 0, pageSettingsDiffer: 0, marginsDiffer: 0, pagesEnlarged: 0, onlyInMain: 0, markersResolved: 0,
	};
	const commands: Command[] = [];

	// Ids in use (strokes and elements share one id space) and the content of each.
	const used = new Map<string, string>();
	const mainPages = new Map<string, Page>();
	/** v8: markers of the main notebook by id, to carry a resolved state over (see `resolveFrom`). */
	const mainMarkers = new Map<string, { pageId: string; done: boolean }>();
	/** Content keys present on each page of the result, for the idempotence of copies. */
	const contentOn = new Map<string, Set<string>>();
	for (const page of main.pages) {
		mainPages.set(page.id, page);
		const keys = new Set<string>();
		for (const s of page.strokes) {
			const k = `s${strokeContentKey(s)}`;
			used.set(s.id, k);
			keys.add(k);
		}
		for (const e of page.elements ?? []) {
			const k = `e${elementContentKey(e)}`;
			used.set(e.id, k);
			keys.add(k);
			if (e.type === "marker") mainMarkers.set(e.id, { pageId: page.id, done: !!e.done });
		}
		contentOn.set(page.id, keys);
	}
	/**
	 * A marker of the copy that is the same marker as one of the main notebook (same id, same content: `key`): resolved
	 * there too when the copy resolved it. Found by id when applied, so a margin change in the same step does not matter.
	 */
	const resolveFrom = (e: PageElement, key: string): void => {
		if (e.type !== "marker" || !e.done || used.get(e.id) !== key) return;
		const main = mainMarkers.get(e.id);
		if (!main || main.done) return;
		commands.push(new SetMarkerDone(main.pageId, e.id, true));
		mainMarkers.set(e.id, { pageId: main.pageId, done: true });
		summary.markersResolved++;
	};
	const freshId = () => {
		let id = createId();
		while (used.has(id)) id = createId();
		return id;
	};

	// Assets first: pages and images that need them come after.
	const mainAssets = main.assets ?? {};
	for (const asset of Object.values(other.assets ?? {})) {
		if (Object.prototype.hasOwnProperty.call(mainAssets, asset.id)) continue;
		commands.push(new AddAsset({ ...asset }));
		summary.assetsAdded++;
	}

	type Decision = { kind: "skip" } | { kind: "keep" } | { kind: "copy"; id: string };
	/** What to do with an item of the copy that goes on page `pageId` of the result. */
	const decide = (id: string, key: string, pageId: string, kind: "stroke" | "element"): Decision => {
		const there = contentOn.get(pageId);
		const current = used.get(id);
		if (current === key) {
			summary.identical++;
			return { kind: "skip" };
		}
		if (there?.has(key)) {
			// Already copied by an earlier merge (or the same content under another id): nothing to add.
			summary.identical++;
			return { kind: "skip" };
		}
		if (current === undefined) {
			used.set(id, key);
			if (kind === "stroke") summary.strokesAdded++;
			else summary.elementsAdded++;
			return { kind: "keep" };
		}
		const fresh = freshId();
		used.set(fresh, key);
		if (kind === "stroke") summary.strokesCopied++;
		else summary.elementsCopied++;
		return { kind: "copy", id: fresh };
	};

	// Page order of the result, to place pages that exist only in the copy.
	const order = main.pages.map((p) => p.id);
	let anchor: string | null = null;
	for (const page of other.pages) {
		const target = mainPages.get(page.id);
		if (target) {
			if (pageSettingsKey(target) !== pageSettingsKey(page)) summary.pageSettingsDiffer++;
			const tags = unionPageTags(target.tags, page.tags);
			const tagsAdded = (tags?.length ?? 0) - (unionPageTags(target.tags, undefined)?.length ?? 0);
			if (tagsAdded > 0) {
				commands.push(new SetPageTags(target.id, target.tags, tags));
				summary.pageTagsAdded += tagsAdded;
			}
			const keys = contentOn.get(page.id)!;
			let shift = frameShift(target, page);
			if (!marginsEqual(normalizeMargins(target.margins), normalizeMargins(page.margins))) summary.marginsDiffer++;
			// New ink of the copy that would fall off the main page: the page grows first, in the same step.
			const inMain = inFrame(page, shift);
			const isNew = (id: string, key: string) => used.get(id) !== key && !keys.has(key);
			const fit = fitOnPage(target, page, {
				strokes: inMain.strokes.filter((s) => isNew(s.id, `s${strokeContentKey(s)}`)),
				elements: inMain.elements.filter((e) => isNew(e.id, `e${elementContentKey(e)}`)),
			});
			if (fit) {
				summary.pagesEnlarged++;
				if (fit.margins) {
					const before = normalizeMargins(target.margins);
					commands.push(new SetPageMargins(target.id, before, fit.margins));
					const w = round2(marginsOf({ margins: normalizeMargins(fit.margins) }).left - marginsOf({ margins: before }).left);
					if (w !== 0) {
						// The main page's own ink moves with its background: its content keys move too.
						keys.clear();
						for (const s of target.strokes) {
							const k = `s${strokeContentKey(translateStroke(s, w))}`;
							used.set(s.id, k);
							keys.add(k);
						}
						for (const e of target.elements ?? []) {
							const k = `e${elementContentKey(translateElement(e, w))}`;
							used.set(e.id, k);
							keys.add(k);
						}
						shift = round2(shift + w);
					}
				}
				if (fit.size) commands.push(new SetPageSize(target.id, fit.size.before, fit.size.after));
			}
			const content = inFrame(page, shift);
			let strokeAt = target.strokes.length;
			for (const s of content.strokes) {
				const key = `s${strokeContentKey(s)}`;
				const d = decide(s.id, key, page.id, "stroke");
				if (d.kind === "skip") continue;
				const stroke = d.kind === "keep" ? s : copyStroke(s, d.id);
				commands.push(new AddStroke(page.id, stroke, strokeAt++));
				keys.add(key);
			}
			let elAt = target.elements?.length ?? 0;
			for (const e of content.elements) {
				const key = `e${elementContentKey(e)}`;
				const d = decide(e.id, key, page.id, "element");
				if (d.kind === "skip") {
					resolveFrom(e, key);
					continue;
				}
				const el = d.kind === "keep" ? e : copyElement(e, d.id);
				commands.push(new AddElement(page.id, el, elAt++));
				keys.add(key);
			}
			anchor = page.id;
			continue;
		}
		// A page only in the copy: added after the page that precedes it in the copy.
		const keys = new Set<string>();
		contentOn.set(page.id, keys);
		const strokes: Stroke[] = [];
		for (const s of page.strokes) {
			const key = `s${strokeContentKey(s)}`;
			const d = decide(s.id, key, page.id, "stroke");
			if (d.kind === "skip") continue;
			strokes.push(d.kind === "keep" ? s : copyStroke(s, d.id));
			keys.add(key);
		}
		const elements: PageElement[] = [];
		for (const e of page.elements ?? []) {
			const key = `e${elementContentKey(e)}`;
			const d = decide(e.id, key, page.id, "element");
			if (d.kind === "skip") continue;
			elements.push(d.kind === "keep" ? e : copyElement(e, d.id));
			keys.add(key);
		}
		const added: Page = { id: page.id, width: page.width, height: page.height, paper: { ...page.paper }, strokes };
		if (page.background) added.background = { ...page.background };
		if (page.infinite !== undefined) added.infinite = page.infinite;
		if (page.margins) added.margins = { ...page.margins };
		if (page.tags && page.tags.length > 0) added.tags = [...page.tags];
		if (elements.length > 0) added.elements = elements;
		const at = anchor === null ? 0 : order.indexOf(anchor) + 1;
		order.splice(at, 0, page.id);
		commands.push(new AddPage(added, at));
		mainPages.set(page.id, added);
		summary.pagesAdded++;
		anchor = page.id;
	}

	// Items of the main notebook that the copy does not have: kept, only counted.
	const otherIds = new Set<string>();
	for (const p of other.pages) {
		for (const s of p.strokes) otherIds.add(s.id);
		for (const e of p.elements ?? []) otherIds.add(e.id);
	}
	for (const p of main.pages) {
		for (const s of p.strokes) if (!otherIds.has(s.id)) summary.onlyInMain++;
		for (const e of p.elements ?? []) if (!otherIds.has(e.id)) summary.onlyInMain++;
	}

	const meta = mergeMeta(main.meta ?? DEFAULT_META, other.meta ?? DEFAULT_META, new Set(order));
	const before = main.meta ?? cloneMeta(DEFAULT_META);
	summary.tagsAdded = meta.tags.length - new Set(before.tags).size;
	summary.bookmarksAdded = meta.bookmarks.length - new Set(before.bookmarks.filter((b) => order.includes(b))).size;
	const fields = bookmarkFieldChanges(before, other.meta ?? DEFAULT_META, meta.bookmarks);
	summary.bookmarkInfoAdded = fields.added;
	summary.bookmarkInfoDiffer = fields.differ;
	if (summary.tagsAdded > 0 || summary.bookmarksAdded > 0 || summary.bookmarkInfoAdded > 0 || meta.favorite !== before.favorite) {
		commands.push(new SetMeta(before, meta));
	}

	return { summary, command: commands.length > 0 ? new Batch("Merge conflicted copy", commands) : null };
}

const BOOKMARK_FIELDS = ["title", "color", "category"] as const;

/** Per bookmark of `bookmarks`: detail fields the copy fills in (`added`) and fields both set differently (`differ`). */
function bookmarkFieldChanges(main: NotebookMeta, other: NotebookMeta, bookmarks: readonly string[]): { added: number; differ: number } {
	let added = 0;
	let differ = 0;
	for (const id of bookmarks) {
		if (id === "__proto__") continue;
		const a = normalizeBookmarkInfo(main.bookmarkInfo?.[id]);
		const b = normalizeBookmarkInfo(other.bookmarkInfo?.[id]);
		if (!b) continue;
		for (const key of BOOKMARK_FIELDS) {
			if (b[key] === undefined) continue;
			if (a?.[key] === undefined) added++;
			else if (a[key] !== b[key]) differ++;
		}
	}
	return { added, differ };
}

/** Bookmark details merged field by field: each field of `main` wins, missing ones come from `other`. */
function mergeBookmarkInfo(main: BookmarkInfo | undefined, other: BookmarkInfo | undefined): BookmarkInfo | undefined {
	const a = normalizeBookmarkInfo(main);
	const b = normalizeBookmarkInfo(other);
	if (!a || !b) return a ?? b;
	const out: BookmarkInfo = { ...a };
	for (const key of BOOKMARK_FIELDS) if (out[key] === undefined && b[key] !== undefined) out[key] = b[key];
	return out;
}

/**
 * Tags and bookmarks of both (main first), favourite if either, the main cover. v7 bookmark details are
 * merged field by field: the main notebook's value of each field, else the copy's.
 */
export function mergeMeta(main: NotebookMeta, other: NotebookMeta, pageIds: ReadonlySet<string>): NotebookMeta {
	const tags = [...new Set([...main.tags, ...other.tags])];
	const bookmarks = [...new Set([...main.bookmarks, ...other.bookmarks])].filter((b) => pageIds.has(b));
	const out: NotebookMeta = { tags, favorite: main.favorite || other.favorite, cover: main.cover, bookmarks };
	const info: Record<string, BookmarkInfo> = {};
	let n = 0;
	for (const id of bookmarks) {
		if (id === "__proto__") continue;
		const chosen = mergeBookmarkInfo(main.bookmarkInfo?.[id], other.bookmarkInfo?.[id]);
		if (chosen) {
			info[id] = chosen;
			n++;
		}
	}
	if (n > 0) out.bookmarkInfo = info;
	return out;
}

/** Number of changes a summary describes (0: the copy holds nothing new). */
export function mergeChangeCount(s: MergeSummary): number {
	return s.pagesEnlarged + s.pagesAdded + s.strokesAdded + s.strokesCopied + s.elementsAdded + s.elementsCopied + s.assetsAdded + s.tagsAdded
		+ s.bookmarksAdded + s.bookmarkInfoAdded + s.pageTagsAdded + s.markersResolved;
}

/**
 * True when `result` contains everything of `other`: every stroke and element, by id with the same
 * content or as identical content on the same page, every asset, every tag, every v7 bookmark detail field
 * with the same value (a field the main notebook set differently is not covered: the copy stays). Content is compared in the
 * result page's margin frame (see `planMerge`), so a page whose margins were lost on the way (its ink
 * would no longer line up with its background) is not covered. Used to check the saved file before
 * the conflicted copy is moved away.
 */
export function mergeCovers(result: NotebookDocument, other: NotebookDocument): boolean {
	const byId = new Map<string, string>();
	const onPage = new Map<string, Set<string>>();
	/** v8: content keys of resolved markers per page, and resolved marker ids. */
	const resolvedOn = new Map<string, Set<string>>();
	const resolvedIds = new Set<string>();
	for (const p of result.pages) {
		const keys = new Set<string>();
		for (const s of p.strokes) {
			const k = `s${strokeContentKey(s)}`;
			byId.set(s.id, k);
			keys.add(k);
		}
		const resolved = new Set<string>();
		for (const e of p.elements ?? []) {
			const k = `e${elementContentKey(e)}`;
			byId.set(e.id, k);
			keys.add(k);
			if (e.type === "marker" && e.done) {
				resolved.add(k);
				resolvedIds.add(e.id);
			}
		}
		onPage.set(p.id, keys);
		resolvedOn.set(p.id, resolved);
	}
	const resultPages = new Map(result.pages.map((p) => [p.id, p]));
	for (const p of other.pages) {
		const keys = onPage.get(p.id);
		const into = resultPages.get(p.id);
		if (!keys || !into) return false;
		const content = inFrame(p, frameShift(into, p));
		for (const s of content.strokes) {
			const k = `s${strokeContentKey(s)}`;
			if (byId.get(s.id) !== k && !keys.has(k)) return false;
		}
		for (const e of content.elements) {
			const k = `e${elementContentKey(e)}`;
			if (byId.get(e.id) !== k && !keys.has(k)) return false;
			// v8: a marker the copy resolved is resolved in the result (the same marker, or the same content on the page).
			if (e.type === "marker" && e.done && !(byId.get(e.id) === k && resolvedIds.has(e.id)) && !resolvedOn.get(p.id)?.has(k)) return false;
		}
	}
	for (const id of Object.keys(other.assets ?? {})) if (!result.assets?.[id]) return false;
	const tags = new Set(result.meta?.tags ?? []);
	if (!(other.meta?.tags ?? []).every((t) => tags.has(t))) return false;
	// v7: every page tag, every bookmark and every bookmark detail field of the copy is in the result, with the same value.
	for (const p of other.pages) {
		const into = resultPages.get(p.id)!;
		const have = new Set((into.tags ?? []).map((t) => t.toLowerCase()));
		if (!(p.tags ?? []).every((t) => have.has(t.toLowerCase()))) return false;
	}
	const marks = new Set(result.meta?.bookmarks ?? []);
	for (const id of other.meta?.bookmarks ?? []) {
		if (!resultPages.has(id)) continue;
		if (!marks.has(id)) return false;
		const want = normalizeBookmarkInfo(other.meta?.bookmarkInfo?.[id]);
		if (!want) continue;
		const have = normalizeBookmarkInfo(result.meta?.bookmarkInfo?.[id]);
		if (BOOKMARK_FIELDS.some((key) => want[key] !== undefined && have?.[key] !== want[key])) return false;
	}
	return true;
}
