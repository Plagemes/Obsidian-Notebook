import { describe, expect, it } from "vitest";
import {
	backupFileName, backupFolderConflict, backupFolderOf, DAY_MS, DEFAULT_BACKUP_FOLDER, DEFAULT_BACKUP_SETTINGS, EMPTY_MEMORY, INTERVAL_MS, isDue, isTempName, MIN_GAP_MS, newestBackupAt,
	looksNotDownloaded, nextDueAt, normaliseMemory, parseBackupName, planBackupFiles, planRetention, readBackupSettings, remember, RETRY_AFTER_FAILURE_MS, STALE_TEMP_MS, tempName,
	type BackupMemory, type BackupResult, type FolderChild,
} from "../src/storage/backup-logic";

const T = new Date(2026, 10, 5, 10, 15, 0).getTime();

describe("backup settings", () => {
	it("defaults to off, the default folder and five backups", () => {
		expect(readBackupSettings({})).toEqual(DEFAULT_BACKUP_SETTINGS);
		expect(DEFAULT_BACKUP_SETTINGS.zipBackupSchedule).toBe("off");
		expect(DEFAULT_BACKUP_SETTINGS.zipBackupKeep).toBe(5);
	});

	it("reads leniently: wrong types keep the defaults, numbers are clamped", () => {
		expect(readBackupSettings({ zipBackupSchedule: "hourly", zipBackupFolder: 5, zipBackupKeep: "9" })).toEqual(DEFAULT_BACKUP_SETTINGS);
		expect(readBackupSettings({ zipBackupSchedule: "weekly", zipBackupKeep: 0 }).zipBackupKeep).toBe(1);
		expect(readBackupSettings({ zipBackupKeep: 999 }).zipBackupKeep).toBe(30);
		expect(readBackupSettings({ zipBackupKeep: 4.6 }).zipBackupKeep).toBe(5);
		expect(readBackupSettings({ zipBackupKeep: Number.NaN }).zipBackupKeep).toBe(5);
		expect(readBackupSettings({ zipBackupSchedule: "daily" }).zipBackupSchedule).toBe("daily");
	});

	it("never lets the folder be the vault root or climb out of it", () => {
		expect(backupFolderOf("")).toBe(DEFAULT_BACKUP_FOLDER);
		expect(backupFolderOf("/")).toBe(DEFAULT_BACKUP_FOLDER);
		expect(backupFolderOf("..")).toBe(DEFAULT_BACKUP_FOLDER);
		expect(backupFolderOf("/Sync/../Backups/")).toBe("Sync/Backups");
		expect(backupFolderOf("Sync\\Backups")).toBe("Sync/Backups");
	});
});

describe("backup names", () => {
	it("writes and reads back the local time", () => {
		const name = backupFileName(T);
		expect(name).toBe("Notebook backup 20261105-101500.zip");
		expect(parseBackupName(name)).toEqual({ at: T, partial: false });
		expect(backupFileName(T, true)).toBe("Notebook backup 20261105-101500 partial.zip");
		expect(parseBackupName(backupFileName(T, true))).toEqual({ at: T, partial: true });
	});

	it("recognises only exactly our names", () => {
		for (const n of [
			"Notebook backup 20261105-101500.zip.tmp", "notebook backup 20261105-101500.zip", "Notebook backup 20261105-101500.ZIP", "Notebook backup 20261105-101500 (1).zip",
			"Notebook backup 20261105-1015.zip", "My Notebook backup 20261105-101500.zip", "Notebook backup 20261105-101500 old.zip", "Notebook backup 20261305-101500.zip",
			"Notebook backup 20260231-101500.zip", "Notebook backup 20261105-256000.zip", "Notebook backup.zip", "backup.zip", "",
		]) expect(parseBackupName(n), n).toBeNull();
	});

	it("knows its temporary names", () => {
		const final = backupFileName(T);
		expect(isTempName(tempName(final))).toBe(true);
		expect(isTempName(final)).toBe(false);
		expect(isTempName("something.zip.tmp")).toBe(false);
		expect(isTempName("Notebook backup 20261305-101500.zip.tmp")).toBe(false);
	});
});

