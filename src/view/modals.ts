import { FuzzySuggestModal, Modal, Setting, type App, type FuzzyMatch, type TFile } from "obsidian";
import { t } from "../i18n";
import { PAGE_SIZES, PAPER_KINDS, type NotebookDocument, type PageSizeName, type PaperKind } from "../model/types";
import { defaultNotebookName, listNotebooks } from "../storage/notebooks";

export interface NewNotebookOptions {
	name: string;
	size: PageSizeName;
	landscape: boolean;
	paper: PaperKind;
	/** A template chosen in the gallery (#74): the notebook starts as a copy of it and size/paper are ignored. */
	template?: { name: string; doc: NotebookDocument };
}

export class NewNotebookModal extends Modal {
	private readonly options: NewNotebookOptions;

	constructor(
		app: App,
		defaults: Omit<NewNotebookOptions, "name" | "template">,
		private readonly onCreate: (options: NewNotebookOptions) => void,
		/** Opens the template gallery; absent = no template row. */
		private readonly pickTemplate?: (done: (template: { name: string; doc: NotebookDocument }) => void) => void,
	) {
		super(app);
		this.options = { name: defaultNotebookName(), ...defaults };
	}

	onOpen(): void {
		this.contentEl.empty();
		this.setTitle(t("modal.new.title"));
		let submitted = false;
		const submit = () => {
			if (submitted) return;
			submitted = true;
			this.close();
			this.onCreate({ ...this.options });
		};
		const o = this.options;
		new Setting(this.contentEl).setName(t("modal.new.name")).addText((text) => {
			text.setValue(o.name).onChange((v) => (o.name = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.select(), 0);
		});
		const pick = this.pickTemplate;
		if (pick) {
			new Setting(this.contentEl).setName(t("template.modal.row")).setDesc(o.template?.name ?? t("template.modal.none"))
				.addButton((b) => b.setButtonText(t("template.modal.choose")).onClick(() => pick((template) => {
					o.template = template;
					this.onOpen();
				})))
				.addButton((b) => b.setButtonText(t("template.modal.clear")).setDisabled(!o.template).onClick(() => {
					delete o.template;
					this.onOpen();
				}));
		}
		if (!o.template) {
			new Setting(this.contentEl).setName(t("modal.new.size")).addDropdown((dd) => {
				for (const size of Object.keys(PAGE_SIZES) as PageSizeName[]) dd.addOption(size, t(`size.${size}`));
				dd.setValue(o.size).onChange((v) => (o.size = v as PageSizeName));
			});
			new Setting(this.contentEl).setName(t("modal.new.landscape")).addToggle((tg) => tg.setValue(o.landscape).onChange((v) => (o.landscape = v)));
			new Setting(this.contentEl).setName(t("modal.new.paper")).addDropdown((dd) => {
				for (const kind of PAPER_KINDS) dd.addOption(kind, t(`paper.${kind}`));
				dd.setValue(o.paper).onChange((v) => (o.paper = v as PaperKind));
			});
		}
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
