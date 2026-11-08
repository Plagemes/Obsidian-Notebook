import { describe, expect, it } from "vitest";
import { decide, massDeletion, plan, MASS_DELETE_MAX, type PathFacts, type PlanOptions } from "../src/sync/planner";
import { conflictCopyPath, conflictStamp, deviceLabel } from "../src/sync/conflict-name";
import { conflictBaseOf } from "../src/storage/conflicts";

const R = { id: "id1", rev: "r2", size: 10, mtime: 1 };
type L = "absent" | "same" | "changed";

function facts(local: L, remote: L, base: boolean, path = "a.md"): PathFacts {
	return {
		path,
		local: local === "absent" ? null : { size: 5, mtime: 2, changed: !base || local === "changed" },
		remote: remote === "absent" ? null : { ...R, changed: !base || remote === "changed" },
		baseRev: base ? "r1" : null,
	};
}

const OPTS: PlanOptions = { trusted: true, deletions: "guard", largeBytes: 0, large: "ask", approvedLarge: new Set() };

describe("sync planner matrix (#126)", () => {
	// [local, remote] -> action kind, with a base and a trusted state.
	const withBase: [L, L, string | null][] = [
		["absent", "absent", "forget"],
		["absent", "same", "delete-remote"],
		["absent", "changed", "download"],
		["same", "absent", "delete-local"],
		["same", "same", null],
		["same", "changed", "download"],
		["changed", "absent", "upload"],
		["changed", "same", "upload"],
		["changed", "changed", "conflict"],
	];
	for (const [l, r, kind] of withBase) {
		it(`with a base: local ${l}, remote ${r} -> ${kind ?? "nothing"}`, () => {
			expect(decide(facts(l, r, true), true)?.kind ?? null).toBe(kind);
		});
	}

	it("uploads conditionally: on the base revision, or create-only when the cloud file is gone", () => {
		expect(decide(facts("changed", "same", true), true)).toMatchObject({ kind: "upload", ifRev: "r2" });
		expect(decide(facts("changed", "absent", true), true)).toMatchObject({ kind: "upload", ifRev: null });
		expect(decide(facts("present" as L, "absent", false), true)).toMatchObject({ kind: "upload", ifRev: null });
	});

	it("deletes remotely only on the revision it saw", () => {
		expect(decide(facts("absent", "same", true), true)).toMatchObject({ kind: "delete-remote", remote: { id: "id1", rev: "r2" } });
	});

	it("without a base: union (upload, download, or compare both)", () => {
		expect(decide(facts("same", "absent", false), true)?.kind).toBe("upload");
		expect(decide(facts("absent", "same", false), true)?.kind).toBe("download");
		expect(decide(facts("same", "same", false), true)?.kind).toBe("conflict");
		expect(decide(facts("absent", "absent", false), true)).toBeNull();
	});

	it("never deletes on an untrusted state: the deletion becomes a restore", () => {
		expect(decide(facts("absent", "same", true), false)?.kind).toBe("download");
		expect(decide(facts("same", "absent", true), false)).toMatchObject({ kind: "upload", ifRev: null });
		// The rest of the matrix is the same.
		expect(decide(facts("changed", "same", true), false)?.kind).toBe("upload");
		expect(decide(facts("absent", "absent", true), false)?.kind).toBe("forget");
	});

	it("a first sync (no base anywhere) deletes nothing whatever the sides hold", () => {
		const all: PathFacts[] = [];
		for (const l of ["absent", "same"] as L[]) for (const r of ["absent", "same"] as L[]) all.push(facts(l, r, false, `${l}-${r}`));
		const p = plan(all, { ...OPTS, trusted: false });
		expect(p.actions.map((a) => a.kind).sort()).toEqual(["conflict", "download", "upload"]);
		expect(p.heldDeletes).toEqual([]);
	});

	it("orders conflicts, downloads, uploads, then deletions", () => {
		const p = plan([facts("absent", "same", true, "d"), facts("changed", "same", true, "u"), facts("same", "changed", true, "w"), facts("changed", "changed", true, "c")], OPTS);
		expect(p.actions.map((a) => a.kind)).toEqual(["conflict", "download", "upload", "delete-remote"]);
	});
});

