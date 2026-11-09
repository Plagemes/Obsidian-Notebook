/** 0.26 gallery (#421): registers the `notebook-gallery` block and the command "Insert gallery block". */
import type { Plugin, TFile } from "obsidian";
import { t } from "../i18n";
import { writing } from "../ink/writing-guard";
import type { GlobalBookmark } from "../library/bookmarks";
import { PageThumbs } from "../library/page-thumbs";
import type { ThumbnailOptions } from "../library/thumbnail";
import type { NotebookDocument, Page } from "../model/types";
import type { Timetable } from "../timetable/schedule";
import { GalleryBuilderModal, galleryInsertText } from "./gallery-builder";
import { registerGallery } from "./gallery-render";
import { GalleryService } from "./gallery-service";
import { openNotebookAtPage } from "./open";

export interface GalleryHost {
	root(): string;
	loadIndex(): Promise<unknown>;
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	background(doc: NotebookDocument, page: Page, width: number): Promise<ThumbnailOptions["drawBackground"] | null>;
	timetable(): Timetable | null | undefined;
	bookmarks(): readonly GlobalBookmark[];
	onBookmarksChange(fn: () => void): () => void;
}

/** Returns the service, so the plugin can stop it on unload. */
export function registerGalleryBlock(plugin: Plugin, host: GalleryHost): GalleryService {
	const { app } = plugin;
	const service = new GalleryService({
		app, root: () => host.root(), loadIndex: () => host.loadIndex(), readNotebook: (f) => host.readNotebook(f), timetable: () => host.timetable(),
		bookmarks: () => host.bookmarks(), onBookmarksChange: (fn) => host.onBookmarksChange(fn),
	});
	let closed = false;
	plugin.register(() => void (closed = true));
	// The same thumbnail drawing and cache as Home's page thumbnails; the mtime comes from the vault so a changed notebook is drawn again.
	const thumbs = new PageThumbs({
		fileOf: (path) => app.vault.getFileByPath(path),
		readNotebook: (f) => host.readNotebook(f),
		background: (doc, page, width) => host.background(doc, page, width),
		idle: () => writing.idle(),
		isClosed: () => closed,
	}, (path) => app.vault.getFileByPath(path)?.stat.mtime ?? 0);
	registerGallery(plugin, { app, data: service, thumbs, open: (file, page, pageId) => void openNotebookAtPage(app, file, page, null, pageId ?? null) });
	plugin.addCommand({
		id: "insert-gallery",
		name: t("command.galleryInsert"),
		editorCallback: (editor) => {
			new GalleryBuilderModal(app, service, (block) => editor.replaceSelection(galleryInsertText(block, editor.getCursor().ch === 0))).open();
		},
	});
	return service;
}
