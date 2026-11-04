/**
 * 0.17 task (roadmap #57): "Make task" from a selection, on the `doc=task` scenario (npm run harness:check). The whole plugin
 * starts against the stub (as daily-check.ts does). Checked: the dialog (the primary button is off until there is a text; the
 * tasks-note choice appears only for a note that exists; the note picker row shows only for "Another note"); a task added to a
 * chosen note leaves the rest of the note byte for byte, writes a real PNG crop that the shared-files inbox will not offer, and the
 * line has the picture, the link to the page and the date; the daily note is not created unless the setting allows it, is made
 * (from the core Daily notes options) when it does, and a second task is appended below the first. The filled dialog is left on
 * screen for the screenshot.
 */
import NotebookPlugin from "../../src/main";
import { MakeTaskModal, runMakeTask, type TaskHost } from "../../src/view/selection-task";
import { createPage, createStroke } from "../../src/model/document";
import { loadWritten } from "../../src/storage/plugin-written";
import { isoDate } from "../../src/view/lecture-logic";
import { t } from "../../src/i18n";
import { App, type Plugin as StubPlugin } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface TaskCheckApi {
	errors: string[];
	notices: string[];
}

const MANIFEST = { id: "notebook", name: "Notebook", version: "0.0.0-harness", dir: "plugins/notebook" };

