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
	compact: { target: 36, icon: 16, slot: 40, dial: 0.9 },
	normal: { target: 40, icon: 18, slot: 44, dial: 1 },
	large: { target: 48, icon: 24, slot: 52, dial: 1.2 },
};

export function toolbarScale(size: ToolbarSize): ToolbarScale {
	return PRESETS[size];
}

/** The dial scale: the designed size times the setting, never more than fits the view (`fit`) and never below 0.6. */
export function dialScale(fit: number, size: ToolbarSize): number {
	return Math.max(0.6, Math.min(PRESETS[size].dial, fit));
}

/**
 * The row of tools (pages panel and seven tools) wraps to a second line when it does not fit the width at this size,
 * so that nothing goes beyond the edge. Padding and the divider as in styles.css.
 */
export function toolsRowWraps(size: ToolbarSize, width: number): boolean {
	const s = PRESETS[size];
	// 8 buttons, 7 gaps of 2 px, the divider (1 px + 2 x 4 px margin) and the 12 px padding of the bar.
	return 8 * s.target + 14 + 9 > width - 12;
}
