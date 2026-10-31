// wave 0.9 (370): adjustable toolbar size. Pure: no DOM, no 'obsidian'. The view turns the numbers into CSS variables
// (--nb-target, --nb-icon) on its root, the layout engine uses `slot` to count how many quick actions fit, and the radial
// menu multiplies its dial by `dial`.

export const TOOLBAR_SIZES = ["compact", "normal", "large"] as const;
export type ToolbarSize = typeof TOOLBAR_SIZES[number];
export const DEFAULT_TOOLBAR_SIZE: ToolbarSize = "normal";

export function isToolbarSize(v: unknown): v is ToolbarSize {
	return typeof v === "string" && (TOOLBAR_SIZES as readonly string[]).includes(v);
}

export interface ToolbarScale {
	/** Side of an icon button, CSS px (the touch target). */
	target: number;
	/** Icon size, CSS px. */
	icon: number;
	/** One button and its gap: what the layout engine budgets per quick slot. */
	slot: number;
	/** Multiplier of the radial dial (1 = the designed size). */
	dial: number;
}

const PRESETS: Record<ToolbarSize, ToolbarScale> = {
	// 0.13: touch targets of at least 40 px even when compact, and 44 px at the normal size (DESIGN.md §7; S Pen and finger).
	compact: { target: 40, icon: 18, slot: 44, dial: 0.9 },
	normal: { target: 44, icon: 20, slot: 48, dial: 1 },
	large: { target: 52, icon: 24, slot: 56, dial: 1.2 },
};

export function toolbarScale(size: ToolbarSize): ToolbarScale {
	return PRESETS[size];
}

/** Whether a row of tools of buttons `target` px wide does not fit `width` (8 buttons, 7 gaps of 2 px, the capsule of the seven tools (2 x (2 px padding + 1 px border)), the dock's gap and the 12 px padding of the bar: styles.css, 0.13 block). */
function rowOverflows(target: number, width: number): boolean {
	return 8 * target + 14 + 6 + 8 > width - 12;
}

/**
 * The scale in use in a view `width` CSS px wide. The normal size has 44 px targets (DESIGN.md §7: S Pen and finger); on
 * a view too narrow for eight of them (a 360 px phone) it falls back to the compact 40 px, so the row of tools stays on
 * one line. The compact size is always 40 px, and the large size is the person's own choice (its tools wrap).
 */
export function toolbarScaleFor(size: ToolbarSize, width: number): ToolbarScale {
	const s = PRESETS[size];
	if (size === "normal" && rowOverflows(s.target, width)) return { ...PRESETS.compact, dial: s.dial };
	return s;
}

/** The dial scale: the designed size times the setting, never more than fits the view (`fit`) and never below 0.6. */
export function dialScale(fit: number, size: ToolbarSize): number {
	return Math.max(0.6, Math.min(PRESETS[size].dial, fit));
}

/**
 * The row of tools (pages panel and seven tools) wraps to a second line when it does not fit the width at this size,
 * so that nothing goes beyond the edge.
 */
export function toolsRowWraps(size: ToolbarSize, width: number): boolean {
	return rowOverflows(toolbarScaleFor(size, width).target, width);
}