describe("when a backup is due", () => {
	const ok = (at: number): BackupResult => ({ at, outcome: "ok", files: 3, bytes: 100, skipped: 0, trashed: 0, name: backupFileName(at), error: "" });
	const bad = (at: number): BackupResult => ({ at, outcome: "failed", files: 0, bytes: 0, skipped: 0, trashed: 0, name: "", error: "disk full" });
	const after = (result: BackupResult, memory: BackupMemory = EMPTY_MEMORY) => remember(memory, result);

	it("is never due when the schedule is off", () => {
		expect(isDue("off", EMPTY_MEMORY, null, T)).toBe(false);
		expect(isDue("off", EMPTY_MEMORY, T - 100 * DAY_MS, T)).toBe(false);
	});

	it("is due at once when there is no backup yet", () => {
		expect(isDue("daily", EMPTY_MEMORY, null, T)).toBe(true);
		expect(isDue("weekly", EMPTY_MEMORY, null, T)).toBe(true);
	});

	it("waits a day (daily) or a week (weekly) after the last backup", () => {
		const memory = after(ok(T));
		expect(isDue("daily", memory, null, T + DAY_MS - 1)).toBe(false);
		expect(isDue("daily", memory, null, T + DAY_MS)).toBe(true);
		expect(isDue("weekly", memory, null, T + 6 * DAY_MS)).toBe(false);
		expect(isDue("weekly", memory, null, T + 7 * DAY_MS)).toBe(true);
		expect(INTERVAL_MS.daily).toBe(DAY_MS);
		expect(INTERVAL_MS.weekly).toBe(7 * DAY_MS);
	});

	it("counts a backup another device made and the sync brought here", () => {
		expect(isDue("daily", EMPTY_MEMORY, T, T + 2 * 3_600_000)).toBe(false);
		expect(isDue("daily", EMPTY_MEMORY, T, T + DAY_MS)).toBe(true);
		// the newer of the two decides
		const memory = after(ok(T - 3 * DAY_MS));
		expect(isDue("daily", memory, T, T + 3_600_000)).toBe(false);
		expect(isDue("daily", memory, T - 5 * DAY_MS, T + 3_600_000)).toBe(true);
	});

	it("retries a failure only after an hour, and keeps the old success as the reference", () => {
		const memory = after(bad(T), after(ok(T - 2 * DAY_MS)));
		expect(memory.lastOkAt).toBe(T - 2 * DAY_MS);
		expect(isDue("daily", memory, null, T + RETRY_AFTER_FAILURE_MS - 1)).toBe(false);
		expect(isDue("daily", memory, null, T + RETRY_AFTER_FAILURE_MS)).toBe(true);
	});

	it("never runs twice within a few minutes", () => {
		const memory: BackupMemory = { lastOkAt: null, lastAttemptAt: T, last: null };
		expect(isDue("daily", memory, null, T + MIN_GAP_MS - 1)).toBe(false);
		expect(isDue("daily", memory, null, T + MIN_GAP_MS)).toBe(true);
	});

	it("ignores times in the future (a clock that was wrong) instead of waiting for them", () => {
		const memory = after(ok(T + 400 * DAY_MS));
		expect(isDue("daily", memory, null, T)).toBe(true);
		expect(isDue("daily", EMPTY_MEMORY, T + 400 * DAY_MS, T)).toBe(true);
	});

	it("tells when the next one is due", () => {
		expect(nextDueAt("off", EMPTY_MEMORY, null)).toBeNull();
		expect(nextDueAt("daily", EMPTY_MEMORY, null)).toBe(0);
		expect(nextDueAt("daily", after(ok(T)), null)).toBe(T + DAY_MS);
		expect(nextDueAt("weekly", after(ok(T)), T + DAY_MS)).toBe(T + 8 * DAY_MS);
	});

	it("finds the newest backup in a folder listing and ignores everything else", () => {
		expect(newestBackupAt([])).toBeNull();
		expect(newestBackupAt(["notes.md", "Notebook backup 2026.zip"])).toBeNull();
		expect(newestBackupAt([backupFileName(T - DAY_MS), "x.zip", backupFileName(T), backupFileName(T - 2 * DAY_MS, true)])).toBe(T);
	});
});

