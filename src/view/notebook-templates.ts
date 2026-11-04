/**
 * Notebook templates (roadmap #19): "Save as notebook template", the picker of the creation dialog and the manager of the
 * settings tab. The copy itself is model/notebook-template.ts; files live in the notebook templates folder.
 */
import { Modal, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { PromptModal } from "../library/library-modals";
import { decodeCoverArt, type CoverFamily } from "../model/cover-family";
import { expandPlaceholders, notebookFromTemplate, templateFromNotebook } from "../model/notebook-template";
import { templateFileName } from "../model/templates";
import type { NotebookDocument } from "../model/types";
import type { NotebookSettings } from "../settings";
import { listStoredTemplates, saveStoredTemplate, type StoredTemplate } from "../storage/templates-store";
import { notebookTemplatesFolderPath } from "../storage/trash-paths";
import { applyArt, artRef } from "../ui/art/art-ref";
import { decorate } from "../ui/components/dom";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { confirmDestructive } from "../ui/destructive";
import { showNotice } from "./notice";

type Settings = Pick<NotebookSettings, "folder" | "templatesFolder" | "notebookTemplatesFolder">;

export const notebookTemplatesFolder = (s: Settings): string => notebookTemplatesFolderPath(s.notebookTemplatesFolder, s.templatesFolder, s.folder);

/** What the creation dialog gets from the picker: a ready document (new ids, placeholders filled) and the title to suggest. */
export interface ChosenNotebookTemplate {
	name: string;
	doc: NotebookDocument;
	ready: true;
}

/** "Save as notebook template…": asks for a name, then writes a copy of the notebook (new ids) to the templates folder. */
export function saveNotebookAsTemplate(app: App, settings: Settings, doc: NotebookDocument, suggestedName: string): void {
	new PromptModal(app, { title: t("nbtemplate.save.title"), label: t("template.save.name"), value: suggestedName, cta: t("template.save.cta") }, (value) => {
		const name = templateFileName(value);
		if (!name) return void showNotice(t("library.notice.invalidName"));
		void saveStoredTemplate(app, notebookTemplatesFolder(settings), name, templateFromNotebook(doc))
			.then((file) => showNotice(t("nbtemplate.saved", { name: file.basename })))
			.catch((e: Error) => showNotice(t("template.saveFailed", { error: e.message })));
	}).open();
}

function coverOf(tpl: StoredTemplate): { color: string; art: { family: CoverFamily; seed: string } } {
	const meta = tpl.doc.meta;
	const color = meta?.cover ?? "#3b82f6";
	const art = meta?.coverArt?.kind === "art" ? decodeCoverArt(meta.coverArt) : { family: "contours" as const, seed: tpl.doc.id };
	return { color, art };
}

/** A small cover (colour plus generated art) for a template; the art arrives later and is only decoration. */
function coverEl(parent: HTMLElement, tpl: StoredTemplate): HTMLElement {
	const { color, art } = coverOf(tpl);
	const cover = parent.createDiv({ cls: "nb-tpl-cover", attr: { "aria-hidden": "true" } });
	cover.setCssProps({ "--nb-tpl-color": color });
	decorate(undefined, () => {
		const surface = activeDocument.body.hasClass("theme-light") ? "light" : "dark";
		cover.addClass("has-art");
		applyArt(cover, artRef("cover", { seed: art.seed, color, style: art.family, surface }, 150, 200), { prop: "--nb-tpl-art", onNone: () => cover.removeClass("has-art") });
	});
	cover.createDiv({ cls: "nb-tpl-spine" });
	return cover;
}

const pagesLabel = (n: number) => (n === 1 ? t("library.pages.one") : t("library.pages.many", { count: String(n) }));

/** The picker: template cards with their cover, the choice "Pages only / With content", then "Use template". */
export function openNotebookTemplatePicker(app: App, settings: Settings, onChoose: (chosen: ChosenNotebookTemplate) => void): void {
	void listStoredTemplates(app, notebookTemplatesFolder(settings))
		.then((list) => new NotebookTemplatePicker(app, settings, list, onChoose).open())
		.catch((e: Error) => showNotice(t("template.loadFailed", { error: e.message })));
}

class NotebookTemplatePicker extends Modal {
	private selected: StoredTemplate | null;
	private content = true;

	constructor(app: App, private readonly settings: Settings, private readonly list: StoredTemplate[], private readonly onChoose: (chosen: ChosenNotebookTemplate) => void) {
		super(app);
		this.selected = list[0] ?? null;
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("nbtemplate.pick.title"), subtitle: t("nbtemplate.pick.subtitle"), icon: "layout-template", size: "wide", cls: "nb-tpl-picker" });
		if (this.list.length === 0) {
			shellNote(shell.body, t("nbtemplate.empty", { folder: notebookTemplatesFolder(this.settings) }));
			shellButton(shell.foot, "secondary", t("ui.modal.cancel"), () => this.close());
			return;
		}
		const grid = shell.body.createDiv({ cls: "nb-tpl-grid", attr: { role: "radiogroup", "aria-label": t("nbtemplate.pick.title") } });
		const cards = new Map<StoredTemplate, HTMLButtonElement>();
		for (const tpl of this.list) {
			const card = grid.createEl("button", { cls: "nb-tpl-card", attr: { type: "button", role: "radio", "aria-checked": String(tpl === this.selected) } });
			coverEl(card, tpl);
			card.createDiv({ cls: "nb-tpl-name", text: tpl.name, attr: { title: tpl.name } });
			card.createDiv({ cls: "nb-tpl-meta", text: pagesLabel(tpl.doc.pages.length) });
			card.toggleClass("is-selected", tpl === this.selected);
			card.addEventListener("click", () => {
				this.selected = tpl;
				for (const [other, el] of cards) {
					el.toggleClass("is-selected", other === tpl);
					el.setAttribute("aria-checked", String(other === tpl));
				}
			});
			cards.set(tpl, card);
		}
		const modes = shell.body.createDiv({ cls: "nb-tpl-modes", attr: { role: "radiogroup", "aria-label": t("nbtemplate.mode") } });
		const buttons: Array<[boolean, HTMLButtonElement]> = [];
		const sync = () => {
			for (const [content, b] of buttons) {
				b.toggleClass("is-selected", content === this.content);
				b.setAttribute("aria-checked", String(content === this.content));
			}
		};
		for (const [content, label] of [[false, t("nbtemplate.mode.pages")], [true, t("nbtemplate.mode.content")]] as const) {
			const b = modes.createEl("button", { cls: "nb-tpl-mode", text: label, attr: { type: "button", role: "radio" } });
			buttons.push([content, b]);
			b.addEventListener("click", () => {
				this.content = content;
				sync();
			});
		}
		sync();
		shellNote(shell.body, t("nbtemplate.placeholders"));
		shellButton(shell.foot, "secondary", t("ui.modal.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("nbtemplate.use"), () => this.choose(), { icon: "check" });
	}

	private choose(): void {
		const tpl = this.selected;
		if (!tpl) return;
		const doc = notebookFromTemplate(tpl.doc, { content: this.content });
		const meta = tpl.doc.meta;
		if (meta && doc.meta) {
			doc.meta.cover = meta.cover;
			if (meta.description !== undefined) doc.meta.description = meta.description;
			if (meta.coverArt?.kind === "art") doc.meta.coverArt = { ...meta.coverArt };
		}
		this.close();
		this.onChoose({ name: expandPlaceholders(tpl.name), doc, ready: true });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Settings: the saved notebook templates with rename and delete (to Obsidian's trash, after a confirmation). */
export function openNotebookTemplateManager(app: App, settings: () => Settings): void {
	new NotebookTemplateManager(app, settings).open();
}

class NotebookTemplateManager extends Modal {
	private list: StoredTemplate[] = [];

	constructor(app: App, private readonly settings: () => Settings) {
		super(app);
	}

	onOpen(): void {
		void this.reload();
	}

	private async reload(): Promise<void> {
		try {
			this.list = await listStoredTemplates(this.app, notebookTemplatesFolder(this.settings()));
		} catch (e) {
			showNotice(t("template.loadFailed", { error: (e as Error).message }));
			this.list = [];
		}
		this.render();
	}

	private render(): void {
		const shell = modalShell(this, { title: t("nbtemplate.manage.title"), subtitle: notebookTemplatesFolder(this.settings()), icon: "layout-template", size: "medium", cls: "nb-tpl-manager" });
		if (this.list.length === 0) shellNote(shell.body, t("nbtemplate.empty", { folder: notebookTemplatesFolder(this.settings()) }));
		const rows = shell.body.createDiv({ cls: "nb-tpl-rows" });
		for (const tpl of this.list) {
			const row = rows.createDiv({ cls: "nb-tpl-row" });
			coverEl(row, tpl);
			const text = row.createDiv({ cls: "nb-tpl-row-text" });
			text.createDiv({ cls: "nb-tpl-name", text: tpl.name, attr: { title: tpl.name } });
			text.createDiv({ cls: "nb-tpl-meta", text: pagesLabel(tpl.doc.pages.length) });
			const actions = row.createDiv({ cls: "nb-tpl-row-actions" });
			shellButton(actions, "secondary", t("library.menu.rename"), () => this.rename(tpl.file), { icon: "pencil" });
			shellButton(actions, "danger", t("template.delete"), () => this.askDelete(tpl), { icon: "trash-2" });
		}
		shellButton(shell.foot, "secondary", t("create.close"), () => this.close());
	}

	private rename(file: TFile): void {
		new PromptModal(this.app, { title: t("nbtemplate.rename.title"), label: t("template.save.name"), value: file.basename, cta: t("library.menu.rename") }, (value) => {
			const name = templateFileName(value);
			if (!name) return void showNotice(t("library.notice.invalidName"));
			if (name === file.basename) return;
			const dir = file.parent?.path ?? "";
			const target = `${dir && dir !== "/" ? `${dir}/` : ""}${name}.${file.extension}`;
			if (this.app.vault.getAbstractFileByPath(target)) return void showNotice(t("nbtemplate.rename.exists", { name }));
			void this.app.fileManager.renameFile(file, target).then(() => this.reload()).catch((e: Error) => showNotice(t("template.loadFailed", { error: e.message })));
		}).open();
	}

	private askDelete(tpl: StoredTemplate): void {
		confirmDestructive(this.app, { title: t("template.delete.title"), body: t("template.delete.body", { name: tpl.name }), confirm: t("template.delete") }, () => {
			void this.app.fileManager.trashFile(tpl.file).then(() => this.reload()).catch((e: Error) => showNotice(t("template.loadFailed", { error: e.message })));
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
