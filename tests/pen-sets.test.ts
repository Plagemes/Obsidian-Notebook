import { describe, expect, it } from "vitest";
import { DEFAULT_FAVOURITES } from "../src/view/favourites";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import {
	addPenSet, ancestorFolders, assign, cleanSetName, defaultPenSets, displayName, MAX_NOTEBOOK_ASSIGNMENTS, MAX_PEN_SETS, normaliseAssignments,
	normalisePenSets, removePenSet, renamePenSet, replacePens, resolvePenSet, restoreStarters, slotsOf, STARTER_SETS, withSetPens,
} from "../src/view/pen-sets";

const sets = defaultPenSets();
const input = (over: Partial<Parameters<typeof resolvePenSet>[0]> = {}) => ({
	sets, folders: {}, notebooks: {}, notebookId: "nb-1", filePath: "Notebooks/Maths/Algebra.notebook", ...over,
});

describe("resolution order", () => {
	it("falls back to the default favourite pens when nothing is assigned", () => {
		expect(resolvePenSet(input())).toEqual({ set: null, source: "default" });
	});

	it("uses the set of the nearest folder above the notebook", () => {
		const r = resolvePenSet(input({ folders: { Notebooks: "starter-languages", "Notebooks/Maths": "starter-maths" } }));
		expect(r.set?.id).toBe("starter-maths");
		expect(r.source).toBe("folder");
		expect(r.folder).toBe("Notebooks/Maths");
	});

	it("walks up to a parent folder when the nearest has none", () => {
		const r = resolvePenSet(input({ folders: { Notebooks: "starter-science" } }));
		expect(r.set?.id).toBe("starter-science");
		expect(r.folder).toBe("Notebooks");
	});

	it("the notebook's own set wins over every folder", () => {
		const r = resolvePenSet(input({ folders: { "Notebooks/Maths": "starter-maths" }, notebooks: { "nb-1": "starter-languages" } }));
		expect(r.set?.id).toBe("starter-languages");
		expect(r.source).toBe("notebook");
	});

	it("skips an assignment to a set that no longer exists and tries the next level", () => {
		const r = resolvePenSet(input({ folders: { "Notebooks/Maths": "starter-maths" }, notebooks: { "nb-1": "deleted" } }));
		expect(r.set?.id).toBe("starter-maths");
		expect(resolvePenSet(input({ folders: { Notebooks: "deleted" } })).source).toBe("default");
	});

	it("does not match a sibling folder with a shared prefix, nor inherited object keys", () => {
		expect(resolvePenSet(input({ folders: { "Notebooks/Math": "starter-maths" } })).source).toBe("default");
		expect(resolvePenSet(input({ notebookId: "constructor" })).source).toBe("default");
		expect(resolvePenSet(input({ filePath: "toString/x.notebook", folders: {} })).source).toBe("default");
	});

	it("a notebook without a document id still gets its folder's set", () => {
		const r = resolvePenSet(input({ notebookId: null, notebooks: { "nb-1": "starter-science" }, folders: { Notebooks: "starter-maths" } }));
		expect(r.set?.id).toBe("starter-maths");
	});

	it("never changes the sets it reads", () => {
		const before = JSON.stringify(sets);
		resolvePenSet(input({ folders: { Notebooks: "starter-maths" } }));
		expect(JSON.stringify(sets)).toBe(before);
	});
});

describe("folders", () => {
	it("lists the folders above a file, nearest first", () => {
		expect(ancestorFolders("a/b/c/x.notebook")).toEqual(["a/b/c", "a/b", "a"]);
		expect(ancestorFolders("x.notebook")).toEqual([]);
		expect(ancestorFolders("/a\\b/x.notebook")).toEqual(["a/b", "a"]);
	});
});

