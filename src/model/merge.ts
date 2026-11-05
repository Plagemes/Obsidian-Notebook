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
 * - v17: a checkbox is its place, size and colour; whether it is ticked, when it was last toggled (`at`), its typed label and its
 *   task link are its state, not content. The same checkbox (same id) on both sides is kept once; when both toggled it the later
 *   toggle wins (`mergedCheckbox`: ticked or unticked as the later one left it, a tie that disagrees keeps the tick) and a label or
 *   task link only the copy has is added (counted in `checkboxesUpdated`); the link itself follows the later decision (`taskAt`,
 *   stamped by link and unlink), so an *Unlink task* is not undone by an older copy. A checkbox only the copy has comes as it is,
 *   link included (it names the same task line). Edits to the task line itself are not merged: they live in the note.
 * - v16: the margin comments of a common page are united by id (`mergeComments`): two devices that added comments or replies
 *   both keep theirs; for one comment (or reply) both have, the later edit wins (`edited`, else `created`; the main notebook on a
 *   tie), and when both edited the text the losing version is kept beside it as a marked comment or reply (`conflictId`, counted in
 *   `commentsAdded`, and what `mergeCovers` looks for). The copy's regions are moved with the content when the page had to be re-framed and
 *   clamped to the size the page has after the merge's own growth. A page that only the copy has comes with its comments. Deletions are
 *   not inferred (a comment one device deleted comes back from a copy that still has it).
 * - v14: a page locked in either copy is locked in the result; the merge is exempt from the page-lock guard (model/page-lock.ts),
 *   so ink of the copy reaches a locked page of the main notebook too. A page that only the copy has comes with its lock.
 * - v13: the parts and states of a drawing (`Page.states`) are not content either: a page that only the copy has brings its
 *   table along (its strokes under their new ids); a page of the main notebook that has none takes the copy's, mapped to the
 *   strokes that are in the main notebook (shifted with them when the page had to be re-framed). When both have a table the
 *   main notebook's stays: two arrangements of one drawing are not merged.
 * - v12: which slide ink was written beside (`Stroke.slide`) is not content: ink taken from the copy keeps its slide,
 *   whose entry is matched in the main notebook's table or added to it (model/slide-links.ts `slideMerger`).
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
import { commentCovered, copyComments, mergeComments, SetPageComments, shiftComments } from "./comments";
import { exemptFromLocks, SetPageLocked } from "./page-lock";
import { slideMerger } from "./slide-links";
import { remapStates, SetPageStates } from "./states";
import { boxBounds, markerBounds } from "./markers";
import { stableStringify } from "./math-elements";
import { marginsEqual, marginsOf, normalizeMargins, translateElement, translateStroke } from "./margins";
import { normalizeBookmarkInfo } from "./bookmarks";
import { SetPageTags, unionPageTags } from "./page-tags";
import { copyStroke as copyStrokeWithId } from "./pages";
import { freezeElement } from "./serialize";
import { UpdateCheckbox } from "./checklist-commands";
import { copiedCheckbox, withChecked, withCheckboxLabel, withCheckboxTask } from "./checklist";
import { DEFAULT_META, type BookmarkInfo, type CheckboxElement, type MarkerElement, type NotebookDocument, type NotebookMeta, type Page, type PageElement, type PageMargins, type Stroke } from "./types";

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
	/** v16: comments and replies of the copy added to common pages, taken from the copy because it edited them later, or kept beside the winner as a marked copy when both edited the text (comments of pages only in the copy come with the page). */
	commentsAdded: number;
	/** v8: markers resolved in the copy only, resolved in the main notebook too ("either", like favourite). */
	markersResolved: number;
	/** v17: checkboxes both have whose state is taken from the copy because it was toggled later (or it has a label or task link the main one lacks). */
	checkboxesUpdated: number;
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
	// v15: a note's list of hidden strokes names ids of one copy: the notes are the same when what they show is the same.
	if (rest.type === "sticky") {
		const { ink: _i, ...note } = rest;
		void _i;
		return stableStringify(note);
	}
	// v17: what a checkbox is (where, how big, which colour) is its content; whether it is ticked, when, its typed label and its
	// task link are its state (merged by `mergedCheckbox`: the later toggle wins).
	if (rest.type === "checkbox") {
		const { checked: _c, at: _t, taskAt: _s, label: _l, task: _k, ...box } = rest;
		void _c; void _t; void _s; void _l; void _k;
		return stableStringify(box);
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
		if (e.type === "checkbox") {
			minX = Math.min(minX, e.x);
			maxX = Math.max(maxX, e.x + e.size);
			maxY = Math.max(maxY, e.y + e.size);
			continue;
		}
		if (e.type === "marker" || e.type === "box" || e.type === "equation" || e.type === "graph" || e.type === "excerpt" || e.type === "sticky") {
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

function copyStroke(s: Stroke, id: string, slide?: string | null): Stroke {
	return copyStrokeWithId(s, id, slide);
}

function copyElement(e: PageElement, id: string): PageElement {
	// v17: a copy under a new id never keeps the link to the task line of the original.
	if (e.type === "checkbox") return freezeElement(copiedCheckbox(e, id));
	return freezeElement({ ...e, id });
}

/**
 * v17: the state of the same checkbox (same id, same content) in the main notebook and in the copy, or null when the main notebook's
 * is kept. The later toggle wins (`at`; never toggled counts as 0); on a tie that disagrees (the same time, or both without one, with
 * different ticks) the tick wins, so a tick is never lost. The link follows the later decision (`taskAt`, set whenever a task is
 * linked or unlinked; none counts as 0): the copy's link, or its absence, replaces the main notebook's when the copy decided later,
 * the main notebook's stands when it did, and when neither ever decided a link only the copy has is taken. A typed label that only
 * the copy has is taken either way (the main notebook's own stays when both have one).
 */
export function mergedCheckbox(main: CheckboxElement, copy: CheckboxElement): CheckboxElement | null {
	const mainAt = main.at ?? 0;
	const copyAt = copy.at ?? 0;
	const mainTicked = main.checked === true;
	const copyTicked = copy.checked === true;
	let out: CheckboxElement = main;
	if (copyAt > mainAt) {
		if (copyTicked !== mainTicked) out = withChecked(out, copyTicked, copyAt);
		else out = { ...out, at: copyAt };
	} else if (copyAt === mainAt && copyTicked && !mainTicked) out = withChecked(out, true, copyAt);
	if (main.label === undefined && copy.label !== undefined) out = withCheckboxLabel(out, copy.label);
	const mainStamp = main.taskAt ?? 0;
	const copyStamp = copy.taskAt ?? 0;
	if (copyStamp > mainStamp) {
		if (copy.task === undefined) {
			if (out.task !== undefined || out.taskAt !== copyStamp) out = withCheckboxTask(out, null, copyStamp);
		} else if (out.task?.path !== copy.task.path || out.task.block !== copy.task.block || out.taskAt !== copyStamp) out = withCheckboxTask(out, copy.task, copyStamp);
	} else if (copyStamp === mainStamp && mainStamp === 0 && main.task === undefined && copy.task !== undefined) out = withCheckboxTask(out, copy.task);
	return out === main ? null : out;
}

/**
 * v15: a collapsed note of the copy names its hidden strokes by the ids they have in the main notebook. Only the strokes this
 * merge adds: the ones that did not come along are dropped, and so are the ones main already had (they are shown there, by a note
 * main has open, and a collapsed copy hiding or owning them would blank that note).
 */
function carriedInk(e: PageElement, strokeMap: ReadonlyMap<string, string>, added: ReadonlySet<string>): PageElement {
	if (e.type !== "sticky" || !e.ink) return e;
	const ink = [...new Set(e.ink.map((id) => strokeMap.get(id)).filter((id): id is string => id !== undefined && added.has(id)))];
	const out = { ...e };
	if (ink.length > 0) out.ink = ink;
	else delete out.ink;
	return freezeElement(out);
}

/** The changes that bring everything of `other` into `main`. Does not modify either document. */
export function planMerge(main: NotebookDocument, other: NotebookDocument): MergePlan {
	const summary: MergeSummary = {
		pagesAdded: 0, strokesAdded: 0, strokesCopied: 0, elementsAdded: 0, elementsCopied: 0, assetsAdded: 0,
		tagsAdded: 0, bookmarksAdded: 0, bookmarkInfoAdded: 0, bookmarkInfoDiffer: 0, pageTagsAdded: 0, identical: 0, pageSettingsDiffer: 0, marginsDiffer: 0, pagesEnlarged: 0, onlyInMain: 0, markersResolved: 0, commentsAdded: 0, checkboxesUpdated: 0,
	};
	const commands: Command[] = [];
	// v12: the copy's slide ids in the main notebook's table.
	const slides = slideMerger(main, other);
	/** A stroke of the copy as it goes into the main notebook: id `id`, its slide id mapped (`keep`: `s` itself when nothing changes). */
	const taken = (s: Stroke, keep: boolean, id: string): Stroke => {
		const slide = s.slide === undefined ? undefined : slides.map(s.slide);
		if (keep && slide === s.slide) return s;
		return copyStroke(s, id, slide);
	};

	// Ids in use (strokes and elements share one id space) and the content of each.
	const used = new Map<string, string>();
	const mainPages = new Map<string, Page>();
	/** v8: markers of the main notebook by id, to carry a resolved state over (see `resolveFrom`). */
	const mainMarkers = new Map<string, { pageId: string; done: boolean }>();
	/** v17: checkboxes of the main notebook by id (see `checkFrom`). */
	const mainCheckboxes = new Map<string, { pageId: string; el: CheckboxElement }>();
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
			if (e.type === "checkbox") mainCheckboxes.set(e.id, { pageId: page.id, el: e });
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
	/**
	 * v17: a checkbox of the copy that is the same checkbox as one of the main notebook (same id, same content: `key`): its state
	 * follows the later toggle. Found by id when applied, so a margin change in the same step does not matter.
	 */
	const checkFrom = (e: PageElement, key: string): void => {
		if (e.type !== "checkbox" || used.get(e.id) !== key) return;
		const have = mainCheckboxes.get(e.id);
		if (!have) return;
		const next = mergedCheckbox(have.el, e);
		if (!next) return;
		// Merged against the element as it is when the command runs (a margin change in the same step moves every element).
		commands.push(new UpdateCheckbox(have.pageId, e.id, (current) => mergedCheckbox(current, e) ?? current, "Merge checkbox"));
		mainCheckboxes.set(e.id, { pageId: have.pageId, el: next });
		summary.checkboxesUpdated++;
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

	/** v13: where each stroke of the copy ended up in the result (the same id, a fresh id) for the copy's state tables. */
	const strokeMap = new Map<string, string>();
	/** The ids (in main) of the strokes this merge adds. */
	const addedStrokes = new Set<string>();
	const mainStrokeIds = new Set<string>();
	for (const p of main.pages) for (const s of p.strokes) mainStrokeIds.add(s.id);
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
			/** v16: how far the main page's own content (and so its comments) moved when its margins widened. */
			let mainMoved = 0;
			if (!marginsEqual(normalizeMargins(target.margins), normalizeMargins(page.margins))) summary.marginsDiffer++;
			// New ink of the copy that would fall off the main page: the page grows first, in the same step.
			const inMain = inFrame(page, shift);
			const isNew = (id: string, key: string) => used.get(id) !== key && !keys.has(key);
			const fit = fitOnPage(target, page, {
				strokes: inMain.strokes.filter((s) => isNew(s.id, `s${strokeContentKey(s)}`)),
				elements: inMain.elements.filter((e) => isNew(e.id, `e${elementContentKey(e)}`)),
			});
			/** v16: the size the main page has once the commands above ran (the copy's comments are kept against that, not the size it has now). */
			let finalSize = { width: target.width, height: target.height };
			if (fit) {
				summary.pagesEnlarged++;
				if (fit.margins) {
					const before = normalizeMargins(target.margins);
					commands.push(new SetPageMargins(target.id, before, fit.margins));
					const mb = marginsOf({ margins: before });
					const ma = marginsOf({ margins: normalizeMargins(fit.margins) });
					finalSize = { width: round2(target.width + ma.left + ma.right - mb.left - mb.right), height: round2(target.height + ma.bottom - mb.bottom) };
					const w = round2(ma.left - mb.left);
					if (w !== 0) {
						mainMoved = w;
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
				if (fit.size) {
					commands.push(new SetPageSize(target.id, fit.size.before, fit.size.after));
					finalSize = fit.size.after;
				}
			}
			const content = inFrame(page, shift);
			let strokeAt = target.strokes.length;
			for (const s of content.strokes) {
				const key = `s${strokeContentKey(s)}`;
				const d = decide(s.id, key, page.id, "stroke");
				if (d.kind === "skip") {
					if (mainStrokeIds.has(s.id)) strokeMap.set(s.id, s.id);
					continue;
				}
				strokeMap.set(s.id, d.kind === "keep" ? s.id : d.id);
				addedStrokes.add(d.kind === "keep" ? s.id : d.id);
				const stroke = d.kind === "keep" ? taken(s, true, s.id) : taken(s, false, d.id);
				commands.push(new AddStroke(page.id, stroke, strokeAt++));
				keys.add(key);
			}
			let elAt = target.elements?.length ?? 0;
			for (const e of content.elements) {
				const key = `e${elementContentKey(e)}`;
				const d = decide(e.id, key, page.id, "element");
				if (d.kind === "skip") {
					resolveFrom(e, key);
					checkFrom(e, key);
					continue;
				}
				const el = carriedInk(d.kind === "keep" ? e : copyElement(e, d.id), strokeMap, addedStrokes);
				commands.push(new AddElement(page.id, el, elAt++));
				keys.add(key);
			}
			// v13: the copy's parts and states for a page that has none (the strokes are in the frame of the main page).
			if (page.states && !target.states) {
				const states = remapStates(page.states, (id) => strokeMap.get(id));
				if (states) {
					const moved = shift === 0 ? states : { ...states, parts: states.parts.map((p) => ({ ...p, pivot: [p.pivot[0] + shift, p.pivot[1]] as [number, number] })) };
					commands.push(new SetPageStates(target.id, undefined, moved, "Merge states"));
				}
			}
			// v16: the comments of both, united by id; the copy's are in the frame of the main page like its ink. Last, after the commands that may have moved the page.
			if (page.comments) {
				const mine = mainMoved === 0 || !target.comments ? target.comments : shiftComments(target.comments, mainMoved);
				const theirs = copyComments(shift === 0 ? page.comments : shiftComments(page.comments, shift), finalSize) ?? [];
				const merged = mergeComments(mine, theirs);
				if (merged.list !== mine) {
					commands.push(new SetPageComments(target.id, mine, merged.list, "Merge comments"));
					// Edits that lost are kept beside the winner (marked), and count: the merge reports what it added.
					summary.commentsAdded += merged.added + merged.replaced + merged.conflicts;
				}
			}
			// v14: a page locked in either copy is locked in the result (the safer side: unlocking is one tap). Added last, after the ink.
			if (page.locked && !target.locked) commands.push(new SetPageLocked(target.id, true));
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
			if (d.kind === "skip") {
				if (mainStrokeIds.has(s.id)) strokeMap.set(s.id, s.id);
				continue;
			}
			strokeMap.set(s.id, d.kind === "keep" ? s.id : d.id);
			addedStrokes.add(d.kind === "keep" ? s.id : d.id);
			strokes.push(d.kind === "keep" ? taken(s, true, s.id) : taken(s, false, d.id));
			keys.add(key);
		}
		const elements: PageElement[] = [];
		for (const e of page.elements ?? []) {
			const key = `e${elementContentKey(e)}`;
			const d = decide(e.id, key, page.id, "element");
			if (d.kind === "skip") continue;
			elements.push(carriedInk(d.kind === "keep" ? e : copyElement(e, d.id), strokeMap, addedStrokes));
			keys.add(key);
		}
		const added: Page = { id: page.id, width: page.width, height: page.height, paper: { ...page.paper }, strokes };
		if (page.background) added.background = { ...page.background };
		if (page.infinite !== undefined) added.infinite = page.infinite;
		if (page.margins) added.margins = { ...page.margins };
		if (page.tags && page.tags.length > 0) added.tags = [...page.tags];
		if (elements.length > 0) added.elements = elements;
		const addedStates = remapStates(page.states, (id) => strokeMap.get(id));
		if (addedStates) added.states = addedStates;
		if (page.locked) added.locked = true;
		const addedComments = copyComments(page.comments, page);
		if (addedComments) added.comments = addedComments;
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
	const v11Added = (meta.description !== undefined && before.description === undefined) || (!!meta.coverArt && !before.coverArt);
	if (summary.tagsAdded > 0 || summary.bookmarksAdded > 0 || summary.bookmarkInfoAdded > 0 || meta.favorite !== before.favorite || v11Added) {
		commands.push(new SetMeta(before, meta));
	}

	// v12: the slide entries the copied ink names, first (in the same undo step).
	commands.unshift(...slides.commands());
	// v14: exempt from the page-lock guard: the merge exists to bring in what the other copy has, and a locked page of the main
	// notebook must receive it too (nothing is lost because a page was locked on one device).
	return { summary, command: commands.length > 0 ? exemptFromLocks(new Batch("Merge conflicted copy", commands)) : null };
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
	// v11: like the cover colour, the main notebook's description and cover win; the copy's fill a gap. The copy's image
	// cover is not taken (its asset may not be in the main notebook, and a cover naming a missing asset cannot be saved).
	const description = main.description ?? other.description;
	if (description !== undefined) out.description = description;
	const coverArt = main.coverArt ?? (other.coverArt?.kind === "art" ? other.coverArt : undefined);
	if (coverArt) out.coverArt = { ...coverArt };
	return out;
}

/** Number of changes a summary describes (0: the copy holds nothing new). */
export function mergeChangeCount(s: MergeSummary): number {
	return s.pagesEnlarged + s.pagesAdded + s.strokesAdded + s.strokesCopied + s.elementsAdded + s.elementsCopied + s.assetsAdded + s.tagsAdded
		+ s.bookmarksAdded + s.bookmarkInfoAdded + s.pageTagsAdded + s.markersResolved + s.commentsAdded + s.checkboxesUpdated;
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
	/** v17: when each checkbox of the result was last toggled (0: never), whether it is ticked, and when its link was last decided. */
	const toggledAt = new Map<string, number>();
	const ticked = new Set<string>();
	const linkedAt = new Map<string, number>();
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
			if (e.type === "checkbox") {
				toggledAt.set(e.id, e.at ?? 0);
				linkedAt.set(e.id, e.taskAt ?? 0);
				if (e.checked === true) ticked.add(e.id);
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
			// v17: the same checkbox is in the result toggled and linked or unlinked at least as late as in the copy, and a tick of the copy
			// that ties with the result's untick is in the result too.
			if (e.type === "checkbox" && byId.get(e.id) === k) {
				const at = toggledAt.get(e.id) ?? 0;
				if (at < (e.at ?? 0) || (at === (e.at ?? 0) && e.checked === true && !ticked.has(e.id))) return false;
				if ((linkedAt.get(e.id) ?? 0) < (e.taskAt ?? 0)) return false;
			}
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
	// v16: every comment and reply of the copy is in the result, edited at least as late.
	for (const p of other.pages) {
		const into = resultPages.get(p.id)!;
		// (a version that lost a merge is covered by the marked copy kept beside the winner)
		if ((p.comments ?? []).some((c) => !commentCovered(into.comments ?? [], c))) return false;
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
