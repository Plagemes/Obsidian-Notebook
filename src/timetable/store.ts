import { normalizePath, type App, type TFile } from "obsidian";
import { ensureFolder } from "../storage/vault-io";
import { emptyTimetable, parseTimetable, serializeChecked, type Timetable } from "./schedule";

export const TIMETABLE_FILE = "_timetable.json";

/** Vault path of the timetable: `<notebooks folder>/_timetable.json` (a plain JSON file, so it syncs and can be edited by hand). */
export function timetablePath(folder: string): string {
	const root = folder.replace(/\/+$/, "");
	return normalizePath(root ? `${root}/${TIMETABLE_FILE}` : TIMETABLE_FILE);
}

export type LoadResult = { ok: true; timetable: Timetable; exists: boolean } | { ok: false; error: string };

const stamp = (d: Date) => {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Reads and writes the timetable file through the Vault API only. An unreadable file is never overwritten: saving
 * over it needs `replaceUnreadable`, and then a copy of it goes to `<folder>/_backup/` first.
 */
export class TimetableStore {
	constructor(private readonly app: App, private readonly folder: () => string) {}

	path(): string {
		return timetablePath(this.folder());
	}

	private file(): TFile | null {
		return this.app.vault.getFileByPath(this.path());
	}

	async load(): Promise<LoadResult> {
		const file = this.file();
		if (!file) return { ok: true, timetable: emptyTimetable(), exists: false };
		let text: string;
		try {
			text = await this.app.vault.read(file);
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		const r = parseTimetable(text);
		return r.ok ? { ok: true, timetable: r.timetable, exists: true } : r;
	}

	/** Saves `tt`; returns the path of the backup copy when an unreadable file was replaced. */
	async save(tt: Timetable, replaceUnreadable = false): Promise<{ backup?: string }> {
		const text = serializeChecked(tt);
		const file = this.file();
		let backup: string | undefined;
		if (file) {
			const current = await this.app.vault.read(file);
			if (!parseTimetable(current).ok) {
				if (!replaceUnreadable) throw new Error("the existing timetable file cannot be read and was not overwritten");
				backup = await this.backUp(current);
			}
			await this.app.vault.process(file, () => text);
		} else {
			const dir = this.path().split("/").slice(0, -1).join("/");
			if (dir) await ensureFolder(this.app, dir);
			await this.app.vault.create(this.path(), text);
		}
		const written = this.file();
		if (!written || (await this.app.vault.read(written)) !== text) throw new Error("the timetable could not be read back after saving");
		return { backup };
	}

	private async backUp(text: string): Promise<string> {
		const dir = `${this.folder().replace(/\/+$/, "")}/_backup`;
		await ensureFolder(this.app, dir);
		let path = normalizePath(`${dir}/_timetable-${stamp(new Date())}.json`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}/_timetable-${stamp(new Date())} ${i}.json`);
		await this.app.vault.create(path, text);
		return path;
	}
}
