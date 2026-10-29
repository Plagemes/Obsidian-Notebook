import { FuzzySuggestModal, Modal, Setting, type App, type FuzzyMatch } from "obsidian";
import { t } from "../i18n";
import { COVER_COLORS } from "./scan";

/** Modal with one text field. Enter submits; the callback runs once, after the modal closed. */
export class PromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private readonly opts: { title: string; label: string; value?: string; cta: string },
		private readonly onSubmit: (value: string) => void,
	) {
		super(app);
		this.value = opts.value ?? "";
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		let done = false;
		const submit = () => {
			const value = this.value.trim();
			if (done || !value) return;
			done = true;
			this.close();
			this.onSubmit(value);
		};
		new Setting(this.contentEl).setName(this.opts.label).addText((text) => {
			text.setValue(this.value).onChange((v) => (this.value = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.select(), 0);
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("library.modal.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.opts.cta).setCta().onClick(submit));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Confirmation for a destructive action. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly opts: { title: string; body: string; cta: string },
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		this.contentEl.createEl("p", { text: this.opts.body });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("library.modal.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText(this.opts.cta).setWarning().onClick(() => {
					this.close();
					this.onConfirm();
				}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Palette of cover colours. */
export class CoverModal extends Modal {
	constructor(
		app: App,
		private readonly current: string,
		private readonly onPick: (color: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("library.modal.coverTitle"));
		const row = this.contentEl.createDiv({ cls: "notebook-lib-swatches" });
		for (const color of COVER_COLORS) {
			const on = color.toLowerCase() === this.current.toLowerCase();
			const b = row.createEl("button", { cls: "notebook-lib-swatch", attr: { "aria-label": color, "aria-pressed": String(on) } });
			b.setCssProps({ "--notebook-cover": color });
			b.toggleClass("is-active", on);
			b.addEventListener("click", () => {
				this.close();
				this.onPick(color);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface FolderChoice {
	path: string;
	label: string;
}

/** Pick a destination folder. */
export class FolderSuggestModal extends FuzzySuggestModal<FolderChoice> {
	constructor(
		app: App,
		private readonly folders: FolderChoice[],
		private readonly onChoose: (folder: FolderChoice) => void,
	) {
		super(app);
		this.setPlaceholder(t("library.modal.movePlaceholder"));
		this.emptyStateText = t("library.modal.moveEmpty");
	}

	getItems(): FolderChoice[] {
		return this.folders;
	}

	getItemText(item: FolderChoice): string {
		return item.label;
	}

	renderSuggestion(match: FuzzyMatch<FolderChoice>, el: HTMLElement): void {
		el.createDiv({ text: match.item.label });
	}

	onChooseItem(item: FolderChoice): void {
		this.onChoose(item);
	}
}
