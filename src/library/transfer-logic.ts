/**
 * The decisions of the merge / split / extract dialog (library/transfer-dialog.ts), apart from the DOM: what a split leaves in
 * each notebook, which locked pages an operation would take out of a notebook, and whether the dialog may go on. Pure.
 */
export type TransferKind = "merge" | "split" | "extract";

export interface TransferPageItem {
	id: string;
	/** 1-based position in the notebook. */
	number: number;
	/** The start of the first text box (the dialog lists it beside the number), or "". */
	excerpt: string;
	locked: boolean;
}

/** Pages that stay and pages that go for a split before the page with 0-based index `at`. */
export function splitCounts(total: number, at: number): { stay: number; go: number } {
	const stay = Math.max(0, Math.min(at, total));
	return { stay, go: total - stay };
}

/** Whether a notebook of `total` pages can be split at `at` (both halves keep a page). */
export function splitPossible(total: number, at: number): boolean {
	return Number.isInteger(at) && at >= 1 && at < total;
}

/** The locked pages among those that would leave the notebook: the user has to confirm taking them out. */
export function lockedLeaving(pages: readonly TransferPageItem[], leaving: ReadonlySet<string>): number {
	return pages.reduce((n, p) => n + (p.locked && leaving.has(p.id) ? 1 : 0), 0);
}

export interface TransferState {
	kind: TransferKind;
	pages: readonly TransferPageItem[];
	/** extract: ticked pages; `copy` leaves the originals. */
	selected: ReadonlySet<string>;
	extractMode: "copy" | "move";
	/** split: 0-based index of the first page of the new notebook. */
	splitAt: number;
	/** merge: the notebook to add is chosen, and how many locked pages it has (null: not read yet). */
	other: { path: string; locked: number | null } | null;
	trashOther: boolean;
	name: string;
	/** The user ticked "locked pages may leave". */
	confirmedLocked: boolean;
}

/** Locked pages that would leave their notebook with this choice. */
export function lockedToLeave(s: TransferState): number {
	if (s.kind === "extract") return s.extractMode === "move" ? lockedLeaving(s.pages, s.selected) : 0;
	if (s.kind === "split") return lockedLeaving(s.pages, new Set(s.pages.slice(s.splitAt).map((p) => p.id)));
	return s.trashOther ? (s.other?.locked ?? 0) : 0;
}

export type Blocker = "no-notebook" | "no-pages" | "bad-split" | "no-name" | "unconfirmed-locked" | "reading";

/** Why the dialog cannot go on yet, or null. */
export function blocker(s: TransferState): Blocker | null {
	if (s.kind === "merge") {
		if (!s.other) return "no-notebook";
		if (s.trashOther && s.other.locked === null) return "reading";
	} else {
		if (s.kind === "extract" && s.selected.size === 0) return "no-pages";
		if (s.kind === "split" && !splitPossible(s.pages.length, s.splitAt)) return "bad-split";
		if (s.name.trim() === "") return "no-name";
	}
	if (lockedToLeave(s) > 0 && !s.confirmedLocked) return "unconfirmed-locked";
	return null;
}

/** Page numbers as ranges for a short sentence: [1,2,3,5] -> "1–3, 5". */
export function pageRanges(numbers: readonly number[]): string {
	const sorted = [...new Set(numbers)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length; ) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
		parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
		i = j + 1;
	}
	return parts.join(", ");
}
