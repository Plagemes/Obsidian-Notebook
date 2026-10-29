/**
 * Page trash (#26) and page templates (#74): what the page menu and the new-notebook dialog call.
 * Kept out of notebook-view.ts on purpose; the view only passes itself as a `PageToolsHost`.
 */
import { getLanguage, Modal, Notice, type App } from "obsidian";
import { t } from "../i18n";
import { ConfirmModal, PromptModal } from "../library/library-modals";
import { relativeTime } from "../library/format";
import { renderThumbnail } from "../library/thumbnail";
import type { Command } from "../model/history";
import { AddAsset, AddPage, Batch } from "../model/history";
import {
	entryDocument, planPageTrashRestore, visibleEntries, PAGE_TRASH_MAX_ENTRIES, PAGE_TRASH_RETENTION_DAYS,
} from "../model/page-trash";
import {
	BUILTIN_IDS, builtinTemplate, pageFromTemplate, templateDocument, type BuiltinId, type BuiltinLabels,
} from "../model/templates";
import type { NotebookDocument, Page } from "../model/types";
import type { NotebookSettings } from "../settings";
import { PageTrashStore } from "../storage/page-trash-store";
import { listStoredTemplates, saveStoredTemplate } from "../storage/templates-store";
import { templatesFolderPath } from "../storage/trash-paths";

/** What the page tools need from the notebook view. */
export interface PageToolsHost {
	readonly app: App;
	/** Read when needed: the plugin replaces its settings object when they change. */
	readonly settings: NotebookSettings;
	/** The loaded document when it can be edited, else null. */
	editableDocument(): NotebookDocument | null;
	/** Runs `cmd` as one undo step. False when the view cannot take it now. */
	applyCommand(cmd: Command, scrollTo?: number): boolean;
}

const stores = new WeakMap<App, PageTrashStore>();

function storeFor(host: PageToolsHost): PageTrashStore {
	let store = stores.get(host.app);
	if (!store) {
		// `host.settings` always reads the plugin's current settings, so the folder follows a later change.
		store = new PageTrashStore(host.app, () => host.settings.folder);
		stores.set(host.app, store);
	}
	return store;
}

// ------------------------------------------------------------------ page trash (#26)

/** Keeps a copy of a page that is about to be deleted. Never throws: a failure only shows a notice. */
export function stashDeletedPage(host: PageToolsHost, doc: NotebookDocument, page: Page, index: number): void {
	try {
		void storeFor(host).add(doc, page, index).catch((e) => {
			console.error("[notebook] could not keep the deleted page", e);
			new Notice(t("pageTrash.keepFailed", { error: (e as Error).message }));
		});
	} catch (e) {
		console.error("[notebook] could not keep the deleted page", e);
	}
}

/** "Deleted pages…": lists the pages deleted from this notebook, with thumbnails, and restores one. */
export async function openDeletedPages(host: PageToolsHost): Promise<void> {
	const doc = host.editableDocument();
	if (!doc) {
		new Notice(t("merge.notEditable"));
		return;
	}
	try {
		const file = await storeFor(host).read(doc.id);
		new DeletedPagesModal(host, doc.id, file.entries.length).open();
	} catch (e) {
		new Notice(t("pageTrash.readFailed", { error: (e as Error).message }));
	}
}

