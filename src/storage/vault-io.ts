import { normalizePath, TFile, type App } from "obsidian";
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

	read(): Promise<string> {
		return this.app.vault.read(this.file);
	}

	async process(fn: (current: string) => string): Promise<void> {
		await this.app.vault.process(this.file, fn);
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
