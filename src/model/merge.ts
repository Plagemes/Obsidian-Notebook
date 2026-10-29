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
 * - v6 margins: a left margin shifts the whole page content by its width, so when a common page has a
 *   different left margin in the copy, the copy's strokes and elements are first moved into the main
 *   page's frame (by the difference of the left margins). Ink that is the same relative to the
 *   background is then recognised as the same, and new ink lands where it was drawn on the background.
 *
 * Both documents must come from `parse()`, so whatever version the copy was written in, it has gone
 * through the regular migrations first. The result is one `Batch` (one undo step) for the main
 * notebook's history; it is planned against the current state of `main` and must be applied to it.
 */
import { cloneMeta, createId } from "./document";
import { AddAsset, AddElement, AddPage, AddStroke, Batch, SetMeta, type Command } from "./history";
import { marginsEqual, marginsOf, normalizeMargins, translateElement, translateStroke } from "./margins";
import { freezeElement, freezeStroke } from "./serialize";
import { DEFAULT_META, type NotebookDocument, type NotebookMeta, type Page, type PageElement, type Stroke } from "./types";

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
	/** Strokes and elements present on both sides with identical content (nothing to do). */
	identical: number;
	/** Common pages whose settings differ: the main notebook's settings are kept. */
	pageSettingsDiffer: number;
	/**
	 * Common pages whose margins differ (also counted in `pageSettingsDiffer`): the main margins are
	 * kept and the copy's content was moved into them before comparing and adding.
	 */
	marginsDiffer: number;
	/** Items of the main notebook missing from the copy (kept: deletions are not inferred). */
	onlyInMain: number;
}

export interface MergePlan {
	summary: MergeSummary;
	/** Null when there is nothing to add. */
	command: Command | null;
}

export function strokeContentKey(s: Stroke): string {
	return JSON.stringify([s.tool, s.color, s.width, s.render, s.points]);
}

export function elementContentKey(e: PageElement): string {
	const { id: _id, ...rest } = e;
	void _id;
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

/** Strokes and elements of `page` moved by `dx` (the same objects when `dx` is 0). */
function inFrame(page: Page, dx: number): { strokes: readonly Stroke[]; elements: readonly PageElement[] } {
	const elements = page.elements ?? [];
	if (dx === 0) return { strokes: page.strokes, elements };
	return { strokes: page.strokes.map((s) => translateStroke(s, dx)), elements: elements.map((e) => translateElement(e, dx)) };
}

function copyStroke(s: Stroke, id: string): Stroke {
	return freezeStroke({ id, tool: s.tool, color: s.color, width: s.width, render: s.render, points: s.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]) });
}

function copyElement(e: PageElement, id: string): PageElement {
	return freezeElement({ ...e, id });
}

/** The changes that bring everything of `other` into `main`. Does not modify either document. */
export function planMerge(main: NotebookDocument, other: NotebookDocument): MergePlan {
	const summary: MergeSummary = {
		pagesAdded: 0, strokesAdded: 0, strokesCopied: 0, elementsAdded: 0, elementsCopied: 0, assetsAdded: 0,
		tagsAdded: 0, bookmarksAdded: 0, identical: 0, pageSettingsDiffer: 0, marginsDiffer: 0, onlyInMain: 0,
	};
	const commands: Command[] = [];

	// Ids in use (strokes and elements share one id space) and the content of each.
	const used = new Map<string, string>();
	const mainPages = new Map<string, Page>();
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
		}
		contentOn.set(page.id, keys);
	}
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
			if (!marginsEqual(normalizeMargins(target.margins), normalizeMargins(page.margins))) summary.marginsDiffer++;
			const content = inFrame(page, frameShift(target, page));
			const keys = contentOn.get(page.id)!;
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
				if (d.kind === "skip") continue;
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
	if (summary.tagsAdded > 0 || summary.bookmarksAdded > 0 || meta.favorite !== before.favorite) commands.push(new SetMeta(before, meta));

	return { summary, command: commands.length > 0 ? new Batch("Merge conflicted copy", commands) : null };
}

/** Tags and bookmarks of both (main first), favourite if either, the main cover. */
export function mergeMeta(main: NotebookMeta, other: NotebookMeta, pageIds: ReadonlySet<string>): NotebookMeta {
	const tags = [...new Set([...main.tags, ...other.tags])];
	const bookmarks = [...new Set([...main.bookmarks, ...other.bookmarks])].filter((b) => pageIds.has(b));
	return { tags, favorite: main.favorite || other.favorite, cover: main.cover, bookmarks };
}

/** Number of changes a summary describes (0: the copy holds nothing new). */
export function mergeChangeCount(s: MergeSummary): number {
	return s.pagesAdded + s.strokesAdded + s.strokesCopied + s.elementsAdded + s.elementsCopied + s.assetsAdded + s.tagsAdded + s.bookmarksAdded;
}

/**
 * True when `result` contains everything of `other`: every stroke and element, by id with the same
 * content or as identical content on the same page, every asset, every tag. Content is compared in the
 * result page's margin frame (see `planMerge`), so a page whose margins were lost on the way (its ink
 * would no longer line up with its background) is not covered. Used to check the saved file before
 * the conflicted copy is moved away.
 */
export function mergeCovers(result: NotebookDocument, other: NotebookDocument): boolean {
	const byId = new Map<string, string>();
	const onPage = new Map<string, Set<string>>();
	for (const p of result.pages) {
		const keys = new Set<string>();
		for (const s of p.strokes) {
			const k = `s${strokeContentKey(s)}`;
			byId.set(s.id, k);
			keys.add(k);
		}
		for (const e of p.elements ?? []) {
			const k = `e${elementContentKey(e)}`;
			byId.set(e.id, k);
			keys.add(k);
		}
		onPage.set(p.id, keys);
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
		}
	}
	for (const id of Object.keys(other.assets ?? {})) if (!result.assets?.[id]) return false;
	const tags = new Set(result.meta?.tags ?? []);
	return (other.meta?.tags ?? []).every((t) => tags.has(t));
}
