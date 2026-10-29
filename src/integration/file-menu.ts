import { TFile, TFolder, type Plugin } from "obsidian";
import { t } from "../i18n";
import { fileMenuKind } from "./page-links";

export interface FileMenuDeps {
	/** Asks for the name and paper of a new notebook and creates it in `folder`. */
	newNotebookIn: (folder: string) => void;
	/** Creates a notebook with the PDF as page backgrounds and opens it. */
	annotatePdf: (pdf: TFile) => void;
}

/** File explorer menu: "New notebook here" on folders, "Annotate in Notebook" on PDFs. */
export function registerFileMenu(plugin: Plugin, deps: FileMenuDeps): void {
	plugin.registerEvent(plugin.app.workspace.on("file-menu", (menu, entry) => {
		const kind = fileMenuKind({ isFolder: entry instanceof TFolder, extension: entry instanceof TFile ? entry.extension : undefined });
		if (kind === "folder" && entry instanceof TFolder) {
			menu.addItem((i) => i.setTitle(t("menu.newNotebookHere")).setIcon("file-plus").setSection("action-primary")
				.onClick(() => deps.newNotebookIn(entry.path)));
		} else if (kind === "pdf" && entry instanceof TFile) {
			menu.addItem((i) => i.setTitle(t("menu.annotatePdf")).setIcon("pen-line").setSection("action-primary")
				.onClick(() => deps.annotatePdf(entry)));
		}
	}));
}
