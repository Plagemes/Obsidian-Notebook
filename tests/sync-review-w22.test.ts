/**
 * Review W22 (cloud sync): the fixes of the engine, the planner, the tree index and the pure helpers, over the in-memory fakes
 * (tests/sync-fakes.ts). No network, no Obsidian. The providers' own fixes are in sync-gdrive / sync-onedrive tests, the
 * service's in sync-service-w22.test.ts.
 */
import { describe, expect, it } from "vitest";
import { runSync, SAVE_EVERY_MS, type SyncOptions } from "../src/sync/engine";
import { foldKey, syncableName, syncablePath } from "../src/sync/names";
import { MASS_DELETE_AUTO_MAX, plan, type PathFacts, type PlanOptions } from "../src/sync/planner";
import { TreeIndex, type TreeItem } from "../src/sync/providers/tree";
import { withoutUrls } from "../src/sync/auth/retry";
import { CLOUD_MOBILE_MAX_MB, CLOUD_MOBILE_MIN_MB, DEFAULT_CLOUD_SYNC_SETTINGS, readCloudSyncSettings } from "../src/sync/settings";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import type { RemoteChanges } from "../src/sync/provider-types";
import { FakeLocal, FakeProvider, MemoryState, ports } from "./sync-fakes";
import { CONFIG_DIR } from "./node-env";

const enc = new TextEncoder();

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
	const sync = (o: Partial<SyncOptions> = {}) => runSync(ports(local, remote, state), { ...OPTS, ...o });
	return { local, remote, state, sync };
}

const copies = (local: FakeLocal, stem: string) => [...local.files.keys()].filter((p) => p.startsWith(`${stem} (conflict `));

describe("review W22 S4: two cloud files with one name", () => {
	it("the same content: the extra file goes to the cloud's trash and the followed one (smallest id) is synced", async () => {
		const { local, remote, sync } = setup();
		remote.put("dup.md", "one");
		const orig = remote.changes.bind(remote);
		remote.changes = async (c) => {
			const ch = await orig(c);
			return { ...ch, upserts: [...ch.upserts, ...ch.upserts.filter((u) => u.path === "dup.md").map((u) => ({ ...u, id: "zz" }))] };
		};
		const r = await sync();
		expect(local.get("dup.md")).toBe("one");
		expect(remote.calls).toContain("remove zz r1");
		expect(r.counts.conflicts).toBe(0);
	});

	it("other content: the extra file is kept as a conflicted copy (here and in the cloud), then trashed; nothing is lost", async () => {
		const { local, remote, sync } = setup();
		remote.put("dup.md", "one");
		remote.put("dup2.md", "two");
		const orig = remote.changes.bind(remote);
		remote.changes = async (c) => {
			const ch: RemoteChanges = await orig(c);
			return { ...ch, upserts: ch.upserts.map((u) => (u.path === "dup2.md" ? { ...u, path: "dup.md", hash: "other" } : u)) };
		};
		const r = await sync();
		expect(local.get("dup.md")).toBe("one");
		const [copy] = copies(local, "dup");
		expect(copy).toBeDefined();
		expect(local.get(copy!)).toBe("two");
		expect(remote.read(copy!)).toBe("two");
		expect(remote.files.has("dup2.md")).toBe(false);
		expect(remote.trash.map((t) => t.data)).toContain("two");
		expect(r.counts.conflicts).toBe(1);
	});
});

describe("review W22 S3: a cloud version replaced by our upload is kept", () => {
	it("the displaced revision becomes a conflicted copy, here and in the cloud", async () => {
		const { local, remote, sync } = setup();
		local.put("a.md", "v1");
		await sync();
		local.put("a.md", "mine");
		const orig = remote.upload.bind(remote);
		let once = true;
		remote.upload = async (path, data, ifRev) => {
			const e = await orig(path, data, ifRev);
			if (!once || path !== "a.md") return e;
			once = false;
			return { ...e, displaced: [{ rev: "r-theirs", data: enc.encode("theirs").buffer }] };
		};
		const r = await sync();
		expect(remote.read("a.md")).toBe("mine");
		const [copy] = copies(local, "a");
		expect(local.get(copy!)).toBe("theirs");
		expect(remote.read(copy!)).toBe("theirs");
		expect(r.counts.conflicts).toBe(1);
	});
});

