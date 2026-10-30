import type { Plugin, TFile } from "obsidian";
import { t } from "../i18n";
import { openLooseSheet, type LooseSheetPlugin } from "../library/loose-sheet";
import type { NotebookSettings } from "../settings";

export interface LecturePlugin extends Plugin, LooseSheetPlugin {
	settings: NotebookSettings;
}

/**
 * Ribbon button of "During the lecture": the loose sheet. The lecture commands (board shot, new lecture, loose sheet,
 * "Move to notebook…") are generated from the action registry (ui/actions.ts → view/commands.ts).
 * `open` shows a notebook file in a tab (the library host's openNotebook).
 */
export function registerLectureRibbon(plugin: LecturePlugin, open: (file: TFile) => Promise<void>): void {
	plugin.addRibbonIcon("sticky-note", t("command.looseSheet"), () => void openLooseSheet(plugin, open));
}
