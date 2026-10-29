import { normalizePath, type App, type TFile } from "obsidian";
import { createDocument } from "../model/document";
import { serialize } from "../model/serialize";
import { FILE_EXTENSION } from "../model/types";
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
export async function createNotebook(app: App, folder: string, name: string): Promise<TFile> {
	const dir = normalizePath(folder || "/");
	if (dir !== "/") await ensureFolder(app, dir);
	const base = sanitizeName(name) || defaultNotebookName();
	const prefix = dir === "/" ? "" : `${dir}/`;
	let path = normalizePath(`${prefix}${base}.${FILE_EXTENSION}`);
	for (let i = 2; app.vault.getAbstractFileByPath(path); i++) {
		path = normalizePath(`${prefix}${base} ${i}.${FILE_EXTENSION}`);
	}
	return app.vault.create(path, serialize(createDocument()));
}

export function listNotebooks(app: App): TFile[] {
	return app.vault.getFiles()
		.filter((f) => f.extension === FILE_EXTENSION)
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
}
