/**
 * 0.16 (roadmap #177): the shared-files inbox. On Android, sharing a PDF or an image to Obsidian saves it in the vault
 * (the attachments location); the plugin cannot register a share target of its own, so it watches that folder for new PDFs
 * and images (vault `create` events, plus a scan when the library opens) and offers to turn each into a notebook or add it
 * to one. Which files count is decided by shared-inbox-logic.ts; the edits are the plugin API's (shared-inbox-plan.ts).
 *
 * Nothing is deleted without asking: "Dismiss" only hides a file on this device (bounded list in local storage) and
 * "Move to trash" asks first and goes through `fileManager.trashFile`. After a file was used, the copy that is now stored
 * with the notebooks (`_assets`, the same path every import takes) is what the notebook uses; the original stays unless the
 * user confirms moving it to the trash.
 */
import { getLanguage, normalizePath, TFile, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import { MAX_IMAGE_BYTES } from "../integration/api-plan";
import { NotebookApiError } from "../integration/api-errors";
import { serializeChecked } from "../model/serialize";
import { PhotoDecodeError, photoSize } from "../scan/decode";
import type { NotebookSettings } from "../settings";
import { isNotebookFile, NOTEBOOK_EXTENSIONS } from "../storage/format";
import { backlinksOf } from "../storage/backlinks";
import { createNotebook } from "../storage/notebooks";
import { loadWritten, writtenSet } from "../storage/plugin-written";
import { storeAsset } from "../view/media";
import { showNotice } from "../view/notice";
import { ConfirmModal } from "./library-modals";
import { moveTargets } from "./move-pages";
import { EditPendingSaveError, editNotebook, elementPageLocked } from "./shared-inbox-edit";
import {
	DISMISSED_KEY, InboxQueue, SINCE_KEY, inboxKind, isInboxCandidate, isNewSince, normaliseDismissed, normaliseSince, noteNames, notebookNameFor, resolveInboxFolder, sinceFor,
	type InboxContext, type InboxItem,
} from "./shared-inbox-logic";
import { buildImageDocument, prepareAppendImagePage, prepareAppendPdf, prepareImageElement, type ImagePlacement, type PageSizePt } from "./shared-inbox-plan";
import { askImagePlacement, askNotebook } from "./shared-inbox-ui";
import { relativeTime } from "./format";

/** What the library and Home need from the inbox. */
export interface SharedInboxPort {
	/** False when the feature is off or there is no folder to watch. */
	enabled(): boolean;
	/** Why there is nothing to watch ("choose a folder"), or null. */
	problem(): string | null;
	/** Received files not dealt with, newest first. */
	items(): InboxItem[];
	/** "Today, 10:24" style age of a file. */
	ago(item: InboxItem): string;
	/** Called when the list changes. Returns the unsubscribe function. */
	onChange(fn: () => void): () => void;
	newNotebook(item: InboxItem): Promise<void>;
	addToNotebook(item: InboxItem): Promise<void>;
	dismiss(item: InboxItem): void;
	moveToTrash(item: InboxItem): void;
	/** Folder shown in texts ("the vault root" for ""). */
	folderLabel(): string;
}

/** What the inbox needs from the plugin's library host. */
export interface SharedInboxHost {
	app: App;
	settings(): NotebookSettings;
	pageSizes(assetId: string): Promise<PageSizePt[]>;
	importPdfFrom(folder: string, file: TFile): Promise<boolean>;
	openNotebook(file: TFile): Promise<void>;
}

interface LocalStorageApp {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

function load(app: LocalStorageApp, key: string): unknown {
	try {
		return app.loadLocalStorage(key);
	} catch {
		return null;
	}
}

function save(app: LocalStorageApp, key: string, value: unknown): void {
	try {
		app.saveLocalStorage(key, value);
	} catch (e) {
		console.error("[notebook] could not store the shared files record", e);
	}
}

/** Obsidian's attachments setting ("Files and links"), which has no typed accessor. */
function attachmentSetting(app: App): unknown {
	try {
		return (app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("attachmentFolderPath");
	} catch {
		return undefined;
	}
}

export class SharedInbox implements SharedInboxPort {
	private readonly app: App;
	private readonly queue: InboxQueue;
	private readonly listeners = new Set<() => void>();
	private scanned: string | null = null;
	private scanning = false;
	private readonly busy = new Set<string>();
	private started = false;

	constructor(private readonly host: SharedInboxHost) {
		this.app = host.app;
		this.queue = new InboxQueue(normaliseDismissed(load(this.app, DISMISSED_KEY)));
	}

	/** Watches the vault once the workspace is ready (before that, `create` fires for every existing file). */
	start(plugin: Plugin): void {
		if (this.started) return;
		this.started = true;
		this.app.workspace.onLayoutReady(() => {
			const vault = this.app.vault;
			plugin.registerEvent(vault.on("create", (f) => this.onCreate(f)));
			plugin.registerEvent(vault.on("modify", (f) => this.onModify(f)));
			plugin.registerEvent(vault.on("delete", (f) => this.emitIf(this.queue.remove(f.path))));
			plugin.registerEvent(vault.on("rename", (f, oldPath) => this.onRename(f, oldPath)));
			void this.scan();
		});
	}

	// ------------------------------------------------------------------------------------------------- the port

	private folder(): string | null {
		const s = this.host.settings();
		if (!s.sharedInbox) return null;
		return resolveInboxFolder(s.sharedInboxFolder, attachmentSetting(this.app));
	}

	enabled(): boolean {
		return this.folder() !== null;
	}

	problem(): string | null {
		const s = this.host.settings();
		return s.sharedInbox && this.folder() === null ? t("si.unavailable") : null;
	}

	folderLabel(): string {
		const f = this.folder();
		return f === null || f === "" ? t("si.root") : f;
	}

	items(): InboxItem[] {
		const folder = this.folder();
		if (folder === null) return [];
		// The setting changed (or this is the first look): read the folder again, quietly.
		if (this.scanned !== folder && !this.scanning) void this.scan();
		return this.queue.list();
	}

	ago(item: InboxItem): string {
		return relativeTime(item.at, Date.now(), getLanguage());
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] shared files listener", e);
			}
		}
	}

	private emitIf(changed: boolean): void {
		if (changed) this.emit();
	}

	// ------------------------------------------------------------------------------------------------- watching

	private context(folder: string, parent: { children: unknown[] } | null): InboxContext {
		const s = this.host.settings();
		const siblings = new Set<string>();
		for (const child of parent?.children ?? []) {
			if (child instanceof TFile && isNotebookFile(child)) siblings.add(child.basename.toLowerCase());
		}
		return { folder, notebooksFolder: s.folder, templatesFolder: s.templatesFolder, notebookTemplatesFolder: s.notebookTemplatesFolder, backupFolder: s.zipBackupFolder, siblingNotebooks: siblings, hasNotebookNamed: (stem) => NOTEBOOK_EXTENSIONS.some((e) => this.app.vault.getFileByPath(`${stem}.${e}`) !== null), pluginWritten: writtenSet(loadWritten(this.app)) };
	}

	private toItem(file: TFile): InboxItem | null {
		const kind = inboxKind(file.name);
		if (!kind) return null;
		return { path: file.path, name: file.name, kind, size: file.stat.size, at: file.stat.ctime || file.stat.mtime };
	}

	private candidate(file: TFile): InboxItem | null {
		const folder = this.folder();
		if (folder === null) return null;
		if (!isInboxCandidate(file.path, this.context(folder, file.parent))) return null;
		return this.toItem(file);
	}

	/** The time from which `folder` offers files on this device (stored the first time the folder is watched). */
	private sinceOf(folder: string): number {
		const stored = normaliseSince(load(this.app, SINCE_KEY));
		const record = sinceFor(stored, folder, Date.now());
		if (record.map !== stored) save(this.app, SINCE_KEY, record.map);
		return record.since;
	}

	/** Reads the watched folder again (the library opened, the setting changed). */
	async scan(): Promise<void> {
		const folder = this.folder();
		if (folder === null) {
			this.scanned = null;
			if (this.queue.reset([])) this.emit();
			return;
		}
		if (this.scanning) return;
		this.scanning = true;
		try {
			const dir = folder === "" ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(normalizePath(folder));
			const found: InboxItem[] = [];
			if (dir) {
				const since = this.sinceOf(folder);
				const ctx = this.context(folder, dir);
				for (const child of dir.children) {
					if (!(child instanceof TFile) || !isInboxCandidate(child.path, ctx)) continue;
					const item = this.toItem(child);
					// Files that were already there when the folder was first watched on this device are not offered.
					if (item && isNewSince(item, since)) found.push(item);
				}
			}
			this.scanned = folder;
			// Files that arrived through events and are still there stay, even if the clock of a synced file is older.
			const keep = this.queue.list().filter((i) => !found.some((f) => f.path === i.path) && this.app.vault.getFileByPath(i.path));
			const changed = this.queue.reset([...found, ...keep]);
			const pruned = this.queue.prune();
			if (pruned.length !== normaliseDismissed(load(this.app, DISMISSED_KEY)).length) save(this.app, DISMISSED_KEY, pruned);
			if (changed) this.emit();
		} catch (e) {
			console.error("[notebook] shared files scan", e);
		} finally {
			this.scanning = false;
		}
	}

	private onCreate(f: unknown): void {
		if (!(f instanceof TFile)) return;
		const item = this.candidate(f);
		if (!item) return;
		// The same rule as the scan: a burst of old files (a sync, a restored folder) is not "received".
		const folder = this.folder();
		if (folder !== null && !isNewSince(item, this.sinceOf(folder))) return;
		this.emitIf(this.queue.add(item));
	}

	private onModify(f: unknown): void {
		if (!(f instanceof TFile)) return;
		if (!this.queue.list().some((i) => i.path === f.path)) return;
		const item = this.candidate(f);
		if (item) this.emitIf(this.queue.add(item));
	}

	private onRename(f: unknown, oldPath: string): void {
		if (!(f instanceof TFile)) return;
		this.emitIf(this.queue.rename(oldPath, this.candidate(f)));
	}

	// ------------------------------------------------------------------------------------------------- actions

	private file(item: InboxItem): TFile | null {
		const file = this.app.vault.getFileByPath(item.path);
		if (!file) {
			showNotice(t("si.gone"));
			this.emitIf(this.queue.remove(item.path));
		}
		return file;
	}

	/** Runs one action per file at a time. */
	private async exclusive(item: InboxItem, job: (file: TFile) => Promise<void>): Promise<void> {
		if (this.busy.has(item.path)) return;
		const file = this.file(item);
		if (!file) return;
		this.busy.add(item.path);
		try {
			await job(file);
		} catch (e) {
			console.error("[notebook] shared files", e);
			if (e instanceof EditPendingSaveError) {
				// The edit is in the open notebook (undo reverts it): the file counts as used, so a retry cannot add it twice.
				this.hide(item);
				showNotice(t("si.savePending", { file: item.name }), 10000);
			} else if (e instanceof PhotoDecodeError && e.reason === "heic") showNotice(t("si.heic"), 8000);
			else if (e instanceof NotebookApiError && e.code === "page-locked") showNotice(e.message, 10000);
			else showNotice(t("si.failed", { error: e instanceof Error ? e.message : String(e) }), 10000);
		} finally {
			this.busy.delete(item.path);
		}
	}

	async newNotebook(item: InboxItem): Promise<void> {
		await this.exclusive(item, async (file) => {
			const settings = this.host.settings();
			if (item.kind === "pdf") {
				// The same import as "Import PDF": stores the file with the notebooks, makes the notebook and opens it.
				if (await this.host.importPdfFrom(settings.folder, file)) this.afterUse(item, file);
				return;
			}
			const bytes = await this.readImage(file);
			const dims = await photoSize(bytes, file.name);
			const asset = await storeAsset(this.app, settings.folder, bytes, file.name, "image");
			const doc = buildImageDocument(asset, dims);
			const checked = serializeChecked(doc);
			if (!checked.ok) throw new Error(checked.message);
			const name = notebookNameFor(file.name);
			const made = await createNotebook(this.app, settings.folder, name, doc);
			showNotice(t("si.created", { name: made.basename, file: file.name }));
			await this.host.openNotebook(made);
			this.afterUse(item, file);
		});
	}

	async addToNotebook(item: InboxItem): Promise<void> {
		if (this.busy.has(item.path)) return;
		const settings = this.host.settings();
		const targets = moveTargets(this.app, settings, null);
		if (targets.length === 0) {
			showNotice(t("si.pick.none"));
			return;
		}
		const target = await askNotebook(this.app, targets);
		if (!target) return;
		let placement: ImagePlacement = "page";
		if (item.kind === "image") {
			const chosen = await askImagePlacement(this.app, target.basename);
			if (!chosen) return;
			placement = chosen;
		}
		await this.exclusive(item, async (file) => {
			const vars = { file: file.name, name: target.basename };
			if (item.kind === "pdf") {
				const bytes = await this.app.vault.readBinary(file);
				const asset = await storeAsset(this.app, settings.folder, bytes, file.name, "pdf");
				const sizes = await this.host.pageSizes(asset.id);
				if (sizes.length === 0) throw new Error(t("import.empty"));
				const out = await editNotebook(this.app, settings, target, () => prepareAppendPdf(asset, sizes), "Insert PDF", asset);
				showNotice(t("si.added.pdf", { ...vars, n: String(out.added) }));
			} else {
				// Before the image is stored: a locked page refuses the edit and the stored copy would stay unused.
				if (placement === "element" && (await elementPageLocked(this.app, target))) {
					throw new NotebookApiError("page-locked", t("si.locked", { name: target.basename }), { path: target.path });
				}
				const bytes = await this.readImage(file);
				const dims = await photoSize(bytes, file.name);
				const asset = await storeAsset(this.app, settings.folder, bytes, file.name, "image");
				if (placement === "page") {
					await editNotebook(this.app, settings, target, () => prepareAppendImagePage(asset, dims), "Insert image page", asset);
					showNotice(t("si.added.imagePage", vars));
				} else {
					const out = await editNotebook(this.app, settings, target, (pageInView) => prepareImageElement(asset, dims, pageInView), "Insert image", asset);
					showNotice(t("si.added.element", { ...vars, page: String(out.page) }));
				}
			}
			this.afterUse(item, file);
		});
	}

	private async readImage(file: TFile): Promise<ArrayBuffer> {
		const bytes = await this.app.vault.readBinary(file);
		if (bytes.byteLength === 0) throw new Error(t("si.gone"));
		if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
		return bytes;
	}

	/** "A, B and 2 more" for a message. */
	private noteList(paths: readonly string[]): string {
		const { names, more } = noteNames(paths);
		const list = names.join(", ");
		return more > 0 ? t("si.notes.more", { notes: list, n: String(more) }) : list;
	}

	/**
	 * The file now lives with the notebooks: hide it here and offer to move the original to the trash, unless a note links to or
	 * embeds it (the trash would break those links): then it stays and a notice says why.
	 */
	private afterUse(item: InboxItem, file: TFile): void {
		this.hide(item);
		const linked = backlinksOf(this.app, file.path);
		if (linked.length > 0) {
			showNotice(t("si.original.linked", { file: file.name, notes: this.noteList(linked) }), 10000);
			return;
		}
		const parent = file.parent?.path && file.parent.path !== "/" ? file.parent.path : t("si.root");
		new ConfirmModal(
			this.app,
			{ title: t("si.original.title"), body: t("si.original.body", { file: file.name, folder: parent }), cta: t("si.action.trash") },
			() => this.trashFile(file),
		).open();
	}

	dismiss(item: InboxItem): void {
		this.hide(item);
		showNotice(t("si.dismissed", { file: item.name }));
	}

	private hide(item: InboxItem): void {
		save(this.app, DISMISSED_KEY, this.queue.dismiss(item));
		this.emit();
	}

	moveToTrash(item: InboxItem): void {
		const file = this.file(item);
		if (!file) return;
		// A note that links to or embeds the file is named, and the dialog starts on Cancel.
		const linked = backlinksOf(this.app, file.path);
		const body = linked.length > 0 ? t("si.trash.linked", { file: file.name, notes: this.noteList(linked) }) : t("si.trash.body", { file: file.name });
		new ConfirmModal(this.app, { title: t("si.trash.title"), body, cta: t("si.action.trash"), safe: linked.length > 0 }, () => this.trashFile(file)).open();
	}

	private trashFile(file: TFile): void {
		// The user's system or Obsidian trash, per their "Deleted files" setting; the delete event takes it off the list.
		this.app.fileManager.trashFile(file).then(
			() => showNotice(t("si.trashed", { file: file.name })),
			(e: unknown) => showNotice(t("si.failed", { error: e instanceof Error ? e.message : String(e) }), 10000),
		);
	}
}
