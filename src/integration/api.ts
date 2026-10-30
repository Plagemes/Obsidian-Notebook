import { normalizePath, type App, type Plugin, type TFile } from "obsidian";
import { pagesToPdf } from "../ink/export-pdf";
import { Batch } from "../model/history";
import { parse, serializeChecked } from "../model/serialize";
import type { Asset, NotebookDocument } from "../model/types";
import { kindFromName } from "../pdf/assets";
import { PhotoDecodeError, photoSize } from "../scan/decode";
import { backupFolder, type NotebookSettings } from "../settings";
import { isNotebookFile, readNotebookText, writeNotebookText } from "../storage/format";
import { isHiddenNotebookPath } from "../storage/trash-paths";
import { createNotebook, sanitizeName } from "../storage/notebooks";
import { VaultDocumentIO } from "../storage/vault-io";
import type { EditContext } from "../view/edit-context";
import { collectPageImages, freePath } from "../view/export";
import { NotebookMedia, storeAsset } from "../view/media";
import { t } from "../i18n";
import { validPageId } from "../zettel/subpath";
import { NotebookApiError, invalid } from "./api-errors";
import {
	API_METHODS, API_VERSION, KeyedQueue, MAX_IMAGE_BYTES, buildNewDocument, checkFolder, checkName, checkPageNumber, checkPageRef, describeNotebook, imageExtension,
	parseCreateOptions, parseImageOptions, parsePageSpec, planClosedEdit, prepareAddPages, prepareInsertImage,
	type AddPagesResult, type CreateNotebookOptions, type InsertImageOptions, type InsertImageResult, type NotebookInfo, type PageLinkInfo, type PageTemplate, type Prepare,
} from "./api-plan";
import { notebookUri } from "./links";
import { openNotebookAtPage, viewsOf } from "./open";
import { stablePageSubpath, withEmbedMarker } from "./page-links";

export { NotebookApiError } from "./api-errors";
export type { NotebookApiErrorCode } from "./api-errors";
export type {
	AddPagesResult, CreateNotebookOptions, InsertImageOptions, InsertImageResult, NotebookInfo, PageInfo, PageLinkInfo, PageTemplate,
} from "./api-plan";

/**
 * Public API for other plugins and scripts (Templater, QuickAdd, Dataview…), documented in docs/api.md:
 * `app.plugins.plugins["notebook"].api`. Arguments are validated and every failure is a `NotebookApiError`.
 * Keep this interface, the doc and `API_METHODS` (tests/api.test.ts checks them against each other) in step.
 */
export interface NotebookApi {
	/** Semantic version of this API (not of the plugin). */
	readonly version: string;
	/** The class of the errors thrown by every method (`error.code`, `error.details`). */
	readonly NotebookApiError: typeof NotebookApiError;
	createNotebook(folder: string, name: string, options?: CreateNotebookOptions): Promise<NotebookRef>;
	addPages(file: NotebookFileRef, pages: number | PageTemplate, after?: number): Promise<AddPagesResult>;
	insertImage(file: NotebookFileRef, page: number, image: Uint8Array | ArrayBuffer | string, options?: InsertImageOptions): Promise<InsertImageResult>;
	exportPdf(file: NotebookFileRef, options?: ExportPdfOptions): Promise<ExportPdfResult>;
	getNotebookInfo(file: NotebookFileRef): Promise<NotebookInfo>;
	/** The links that point at a page (by number or page id); they follow the page when pages are reordered. */
	getPageLink(file: NotebookFileRef, page: number | string): Promise<PageLinkInfo>;
	/** `page`: a 1-based number, or a page id (a string), which wins over any number when the page moved. */
	openNotebook(file: NotebookFileRef, page?: number | string): Promise<void>;
	listNotebooks(options?: ListNotebooksOptions): NotebookSummary[];
}

/** A notebook: the `TFile`, its vault path (with or without `.notebook`), or any object with a `path`. */
export type NotebookFileRef = TFile | string | { path: string };

