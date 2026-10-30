import { elementBounds, transformElement, type MeasureText } from "../elements";
import { transformStroke } from "../lasso";
import { estimateMeasure } from "../text-layout";
import { translate } from "../transform";
import type { PageContentPlan } from "../../model/page-content";
import { freezeStroke } from "../../model/serialize";
import type { NotebookDocument, PageElement, Stroke } from "../../model/types";

/**
 * Moves the selected strokes and objects to another page, keeping their place (shifted just enough to stay on the
 * page when it is smaller). One content plan: the source page without them, the target page with them.
 */
export function movePlan(
	doc: NotebookDocument, sel: { pageIndex: number; strokes: readonly Stroke[]; elements: readonly PageElement[] }, target: number, measure: MeasureText = estimateMeasure,
): PageContentPlan | null {
	const from = doc.pages[sel.pageIndex], to = doc.pages[target];
	if (!from || !to || from === to) return null;
	const strokeSet = new Set(sel.strokes), elementSet = new Set(sel.elements);
	const strokes = from.strokes.filter((s) => strokeSet.has(s));
	const elements = (from.elements ?? []).filter((e) => elementSet.has(e));
	if (strokes.length === 0 && elements.length === 0) return null;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const s of strokes) for (const [x, y] of s.points) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	for (const e of elements) {
		const b = elementBounds(e, measure);
		minX = Math.min(minX, b.minX);
		maxX = Math.max(maxX, b.maxX);
		minY = Math.min(minY, b.minY);
		maxY = Math.max(maxY, b.maxY);
	}
	// Shift into the target page only when the content would otherwise stick out of it.
	const dx = Number.isFinite(maxX) ? Math.min(0, to.width - maxX) + Math.max(0, -minX) : 0;
	const dy = Number.isFinite(maxY) && !to.infinite ? Math.min(0, to.height - maxY) + Math.max(0, -minY) : 0;
	const m = translate(dx, dy);
	const moved = strokes.map((s) => (dx === 0 && dy === 0 ? s : freezeStroke(transformStroke(s, m))));
	const movedEls = elements.map((e) => (dx === 0 && dy === 0 ? e : transformElement(e, m, measure)));
	const keepEls = (from.elements ?? []).filter((e) => !elementSet.has(e));
	const targetEls = [...(to.elements ?? []), ...movedEls];
	return {
		changes: [
			{ pageId: from.id, strokes: from.strokes.filter((s) => !strokeSet.has(s)), elements: keepEls.length > 0 ? keepEls : undefined },
			{ pageId: to.id, strokes: [...to.strokes, ...moved], elements: targetEls.length > 0 ? targetEls : undefined },
		],
		appended: [],
	};
}
