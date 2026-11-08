/**
 * 0.22 synccore (roadmap #126): the optional cloud sync, on the `doc=synccore` scenario (npm run harness:check). The whole plugin
 * starts against the stub (as backups-check.ts does) with an in-memory cloud (synccore-fake.ts) in place of Google Drive.
 * Checked: off by default and nothing runs; the "Cloud sync" group of the Sync section shows only the service choice until one
 * is chosen; without the providers the account row says sign-in is not available and offers no button (no fake control); with a
 * sign-in, "Sign in" works and the first sync is a union; a notebook changed on both sides keeps both (a conflicted copy named
 * for the #122 merge offer); deleting many files stops and asks, and "Keep them" copies them back; the status line and the
 * activity log follow. `variant=modal` leaves the deletion dialog open for its screenshot; otherwise the settings stay on screen.
 */
import NotebookPlugin from "../../src/main";
import { t } from "../../src/i18n";
import { conflictBaseOf } from "../../src/storage/conflicts";
import { App, type Plugin as StubPlugin } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";
import { HarnessCloud, harnessAuth } from "./synccore-fake";

export interface SynccoreCheckApi {
	errors: string[];
	notices: string[];
}

const MANIFEST = { id: "notebook", name: "Notebook", version: "0.0.0-harness", dir: "plugins/notebook" };