export interface NotebookRef {
	path: string;
	/** File name without extension (differs from the requested name when that was taken: " 2", " 3"…). */
	name: string;
	/** Document id. */
	id: string;
	file: TFile;
}

export interface ExportPdfOptions {
	/** Fail with `export-incomplete`, writing nothing, if a PDF page or image cannot be loaded (default: leave it out and count it). */
	strict?: boolean;
}

export interface ExportPdfResult {
	/** The new PDF, next to the notebook. */
	path: string;
	pages: number;
	/** PDF pages or images that could not be loaded and are missing from the PDF. */
	skippedImages: number;
}

export interface ListNotebooksOptions {
	/** Only notebooks inside this folder (and its subfolders). */
	folder?: string;
}

export interface NotebookSummary {
	path: string;
	name: string;
	folder: string;
	/** Modification time of the file, ms since 1970. */
	mtime: number;
	size: number;
	/** Open in a tab. */
	open: boolean;
}

export interface ApiHost extends Plugin {
	settings: NotebookSettings;
}

/** How long a call waits for an open notebook that is still loading or has a pen down before it gives up with `busy`. */
const BUSY_WAIT_MS = 3_000;
const BUSY_POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function createNotebookApi(plugin: ApiHost): NotebookApi {
	return Object.freeze(new NotebookApiImpl(plugin));
}

class NotebookApiImpl implements NotebookApi {
	readonly version = API_VERSION;
	readonly NotebookApiError = NotebookApiError;
	private readonly queue = new KeyedQueue();

	constructor(private readonly plugin: ApiHost) {
		// Methods are called detached by scripts (`const { addPages } = api`): bind them.
		for (const name of API_METHODS) (this as unknown as Record<string, unknown>)[name] = (this[name] as (...a: never[]) => unknown).bind(this);
	}

	private get app(): App {
		return this.plugin.app;
	}

	private get settings(): NotebookSettings {
		return this.plugin.settings;
	}

	// ------------------------------------------------------------------- files

	private resolve(ref: unknown): TFile {
		const raw = typeof ref === "string" ? ref : typeof ref === "object" && ref !== null && typeof (ref as { path?: unknown }).path === "string" ? (ref as { path: string }).path : null;
		if (raw === null || raw.trim() === "") throw invalid("file", "expected a notebook (TFile or vault path)");
		const path = normalizePath(raw.trim());
		const file = this.app.vault.getFileByPath(path) ?? this.app.vault.getFileByPath(`${path}.notebook`);
		if (!file) throw new NotebookApiError("not-found", `No file "${path}" in the vault.`, { path });
		if (!isNotebookFile(file)) throw new NotebookApiError("not-a-notebook", `"${file.path}" is not a notebook.`, { path: file.path });
		if (this.hidden(file.path)) throw new NotebookApiError("not-found", `"${file.path}" is in the trash or the templates folder, not in the library.`, { path: file.path });
		return file;
	}

	/** Notebooks the library does not show: the plugin trash, the templates folder and the other reserved folders. */
	private hidden(path: string): boolean {
		return isHiddenNotebookPath(path, this.settings.folder, this.settings.templatesFolder);
	}

	/** The document as the open view has it, else as saved. */
	private async document(file: TFile): Promise<NotebookDocument> {
		for (const { view } of viewsOf(this.app, file)) if (view.document) return view.document;
		const parsed = parse(readNotebookText(file.extension, await this.app.vault.read(file)));
		if (!parsed.ok) {
			throw new NotebookApiError("unreadable", `"${file.path}" cannot be read: ${parsed.message}`, { path: file.path, reason: parsed.reason });
		}
		return parsed.doc;
	}

	// ------------------------------------------------------------------- reading

