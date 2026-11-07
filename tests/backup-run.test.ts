import { describe, expect, it } from "vitest";
import { readZip, verifyZipEntry, zipEntryData } from "../src/model/zip";
import { backupFileName, DAY_MS, tempName, type FolderChild } from "../src/storage/backup-logic";
import { runBackup, ZIP_COMMENT, type BackupConfig, type BackupPorts } from "../src/storage/backup-run";

const T = new Date(2026, 10, 5, 10, 15, 0).getTime();
const enc = (s: string) => new TextEncoder().encode(s);
const FOLDER = "Notebook backups";
const CFG: BackupConfig = { notebooksFolder: "Notebooks", folder: FOLDER, keep: 3, maxBytes: 1_000_000 };

/** An in-memory vault with the same behaviour the ports promise. */
class FakeVault {
	files = new Map<string, Uint8Array>();
	trashed: string[] = [];
	unreadable = new Set<string>();
	flushes = 0;
	failWrite = false;
	truncateWrite = false;
	failRename = false;
	order: string[] = [];
	breathed = 0;
	clock = T;

	ports(over: Partial<BackupPorts> = {}): BackupPorts {
		return {
			now: () => this.clock,
			files: () => [...this.files].map(([path, b]) => ({ path, size: b.length, mtime: T - 1000 })),
			read: async (p) => {
				if (this.unreadable.has(p)) throw new Error("not downloaded");
				return this.files.get(p)!;
			},
			flush: async () => void this.flushes++,
			children: () => [...this.files.keys()].filter((p) => p.startsWith(`${FOLDER}/`) && !p.slice(FOLDER.length + 1).includes("/")).map((p): FolderChild => ({ name: p.slice(FOLDER.length + 1), path: p, file: true })),
			ensureFolder: async () => void this.order.push("ensure"),
			exists: (p) => this.files.has(p),
			write: async (p, b) => {
				if (this.failWrite) throw new Error("disk full");
				if (this.files.has(p)) throw new Error("exists");
				this.order.push(`write ${p}`);
				this.files.set(p, this.truncateWrite ? b.slice(0, b.length - 1) : b);
			},
			sizeOf: async (p) => this.files.get(p)?.length ?? null,
			rename: async (from, to) => {
				if (this.failRename) throw new Error("rename failed");
				this.order.push(`rename ${from} -> ${to}`);
				this.files.set(to, this.files.get(from)!);
				this.files.delete(from);
			},
			trash: async (p) => {
				this.order.push(`trash ${p}`);
				this.trashed.push(p);
				this.files.delete(p);
			},
			breathe: async () => void this.breathed++,
			...over,
		};
	}

	seed(): void {
		this.files.set("Notebooks/Maths.notebook", enc('{"version":18,"name":"Maths"}'));
		this.files.set("Notebooks/Sub/Physics.notebook", enc('{"version":18,"name":"Physics"}'));
		this.files.set("Notebooks/_assets/0123456789abcdef01234567.pdf", Uint8Array.from({ length: 4000 }, (_, i) => (i * 7) & 255));
		this.files.set("Notebooks/_meta/folders-ab12cd34.json", enc("{}"));
		this.files.set("Notebooks/_trash/items/x/Old.notebook", enc("old"));
		this.files.set("Notes/Daily.md", enc("# daily"));
	}
}

