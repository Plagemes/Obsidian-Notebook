import type { Stroke } from "../model/types";

/**
 * Selective eraser: which ink the eraser is allowed to touch.
 * - `all`: everything (the default);
 * - `highlighter`: highlighter strokes only;
 * - `pen`: pen and shape strokes (everything that is not a highlighter);
 * - `color`: strokes of one colour (any tool).
 */
export const ERASE_FILTER_KINDS = ["all", "highlighter", "pen", "color"] as const;
export type EraseFilterKind = (typeof ERASE_FILTER_KINDS)[number];

export interface EraseFilter {
	kind: EraseFilterKind;
	/** `#rrggbb`, used by the `color` filter. */
	color: string;
}

export function isEraseFilterKind(value: unknown): value is EraseFilterKind {
	return ERASE_FILTER_KINDS.includes(value as EraseFilterKind);
}

/** May the eraser touch this stroke? */
export function strokeMatchesFilter(stroke: Stroke, filter: EraseFilter): boolean {
	switch (filter.kind) {
		case "all":
			return true;
		case "highlighter":
			return stroke.tool === "highlighter";
		case "pen":
			return stroke.tool !== "highlighter";
		case "color":
			return stroke.color.toLowerCase() === filter.color.toLowerCase();
	}
}

/** The strokes the eraser may touch, in document order (the same array when the filter lets everything through). */
export function filterErasable(strokes: readonly Stroke[], filter: EraseFilter): readonly Stroke[] {
	return filter.kind === "all" ? strokes : strokes.filter((s) => strokeMatchesFilter(s, filter));
}
