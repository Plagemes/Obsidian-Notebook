import { loadPdfJs, normalizePath, Platform, TFolder, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { createDocument, createId } from "../model/document";
import { backgroundRect } from "../model/margins";
import { parse, serializeChecked } from "../model/serialize";
import { PAGE_SIZES, PAPER_SPACING, type Asset, type NotebookDocument, type NotebookMeta, type Page } from "../model/types";
import { CreateDialog, type ChosenTemplate, type CreateTab, type FolderSpec } from "../view/create-dialog";
import { applyNotebookMeta, joinPath, notebookDocument, type NotebookSpec } from "../view/create-logic";
import type { PickedFile } from "../view/pick";
import { FolderMetaStore } from "./folder-meta-store";
import { assetExtension, assetPath, assetsFolder } from "../pdf/assets";
import { assetIdFromHash, sha256Hex } from "../pdf/hash";
import { scanFromCamera } from "../scan/scan-modal";
import { scannedPage } from "../scan/pages";
import { PdfStore } from "../pdf/pdf-store";
import type { PdfLib } from "../pdf/pdfjs-types";
import { backupFolder, readSettings, type NotebookSettings } from "../settings";
import { NEW_NOTEBOOK_EXTENSION, readNotebookText, writeNotebookText } from "../storage/format";
import { createNotebook } from "../storage/notebooks";
import { existsInsensitive } from "../storage/names";
import { LibraryTrash } from "../storage/trash";
import { expandPlaceholders } from "../model/notebook-template";
import { documentFromTemplate } from "../model/templates";
import { isWithin } from "../storage/trash-paths";
import { notebookTemplatesFolder, openNotebookTemplatePicker, saveNotebookAsTemplate } from "../view/notebook-templates";
import { openTemplateGallery } from "../view/page-tools";
import { headerField } from "../storage/integrity";
import { journalFolder, sidecarDeviceId, VaultDocumentIO, vaultDeviceFileAdapter } from "../storage/vault-io";
import { resolveAssetFile, storeAsset } from "../view/media";
import { NotebookView, VIEW_TYPE } from "../view/notebook-view";
import { askLectureSetup } from "../view/lecture-pack-modal";
import { pickFile } from "../view/pick";
import { libraryIndexPath, parseStoredJson, patchNotebookId, patchNotebookMeta, type MetaPatchResult } from "./host-logic";
import { importPdfAsNotebook } from "./import-pdf";
import { BulkImportDialog } from "./bulk-import-dialog";
import { pickManyFiles, fileSource } from "./bulk-drop";
import { BulkSkipError, runBulkImport } from "./bulk-import-run";
import { PhotoDecodeError, photoSize } from "../scan/decode";
import { artStyleFor } from "../ui/art/generative-art";
import { hint } from "../ui/hints";
import { createLectureFromSlides } from "./lecture-pack";
import { openLooseSheet, openNewQuickPage } from "./loose-sheet";
import { openTodaysPage } from "./daily";
import type { LectureTarget } from "./home-stats";
import { mayDiscardAsset } from "./bulk-discard";
import { journalReader, openLibraryCheck } from "./library-check-modal";
import { openStorageManager } from "./storage-dialog";
import { LibraryStateStore } from "./library-state-store";
import { BoardStateStore } from "./board-state-store";
import { CollectionsStore } from "./collections-store";
import type { BoardColumn } from "./board-logic";
import { BoardColumnsModal } from "../view/board-columns-modal";
import type { LibraryHost } from "./library-view";
import type { ThumbnailOptions } from "./thumbnail";
import { showNotice } from "../view/notice";
import { TransferFlows } from "./transfer-flows";

/** This device's last folder of the creation dialog (local storage of the vault, not synced). */
const LAST_FOLDER_KEY = "notebook-create-last-folder";
/** 0.14: this device's record of the notebooks it has seen (library/changed-seen.ts). */
const SEEN_STATE_KEY = "notebook-changed-seen";

/** Longest wait for a closing notebook view's final save before a library move goes on. */
const CLOSE_WAIT_MS = 10_000;

/** What the host needs from the plugin. */
export interface HostPlugin {
	app: App;
	manifest: { id: string };
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
	/** Class timetable service (optional: wave 0.6). */
	timetable?: {
		nowClass(): { course: string; room?: string } | null;
		openNow(): void;
		offer(): Promise<void>;
		/** 0.13: the class in progress and the notebook it opens (or the folder a new one is made in). */
		nowTarget?(): LectureTarget | null;
	};
}

/** The part of NotebookView the host calls (checked at runtime so the host compiles without it). */
interface MetaPatchable {
	applyMetaPatch?(patch: Partial<NotebookMeta>): boolean;
}

export class NotebookLibraryHost implements LibraryHost {
	/** Plugin-level PDF rasteriser: page sizes for the import, first-page thumbnails for the library. */
	readonly pdf: PdfStore;
	/** Assets seen in notebooks the library read, so a PDF is found even if its file was moved. */
	private readonly assets = new Map<string, Asset>();
	/** Library trash (#160): deleting from the library moves to `_trash/`. */
	readonly trash: LibraryTrash;
	/** Roadmap 54: pinned, archived and manual order, one file per device in `_meta` (library/library-state.ts). */
	readonly state: LibraryStateStore;
	/**
	 * Wave 0.12: colour, icon, description and art style of the library folders, one file per device in `_meta`
	 * (library/folder-meta.ts). Read API for the cards: `folderMeta.getFolderMeta(path)` and `folderMeta.onFolderMetaChange(fn)`.
	 */
	readonly folderMeta: FolderMetaStore;
	/** 0.15: the Board view's statuses, one file per device in `_meta` (library/board-state.ts). */
	readonly board: BoardStateStore;
	/** 0.17 (#120): the saved collections (rules over the library), one file per device in `_meta` (library/collections.ts). */
	readonly collections: CollectionsStore;

	constructor(private readonly plugin: HostPlugin) {
		this.state = new LibraryStateStore(vaultDeviceFileAdapter(plugin.app), () => plugin.settings.folder, sidecarDeviceId(plugin.app));
		this.folderMeta = new FolderMetaStore(vaultDeviceFileAdapter(plugin.app), () => plugin.settings.folder, sidecarDeviceId(plugin.app));
		this.board = new BoardStateStore(vaultDeviceFileAdapter(plugin.app), () => plugin.settings.folder, sidecarDeviceId(plugin.app));
		this.collections = new CollectionsStore(vaultDeviceFileAdapter(plugin.app), () => plugin.settings.folder, sidecarDeviceId(plugin.app));
		this.trash = new LibraryTrash({
			app: plugin.app,
			root: () => plugin.settings.folder,
			retentionDays: () => plugin.settings.trashRetentionDays,
			beforeMove: (path) => this.closeViewsOf(path),
		});
		this.transfers = new TransferFlows({
			app: plugin.app, settings: () => plugin.settings, trash: this.trash,
			// A closed notebook with edits waiting in the instant-save journal is not rewritten or trashed by a merge or a split.
			journal: { reader: journalReader(plugin.app), folder: journalFolder(plugin.app, plugin.manifest.id) },
		});
		this.pdf = new PdfStore({
			loadPdfJs: () => loadPdfJs() as Promise<PdfLib>,
			readAsset: (id) => this.readAsset(id),
			createCanvas: (w, h) => {
				const c = createEl("canvas");
				c.width = w;
				c.height = h;
				return c;
			},
			// Thumbnails are small; keep the budget well under the notebook view's.
			memoryBudgetBytes: (Platform.isMobile ? 32 : 64) * 1024 * 1024,
		});
	}

	/** 0.15: the Board's columns (the `boardColumns` setting). */
	boardColumns(): BoardColumn[] {
		return this.plugin.settings.boardColumns;
	}

	/** 0.15: opens the dialog that renames, recolours, adds and removes the Board's columns. */
	editBoardColumns(): void {
		new BoardColumnsModal({
			app: this.app,
			get: () => this.plugin.settings.boardColumns,
			set: async (columns) => {
				this.plugin.settings = readSettings({ ...this.plugin.settings, boardColumns: columns });
				await this.plugin.saveSettings();
			},
		}).open();
	}

	dispose(): void {
		this.pdf.clear();
	}

	private get app(): App {
		return this.plugin.app;
	}

	root(): string {
		return this.plugin.settings.folder;
	}

	private async readAsset(id: string): Promise<ArrayBuffer> {
		const asset: Asset = this.assets.get(id)
			?? { id, kind: "pdf", path: assetPath(assetsFolder(this.root()), id, assetExtension("pdf", "")), name: id, bytes: 0 };
		const file = resolveAssetFile(this.app, asset, this.root());
		if (!file) throw new Error(`missing asset ${asset.name}`);
		return this.app.vault.readBinary(file);
	}

	private remember(doc: NotebookDocument): void {
		for (const asset of Object.values(doc.assets ?? {})) this.assets.set(asset.id, asset);
	}

	// ----------------------------------------------------------------- reading

	async readNotebook(file: TFile): Promise<NotebookDocument | null> {
		try {
			const raw = await this.app.vault.read(file);
			const parsed = parse(readNotebookText(file.extension, raw));
			if (!parsed.ok) return null;
			this.remember(parsed.doc);
			return parsed.doc;
		} catch (e) {
			console.error("[notebook] could not read", file.path, e);
			return null;
		}
	}

	/** Roadmap #19: the notebook templates folder is not part of the library, wherever the setting puts it. */
	isHiddenPath(path: string): boolean {
		const s = this.plugin.settings;
		return isWithin(path, notebookTemplatesFolder(s));
	}

	/** Roadmap #19: "Save as notebook template" for a library card (what an open view holds, else the file). */
	async saveAsTemplate(file: TFile): Promise<void> {
		const doc = this.openView(file)?.document ?? (await this.readNotebook(file));
		if (!doc) return void showNotice(t("nbtemplate.unreadable", { name: file.basename }));
		saveNotebookAsTemplate(this.app, this.plugin.settings, doc, file.basename);
	}

	/** 0.17 (#77): merge, split and extract pages from the library's notebook menu. */
	private readonly transfers: TransferFlows;

	mergeNotebook(file: TFile): Promise<void> {
		return this.transfers.merge(file);
	}

	splitNotebook(file: TFile): Promise<void> {
		return this.transfers.split(file);
	}

	extractPages(file: TFile): Promise<void> {
		return this.transfers.extract(file);
	}

	/** The id at the start of the file, without parsing it; the whole parse when the file is laid out differently. */
	async readNotebookId(file: TFile): Promise<string | null> {
		try {
			const quick = headerField(readNotebookText(file.extension, await this.app.vault.cachedRead(file)), "id");
			if (quick) return quick;
		} catch (e) {
			console.error("[notebook] could not read", file.path, e);
			return null;
		}
		return (await this.readNotebook(file))?.id ?? null;
	}

	/** Roadmap 27: the library check (unreadable notebooks, unused files). */
	checkLibrary(): void {
		openLibraryCheck(this.app, () => this.plugin.settings, {
			journalFolder: journalFolder(this.app, this.plugin.manifest.id),
			// What every open notebook holds in memory: a view that cannot be inspected makes the check incomplete (it throws).
			openRoots: () => this.app.workspace.getLeavesOfType(VIEW_TYPE).flatMap((leaf) => (leaf.view instanceof NotebookView ? leaf.view.libraryCheckRoots() : [])),
		});
	}

	/** 0.15 (128): the Storage manager (sizes, unused / duplicate / heavy files, old backups). */
	openStorage(): void {
		openStorageManager({
			app: this.app,
			settings: () => this.plugin.settings,
			journalFolder: journalFolder(this.app, this.plugin.manifest.id),
			openRoots: () => this.app.workspace.getLeavesOfType(VIEW_TYPE).flatMap((leaf) => (leaf.view instanceof NotebookView ? leaf.view.libraryCheckRoots() : [])),
			trashNotebook: (file) => this.trash.trash(file),
			openNotebook: (file) => void this.openNotebook(file),
		});
	}

	// ----------------------------------------------------------------- opening

	/** Opens the notebook in a tab, focusing the tab that already shows it. */
	async openNotebook(file: TFile, pageIndex?: number): Promise<void> {
		const page = pageIndex !== undefined && pageIndex >= 0 ? pageIndex + 1 : undefined;
		const open = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((leaf) => leafFile(leaf) === file.path);
		if (open) {
			if (page !== undefined) {
				const current = open.getViewState();
				await open.setViewState({ ...current, state: { ...current.state, file: file.path, page } });
			}
			await this.app.workspace.revealLeaf(open);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await (page === undefined ? leaf.openFile(file) : leaf.openFile(file, { state: { page } }));
	}

	// ---------------------------------------------------------------- creating

	/** Opens the creation dialog on the Notebook tab, in `folder` (the registry action `new-notebook`). */
	createNotebook(folder?: string): void {
		this.openCreate("notebook", folder);
	}

	/** Opens the creation dialog on the Folder tab, inside `parent` (the registry action `new-folder`). */
	createFolder(parent?: string): void {
		this.openCreate("folder", parent);
	}

	/** Wave 0.12: the creation dialog (view/create-dialog.ts). */
	openCreate(tab: CreateTab, folder?: string): void {
		const app = this.app;
		new CreateDialog(app, {
			root: () => this.root(),
			allFolders: () => app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path),
			// Case is ignored, as on the disks of Windows, macOS and Android: `anatomy` takes `Anatomy`.
			exists: (path) => existsInsensitive(app.vault, normalizePath(path)),
			folderMeta: (path) => this.folderMeta.getFolderMeta(path),
			defaults: () => {
				const s = this.plugin.settings;
				return { size: s.defaultPageSize, landscape: s.defaultLandscape, paper: s.defaultPaper };
			},
			lastFolder: () => {
				const v: unknown = app.loadLocalStorage(LAST_FOLDER_KEY);
				return typeof v === "string" ? v : null;
			},
			pickTemplate: (done) => void openTemplateGallery(app, this.plugin.settings, (c) => done({ name: c.name, doc: c.doc })),
			pickNotebookTemplate: (done) => openNotebookTemplatePicker(app, this.plugin.settings, done),
			pickImage: () => pickFile(app, "image"),
			createNotebook: (spec, extras) => this.createFromDialog(spec, extras),
			createFolder: (spec) => this.createFolderFromDialog(spec),
		}, tab, folder).open();
	}

	/**
	 * Closes the notebook tabs that show `path` or something inside it before the file moves. Each view is flushed
	 * first (the move is refused if its changes cannot be written), then detached, and the move waits for the view's
	 * own close (its final flush) to finish, so no save of the old path runs while `vault.rename` does.
	 */
	private async closeViewsOf(path: string): Promise<void> {
		const closing: Promise<void>[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const file = leafFile(leaf);
			if (file === undefined || (file !== path && !file.startsWith(`${path}/`))) continue;
			const view = leaf.view;
			if (view instanceof NotebookView) {
				if (!(await view.flushNow())) throw new Error(t("library.notice.unsavedBeforeMove", { name: file }));
				closing.push(view.closed);
			}
			leaf.detach();
		}
		// A view that never gets its onClose (should not happen) must not block the move forever.
		await Promise.race([Promise.all(closing), new Promise<void>((resolve) => window.setTimeout(resolve, CLOSE_WAIT_MS))]);
	}

	/**
	 * Creates the notebook the dialog describes and opens it: a blank first page of the chosen paper and size (or the
	 * template's pages), the cover colour, description and cover art. The document is validated before the file exists.
	 */
	private async createFromDialog(spec: NotebookSpec, extras: { image?: PickedFile; template?: ChosenTemplate }): Promise<boolean> {
		try {
			const s = this.plugin.settings;
			// Remember the choice for the next notebook (a custom size is not a default).
			if (!extras.template && spec.size !== "custom" && (spec.size !== s.defaultPageSize || spec.landscape !== s.defaultLandscape || spec.paper !== s.defaultPaper)) {
				this.plugin.settings = { ...s, defaultPageSize: spec.size, defaultLandscape: spec.landscape, defaultPaper: spec.paper };
				await this.plugin.saveSettings();
			}
			// Roadmap #19: {{date}} in the title and description is filled in for any template.
			if (extras.template) spec = { ...spec, name: expandPlaceholders(spec.name), description: expandPlaceholders(spec.description) };
			const doc = extras.template ? (extras.template.ready ? extras.template.doc : documentFromTemplate(extras.template.doc)) : notebookDocument(spec);
			if (extras.template) applyNotebookMeta(doc, spec);
			if (extras.image) {
				const asset = await storeAsset(this.app, this.root(), extras.image.bytes, extras.image.name, "image");
				this.assets.set(asset.id, asset);
				doc.assets = { ...(doc.assets ?? {}), [asset.id]: asset };
				applyNotebookMeta(doc, spec, { kind: "image", asset: asset.id });
			}
			const checked = serializeChecked(doc);
			if (!checked.ok) throw new Error(checked.message);
			const file = await createNotebook(this.app, spec.folder, spec.name, doc);
			this.app.saveLocalStorage(LAST_FOLDER_KEY, spec.folder);
			await this.openNotebook(file);
			return true;
		} catch (e) {
			showNotice(t("notice.createFailed", { error: (e as Error).message }));
			return false;
		}
	}

	/** Creates the vault folder the dialog describes and stores its look (colour, icon, description, art style). */
	private async createFolderFromDialog(spec: FolderSpec): Promise<boolean> {
		const path = normalizePath(joinPath(spec.parent, spec.name));
		try {
			if (existsInsensitive(this.app.vault, path)) throw new Error(t("create.error.folderExists", { name: spec.name }));
			await this.app.vault.createFolder(path);
			this.app.saveLocalStorage(LAST_FOLDER_KEY, spec.parent);
		} catch (e) {
			showNotice(t("create.failed", { error: (e as Error).message }));
			return false;
		}
		try {
			// Every field is written, so a new folder never shows the look of an older one that had the same path.
			await this.folderMeta.set(path, { color: spec.color, icon: spec.icon, art: spec.art, description: spec.description || null });
		} catch (e) {
			// The folder exists: only its look could not be stored (e.g. this device's metadata file is unreadable).
			showNotice(t("create.metaFailed", { error: (e as Error).message }), 8000);
		}
		return true;
	}

	/** Imports a PDF as a new notebook in `folder`: the one chosen in a picker, or `source` when it is already in the vault. */
	importPdf(folder: string, source?: TFile): void {
		void this.importPdfFrom(folder, source);
	}

	/** `importPdf`, resolving to whether a notebook was made (0.16: the shared-files inbox goes on from there). */
	importPdfFrom(folder: string, source?: TFile, bytes?: ArrayBuffer): Promise<boolean> {
		return importPdfAsNotebook<TFile>({
			pick: source
				? async () => ({ name: source.name, bytes: bytes ?? (await this.app.vault.readBinary(source)) })
				: () => pickFile(this.app, "pdf"),
			store: async (bytes, name) => {
				const asset = await storeAsset(this.app, this.root(), bytes, name, "pdf");
				this.assets.set(asset.id, asset);
				return asset;
			},
			pageSizes: (id) => this.pdf.pageSizes(id),
			create: (dir, name, doc) => createNotebook(this.app, dir, name, doc),
			open: (file) => (hint("pdf-imported"), this.openNotebook(file)),
			progress: (text) => {
				const notice = showNotice(text, 0);
				return () => notice.hide();
			},
			notify: (text) => void showNotice(text),
			messages: {
				working: (name) => t("import.working", { name }),
				failed: (error) => t("import.failed", { error }),
				empty: () => t("import.empty"),
			},
		}, folder);
	}

	/**
	 * 0.16 (#80): bulk import. `files` are the ones dropped on the library (absent: the device's file picker opens first); the
	 * bulk-import dialog lists them and makes one notebook per PDF or image, or one for all the images. `after` gets the vault
	 * paths of the notebooks made (a drop on a Board column sets their status).
	 */
	importFiles(folder: string, files?: File[], after?: (paths: string[]) => void): void {
		void (async () => {
			const picked = files ?? (await pickManyFiles());
			if (picked.length === 0) return;
			const app = this.app;
			const root = () => this.root();
			const createdAssets = new Set<string>(); // asset paths this import created (not the ones already in the vault)
			new BulkImportDialog(app, {
				root,
				allFolders: () => app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path),
				taken: (dir, clean) => existsInsensitive(app.vault, normalizePath(joinPath(dir, `${clean}.${NEW_NOTEBOOK_EXTENSION}`))),
				run: (jobs, dir, look, ctl) => runBulkImport<TFile>(jobs, dir, look, {
					store: async (bytes, name, kind) => {
						// Remember the copies this run creates: only those may be removed again if their file turns out unusable.
						const path = normalizePath(assetPath(assetsFolder(root()), assetIdFromHash(await sha256Hex(bytes)), assetExtension(kind, name)));
						const existed = app.vault.getFileByPath(path) !== null;
						const asset = await storeAsset(app, root(), bytes, name, kind);
						this.assets.set(asset.id, asset);
						if (!existed) createdAssets.add(asset.path);
						return asset;
					},
					discard: async (asset) => {
						if (!createdAssets.has(asset.path)) return; // it was already in the vault: another notebook may use it
						const copy = app.vault.getFileByPath(normalizePath(asset.path));
						// A notebook of the library may already name it (a synced notebook whose asset file was still on its way when
						// this run looked): never discard then, nor while any notebook is still being downloaded.
						const notebooks = app.vault.getFiles().filter((f) => f.extension === NEW_NOTEBOOK_EXTENSION);
						if (!(await mayDiscardAsset(asset.id, notebooks.map((f) => ({ read: () => app.vault.read(f) }))))) return;
						createdAssets.delete(asset.path);
						this.assets.delete(asset.id);
						if (copy) await app.fileManager.trashFile(copy);
					},
					pdfSizes: (id) => this.pdf.pageSizes(id),
					imageSize: (bytes, name, type) => photoSize(bytes, name, type).catch((e: unknown) => {
						throw e instanceof PhotoDecodeError && e.reason === "heic" ? new BulkSkipError("heic") : e;
					}),
					create: async (dir2, name, doc) => {
						const file = await createNotebook(app, dir2, name, doc);
						return { file, path: file.path };
					},
					notebookExists: (dir2, name) => existsInsensitive(app.vault, normalizePath(joinPath(dir2, `${name}.${NEW_NOTEBOOK_EXTENSION}`))),
					artStyle: (name) => artStyleFor(name),
					yieldToUi: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
				}, ctl),
				open: (path) => {
					const file = app.vault.getFileByPath(path);
					if (file) void this.openNotebook(file);
				},
				finished: (outcomes) => {
					const made = outcomes.flatMap((o) => (o.path !== null ? [o.path] : []));
					if (made.length > 0) after?.(made);
				},
				notify: (text) => void showNotice(text),
				today: () => new Date().toISOString().slice(0, 10),
			}, picked.map(fileSource), folder).open();
		})();
	}

	nowClass(): { course: string; room?: string } | null {
		return this.plugin.timetable?.nowClass() ?? null;
	}

	openNowClass(): void {
		this.plugin.timetable?.openNow();
	}

	/** The library was opened: offer the class in progress. */
	libraryOpened(): void {
		void this.plugin.timetable?.offer();
	}

	/**
	 * "New lecture from slides…": picks the course slides (vault or device), asks for layout and header and creates the
	 * lecture notebook. Without `folder` it goes next to the notebook in view, or in the notebooks folder.
	 */
	lectureFromSlides(folder?: string): void {
		const active = this.app.workspace.getActiveViewOfType(NotebookView)?.file?.parent?.path;
		const target = folder ?? (active && active !== "/" ? active : this.plugin.settings.folder);
		void createLectureFromSlides<TFile>({
			pick: () => pickFile(this.app, "pdf"),
			ask: (defaultTitle) => askLectureSetup(this.app, defaultTitle),
			store: async (bytes, name) => {
				const asset = await storeAsset(this.app, this.root(), bytes, name, "pdf");
				this.assets.set(asset.id, asset);
				return asset;
			},
			pageSizes: (id) => this.pdf.pageSizes(id),
			create: (dir, name, doc) => createNotebook(this.app, dir, name, doc),
			open: (file) => this.openNotebook(file),
			progress: (text) => {
				const notice = showNotice(text, 0);
				return () => notice.hide();
			},
			notify: (text) => void showNotice(text),
			messages: {
				working: (name) => t("import.working", { name }),
				failed: (error) => t("import.failed", { error }),
				empty: () => t("import.empty"),
			},
		}, target);
	}

	openLooseSheet(): void {
		void openLooseSheet(this.plugin, (file) => this.openNotebook(file));
	}

	/** 0.15 (O12): Home's "Today's page" quick action: a dated page in the daily notebook. */
	todaysPage(): void {
		void openTodaysPage(this.plugin, (file) => this.openNotebook(file));
	}

	/** 0.13 (Home's Quick page card): a new page in Quick notes, created the first time. */
	newQuickPage(): void {
		void openNewQuickPage(this.plugin, (file) => this.openNotebook(file));
	}

	/** 0.13: the class in progress and what it opens (Home's Continue card). */
	lectureTarget(): LectureTarget | null {
		return this.plugin.timetable?.nowTarget?.() ?? null;
	}

	/** 0.13: the notebook and page (1-based) the reader was on last (Home's Continue card). */
	lastNotebook(): { path: string; page: number } | null {
		const s = this.plugin.settings;
		return s.lastNotebookPath ? { path: s.lastNotebookPath, page: s.lastNotebookPage } : null;
	}

	/** 0.14: this device's record of what it has seen of each notebook (local storage: per vault and device, never synced). */
	loadSeenState(): unknown {
		return this.app.loadLocalStorage(SEEN_STATE_KEY) as unknown;
	}

	saveSeenState(state: unknown): void {
		this.app.saveLocalStorage(SEEN_STATE_KEY, state);
	}

	/** 0.14: paths of the notebooks open in a tab (the "Now" section). */
	openNotebooks(): string[] {
		const out: string[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const path = leaf.view instanceof NotebookView ? leaf.view.file?.path : undefined;
			if (path && !out.includes(path)) out.push(path);
		}
		return out;
	}

	/** 0.13: the "Your name" setting (Home's greeting). */
	userName(): string {
		return this.plugin.settings.userName;
	}

	/** Camera scan into a new notebook "Scan <date>": one page per sheet, the JPEG as the page background. */
	scanToNotebook(folder: string): void {
		void this.createFromScan(folder);
	}

	private async createFromScan(folder: string): Promise<void> {
		try {
			const sheets = await scanFromCamera(this.app);
			if (sheets.length === 0) return;
			const doc = createDocument(new Date(), PAGE_SIZES.a4, { kind: "blank", spacing: PAPER_SPACING.blank });
			doc.pages = [];
			doc.assets = {};
			for (const sheet of sheets) {
				const asset = await storeAsset(this.app, this.root(), sheet.jpeg, `${sheet.name}.jpg`, "image");
				this.assets.set(asset.id, asset);
				doc.assets[asset.id] = asset;
				doc.pages.push(scannedPage(asset, sheet.width, sheet.height));
			}
			const name = t("scan.notebookName", { date: new Date().toISOString().slice(0, 10) });
			// Validate before creating the file, like the PDF import: an invalid document never reaches the vault.
			const checked = serializeChecked(doc);
			if (!checked.ok) throw new Error(checked.message);
			const file = await createNotebook(this.app, folder, name, doc);
			await this.openNotebook(file);
		} catch (e) {
			showNotice(t("scan.failed", { error: (e as Error).message }), 8000);
		}
	}

	// ---------------------------------------------------------------- metadata

	async updateMeta(file: TFile, patch: Partial<NotebookMeta>): Promise<void> {
		const view = this.openView(file);
		if (view) {
			const target = view as unknown as MetaPatchable;
			if (typeof target.applyMetaPatch !== "function" || !target.applyMetaPatch(patch)) throw new Error(t("host.metaRejected"));
			return;
		}
		await this.rewrite(file, (json) => patchNotebookMeta(json, patch));
	}

	/** A duplicated notebook is a byte copy: give it its own document id. */
	async afterDuplicate(file: TFile): Promise<void> {
		await this.rewrite(file, (json) => patchNotebookId(json, createId()));
	}

	/**
	 * Safe read-patch-write: nothing is written if the file fails to parse or the result fails the
	 * round-trip check, and only if the file still holds what was read (one retry, then an error).
	 */
	private async rewrite(file: TFile, patch: (json: string) => MetaPatchResult): Promise<void> {
		const ext = file.extension;
		for (let attempt = 0; attempt < 2; attempt++) {
			const raw = await this.app.vault.read(file);
			const json = readNotebookText(ext, raw);
			const result = patch(json);
			if (!result.ok) throw new Error(result.message);
			if (!result.changed) return;
			if (result.migrated) {
				// Writing upgrades an older file: keep the original with the other backups.
				const io = new VaultDocumentIO(this.app, file, () => backupFolder(this.plugin.settings));
				await io.backup(json, "unsaved");
			}
			let stale = false;
			await this.app.vault.process(file, (current) => {
				if (current !== raw) {
					stale = true;
					return current;
				}
				return writeNotebookText(ext, result.text, current);
			});
			if (!stale) return;
		}
		throw new Error(t("host.changedElsewhere"));
	}

	private openView(file: TFile): NotebookView | null {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof NotebookView && view.file?.path === file.path) return view;
		}
		return null;
	}

	// ------------------------------------------------------------------- index

	private indexPath(): string {
		return normalizePath(libraryIndexPath(this.app.vault.configDir, this.plugin.manifest.id));
	}

	async loadIndex(): Promise<unknown> {
		// The plugin's own config folder (not a vault file): the adapter is the allowed route there.
		const adapter = this.app.vault.adapter;
		try {
			const path = this.indexPath();
			if (!(await adapter.exists(path))) return null;
			return parseStoredJson(await adapter.read(path));
		} catch {
			return null;
		}
	}

	async saveIndex(data: unknown): Promise<void> {
		const adapter = this.app.vault.adapter;
		const path = this.indexPath();
		const dir = path.slice(0, path.lastIndexOf("/"));
		if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		await adapter.write(path, JSON.stringify(data));
	}

	// -------------------------------------------------------------- thumbnails

	/**
	 * Draws the PDF page or image behind a thumbnail: loads it first (async), then returns the synchronous
	 * `drawBackground` that renderThumbnail expects. Null for pages without a PDF background or when
	 * the PDF cannot be rendered (the thumbnail then shows the ink on paper).
	 */
	async thumbnailBackground(doc: NotebookDocument, page: Page, width: number): Promise<ThumbnailOptions["drawBackground"] | null> {
		const bg = page.background;
		if (!bg || page.width <= 0) return null;
		this.remember(doc);
		try {
			if (bg.kind === "pdf") {
				const canvas = await this.pdf.render(bg.asset, bg.page, width / page.width);
				return (ctx, p) => {
					const r = backgroundRect(p);
					ctx.drawImage(canvas, r.x, r.y, r.width, r.height);
				};
			}
			const asset = doc.assets?.[bg.asset];
			const file = asset && resolveAssetFile(this.app, asset, this.root());
			if (!file) return null;
			const bitmap = await createImageBitmap(new Blob([await this.app.vault.readBinary(file)]));
			return (ctx, p) => {
				const r = backgroundRect(p);
				ctx.drawImage(bitmap, r.x, r.y, r.width, r.height);
				bitmap.close();
			};
		} catch (e) {
			console.error("[notebook] thumbnail background", e);
			return null;
		}
	}
}

function leafFile(leaf: WorkspaceLeaf): string | undefined {
	const state = leaf.getViewState().state as { file?: unknown } | undefined;
	return typeof state?.file === "string" ? state.file : undefined;
}