describe("settings parsing", () => {
	it("the first run (no saved sets) has the three starter sets", () => {
		expect(normalisePenSets(undefined).map((s) => s.id)).toEqual(["starter-maths", "starter-languages", "starter-science"]);
		expect(readSettings({}).penSets).toHaveLength(3);
		expect(DEFAULT_SETTINGS.penSetFolders).toEqual({});
	});

	it("a saved empty list stays empty (deleting every set is respected)", () => {
		expect(normalisePenSets([])).toEqual([]);
		expect(readSettings({ penSets: [] }).penSets).toEqual([]);
	});

	it("drops broken entries, repeated ids and bad pens, and keeps the good ones", () => {
		const out = normalisePenSets([
			{ id: "a", name: "  Chem  istry ", pens: [{ tool: "pen", color: "#ABCDEF", width: 2 }, { tool: "brush", color: "#000000", width: 1 }, { tool: "pen", color: "red", width: 1 }, null] },
			{ id: "a", name: "Dup", pens: [{ tool: "pen", color: "#000000", width: 1 }] },
			{ id: "b", name: "", pens: [{ tool: "pen", color: "#000000", width: 1 }] },
			{ id: "c", name: "No pens", pens: [] },
			{ id: "bad id!", name: "X", pens: [{ tool: "pen", color: "#000000", width: 1 }] },
			"junk", 7, null,
		]);
		expect(out).toEqual([{ id: "a", name: "Chem istry", pens: [{ tool: "pen", color: "#abcdef", width: 2 }] }]);
	});

	it("keeps at most six pens per set and at most MAX_PEN_SETS sets", () => {
		const pens = Array.from({ length: 9 }, (_, i) => ({ tool: "pen", color: "#000000", width: i + 1 }));
		expect(normalisePenSets([{ id: "a", name: "A", pens }])[0]!.pens).toHaveLength(6);
		const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, pens: [pens[0]] }));
		expect(normalisePenSets(many)).toHaveLength(MAX_PEN_SETS);
	});

	it("reads assignments leniently and bounds them to the newest entries", () => {
		expect(normaliseAssignments("x", 5)).toEqual({});
		expect(normaliseAssignments(["a"], 5)).toEqual({});
		expect(normaliseAssignments({ a: "s", b: 3, c: "", "": "s" }, 5)).toEqual({ a: "s" });
		const big: Record<string, string> = {};
		for (let i = 0; i < MAX_NOTEBOOK_ASSIGNMENTS + 25; i++) big[`id${i}`] = "s";
		const out = normaliseAssignments(big, MAX_NOTEBOOK_ASSIGNMENTS);
		expect(Object.keys(out)).toHaveLength(MAX_NOTEBOOK_ASSIGNMENTS);
		expect(out["id0"]).toBeUndefined();
		expect(out[`id${MAX_NOTEBOOK_ASSIGNMENTS + 24}`]).toBe("s");
	});

	it("readSettings survives garbage and leaves the favourite pens alone", () => {
		const s = readSettings({ penSets: "nope", penSetFolders: [1], penSetNotebooks: { a: 1 }, favouritePens: undefined });
		expect(s.penSets.map((x) => x.id)).toEqual(["starter-maths", "starter-languages", "starter-science"]);
		expect(s.penSetFolders).toEqual({});
		expect(s.penSetNotebooks).toEqual({});
		expect(s.favouritePens).toEqual(DEFAULT_FAVOURITES);
	});

	it("a saved configuration round-trips", () => {
		const saved = { penSets: [{ id: "set-1", name: "Mine", pens: [{ tool: "highlighter", color: "#facc15", width: 14 }] }], penSetFolders: { "A/B": "set-1" }, penSetNotebooks: { x: "set-1" } };
		const s = readSettings(JSON.parse(JSON.stringify(saved)));
		expect({ penSets: s.penSets, penSetFolders: s.penSetFolders, penSetNotebooks: s.penSetNotebooks }).toEqual(saved);
	});
});

