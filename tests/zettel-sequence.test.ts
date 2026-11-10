import { describe, expect, it } from "vitest";
import { idSet } from "../src/zettel/ids";
import { branchId, compareSequenceIds, depthOf, followUpId, idsInNames, isSequenceId, neighbours, parentId, sequenceCardId } from "../src/zettel/sequence";

const sorted = (ids: string[]) => [...ids].sort(compareSequenceIds);

describe("sequence order", () => {
	it("puts a card before its branches and numbers as numbers", () => {
		expect(sorted(["10", "2", "1b", "1a1", "1", "1a"])).toEqual(["1", "1a", "1a1", "1b", "2", "10"]);
		expect(sorted(["2", "1", "10", "9"])).toEqual(["1", "2", "9", "10"]);
	});

	it("letters run on after z (aa after z) and deep levels compare level by level", () => {
		expect(sorted(["1aa", "1z", "1b", "1a"])).toEqual(["1a", "1b", "1z", "1aa"]);
		expect(sorted(["1a10", "1a2", "1a2b", "1a2a", "1a1"])).toEqual(["1a1", "1a2", "1a2a", "1a2b", "1a10"]);
	});

	it("ignores case and is total (equal values fall back to text)", () => {
		expect(compareSequenceIds("1A", "1a")).toBe(0);
		expect(compareSequenceIds("1a", "1a")).toBe(0);
		expect(compareSequenceIds("01", "1")).toBe(-1);
		expect(sorted(["1B", "1a"])).toEqual(["1a", "1B"]);
	});

	it("puts ids that are not Luhmann-style (timestamps) after the numbered ones", () => {
		expect(sorted(["20261029144207-k3f9", "2", "1a"])).toEqual(["1a", "2", "20261029144207-k3f9"]);
		expect(isSequenceId("20261029144207-k3f9")).toBe(false);
		expect(isSequenceId("1a2")).toBe(true);
	});
});

describe("parent", () => {
	it("cuts the last group", () => {
		expect(parentId("1a2")).toBe("1a");
		expect(parentId("1a")).toBe("1");
		expect(parentId("12bc34")).toBe("12bc");
		expect(parentId("1")).toBeNull();
		expect(parentId("1A")).toBe("1");
		expect(parentId("x1")).toBeNull();
		expect(parentId("")).toBeNull();
		expect(depthOf("1a2")).toBe(3);
		expect(depthOf("nope")).toBe(0);
	});
});

describe("neighbours", () => {
	const ids = ["1", "1a", "1a1", "1a2", "1b", "2", "10", "20261029144207-k3f9"];

	it("finds parent, previous, next and children", () => {
		expect(neighbours("1a", ids)).toEqual({ parent: "1", previous: null, next: "1b", children: ["1a1", "1a2"] });
		expect(neighbours("1b", ids)).toEqual({ parent: "1", previous: "1a", next: null, children: [] });
		expect(neighbours("1a2", ids)).toEqual({ parent: "1a", previous: "1a1", next: null, children: [] });
		expect(neighbours("2", ids)).toEqual({ parent: null, previous: "1", next: "10", children: [] });
		expect(neighbours("1", ids)).toEqual({ parent: null, previous: null, next: "2", children: ["1a", "1b"] });
	});

	it("skips a missing parent: the nearest card above is the parent and the cards stay reachable", () => {
		const gap = ["1", "1a1", "1a2", "1b"];
		expect(neighbours("1a1", gap)).toEqual({ parent: "1", previous: null, next: "1a2", children: [] });
		expect(neighbours("1", gap).children).toEqual(["1a1", "1a2", "1b"]);
		expect(neighbours("1b", gap)).toEqual({ parent: "1", previous: "1a2", next: null, children: [] });
	});

	it("works for a card that is not there yet (a card about to be made)", () => {
		expect(neighbours("1c", ["1", "1a", "1b", "2"])).toEqual({ parent: "1", previous: "1b", next: null, children: [] });
		expect(neighbours("1a1", ["1", "1a"])).toEqual({ parent: "1a", previous: null, next: null, children: [] });
	});

	it("handles a card renamed to another id and mixed-case or duplicate ids", () => {
		// 1b was renamed 3 by hand: it is a top-level card now and leaves the branches of 1.
		const renamed = ["1", "1a", "3", "2"];
		expect(neighbours("1", renamed).children).toEqual(["1a"]);
		expect(neighbours("3", renamed)).toEqual({ parent: null, previous: "2", next: null, children: [] });
		expect(neighbours("1A", ["1", "1a", "1B", "1b"])).toEqual({ parent: "1", previous: null, next: "1b", children: [] });
	});

	it("gives nothing for an id that is not Luhmann-style", () => {
		expect(neighbours("20261029144207-k3f9", ids)).toEqual({ parent: null, previous: null, next: null, children: [] });
	});
});

