import { describe, expect, it } from "vitest";
import { emptyState, readState, setRecord, writeState, STATE_VERSION } from "../src/sync/state";
import { normaliseSyncMemory, rememberInfo, rememberRun, MAX_LOG } from "../src/sync/sync-memory";

const HASH = "ab".repeat(32);

describe("cloud sync state (#126)", () => {
	it("round-trips and keeps fields of a newer version", () => {
		const s = emptyState("gdrive", "root1");
		s.cursor = "c9";
		s.trusted = true;
		s.scope = "k";
		setRecord(s, "a.md", { r: { id: "i", rev: "r1", size: 3, mtime: 4 }, b: { lm: 1, ls: 3, lh: HASH, rr: "r1" } });
		setRecord(s, "b.md", { r: { id: "j", rev: "r2", size: 3, mtime: 4 } });
		const stored = { ...writeState(s), future: { x: 1 } };
		const back = readState(JSON.parse(JSON.stringify(stored)), "gdrive", "root1");
		expect(back.damaged).toBe(false);
		expect(back.state.trusted).toBe(true);
		expect(back.state.cursor).toBe("c9");
		expect(back.state.paths.get("a.md")).toEqual(s.paths.get("a.md"));
		expect(writeState(back.state).future).toEqual({ x: 1 });
	});

	it("starts empty (a first sync) when nothing is stored, or for another provider or root", () => {
		const s = emptyState("gdrive", "root1");
		s.trusted = true;
		setRecord(s, "a.md", { b: { lm: 1, ls: 3, lh: HASH, rr: "r1" } });
		expect(readState(null, "gdrive", "root1")).toMatchObject({ damaged: false, state: { trusted: false } });
		expect(readState(writeState(s), "onedrive", "root1").state.paths.size).toBe(0);
		expect(readState(writeState(s), "gdrive", "root2").state.paths.size).toBe(0);
	});

	it("reads a corrupt state as untrusted, without cursor, keeping only valid records (full rescan, never mass-delete)", () => {
		for (const raw of ["garbage", 42, [], { v: 99, paths: {} }, { v: STATE_VERSION, paths: null }]) {
			const r = readState(raw, "gdrive", null);
			expect(r.damaged, JSON.stringify(raw)).toBe(true);
			expect(r.state.trusted).toBe(false);
			expect(r.state.paths.size).toBe(0);
		}
		const partly = readState({
			v: STATE_VERSION, provider: "gdrive", root: null, cursor: "c1", trusted: true,
			paths: { "ok.md": { b: [1, 2, HASH, "r"] }, "bad.md": { b: [1, 2, "not-a-hash", "r"] }, "empty.md": {}, "r.md": { r: ["i", "r", -1, 0] } },
		}, "gdrive", null);
		expect(partly.damaged).toBe(true);
		expect(partly.state.trusted).toBe(false);
		expect(partly.state.cursor).toBeNull();
		expect([...partly.state.paths.keys()]).toEqual(["ok.md"]);
	});

	it("drops records that hold nothing", () => {
		const s = emptyState("gdrive", null);
		setRecord(s, "a", { r: { id: "i", rev: "r", size: 1, mtime: 1 } });
		setRecord(s, "a", { r: null });
		expect(s.paths.size).toBe(0);
	});
});

describe("cloud sync memory (#126)", () => {
	it("keeps the last 50 entries, newest first, and reads garbage as empty", () => {
		expect(normaliseSyncMemory("x")).toEqual({ last: null, log: [] });
		let m = normaliseSyncMemory(null);
		const counts = { up: 1, down: 0, delLocal: 0, delRemote: 0, conflicts: 0, skipped: 0, errors: 0 };
		for (let i = 0; i < 30; i++) m = rememberRun(m, { at: i, outcome: "ok", counts }, [{ kind: "up", path: `f${i}` }]);
		m = rememberInfo(m, 99, "signed-in");
		expect(m.log).toHaveLength(MAX_LOG);
		expect(m.log[0]).toEqual({ at: 99, kind: "info", path: "signed-in" });
		expect(m.log[1]).toMatchObject({ kind: "run", path: "ok", at: 29 });
		const back = normaliseSyncMemory(JSON.parse(JSON.stringify(m)));
		expect(back).toEqual(m);
		expect(normaliseSyncMemory({ last: { at: 1, outcome: "weird", counts }, log: [{ at: 1, kind: "zzz", path: "x" }] })).toEqual({ last: null, log: [] });
	});
});