describe("editing sets", () => {
	it("a set fills the six slots, the user's favourites fill what it leaves out", () => {
		const slots = slotsOf({ id: "x", name: "X", pens: [{ tool: "pen", color: "#111111", width: 3 }] });
		expect(slots).toHaveLength(6);
		expect(slots[0]).toEqual({ tool: "pen", color: "#111111", width: 3 });
		expect(slots.slice(1)).toEqual(DEFAULT_FAVOURITES.slice(1));
		const custom = slotsOf({ id: "x", name: "X", pens: [] }, [{ tool: "pen", color: "#222222", width: 1 }]);
		expect(custom[0]).toEqual({ tool: "pen", color: "#222222", width: 1 });
	});

	it("saving a slot while a set is active writes into that set only", () => {
		const strip = slotsOf(STARTER_SETS[0]!);
		strip[2] = { tool: "pen", color: "#000001", width: 5 };
		const next = withSetPens(sets, "starter-maths", strip);
		expect(next[0]!.pens[2]).toEqual({ tool: "pen", color: "#000001", width: 5 });
		expect(next[1]).toEqual(sets[1]);
		expect(sets[0]!.pens[2]).not.toEqual(next[0]!.pens[2]);
	});

	it("adds, renames, replaces and removes without touching the input", () => {
		const frozen = JSON.stringify(sets);
		const added = addPenSet(sets, "  Physics  ", DEFAULT_FAVOURITES)!;
		expect(added.id).toBe("set-4");
		expect(added.sets[added.sets.length - 1]!.name).toBe("Physics");
		expect(addPenSet(sets, "   ", DEFAULT_FAVOURITES)).toBeNull();
		expect(addPenSet(sets, "x", [])).toBeNull();
		expect(renamePenSet(sets, "starter-maths", "Algebra")[0]!.name).toBe("Algebra");
		expect(renamePenSet(sets, "starter-maths", "  ")[0]!.name).toBe("Maths");
		expect(replacePens(sets, "starter-science", [{ tool: "pen", color: "#123456", width: 2 }])[2]!.pens).toHaveLength(1);
		const gone = removePenSet(sets, { A: "starter-maths", B: "starter-science" }, { n: "starter-maths" }, "starter-maths");
		expect(gone.sets.map((s) => s.id)).toEqual(["starter-languages", "starter-science"]);
		expect(gone.folders).toEqual({ B: "starter-science" });
		expect(gone.notebooks).toEqual({});
		expect(JSON.stringify(sets)).toBe(frozen);
	});

	it("never reaches the limit of sets silently", () => {
		const full = Array.from({ length: MAX_PEN_SETS }, (_, i) => ({ id: `s${i}`, name: `S${i}`, pens: [DEFAULT_FAVOURITES[0]!] }));
		expect(addPenSet(full, "one more", DEFAULT_FAVOURITES)).toBeNull();
		expect(restoreStarters(full)).toHaveLength(MAX_PEN_SETS);
	});

	it("restores only the starter sets that are missing, keeping edits", () => {
		const edited = renamePenSet(sets, "starter-maths", "Mine").filter((s) => s.id !== "starter-science");
		const back = restoreStarters(edited);
		expect(back.map((s) => s.id)).toEqual(["starter-maths", "starter-languages", "starter-science"]);
		expect(back[0]!.name).toBe("Mine");
	});

	it("assign sets, replaces and clears one key, and bounds the map", () => {
		expect(assign({}, "a", "s", 5)).toEqual({ a: "s" });
		expect(assign({ a: "s" }, "a", "t", 5)).toEqual({ a: "t" });
		expect(assign({ a: "s", b: "s" }, "a", null, 5)).toEqual({ b: "s" });
		const m = assign({ a: "1", b: "2", c: "3" }, "d", "4", 3);
		expect(Object.keys(m)).toEqual(["b", "c", "d"]);
		expect(assign({}, "", "s", 5)).toEqual({});
	});

	it("names are cleaned and cut", () => {
		expect(cleanSetName("  a   b ")).toBe("a b");
		expect(cleanSetName("x".repeat(100))).toHaveLength(40);
		expect(cleanSetName(5)).toBe("");
	});

	it("starter sets show in the interface language until renamed", () => {
		const tr = (k: string) => `T:${k}`;
		expect(displayName(sets[0]!, tr)).toBe("T:pensets.starter.maths");
		expect(displayName({ ...sets[0]!, name: "Mine" }, tr)).toBe("Mine");
		expect(displayName({ id: "set-1", name: "Maths", pens: sets[0]!.pens }, tr)).toBe("Maths");
	});

	it("starter sets are valid pens that survive the reader unchanged", () => {
		expect(normalisePenSets(JSON.parse(JSON.stringify(STARTER_SETS)))).toEqual(STARTER_SETS);
	});
});