describe("what the memory keeps", () => {
	it("reads whatever was stored without throwing", () => {
		for (const junk of [null, undefined, 5, "text", [], { last: 5 }, { lastOkAt: "x", last: { at: "y" } }]) {
			expect(normaliseMemory(junk), JSON.stringify(junk)).toEqual(EMPTY_MEMORY);
		}
	});

	it("round-trips a result and bounds the error text", () => {
		const result: BackupResult = { at: T, outcome: "partial", files: 12, bytes: 3456, skipped: 2, trashed: 1, name: backupFileName(T, true), error: "x".repeat(1000) };
		const memory = remember(EMPTY_MEMORY, result);
		const back = normaliseMemory(JSON.parse(JSON.stringify(memory)));
		expect(back.lastOkAt).toBe(T);
		expect(back.last?.outcome).toBe("partial");
		expect(back.last?.error.length).toBe(300);
		expect(back.last?.files).toBe(12);
	});

	it("drops a result with an unknown outcome", () => {
		expect(normaliseMemory({ lastOkAt: T, last: { at: T, outcome: "great" } }).last).toBeNull();
	});
});

describe("files still arriving from a sync client", () => {
	const b = (...n: number[]) => Uint8Array.from(n);
	it("recognises empty, blank, NUL-only and NUL-tailed content", () => {
		expect(looksNotDownloaded(b())).toBe(true);
		expect(looksNotDownloaded(b(0, 0, 0))).toBe(true);
		expect(looksNotDownloaded(b(0x20, 0x0a, 0x09, 0))).toBe(true);
		expect(looksNotDownloaded(b(0x7b, 0x7d, 0))).toBe(true);
	});
	it("lets real content through", () => {
		expect(looksNotDownloaded(b(0x7b, 0x7d))).toBe(false);
		expect(looksNotDownloaded(b(0, 0, 0x7b, 0x7d))).toBe(false);
	});
});

describe("which files go in a backup", () => {
	const f = (path: string, size = 10) => ({ path, size, mtime: 1 });
	const files = [
		f("Notebooks/Maths.notebook"), f("Notebooks/Sub/Physics.notebook"), f("Notebooks/_assets/0123456789abcdef01234567.pdf", 500), f("Notebooks/_meta/folders-ab12cd34.json"),
		f("Notebooks/_templates/Cornell.notebook"), f("Notebooks/_trash/items/abc-12345/Old.notebook"), f("Notebooks/_backup/Maths 20260101-000000 unsaved 0a1b2c3d.bak"),
		f("Notebooks/_backup/Maths.notebook"), f("Elsewhere/Loose.notebook"), f("Notes/Daily.md"), f("Notebooks/Maths.pdf"), f("Notebook backups/Notebook backup 20261104-101500.zip", 999),
		f("Notebooks/_assets/Notebook backups/inner.notebook"), f("Notebooks/Maths.notebook.conflict"),
	];

	it("takes notebooks, assets and meta files, and leaves the rest", () => {
		const plan = planBackupFiles(files, "Notebooks", "Notebook backups");
		expect(plan.include.map((x) => x.path)).toEqual([
			"Elsewhere/Loose.notebook", "Notebooks/Maths.notebook", "Notebooks/Sub/Physics.notebook", "Notebooks/_assets/0123456789abcdef01234567.pdf",
			"Notebooks/_assets/Notebook backups/inner.notebook", "Notebooks/_meta/folders-ab12cd34.json", "Notebooks/_templates/Cornell.notebook",
		]);
		expect(plan.bytes).toBe(10 * 6 + 500);
	});

	it("never includes the backup folder, even inside the notebooks folder", () => {
		const inside = planBackupFiles([...files, f("Notebooks/_meta/Backups/Notebook backup 20261104-101500.zip"), f("Notebooks/_meta/Backups/Old.notebook")], "Notebooks", "Notebooks/_meta/Backups");
		expect(inside.include.some((x) => x.path.startsWith("Notebooks/_meta/Backups/"))).toBe(false);
	});

	it("works with the notebooks folder at the vault root", () => {
		const plan = planBackupFiles([f("A.notebook"), f("_assets/aaaaaaaaaaaaaaaaaaaaaaaa.png"), f("_meta/x.json"), f("_backup/B.notebook"), f("notes.md"), f("Notebook backups/n.zip")], "", "Notebook backups");
		expect(plan.include.map((x) => x.path)).toEqual(["A.notebook", "_assets/aaaaaaaaaaaaaaaaaaaaaaaa.png", "_meta/x.json"]);
	});
});