describe("mass-deletion guard (#126)", () => {
	it("stops above the count or the share of tracked files", () => {
		expect(massDeletion(MASS_DELETE_MAX, 10_000)).toBe(false);
		expect(massDeletion(MASS_DELETE_MAX + 1, 10_000)).toBe(true);
		expect(massDeletion(2, 2)).toBe(false);
		expect(massDeletion(3, 9)).toBe(true);
		expect(massDeletion(3, 10)).toBe(false);
		expect(massDeletion(1, 1)).toBe(false);
	});

	const many = (n: number) => Array.from({ length: n }, (_, i) => facts("absent", "same", true, `f${i}.md`));

	it("holds the deletions back and runs the rest", () => {
		const p = plan([...many(25), facts("changed", "same", true, "keep.md")], OPTS);
		expect(p.heldDeletes).toHaveLength(25);
		expect(p.actions.map((a) => a.kind)).toEqual(["upload"]);
	});

	it("runs them once allowed, or restores them instead", () => {
		expect(plan(many(25), { ...OPTS, deletions: "allow" }).actions).toHaveLength(25);
		const restored = plan([...many(24), facts("same", "absent", true, "gone-remote.md")], { ...OPTS, deletions: "restore" });
		expect(restored.heldDeletes).toEqual([]);
		expect(restored.actions.filter((a) => a.kind === "download")).toHaveLength(24);
		expect(restored.actions.find((a) => a.path === "gone-remote.md")).toMatchObject({ kind: "upload", ifRev: null });
	});

	it("lets the confirmed deletions through and still holds new ones", () => {
		const confirmed = new Set(Array.from({ length: 25 }, (_, i) => `f${i}.md`));
		const p = plan(many(25), { ...OPTS, allowedDeletes: confirmed });
		expect(p.heldDeletes).toEqual([]);
		expect(p.actions).toHaveLength(25);
		const more = plan([...many(25), ...Array.from({ length: 21 }, (_, i) => facts("absent", "same", true, `g${i}.md`))], { ...OPTS, allowedDeletes: confirmed });
		expect(more.heldDeletes.map((a) => a.path).every((p) => p.startsWith("g"))).toBe(true);
		expect(more.actions).toHaveLength(25);
	});

	it("skips a large file the user declined instead of asking again", () => {
		const big: PathFacts = { path: "big.pdf", local: null, remote: { ...R, size: 100, changed: true }, baseRev: null };
		const p = plan([big], { ...OPTS, largeBytes: 50, declinedLarge: new Set(["big.pdf"]) });
		expect(p.askLarge).toEqual([]);
		expect(p.skippedLarge.map((a) => a.path)).toEqual(["big.pdf"]);
	});

	it("lets a few deletions through", () => {
		const p = plan([...many(2), ...Array.from({ length: 20 }, (_, i) => facts("same", "same", true, `s${i}`))], OPTS);
		expect(p.heldDeletes).toEqual([]);
		expect(p.actions).toHaveLength(2);
	});
});

describe("large files (#126)", () => {
	const big: PathFacts = { path: "big.pdf", local: null, remote: { ...R, size: 100, changed: true }, baseRev: null };
	const small: PathFacts = { path: "small.pdf", local: { size: 5, mtime: 1, changed: true }, remote: null, baseRev: null };

	it("asks, skips, or sends an approved one", () => {
		const ask = plan([big, small], { ...OPTS, largeBytes: 50 });
		expect(ask.askLarge.map((a) => a.path)).toEqual(["big.pdf"]);
		expect(ask.actions.map((a) => a.path)).toEqual(["small.pdf"]);
		const skip = plan([big, small], { ...OPTS, largeBytes: 50, large: "skip" });
		expect(skip.skippedLarge.map((a) => a.path)).toEqual(["big.pdf"]);
		expect(skip.askLarge).toEqual([]);
		const ok = plan([big], { ...OPTS, largeBytes: 50, approvedLarge: new Set(["big.pdf"]) });
		expect(ok.actions.map((a) => a.path)).toEqual(["big.pdf"]);
		expect(plan([big], { ...OPTS, largeBytes: 0 }).actions).toHaveLength(1);
	});
});

describe("conflicted copy names (#126 + #122)", () => {
	const at = new Date(2026, 10, 8, 14, 5);

	it("names the copy so the #122 merge offer recognises it", () => {
		const copy = conflictCopyPath("School/Maths.notebook", at, "Galaxy Tab", () => false);
		expect(copy).toBe("School/Maths (conflict 2026-11-08 14.05 Galaxy Tab).notebook");
		const stem = copy.slice(copy.lastIndexOf("/") + 1, -".notebook".length);
		expect(conflictBaseOf(stem, new Set(["Maths"]))).toBe("Maths");
	});

	it("adds a counter when the name is taken, and handles names without extension or device", () => {
		const taken = new Set(["a (conflict 2026-11-08 14.05).md", "a (conflict 2026-11-08 14.05 2).md"]);
		expect(conflictCopyPath("a.md", at, "", (p) => taken.has(p))).toBe("a (conflict 2026-11-08 14.05 3).md");
		expect(conflictCopyPath("Makefile", at, "", () => false)).toBe("Makefile (conflict 2026-11-08 14.05)");
		expect(conflictCopyPath(".x", at, "", () => false)).toBe(".x (conflict 2026-11-08 14.05)");
	});

	it("keeps the device label safe in a file name and inside the parentheses", () => {
		expect(deviceLabel("Anna's (work) PC: #1/2")).toBe("Anna's work PC 1 2");
		expect(deviceLabel("x".repeat(40))).toHaveLength(24);
		expect(conflictStamp(new Date(2026, 0, 2, 3, 4))).toBe("2026-01-02 03.04");
		const stem = conflictCopyPath("N.notebook", at, "Anna's (work) PC", () => false).slice(0, -".notebook".length);
		expect(conflictBaseOf(stem, new Set(["N"]))).toBe("N");
	});
});
