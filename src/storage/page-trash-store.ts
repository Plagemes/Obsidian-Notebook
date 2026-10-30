import { normalizePath, type App, type TFile } from "obsidian";
import { addEntry, emptyPageTrash, parsePageTrash, removeEntry, serializePageTrash, makeEntry, type PageTrashFile } from "../model/page-trash";
import type { NotebookDocument, Page } from "../model/types";
import { pageTrashPath } from "./trash-paths";
import { ensureFolder } from "./vault-io";

/**
 * Per-notebook page trash files in the plugin trash folder (roadmap #26). Reads and writes of one notebook's file
 * are queued, so two deletions in a row never overwrite each other. A file that cannot be read is never overwritten:
 * it is renamed to `<id> (unreadable <time>).json` and a new file is started.
 */
export class PageTrashStore {
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(private readonly app: App, private readonly root: () => string) {}

	private path(notebookId: string): string {
		return normalizePath(pageTrashPath(this.root(), notebookId));
	}

	private enqueue<T>(notebookId: string, job: () => Promise<T>): Promise<T> {
		const run = (this.queues.get(notebookId) ?? Promise.resolve()).then(job, job);
		this.queues.set(notebookId, run.catch(() => undefined));
		return run;
	}

	private async load(notebookId: string): Promise<{ file: TFile | null; data: PageTrashFile }> {
		const file = this.app.vault.getFileByPath(this.path(notebookId));
		if (!file) return { file: null, data: emptyPageTrash(notebookId) };
		const parsed = parsePageTrash(await this.app.vault.read(file));
		if (parsed.ok && parsed.file.notebookId === notebookId) return { file, data: parsed.file };
		// Keep the damaged (or newer-format) file: put it aside and start a new one.
		const aside = normalizePath(this.path(notebookId).replace(/\.json$/, ` (unreadable ${Date.now()}).json`));
		await this.app.vault.rename(file, aside);
		return { file: null, data: emptyPageTrash(notebookId) };
	}

	private async save(notebookId: string, file: TFile | null, data: PageTrashFile): Promise<void> {
		const text = serializePageTrash(data);
		if (file) {
			await this.app.vault.modify(file, text);
			return;
		}
		await ensureFolder(this.app, normalizePath(this.path(notebookId)).replace(/\/[^/]+$/, ""));
		await this.app.vault.create(this.path(notebookId), text);
	}

	/** Remembers a page that is about to be deleted. `page` must still be at `index` in `doc`. */
	add(doc: NotebookDocument, page: Page, index: number): Promise<void> {
		const entry = makeEntry(doc, page, index, Date.now());
		return this.enqueue(doc.id, async () => {
			const { file, data } = await this.load(doc.id);
			await this.save(doc.id, file, addEntry(data, entry, Date.now()));
		});
	}

	/** The deleted pages of a notebook (empty when there is none or the file cannot be read). */
	read(notebookId: string): Promise<PageTrashFile> {
		return this.enqueue(notebookId, async () => (await this.load(notebookId)).data);
	}

	/** Forgets one entry (after it was restored, or when the user discards it). */
	discard(notebookId: string, entryId: string): Promise<void> {
		return this.enqueue(notebookId, async () => {
			const { file, data } = await this.load(notebookId);
			if (file && data.entries.some((e) => e.id === entryId)) await this.save(notebookId, file, removeEntry(data, entryId));
		});
	}
}
