// 0.17 (#57) Task from a selection: the dialog and the vault side. The selected region of the page is drawn through the shared page
// renderer (ink, the PDF page, pictures and the state a page is shown in all appear), saved as a picture where Obsidian puts
// attachments (remembered as written by the plugin, so the shared-files inbox never offers it), and a task line
// `- [ ] text ![[crop|200]] [[link to the page]] <date>` is added to the end of the daily note, a configured tasks note or a chosen
// note. Existing notes change only through vault.process (the rest of the note is untouched); the daily note is made only through
// the daily-note path (library/daily.ts).
import { FuzzySuggestModal, Modal, TFile, normalizePath, type App, type FuzzyMatch } from "obsidian";
import { t } from "../i18n";
import { appendToDailyNote } from "../library/daily";
import { stablePageSubpath, withEmbedMarker } from "../integration/page-links";
import { DEFAULT_MARKDOWN_DPI } from "../model/export-markdown";
import { appendTaskLine, buildTaskLine, cleanTaskText, embedWithWidth, isIsoDate, isSubmitKey, taskPictureName, taskStamp, TASK_IMAGE_WIDTH, type TaskRect } from "../model/selection-task";
import type { Page } from "../model/types";
import type { NotebookSettings } from "../settings";
import { recordPluginWrite } from "../storage/plugin-written";
import { ensureFolder } from "../storage/vault-io";
import { sanitizeName } from "../storage/names";
import { modalShell, shellButton, shellField, shellNote } from "../ui/components/modal-shell";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer, type PageImageOptions } from "./page-images";

/** Where the task goes. */
export type TaskTarget = { kind: "daily" } | { kind: "file"; file: TFile };

export interface TaskRequest {
	text: string;
	/** `YYYY-MM-DD` or empty. */
	due: string;
	target: TaskTarget;
}

export interface TaskHost {
	app: App;
	file: TFile;
	settings: NotebookSettings;
	/** The page as the view shows it (the live view of a page with states). */
	page: Page;
	pageNumber: number;
	/** The region to draw, in page points. */
	crop: TaskRect;
	media: NotebookMedia | null;
	render: PageImageOptions;
	prepare?: (pages: readonly Page[]) => Promise<void>;
}

/** The configured tasks note, when it exists (a note that is not there is never made from here). */
export function configuredTasksNote(app: App, settings: NotebookSettings): TFile | null {
	const path = settings.tasksNote.trim();
	if (path === "") return null;
	const f = app.vault.getFileByPath(normalizePath(/\.md$/iu.test(path) ? path : `${path}.md`));
	return f instanceof TFile ? f : null;
}

class NotePicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly choose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder(t("task.pick.placeholder"));
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
		this.choose(file);
	}

	renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
		el.setText(match.item.path);
	}
}

let lastTarget: "daily" | "tasks" = "daily";

/** The dialog: the task's text, an optional due date and the note it goes to. */
export class MakeTaskModal extends Modal {
	private text = "";
	private due = "";
	private choice: "daily" | "tasks" | "pick" = lastTarget;
	private picked: TFile | null = null;

	constructor(app: App, private readonly settings: NotebookSettings, private readonly page: number, private readonly run: (request: TaskRequest) => void) {
		super(app);
	}

	onOpen(): void {
		const tasksNote = configuredTasksNote(this.app, this.settings);
		if (this.choice === "tasks" && !tasksNote) this.choice = "daily";
		const shell = modalShell(this, { title: t("task.title"), icon: "list-checks", size: "narrow", cls: "notebook-task-modal" });
		shellNote(shell.body, t("task.desc", { page: String(this.page) }));
		const textField = shellField(shell.body, t("task.text"), "nb-task-text");
		const input = textField.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-task-text", type: "text", maxlength: "300", autocomplete: "off", placeholder: t("task.text.placeholder") } });
		const dueField = shellField(shell.body, t("task.due"), "nb-task-due");
		const date = dueField.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-task-due", type: "date" } });
		const targetField = shellField(shell.body, t("task.target"), "nb-task-target");
		const select = targetField.createEl("select", { cls: "nb-modal-input dropdown", attr: { id: "nb-task-target" } });
		select.createEl("option", { value: "daily", text: t("task.target.daily") });
		if (tasksNote) select.createEl("option", { value: "tasks", text: t("task.target.tasks", { note: tasksNote.basename }) });
		select.createEl("option", { value: "pick", text: t("task.target.pick") });
		select.value = this.choice;
		const pickRow = targetField.createDiv({ cls: "nb-task-pick" });
		const chosen = pickRow.createSpan({ cls: "nb-modal-note nb-task-chosen" });
		shellButton(pickRow, "secondary", t("task.choose"), () => {
			new NotePicker(this.app, (f) => {
				this.picked = f;
				refresh();
			}).open();
		});
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		const make = shellButton(shell.foot, "primary", t("task.make"), () => this.submit(tasksNote), { icon: "plus" });
		const refresh = () => {
			pickRow.toggleClass("nb-task-hidden", this.choice !== "pick");
			chosen.setText(this.picked ? this.picked.path : t("task.pick.none"));
			make.disabled = cleanTaskText(this.text) === "" || (this.choice === "pick" && !this.picked) || (this.due !== "" && !isIsoDate(this.due));
		};
		input.addEventListener("input", () => {
			this.text = input.value;
			refresh();
		});
		input.addEventListener("keydown", (e) => {
			// The Enter that confirms an IME composition (Japanese, Chinese, Korean keyboards) is not "add the task".
			if (isSubmitKey(e) && !make.disabled) this.submit(tasksNote);
		});
		date.addEventListener("input", () => {
			this.due = date.value;
			refresh();
		});
		select.addEventListener("change", () => {
			if (select.value === "daily" || select.value === "tasks" || select.value === "pick") this.choice = select.value;
			refresh();
		});
		refresh();
		window.setTimeout(() => input.focus(), 0);
	}

