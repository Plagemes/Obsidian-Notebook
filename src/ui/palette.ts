// STUB (CREATE branch): the ART agent owns this file; its version replaces this one at merge. Same contract.
/** Subject palette of DESIGN.md §2.3. Pure: no 'obsidian'. */

export interface SubjectColor {
	name: string;
	/** `#rrggbb` */
	base: string;
	/** `rgba(...)` background tint. */
	tint: string;
}

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

function hash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** A stable colour of the palette for a name (a hash, not keyword matching). */
export function colorFor(name: string): string {
	return SUBJECT_COLORS[hash(name.trim().toLowerCase()) % SUBJECT_COLORS.length]!.base;
}
