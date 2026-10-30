import { normalizePath, TFile, TFolder, type App, type TAbstractFile } from "obsidian";
import { createId } from "../model/document";
import {
	expiredIds, isValidTrashId, newTrashId, parseTrashMeta, restorePath, serializeTrashMeta, sortTrash,
	trashItemFolder, trashItemPath, trashItemsFolder, trashMetaPath, type TrashKind, type TrashMeta,
} from "./trash-paths";
import { isNotebookFile } from "./format";
import { ensureFolder } from "./vault-io";
import { deletePluginFile } from "./plugin-files";

/** Every file inside `folder` (all levels), split into notebooks and the user's other files (.md, .pdf, images…). */
export function folderContents(folder: TFolder): { notebooks: TFile[]; others: TFile[] } {
	const notebooks: TFile[] = [];
	const others: TFile[] = [];
	const walk = (f: TFolder) => {
		for (const child of f.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile) (isNotebookFile(child) ? notebooks : others).push(child);
		}
	};
	walk(folder);
	return { notebooks, others };
}

/** What the library trash needs from the plugin. */
export interface TrashHost {
	app: App;
	/** Notebooks folder. */
	root(): string;
	/** Auto-empty after this many days; 0 = off. */
	retentionDays(): number;
	/** Called before something moves to the trash, e.g. to close the tabs that show it (so they flush first). */
	beforeMove?(path: string): Promise<void>;
}

/** An item in the trash that can be restored: its meta file was read and the item itself is where the meta says. */
export interface TrashItem extends TrashMeta {
	/** Vault path of the item inside the trash. */
	trashPath: string;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * Library trash (roadmap #160): deleting a notebook or a folder from the library moves it to
 * `<notebooks folder>/_trash/items/<id>/` with a small meta file that remembers where it was. Restoring moves it back
 * (to a free name if the old one is taken). Permanent deletion goes through `fileManager.trashFile`, so it follows the
 * user's Obsidian "Deleted files" setting (system trash, Obsidian's .trash folder, or permanent).
 * Plain renames are used for moving (`vault.rename`), so links in the user's notes are not rewritten to trash paths.
 */
export class LibraryTrash {
	constructor(private readonly host: TrashHost) {}

	private get app(): App {
		return this.host.app;
	}

	private get root(): string {
		return normalizePath(this.host.root()).replace(/^\/$/, "");
	}

	/** Moves a notebook or folder of the library to the trash. Never touches the notebooks folder itself. */
	async trash(target: TAbstractFile): Promise<TrashItem> {
		if (target.path === this.root || target.path === "/" || (target instanceof TFolder && target.isRoot())) {
			throw new Error("the notebooks folder cannot be deleted");
		}
		const kind: TrashKind = target instanceof TFile ? "notebook" : "folder";
		await this.host.beforeMove?.(target.path);
		const id = newTrashId(Date.now(), createId().replace(/-/g, "").slice(0, 8));
		const meta: TrashMeta = { v: 1, id, kind, name: target.name, originalPath: target.path, deletedAt: Date.now() };
		await ensureFolder(this.app, trashItemFolder(this.root, id));
		const metaFile = await this.app.vault.create(trashMetaPath(this.root, id), serializeTrashMeta(meta));
		const dest = trashItemPath(this.root, id, target.name);
		try {
			await this.app.vault.rename(target, dest);
		} catch (e) {
			// Nothing moved: remove only the meta file written a moment ago and its empty folder.
			await deletePluginFile(this.app.vault, metaFile).catch(() => undefined);
			const folder = this.app.vault.getFolderByPath(trashItemFolder(this.root, id));
			if (folder && folder.children.length === 0) await deletePluginFile(this.app.vault, folder).catch(() => undefined);
			throw e;
		}
		return { ...meta, trashPath: dest };
	}

	/** Days after which items are emptied automatically; 0 = never. */
	retentionDays(): number {
		return this.host.retentionDays();
	}

