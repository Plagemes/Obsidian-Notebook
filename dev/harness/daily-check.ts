/**
 * 0.15 daily (roadmap O12): "Today's page" and the link from the daily note, on the `doc=daily` scenario (npm run
 * harness:check). The whole plugin starts against the stub (as hints-check.ts does). Checked: the link goes into today's
 * daily note once (a second run writes nothing) and the rest of the note is untouched; a missing note is left alone unless
 * "Create the daily note if missing" is on; Periodic Notes wins over the core plugin; nothing available gives a notice and
 * never an exception; the settings rows exist (the create option only while linking is on); the first-use confirmation
 * dialog has a working Cancel and Create. The settings tab and the dialog are left on screen for the screenshot.
 */
import NotebookPlugin from "../../src/main";
import { confirmCreate, linkFromDailyNote } from "../../src/library/daily";
import { isoDate } from "../../src/view/lecture-logic";
import { t } from "../../src/i18n";
import { App, type Plugin as StubPlugin } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface DailyCheckApi {
	errors: string[];
	notices: string[];
}

const MANIFEST = { id: "notebook", name: "Notebook", version: "0.0.0-harness", dir: "plugins/notebook" };

export async function checkDaily(api: DailyCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const frames = async () => {
		await sleep(30);
	};

	const app = new App();
	const plugin = new NotebookPlugin(app as never, MANIFEST as never) as NotebookPlugin & StubPlugin;
	await plugin.onload();
	add("the plugin starts with the daily options off", !plugin.settings.dailyLink && !plugin.settings.dailyCreateNote && plugin.settings.dailyNotebookPath === "");
	const vault = app.vault;
	const now = new Date(2026, 10, 4, 9, 30);
	const iso = isoDate(now);
	const notebook = await vault.create("Notebooks/Daily.notebook", "{}");
	const settings = plugin.settings;
	const notePath = `Daily/${iso}.md`;
	const core = (folder: string, format: string) => ({ getEnabledPluginById: (id: string) => (id === "daily-notes" ? { instance: { options: { folder, format } } } : null) });
	const text = async (path: string): Promise<string | null> => {
		const f = vault.getFileByPath(path);
		return f ? vault.read(f) : null;
	};
	const noticeCount = () => api.notices.length;
	const lastNotice = () => api.notices[api.notices.length - 1] ?? "";

	// 1. Nothing available: a notice, no exception, no file.
	let before = noticeCount();
	await linkFromDailyNote(app as never, settings, notebook as never, 2, "p-day1", now);
	add("no Daily notes plugin: a notice and no note", noticeCount() === before + 1 && lastNotice() === t("daily.unavailable") && (await text(notePath)) === null, lastNotice());
	(app as unknown as { internalPlugins: unknown }).internalPlugins = { getEnabledPluginById: () => { throw new Error("harness: internals changed"); } };
	await linkFromDailyNote(app as never, settings, notebook as never, 2, "p-day1", now);
	add("unexpected internals do not throw", (await text(notePath)) === null);
	api.errors.splice(0, api.errors.length); // the failure above logs on purpose

	// 2. The core plugin is on, today's note does not exist, "create" is off: left alone.
	(app as unknown as { internalPlugins: unknown }).internalPlugins = core("Daily", "YYYY-MM-DD");
	before = noticeCount();
	await linkFromDailyNote(app as never, settings, notebook as never, 2, "p-day1", now);
	add("a missing daily note is not created by default", (await text(notePath)) === null && lastNotice() === t("daily.noteMissing", { path: notePath }) && noticeCount() === before + 1, lastNotice());

	// 3. The note exists: the link is appended once and everything else stays.
	const original = "# Tuesday\r\n\r\n- call mum\r\n- [ ] buy milk";
	await vault.create(notePath, original);
	await linkFromDailyNote(app as never, settings, notebook as never, 2, "p-day1", now);
	const once = (await text(notePath)) ?? "";
	add("the link is added at the end", once.startsWith(original) && once.includes("[[Notebooks/Daily.notebook#p2&id=p-day1|") && once.endsWith("\r\n"), JSON.stringify(once.slice(original.length)));
	add("the rest of the note is untouched", once.startsWith(`${original}\r\n`), "");
	before = noticeCount();
	await linkFromDailyNote(app as never, settings, notebook as never, 2, "p-day1", now);
	add("a second run writes nothing", (await text(notePath)) === once && noticeCount() === before, lastNotice());
	await linkFromDailyNote(app as never, settings, notebook as never, 3, "p-day1", now);
	add("the same page at another number is still the same link", (await text(notePath)) === once);

	// 4. Create the note when asked to; Periodic Notes wins over the core plugin.
	settings.dailyCreateNote = true;
	(app as unknown as { plugins: unknown }).plugins = { getPlugin: (id: string) => (id === "periodic-notes" ? { settings: { daily: { enabled: true, folder: "Journal/", format: "YYYY-MM-DD" } } } : null) };
	await linkFromDailyNote(app as never, settings, notebook as never, 1, "p-day2", now);
	const made = await text(`Journal/${iso}.md`);
	add("Periodic Notes' folder wins, and the missing note is created with the link", !!made && made.includes("p-day2") && (await text(`Daily/${iso}.md`)) === once, String(made));
	settings.dailyCreateNote = false;

	// 5. The settings rows.
	const tab = plugin.registered.settingTabs[0];
	if (tab) {
		tab.containerEl.addClass("harness-settings");
		document.body.appendChild(tab.containerEl);
		tab.showDeclarative();
		const names = () => new Set([...tab.containerEl.querySelectorAll(".setting-item-name")].map((el) => el.textContent ?? ""));
		const visibleRow = (name: string): boolean => {
			const row = [...tab.containerEl.querySelectorAll<HTMLElement>(".setting-item")].find((el) => el.querySelector(".setting-item-name")?.textContent === name);
			return !!row && row.offsetParent !== null;
		};
		add("the settings tab has the daily notebook and link rows", names().has(t("settings.dailyNotebook")) && names().has(t("settings.dailyLink")));
		add("'Create the daily note if missing' is hidden while linking is off", !visibleRow(t("settings.dailyCreateNote")));
		settings.dailyLink = true;
		tab.containerEl.empty();
		tab.showDeclarative();
		add("…and shown once linking is on", visibleRow(t("settings.dailyCreateNote")));
	} else {
		add("the settings tab is registered", false);
	}

	// 6. The first-use confirmation: Cancel says no, Create says yes; the second one is left open for the screenshot.
	const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".notebook-daily-modal .nb-modal-btn"));
	const cancelled = confirmCreate(app as never, "Notebooks/Daily.notebook");
	await frames();
	add("the dialog shows the path and two buttons", !!document.querySelector(".notebook-daily-modal") && buttons().length === 2 && (document.querySelector(".notebook-daily-modal")?.textContent ?? "").includes("Notebooks/Daily.notebook"), buttons().map((b) => b.textContent).join("/"));
	buttons()[0]?.click();
	add("Cancel answers no", (await cancelled) === false);
	await frames();
	const accepted = confirmCreate(app as never, "Notebooks/Daily.notebook");
	await frames();
	add("every button is a 40 px target", buttons().every((b) => b.getBoundingClientRect().height >= 40), buttons().map((b) => Math.round(b.getBoundingClientRect().height)).join(","));
	const dialog = document.querySelector<HTMLElement>(".notebook-daily-modal");
	add("the dialog fits the screen", !!dialog && dialog.getBoundingClientRect().left >= 0 && dialog.getBoundingClientRect().right <= window.innerWidth + 1, dialog ? String(Math.round(dialog.getBoundingClientRect().width)) : "");
	buttons()[1]?.click();
	add("Create answers yes", (await accepted) === true);
	// Leave a dialog open under the settings for the screenshot.
	void confirmCreate(app as never, "Notebooks/Daily.notebook");
	await frames();
	const open = document.querySelector<HTMLElement>(".notebook-daily-modal");
	if (open && !open.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(open);
	await frames();

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