	listNotebooks(options?: ListNotebooksOptions): NotebookSummary[] {
		const known = options === undefined || options === null ? {} : options;
		if (typeof known !== "object" || Array.isArray(known)) throw invalid("options", "expected an object");
		for (const key of Object.keys(known)) if (key !== "folder") throw invalid("options", `unknown option "${key}" (known: folder)`, { option: key });
		const folder = known.folder === undefined ? null : checkFolder(known.folder);
		const open = new Set(this.app.workspace.getLeavesOfType("notebook-view").map((leaf) => (leaf.getViewState().state as { file?: unknown } | undefined)?.file));
		return this.app.vault.getFiles()
			.filter((f) => isNotebookFile(f) && (!folder || f.path.startsWith(`${folder}/`)) && !this.hidden(f.path))
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((f) => ({
				path: f.path,
				name: f.basename,
				folder: f.parent && f.parent.path !== "/" ? f.parent.path : "",
				mtime: f.stat.mtime,
				size: f.stat.size,
				open: open.has(f.path),
			}));
	}

	async getNotebookInfo(file: NotebookFileRef): Promise<NotebookInfo> {
		const f = this.resolve(file);
		const open = viewsOf(this.app, f).some(({ view }) => view.document !== null);
		return describeNotebook(await this.document(f), f, open);
	}

	// ------------------------------------------------------------------- creating, opening

	async createNotebook(folder: string, name: string, options?: CreateNotebookOptions): Promise<NotebookRef> {
		const dir = checkFolder(folder);
		const base = sanitizeName(checkName(name));
		if (!base) throw invalid("name", "has no characters that can be used in a file name");
		const o = parseCreateOptions(options);
		const s = this.settings;
		const doc = buildNewDocument(o, { pageSize: s.defaultPageSize, landscape: s.defaultLandscape, paper: s.defaultPaper }, new Date());
		const checked = serializeChecked(doc, true);
		if (!checked.ok) throw new NotebookApiError("write-failed", `The new notebook did not pass validation, so nothing was created: ${checked.message}`);
		let file: TFile;
		try {
			file = await createNotebook(this.app, dir, base, doc);
		} catch (e) {
			throw new NotebookApiError("write-failed", `The notebook could not be created: ${message(e)}`, { folder: dir });
		}
		const back = parse(readNotebookText(file.extension, await this.app.vault.read(file)));
		if (!back.ok || back.doc.id !== doc.id) throw new NotebookApiError("write-failed", `"${file.path}" was created but could not be read back.`, { path: file.path });
		if (o.open) await this.openNotebook(file);
		return { path: file.path, name: file.basename, id: doc.id, file };
	}

	async getPageLink(file: NotebookFileRef, page: number | string): Promise<PageLinkInfo> {
		const f = this.resolve(file);
		const doc = await this.document(f);
		const number = checkPageRef("page", page, doc.pages);
		const id = doc.pages[number - 1]!.id;
		const subpath = stablePageSubpath(number, id);
		const link = this.app.fileManager.generateMarkdownLink(f, "", subpath, t("share.linkAlias", { name: f.basename, page: String(number) }));
		const embed = withEmbedMarker(this.app.fileManager.generateMarkdownLink(f, "", subpath), true);
		return { page: number, id, subpath, link: withEmbedMarker(link, false), embed, uri: notebookUri(this.app.vault.getName(), f.path, number, id) };
	}

	async openNotebook(file: NotebookFileRef, page?: number | string): Promise<void> {
		const f = this.resolve(file);
		if (typeof page === "string") {
			if (!validPageId(page)) throw invalid("page", "expected a page number of 1 or more, or a page id", { value: page });
		} else if (page !== undefined && page !== null && (typeof page !== "number" || !Number.isInteger(page) || page < 1)) {
			throw invalid("page", "expected a page number of 1 or more (a number past the last page opens the last page)", { value: page });
		}
		const number = typeof page === "number" ? page : null;
		const pageId = typeof page === "string" ? page : null;
		try {
			await openNotebookAtPage(this.app, f, number, null, pageId);
		} catch (e) {
			throw new NotebookApiError("open-failed", `"${f.path}" could not be opened: ${message(e)}`, { path: f.path });
		}
	}

	// ------------------------------------------------------------------- editing