export async function checkSynccore(api: SynccoreCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const variant = new URLSearchParams(location.search).get("variant");

	const app = new App();
	const vault = app.vault;
	const plugin = new NotebookPlugin(app as never, MANIFEST as never) as NotebookPlugin & StubPlugin;
	await plugin.onload();
	const service = plugin.cloudSync;
	add("the plugin starts with the cloud sync service, off by default", !!service && plugin.settings.cloudSyncProvider === "off");
	if (!service) return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	add("nothing runs while it is off", (await service.syncNow()) === null && api.notices.includes(t("cloudSync.notice.off")), api.notices.join(" | "));

	const doc = (name: string, extra = "") => JSON.stringify({ version: 19, id: "doc-maths-0001", name, extra });
	await vault.create("Notebooks/Maths.notebook", doc("Maths"));
	await vault.create("Notebooks/Physics.notebook", JSON.stringify({ version: 19, id: "doc-phys-0001", name: "Physics" }));
	await vault.create("Daily/today.md", "# today");

	const tab = plugin.registered.settingTabs[0];
	if (!tab) {
		add("the settings tab is registered", false);
		return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	}
	tab.containerEl.addClass("harness-settings");
	document.body.appendChild(tab.containerEl);
	const redraw = () => {
		tab.containerEl.empty();
		tab.showDeclarative();
	};
	const rows = () => [...tab.containerEl.querySelectorAll<HTMLElement>(".setting-item")];
	const row = (name: string) => rows().find((el) => el.querySelector(".setting-item-name")?.textContent === name);
	const shown = (name: string) => {
		const el = row(name);
		return !!el && el.offsetParent !== null;
	};
	redraw();
	add("the Cloud sync group is in the Sync section, closed while off", shown(t("settings.cloudSync")) && !shown(t("settings.cloudSyncProvider")));
	row(t("settings.cloudSync"))?.click();
	await sleep(30);
	add("opened, it shows only the service choice while off", shown(t("settings.cloudSyncProvider")) && !shown(t("settings.cloudSyncAccount")) && !shown(t("settings.cloudSyncScope")));

	plugin.settings.cloudSyncProvider = "gdrive";
	redraw();
	const account = () => row(t("settings.cloudSyncAccount"));
	add("with a service chosen, the options are shown", shown(t("settings.cloudSyncAccount")) && shown(t("settings.cloudSyncNow")) && shown(t("settings.cloudSyncScope")) && shown(t("settings.cloudSyncWifiOnly")) && shown(t("settings.cloudSyncLog")));
	add("rules fields show only for their scope", !shown(t("settings.cloudSyncFolders")) && !shown(t("settings.cloudSyncInclude")));
	add(
		"without the providers, the account row says sign-in is not available and offers no button",
		(account()?.textContent ?? "").includes(t("cloudSync.account.unavailable", { provider: "Google Drive" })) && account()?.querySelector("button") === null,
		account()?.textContent ?? "",
	);

	// The in-memory cloud already holds a note from "another device".
	const cloud = new HarnessCloud();
	cloud.put("Daily/yesterday.md", "# yesterday");
	const auth = harnessAuth(cloud);
	service.setAuth(auth);
	const signIn = [...(account()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === t("cloudSync.account.signIn"));
	add("with a sign-in available, the account row offers Sign in", !!signIn);
	add("Google asks for the client ID and the (device-local) client secret", shown(t("settings.cloudSyncClientId")) && shown(t("settings.cloudSyncSecret")) && row(t("settings.cloudSyncSecret"))?.querySelector("input")?.type === "password");
	signIn?.click();
	await sleep(30);
	add("without a client ID, Sign in says what is missing and does nothing", !auth.signedIn && api.notices.includes(t("cloudSync.notice.clientId", { provider: "Google Drive" })), api.notices.slice(-2).join(" | "));
	plugin.settings.cloudSyncGdriveClientId = "1234-harness.apps.googleusercontent.com";
	const secretInput = row(t("settings.cloudSyncSecret"))?.querySelector("input");
	if (secretInput) {
		secretInput.value = "harness-secret";
		secretInput.dispatchEvent(new Event("input"));
	}
	add("the client secret is kept in this device's local storage, not in the settings", service.clientSecret("gdrive") === "harness-secret" && !JSON.stringify(plugin.settings).includes("harness-secret"));
	signIn?.click();
	for (let i = 0; i < 50 && (service.running() || cloud.files.size < 4); i++) await sleep(50);
	add("Sign in works and starts the first sync: a union of both sides", auth.signedIn && cloud.text("Notebooks/Maths.notebook") === doc("Maths") && vault.getFileByPath("Daily/yesterday.md") !== null, [...cloud.files.keys()].join(","));
	add("the account row shows the account and the cloud folder, and Disconnect", (account()?.textContent ?? "").includes("student@example.com") && [...(account()?.querySelectorAll("button") ?? [])].some((b) => b.textContent === t("cloudSync.account.disconnect")));
	const nowRow = () => row(t("settings.cloudSyncNow"));
	add("the status line shows the last sync", (nowRow()?.textContent ?? "").includes("Last sync"), nowRow()?.textContent ?? "");
	add("the status says the network type could not be checked (no Network Information type here)", typeof (navigator as { connection?: { type?: string } }).connection?.type === "string" || (nowRow()?.textContent ?? "").includes(t("cloudSync.status.unknownNetwork")), nowRow()?.textContent ?? "");
	add("the activity log lists what was sent and received", (row(t("settings.cloudSyncLog"))?.querySelectorAll(".nb-cloudsync-log-line").length ?? 0) >= 3);

	// Both sides change the same notebook: both are kept, the cloud's as a conflicted copy the #122 merge offer recognises.
	cloud.put("Notebooks/Maths.notebook", doc("Maths", "tablet"));
	const maths = vault.getFileByPath("Notebooks/Maths.notebook");
	if (maths) await vault.modify(maths, doc("Maths", "phone"));
	await service.syncNow();
	const copy = vault.getFiles().find((f) => f.path.startsWith("Notebooks/Maths (conflict "));
	add("a notebook changed on both sides keeps both versions", !!copy && maths !== null && (await vault.read(maths)) === doc("Maths", "phone") && cloud.text("Notebooks/Maths.notebook") === doc("Maths", "phone"), copy?.path ?? "no copy");
	add("the copy is named like a conflicted copy of the notebook (#122)", !!copy && conflictBaseOf(copy.basename, new Set(["Maths"])) === "Maths", copy?.basename ?? "");
	add("a notice says both versions were kept", api.notices.some((n) => n.startsWith("Cloud sync kept both versions")), api.notices.slice(-3).join(" | "));

	// Many deletions at once: the sync stops and asks.
	for (let i = 0; i < 24; i++) await vault.create(`Notebooks/Pages/page ${i}.md`, `page ${i}`);
	await service.syncNow();
	for (let i = 0; i < 24; i++) {
		const f = vault.getFileByPath(`Notebooks/Pages/page ${i}.md`);
		if (f) await app.fileManager.trashFile(f);
	}
	await service.syncNow();
	await sleep(50);
	const modal = document.querySelector<HTMLElement>(".nb-cloudsync-modal");
	add("deleting many files stops and asks", !!modal && cloud.files.has("Notebooks/Pages/page 0.md") && (modal.textContent ?? "").includes(t("cloudSync.deletes.title", { count: "24" })), modal?.textContent?.slice(0, 120) ?? "no dialog");
	add("the Review button shows while the sync waits", !!nowRow()?.querySelector("button:not(.notebook-hidden)") && service.waiting());
	if (variant !== "modal") {
		const keep = [...(modal?.querySelectorAll("button") ?? [])].find((b) => b.textContent === t("cloudSync.deletes.keep"));
		keep?.click();
		for (let i = 0; i < 50 && (service.running() || vault.getFileByPath("Notebooks/Pages/page 0.md") === null); i++) await sleep(50);
		add("Keep them copies the files back", vault.getFileByPath("Notebooks/Pages/page 23.md") !== null && cloud.files.has("Notebooks/Pages/page 23.md") && cloud.trash.length === 0);
		redraw();
		row(t("settings.cloudSync"))?.scrollIntoView({ block: "start" });
		await sleep(50);
	} else {
		// The stub appends the dialog to the page; the harness layer shows it (the settings layer would cover it, so it goes).
		tab.containerEl.remove();
		if (modal && !modal.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(modal.closest(".modal") ?? modal);
		await sleep(50);
		const btn = modal?.querySelector<HTMLElement>("button");
		add("the dialog's buttons are usable targets", (btn?.getBoundingClientRect().height ?? 0) >= 32, String(btn?.getBoundingClientRect().height));
	}
	add("no error notices on the way", !api.notices.some((n) => n.startsWith("Cloud sync failed")), api.notices.join(" | "));

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
