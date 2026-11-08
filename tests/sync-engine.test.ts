import { describe, expect, it } from "vitest";
import { runSync, type SyncOptions } from "../src/sync/engine";
import { AuthRequiredError, TransientRemoteError } from "../src/sync/provider-types";
import { conflictBaseOf } from "../src/storage/conflicts";
import { FakeLocal, FakeProvider, MemoryState, ports } from "./sync-fakes";
import { CONFIG_DIR } from "./node-env";

const lastChanges = (calls: string[]): string | undefined => calls.filter((c) => c.startsWith("changes")).slice(-1)[0];

const OPTS: SyncOptions = {
	root: "root",
	scope: { mode: "vault", folders: [], include: [], exclude: [], types: [] },
	fixed: { configDir: CONFIG_DIR, backupFolder: "Notebook backups" },
	deletions: "guard",
	largeBytes: 0,
	large: "ask",
	approvedLarge: new Set(),
	device: "Tablet",
};

function setup() {
	const local = new FakeLocal();
	const remote = new FakeProvider();
	const state = new MemoryState();
	const sleeps: number[] = [];
	const sync = (o: Partial<SyncOptions> = {}) => runSync(ports(local, remote, state, sleeps), { ...OPTS, ...o });
	return { local, remote, state, sleeps, sync };
}

