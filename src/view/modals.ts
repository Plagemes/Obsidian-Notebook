import { FuzzySuggestModal, Modal, Setting, type App, type FuzzyMatch, type TFile } from "obsidian";
import { t } from "../i18n";
import { defaultNotebookName, listNotebooks } from "../storage/notebooks";

export class NewNotebookModal extends Modal {
	private name = defaultNotebookName();

	constructor(app: App, private readonly onCreate: (name: string) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("modal.new.title"));
		let submitted = false;
		const submit = () => {
			if (submitted) return;
			submitted = true;
			this.close();
			this.onCreate(this.name);
		};
		new Setting(this.contentEl).setName(t("modal.new.name")).addText((text) => {
			text.setValue(this.name).onChange((v) => (this.name = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.select(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText(t("modal.new.create")).setCta().onClick(submit));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

type PickerItem = TFile | "new";

export class OpenNotebookModal extends FuzzySuggestModal<PickerItem> {
	constructor(
		app: App,
		private readonly folder: string,
		private readonly onOpenFile: (file: TFile) => void,
		private readonly onNew: () => void,
	) {
		super(app);
		this.setPlaceholder(t("modal.open.placeholder"));
		this.emptyStateText = t("modal.open.empty");
	}

	getItems(): PickerItem[] {
		return ["new", ...listNotebooks(this.app, this.folder)];
	}

	getItemText(item: PickerItem): string {
		return item === "new" ? t("modal.open.new") : item.path;
	}

	renderSuggestion(match: FuzzyMatch<PickerItem>, el: HTMLElement): void {
		const item = match.item;
		if (item === "new") {
			el.createDiv({ text: t("modal.open.new"), cls: "notebook-picker-new" });
			return;
		}
		el.createDiv({ text: item.basename });
		el.createDiv({ text: item.parent?.path ?? "", cls: "notebook-picker-path" });
	}

	onChooseItem(item: PickerItem): void {
		if (item === "new") this.onNew();
		else this.onOpenFile(item);
	}
}
