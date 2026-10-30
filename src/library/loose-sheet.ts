import { normalizePath, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { createDocument } from "../model/document";
import { PAGE_SIZES, PAPER_SPACING } from "../model/types";
import type { NotebookSettings } from "../settings";
import { createNotebook } from "../storage/notebooks";
import { ensureFolder } from "../storage/vault-io";
import { looseSheetPath, notebookBaseName, parentFolder } from "./loose-sheet-logic";
import { showNotice } from "../view/notice";

/** Cover colour of the loose sheet in the library (amber, one of the cover colours). */
const LOOSE_SHEET_COVER = "#c9a227";

export interface LooseSheetPlugin {
	app: App;
	settings: NotebookSettings;
}

let opening: Promise<void> | null = null;

/** The loose sheet's file, or null when it has not been created yet. */
export function findLooseSheet(app: App, settings: NotebookSettings): TFile | null {
	return app.vault.getFileByPath(normalizePath(looseSheetPath(settings.folder, settings.looseSheetPath)));
}

async function ensureLooseSheet(plugin: LooseSheetPlugin): Promise<TFile> {
	const { app, settings } = plugin;
	const path = normalizePath(looseSheetPath(settings.folder, settings.looseSheetPath));
	const existing = app.vault.getFileByPath(path);
	if (existing) return existing;
	if (app.vault.getAbstractFileByPath(path)) throw new Error(t("loose.pathTaken", { path }));
	const base = PAGE_SIZES[settings.defaultPageSize];
	const size = settings.defaultLandscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
	const doc = createDocument(new Date(), size, { kind: settings.defaultPaper, spacing: PAPER_SPACING[settings.defaultPaper] });
	if (doc.meta) doc.meta.cover = LOOSE_SHEET_COVER;
	const folder = parentFolder(path);
	if (folder) await ensureFolder(app, folder);
	return createNotebook(app, folder, notebookBaseName(path), doc);
}

/**
 * Opens the loose sheet (quick notes), creating it in the configured place the first time. An existing file is opened
 * as it is, whatever it holds: it is never replaced, and an unreadable one shows the usual message in the view.
 */
export function openLooseSheet(plugin: LooseSheetPlugin, open: (file: TFile) => Promise<void>): Promise<void> {
	opening ??= (async () => {
		try {
			await open(await ensureLooseSheet(plugin));
		} catch (e) {
			console.error("[notebook] loose sheet", e);
			showNotice(t("loose.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			opening = null;
		}
	})();
	return opening;
}
