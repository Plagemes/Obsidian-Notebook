import { remapFigureMarkers } from "../ink/figure-text";
import { copiedCheckbox } from "./checklist";
import { createId, createPage } from "./document";
import { freezeElement, freezeStroke } from "./serialize";
import { copyComments } from "./comments";
import { groupRenamer } from "./groups";
import { pageTimes, putPageTimes } from "./page-times";
import { remapStates } from "./states";
import { PAPER_SPACING, type Asset, type Page, type PageElement, type Stroke } from "./types";

function copyElement(el: PageElement, keepTasks: boolean, regroup: (group: string) => string, id: string, figures: ReadonlyMap<string, string>): PageElement {
	// v17: a copy of a checkbox keeps its tick but never the link to the task line of the original (unless the page is moved).
	const copy = el.type === "checkbox" ? copiedCheckbox(el, id, keepTasks) : { ...el, id };
	// v18: a copy of a page belongs to groups of its own (new ids); its locks are kept.
	if (copy.group !== undefined) copy.group = regroup(copy.group);
	// 0.29 (#248) review fix (F2): a caption or a reference to a picture that is copied too names the COPY of the picture.
	if (copy.type === "text") {
		const text = remapFigureMarkers(copy.text, figures);
		if (text !== copy.text) copy.text = text;
	}
	return freezeElement(copy);
}

/** The pictures (images and figure cut-outs) among `elements` with the ids their copies get. */
function figureIdsOf(elements: readonly PageElement[] | undefined, ids: ReadonlyMap<string, string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of elements ?? []) if (e.type === "image" || e.type === "excerpt") out.set(e.id, ids.get(e.id)!);
	return out;
}

export interface DuplicateOptions {
	/**
	 * Review fix (F2): old element id -> id of its copy, shared by the pages of one operation (`duplicatePages`): the pictures the pages
	 * copied so far have their entries here, so a caption on a later page finds the copy of a picture on an earlier one.
	 */
	figures?: Map<string, string>;
	/**
	 * The copy replaces the page (pages moved to another notebook, a page restored from the page trash): its checkboxes are the same
	 * checkboxes and keep the link to their task lines. A real copy (the default) never ticks the tasks of the original. v19: the same
	 * decides the start and end times of the page: kept when the copy replaces the page, absent on a real copy.
	 */
	keepTasks?: boolean;
}

/**
 * Deep copy of a stroke with id `id` (points copied, not shared), frozen. Every field is kept, v8 `hidden`
 * included: every path that copies ink (duplicate, restore, merge, clipboard) goes through here. v12 `slide` is kept too
 * (`slide` given: replaced by it, null: left out); in another notebook it names no entry and is not written. v18 `group` is kept
 * the same way (`group` given: replaced by it, null: left out).
 */
export function copyStroke(s: Stroke, id: string = s.id, slide?: string | null, group?: string | null): Stroke {
	const points = s.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
	const copy: Stroke = { id, tool: s.tool, color: s.color, width: s.width, render: s.render, points };
	if (s.hidden) copy.hidden = true;
	const ref = slide === undefined ? s.slide : slide ?? undefined;
	if (ref !== undefined) copy.slide = ref;
	const g = group === undefined ? s.group : group ?? undefined;
	if (g !== undefined) copy.group = g;
	// v20: the nib angle of a fountain pen or a marker.
	if (s.nib !== undefined) copy.nib = s.nib;
	// v22: the fill and the line style of a shape.
	if (s.fill !== undefined) copy.fill = s.fill;
	if (s.fillTint !== undefined) copy.fillTint = s.fillTint;
	if (s.dash !== undefined) copy.dash = s.dash;
	// v24: the opacity.
	if (s.opacity !== undefined) copy.opacity = s.opacity;
	// v25: the taper of the two ends.
	if (s.taperStart !== undefined) copy.taperStart = s.taperStart;
	if (s.taperEnd !== undefined) copy.taperEnd = s.taperEnd;
	return freezeStroke(copy);
}

/**
 * Copy of a page for "duplicate page": new page id and new stroke/element ids, same size, paper,
 * background, infinite flag and content. Points are copied (not shared) and strokes and elements are
 * frozen like committed ones. Lives apart from document.ts because
 * serialize.ts -> migrations.ts -> document.ts would cycle.
 */