describe("review W22 S6: a new cloud revision with the base's content is not a conflict", () => {
	it("only this side changed: it goes up on the new revision, no conflicted copy", async () => {
		const { local, remote, sync } = setup();
		local.put("a.md", "v1");
		await sync();
		remote.put("a.md", "v1"); // re-tagged in the cloud, same bytes
		local.put("a.md", "v2");
		const r = await sync();
		expect(r.counts.conflicts).toBe(0);
		expect(copies(local, "a")).toEqual([]);
		expect(remote.read("a.md")).toBe("v2");
		expect(local.get("a.md")).toBe("v2");
	});
});

describe("review W22 S7: start-up and leaving runs defer deletions; automatic runs ask sooner", () => {
	it("deletions: 'defer' leaves the deletion for later and counts it; the next guarded run does it", async () => {
		const { local, remote, sync } = setup();
		local.put("a.md", "x");
		local.put("b.md", "y");
		await sync();
		local.files.delete("a.md");
		remote.put("b.md", "y2");
		const r = await sync({ deletions: "defer" });
		expect(r.deferredDeletes).toBe(1);
		expect(remote.read("a.md")).toBe("x");
		expect(local.get("b.md")).toBe("y2");
		const r2 = await sync();
		expect(r2.deferredDeletes).toBe(0);
		expect(remote.read("a.md")).toBeUndefined();
	});

	it("the planner: defer, the automatic limit, and the mobile hard cap", () => {
		const del = (path: string): PathFacts => ({ path, local: null, remote: { id: path, rev: "r1", size: 1, mtime: 1, changed: false }, baseRev: "r1" });
		const keep = (path: string): PathFacts => ({ path, local: { size: 1, mtime: 1, changed: false }, remote: { id: path, rev: "r1", size: 1, mtime: 1, changed: false }, baseRev: "r1" });
		const O: PlanOptions = { trusted: true, deletions: "guard", largeBytes: 0, large: "ask", approvedLarge: new Set() };
		const facts = [...Array.from({ length: 11 }, (_, i) => del(`d${i}.md`)), ...Array.from({ length: 89 }, (_, i) => keep(`k${i}.md`))];
		expect(plan(facts, O).heldDeletes).toHaveLength(0);
		expect(plan(facts, { ...O, massDeleteMax: MASS_DELETE_AUTO_MAX }).heldDeletes).toHaveLength(11);
		const deferred = plan(facts, { ...O, deletions: "defer" });
		expect(deferred.deferred).toHaveLength(11);
		expect(deferred.actions).toEqual([]);
		const big: PathFacts = { path: "big.pdf", local: { size: 900, mtime: 1, changed: true }, remote: null, baseRev: null };
		const capped = plan([big], { ...O, hardMaxBytes: 500, largeBytes: 100, approvedLarge: new Set(["big.pdf"]) });
		expect(capped.tooLarge.map((a) => a.path)).toEqual(["big.pdf"]);
		expect(capped.actions).toEqual([]);
		expect(capped.askLarge).toEqual([]);
	});

	it("the engine reports files above the hard cap and never moves them, even when approved", async () => {
		const { local, remote, sync } = setup();
		local.put("big.pdf", "0123456789");
		const r = await sync({ hardMaxBytes: 5, approvedLarge: new Set(["big.pdf"]) });
		expect(r.tooLarge).toEqual([{ path: "big.pdf", size: 10 }]);
		expect(r.events).toContainEqual({ kind: "skip", path: "big.pdf", detail: "too-large" });
		expect(remote.read("big.pdf")).toBeUndefined();
	});
});

describe("review W22 S8: a conflicted copy outside the scope stays a local file", () => {
	it("never uploaded nor recorded, so no later run deletes it", async () => {
		const { local, remote, sync } = setup();
		const scope = { mode: "rules" as const, folders: [], include: ["a.md"], exclude: [], types: [] };
		local.put("a.md", "v1");
		await sync({ scope });
		local.put("a.md", "mine");
		remote.put("a.md", "theirs");
		const r = await sync({ scope });
		expect(r.counts.conflicts).toBe(1);
		const [copy] = copies(local, "a");
		expect(local.get(copy!)).toBe("theirs");
		expect(remote.read(copy!)).toBeUndefined();
		expect(remote.read("a.md")).toBe("mine");
		await sync({ scope });
		expect(local.get(copy!)).toBe("theirs");
	});
});

