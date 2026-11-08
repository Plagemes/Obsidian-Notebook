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
import { BookmarkResolver } from "../library/bookmark-resolve";
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
		// A file that changed may carry another notebook id now.
		const forget = (file: unknown) => {
			if (file instanceof TFile) this.idAt.delete(file.path);
		};
		plugin.registerEvent(vault.on("create", forget));
		plugin.registerEvent(vault.on("modify", forget));
		plugin.registerEvent(vault.on("delete", forget));
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
			this.idAt.delete(oldPath);
			this.idAt.delete(file.path);
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

	/** The notebook id found at a path (null: could not be read), as far as it has been looked at; dropped when the file changes. */
	private readonly idAt = new Map<string, string | null>();

	/**
	 * Whether the file at `path` is still the notebook `docId`: false when there is no notebook file there, or when it is known to carry another id (a
	 * different notebook now sits at the old path). An id not looked at yet counts as the same notebook.
	 */
	private readonly pathHolds = (path: string, docId: string): boolean => {
		const f = this.deps.app.vault.getFileByPath(path);
		if (!f || !isNotebookFile(f)) return false;
		const id = this.idAt.get(path);
		return id === undefined || id === null || id === docId;
	};

	/** Reads the id of the notebooks at the other paths this page is bookmarked under, so `pathHolds` knows them. True when something new was learnt. */
	private async prime(ref: { docId: string; path: string; pageId: string }): Promise<boolean> {
		if (!ref.docId) return false;
		const paths = new Set(this.deps.store.list().filter((b) => b.docId === ref.docId && b.pageId === ref.pageId && b.path !== ref.path && !this.idAt.has(b.path)).map((b) => b.path));
		let learnt = false;
		for (const path of paths) {
			const f = this.deps.app.vault.getFileByPath(path);
			if (!f || !isNotebookFile(f)) continue;
			this.idAt.set(path, await this.deps.readNotebookId(f).catch(() => null));
			learnt = true;
		}
		return learnt;
	}

	/** One look-up session (a dialog open, one tap): each notebook's id is read at most once, whatever the number of bookmarks. */
	newResolver(): BookmarkResolver<TFile> {
		return new BookmarkResolver<TFile>({
			fileAt: (path) => {
				const f = this.deps.app.vault.getFileByPath(path);
				return f && isNotebookFile(f) ? f : null;
			},
			notebooks: () => listNotebooks(this.deps.app, this.deps.notebooksFolder()),
			idOf: (file) => this.deps.readNotebookId(file),
		});
	}

	private ref(view: BookmarksViewApi, pageId: string): { docId: string; path: string; pageId: string } | null {
		const path = view.path();
		return path ? { docId: view.docId() ?? "", path, pageId } : null;
	}

	/** Whether page `index` (0-based) of the notebook in view is bookmarked. */
	isBookmarkedAt(view: BookmarksViewApi, index: number): boolean {
		const id = view.pageIds()[index];
		const ref = id ? this.ref(view, id) : null;
		if (!ref) return false;
		void this.prime(ref).then((learnt) => learnt && this.changed()).catch(() => undefined);
		return this.deps.store.find(ref, this.pathHolds) !== null;
	}

	/** 0.25 (#419): the ids of the pages of the notebook in view that have a global bookmark (read-only; used by the navigator's marked-pages filter). */
	bookmarkedPageIds(view: BookmarksViewApi): Set<string> {
		const out = new Set<string>();
		for (const id of view.pageIds()) {
			const ref = this.ref(view, id);
			if (ref && this.deps.store.find(ref, this.pathHolds) !== null) out.add(id);
		}
		return out;
	}

	/** Bookmarks the page in view, or removes its bookmark when it has one. */
	async toggle(view: BookmarksViewApi): Promise<void> {
		const cur = view.current();
		const ref = cur ? this.ref(view, cur.pageId) : null;
		if (!cur || !ref) return;
		await this.prime(ref).catch(() => false);
		const there = this.deps.store.find(ref, this.pathHolds);
		try {
			if (there) {
				await this.deps.store.remove(there.id);
				showNotice(t("gbm.removed"));
			} else {
				await this.deps.store.add({ ...ref, num: cur.index + 1, label: cur.title }, this.pathHolds);
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
	 * What each bookmark points at now: the page (with its number and title), a notebook whose page is gone, or no notebook. Only looks: it never
	 * moves a bookmark (a notebook that has not synced yet must not lose its bookmarks to a copy). Pass the same `resolver` for the whole dialog session
	 * so the notebooks are read once, not at every refresh.
	 */
	async inspect(list: readonly GlobalBookmark[], resolver: BookmarkResolver<TFile> = this.newResolver()): Promise<Map<string, BookmarkStatus>> {
		const out = new Map<string, BookmarkStatus>();
		const docs = new Map<string, NotebookDocument | null>();
		for (const b of list) {
			const file = (await resolver.resolve(b))?.file ?? null;
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

	/**
	 * A tap on a bookmark: opens its notebook at its page (the nearest page when the page is gone). A notebook found by its id (its path is out of date) is
	 * followed by the bookmark, but only when exactly one notebook carries that id: with a copy around there is no telling which one is the notebook.
	 */
	async open(b: GlobalBookmark): Promise<void> {
		const found = await this.newResolver().resolve(b);
		if (!found) {
			showNotice(t("gbm.missing", { path: b.path }), 6000);
			return;
		}
		const file = found.file;
		if (found.byId && found.unique) void this.deps.store.retarget(b.path, file.path, b.docId).catch((e) => this.fail(e));
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