class DeletedPagesModal extends Modal {
	constructor(private readonly host: PageToolsHost, private readonly notebookId: string, private readonly total: number) {
		super(host.app);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-page-trash-modal");
		this.setTitle(t("pageTrash.title"));
		void this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.createEl("p", { text: t("pageTrash.hint", { days: String(PAGE_TRASH_RETENTION_DAYS), max: String(PAGE_TRASH_MAX_ENTRIES) }) });
		const doc = this.host.editableDocument();
		if (!doc || doc.id !== this.notebookId) {
			el.createEl("p", { text: t("merge.notEditable") });
			return;
		}
		const file = await storeFor(this.host).read(this.notebookId);
		const entries = visibleEntries(file, doc);
		if (entries.length === 0) {
			el.createDiv({ cls: "notebook-trash-empty", text: this.total === 0 ? t("pageTrash.empty") : t("pageTrash.emptyNow") });
			return;
		}
		const grid = el.createDiv({ cls: "notebook-restore-grid notebook-page-trash-grid" });
		const now = Date.now();
		for (const entry of entries) {
			const cell = grid.createDiv({ cls: "notebook-restore-page" });
			const page = entryDocument(entry)?.pages[0];
			if (page) {
				const url = renderThumbnail(page, 120);
				if (url) cell.createEl("img", { attr: { src: url, alt: t("pageTrash.thumb") } });
			} else {
				cell.createDiv({ text: t("pageTrash.unreadable") });
			}
			cell.createDiv({ text: t("pageTrash.was", { n: String(entry.index + 1) }) });
			cell.createDiv({ cls: "notebook-trash-meta", text: t("trash.deleted", { when: relativeTime(entry.deletedAt, now, getLanguage()) }) });
			const btn = cell.createEl("button", { cls: "mod-cta", text: t("trash.restore") });
			btn.disabled = !page;
			btn.addEventListener("click", () => this.restore(entry.id));
		}
	}

	private restore(entryId: string): void {
		void (async () => {
			const doc = this.host.editableDocument();
			const file = await storeFor(this.host).read(this.notebookId);
			const entry = file.entries.find((e) => e.id === entryId);
			const plan = doc && entry ? planPageTrashRestore(doc, entry) : null;
			if (!plan || !this.host.applyCommand(plan.command, plan.pageIndex)) {
				new Notice(t("pageTrash.cannotRestore"));
				return;
			}
			new Notice(t("pageTrash.done"));
			this.close();
		})();
	}
}

// ------------------------------------------------------------------ templates (#74)

export interface TemplateChoice {
	/** Display name. */
	name: string;
	doc: NotebookDocument;
	/** Stored templates can be deleted from the gallery; built-in ones cannot. */
	stored: { path: string } | null;
}

export function builtinLabels(): BuiltinLabels {
	return {
		cue: t("template.label.cue"), notes: t("template.label.notes"), summary: t("template.label.summary"),
		meetingTitle: t("template.label.meetingTitle"), date: t("template.label.date"), attendees: t("template.label.attendees"),
		agenda: t("template.label.agenda"), decisions: t("template.label.decisions"), actions: t("template.label.actions"),
		todoTitle: t("template.label.todoTitle"),
	};
}

const builtinName = (id: BuiltinId) => t(`template.builtin.${id}`);

/** Built-in templates first, then the ones saved in the templates folder. */
export async function loadTemplateChoices(app: App, settings: NotebookSettings): Promise<{ builtin: TemplateChoice[]; mine: TemplateChoice[] }> {
	const labels = builtinLabels();
	const builtin = BUILTIN_IDS.map((id): TemplateChoice => ({ name: builtinName(id), doc: builtinTemplate(id, labels), stored: null }));
	const stored = await listStoredTemplates(app, templatesFolderPath(settings.templatesFolder, settings.folder));
	const mine = stored.map((s): TemplateChoice => ({ name: s.name, doc: s.doc, stored: { path: s.file.path } }));
	return { builtin, mine };
}

/** Gallery of templates with thumbnails; `onChoose` gets the one the user taps. */
export async function openTemplateGallery(app: App, settings: NotebookSettings, onChoose: (choice: TemplateChoice) => void): Promise<void> {
	try {
		const choices = await loadTemplateChoices(app, settings);
		new TemplateGalleryModal(app, settings, choices, onChoose).open();
	} catch (e) {
		new Notice(t("template.loadFailed", { error: (e as Error).message }));
	}
}

