import { FuzzySuggestModal, type App, type FuzzyMatch, type TFile } from "obsidian";
import { t } from "../i18n";
import { listNotebooks } from "../storage/notebooks";

/** Fuzzy picker over the notebooks in the notebooks folder. */
export class NotebookPickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly folder: string, private readonly onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder(t("integration.pick.placeholder"));
		this.emptyStateText = t("integration.pick.empty");
	}

	getItems(): TFile[] {
		return listNotebooks(this.app, this.folder);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
		el.createDiv({ text: match.item.basename });
		el.createDiv({ text: match.item.parent?.path ?? "", cls: "notebook-picker-path" });
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}
