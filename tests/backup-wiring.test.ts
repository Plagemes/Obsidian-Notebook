import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { it as italian } from "../src/i18n/it";
import { isInboxCandidate, type InboxContext } from "../src/library/shared-inbox-logic";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { isHiddenNotebookPath } from "../src/storage/trash-paths";
import { settingSpecs, settingsView, type SettingsContext } from "../src/view/settings-schema";

describe("the backup folder is not part of the library", () => {
	it("hides notebooks inside it, wherever it is", () => {
		expect(isHiddenNotebookPath("Notebook backups/Unzipped.notebook", "Notebooks", "", "", "Notebook backups")).toBe(true);
		expect(isHiddenNotebookPath("Notebook backups/Sub/Unzipped.notebook", "Notebooks", "", "", "Notebook backups")).toBe(true);
		expect(isHiddenNotebookPath("Notebooks/Sync/Unzipped.notebook", "Notebooks", "", "", "Notebooks/Sync")).toBe(true);
		expect(isHiddenNotebookPath("Notebook backups 2/Real.notebook", "Notebooks", "", "", "Notebook backups")).toBe(false);
		expect(isHiddenNotebookPath("Notebooks/Real.notebook", "Notebooks", "", "", "Notebook backups")).toBe(false);
		// without the folder the rule is the old one
		expect(isHiddenNotebookPath("Notebook backups/Unzipped.notebook", "Notebooks", "")).toBe(false);
	});

	it("keeps the shared-files inbox from offering anything in it", () => {
		const ctx: InboxContext = { folder: "Notebook backups", notebooksFolder: "Notebooks", templatesFolder: "", notebookTemplatesFolder: "" };
		expect(isInboxCandidate("Notebook backups/scan.pdf", ctx)).toBe(true);
		expect(isInboxCandidate("Notebook backups/scan.pdf", { ...ctx, backupFolder: "Notebook backups" })).toBe(false);
		const elsewhere: InboxContext = { ...ctx, folder: "Inbox", backupFolder: "Notebook backups" };
		expect(isInboxCandidate("Inbox/scan.pdf", elsewhere)).toBe(true);
	});
});

describe("the backup settings", () => {
	it("are off by default and survive a round trip through the settings reader", () => {
		expect(DEFAULT_SETTINGS.zipBackupSchedule).toBe("off");
		expect(DEFAULT_SETTINGS.zipBackupFolder).toBe("Notebook backups");
		expect(DEFAULT_SETTINGS.zipBackupKeep).toBe(5);
		const s = readSettings({ zipBackupSchedule: "weekly", zipBackupFolder: "Sync/Backups/", zipBackupKeep: 9 });
		expect(s).toMatchObject({ zipBackupSchedule: "weekly", zipBackupFolder: "Sync/Backups", zipBackupKeep: 9 });
		expect(readSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
	});

	it("show the folder and the count only while a schedule is on, and the manual row when the service runs", () => {
		const ctx: SettingsContext = { sync: false, timetable: false, timetableInUse: false, backups: true };
		const shown = (over: Partial<typeof DEFAULT_SETTINGS>, context = ctx) => {
			const view = settingsView(settingSpecs(), { settings: { ...DEFAULT_SETTINGS, ...over }, context, query: "", groupOverrides: new Map() });
			return new Set([...view.rows].filter(([, on]) => on).map(([id]) => id));
		};
		const off = shown({});
		expect(off.has("zipBackupSchedule")).toBe(true);
		expect(off.has("zipBackupFolder")).toBe(false);
		expect(off.has("zipBackupKeep")).toBe(false);
		expect(off.has("backupNow")).toBe(true);
		const on = shown({ zipBackupSchedule: "daily" });
		expect(on.has("zipBackupFolder") && on.has("zipBackupKeep")).toBe(true);
		expect(shown({}, { ...ctx, backups: false }).has("backupNow")).toBe(false);
	});

	it("are found by a search in both languages", () => {
		const ctx: SettingsContext = { sync: false, timetable: false, timetableInUse: false, backups: true };
		for (const query of ["backup", "zip", "copia di sicurezza"]) {
			const view = settingsView(settingSpecs(), { settings: DEFAULT_SETTINGS, context: ctx, query, groupOverrides: new Map() });
			expect(view.rows.get("zipBackupSchedule"), query).toBe(true);
		}
	});

	it("have every text in English and Italian", () => {
		const keys = Object.keys(en).filter((k) => k.startsWith("backup.") || /^settings\.backup/.test(k) || k === "command.backupNow");
		expect(keys.length).toBeGreaterThanOrEqual(25);
		const table = italian as Record<string, string | undefined>;
		for (const key of keys) expect(table[key], key).toBeTruthy();
	});
});
