import { isNibPen, NIB_DEFAULT, NIB_MAX, type Tool } from "../model/types";

/**
 * The kinds of pen the *pen* tool can write with (0.22, roadmap #35). Each is a stroke tool of the document (`Stroke.tool`): the ballpoint
 * pen is "pen", the others are the format v20 tools. The highlighter is a tool of its own, not a kind. Pure: no 'obsidian'.
 */
export const PEN_KINDS = ["pen", "fountain", "brush", "marker"] as const;
export type PenKind = (typeof PEN_KINDS)[number];

export function isPenKind(v: unknown): v is PenKind {
	return typeof v === "string" && (PEN_KINDS as readonly string[]).includes(v);
}

/** The stroke tool a kind writes with. */
export function kindTool(kind: PenKind): Tool {
	return kind;
}

/** Does this kind have a nib angle? (The fountain pen and the marker do.) */
export function kindHasNib(kind: PenKind): boolean {
	return isNibPen(kind);
}

/** Nib angle presets of the options row, degrees. */
export const NIB_PRESETS = [0, 30, 45, 60, 90, 120, 135, 150] as const;
export const NIB_STEP = 5;

/** A nib angle from anything: whole degrees, folded into [0, 179] (the nib is a line); anything else is the default. */
export function normaliseNib(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return NIB_DEFAULT;
	const r = Math.round(v) % 180;
	return Math.min(NIB_MAX, r < 0 ? r + 180 : r);
}

/** The `nib` field a new stroke of this kind stores: only the nib pens have one, and the default angle is left out (absent = 45). */
export function strokeNib(kind: Tool, angle: number): number | undefined {
	if (!isNibPen(kind)) return undefined;
	const a = normaliseNib(angle);
	return a === NIB_DEFAULT ? undefined : a;
}