describe("review W22 S9: names that differ only by case", () => {
	it("a case-only rename here is followed: the cloud's old name goes to its trash, the new one goes up", async () => {
		const { local, remote, sync } = setup();
		local.put("Note.md", "text");
		await sync();
		local.files.delete("Note.md");
		local.put("note.md", "text");
		const r = await sync();
		expect(remote.read("note.md")).toBe("text");
		expect(remote.files.has("Note.md")).toBe(false);
		expect(remote.trash.map((t) => t.path)).toContain("Note.md");
		expect(r.events.some((e) => e.detail === "case")).toBe(false);
	});

	it("a case-only rename in the cloud is followed: the old local name goes to the trash, the new one comes down", async () => {
		const { local, remote, sync } = setup();
		local.put("Note.md", "text");
		await sync();
		remote.del("Note.md");
		remote.put("note.md", "text");
		await sync();
		expect(local.get("note.md")).toBe("text");
		expect(local.files.has("Note.md")).toBe(false);
		expect(local.trashed.map((t) => t.path)).toEqual(["Note.md"]);
	});

	it("not followed by a run that may not delete (start-up), nor without a base: both are skipped, nothing written", async () => {
		const { local, remote, sync } = setup();
		local.put("Note.md", "text");
		await sync();
		local.files.delete("Note.md");
		local.put("note.md", "text");
		const r = await sync({ deletions: "defer" });
		expect(r.events).toContainEqual({ kind: "skip", path: "note.md", detail: "case" });
		expect(remote.read("Note.md")).toBe("text");
		expect(remote.files.has("note.md")).toBe(false);
	});

	it("two spellings of one name in Unicode (NFC and NFD) are never both written", async () => {
		const { local, remote, sync } = setup();
		const nfc = "café.md";
		const nfd = "café.md";
		local.put(nfc, "here");
		remote.put(nfd, "there");
		const r = await sync();
		expect(local.files.has(nfd)).toBe(false);
		expect(remote.files.has(nfc)).toBe(false);
		expect(r.events.filter((e) => e.detail === "case").map((e) => e.path).sort()).toEqual([nfd, nfc].sort());
	});
});

describe("review W22 S10: names that cannot exist on every device", () => {
	it("a cloud file with such a name is skipped with a note, never written here", async () => {
		const { local, remote, sync } = setup();
		remote.put("bad?.md", "x");
		remote.put("ok.md", "y");
		const r = await sync();
		expect(local.files.has("bad?.md")).toBe(false);
		expect(local.get("ok.md")).toBe("y");
		expect(r.unsyncable).toEqual(["bad?.md"]);
		expect(r.events).toContainEqual({ kind: "skip", path: "bad?.md", detail: "name" });
	});

	it("a local file with such a name is skipped, never uploaded", async () => {
		const { local, remote, sync } = setup();
		local.put("CON.md", "x");
		const r = await sync();
		expect(remote.files.has("CON.md")).toBe(false);
		expect(r.unsyncable).toEqual(["CON.md"]);
	});

	it("a cloud file renamed to such a name: the local file is not deleted, it goes up again under its old name", async () => {
		const { local, remote, sync } = setup();
		local.put("good.md", "keep me");
		await sync();
		const f = remote.files.get("good.md")!;
		remote.files.delete("good.md");
		remote.files.set("bad|name.md", f);
		remote.alwaysFull = true;
		const r = await sync();
		expect(local.get("good.md")).toBe("keep me");
		expect(local.trashed).toEqual([]);
		expect(remote.read("good.md")).toBe("keep me");
		expect(r.unsyncable).toEqual(["bad|name.md"]);
	});

	it("a cloud name with a slash (Drive allows it) arrives as a backslash and is skipped", async () => {
		const { local, remote, sync } = setup();
		remote.put("a\\b.md", "x");
		const r = await sync();
		expect([...local.files.keys()]).toEqual([]);
		expect(r.unsyncable).toEqual(["a\\b.md"]);
	});

	it("the name rules", () => {
		for (const ok of ["a.md", "Notebook 1.notebook", "été.md", ".hidden"]) expect(syncableName(ok)).toBe(true);
		for (const bad of ["", ".", "..", "a:b", "a?.md", "CON", "nul.txt", "trailing.", "trailing ", "a\\b"]) expect(syncableName(bad)).toBe(false);
		expect(syncablePath("A/b/c.md")).toBe(true);
		expect(syncablePath("A//c.md")).toBe(false);
		expect(foldKey("Café.MD")).toBe(foldKey("café.md"));
	});
});

