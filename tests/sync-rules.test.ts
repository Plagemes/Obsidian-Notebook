import { describe, expect, it } from "vitest";
import { alwaysExcluded, cleanFolder, globToRegExp, inScope, parseList, parseTypes, type FixedExclusions, type ScopeRules } from "../src/sync/rules";
import { DEFAULT_CLOUD_SYNC_SETTINGS, fixedExclusions, readCloudSyncSettings, scopeRules } from "../src/sync/settings";
import { networkVerdict } from "../src/sync/network";
import { CONFIG_DIR } from "./node-env";

const FIXED: FixedExclusions = { configDir: CONFIG_DIR, backupFolder: "Notebook backups" };
const vault: ScopeRules = { mode: "vault", folders: [], include: [], exclude: [], types: [] };

describe("cloud sync scope (#126)", () => {
	it("parses the comma-separated lists of the settings", () => {
		expect(parseList(" a, b ,, a\nc ")).toEqual(["a", "b", "c"]);
		expect(parseTypes("pdf, .PNG, *.md, bad type, ")).toEqual(["pdf", "png", "md"]);
		expect(cleanFolder("/School\\Maths/./")).toBe("School/Maths");
	});

	it("never syncs the config folder, hidden paths, the trash, temporary files or the zip backups", () => {
		for (const p of [`${CONFIG_DIR}/app.json`, CONFIG_DIR, ".trash/x.md", "a/.hidden/b.md", ".DS_Store", "Notebook backups/Notebook backup 1.zip", "Notes/x.notebook.tmp", "", "/abs", "a//b", "a/../b"]) {
			expect(alwaysExcluded(p, FIXED), p).toBe(true);
			expect(inScope(p, vault, FIXED), p).toBe(false);
		}
		expect(alwaysExcluded("Notebook backups2/x.zip", FIXED)).toBe(false);
		expect(alwaysExcluded("Notebooks/Maths.notebook", FIXED)).toBe(false);
		expect(alwaysExcluded("x.md", { configDir: "custom-config", backupFolder: null })).toBe(false);
		expect(alwaysExcluded("custom-config/app.json", { configDir: "custom-config", backupFolder: null })).toBe(true);
	});

	it("matches globs: * within a name, ** across folders, ? one character, names anywhere, folders with their content", () => {
		expect(globToRegExp("*.pdf").test("School/Maths/book.pdf")).toBe(true);
		expect(globToRegExp("*.pdf").test("School/book.pdf.md")).toBe(false);
		expect(globToRegExp("School/*.md").test("School/a.md")).toBe(true);
		expect(globToRegExp("School/*.md").test("School/sub/a.md")).toBe(false);
		expect(globToRegExp("School/**/*.md").test("School/sub/deep/a.md")).toBe(true);
		expect(globToRegExp("School/**/*.md").test("School/a.md")).toBe(true);
		expect(globToRegExp("**/drafts/**").test("x/drafts/y.md")).toBe(true);
		expect(globToRegExp("drafts").test("x/drafts/y.md")).toBe(true);
		expect(globToRegExp("drafts").test("x/mydrafts/y.md")).toBe(false);
		expect(globToRegExp("note?.md").test("note1.md")).toBe(true);
		expect(globToRegExp("note?.md").test("note12.md")).toBe(false);
		expect(globToRegExp("a+b (1).md").test("a+b (1).md")).toBe(true);
		expect(globToRegExp("SCHOOL/**").test("school/x.md")).toBe(true);
	});

	it("applies the folders scope", () => {
		const rules: ScopeRules = { ...vault, mode: "folders", folders: ["School", "Work/Projects"] };
		expect(inScope("School/a.md", rules, FIXED)).toBe(true);
		expect(inScope("school/a.md", rules, FIXED)).toBe(true);
		expect(inScope("Schools/a.md", rules, FIXED)).toBe(false);
		expect(inScope("Work/Projects/x/y.pdf", rules, FIXED)).toBe(true);
		expect(inScope("Work/other.md", rules, FIXED)).toBe(false);
		expect(inScope("a.md", { ...rules, folders: [] }, FIXED)).toBe(false);
	});

	it("applies include / exclude rules and file types (exclude wins)", () => {
		const rules: ScopeRules = { ...vault, mode: "rules", include: ["Notebooks/**", "*.pdf"], exclude: ["**/drafts/**", "*.zip"], types: [] };
		expect(inScope("Notebooks/a.notebook", rules, FIXED)).toBe(true);
		expect(inScope("Other/book.pdf", rules, FIXED)).toBe(true);
		expect(inScope("Other/a.md", rules, FIXED)).toBe(false);
		expect(inScope("Notebooks/drafts/a.notebook", rules, FIXED)).toBe(false);
		expect(inScope("Notebooks/x.zip", rules, FIXED)).toBe(false);
		const typed: ScopeRules = { ...vault, mode: "rules", types: ["notebook", "png"] };
		expect(inScope("a/b.notebook", typed, FIXED)).toBe(true);
		expect(inScope("a/b.PNG", typed, FIXED)).toBe(true);
		expect(inScope("a/b.md", typed, FIXED)).toBe(false);
		expect(inScope("a/README", typed, FIXED)).toBe(false);
	});

	it("reads the settings leniently and builds the rules from them", () => {
		expect(readCloudSyncSettings({})).toEqual(DEFAULT_CLOUD_SYNC_SETTINGS);
		expect(DEFAULT_CLOUD_SYNC_SETTINGS.cloudSyncProvider).toBe("off");
		const s = readCloudSyncSettings({ cloudSyncProvider: "onedrive", cloudSyncScope: "folders", cloudSyncFolders: "/School/, Work", cloudSyncInterval: 9999, cloudSyncLargeMb: -4, cloudSyncLarge: "nope", cloudSyncWifiOnly: "yes" });
		expect(s.cloudSyncProvider).toBe("onedrive");
		expect(s.cloudSyncInterval).toBe(240);
		expect(s.cloudSyncLargeMb).toBe(0);
		expect(s.cloudSyncLarge).toBe("ask");
		expect(s.cloudSyncWifiOnly).toBe(true);
		expect(scopeRules(s).folders).toEqual(["School", "Work"]);
		expect(readCloudSyncSettings({ cloudSyncProvider: "dropbox" }).cloudSyncProvider).toBe("off");
		expect(fixedExclusions(CONFIG_DIR, "/Backups/")).toEqual({ configDir: CONFIG_DIR, backupFolder: "Backups" });
	});
});

describe("cloud sync network check (#126)", () => {
	it("stops on a mobile network when Wi-Fi only is on, allows an unknown network but says so", () => {
		expect(networkVerdict({ onLine: true, connection: { type: "wifi" } }, true)).toBe("ok");
		expect(networkVerdict({ onLine: true, connection: { type: "ethernet" } }, true)).toBe("ok");
		expect(networkVerdict({ onLine: true, connection: { type: "cellular" } }, true)).toBe("metered");
		expect(networkVerdict({ onLine: true, connection: { type: "cellular" } }, false)).toBe("ok");
		expect(networkVerdict({ onLine: true }, true)).toBe("unknown");
		expect(networkVerdict({ onLine: true, connection: { type: "unknown" } }, true)).toBe("unknown");
		expect(networkVerdict(undefined, true)).toBe("unknown");
		expect(networkVerdict({ onLine: false }, false)).toBe("offline");
		expect(networkVerdict({ onLine: true, connection: { type: "none" } }, false)).toBe("offline");
	});
});
