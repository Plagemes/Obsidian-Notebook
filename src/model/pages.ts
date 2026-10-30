import { createId, createPage } from "./document";
import { freezeElement, freezeStroke } from "./serialize";
import { PAPER_SPACING, type Asset, type Page, type PageElement, type Stroke } from "./types";

function copyElement(el: PageElement): PageElement {
	return freezeElement({ ...el, id: createId() });
}

/**
 * Deep copy of a stroke with id `id` (points copied, not shared), frozen. Every field is kept, v8 `hidden`
 * included: every path that copies ink (duplicate, restore, merge, clipboard) goes through here.
 */
export function copyStroke(s: Stroke, id: string = s.id): Stroke {
	const points = s.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
	return freezeStroke(s.hidden
		? { id, tool: s.tool, color: s.color, width: s.width, render: s.render, hidden: true, points }
		: { id, tool: s.tool, color: s.color, width: s.width, render: s.render, points });
}

/**
 * Copy of a page for "duplicate page": new page id and new stroke/element ids, same size, paper,
 * background, infinite flag and content. Points are copied (not shared) and strokes and elements are
 * frozen like committed ones. Lives apart from document.ts because
 * serialize.ts -> migrations.ts -> document.ts would cycle.
 */
export function duplicatePage(page: Page): Page {
	const copy: Page = {
		id: createId(),
		width: page.width,
		height: page.height,
		paper: { kind: page.paper.kind, spacing: page.paper.spacing },
		strokes: page.strokes.map((s) => copyStroke(s, createId())),
	};
	if (page.background) copy.background = { ...page.background };
	if (page.infinite !== undefined) copy.infinite = page.infinite;
	if (page.margins) copy.margins = { ...page.margins };
	// v7: the copy keeps the page's tags (its bookmark is not copied: bookmarks belong to the original page id).
	if (page.tags && page.tags.length > 0) copy.tags = [...page.tags];
	if (page.elements && page.elements.length > 0) copy.elements = page.elements.map(copyElement);
	return copy;
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
