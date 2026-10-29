import type { Plugin, TFile } from "obsidian";
import { t } from "../i18n";
import { openLooseSheet, type LooseSheetPlugin } from "../library/loose-sheet";
import type { NotebookSettings } from "../settings";
import { NotebookView } from "./notebook-view";

export interface LecturePlugin extends Plugin, LooseSheetPlugin {
	settings: NotebookSettings;
}

/**
 * Commands and ribbon button of "During the lecture": instant board shot, new lecture, loose sheet and
 * "Move to notebook…". `open` shows a notebook file in a tab (the library host's openNotebook).
 */
export function registerLectureCommands(plugin: LecturePlugin, open: (file: TFile) => Promise<void>): void {
	const withView = (checking: boolean, run: (view: NotebookView) => void): boolean => {
		const view = plugin.app.workspace.getActiveViewOfType(NotebookView);
		if (!view) return false;
		if (!checking) run(view);
		return true;
	};
	plugin.addCommand({ id: "board-shot", name: t("command.boardShot"), checkCallback: (checking) => withView(checking, (v) => void v.boardShot()) });
	plugin.addCommand({ id: "new-lecture", name: t("command.newLecture"), checkCallback: (checking) => withView(checking, (v) => void v.newLecture()) });
	plugin.addCommand({ id: "loose-sheet", name: t("command.looseSheet"), callback: () => void openLooseSheet(plugin, open) });
	plugin.addCommand({ id: "move-pages", name: t("command.movePages"), checkCallback: (checking) => withView(checking, (v) => void v.movePagesToNotebook()) });
	plugin.addRibbonIcon("sticky-note", t("command.looseSheet"), () => void openLooseSheet(plugin, open));
}
