import { normalizePath, type App, type TFile } from "obsidian";
import { openNotebookAtPage, viewsOf } from "../integration/open";
import { AddPage } from "../model/history";
import { isEditContextSource, type EditContext } from "../view/edit-context";
import { t } from "../i18n";
import { createDocument } from "../model/document";
import { PAGE_SIZES, PAPER_SPACING } from "../model/types";
import type { NotebookSettings } from "../settings";
import { createNotebook } from "../storage/notebooks";
import { ensureFolder } from "../storage/vault-io";
import { blankPageLike, isBlankPage, looseSheetPath, notebookBaseName, parentFolder } from "./loose-sheet-logic";
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

let ensuring: Promise<TFile> | null = null;

/**
 * One creation at a time for both entry points (the Home card, the ribbon and the command, `openLooseSheet` and
 * `openNewQuickPage`): used at once they share the file instead of making "Quick notes 2".
 */
function ensureLooseSheet(plugin: LooseSheetPlugin): Promise<TFile> {
	ensuring ??= makeLooseSheet(plugin).finally(() => {
		ensuring = null;
	});
	return ensuring;
}

async function makeLooseSheet(plugin: LooseSheetPlugin): Promise<TFile> {
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

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** The notebook view loads asynchronously: waits (up to 6 s) for an editable document of that file. */
async function waitForContext(app: App, file: TFile): Promise<EditContext | null> {
	for (let i = 0; i < 60; i++) {
		for (const { view } of viewsOf(app, file)) {
			if (isEditContextSource(view)) {
				const ctx = view.editContext();
				if (ctx) return ctx;
			}
		}
		await wait(100);
	}
	return null;
}

let openingPage: Promise<void> | null = null;

/**
 * Home's "Quick page" (0.13): opens Quick notes (made the first time) at a new blank page, the same size and paper as the
 * last one. A last page that is still blank is shown instead of adding another, so tapping twice never piles up empty pages.
 * The new page is one undo step. If the sheet cannot be edited here (read-only, still loading) it is simply opened.
 */
export function openNewQuickPage(plugin: LooseSheetPlugin, open: (file: TFile) => Promise<void>): Promise<void> {
	openingPage ??= (async () => {
		try {
			const file = await ensureLooseSheet(plugin);
			await open(file);
			const ctx = await waitForContext(plugin.app, file);
			if (!ctx) return;
			const pages = ctx.doc.pages;
			const last = pages[pages.length - 1];
			if (!last) return;
			if (isBlankPage(last)) {
				await openNotebookAtPage(plugin.app, file, pages.length);
				return;
			}
			ctx.execute(new AddPage(blankPageLike(last), pages.length), pages.length);
		} catch (e) {
			console.error("[notebook] quick page", e);
			showNotice(t("loose.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			openingPage = null;
		}
	})();
	return openingPage;
}
