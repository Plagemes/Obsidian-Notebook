import { normalizePath, TFile, Vault, type App } from "obsidian";
import { createDocument } from "../model/document";
import { serialize } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { isNotebookFile, NEW_NOTEBOOK_EXTENSION, writeNotebookText } from "./format";
import { ensureFolder } from "./vault-io";

/** Characters Obsidian does not allow in file names, plus those that break links. */
const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

export function sanitizeName(name: string): string {
	return name.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
}

export function defaultNotebookName(now = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `Notebook ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}`;
}

/** Creates `<folder>/<name>.notebook` with one empty grid page, adding " 2", " 3"… if the name is taken. */
export async function createNotebook(app: App, folder: string, name: string, doc: NotebookDocument = createDocument()): Promise<TFile> {
	const dir = normalizePath(folder || "/");
	if (dir !== "/") await ensureFolder(app, dir);
	const base = sanitizeName(name) || defaultNotebookName();
	const prefix = dir === "/" ? "" : `${dir}/`;
	let path = normalizePath(`${prefix}${base}.${NEW_NOTEBOOK_EXTENSION}`);
	for (let i = 2; app.vault.getAbstractFileByPath(path); i++) {
		path = normalizePath(`${prefix}${base} ${i}.${NEW_NOTEBOOK_EXTENSION}`);
	}
	return app.vault.create(path, writeNotebookText(NEW_NOTEBOOK_EXTENSION, serialize(doc), ""));
}

/** Notebooks inside the notebooks folder (recursively). The rest of the vault is not enumerated. */
export function listNotebooks(app: App, folder: string): TFile[] {
	const root = app.vault.getFolderByPath(normalizePath(folder || "/"));
	if (!root) return [];
	const found: TFile[] = [];
	Vault.recurseChildren(root, (f) => {
		if (f instanceof TFile && isNotebookFile(f)) found.push(f);
	});
	return found.sort((a, b) => b.stat.mtime - a.stat.mtime);
}