describe("follow-up and branch ids", () => {
	it("follow-up is the next sibling, branch the first child", () => {
		const taken = idSet(["1", "1a", "2"]);
		expect(followUpId("1a", taken)).toBe("1b");
		expect(branchId("1a", taken)).toBe("1a1");
		expect(branchId("1", taken)).toBe("1b");
		expect(followUpId("2", taken)).toBe("3");
		expect(followUpId("1a1", idSet(["1a1"]))).toBe("1a2");
	});

	it("a follow-up skips taken ids and fills a gap right after the card", () => {
		expect(followUpId("1a", idSet(["1a", "1b", "1c"]))).toBe("1d");
		expect(followUpId("1a", idSet(["1a", "1c"]))).toBe("1b");
		expect(followUpId("1", idSet(["1", "2", "3"]))).toBe("4");
		expect(followUpId("9", idSet(["9"]))).toBe("10");
		expect(followUpId("1z", idSet(["1z"]))).toBe("1aa");
	});

	it("a branch is one past the last branch: a deleted branch id is not reused", () => {
		expect(branchId("1", idSet(["1", "1a", "1c"]))).toBe("1d");
		expect(branchId("1a", idSet(["1a", "1a1", "1a3"]))).toBe("1a4");
		expect(branchId("1z", idSet(["1z", "1z9"]))).toBe("1z10");
		expect(branchId("1", idSet(["1", "1z"]))).toBe("1aa");
	});

	it("a branch does not count cards of other branches or deeper levels", () => {
		expect(branchId("1", idSet(["1", "1a", "1a1", "1a2", "10", "10a"]))).toBe("1b");
		expect(branchId("1a", idSet(["1a", "1ab", "1a1b"]))).toBe("1a1");
	});

	it("is case-insensitive and null for ids outside the numbering", () => {
		expect(followUpId("1A", idSet(["1a", "1B"]))).toBe("1c");
		expect(branchId("1A", idSet(["1a"]))).toBe("1a1");
		expect(followUpId("20261029144207-k3f9", new Set())).toBeNull();
		expect(branchId("nope", new Set())).toBeNull();
	});

	it("never answers an id that is taken", () => {
		const taken = idSet(["1", "1a", "1b", "1b1", "1c", "2", "2a", "3"]);
		for (const origin of ["1", "1a", "1b", "1b1", "2", "3"]) {
			expect(taken.has(followUpId(origin, taken)!)).toBe(false);
			expect(taken.has(branchId(origin, taken)!)).toBe(false);
		}
	});
});

describe("ids used by note names", () => {
	it("reads the id a name starts with", () => {
		expect(idsInNames(["1a Energy", "2-k3f9", "1b", "Plan", "3. Notes", "1A.md-like", "12bc34 deep"])).toEqual(["1a", "2", "1b", "3", "1a", "12bc34"]);
	});

	it("skips dates and timestamps, and names that do not start with a number", () => {
		expect(idsInNames(["20261029 Plan", "20261029144207-k3f9", "Report 2024", "a1", "10"])).toEqual(["10"]);
	});

	it("a new card does not take the id of an existing note that is not a card", () => {
		expect(sequenceCardId("follow-up", "1a", ["1", "1a"], idsInNames(["1b Energy"]))).toBe("1c");
		expect(sequenceCardId("branch", "1", ["1"], idsInNames(["1a", "1b notes"]))).toBe("1c");
		expect(sequenceCardId("branch", "1a", ["1a"], [])).toBe("1a1");
		expect(sequenceCardId("follow-up", "x", ["1"], [])).toBeNull();
	});

	it("a note in the gap fills the conflict: the next free id is chosen", () => {
		expect(sequenceCardId("follow-up", "1a", ["1a", "1c"], ["1b"])).toBe("1d");
	});
});