	/** Everything in the trash, newest first. Folders without a readable meta file or without their item are left alone and not listed. */
	async list(): Promise<TrashItem[]> {
		const items = this.app.vault.getFolderByPath(trashItemsFolder(this.root));
		if (!items) return [];
		const out: TrashItem[] = [];
		for (const child of [...items.children]) {
			if (!(child instanceof TFolder) || !isValidTrashId(child.name)) continue;
			const item = await this.readItem(child.name);
			if (item) out.push(item);
		}
		return sortTrash(out);
	}

	private async readItem(id: string): Promise<TrashItem | null> {
		const metaFile = this.app.vault.getFileByPath(trashMetaPath(this.root, id));
		if (!metaFile) return null;
		try {
			const meta = parseTrashMeta(await this.app.vault.read(metaFile));
			if (!meta || meta.id !== id) return null;
			const trashPath = trashItemPath(this.root, id, meta.name);
			const found = this.app.vault.getAbstractFileByPath(trashPath);
			if (!found || (meta.kind === "notebook") !== (found instanceof TFile)) return null;
			return { ...meta, trashPath };
		} catch (e) {
			console.error("[notebook] unreadable trash entry", id, e);
			return null;
		}
	}

	/** Exact or case-insensitive match: Android and Windows file systems do not tell "Notes" from "notes". */
	private taken(path: string): boolean {
		if (this.app.vault.getAbstractFileByPath(path)) return true;
		const parent = this.app.vault.getFolderByPath(dirOf(path) || "/");
		const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
		return !!parent?.children.some((c) => c.name.toLowerCase() === name);
	}

	/** Puts an item back; returns the vault path it now has. */
	async restore(id: string): Promise<string> {
		const item = await this.readItem(id);
		if (!item) throw new Error("this item is no longer in the trash");
		const found = this.app.vault.getAbstractFileByPath(item.trashPath);
		if (!found) throw new Error("this item is no longer in the trash");
		const target = normalizePath(restorePath(item.originalPath, item.kind, (p) => this.taken(normalizePath(p))));
		const dir = dirOf(target);
		if (dir) await ensureFolder(this.app, dir);
		await this.app.vault.rename(found, target);
		// Only our own meta file is left in the item folder: it is plugin bookkeeping, not user data, so it is removed outright
		// (trashFile would fill the user trash with one folder per restore).
		const folder = this.app.vault.getFolderByPath(trashItemFolder(this.root, id));
		if (folder && folder.children.every((c) => c.name === "meta.json")) await deletePluginFile(this.app.vault, folder, true).catch(() => undefined);
		return target;
	}

	/** Deletes one item for good (through Obsidian's own deletion setting). */
	async deletePermanently(id: string): Promise<void> {
		const folder = this.app.vault.getFolderByPath(trashItemFolder(this.root, id));
		if (!folder || !isValidTrashId(id)) return;
		await this.app.fileManager.trashFile(folder);
	}

	/** Deletes everything in the trash; returns how many items. */
	async empty(): Promise<number> {
		const items = await this.list();
		let n = 0;
		for (const item of items) {
			await this.deletePermanently(item.id);
			n++;
		}
		return n;
	}

	/** Vault paths of the files in a trashed folder that are not notebooks (empty for a notebook item). */
	otherFiles(item: TrashItem): string[] {
		if (item.kind !== "folder") return [];
		const folder = this.app.vault.getFolderByPath(item.trashPath);
		return folder ? folderContents(folder).others.map((f) => f.path) : [];
	}

	/**
	 * Auto-empty: deletes the items older than the retention setting. Does nothing when the setting is 0. A folder that
	 * holds files other than notebooks (the user's notes, PDFs, images) is never emptied automatically: only an explicit
	 * "Delete permanently" or "Empty trash", whose confirmation lists those files, removes it.
	 */
	async purgeExpired(now = Date.now()): Promise<number> {
		const days = this.host.retentionDays();
		if (!(days > 0)) return 0;
		const items = (await this.list()).filter((item) => this.otherFiles(item).length === 0);
		const ids = expiredIds(items, now, days);
		for (const id of ids) await this.deletePermanently(id);
		return ids.length;
	}
}
