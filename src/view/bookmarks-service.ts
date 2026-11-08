/**
 * Global bookmarks (roadmap #265): what the page action, the command, Home and the dialog do. The bookmarks are kept by
 * `BookmarksStore` (one file per device in `_meta`, never in a notebook); this keeps them in step with the vault (other
 * devices' files, renamed and moved notebooks), toggles the page in view and opens a bookmark.
 */
import { TFile, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import { openNotebookAtPage } from "../integration/open";
import { RenameBatcher } from "../library/quicktabs";
import { resolveBookmark, type GlobalBookmark } from "../library/bookmarks";
import type { NotebookDocument } from "../model/types";
import { BookmarksBlockedError, type BookmarksStore } from "../library/bookmarks-store";
import { listNotebooks } from "../storage/notebooks";
import { isNotebookFile } from "../storage/format";
import { showNotice } from "./notice";

/** What the service needs of a notebook view (an interface, so the view can be a plain object in tests). */
export interface BookmarksViewApi {
	/** The id of the notebook in view, or null when none is loaded. */
	docId(): string | null;
	path(): string | null;
	pageIds(): string[];
	/** The page in view: its id, 0-based index and its own bookmark title, if any. */
	current(): { pageId: string; index: number; title: string } | null;
}

export type BookmarkStatus =
	| { kind: "page"; file: TFile; index: number; title: string }
	| { kind: "page-gone"; file: TFile }
	| { kind: "notebook-gone" };

export interface BookmarksDeps {
	app: App;
	store: BookmarksStore;
	/** The notebook's id from the start of its file, or null (finds a notebook that was moved where no rename event was seen). */
	readNotebookId(file: TFile): Promise<string | null>;
	/** The parsed notebook, or null when it cannot be read (the dialog checks that the pages are still there). */
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	notebooksFolder(): string;
	/** Opens a notebook at a page (default: the plugin's own opener). Replaced in the harness. */
	openAt?(file: TFile, page: number, pageId: string): Promise<void>;
}

export class BookmarksService {
	private readonly listeners = new Set<() => void>();

	constructor(private readonly deps: BookmarksDeps) {
		deps.store.onChange(() => this.changed());
	}

	get store(): BookmarksStore {
		return this.deps.store;
	}

	/** Reads the files at start and follows other devices' files and renamed or moved notebooks. */
	register(plugin: Plugin): void {
		const { vault, workspace } = plugin.app;
		const load = () => void this.deps.store.load().catch((e) => console.error("[notebook] bookmarks could not be read", e));
		workspace.onLayoutReady(load);
		const changed = (file: unknown) => {
			if (file instanceof TFile && this.deps.store.watches(file.path)) load();
		};
		plugin.registerEvent(vault.on("create", changed));
		plugin.registerEvent(vault.on("modify", changed));
		plugin.registerEvent(vault.on("delete", changed));
		// A renamed folder fires one event per notebook in it: they are followed in one pass.
		const renames = new RenameBatcher(
			(list) => void this.deps.store.retargetMany(list).catch((e) => this.fail(e)),
			(fn, ms) => {
				const id = window.setTimeout(fn, ms);
				return () => window.clearTimeout(id);
			},
		);
		plugin.register(() => renames.flush());
		plugin.registerEvent(vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile && isNotebookFile(file)) renames.add(oldPath, file.path);
		}));
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	private changed(): void {
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] bookmarks listener failed", e);
			}
		}
	}

	list(): GlobalBookmark[] {
		return this.deps.store.list();
	}

	count(): number {
		return this.deps.store.list().length;
	}

	private ref(view: BookmarksViewApi, pageId: string): { docId: string; path: string; pageId: string } | null {
		const path = view.path();
		return path ? { docId: view.docId() ?? "", path, pageId } : null;
	}

	/** Whether page `index` (0-based) of the notebook in view is bookmarked. */
	isBookmarkedAt(view: BookmarksViewApi, index: number): boolean {
		const id = view.pageIds()[index];
		const ref = id ? this.ref(view, id) : null;
		return !!ref && this.deps.store.find(ref) !== null;
	}

	/** Bookmarks the page in view, or removes its bookmark when it has one. */
	async toggle(view: BookmarksViewApi): Promise<void> {
		const cur = view.current();
		const ref = cur ? this.ref(view, cur.pageId) : null;
		if (!cur || !ref) return;
		const there = this.deps.store.find(ref);
		try {
			if (there) {
				await this.deps.store.remove(there.id);
				showNotice(t("gbm.removed"));
			} else {
				await this.deps.store.add({ ...ref, num: cur.index + 1, label: cur.title });
				showNotice(t("gbm.added"));
			}
		} catch (e) {
			this.fail(e);
		}
	}

	remove(id: string): Promise<void> {
		return this.deps.store.remove(id).catch((e) => this.fail(e));
	}

	rename(id: string, label: string): Promise<void> {
		return this.deps.store.rename(id, label).catch((e) => this.fail(e));
	}

	move(id: string, to: number): Promise<void> {
		return this.deps.store.move(id, to).catch((e) => this.fail(e));
	}

	/**
	 * The notebook file of a bookmark: the file at its path, else (a notebook moved where no rename was seen, e.g. by
	 * another app or on another device before it synced) the notebook with the same id.
	 */
	async fileOf(b: GlobalBookmark): Promise<TFile | null> {
		const direct = this.deps.app.vault.getFileByPath(b.path);
		if (direct && isNotebookFile(direct)) return direct;
		if (!b.docId) return null;
		for (const file of listNotebooks(this.deps.app, this.deps.notebooksFolder())) {
			if ((await this.deps.readNotebookId(file).catch(() => null)) === b.docId) {
				void this.deps.store.retarget(b.path, file.path).catch((e) => this.fail(e));
				return file;
			}
		}
		return null;
	}

	/** What each bookmark points at now: the page (with its number and title), a notebook whose page is gone, or no notebook. */
	async inspect(list: readonly GlobalBookmark[]): Promise<Map<string, BookmarkStatus>> {
		const out = new Map<string, BookmarkStatus>();
		const docs = new Map<string, NotebookDocument | null>();
		for (const b of list) {
			const file = await this.fileOf(b);
			if (!file) {
				out.set(b.id, { kind: "notebook-gone" });
				continue;
			}
			if (!docs.has(file.path)) docs.set(file.path, await this.deps.readNotebook(file).catch(() => null));
			const doc = docs.get(file.path) ?? null;
			if (!doc) {
				out.set(b.id, { kind: "notebook-gone" });
				continue;
			}
			const target = resolveBookmark(b, doc.pages.map((p) => p.id));
			if (target.kind === "gone") out.set(b.id, { kind: "page-gone", file });
			else out.set(b.id, { kind: "page", file, index: target.index, title: doc.meta?.bookmarkInfo?.[b.pageId]?.title?.trim() ?? "" });
		}
		return out;
	}

	/** A tap on a bookmark: opens its notebook at its page (the nearest page when the page is gone). */
	async open(b: GlobalBookmark): Promise<void> {
		const file = await this.fileOf(b);
		if (!file) {
			showNotice(t("gbm.missing", { path: b.path }), 6000);
			return;
		}
		await (this.deps.openAt ? this.deps.openAt(file, b.num, b.pageId) : openNotebookAtPage(this.deps.app, file, b.num, null, b.pageId));
	}

	private fail(e: unknown): void {
		if (e instanceof BookmarksBlockedError) {
			showNotice(t("gbm.blocked", { error: e.message }), 8000);
			return;
		}
		console.error("[notebook] bookmarks", e);
		showNotice(t("gbm.saveFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
	}
}
