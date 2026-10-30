import { normalizePath, TFile, type App } from "obsidian";
import {
	emptyPageTrash, entriesToDrop, makeEntry, mergeEntries, parsePageTrash, parsePageTrashEntry, serializePageTrashEntry,
	type PageTrashEntry, type PageTrashFile,
} from "../model/page-trash";
import type { NotebookDocument, Page } from "../model/types";
import { pageTrashEntriesFolder, pageTrashEntryPath, pageTrashFolder } from "./trash-paths";
import { ensureFolder } from "./vault-io";
import { deletePluginFile } from "./plugin-files";

interface ReadEntry {
	file: TFile;
	entry: PageTrashEntry;
}

/**
 * Deleted pages of each notebook in the plugin trash folder (roadmap #26), one immutable file per entry:
 * `_trash/pages/<notebook id>/<entry id>.json` is created once and never modified, so two devices deleting pages
 * before they sync never write the same file. Discarding an entry (after a restore) and the retention limits delete
 * entry files; nothing else does.
 *
 * Listing reads every `.json` file in the notebook's folder, so a conflicted copy made by a sync service is read too
 * (entries are matched by id, never by file name). Files of the first layout (`_trash/pages/<notebook id>.json`, one
 * file with every entry, and its conflicted copies) are still read and moved over lazily: each entry gets its own file,
 * and the old file is deleted only after every entry in it reads back from an entry file. A file that cannot be read
 * is never overwritten, moved or deleted; it is skipped.
 *
 * Calls for one notebook are queued, so a restore and a deletion never interleave on this device.
 */
export class PageTrashStore {
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(private readonly app: App, private readonly root: () => string) {}

	private enqueue<T>(notebookId: string, job: () => Promise<T>): Promise<T> {
		const run = (this.queues.get(notebookId) ?? Promise.resolve()).then(job, job);
		this.queues.set(notebookId, run.catch(() => undefined));
		return run;
	}

	private folder(notebookId: string): string {
		return normalizePath(pageTrashEntriesFolder(this.root(), notebookId));
	}

	private jsonFilesIn(folder: string): TFile[] {
		const dir = this.app.vault.getFolderByPath(folder);
		if (!dir) return [];
		return dir.children.filter((c): c is TFile => c instanceof TFile && c.extension === "json");
	}

	/** Entry files of the notebook, conflicted copies included. Unreadable or foreign files are skipped (and left alone). */
	private async entryFiles(notebookId: string): Promise<ReadEntry[]> {
		const out: ReadEntry[] = [];
		for (const file of this.jsonFilesIn(this.folder(notebookId))) {
			try {
				const parsed = parsePageTrashEntry(await this.app.vault.read(file));
				if (parsed.ok && parsed.notebookId === notebookId) out.push({ file, entry: parsed.entry });
				else if (!parsed.ok) console.warn("[notebook] page trash entry skipped", file.path, parsed.message);
			} catch (e) {
				console.warn("[notebook] page trash entry skipped", file.path, e);
			}
		}
		return out;
	}

	/** Files of the first layout for this notebook (the file and conflicted copies of it), with their entries. */
	private async legacyFiles(notebookId: string): Promise<Array<{ file: TFile; data: PageTrashFile }>> {
		const out: Array<{ file: TFile; data: PageTrashFile }> = [];
		for (const file of this.jsonFilesIn(normalizePath(pageTrashFolder(this.root())))) {
			if (!file.name.startsWith(notebookId)) continue;
			try {
				const parsed = parsePageTrash(await this.app.vault.read(file));
				if (parsed.ok && parsed.file.notebookId === notebookId) out.push({ file, data: parsed.file });
			} catch (e) {
				console.warn("[notebook] old page trash file skipped", file.path, e);
			}
		}
		return out;
	}

	/** Creates a new entry file. Never overwrites: fails when a file of that name exists. */
	private async writeEntry(notebookId: string, entry: PageTrashEntry): Promise<void> {
		const path = normalizePath(pageTrashEntryPath(this.root(), notebookId, entry.id));
		if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`"${path}" already exists`);
		await ensureFolder(this.app, this.folder(notebookId));
		await this.app.vault.create(path, serializePageTrashEntry(notebookId, entry));
	}

	/**
	 * Moves the entries of first-layout files into entry files. An old file is deleted only when every entry in it now
	 * reads back from an entry file; otherwise it stays, is still read, and is tried again next time.
	 */
	private async migrate(notebookId: string, present: ReadEntry[]): Promise<ReadEntry[]> {
		const legacy = await this.legacyFiles(notebookId);
		if (legacy.length === 0) return present;
		const have = new Set(present.map((r) => r.entry.id));
		for (const { file, data } of legacy) {
			let complete = true;
			for (const entry of data.entries) {
				if (have.has(entry.id)) continue;
				try {
					await this.writeEntry(notebookId, entry);
					have.add(entry.id);
				} catch (e) {
					complete = false;
					console.warn("[notebook] could not move a deleted page to its own file", file.path, e);
				}
			}
			if (!complete) continue;
			const written = new Set((await this.entryFiles(notebookId)).map((r) => r.entry.id));
			if (data.entries.every((e) => written.has(e.id))) {
				await deletePluginFile(this.app.vault, file).catch((e) => console.warn("[notebook] old page trash file kept", file.path, e));
			}
		}
		return this.entryFiles(notebookId);
	}

	/** Every entry of the notebook: entry files, plus whatever a first-layout file still holds. */
	private async collect(notebookId: string): Promise<{ files: ReadEntry[]; entries: PageTrashEntry[] }> {
		const files = await this.migrate(notebookId, await this.entryFiles(notebookId));
		const leftover = (await this.legacyFiles(notebookId)).map((l) => l.data.entries);
		return { files, entries: mergeEntries([files.map((r) => r.entry), ...leftover]) };
	}

	/** Deletes the entry files (conflicted copies included) of the given entry ids. */
	private async deleteEntries(files: readonly ReadEntry[], ids: ReadonlySet<string>): Promise<void> {
		// Plugin-internal records (after a restore was saved, or by the retention limits): not moved to the user's trash.
		for (const r of files) if (ids.has(r.entry.id)) await deletePluginFile(this.app.vault, r.file);
	}

	/** Remembers a page that is about to be deleted. `page` must still be at `index` in `doc`. Resolves once the copy is on disk. */
	add(doc: NotebookDocument, page: Page, index: number): Promise<void> {
		const entry = makeEntry(doc, page, index, Date.now());
		return this.enqueue(doc.id, async () => {
			await this.writeEntry(doc.id, entry);
			// The limits never fail the deletion: an old entry that cannot be removed now is removed next time.
			try {
				const { files } = await this.collect(doc.id);
				const drop = entriesToDrop(files.map((r) => r.entry), Date.now());
				drop.delete(entry.id);
				await this.deleteEntries(files, drop);
			} catch (e) {
				console.warn("[notebook] page trash limits not applied", e);
			}
		});
	}

	/** The deleted pages of a notebook (empty when there is none). */
	read(notebookId: string): Promise<PageTrashFile> {
		return this.enqueue(notebookId, async () => ({ ...emptyPageTrash(notebookId), entries: (await this.collect(notebookId)).entries }));
	}

	/** Forgets one entry (after it was restored and saved, or when the user discards it). */
	discard(notebookId: string, entryId: string): Promise<void> {
		return this.enqueue(notebookId, async () => {
			const { files } = await this.collect(notebookId);
			await this.deleteEntries(files, new Set([entryId]));
		});
	}
}
