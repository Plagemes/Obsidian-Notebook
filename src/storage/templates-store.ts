import { normalizePath, TFile, Vault, type App } from "obsidian";
import { templateFileName } from "../model/templates";
import { parse, serializeChecked } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { isNotebookFile, NEW_NOTEBOOK_EXTENSION, readNotebookText, writeNotebookText } from "./format";
import { ensureFolder } from "./vault-io";

/** A template stored in the templates folder. Templates that cannot be read are skipped (never modified). */
export interface StoredTemplate {
	file: TFile;
	name: string;
	doc: NotebookDocument;
}

/** Templates in `folder`, by name. */
export async function listStoredTemplates(app: App, folder: string): Promise<StoredTemplate[]> {
	const root = app.vault.getFolderByPath(normalizePath(folder));
	if (!root) return [];
	const files: TFile[] = [];
	Vault.recurseChildren(root, (f) => {
		if (f instanceof TFile && isNotebookFile(f)) files.push(f);
	});
	const out: StoredTemplate[] = [];
	for (const file of files) {
		try {
			const parsed = parse(readNotebookText(file.extension, await app.vault.read(file)));
			if (parsed.ok && parsed.doc.pages.length > 0) out.push({ file, name: file.basename, doc: parsed.doc });
		} catch (e) {
			console.error("[notebook] could not read template", file.path, e);
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** Writes a template as `<folder>/<name>.notebook` (" 2", " 3"… when the name is taken). The document is validated first. */
export async function saveStoredTemplate(app: App, folder: string, name: string, doc: NotebookDocument): Promise<TFile> {
	const checked = serializeChecked(doc, true);
	if (!checked.ok) throw new Error(checked.message);
	const dir = normalizePath(folder);
	await ensureFolder(app, dir);
	const base = templateFileName(name) || "Template";
	let path = normalizePath(`${dir}/${base}.${NEW_NOTEBOOK_EXTENSION}`);
	for (let i = 2; app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}/${base} ${i}.${NEW_NOTEBOOK_EXTENSION}`);
	return app.vault.create(path, writeNotebookText(NEW_NOTEBOOK_EXTENSION, checked.text, ""));
}
