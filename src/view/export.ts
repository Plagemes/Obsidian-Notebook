import { Notice, normalizePath, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { pagesToPdf } from "../ink/export-pdf";
import { pageToSvg } from "../ink/export-svg";
import type { Page } from "../model/types";

/** Path next to the notebook, adding " 2", " 3"… if taken. */
function freePath(app: App, notebook: TFile, suffix: string, ext: string): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	let path = normalizePath(`${dir}${notebook.basename}${suffix}.${ext}`);
	for (let i = 2; app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}${notebook.basename}${suffix} ${i}.${ext}`);
	return path;
}

/** Writes a PDF of `pages` next to the notebook; `suffix` distinguishes single-page exports. */
export async function exportPdf(app: App, notebook: TFile, pages: readonly Page[], suffix = ""): Promise<void> {
	try {
		const bytes = pagesToPdf(pages, { paper: true, title: notebook.basename });
		const path = freePath(app, notebook, suffix, "pdf");
		await app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		new Notice(t("export.done", { path }));
	} catch (e) {
		new Notice(t("export.failed", { error: (e as Error).message }));
	}
}

export async function exportSvg(app: App, notebook: TFile, page: Page, suffix: string): Promise<void> {
	try {
		const path = freePath(app, notebook, suffix, "svg");
		await app.vault.create(path, pageToSvg(page, { paper: true }));
		new Notice(t("export.done", { path }));
	} catch (e) {
		new Notice(t("export.failed", { error: (e as Error).message }));
	}
}
