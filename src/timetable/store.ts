import { normalizePath, type App, type TFile } from "obsidian";
import { ensureFolder } from "../storage/vault-io";
import { emptyTimetable, parseTimetable, serializeChecked, type Timetable } from "./schedule";

export const TIMETABLE_FILE = "_timetable.json";

/** Vault path of the timetable: `<notebooks folder>/_timetable.json` (a plain JSON file, so it syncs and can be edited by hand). */
export function timetablePath(folder: string): string {
	const root = folder.replace(/\/+$/, "");
	return normalizePath(root ? `${root}/${TIMETABLE_FILE}` : TIMETABLE_FILE);
}

/** `text`: the file as read (null when there is none); pass it back to `save` as the base the edit started from. */
export type LoadResult =
	| { ok: true; timetable: Timetable; exists: boolean; text: string | null }
	| { ok: false; error: string; text: string | null };

/** The file changed since it was loaded (another device, sync, a hand edit): nothing was written. */
export class TimetableChangedError extends Error {
	constructor(readonly draftBackup: string | null) {
		super(draftBackup
			? `the timetable file changed since it was opened (for example by sync), so it was not overwritten; your edits were copied to ${draftBackup}`
			: "the timetable file changed since it was opened (for example by sync), so it was not overwritten");
		this.name = "TimetableChangedError";
	}
}

const stamp = (d: Date) => {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Reads and writes the timetable file through the Vault API only. A save never overwrites a file that changed since it
 * was loaded, and never overwrites an unreadable file without `replaceUnreadable` and a copy in `<folder>/_backup/`.
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
		if (!file) return { ok: true, timetable: emptyTimetable(), exists: false, text: null };
		let text: string;
		try {
			text = await this.app.vault.read(file);
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e), text: null };
		}
		const r = parseTimetable(text);
		return r.ok ? { ok: true, timetable: r.timetable, exists: true, text } : { ok: false, error: r.error, text };
	}

	/**
	 * Saves `tt` over the file as it was when the edit started (`base`: the text `load` returned, null when there was no
	 * file). Writes nothing when the file already holds exactly this text. If the file changed since `base` (synced from
	 * another device, edited by hand), it is never overwritten: the draft is copied to the backup folder and
	 * `TimetableChangedError` is thrown. An unreadable file is replaced only with `replaceUnreadable`, and only when it is
	 * still the unreadable text the user saw; a copy of it goes to the backup folder first. The check against `base` is
	 * repeated inside `vault.process`, so a change that lands while saving is kept too.
	 * Returns the path of the backup copy when an unreadable file was replaced.
	 */
	async save(tt: Timetable, opts: { base: string | null; replaceUnreadable?: boolean }): Promise<{ backup?: string }> {
		const text = serializeChecked(tt);
		const file = this.file();
		let backup: string | undefined;
		if (file) {
			const current = await this.app.vault.read(file);
			if (current === text) return {};
			if (current !== opts.base) throw new TimetableChangedError(await this.backUpDraft(text));
			if (!parseTimetable(current).ok) {
				if (!opts.replaceUnreadable) throw new Error("the existing timetable file cannot be read and was not overwritten");
				backup = await this.backUp(current);
			}
			let changed = false;
			await this.app.vault.process(file, (now) => {
				if (now === text) return now;
				if (now !== opts.base) {
					changed = true;
					return now;
				}
				return text;
			});
			if (changed) throw new TimetableChangedError(await this.backUpDraft(text));
		} else {
			// No file (never made, or deleted meanwhile): nothing to overwrite.
			const dir = this.path().split("/").slice(0, -1).join("/");
			if (dir) await ensureFolder(this.app, dir);
			await this.app.vault.create(this.path(), text);
		}
		const written = this.file();
		if (!written || (await this.app.vault.read(written)) !== text) throw new Error("the timetable could not be read back after saving");
		return { backup };
	}

	/** Keeps a draft that could not be saved; null when even that copy fails (the editor still holds it). */
	private async backUpDraft(text: string): Promise<string | null> {
		try {
			return await this.backUp(text, "unsaved");
		} catch (e) {
			console.error("[notebook] could not keep the unsaved timetable", e);
			return null;
		}
	}

	private async backUp(text: string, label = ""): Promise<string> {
		const dir = `${this.folder().replace(/\/+$/, "")}/_backup`;
		await ensureFolder(this.app, dir);
		const base = `${dir}/_timetable-${stamp(new Date())}${label ? ` ${label}` : ""}`;
		let path = normalizePath(`${base}.json`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${base} ${i}.json`);
		await this.app.vault.create(path, text);
		return path;
	}
}