	private submit(tasksNote: TFile | null): void {
		const text = cleanTaskText(this.text);
		if (text === "") return;
		const target: TaskTarget | null = this.choice === "daily" ? { kind: "daily" } : this.choice === "tasks" ? (tasksNote ? { kind: "file", file: tasksNote } : null) : this.picked ? { kind: "file", file: this.picked } : null;
		if (!target) return;
		if (this.choice !== "pick") lastTarget = this.choice;
		this.close();
		this.run({ text, due: this.due, target });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Saves the crop where Obsidian keeps attachments of the note and returns its embed with a display width; null when it fails. */
async function storeCrop(app: App, notePath: string, name: string, blob: Blob): Promise<{ embed: string; file: TFile } | null> {
	try {
		const data = await blob.arrayBuffer();
		const path = normalizePath(await app.fileManager.getAvailablePathForAttachment(name, notePath));
		recordPluginWrite(app, [path]); // before the write: the inbox must not offer this picture
		const slash = path.lastIndexOf("/");
		if (slash > 0) await ensureFolder(app, path.slice(0, slash));
		const target = await app.vault.createBinary(path, data);
		return { embed: embedWithWidth(withEmbedMarker(app.fileManager.generateMarkdownLink(target, notePath), true), TASK_IMAGE_WIDTH), file: target };
	} catch (e) {
		console.error("[notebook] task picture", e);
		return null;
	}
}

/** Draws the region once; null when it cannot be drawn. */
async function drawCrop(host: TaskHost): Promise<Blob | null> {
	const renderer = new PageImageRenderer(host.media, host.render);
	try {
		await host.prepare?.([host.page]);
		const drawn = await renderer.renderRegions(host.page, DEFAULT_MARKDOWN_DPI, [host.crop]);
		return drawn.blobs[0] ?? null;
	} catch (e) {
		console.error("[notebook] task crop", e);
		return null;
	} finally {
		renderer.close();
	}
}

/** Moves the picture this run stored to the trash (the line it was for did not get into a note). */
async function discardCrop(app: App, file: TFile | null): Promise<void> {
	if (!file) return;
	try {
		await app.fileManager.trashFile(file);
	} catch (e) {
		console.error("[notebook] task picture could not be removed", e);
	}
}

/** Adds the task; returns the path of the note or null (nothing written, the reason is shown). Never throws. */
export async function runMakeTask(host: TaskHost, request: TaskRequest, now: Date = new Date()): Promise<string | null> {
	const { app, file } = host;
	try {
		const blob = await drawCrop(host);
		if (!blob) showNotice(t("task.noPicture"), 6000);
		const name = taskPictureName(sanitizeName(file.basename) || "Notebook", host.pageNumber, taskStamp(now));
		// The picture is stored when the note is certain to be written; if the line then does not get in, the picture goes to the trash.
		let stored: TFile | null = null;
		const line = async (notePath: string): Promise<string> => {
			const crop = blob ? await storeCrop(app, notePath, name, blob) : null;
			stored = crop?.file ?? null;
			const image = crop?.embed ?? null;
			const pageLink = app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(host.pageNumber, host.page.id), t("task.pageAlias", { notebook: file.basename, n: String(host.pageNumber) }));
			return buildTaskLine({ text: request.text, due: request.due, emoji: host.settings.taskDueEmoji, image, pageLink });
		};
		let written: string | null = null;
		let added = false;
		try {
			if (request.target.kind === "daily") {
				const done = await appendToDailyNote(app, host.settings, now, line);
				written = done?.path ?? null;
				added = done?.added ?? false;
			} else {
				const note = request.target.file;
				const text = await line(note.path);
				await app.vault.process(note, (current) => {
					const next = appendTaskLine(current, text);
					added = next !== null;
					return next ?? current;
				});
				written = note.path;
			}
		} catch (e) {
			await discardCrop(app, stored);
			throw e;
		}
		if (!added) await discardCrop(app, stored);
		if (written) showNotice(t(added ? "task.done" : "task.exists", { path: written }), 7000);
		return written;
	} catch (e) {
		console.error("[notebook] make task", e);
		showNotice(t("task.failed", { error: e instanceof Error ? e.message : String(e) }), 9000);
		return null;
	}
}