describe("retention", () => {
	const child = (name: string, file = true): FolderChild => ({ name, path: `B/${name}`, file });
	const n = (days: number, partial = false) => backupFileName(T - days * DAY_MS, partial);

	it("keeps the newest N and lists the older ones", () => {
		const children = [0, 1, 2, 3, 4, 5, 6].map((d) => child(n(d)));
		const plan = planRetention(children, 3, T);
		expect(plan.kept.map((c) => c.name)).toEqual([n(0), n(1), n(2)]);
		expect(plan.trash.map((c) => c.name)).toEqual([n(3), n(4), n(5), n(6)]);
	});

	it("never lists a file that is not exactly one of our backups", () => {
		const foreign = [
			child("notes.md"), child("Notebook backup 20200101-000000.zip.bak"), child("Notebook backup 2020.zip"), child("My Notebook backup 20200101-000000.zip"),
			child("Notebook backup 20200101-000000 mine.zip"), child("holiday.zip"), child("Notebook backup 20200101-000000.zip", false), // a FOLDER named like a backup
		];
		const plan = planRetention([...foreign, child(n(0)), child(n(1))], 1, T);
		expect(plan.trash.map((c) => c.name)).toEqual([n(1)]);
		const all = planRetention(foreign, 1, T);
		expect(all.trash).toEqual([]);
		expect(all.staleTemps).toEqual([]);
		expect(all.kept).toEqual([]);
	});

	it("keeps the newest complete backup even when newer partial ones fill the quota", () => {
		const children = [child(n(0, true)), child(n(1, true)), child(n(2)), child(n(3)), child(n(4, true))];
		const plan = planRetention(children, 2, T);
		expect(plan.kept.map((c) => c.name)).toEqual([n(0, true), n(1, true), n(2)]);
		expect(plan.trash.map((c) => c.name)).toEqual([n(3), n(4, true)]);
	});

	it("keeps at least one, whatever the setting says", () => {
		const children = [child(n(0)), child(n(1))];
		for (const keep of [0, -3, Number.NaN]) expect(planRetention(children, keep, T).kept.map((c) => c.name)).toEqual([n(0)]);
	});

	it("does nothing with fewer backups than the quota", () => {
		expect(planRetention([child(n(0)), child(n(1))], 5, T).trash).toEqual([]);
		expect(planRetention([], 5, T)).toEqual({ trash: [], staleTemps: [], kept: [] });
	});

	it("lists only temporary files that are old, are files and are not the current one", () => {
		const old = tempName(backupFileName(T - STALE_TEMP_MS - 60_000));
		const fresh = tempName(backupFileName(T - 60_000));
		const current = tempName(backupFileName(T - STALE_TEMP_MS - 120_000));
		const plan = planRetention([child(old), child(fresh), child(current), child(tempName(backupFileName(T - 9 * DAY_MS)), false), child("other.tmp")], 5, T, current);
		expect(plan.staleTemps.map((c) => c.name)).toEqual([old]);
	});

	it("orders equal times by name so the choice is stable", () => {
		const a = child("Notebook backup 20261105-101500.zip");
		const b = child("Notebook backup 20261105-101500 partial.zip");
		const first = planRetention([a, b], 1, T);
		const second = planRetention([b, a], 1, T);
		expect(first.kept.map((c) => c.name)).toEqual(second.kept.map((c) => c.name));
	});
});