describe("cloud sync engine, end to end with a fake provider and a fake vault (#126)", () => {
	it("first sync is a union: both sides get every file, identical files are adopted, nothing is deleted", async () => {
		const { local, remote, sync } = setup();
		local.put("Notebooks/Maths.notebook", "{maths}");
		local.put("same.md", "same");
		local.put(`${CONFIG_DIR}/app.json`, "{}");
		local.put("Notebook backups/b.zip", "zip");
		remote.put("Remote/note.md", "from cloud");
		remote.put("same.md", "same");
		const r = await sync();
		expect(r.outcome).toBe("ok");
		expect(r.first).toBe(true);
		expect(remote.read("Notebooks/Maths.notebook")).toBe("{maths}");
		expect(local.get("Remote/note.md")).toBe("from cloud");
		expect(r.counts).toMatchObject({ up: 1, down: 1, conflicts: 0, delLocal: 0, delRemote: 0 });
		expect(r.events.some((e) => e.kind === "same" && e.path === "same.md")).toBe(true);
		expect(remote.read(`${CONFIG_DIR}/app.json`)).toBeUndefined();
		expect(remote.read("Notebook backups/b.zip")).toBeUndefined();
		// Second run: nothing to do.
		const again = await sync();
		expect(again.first).toBe(false);
		expect(again.counts).toMatchObject({ up: 0, down: 0 });
	});

	it("first sync with different versions keeps both: the cloud's becomes a conflicted copy the merge offer recognises", async () => {
		const { local, remote, sync } = setup();
		local.put("School/Maths.notebook", "{local}");
		remote.put("School/Maths.notebook", "{remote}");
		const r = await sync();
		expect(r.counts.conflicts).toBe(1);
		const copy = "School/Maths (conflict 2026-11-08 14.05 Tablet).notebook";
		expect(local.get(copy)).toBe("{remote}");
		expect(local.get("School/Maths.notebook")).toBe("{local}");
		expect(remote.read("School/Maths.notebook")).toBe("{local}");
		expect(remote.read(copy)).toBe("{remote}");
		expect(conflictBaseOf("Maths (conflict 2026-11-08 14.05 Tablet)", new Set(["Maths"]))).toBe("Maths");
		const again = await sync();
		expect(again.counts).toMatchObject({ up: 0, down: 0, conflicts: 0 });
	});

	it("propagates edits both ways, conditionally", async () => {
		const { local, remote, sync } = setup();
		local.put("a.md", "1");
		await sync();
		local.put("a.md", "2");
		expect((await sync()).counts.up).toBe(1);
		expect(remote.read("a.md")).toBe("2");
		remote.put("a.md", "3");
		expect((await sync()).counts.down).toBe(1);
		expect(local.get("a.md")).toBe("3");
		expect(remote.calls.filter((c) => c.startsWith("upload a.md"))).toEqual(["upload a.md new", "upload a.md r1"]);
	});

	it("a touched file with the same content is not uploaded", async () => {
		const { local, remote, sync } = setup();
		local.put("a.md", "1");
		await sync();
		local.touch("a.md");
		const before = remote.calls.length;
		const r = await sync();
		expect(r.counts.up).toBe(0);
		expect(remote.calls.slice(before).filter((c) => c.startsWith("upload"))).toEqual([]);
	});

	it("both sides changed: keeps both, never overwrites the local edit", async () => {
		const { local, remote, sync } = setup();
		local.put("n.notebook", "base");
		await sync();
		local.put("n.notebook", "mine");
		remote.put("n.notebook", "theirs");
		const r = await sync();
		expect(r.counts.conflicts).toBe(1);
		expect(local.get("n.notebook")).toBe("mine");
		expect(local.get("n (conflict 2026-11-08 14.05 Tablet).notebook")).toBe("theirs");
		expect(remote.read("n.notebook")).toBe("mine");
	});

	it("propagates deletions only from a synced, unchanged state, to the trash on both sides", async () => {
		const { local, remote, sync } = setup();
		for (const n of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) local.put(`${n}.md`, n);
		await sync();
		local.files.delete("a.md");
		remote.del("b.md");
		const r = await sync();
		expect(r.counts).toMatchObject({ delRemote: 1, delLocal: 1 });
		expect(remote.trash.map((t) => t.path)).toContain("a.md");
		expect(local.trashed).toEqual([{ path: "b.md", data: "b" }]);
		expect(remote.calls.some((c) => /^remove id\d+ r\d+$/.test(c))).toBe(true);
	});

	it("a deletion loses to an edit on the other side", async () => {
		const { local, remote, sync } = setup();
		for (const n of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) local.put(`${n}.md`, n);
		await sync();
		local.files.delete("a.md");
		remote.put("a.md", "edited in the cloud");
		remote.del("b.md");
		local.put("b.md", "edited here");
		await sync();
		expect(local.get("a.md")).toBe("edited in the cloud");
		expect(remote.read("b.md")).toBe("edited here");
		expect(local.trashed).toEqual([]);
	});

	it("the mass-deletion guard stops and asks; allowed deletes, restore brings the files back", async () => {
		const { local, remote, sync } = setup();
		for (let i = 0; i < 30; i++) local.put(`f${i}.md`, String(i));
		await sync();
		for (let i = 0; i < 25; i++) local.files.delete(`f${i}.md`);
		const held = await sync();
		expect(held.outcome).toBe("confirm");
		expect(held.heldDeletes).toHaveLength(25);
		expect(remote.files.size).toBe(30);
		const restored = await sync({ deletions: "restore" });
		expect(restored.counts.down).toBe(25);
		expect(local.files.size).toBe(30);
		for (let i = 0; i < 25; i++) local.files.delete(`f${i}.md`);
		const allowed = await sync({ deletions: "allow" });
		expect(allowed.counts.delRemote).toBe(25);
		expect(remote.files.size).toBe(5);
	});

	it("an empty listing from the cloud (wrong folder, lost data) never empties the vault", async () => {
		const { local, remote, sync } = setup();
		for (let i = 0; i < 10; i++) local.put(`f${i}.md`, String(i));
		await sync();
		for (let i = 0; i < 10; i++) remote.del(`f${i}.md`);
		const r = await sync();
		expect(r.outcome).toBe("confirm");
		expect(local.files.size).toBe(10);
		expect(local.trashed).toEqual([]);
	});

	it("a full listing on every run (the providers' index lives in memory) changes and deletes nothing by itself", async () => {
		const { local, remote, sync } = setup();
		for (let i = 0; i < 10; i++) local.put(`f${i}.md`, String(i));
		remote.put("cloud.md", "from the cloud");
		await sync();
		remote.alwaysFull = true;
		const again = await sync();
		expect(again.outcome).toBe("ok");
		expect(again.counts).toMatchObject({ up: 0, down: 0, delLocal: 0, delRemote: 0, conflicts: 0 });
		expect(remote.calls.filter((c) => c.startsWith("upload") || c.startsWith("remove"))).toHaveLength(10);
		// A file really deleted in the cloud is still seen as deleted (the listing is complete), one at a time.
		remote.del("f3.md");
		const one = await sync();
		expect(one.counts.delLocal).toBe(1);
		expect(local.files.size).toBe(10);
	});

	it("a missing cloud folder is an error, never 'everything was deleted'", async () => {
		const { local, remote, sync } = setup();
		for (let i = 0; i < 10; i++) local.put(`f${i}.md`, String(i));
		await sync();
		// RootMissingError (providers) extends TransientRemoteError.
		class RootMissingError extends TransientRemoteError {}
		for (let i = 0; i < 4; i++) remote.failures.push(new RootMissingError("the sync folder is gone"));
		const r = await sync();
		expect(["failed", "offline"]).toContain(r.outcome);
		expect(local.files.size).toBe(10);
		expect(local.trashed).toEqual([]);
	});

	it("a corrupt state means a full rescan and no deletions", async () => {
		const { local, remote, state, sync } = setup();
		for (let i = 0; i < 5; i++) local.put(`f${i}.md`, String(i));
		await sync();
		local.files.delete("f0.md");
		remote.del("f1.md");
		state.data = "{not json";
		const r = await sync();
		expect(r.damaged).toBe(true);
		expect(r.first).toBe(true);
		expect(lastChanges(remote.calls)).toBe("changes -");
		expect(r.counts.delLocal + r.counts.delRemote).toBe(0);
		expect(local.get("f0.md")).toBe("0");
		expect(remote.read("f1.md")).toBe("1");
	});

	it("re-plans when the cloud file changed during an upload", async () => {
		const { local, remote, sync } = setup();
		local.put("a.md", "1");
		await sync();
		local.put("a.md", "mine");
		remote.beforeUpload = (p) => {
			if (p === "a.md") remote.put("a.md", "sneaky");
		};
		const r = await sync();
		expect(r.counts.conflicts).toBe(1);
		expect(local.get("a.md")).toBe("mine");
		expect(local.get("a (conflict 2026-11-08 14.05 Tablet).md")).toBe("sneaky");
		expect(remote.read("a.md")).toBe("mine");
	});

	it("retries transient errors with the retry-after, then gives up and says so", async () => {
		const { local, remote, sleeps, sync } = setup();
		local.put("a.md", "1");
		remote.failures.push(new TransientRemoteError("429", 1500), new TransientRemoteError("503"));
		const ok = await sync();
		expect(ok.outcome).toBe("ok");
		expect(sleeps).toEqual([1500, 2000]);
		remote.failures.push(new TransientRemoteError("down"), new TransientRemoteError("down"), new TransientRemoteError("down", 9000));
		local.put("a.md", "2");
		const off = await sync();
		expect(off.outcome).toBe("offline");
		expect(off.retryAfterMs).toBe(9000);
		expect(remote.read("a.md")).toBe("1");
		// Nothing lost: the next run sends it.
		expect((await sync()).counts.up).toBe(1);
		expect(remote.read("a.md")).toBe("2");
	});

	it("stops on a sign-in problem and keeps the state", async () => {
		const { local, remote, state, sync } = setup();
		local.put("a.md", "1");
		await sync();
		const saved = JSON.stringify(state.data);
		remote.failures.push(new AuthRequiredError("gdrive"));
		const r = await sync();
		expect(r.outcome).toBe("auth");
		expect(JSON.stringify(state.data)).toBe(saved);
	});

	it("an open notebook is saved before upload, and never replaced while it holds unsaved changes", async () => {
		const { local, remote, sync } = setup();
		local.put("n.notebook", "v1");
		local.open.set("n.notebook", { unsaved: false, flushes: 0 });
		await sync();
		expect(local.open.get("n.notebook")!.flushes).toBeGreaterThan(0);
		remote.put("n.notebook", "v2 from the cloud");
		local.open.set("n.notebook", { unsaved: true, flushes: 0 });
		const r = await sync();
		expect(local.get("n.notebook")).toBe("v1");
		expect(local.get("n (conflict 2026-11-08 14.05 Tablet).notebook")).toBe("v2 from the cloud");
		expect(r.counts.conflicts).toBe(1);
		// Saved now: the local version goes up on the next run (the cloud's is kept as the copy).
		local.open.set("n.notebook", { unsaved: false, flushes: 0 });
		local.put("n.notebook", "v1 + edits");
		await sync();
		expect(remote.read("n.notebook")).toBe("v1 + edits");
		expect(local.files.size).toBe(2);
	});

	it("a local file changed while the run was planning is never overwritten", async () => {
		const { local, remote, sync } = setup();
		local.put("a.md", "1");
		await sync();
		remote.put("a.md", "cloud");
		const realStat = local.stat.bind(local);
		let n = 0;
		local.stat = async (p) => {
			if (p === "a.md" && n++ === 0) local.put("a.md", "typed meanwhile");
			return realStat(p);
		};
		const r = await sync();
		expect(local.get("a.md")).toBe("typed meanwhile");
		expect(r.events.some((e) => e.kind === "skip" && e.detail === "changed")).toBe(true);
		local.stat = realStat;
		const next = await sync();
		expect(next.counts.conflicts).toBe(1);
		expect(local.get("a.md")).toBe("typed meanwhile");
	});

	it("large files: ask (others go on), approved later; or skipped", async () => {
		const { local, remote, sync } = setup();
		local.put("big.pdf", "x".repeat(100));
		local.put("small.md", "s");
		const r = await sync({ largeBytes: 50 });
		expect(r.outcome).toBe("confirm");
		expect(r.askLarge).toEqual([{ path: "big.pdf", size: 100 }]);
		expect(remote.read("small.md")).toBe("s");
		expect(remote.read("big.pdf")).toBeUndefined();
		await sync({ largeBytes: 50, approvedLarge: new Set(["big.pdf"]) });
		expect(remote.read("big.pdf")).toBe("x".repeat(100));
		local.put("huge.bin", "y".repeat(200));
		const skipped = await sync({ largeBytes: 50, large: "skip" });
		expect(skipped.outcome).toBe("partial");
		expect(skipped.skippedLarge.map((s) => s.path)).toEqual(["huge.bin"]);
	});

	it("follows the delta cursor, and a scope change lists everything again without deleting", async () => {
		const { local, remote, sync } = setup();
		local.put("School/a.md", "a");
		local.put("Work/b.md", "b");
		await sync();
		await sync();
		expect(lastChanges(remote.calls)).toMatch(/^changes c\d+$/);
		const narrow = await sync({ scope: { mode: "folders", folders: ["School"], include: [], exclude: [], types: [] } });
		expect(lastChanges(remote.calls)).toBe("changes -");
		expect(narrow.counts.delLocal + narrow.counts.delRemote).toBe(0);
		local.files.delete("Work/b.md");
		await sync({ scope: { mode: "folders", folders: ["School"], include: [], exclude: [], types: [] } });
		expect(remote.read("Work/b.md")).toBe("b");
	});

	it("two cloud files with one name that cannot be kept apart are skipped instead of guessing (review W22 S4)", async () => {
		const { local, remote, sync } = setup();
		remote.put("dup.md", "one");
		const orig = remote.changes.bind(remote);
		remote.changes = async (c) => {
			const ch = await orig(c);
			return { ...ch, upserts: [...ch.upserts, { ...ch.upserts[0]!, id: "other" }] };
		};
		remote.remove = () => Promise.reject(new Error("refused"));
		const r = await sync();
		expect(local.get("dup.md")).toBeUndefined();
		expect(r.events).toContainEqual({ kind: "skip", path: "dup.md", detail: "duplicate" });
	});
});
