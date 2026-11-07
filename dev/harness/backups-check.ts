/**
 * 0.21 backups (roadmap #127): scheduled zip backups, on the `doc=backups` scenario (npm run harness:check). The whole plugin
 * starts against the stub (as daily-check.ts does). Checked: nothing is made while the schedule is off; "Back up now" writes
 * one valid zip with the notebooks, the assets and the sidecars and nothing else; the file is announced as a plugin write; a
 * second request while one runs does nothing; the retention keeps the last N and never touches a file of the user's; the
 * settings rows exist (the folder and the count only while a schedule is on) and the "Back up now" row shows the status and
 * works. The settings tab is left on screen for the screenshot.
 */
import NotebookPlugin from "../../src/main";
import { readZip, verifyZipEntry } from "../../src/model/zip";
import { t } from "../../src/i18n";
import { loadWritten } from "../../src/storage/plugin-written";
import { App, type Plugin as StubPlugin } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface BackupsCheckApi {
	errors: string[];
	notices: string[];
}

const MANIFEST = { id: "notebook", name: "Notebook", version: "0.0.0-harness", dir: "plugins/notebook" };
const FOLDER = "Notebook backups";

export async function checkBackups(api: BackupsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

	const app = new App();
	const vault = app.vault;
	// The stub's adapter has no stat(); Obsidian's has. The size of the stored bytes is what it would answer.
	const store = vault as unknown as { binary: Map<string, ArrayBuffer>; text: Map<string, string> };
	(vault.adapter as unknown as { stat: (p: string) => Promise<{ size: number } | null> }).stat = async (p) => {
		const bin = store.binary.get(p);
		if (bin) return { size: bin.byteLength };
		const text = store.text.get(p);
		return text === undefined ? null : { size: new TextEncoder().encode(text).length };
	};
	const plugin = new NotebookPlugin(app as never, MANIFEST as never) as NotebookPlugin & StubPlugin;
	await plugin.onload();
	const service = plugin.backups;
	add("the plugin starts with the backup service and the schedule off", !!service && plugin.settings.zipBackupSchedule === "off" && plugin.settings.zipBackupKeep === 5 && plugin.settings.zipBackupFolder === FOLDER);
	if (!service) return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };

	// A small vault: two notebooks, one asset, one sidecar, a trashed notebook, a note.
	const doc = (name: string) => JSON.stringify({ version: 18, name });
	await vault.create("Notebooks/Maths.notebook", doc("Maths"));
	await vault.create("Notebooks/Sub/Physics.notebook", doc("Physics"));
	await vault.createBinary("Notebooks/_assets/0123456789abcdef01234567.png", Uint8Array.from({ length: 3000 }, (_, i) => (i * 13) & 255).buffer);
	await vault.create("Notebooks/_meta/folders-ab12cd34.json", "{}");
	await vault.create("Notebooks/_trash/items/x/Old.notebook", doc("Old"));
	await vault.create("Daily/today.md", "# today");
	const backups = () => vault.getFiles().filter((f) => f.path.startsWith(`${FOLDER}/`)).map((f) => f.path).sort();

	// 1. Off: the schedule makes nothing.
	await service.check();
	add("nothing is made while the schedule is off", backups().length === 0);
	add("the status line says there is no backup yet", service.statusText() === t("backup.status.never"), service.statusText());

	// 2. Back up now.
	await service.backUpNow();
	const first = backups();
	add("Back up now writes one zip in the backup folder", first.length === 1 && /^Notebook backups\/Notebook backup \d{8}-\d{6}\.zip$/.test(first[0] ?? ""), first.join(","));
	const zipFile = first[0] ? vault.getFileByPath(first[0]) : null;
	const bytes = zipFile ? new Uint8Array(await vault.readBinary(zipFile)) : new Uint8Array(0);
	let names: string[] = [];
	let sound = false;
	try {
		const listing = readZip(bytes);
		names = listing.entries.map((e) => e.name);
		sound = listing.entries.every((e) => verifyZipEntry(bytes, e));
	} catch (e) {
		add("the zip can be read", false, String(e));
	}
	add("every entry of the zip passes its checksum", sound);
	add("the zip holds the notebooks, the asset and the sidecar, and not the trash or the notes", names.join("|") === "Notebooks/Maths.notebook|Notebooks/Sub/Physics.notebook|Notebooks/_assets/0123456789abcdef01234567.png|Notebooks/_meta/folders-ab12cd34.json", names.join("|"));
	add("no temporary file is left", !vault.getFiles().some((f) => f.path.endsWith(".tmp")));
	add("the zip is recorded as a plugin write", zipFile !== null && Object.prototype.hasOwnProperty.call(loadWritten(app), zipFile.path));
	add("the sources are untouched", (await vault.read(vault.getFileByPath("Notebooks/Maths.notebook")!)) === doc("Maths"));
	add("a notice told the result", api.notices.some((n) => n.startsWith("Backup saved")), api.notices.join(" | "));
	add("the status line shows the last backup", service.statusText().startsWith("Last backup") && service.statusText().includes("4 files"), service.statusText());

	// 3. One at a time.
	const running = service.backUpNow();
	const before = api.notices.length;
	add("the service reports it is running", service.running());
	await service.backUpNow();
	await running;
	add("a second request while one runs only says so", api.notices.slice(before).includes(t("backup.already")), api.notices.slice(before).join(" | "));

	// 4. Retention: keep 2; files of the user's in the folder are never touched.
	plugin.settings.zipBackupKeep = 2;
	const mine = [`${FOLDER}/holiday.zip`, `${FOLDER}/notes.md`, `${FOLDER}/Notebook backup 2020.zip`, `${FOLDER}/Sub/Notebook backup 20200101-000000.zip`];
	for (const p of mine) await vault.create(p, "mine");
	for (let i = 0; i < 3; i++) await service.backUpNow();
	const ours = backups().filter((p) => /^Notebook backups\/Notebook backup \d{8}-\d{6}\.zip$/.test(p));
	add("only the last 2 backups remain", ours.length === 2, ours.join(","));
	add("the user's own files in the folder are all still there", mine.every((p) => vault.getFileByPath(p) !== null));

	// 5. The settings rows.
	const tab = plugin.registered.settingTabs[0];
	if (tab) {
		tab.containerEl.addClass("harness-settings");
		document.body.appendChild(tab.containerEl);
		tab.showDeclarative();
		const rows = () => [...tab.containerEl.querySelectorAll<HTMLElement>(".setting-item")];
		const row = (name: string) => rows().find((el) => el.querySelector(".setting-item-name")?.textContent === name);
		const shown = (name: string) => {
			const el = row(name);
			return !!el && el.offsetParent !== null;
		};
		add("the schedule row is there", shown(t("settings.backupSchedule")));
		add("the Back up now row is there", shown(t("settings.backupNow")));
		add("the folder and the count are hidden while the schedule is off", !shown(t("settings.backupFolder")) && !shown(t("settings.backupKeep")));
		plugin.settings.zipBackupSchedule = "weekly";
		tab.containerEl.empty();
		tab.showDeclarative();
		add("…and shown once a schedule is on", shown(t("settings.backupFolder")) && shown(t("settings.backupKeep")));
		const button = row(t("settings.backupNow"))?.querySelector<HTMLButtonElement>("button");
		const countBefore = backups().length;
		const noticesBefore = api.notices.length;
		button?.click();
		await sleep(400);
		add("the Back up now button works and the description follows the result", !!button && api.notices.length > noticesBefore && backups().length >= Math.min(countBefore, 2) && (row(t("settings.backupNow"))?.textContent ?? "").includes("Last backup"), row(t("settings.backupNow"))?.textContent ?? "");
		add("the button is a usable target", (button?.getBoundingClientRect().height ?? 0) >= 28, String(button?.getBoundingClientRect().height));
	} else {
		add("the settings tab is registered", false);
	}

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