describe("a backup run", () => {
	it("writes a valid zip of the notebooks, assets and meta files, and nothing else", async () => {
		const v = new FakeVault();
		v.seed();
		const before = new Map(v.files);
		const result = await runBackup(CFG, v.ports());
		expect(result).toMatchObject({ outcome: "ok", files: 4, skipped: 0, trashed: 0, error: "", name: backupFileName(T) });
		const bytes = v.files.get(`${FOLDER}/${backupFileName(T)}`)!;
		expect(result.bytes).toBe(bytes.length);
		const listing = readZip(bytes);
		expect(listing.comment).toContain(ZIP_COMMENT);
		expect(listing.entries.map((e) => e.name)).toEqual([
			"Notebooks/Maths.notebook", "Notebooks/Sub/Physics.notebook", "Notebooks/_assets/0123456789abcdef01234567.pdf", "Notebooks/_meta/folders-ab12cd34.json",
		]);
		for (const e of listing.entries) {
			expect(verifyZipEntry(bytes, e)).toBe(true);
			expect(Array.from(zipEntryData(bytes, e))).toEqual(Array.from(before.get(e.name)!));
		}
		// the sources are untouched, and nothing but the zip is new
		for (const [p, b] of before) expect(v.files.get(p)).toBe(b);
		expect([...v.files.keys()].filter((p) => !before.has(p))).toEqual([`${FOLDER}/${backupFileName(T)}`]);
	});

	it("flushes the open notebooks first, writes to a temporary name, then renames", async () => {
		const v = new FakeVault();
		v.seed();
		let flushedBeforeFirstRead = false;
		const ports = v.ports({
			flush: async () => void v.flushes++,
			read: async (p) => {
				flushedBeforeFirstRead = v.flushes === 1;
				return v.files.get(p)!;
			},
		});
		await runBackup(CFG, ports);
		expect(flushedBeforeFirstRead).toBe(true);
		const final = `${FOLDER}/${backupFileName(T)}`;
		expect(v.order).toEqual(["ensure", `write ${tempName(final)}`, `rename ${tempName(final)} -> ${final}`]);
	});

	it("backs up the files as they are on disk when the flush fails", async () => {
		const v = new FakeVault();
		v.seed();
		const result = await runBackup(CFG, v.ports({ flush: async () => Promise.reject(new Error("view gone")) }));
		expect(result.outcome).toBe("ok");
	});

	it("yields to the interface during a large run", async () => {
		const v = new FakeVault();
		for (let i = 0; i < 60; i++) v.files.set(`Notebooks/N${i}.notebook`, enc(`{"i":${i}}`));
		const progress: number[] = [];
		const result = await runBackup(CFG, v.ports({ progress: (done) => void progress.push(done) }));
		expect(result.files).toBe(60);
		expect(v.breathed).toBeGreaterThanOrEqual(2);
		expect(progress[0]).toBe(0);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));
	});

	it("marks a backup partial, and says how many files were skipped, when a file cannot be read", async () => {
		const v = new FakeVault();
		v.seed();
		v.unreadable.add("Notebooks/Sub/Physics.notebook");
		const result = await runBackup(CFG, v.ports());
		expect(result).toMatchObject({ outcome: "partial", files: 3, skipped: 1, name: backupFileName(T, true) });
		expect(readZip(v.files.get(`${FOLDER}/${result.name}`)!).entries.map((e) => e.name)).not.toContain("Notebooks/Sub/Physics.notebook");
	});

	it("skips a notebook a sync client has not finished downloading", async () => {
		const v = new FakeVault();
		v.seed();
		v.files.set("Notebooks/Empty.notebook", new Uint8Array(0));
		v.files.set("Notebooks/Reserved.notebook", new Uint8Array(40));
		v.files.set("Notebooks/Tail.notebook", Uint8Array.from([...enc('{"version":18}'), 0, 0, 0]));
		const result = await runBackup(CFG, v.ports());
		expect(result).toMatchObject({ outcome: "partial", files: 4, skipped: 3 });
		const names = readZip(v.files.get(`${FOLDER}/${result.name}`)!).entries.map((e) => e.name);
		expect(names.some((n) => /Empty|Reserved|Tail/.test(n))).toBe(false);
	});

	it("skips a file whose name cannot go in a zip, and says so", async () => {
		const v = new FakeVault();
		v.seed();
		v.files.set("Notebooks/back\\slash.notebook", enc("{}"));
		const result = await runBackup(CFG, v.ports());
		expect(result).toMatchObject({ outcome: "partial", skipped: 1 });
	});

	it("fails without writing when nothing can be read", async () => {
		const v = new FakeVault();
		v.files.set("Notebooks/A.notebook", enc("{}"));
		v.unreadable.add("Notebooks/A.notebook");
		const before = new Set(v.files.keys());
		const result = await runBackup(CFG, v.ports());
		expect(result.outcome).toBe("failed");
		expect([...v.files.keys()]).toEqual([...before]);
	});

	it("fails without reading when the vault is larger than the memory limit", async () => {
		const v = new FakeVault();
		v.seed();
		let reads = 0;
		const result = await runBackup({ ...CFG, maxBytes: 100 }, v.ports({ read: async (p) => (reads++, v.files.get(p)!) }));
		expect(result.outcome).toBe("failed");
		expect(result.error).toMatch(/too large/);
		expect(reads).toBe(0);
	});

	it("reports success with nothing to back up, without writing an empty zip", async () => {
		const v = new FakeVault();
		v.files.set("Notes/Daily.md", enc("x"));
		const result = await runBackup(CFG, v.ports());
		expect(result).toMatchObject({ outcome: "ok", files: 0, name: "" });
		expect([...v.files.keys()]).toEqual(["Notes/Daily.md"]);
	});

	it("can be cancelled before anything is written", async () => {
		const v = new FakeVault();
		v.seed();
		const result = await runBackup(CFG, v.ports({ cancelled: () => true }));
		expect(result).toMatchObject({ outcome: "failed", error: "cancelled" });
		expect(v.files.has(`${FOLDER}/${backupFileName(T)}`)).toBe(false);
	});

	it("does not touch the older backups when the write fails", async () => {
		const v = new FakeVault();
		v.seed();
		const old = [1, 2, 3, 4].map((d) => `${FOLDER}/${backupFileName(T - d * DAY_MS)}`);
		for (const p of old) v.files.set(p, enc("old"));
		v.failWrite = true;
		const result = await runBackup(CFG, v.ports());
		expect(result).toMatchObject({ outcome: "failed", error: "disk full" });
		expect(v.trashed).toEqual([]);
		for (const p of old) expect(v.files.has(p)).toBe(true);
	});

	it("does not touch the older backups when the file written is the wrong size", async () => {
		const v = new FakeVault();
		v.seed();
		const old = [1, 2, 3, 4].map((d) => `${FOLDER}/${backupFileName(T - d * DAY_MS)}`);
		for (const p of old) v.files.set(p, enc("old"));
		v.truncateWrite = true;
		const result = await runBackup(CFG, v.ports());
		expect(result.outcome).toBe("failed");
		for (const p of old) expect(v.files.has(p)).toBe(true);
		// the bad temporary file was removed, and no final file exists
		expect([...v.files.keys()].filter((p) => p.includes(backupFileName(T)))).toEqual([]);
	});

	it("does not touch the older backups when the rename fails", async () => {
		const v = new FakeVault();
		v.seed();
		const old = [1, 2, 3, 4].map((d) => `${FOLDER}/${backupFileName(T - d * DAY_MS)}`);
		for (const p of old) v.files.set(p, enc("old"));
		v.failRename = true;
		const result = await runBackup(CFG, v.ports());
		expect(result.outcome).toBe("failed");
		expect(v.trashed).toEqual([]);
	});

	it("picks a free name when the second is taken", async () => {
		const v = new FakeVault();
		v.seed();
		v.files.set(`${FOLDER}/${backupFileName(T)}`, enc("another device made this one"));
		const result = await runBackup({ ...CFG, keep: 30 }, v.ports());
		expect(result.name).toBe(backupFileName(T + 1000));
		expect(v.files.get(`${FOLDER}/${backupFileName(T)}`)).toEqual(enc("another device made this one"));
	});
});