describe("review W21 D1: the backup just written is always kept", () => {
	const child = (name: string): FolderChild => ({ name, path: `B/${name}`, file: true });
	const future = "Notebook backup 20300101-000000.zip";

	it("keep = 1 keeps the new backup and lists the future-dated one", () => {
		const fresh = backupFileName(T);
		const plan = planRetention([child(future), child(fresh)], 1, T, "", fresh);
		expect(plan.kept.map((c) => c.name)).toEqual([fresh]);
		expect(plan.trash.map((c) => c.name)).toEqual([future]);
	});

	it("a name dated more than a day ahead ranks as the oldest even without the just-written name", () => {
		const fresh = backupFileName(T);
		const plan = planRetention([child(future), child(fresh)], 1, T);
		expect(plan.kept.map((c) => c.name)).toEqual([fresh]);
	});

	it("a name a few hours ahead (another time zone) still counts as recent", () => {
		const ahead = backupFileName(T + 5 * 3_600_000);
		const plan = planRetention([child(ahead), child(backupFileName(T))], 1, T, "", backupFileName(T));
		expect(plan.kept.map((c) => c.name).sort()).toEqual([ahead, backupFileName(T)].sort());
	});

	it("the just-written backup stays even when it is partial and older names fill the quota", () => {
		const fresh = backupFileName(T, true);
		const complete = backupFileName(T - DAY_MS);
		const plan = planRetention([child(complete), child(fresh)], 1, T, "", fresh);
		expect(plan.kept.map((c) => c.name).sort()).toEqual([complete, fresh].sort());
		expect(plan.trash).toEqual([]);
	});
});

describe("review W21 D2: the backup folder must not overlap the notebooks", () => {
	const layout = { notebooksFolder: "School/Notebooks", templatesFolder: "", notebookTemplatesFolder: "" };

	it("refuses the notebooks folder, a folder that contains it, and one inside it", () => {
		for (const b of ["School/Notebooks", "School", "School/Notebooks/_assets", "School/Notebooks/Backups"]) expect(backupFolderConflict(b, layout), b).toBe("notebooks");
	});

	it("accepts a sibling and a name that only starts the same", () => {
		for (const b of ["Notebook backups", "School/Backups", "School/Notebooks2"]) expect(backupFolderConflict(b, layout), b).toBeNull();
	});

	it("refuses a templates folder, wherever it is", () => {
		expect(backupFolderConflict("Templates", { ...layout, templatesFolder: "Templates" })).toBe("templates");
		expect(backupFolderConflict("Templates/books", { ...layout, notebookTemplatesFolder: "Templates/books/x" })).toBe("templates");
	});

	it("refuses a folder that holds a notebook file, but not one that holds the trash or a _backup copy", () => {
		const files = ["Other/Maths.notebook", "Other/_trash/items/a/Old.notebook", "Elsewhere/_backup/x.notebook"];
		expect(backupFolderConflict("Other", layout, files)).toBe("holds-notebooks");
		expect(backupFolderConflict("Other/Sub", layout, files)).toBeNull();
		expect(backupFolderConflict("Elsewhere", layout, files)).toBeNull();
	});

	it("with the notebooks at the vault root only reserved folders and notebook holders are refused", () => {
		const root = { notebooksFolder: "", templatesFolder: "", notebookTemplatesFolder: "" };
		expect(backupFolderConflict("Notebook backups", root)).toBeNull();
		expect(backupFolderConflict("_assets", root)).toBe("notebooks");
	});
});

describe("review W21 D2: readSettings falls back from an overlapping backup folder", () => {
	it("resets a backup folder that is the notebooks folder or inside it", async () => {
		const { readSettings } = await import("../src/settings");
		expect(readSettings({ folder: "Notebooks", zipBackupFolder: "Notebooks" }).zipBackupFolder).toBe(DEFAULT_BACKUP_FOLDER);
		expect(readSettings({ folder: "Notebooks", zipBackupFolder: "Notebooks/_assets" }).zipBackupFolder).toBe(DEFAULT_BACKUP_FOLDER);
		expect(readSettings({ folder: "Notebooks", zipBackupFolder: "Elsewhere/Backups" }).zipBackupFolder).toBe("Elsewhere/Backups");
	});
});
