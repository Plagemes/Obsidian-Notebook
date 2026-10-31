// The subject palette (DESIGN.md §2.3). Each subject gets a colour by a stable hash of its name; the user can change it.
// Pure logic: no obsidian, no DOM.
import { hex, rgbOf } from "./art/art-colour";
import { oklchRamp } from "./art/oklch";
import { hashString } from "./art/prng";

export interface SubjectColor {
	/** English identifier of the colour (not a UI string). */
	readonly name: "Red" | "Blue" | "Violet" | "Teal" | "Amber" | "Pink" | "Indigo" | "Green";
	/** Vivid base colour, `#rrggbb`: folder icon, subject card, tag dot, subject pill text. */
	readonly base: string;
	/** Tinted background (`rgba`, alpha 0.16) for everything else. */
	readonly tint: string;
}

/** The eight subject colours, in DESIGN.md order (the order `colorFor` hashes into: never reorder, only append). */
export const SUBJECT_COLORS: readonly SubjectColor[] = [
	{ name: "Red", base: "#F0565E", tint: "rgba(240,86,94,0.16)" },
	{ name: "Blue", base: "#2F80F7", tint: "rgba(47,128,247,0.16)" },
	{ name: "Violet", base: "#8B5CF6", tint: "rgba(139,92,246,0.16)" },
	{ name: "Teal", base: "#16C2A3", tint: "rgba(22,194,163,0.16)" },
	{ name: "Amber", base: "#F59E0B", tint: "rgba(245,158,11,0.16)" },
	{ name: "Pink", base: "#EC4899", tint: "rgba(236,72,153,0.16)" },
	{ name: "Indigo", base: "#6366F1", tint: "rgba(99,102,241,0.16)" },
	{ name: "Green", base: "#22C55E", tint: "rgba(34,197,94,0.16)" },
];

/** The palette entry for a name: a stable hash (trimmed, case-insensitive), so "Anatomia" always gets the same colour. */
export function subjectColorFor(name: string): SubjectColor {
	return SUBJECT_COLORS[hashString(`color:${name.trim().toLowerCase()}`) % SUBJECT_COLORS.length]!;
}

/** The base colour (`#RRGGBB`) for a name, from the subject palette. */
export function colorFor(name: string): string {
	return subjectColorFor(name).base;
}

/** The tint of a base colour from the palette (case-insensitive), or an alpha-0.16 tint computed from any `#rrggbb`. */
export function tintFor(base: string): string {
	const hit = SUBJECT_COLORS.find((c) => c.base.toLowerCase() === base.trim().toLowerCase());
	if (hit) return hit.tint;
	const m = /^#?([0-9a-f]{6})$/i.exec(base.trim());
	if (!m) return "rgba(109,139,255,0.16)";
	const n = parseInt(m[1]!, 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)`;
}

/**
 * A ramp of `steps` colours (`#rrggbb`) from dark to light with the hue of `base`, mixed in OKLCH (perceptually even
 * steps that keep the hue). For tints and gradients built from a subject colour; an invalid colour gives a ramp of
 * the accent blue.
 */
export function rampFor(base: string, steps: number): string[] {
	return oklchRamp(rgbOf(base), steps).map((c) => hex(c));
}
