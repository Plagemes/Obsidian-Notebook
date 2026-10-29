import { normalizePath, TFile, type App, type DataAdapter } from "obsidian";
import { readNotebookText, writeNotebookText } from "./format";
import type { JournalSlotFile, JournalStore } from "./journal";
import type { BackupReason, DocumentIO } from "./session";

/** Creates every missing folder along `path`. */
export async function ensureFolder(app: App, path: string): Promise<void> {
	const parts = normalizePath(path).split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(current);
		if (existing instanceof TFile) throw new Error(`"${current}" is a file, not a folder`);
		if (existing) continue;
		try {
			await app.vault.createFolder(current);
		} catch (e) {
			// Created in the meantime (e.g. by Sync): fine as long as it exists now.
			if (!app.vault.getFolderByPath(current)) throw e;
		}
	}
}

/** FNV-1a 32 bit, to name backups by content and avoid duplicates. */
export function contentHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function timestamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** DocumentIO over the Vault API (works on desktop and mobile, no adapter access). */
export class VaultDocumentIO implements DocumentIO {
	constructor(
		private readonly app: App,
		private readonly file: TFile,
		private readonly backupFolder: () => string,
	) {}

	/** The document text inside the file (the container format lives in format.ts). */
	async read(): Promise<string> {
		return readNotebookText(this.file.extension, await this.app.vault.read(this.file));
	}

	async process(fn: (current: string) => string): Promise<void> {
		const ext = this.file.extension;
		await this.app.vault.process(this.file, (raw) => writeNotebookText(ext, fn(readNotebookText(ext, raw)), raw));
	}

	async backup(content: string, reason: BackupReason): Promise<string | null> {
		const folder = normalizePath(this.backupFolder());
		await ensureFolder(this.app, folder);
		const hash = contentHash(content);
		const base = this.file.basename;
		const sameHash = (this.app.vault.getFolderByPath(folder)?.children ?? [])
			.filter((f): f is TFile => f instanceof TFile && f.name.startsWith(`${base} `) && f.name.endsWith(` ${hash}.bak`));
		// The hash only narrows the search: skip the backup only if the content really is identical.
		for (const f of sameHash) {
			if ((await this.app.vault.read(f)) === content) return null;
		}
		const stem = `${folder}/${base} ${timestamp(new Date())} ${reason}`;
		let path = normalizePath(`${stem} ${hash}.bak`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${stem} ${i} ${hash}.bak`);
		await this.app.vault.create(path, content);
		return path;
	}
}

/** Folder of the instant save journal: `<config dir>/plugins/<plugin id>/journal`. */
export function journalFolder(app: App, pluginId: string): string {
	return normalizePath(`${app.vault.configDir}/plugins/${pluginId}/journal`);
}

/**
 * JournalStore over the vault adapter. The journal is a plugin-owned technical file, so it lives in
 * the plugin's config folder (no vault events, no sync, no indexing); this is the one place the
 * adapter is used. Reads skip slots that cannot be read; the session decides what to do with them.
 */
export class AdapterJournalStore implements JournalStore {
	private folderReady = false;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly folder: string,
	) {}

	private path(docId: string, slot: 0 | 1): string {
		return normalizePath(`${this.folder}/${docId.replace(/[^A-Za-z0-9_-]/g, "_")}.${slot}.journal`);
	}

	async read(docId: string): Promise<JournalSlotFile[]> {
		const files: JournalSlotFile[] = [];
		for (const slot of [0, 1] as const) {
			try {
				const path = this.path(docId, slot);
				if (await this.adapter.exists(path)) files.push({ slot, text: await this.adapter.read(path) });
			} catch {
				// Unreadable slot: ignored, the other one may still be good.
			}
		}
		return files;
	}

	async write(docId: string, slot: 0 | 1, text: string): Promise<void> {
		if (!this.folderReady) {
			let current = "";
			for (const part of this.folder.split("/").filter(Boolean)) {
				current = current ? `${current}/${part}` : part;
				if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
			}
			this.folderReady = true;
		}
		await this.adapter.write(this.path(docId, slot), text);
	}

	async remove(docId: string): Promise<void> {
		for (const slot of [0, 1] as const) {
			const path = this.path(docId, slot);
			if (await this.adapter.exists(path)) await this.adapter.remove(path);
		}
	}
}