class TemplateGalleryModal extends Modal {
	constructor(
		app: App,
		private readonly settings: NotebookSettings,
		private choices: { builtin: TemplateChoice[]; mine: TemplateChoice[] },
		private readonly onChoose: (choice: TemplateChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-template-modal");
		this.setTitle(t("template.gallery.title"));
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		this.section(el, t("template.section.builtin"), this.choices.builtin);
		this.section(el, t("template.section.mine"), this.choices.mine, t("template.mine.empty", { folder: templatesFolderPath(this.settings.templatesFolder, this.settings.folder) }));
	}

	private section(el: HTMLElement, title: string, items: TemplateChoice[], empty?: string): void {
		el.createEl("h4", { text: title });
		if (items.length === 0 && empty) {
			el.createDiv({ cls: "notebook-trash-empty", text: empty });
			return;
		}
		const grid = el.createDiv({ cls: "notebook-restore-grid notebook-template-grid" });
		for (const choice of items) {
			const cell = grid.createDiv({ cls: "notebook-restore-page" });
			const page = choice.doc.pages[0];
			if (page) {
				const url = renderThumbnail(page, 120);
				if (url) cell.createEl("img", { attr: { src: url, alt: choice.name } });
			}
			cell.createDiv({ text: choice.name });
			const actions = cell.createDiv({ cls: "notebook-template-actions" });
			actions.createEl("button", { cls: "mod-cta", text: t("template.use") }).addEventListener("click", () => {
				this.close();
				this.onChoose(choice);
			});
			const stored = choice.stored;
			if (stored) {
				actions.createEl("button", { text: t("template.delete") }).addEventListener("click", () => this.askDelete(choice, stored.path));
			}
		}
	}

	private askDelete(choice: TemplateChoice, path: string): void {
		new ConfirmModal(
			this.app,
			{ title: t("template.delete.title"), body: t("template.delete.body", { name: choice.name }), cta: t("template.delete") },
			() => {
				const file = this.app.vault.getFileByPath(path);
				if (!file) return;
				void this.app.fileManager.trashFile(file).then(() => {
					this.choices = { ...this.choices, mine: this.choices.mine.filter((c) => c !== choice) };
					this.render();
				}).catch((e: Error) => new Notice(t("template.loadFailed", { error: e.message })));
			},
		).open();
	}
}

/** "Save page as template…": asks for a name and writes the page (content, paper, size, background) to the templates folder. */
export function savePageAsTemplate(host: PageToolsHost, doc: NotebookDocument, page: Page, suggestedName: string): void {
	new PromptModal(host.app, { title: t("template.save.title"), label: t("template.save.name"), value: suggestedName, cta: t("template.save.cta") }, (value) => {
		const name = value.trim();
		if (!name) return void new Notice(t("library.notice.invalidName"));
		const s = host.settings;
		void saveStoredTemplate(host.app, templatesFolderPath(s.templatesFolder, s.folder), name, templateDocument(doc, page))
			.then((file) => new Notice(t("template.saved", { name: file.basename })))
			.catch((e: Error) => new Notice(t("template.saveFailed", { error: e.message })));
	}).open();
}

/** "New page from template…": the gallery, then the template's page is inserted after page `index` as one undo step. */
export function newPageFromTemplate(host: PageToolsHost, index: number): void {
	if (!host.editableDocument()) {
		new Notice(t("merge.notEditable"));
		return;
	}
	void openTemplateGallery(host.app, host.settings, (choice) => {
		const doc = host.editableDocument();
		const made = pageFromTemplate(choice.doc);
		if (!doc || !made) return void new Notice(t("merge.notEditable"));
		const commands: Command[] = [];
		for (const a of made.assets) {
			if (!doc.assets || !Object.prototype.hasOwnProperty.call(doc.assets, a.id)) commands.push(new AddAsset(a));
		}
		const at = Math.min(index + 1, doc.pages.length);
		commands.push(new AddPage(made.page, at));
		if (host.applyCommand(new Batch("New page from template", commands), at)) new Notice(t("template.pageAdded", { name: choice.name }));
		else new Notice(t("merge.notEditable"));
	});
}