export async function checkTask(api: TaskCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

	const app = new App();
	const plugin = new NotebookPlugin(app as never, MANIFEST as never) as NotebookPlugin & StubPlugin;
	await plugin.onload();
	const settings = plugin.settings;
	add("the plugin starts with the due date as the Tasks plugin's emoji and no tasks note", settings.taskDueEmoji && settings.tasksNote === "");
	const vault = app.vault;
	const read = async (path: string): Promise<string | null> => {
		const f = vault.getFileByPath(path);
		return f ? vault.read(f) : null;
	};
	const now = new Date(2026, 10, 4, 9, 30, 15);
	const iso = isoDate(now);
	const notebook = await vault.create("Notebooks/Maths.notebook", "{}");
	const page = createPage({ width: 595, height: 842 }, { kind: "ruled", spacing: 22.68 });
	page.strokes = [createStroke("#1d4ed8", 3, [[100, 120, 0.5], [180, 150, 0.6], [260, 130, 0.5]], "pen")];
	const host = (target: { crop?: { x: number; y: number; width: number; height: number } } = {}): TaskHost => ({
		app: app as never, file: notebook as never, settings, page, pageNumber: 3,
		crop: target.crop ?? { x: 88, y: 108, width: 190, height: 60 }, media: null, render: {},
	});
	const dialogButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".notebook-task-modal .nb-modal-btn"));
	const primary = () => dialogButtons().find((b) => b.classList.contains("is-primary") || b.className.includes("primary")) ?? dialogButtons()[dialogButtons().length - 1];

	// 1. A task in a chosen note: the rest of the note is untouched, the crop is a PNG, the line has everything.
	const original = "# Inbox\r\n\r\n- keep this\r\n- [ ] and this";
	const inbox = await vault.create("Notes/Inbox.md", original);
	const done = await runMakeTask(host(), { text: "Check the limit", due: "2026-11-10", target: { kind: "file", file: inbox as never } }, now);
	const after = (await read("Notes/Inbox.md")) ?? "";
	add("the task goes to the chosen note", done === "Notes/Inbox.md" && after.startsWith(`${original}\r\n`) && after.endsWith("\r\n"), JSON.stringify(after.slice(original.length)));
	const line = after.slice(original.length).trim();
	add("the line has the text, a 200 px picture, the page link and the date last", /^- \[ \] Check the limit !\[\[Attachments\/Maths task p3-093015\.png\|200\]\] \[\[Notebooks\/Maths\.notebook#p3[^\]]*\|Maths, page 3\]\] \u{1F4C5} 2026-11-10$/u.test(line), line);
	const picture = vault.getFileByPath("Attachments/Maths task p3-093015.png");
	const bytes = picture ? new Uint8Array(await vault.readBinary(picture)) : new Uint8Array();
	add("the crop is a real PNG", bytes.length > 100 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, String(bytes.length));
	add("the picture is remembered as written by the plugin", "Attachments/Maths task p3-093015.png" in loadWritten(app));

	// 2. The daily note: not created by default; made from the core options when allowed; the next task goes below.
	(app as unknown as { internalPlugins: unknown }).internalPlugins = {
		getPluginById: (id: string) => (id === "daily-notes" ? { enabled: true, instance: { options: { folder: "Daily", format: "YYYY-MM-DD" } } } : undefined),
	};
	const dailyPath = `Daily/${iso}.md`;
	const before = api.notices.length;
	const refused = await runMakeTask(host(), { text: "First", due: "", target: { kind: "daily" } }, now);
	add("a missing daily note is left alone by default", refused === null && (await read(dailyPath)) === null && api.notices.slice(before).includes(t("daily.noteMissing", { path: dailyPath })), api.notices.slice(before).join(" | "));
	add("…and no picture is left behind", !vault.getFileByPath("Attachments/Maths task p3-093015 1.png"));
	settings.dailyCreateNote = true;
	const made = await runMakeTask(host(), { text: "First", due: "", target: { kind: "daily" } }, now);
	const first = (await read(dailyPath)) ?? "";
	add("with the setting on, the daily note is created with the task", made === dailyPath && first.startsWith("- [ ] First ![[Attachments/") && !first.includes("\u{1F4C5}"), JSON.stringify(first));
	await runMakeTask(host(), { text: "Second", due: "2026-12-01", target: { kind: "daily" } }, new Date(2026, 10, 4, 9, 31, 2));
	const second = (await read(dailyPath)) ?? "";
	add("a second task is appended below the first", second.startsWith(first) && second.split("\n").filter((l) => l.startsWith("- [ ] ")).length === 2, JSON.stringify(second.slice(first.length)));
	settings.dailyCreateNote = false;
	api.errors.splice(0, api.errors.length);

	// 3. The dialog.
	settings.tasksNote = "Missing/Tasks";
	const modal = new MakeTaskModal(app as never, settings, 3, () => undefined);
	modal.open();
	await sleep(40);
	const q = (sel: string) => document.querySelector<HTMLElement>(`.notebook-task-modal ${sel}`);
	const select = q("select") as HTMLSelectElement | null;
	add("the dialog has a text, a date and a target", !!q("#nb-task-text") && !!q("#nb-task-due") && !!select);
	add("a tasks note that does not exist is not offered", !!select && Array.from(select.options).map((o) => o.value).join(",") === "daily,pick", select ? Array.from(select.options).map((o) => o.value).join(",") : "");
	add("Add task is off while there is no text", primary()?.disabled === true);
	const text = q("#nb-task-text") as HTMLInputElement | null;
	if (text) {
		text.value = "Redo exercise 4";
		text.dispatchEvent(new Event("input"));
	}
	add("…and on once there is one", primary()?.disabled === false);
	if (select) {
		select.value = "pick";
		select.dispatchEvent(new Event("change"));
	}
	add("'Another note…' needs a note before it can be added", primary()?.disabled === true && q(".nb-task-pick")?.classList.contains("nb-task-hidden") === false);
	if (select) {
		select.value = "daily";
		select.dispatchEvent(new Event("change"));
	}
	add("the note picker row is hidden for the daily note", q(".nb-task-pick")?.classList.contains("nb-task-hidden") === true && primary()?.disabled === false);
	const buttons = dialogButtons().filter((b) => b.getBoundingClientRect().height > 0);
	add("every button is a 40 px target", buttons.length === 2 && buttons.every((b) => b.getBoundingClientRect().height >= 40), buttons.map((b) => Math.round(b.getBoundingClientRect().height)).join(","));
	const box = document.querySelector<HTMLElement>(".notebook-task-modal");
	add("the dialog fits the screen", !!box && box.getBoundingClientRect().left >= 0 && box.getBoundingClientRect().right <= window.innerWidth + 1);
	const due = q("#nb-task-due") as HTMLInputElement | null;
	if (due) {
		due.value = "2026-11-12";
		due.dispatchEvent(new Event("input"));
	}
	if (box && !box.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(box);
	await sleep(40);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