	async addPages(file: NotebookFileRef, pages: number | PageTemplate, after?: number): Promise<AddPagesResult> {
		const spec = parsePageSpec(pages);
		const f = this.resolve(file);
		const prepare = prepareAddPages(spec, after);
		// Reports a bad `after` before anything is queued or written.
		prepare(await this.document(f));
		return this.edit(f, prepare, "Insert pages");
	}

	async insertImage(file: NotebookFileRef, page: number, image: Uint8Array | ArrayBuffer | string, options?: InsertImageOptions): Promise<InsertImageResult> {
		const opts = parseImageOptions(options);
		const f = this.resolve(file);
		checkPageNumber("page", page, (await this.document(f)).pages.length);
		const { bytes, name } = await this.imageBytes(image);
		let dims: { width: number; height: number };
		try {
			dims = await photoSize(bytes, name);
		} catch (e) {
			const heic = e instanceof PhotoDecodeError && e.reason === "heic";
			throw new NotebookApiError("unsupported-image", heic ? "HEIC/HEIF images cannot be decoded here: convert the image to PNG or JPEG." : `The image cannot be decoded: ${message(e)}`);
		}
		let asset: Asset;
		try {
			asset = await storeAsset(this.app, this.settings.folder, bytes, name, "image");
		} catch (e) {
			throw new NotebookApiError("write-failed", `The image file could not be stored: ${message(e)}`);
		}
		return this.edit(f, prepareInsertImage(page, asset, dims, opts), "Insert image", asset);
	}

