// 0.14 generative UI (402): what a selection holds, so the selection bar shows the actions of that content. Pure.

/** ink: only strokes. image: only pictures. text: only text boxes. mixed: more than one of those (or anything else). object: only other objects (maths, graphs, excerpts, markers, boxes). */
export type SelectionKind = "ink" | "image" | "text" | "mixed" | "object";

export interface SelectionMix {
	strokes: number;
	images: number;
	texts: number;
	/** Selected elements that are neither pictures nor text boxes. */
	others: number;
}

/** The kind of a selection; null when nothing is selected. */
export function selectionKindOf(m: SelectionMix): SelectionKind | null {
	const present = [m.strokes > 0, m.images > 0, m.texts > 0, m.others > 0];
	const n = present.filter(Boolean).length;
	if (n === 0) return null;
	if (n > 1) return "mixed";
	if (m.strokes > 0) return "ink";
	if (m.images > 0) return "image";
	if (m.texts > 0) return "text";
	return "object";
}

/** The mix from the counts the view puts in the UI context (`texts` absent counts as 0: older callers). */
export function mixFromCounts(sel: { strokes: number; elements: number; images: number; texts?: number }): SelectionMix {
	const texts = sel.texts ?? 0;
	return { strokes: sel.strokes, images: sel.images, texts, others: Math.max(0, sel.elements - sel.images - texts) };
}
