import type { MessageKey } from "../i18n/en";
import { analyzeDimensions, describeDimension, type Dim, type DimensionIssue } from "../math/dimensions";

/**
 * The words of the units hint of the equation editor (#293): turns the issues of the dimension check into the sentences
 * the editor shows. Pure (no 'obsidian'); the caller passes the translator.
 */

export type Translate = (key: MessageKey, vars?: Record<string, string>) => string;

/** How many issues the hint spells out; the rest is counted. */
export const HINT_MAX_SHOWN = 2;

function describe(d: Dim | null, tr: Translate): string {
	if (!d) return "?";
	const { si, quantity } = describeDimension(d);
	if (quantity === "dimensionless" || si === "1") return tr("dimcheck.dimensionless");
	return quantity ? `${tr(`dimcheck.q.${quantity}` as MessageKey)}, ${si}` : si;
}

/** One issue as a sentence. */
export function issueText(i: DimensionIssue, tr: Translate): string {
	const leftDesc = describe(i.leftDim, tr);
	const rightDesc = describe(i.rightDim, tr);
	switch (i.kind) {
		case "sum":
			return tr(i.op === "-" ? "dimcheck.sum.sub" : "dimcheck.sum.add", { left: i.left, leftDesc, right: i.right, rightDesc });
		case "relation":
			return tr(i.op === "=" || i.op === "~=" || i.op === "def" || i.op === "!=" ? "dimcheck.relation.eq" : "dimcheck.relation.cmp", { left: i.left, leftDesc, right: i.right, rightDesc });
		case "unit-missing":
			return i.bare === "left"
				? tr("dimcheck.unitMissing", { bare: i.left, other: i.right, otherDesc: rightDesc })
				: tr("dimcheck.unitMissing", { bare: i.right, other: i.left, otherDesc: leftDesc });
		case "exponent":
			return tr("dimcheck.exponent", { right: i.right, rightDesc });
		case "function":
			return tr("dimcheck.function", { left: i.left, right: i.right, rightDesc });
	}
}

export interface DimensionHint {
	/** The sentences to show (at most `HINT_MAX_SHOWN`). */
	lines: string[];
	/** Issues beyond the ones shown. */
	more: number;
	/** No issue, and at least one comparison involved a unit or a symbol of known dimension. */
	consistent: boolean;
}

/** The hint for a formula, or null when there is nothing to say (no issue and nothing was checked). */
export function dimensionHint(latex: string, tr: Translate): DimensionHint | null {
	if (latex.trim() === "") return null;
	const r = analyzeDimensions(latex);
	if (r.issues.length === 0) return r.checked > 0 ? { lines: [], more: 0, consistent: true } : null;
	return {
		lines: r.issues.slice(0, HINT_MAX_SHOWN).map((i) => issueText(i, tr)),
		more: Math.max(0, r.issues.length - HINT_MAX_SHOWN),
		consistent: false,
	};
}
