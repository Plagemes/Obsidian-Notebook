// STUB (LIBHOME branch): placeholder of the ART agent's subject palette, same contract (common brief). Replaced at merge.
/** Subject palette (DESIGN.md §2.3). */
export interface SubjectColor {
	readonly name: string;
	readonly base: string;
	readonly tint: string;
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

/** A stable colour for a name: a hash into the palette. */
export function colorFor(name: string): string {
	let h = 2166136261;
	for (const ch of name.trim().toLowerCase()) {
		h ^= ch.codePointAt(0) ?? 0;
		h = Math.imul(h, 16777619);
	}
	return SUBJECT_COLORS[(h >>> 0) % SUBJECT_COLORS.length]!.base;
}
