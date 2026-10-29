import { loadPdfJs, normalizePath, Notice, Platform, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { createDocument, createId } from "../model/document";
import { parse, serializeChecked } from "../model/serialize";
import { PAGE_SIZES, PAPER_SPACING, type Asset, type NotebookDocument, type NotebookMeta, type Page } from "../model/types";
import { assetExtension, assetPath, assetsFolder } from "../pdf/assets";
import { scanFromCamera } from "../scan/scan-modal";
import { scannedPage } from "../scan/pages";
import { PdfStore } from "../pdf/pdf-store";
import type { PdfLib } from "../pdf/pdfjs-types";
import { backupFolder, type NotebookSettings } from "../settings";
import { readNotebookText, writeNotebookText } from "../storage/format";
import { createNotebook } from "../storage/notebooks";
import { VaultDocumentIO } from "../storage/vault-io";
import { resolveAssetFile, storeAsset } from "../view/media";
import { NewNotebookModal, type NewNotebookOptions } from "../view/modals";
import { NotebookView, VIEW_TYPE } from "../view/notebook-view";
import { pickFile } from "../view/pick";
import { libraryIndexPath, parseStoredJson, patchNotebookId, patchNotebookMeta, type MetaPatchResult } from "./host-logic";
import { importPdfAsNotebook } from "./import-pdf";
import { openLooseSheet } from "./loose-sheet";
import type { LibraryHost } from "./library-view";
import type { ThumbnailOptions } from "./thumbnail";

/** What the host needs from the plugin. */
export interface HostPlugin {
	app: App;
	manifest: { id: string };
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
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

	constructor(private readonly plugin: HostPlugin) {
		this.pdf = new PdfStore({
			loadPdfJs: () => loadPdfJs() as Promise<PdfLib>,
			readAsset: (id) => this.readAsset(id),
			createCanvas: (w, h) => {
				const c = activeDocument.createEl("canvas");
				c.width = w;
				c.height = h;
				return c;
			},
			// Thumbnails are small; keep the budget well under the notebook view's.
			memoryBudgetBytes: (Platform.isMobile ? 32 : 64) * 1024 * 1024,
		});
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

	createNotebook(folder: string): void {
		const s = this.plugin.settings;
		const defaults = { size: s.defaultPageSize, landscape: s.defaultLandscape, paper: s.defaultPaper };
		new NewNotebookModal(this.app, defaults, (options) => void this.createAndOpen(options, folder)).open();
	}

	private async createAndOpen(o: NewNotebookOptions, folder: string): Promise<void> {
		try {
			const s = this.plugin.settings;
			// Remember the choice for the next notebook.
			if (o.size !== s.defaultPageSize || o.landscape !== s.defaultLandscape || o.paper !== s.defaultPaper) {
				this.plugin.settings = { ...s, defaultPageSize: o.size, defaultLandscape: o.landscape, defaultPaper: o.paper };
				await this.plugin.saveSettings();
			}
			const base = PAGE_SIZES[o.size];
			const size = o.landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
			const doc = createDocument(new Date(), size, { kind: o.paper, spacing: PAPER_SPACING[o.paper] });
			const file = await createNotebook(this.app, folder, o.name, doc);
			await this.openNotebook(file);
		} catch (e) {
			new Notice(t("notice.createFailed", { error: (e as Error).message }));
		}
	}

	importPdf(folder: string): void {
		void importPdfAsNotebook<TFile>({
			pick: () => pickFile(this.app, "pdf"),
			store: async (bytes, name) => {
				const asset = await storeAsset(this.app, this.root(), bytes, name, "pdf");
				this.assets.set(asset.id, asset);
				return asset;
			},
			pageSizes: (id) => this.pdf.pageSizes(id),
			create: (dir, name, doc) => createNotebook(this.app, dir, name, doc),
			open: (file) => this.openNotebook(file),
			progress: (text) => {
				const notice = new Notice(text, 0);
				return () => notice.hide();
			},
			notify: (text) => void new Notice(text),
			messages: {
				working: (name) => t("import.working", { name }),
				failed: (error) => t("import.failed", { error }),
				empty: () => t("import.empty"),
			},
		}, folder);
	}

	openLooseSheet(): void {
		void openLooseSheet(this.plugin, (file) => this.openNotebook(file));
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
			new Notice(t("scan.failed", { error: (e as Error).message }), 8000);
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
				return (ctx, p) => ctx.drawImage(canvas, 0, 0, p.width, p.height);
			}
			const asset = doc.assets?.[bg.asset];
			const file = asset && resolveAssetFile(this.app, asset, this.root());
			if (!file) return null;
			const bitmap = await createImageBitmap(new Blob([await this.app.vault.readBinary(file)]));
			return (ctx, p) => {
				ctx.drawImage(bitmap, 0, 0, p.width, p.height);
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
