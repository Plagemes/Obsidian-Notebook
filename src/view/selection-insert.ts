// 0.18 (#59) Selection into a note: the selected region of the page is drawn through the shared page renderer (PNG) or cropped from
// the page SVG, stored where Obsidian puts attachments (remembered as written by the plugin), and its embed, with an optional link
// back to the page, is inserted at the cursor of the Markdown note the user was last in (editor API, so undo in the note works).
// With no note open a picker offers one and the block is appended with vault.process. Nothing changes the notebook.
import { FuzzySuggestModal, TFile, normalizePath, type App, type FuzzyMatch, type MarkdownView } from "obsidian";
import { t } from "../i18n";
import { targetNote } from "../integration/page-share";
import { stablePageSubpath, withEmbedMarker } from "../integration/page-links";
import { pageToSvg, type SvgPlacedImage } from "../ink/export-svg";
import { DEFAULT_MARKDOWN_DPI } from "../model/export-markdown";
import { appendInsertBlock, buildInsertLine, cropSvg, editorStillTargets, insertionAtCursor, insertPictureName, insertPoint, type InsertKind } from "../model/note-insert";
import { taskStamp, type TaskRect } from "../model/selection-task";
import type { Page } from "../model/types";
import type { NotebookSettings } from "../settings";
import { recordPluginWrite } from "../storage/plugin-written";
import { ensureFolder } from "../storage/vault-io";
import { sanitizeName } from "../storage/names";
import { collectPageImages, jpegDataUrl, type ExportOptions } from "./export";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer, type PageImageOptions } from "./page-images";

export interface InsertHost {
	app: App;
	file: TFile;
	settings: NotebookSettings;
	/** The page as the view shows it (the live view of a page with states). */
	page: Page;
	pageNumber: number;
	/** The region to draw, in page points. */
	crop: TaskRect;
	media: NotebookMedia | null;
	render: PageImageOptions;
	exportOptions: ExportOptions;
	kind: InsertKind;
}

class NoteChooser extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly choose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder(t("noteInsert.pick.placeholder"));
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
		this.choose(file);
	}

	renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
		el.setText(match.item.path);
	}
}

/** The picture of the region as bytes; null when it cannot be made. */
async function drawPicture(host: InsertHost): Promise<ArrayBuffer | null> {
	const transparent = host.settings.noteInsertBackground === "transparent";
	if (host.kind === "svg") {
		const options: ExportOptions = { ...host.exportOptions, ...(transparent ? { layers: "ink" as const } : {}) };
		const { images } = await collectPageImages(host.media, [host.page], options.layers);
		await options.prepare?.([host.page]);
		const placed = (p: Page): SvgPlacedImage[] => (images.get(p) ?? []).map((img) => ({
			href: jpegDataUrl(img.jpeg), x: img.x, y: img.y, width: img.width, height: img.height,
			...(img.rotation !== undefined ? { rotation: img.rotation } : {}),
			...(img.layer !== undefined ? { layer: img.layer } : {}),
		}));
		const svg = pageToSvg(host.page, {
			paper: true, images: placed, hiddenInk: options.hiddenInk?.(host.page) ?? false,
			...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
			...(options.header ? { header: options.header(host.page) } : {}),
			...(options.layers ? { layers: options.layers } : {}),
			...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
		});
		const cropped = cropSvg(svg, host.crop);
		return cropped ? new TextEncoder().encode(cropped).buffer : null;
	}
	const renderer = new PageImageRenderer(host.media, { ...host.render, ...(transparent ? { layers: "ink" as const } : {}) });
	try {
		await host.exportOptions.prepare?.([host.page]);
		const drawn = await renderer.renderRegions(host.page, DEFAULT_MARKDOWN_DPI, [host.crop]);
		const blob = drawn.blobs[0];
		return blob ? await blob.arrayBuffer() : null;
	} finally {
		renderer.close();
	}
}

/** Where the text goes: the note and, for an open editor, the view it was open in (checked again before writing: the leaf may show another note by then). */
type Destination = { note: TFile; view: MarkdownView | null } | null;

function chooseDestination(app: App): Promise<Destination> {
	const view = targetNote(app);
	if (view?.file) return Promise.resolve({ note: view.file, view: view.getMode() === "source" ? view : null });
	return new Promise((resolve) => {
		let chosen = false;
		const picker = new NoteChooser(app, (file) => {
			chosen = true;
			resolve({ note: file, view: null });
		});
		const close = picker.onClose.bind(picker);
		picker.onClose = () => {
			close();
			// onChooseItem runs after onClose, so the answer for "nothing chosen" waits a tick.
			window.setTimeout(() => {
				if (!chosen) resolve(null);
			}, 0);
		};
		picker.open();
	});
}

/** Inserts the selection into a note; returns the note path or null (nothing written, the reason is shown). Never throws. */
export async function runInsertIntoNote(host: InsertHost, now: Date = new Date()): Promise<string | null> {
	const { app, file } = host;
	let stored: TFile | null = null;
	try {
		const destination = await chooseDestination(app);
		if (!destination) return null;
		const data = await drawPicture(host);
		if (!data) {
			showNotice(t("noteInsert.noPicture"), 6000);
			return null;
		}
		const notePath = destination.note.path;
		const name = insertPictureName(sanitizeName(file.basename) || "Notebook", host.pageNumber, taskStamp(now), host.kind);
		const path = normalizePath(await app.fileManager.getAvailablePathForAttachment(name, notePath));
		recordPluginWrite(app, [path]); // before the write: the inbox must not offer this picture
		const slash = path.lastIndexOf("/");
		if (slash > 0) await ensureFolder(app, path.slice(0, slash));
		stored = await app.vault.createBinary(path, data);
		const pageLink = host.settings.noteInsertLinkBack
			? app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(host.pageNumber, host.page.id), "↩")
			: null;
		const line = buildInsertLine({ embed: withEmbedMarker(app.fileManager.generateMarkdownLink(stored, notePath), true), width: host.settings.noteInsertWidth, pageLink });
		const { view } = destination;
		// The drawing was async: the leaf may have switched to another note meanwhile, and the embed must not go there.
		const editor = view && editorStillTargets(view.file?.path, destination.note.path, view.getMode(), view.containerEl.isConnected) ? view.editor : null;
		if (editor) {
			const fmEnd = app.metadataCache.getFileCache(destination.note)?.frontmatterPosition?.end.line ?? null;
			const at = insertPoint(editor.getCursor(), fmEnd, (n) => editor.getLine(n), editor.lastLine());
			editor.replaceRange(insertionAtCursor(line, at.before, at.after), { line: at.line, ch: at.ch });
		} else {
			await app.vault.process(destination.note, (current) => appendInsertBlock(current, line));
		}
		stored = null; // in the note: it stays
		showNotice(t("noteInsert.done", { name: destination.note.basename }), 5000);
		return destination.note.path;
	} catch (e) {
		console.error("[notebook] insert into note", e);
		if (stored) {
			try {
				await app.fileManager.trashFile(stored);
			} catch (e2) {
				console.error("[notebook] insert: the picture could not be removed", e2);
			}
		}
		showNotice(t("noteInsert.failed", { error: e instanceof Error ? e.message : String(e) }), 9000);
		return null;
	}
}