describe("review W22 S11: the state is saved during a run, but not after every file", () => {
	it("at most every SAVE_EVERY_MS, plus once at the end", async () => {
		const local = new FakeLocal();
		const remote = new FakeProvider();
		const state = new MemoryState();
		for (let i = 0; i < 30; i++) local.put(`f${i}.md`, String(i));
		await runSync(ports(local, remote, state), OPTS);
		expect(state.saves).toBe(1);

		const state2 = new MemoryState();
		const local2 = new FakeLocal();
		for (let i = 0; i < 30; i++) local2.put(`f${i}.md`, String(i));
		const p = ports(local2, new FakeProvider(), state2);
		let now = 0;
		p.now = () => (now += SAVE_EVERY_MS / 4);
		await runSync(p, OPTS);
		expect(state2.saves).toBeGreaterThan(1);
		expect(state2.saves).toBeLessThan(30);
	});
});

describe("review W22 S4: the tree index keeps every file of a path", () => {
	const file = (id: string, name: string, parent = "R"): TreeItem => ({ id, folder: false, removed: false, name, parent, entry: { id, size: 1, mtime: 1, rev: `rev-${id}` } });

	it("a full listing returns both files of one name", () => {
		const t = new TreeIndex("R");
		expect(t.buildFull([file("a", "x.md"), file("b", "x.md")]).map((e) => [e.id, e.path])).toEqual([["a", "x.md"], ["b", "x.md"]]);
	});

	it("a deleted twin does not delete the path the other one still holds; the other is listed", async () => {
		const t = new TreeIndex("R");
		t.buildFull([file("a", "x.md"), file("b", "x.md")]);
		const d = await t.applyDelta([{ id: "b", folder: false, removed: true }], () => Promise.resolve(null));
		expect(d.deletions).toEqual([]);
		expect(d.upserts.map((e) => e.id)).toEqual(["a"]);
	});

	it("a new file at a known path is listed with the one already there", async () => {
		const t = new TreeIndex("R");
		t.buildFull([file("a", "x.md")]);
		const d = await t.applyDelta([file("b", "x.md")], () => Promise.resolve(null));
		expect(d.upserts.map((e) => e.id).sort()).toEqual(["a", "b"]);
	});

	it("a slash inside a name becomes a backslash (the engine skips it)", () => {
		const t = new TreeIndex("R");
		expect(t.buildFull([file("a", "a/b.md")]).map((e) => e.path)).toEqual(["a\\b.md"]);
	});
});

describe("review W22: small helpers", () => {
	it("error texts lose their addresses (no tokens or ids in the log)", () => {
		expect(withoutUrls("failed GET https://graph.microsoft.com/v1.0/me/drive/items/X?token=abc: 500")).toBe("failed GET <address>: 500");
		expect(withoutUrls("no address here")).toBe("no address here");
	});

	it("the mobile size cap is clamped to 5–500 MB, 50 by default", () => {
		expect(DEFAULT_CLOUD_SYNC_SETTINGS.cloudSyncMobileMaxMb).toBe(50);
		expect(readCloudSyncSettings({}).cloudSyncMobileMaxMb).toBe(50);
		expect(readCloudSyncSettings({ cloudSyncMobileMaxMb: 0 }).cloudSyncMobileMaxMb).toBe(CLOUD_MOBILE_MIN_MB);
		expect(readCloudSyncSettings({ cloudSyncMobileMaxMb: 9999 }).cloudSyncMobileMaxMb).toBe(CLOUD_MOBILE_MAX_MB);
		expect(readCloudSyncSettings({ cloudSyncMobileMaxMb: "x" }).cloudSyncMobileMaxMb).toBe(50);
	});

	it("the new strings exist in English and Italian; setting descriptions fit in 90 characters", () => {
		const keys = Object.keys(en).filter((k) => /^cloudSync\.(disconnect\.|notice\.(loading|unknownNetwork|names|tooLarge)|status\.(unknownWaits|deferred|loading)|skip\.(name|tooLarge)|account\.(otherSignedIn|onedriveNote))|^settings\.cloudSyncMobileMaxMb/.test(k)) as (keyof typeof en)[];
		expect(keys.length).toBeGreaterThanOrEqual(19);
		for (const k of keys) expect(itMessages[k], k).toBeTruthy();
		for (const k of ["settings.cloudSyncMobileMaxMb.desc", "settings.cloudSyncWifiOnly.desc"] as const) {
			expect(en[k].length).toBeLessThanOrEqual(90);
			expect(itMessages[k]!.length).toBeLessThanOrEqual(90);
		}
	});
});