describe("retention in a run", () => {
	it("trashes only the plugin's own old backups, newest N kept", async () => {
		const v = new FakeVault();
		v.seed();
		const ours = [1, 2, 3, 4, 5].map((d) => `${FOLDER}/${backupFileName(T - d * DAY_MS)}`);
		for (const p of ours) v.files.set(p, enc("old"));
		const foreign = [
			`${FOLDER}/notes.md`, `${FOLDER}/holiday.zip`, `${FOLDER}/Notebook backup 20200101-000000 mine.zip`, `${FOLDER}/Notebook backup.zip`,
			`${FOLDER}/sub/Notebook backup 20200101-000000.zip`, `${FOLDER}/Maths 20260101-000000 unsaved 0a1b2c3d.bak`,
		];
		for (const p of foreign) v.files.set(p, enc("mine"));
		const result = await runBackup(CFG, v.ports()); // keep 3: the new one plus the two newest old ones
		expect(result.trashed).toBe(3);
		expect(v.trashed.sort()).toEqual([ours[2], ours[3], ours[4]].sort());
		for (const p of foreign) expect(v.files.has(p), p).toBe(true);
		expect(v.files.has(ours[0]!) && v.files.has(ours[1]!)).toBe(true);
		// every trashed path is a direct child with an exact backup name
		for (const p of v.trashed) expect(p).toMatch(/^Notebook backups\/Notebook backup \d{8}-\d{6}\.zip$/);
	});

	it("never trashes anything for a vault whose backup folder holds only foreign files", async () => {
		const v = new FakeVault();
		v.seed();
		v.files.set(`${FOLDER}/a.zip`, enc("a"));
		v.files.set(`${FOLDER}/b.notebook`, enc("b"));
		await runBackup({ ...CFG, keep: 1 }, v.ports());
		expect(v.trashed).toEqual([]);
	});

	it("keeps the newest complete backup when partial ones would push it out", async () => {
		const v = new FakeVault();
		v.seed();
		v.unreadable.add("Notebooks/Sub/Physics.notebook"); // this run is partial
		const complete = `${FOLDER}/${backupFileName(T - 3 * DAY_MS)}`;
		v.files.set(complete, enc("complete"));
		v.files.set(`${FOLDER}/${backupFileName(T - 1 * DAY_MS, true)}`, enc("p1"));
		v.files.set(`${FOLDER}/${backupFileName(T - 2 * DAY_MS, true)}`, enc("p2"));
		await runBackup({ ...CFG, keep: 2 }, v.ports());
		expect(v.files.has(complete)).toBe(true);
	});

	it("removes the leftover temporary file of an interrupted run, but not a recent one", async () => {
		const v = new FakeVault();
		v.seed();
		const stale = `${FOLDER}/${tempName(backupFileName(T - 2 * DAY_MS))}`;
		const recent = `${FOLDER}/${tempName(backupFileName(T - 5 * 60_000))}`;
		const foreignTmp = `${FOLDER}/draft.tmp`;
		for (const p of [stale, recent, foreignTmp]) v.files.set(p, enc("tmp"));
		await runBackup(CFG, v.ports());
		expect(v.files.has(stale)).toBe(false);
		expect(v.files.has(recent)).toBe(true);
		expect(v.files.has(foreignTmp)).toBe(true);
	});

	it("survives a trash that fails and still reports the backup", async () => {
		const v = new FakeVault();
		v.seed();
		for (const d of [1, 2, 3, 4]) v.files.set(`${FOLDER}/${backupFileName(T - d * DAY_MS)}`, enc("old"));
		const result = await runBackup(CFG, v.ports({ trash: async () => Promise.reject(new Error("locked")) }));
		expect(result.outcome).toBe("ok");
		expect(result.trashed).toBe(0);
	});
});