	/** The image as an exact `ArrayBuffer` plus a file name whose extension matches the format found in its first bytes. */
	private async imageBytes(image: unknown): Promise<{ bytes: ArrayBuffer; name: string }> {
		let bytes: ArrayBuffer;
		if (typeof image === "string") {
			const path = normalizePath(image.trim());
			const file = this.app.vault.getFileByPath(path);
			if (!file) throw new NotebookApiError("not-found", `No image file "${path}" in the vault.`, { path });
			if (kindFromName(file.name) !== "image") throw new NotebookApiError("unsupported-image", `"${path}" is not a PNG, JPEG, GIF or WebP file.`, { path });
			bytes = await this.app.vault.readBinary(file);
		} else if (image instanceof ArrayBuffer) {
			bytes = image;
		} else if (ArrayBuffer.isView(image)) {
			bytes = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer;
		} else {
			throw invalid("image", "expected bytes (Uint8Array or ArrayBuffer) or the vault path of an image file");
		}
		if (bytes.byteLength === 0) throw invalid("image", "is empty");
		if (bytes.byteLength > MAX_IMAGE_BYTES) throw invalid("image", `is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, { bytes: bytes.byteLength });
		const ext = imageExtension(bytes);
		if (!ext) throw new NotebookApiError("unsupported-image", "The image is not a PNG, JPEG, GIF or WebP file.");
		return { bytes, name: `image.${ext}` };
	}

	/** One edit at a time per notebook; through the open view when there is one, else on the file. */
	private edit<R>(file: TFile, prepare: Prepare<R>, label: string, pending?: Asset): Promise<R> {
		return this.queue.run(file.path, async () => {
			const ctx = await this.openContext(file);
			if (!ctx) return this.editClosed(file, prepare);
			if (pending) ctx.addPending(pending);
			try {
				return await this.editOpen(file, ctx, prepare, label);
			} finally {
				if (pending) ctx.removePending(pending.id);
			}
		});
	}

	/** Editing context of the open view of `file`; null when it is not open. Waits briefly for one that is loading or being written on. */
	private async openContext(file: TFile): Promise<EditContext | null> {
		const deadline = Date.now() + BUSY_WAIT_MS;
		for (;;) {
			const views = viewsOf(this.app, file);
			if (views.length === 0) return null;
			for (const { view } of views) {
				const ctx = view.editContext();
				if (ctx) return ctx;
			}
			if (Date.now() >= deadline) {
				throw new NotebookApiError("busy", `"${file.path}" is open but cannot be edited right now (still loading, read-only, or a pen, finger or gesture is down). Try again in a moment.`, { path: file.path });
			}
			await sleep(BUSY_POLL_MS);
		}
	}

	/** Through the open notebook's own history: one undo step, saved by its session. The file read back decides success. */
	private async editOpen<R>(file: TFile, ctx: EditContext, prepare: Prepare<R>, label: string): Promise<R> {
		const plan = prepare(ctx.doc);
		ctx.execute(new Batch(label, plan.commands));
		const flushed = await ctx.flush();
		const back = parse(readNotebookText(file.extension, await this.app.vault.read(file)));
		if (back.ok && plan.verify(back.doc)) return plan.result;
		throw new NotebookApiError("write-failed", flushed
			? `The change is in the open notebook but was not found in the saved file "${file.path}".`
			: `The change is in the open notebook (undo reverts it) but could not be saved yet; "${file.path}" will be saved when possible.`, { path: file.path });
	}

	/**
	 * A notebook that is not open: parse, apply, re-validate, keep a copy of what was there, write only if the file still
	 * holds what was read, read it back and check the change is in it. Throws on any doubt; the file is then unchanged.
	 */
	private async editClosed<R>(file: TFile, prepare: Prepare<R>): Promise<R> {
		const ext = file.extension;
		for (let attempt = 0; attempt < 2; attempt++) {
			const raw = await this.app.vault.read(file);
			const before = readNotebookText(ext, raw);
			const plan = planClosedEdit(before, prepare, new Date());
			if (!plan.ok) throw plan.error;
			const io = new VaultDocumentIO(this.app, file, () => backupFolder(this.settings));
			try {
				await io.backup(before, "before-api");
			} catch (e) {
				throw new NotebookApiError("write-failed", `A backup of "${file.path}" could not be made, so it was not changed: ${message(e)}`, { path: file.path });
			}
			let stale = false;
			await this.app.vault.process(file, (current) => {
				if (readNotebookText(ext, current) !== before) {
					stale = true;
					return current;
				}
				return writeNotebookText(ext, plan.text, current);
			});
			if (stale) continue;
			if (!plan.verify(await io.read())) {
				throw new NotebookApiError("write-failed", `The change was written to "${file.path}" but was not found when reading it back. The previous version is in the backup folder.`, { path: file.path });
			}
			return plan.result;
		}
		throw new NotebookApiError("changed-elsewhere", `"${file.path}" changed while it was being written (sync or another app). Nothing was written; try again.`, { path: file.path });
	}

	// ------------------------------------------------------------------- export

	async exportPdf(file: NotebookFileRef, options?: ExportPdfOptions): Promise<ExportPdfResult> {
		if (options !== undefined && options !== null && (typeof options !== "object" || Array.isArray(options))) throw invalid("options", "expected an object");
		for (const key of Object.keys(options ?? {})) if (key !== "strict") throw invalid("options", `unknown option "${key}" (known: strict)`, { option: key });
		if (options?.strict !== undefined && typeof options.strict !== "boolean") throw invalid("options.strict", "expected true or false");
		const f = this.resolve(file);
		const doc = await this.document(f);
		const media = new NotebookMedia(this.app, () => doc, () => this.settings.folder, () => undefined);
		try {
			const { images, skipped } = await collectPageImages(media, doc.pages);
			if (skipped > 0 && options?.strict) {
				throw new NotebookApiError("export-incomplete", `${skipped} PDF page(s) or image(s) could not be loaded, so no PDF was written.`, { skipped });
			}
			const bytes = pagesToPdf(doc.pages, { paper: true, title: f.basename, images: (p) => images.get(p) ?? [] });
			const path = freePath(this.app, f, "", "pdf");
			await this.app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
			return { path, pages: doc.pages.length, skippedImages: skipped };
		} catch (e) {
			if (e instanceof NotebookApiError) throw e;
			throw new NotebookApiError("export-failed", `The PDF could not be produced: ${message(e)}`, { path: f.path });
		} finally {
			media.destroy();
		}
	}
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