export function duplicatePage(page: Page, opts: DuplicateOptions = {}): Page {
	const ids = new Map<string, string>();
	const regroup = groupRenamer();
	const copy: Page = {
		id: createId(),
		width: page.width,
		height: page.height,
		paper: { kind: page.paper.kind, spacing: page.paper.spacing },
		strokes: page.strokes.map((s) => {
			const id = createId();
			ids.set(s.id, id);
			return copyStroke(s, id, undefined, s.group === undefined ? undefined : regroup(s.group));
		}),
	};
	// v13: the parts and states follow the strokes to their new ids (a copy of a drawing with states is a drawing with states).
	const states = remapStates(page.states, (id) => ids.get(id));
	if (states) copy.states = states;
	if (page.background) copy.background = { ...page.background };
	if (page.infinite !== undefined) copy.infinite = page.infinite;
	if (page.margins) copy.margins = { ...page.margins };
	// v7: the copy keeps the page's tags (its bookmark is not copied: bookmarks belong to the original page id).
	if (page.tags && page.tags.length > 0) copy.tags = [...page.tags];
	if (page.elements && page.elements.length > 0) {
		const made = page.elements.map(() => createId());
		const newIds = new Map<string, string>();
		page.elements.forEach((e, i) => {
			if (!newIds.has(e.id)) newIds.set(e.id, made[i]!);
		});
		const mine = figureIdsOf(page.elements, newIds);
		if (opts.figures) for (const [from, to] of mine) opts.figures.set(from, to);
		const known = opts.figures ?? mine;
		copy.elements = page.elements.map((e, i) => copyElement(e, opts.keepTasks === true, regroup, made[i]!, known));
	}
	// v16: the comments are about the page, so a copy of the page keeps them (same ids: they are scoped to the page).
	const comments = copyComments(page.comments, page);
	if (comments) copy.comments = comments;
	// v19: a real copy is a new page and starts without start and end times (its ink has none of its own); a page that is only moved
	// or comes back from the trash (`keepTasks`: the copy replaces the page) is the same page and keeps them.
	if (opts.keepTasks === true) putPageTimes(copy, pageTimes(page));
	return copy;
}

/**
 * Copies of several pages made in ONE operation (duplicate pages, a notebook made from a template, pages moved to another notebook).
 * 0.29 (#248) review fix (F2): a caption or reference on any of the copies that names a picture on any of the copies names the copy of
 * that picture, wherever the two pages are in the list; one that names a picture not copied keeps naming the original.
 */
export function duplicatePages(pages: readonly Page[], opts: DuplicateOptions = {}): Page[] {
	const figures = new Map<string, string>();
	const copies = pages.map((p) => duplicatePage(p, { ...opts, figures }));
	for (const copy of copies) {
		const elements = copy.elements;
		if (!elements) continue;
		elements.forEach((e, i) => {
			if (e.type !== "text") return;
			const text = remapFigureMarkers(e.text, figures);
			if (text !== e.text) elements[i] = freezeElement({ ...e, text });
		});
	}
	return copies;
}

/**
 * One blank page per PDF page, in order: page `i` has the size `sizes[i]` (pt) and shows PDF page
 * `firstPage + i` of `asset`. The caller adds the asset (AddAsset) and the pages (InsertPages) in one Batch.
 */
export function createPdfPages(
	asset: Asset,
	sizes: ReadonlyArray<{ width: number; height: number }>,
	firstPage = 1,
): Page[] {
	if (asset.kind !== "pdf") throw new Error("createPdfPages: the asset is not a PDF");
	if (!Number.isInteger(firstPage) || firstPage < 1) throw new Error("createPdfPages: firstPage must be an integer >= 1");
	return sizes.map((size, i) => {
		if (!(Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0)) {
			throw new Error(`createPdfPages: invalid size for page ${i}`);
		}
		const page = createPage({ width: size.width, height: size.height }, { kind: "blank", spacing: PAPER_SPACING.blank });
		page.background = { kind: "pdf", asset: asset.id, page: firstPage + i };
		return page;
	});
}
