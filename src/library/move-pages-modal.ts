import { FuzzySuggestModal, Modal, Setting, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { showNotice } from "../view/notice";

export interface MovePageItem {
	id: string;
	/** 1-based position in the notebook. */
	number: number;
	excerpt: string;
}

export interface MovePagesAnswer {
	pageIds: string[];
	target: TFile;
}

function withoutExtension(path: string): string {
	return path.replace(/\.[^./]+$/, "");
}

class TargetPicker extends FuzzySuggestModal<TFile> {
	private chosen = false;

	constructor(app: App, private readonly files: TFile[], private readonly done: (f: TFile | null) => void) {
		super(app);
		this.setPlaceholder(t("move.searchNotebook"));
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(f: TFile): string {
		return withoutExtension(f.path);
	}

	onChooseItem(f: TFile): void {
		this.chosen = true;
		this.done(f);
	}

	onClose(): void {
		// onChooseItem runs after onClose: wait a tick before reporting a cancel.
		window.setTimeout(() => {
			if (!this.chosen) this.done(null);
		}, 0);
	}
}

/** Dialog of "Move to notebook…": which pages (checkboxes) and to which notebook (a search list). */
class MovePagesModal extends Modal {
	private readonly checked: Set<string>;
	private target: TFile | null = null;
	private targetButton!: HTMLButtonElement;
	private moveButton!: HTMLButtonElement;
	private done = false;

	constructor(
		app: App,
		private readonly pages: readonly MovePageItem[],
		preselected: readonly string[],
		private readonly candidates: TFile[],
		private readonly finish: (answer: MovePagesAnswer | null) => void,
	) {
		super(app);
		this.checked = new Set(preselected);
	}

	onOpen(): void {
		this.setTitle(t("move.title"));
		this.contentEl.createEl("p", { text: t("move.intro"), cls: "setting-item-description" });

		new Setting(this.contentEl)
			.setName(t("move.target"))
			.addButton((b) => {
				this.targetButton = b.buttonEl;
				b.setButtonText(t("move.chooseNotebook")).onClick(() => this.pickTarget());
			});

		new Setting(this.contentEl)
			.setName(t("move.pages"))
			.addButton((b) => b.setButtonText(t("move.selectAll")).onClick(() => this.setAll(true)))
			.addButton((b) => b.setButtonText(t("move.selectNone")).onClick(() => this.setAll(false)));

		const list = this.contentEl.createDiv({ cls: "notebook-move-pages" });
		for (const p of this.pages) {
			const row = list.createEl("label", { cls: "notebook-move-page" });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = this.checked.has(p.id);
			box.addEventListener("change", () => {
				if (box.checked) this.checked.add(p.id);
				else this.checked.delete(p.id);
				this.refresh();
			});
			row.createSpan({ text: t("move.pageLabel", { n: String(p.number) }) });
			if (p.excerpt) row.createSpan({ text: p.excerpt, cls: "notebook-move-excerpt" });
		}

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("move.cancel")).onClick(() => this.close()))
			.addButton((b) => {
				this.moveButton = b.buttonEl;
				b.setButtonText(t("move.move")).setCta().onClick(() => this.submit());
			});
		this.refresh();
	}

	private setAll(on: boolean): void {
		this.checked.clear();
		if (on) for (const p of this.pages) this.checked.add(p.id);
		this.contentEl.querySelectorAll<HTMLInputElement>(".notebook-move-page input").forEach((box) => (box.checked = on));
		this.refresh();
	}

	private refresh(): void {
		this.moveButton.disabled = !this.target || this.checked.size === 0;
		this.targetButton.setText(this.target ? withoutExtension(this.target.path) : t("move.chooseNotebook"));
	}

	private pickTarget(): void {
		if (this.candidates.length === 0) {
			showNotice(t("move.noNotebooks"));
			return;
		}
		new TargetPicker(this.app, this.candidates, (file) => {
			if (!file) return;
			this.target = file;
			this.refresh();
		}).open();
	}

	private submit(): void {
		if (!this.target || this.checked.size === 0) return;
		this.done = true;
		this.finish({ pageIds: this.pages.filter((p) => this.checked.has(p.id)).map((p) => p.id), target: this.target });
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) this.finish(null);
	}
}

export function askMovePages(
	app: App, pages: readonly MovePageItem[], preselected: readonly string[], candidates: TFile[],
): Promise<MovePagesAnswer | null> {
	return new Promise((resolve) => new MovePagesModal(app, pages, preselected, candidates, resolve).open());
}
