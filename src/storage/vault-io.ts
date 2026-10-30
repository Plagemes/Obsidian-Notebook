import { normalizePath, TFile, type App, type DataAdapter } from "obsidian";
import { readNotebookText, writeNotebookText } from "./format";
import type { JournalSlotFile, JournalStore } from "./journal";
import type { LinkFileAdapter } from "./pdf-links-store";
import type { BackupReason, DocumentIO } from "./session";

/** Vault-backed file operations for small plugin sidecar files that live in the vault (e.g. the PDF links file). */
export function vaultLinkFileAdapter(app: App): LinkFileAdapter {
	return {
		exists: async (p) => app.vault.getAbstractFileByPath(normalizePath(p)) !== null,
		read: async (p) => {
			const file = app.vault.getFileByPath(normalizePath(p));
			if (!file) throw new Error(`"${p}" does not exist`);
			return app.vault.read(file);
		},
		write: async (p, d) => {
			const file = app.vault.getFileByPath(normalizePath(p));
			if (file) await app.vault.modify(file, d);
			else await app.vault.create(normalizePath(p), d);
		},
		mkdir: (p) => ensureFolder(app, p),
	};
}

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

	/** Current vault path of the file (follows renames): part of the journal's file identity. */
	path(): string {
		return this.file.path;
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
 *
 * Files are named `<key>.<owner>.<slot>.journal` (see `journalKey`). `live` holds the owners that
 * have written and are not released yet: their files belong to a running session, so `read` hides them.
 */
export class AdapterJournalStore implements JournalStore {
	private folderReady = false;
	private readonly live = new Set<string>();

	constructor(
		private readonly adapter: DataAdapter,
		private readonly folder: string,
	) {}

	private path(key: string, owner: string, slot: 0 | 1): string {
		return normalizePath(`${this.folder}/${key}.${owner.replace(/[^A-Za-z0-9_-]/g, "_")}.${slot}.journal`);
	}

	async read(key: string): Promise<JournalSlotFile[]> {
		const files: JournalSlotFile[] = [];
		let listed: string[];
		try {
			if (!(await this.adapter.exists(this.folder))) return files;
			listed = (await this.adapter.list(this.folder)).files;
		} catch {
			return files;
		}
		for (const full of listed) {
			// <doc>.<path hash>.<owner>.<slot>.journal
			const name = full.slice(full.lastIndexOf("/") + 1);
			const parts = name.split(".");
			if (parts.length !== 5 || parts[4] !== "journal" || `${parts[0]}.${parts[1]}` !== key) continue;
			const owner = parts[2]!;
			const slot = parts[3] === "0" ? 0 : parts[3] === "1" ? 1 : null;
			if (slot === null || this.live.has(owner)) continue;
			try {
				files.push({ owner, slot, text: await this.adapter.read(full) });
			} catch {
				// Unreadable slot: ignored, the other one may still be good.
			}
		}
		return files;
	}

	async write(key: string, owner: string, slot: 0 | 1, text: string): Promise<void> {
		if (!this.folderReady) {
			let current = "";
			for (const part of this.folder.split("/").filter(Boolean)) {
				current = current ? `${current}/${part}` : part;
				if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
			}
			this.folderReady = true;
		}
		this.live.add(owner.replace(/[^A-Za-z0-9_-]/g, "_"));
		await this.adapter.write(this.path(key, owner, slot), text);
	}

	async remove(key: string, owner: string): Promise<void> {
		for (const slot of [0, 1] as const) {
			const path = this.path(key, owner, slot);
			if (await this.adapter.exists(path)) await this.adapter.remove(path);
		}
	}

	release(owner: string): void {
		this.live.delete(owner.replace(/[^A-Za-z0-9_-]/g, "_"));
	}
}
