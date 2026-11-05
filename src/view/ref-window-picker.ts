/**
 * 0.20 reference window (#107): the picker of "Open reference window…": a fuzzy list over the vault files the window can show
 * (notebooks, PDFs, pictures, Markdown notes), the most recently changed first.
 */
import { FuzzySuggestModal, type App, type FuzzyMatch, type TFile } from "obsidian";
import { t } from "../i18n";
import { NOTEBOOK_EXTENSIONS } from "../storage/format";
import { referenceKind } from "./ref-window-logic";

/** Whether the window can show this file. */
export function canShowAsReference(file: { extension: string }): boolean {
	return referenceKind(file.extension, NOTEBOOK_EXTENSIONS) !== null;
}

export class ReferencePickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder(t("refwin.pick.placeholder"));
		this.emptyStateText = t("refwin.pick.empty");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter(canShowAsReference).sort((a, b) => b.stat.mtime - a.stat.mtime);
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
