import { describe, expect, it } from "vitest";
import { blocker, lockedLeaving, lockedToLeave, pageRanges, splitCounts, splitPossible, type TransferPageItem, type TransferState } from "../src/library/transfer-logic";

const pages = (n: number, locked: number[] = []): TransferPageItem[] =>
	Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, number: i + 1, excerpt: "", locked: locked.includes(i + 1) }));

function state(over: Partial<TransferState>): TransferState {
	return {
		kind: "extract", pages: pages(4), selected: new Set(), extractMode: "copy", splitAt: 2, other: null, trashOther: false, name: "New", confirmedLocked: false, ...over,
	};
}

describe("split counts", () => {
	it("tells what stays and what goes, and when a split is possible", () => {
		expect(splitCounts(5, 2)).toEqual({ stay: 2, go: 3 });
		expect(splitCounts(5, 9)).toEqual({ stay: 5, go: 0 });
		expect(splitPossible(5, 1)).toBe(true);
		expect(splitPossible(5, 4)).toBe(true);
		expect(splitPossible(5, 0)).toBe(false);
		expect(splitPossible(5, 5)).toBe(false);
		expect(splitPossible(1, 1)).toBe(false);
		expect(splitPossible(5, 2.5)).toBe(false);
	});
});

describe("locked pages that would leave", () => {
	it("counts only the leaving ones", () => {
		expect(lockedLeaving(pages(4, [2, 4]), new Set(["p1", "p2"]))).toBe(1);
		expect(lockedLeaving(pages(4), new Set(["p1"]))).toBe(0);
	});

	it("copying takes nothing out; moving, splitting and trashing do", () => {
		const locked = pages(4, [3]);
		expect(lockedToLeave(state({ pages: locked, selected: new Set(["p3"]), extractMode: "copy" }))).toBe(0);
		expect(lockedToLeave(state({ pages: locked, selected: new Set(["p3"]), extractMode: "move" }))).toBe(1);
		expect(lockedToLeave(state({ kind: "split", pages: locked, splitAt: 2 }))).toBe(1);
		expect(lockedToLeave(state({ kind: "split", pages: locked, splitAt: 3 }))).toBe(0);
		expect(lockedToLeave(state({ kind: "merge", other: { path: "B", locked: 2 }, trashOther: false }))).toBe(0);
		expect(lockedToLeave(state({ kind: "merge", other: { path: "B", locked: 2 }, trashOther: true }))).toBe(2);
	});
});

describe("when the dialog may go on", () => {
	it("extract needs pages and a name, and the tick for locked pages that leave", () => {
		expect(blocker(state({}))).toBe("no-pages");
		expect(blocker(state({ selected: new Set(["p1"]), name: "  " }))).toBe("no-name");
		expect(blocker(state({ selected: new Set(["p1"]) }))).toBeNull();
		const locked = state({ pages: pages(4, [1]), selected: new Set(["p1"]), extractMode: "move" });
		expect(blocker(locked)).toBe("unconfirmed-locked");
		expect(blocker({ ...locked, confirmedLocked: true })).toBeNull();
		expect(blocker({ ...locked, extractMode: "copy" })).toBeNull();
	});

	it("split needs a page after the first and a name", () => {
		expect(blocker(state({ kind: "split", splitAt: 0 }))).toBe("bad-split");
		expect(blocker(state({ kind: "split", splitAt: 4 }))).toBe("bad-split");
		expect(blocker(state({ kind: "split", splitAt: 1, name: "" }))).toBe("no-name");
		expect(blocker(state({ kind: "split", splitAt: 3 }))).toBeNull();
	});

	it("merge needs a notebook, and waits for its lock count before a trash", () => {
		expect(blocker(state({ kind: "merge" }))).toBe("no-notebook");
		expect(blocker(state({ kind: "merge", other: { path: "B", locked: null } }))).toBeNull();
		expect(blocker(state({ kind: "merge", other: { path: "B", locked: null }, trashOther: true }))).toBe("reading");
		expect(blocker(state({ kind: "merge", other: { path: "B", locked: 1 }, trashOther: true }))).toBe("unconfirmed-locked");
		expect(blocker(state({ kind: "merge", other: { path: "B", locked: 1 }, trashOther: true, confirmedLocked: true }))).toBeNull();
		expect(blocker(state({ kind: "merge", other: { path: "B", locked: 0 }, trashOther: true }))).toBeNull();
	});
});

describe("page ranges", () => {
	it("joins neighbours", () => {
		expect(pageRanges([1, 2, 3, 5])).toBe("1–3, 5");
		expect(pageRanges([7])).toBe("7");
		expect(pageRanges([4, 2, 3, 2])).toBe("2–4");
		expect(pageRanges([])).toBe("");
	});
});
