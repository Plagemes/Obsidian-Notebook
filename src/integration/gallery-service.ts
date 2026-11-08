/**
 * 0.26 gallery (#421): what the `notebook-gallery` blocks read from the vault. One instance for the whole plugin; it does nothing
 * until a block (or the builder) asks, keeps the library index it needs in memory only (nothing is written, not even the index
 * file), and tells the open blocks when the notebooks changed (debounced, after the pen is quiet).
 */
import { TFile, type App, type EventRef } from "obsidian";
import { writing } from "../ink/writing-guard";
import { LibraryIndex, type LibraryEntry } from "../library/index";
import { entryFromFile, filesToRead } from "../library/scan";
import type { GlobalBookmark } from "../library/bookmarks";
import type { NotebookDocument } from "../model/types";
import { isNotebookFile } from "../storage/format";
import { listNotebooks } from "../storage/notebooks";
import type { Timetable } from "../timetable/schedule";
import { linkCovers } from "../timetable/schedule";
import { notebookPagesOf, type GalleryContext, type NotebookPages } from "./gallery-query";

/** What a gallery block needs; the harness supplies a fake. */
export interface GalleryData {
	entries(): Promise<LibraryEntry[]>;
	context(): GalleryContext;
	pagesOf(entry: LibraryEntry): Promise<NotebookPages | null>;
	/** Timetable courses and page tags in use, for the builder. */
	courses(): string[];
	tags(): Promise<string[]>;
	/** Calls `fn` when the indexed notebooks, the bookmarks or the timetable changed. Returns the unsubscribe. */
	onChange(fn: () => void): () => void;
}

export interface GalleryServiceDeps {
	app: App;
	root(): string;
	loadIndex(): Promise<unknown>;
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	timetable(): Timetable | null | undefined;
	bookmarks(): readonly GlobalBookmark[];
	onBookmarksChange?(fn: () => void): () => void;
}

const DEBOUNCE_MS = 900;
const DOCS_MAX = 3;

export class GalleryService implements GalleryData {
	private index = new LibraryIndex();
	private loaded = false;
	private running: Promise<void> | null = null;
	private fresh = false;
	private readonly listeners = new Set<() => void>();
	private readonly docs = new Map<string, NotebookDocument | null>();
	private timer: number | null = null;
	private refs: EventRef[] = [];
	private stopBookmarks: (() => void) | null = null;

	constructor(private readonly deps: GalleryServiceDeps) {}

	// ---------------------------------------------------------------------------------------------------- reading

	async entries(): Promise<LibraryEntry[]> {
		if (!this.fresh) await this.refresh();
		return this.index.all();
	}

	private refresh(): Promise<void> {
		this.running ??= this.run().finally(() => (this.running = null));
		return this.running;
	}

	private async run(): Promise<void> {
		const { app } = this.deps;
		if (!this.loaded) {
			this.loaded = true;
			try {
				this.index = LibraryIndex.fromJSON(await this.deps.loadIndex());
			} catch {
				this.index = new LibraryIndex();
			}
		}
		const files = listNotebooks(app, this.deps.root());
		this.index.prune(files.map((f) => f.path));
		for (const info of filesToRead(files.map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })), this.index)) {
			await writing.idle();
			const file = app.vault.getFileByPath(info.path);
			const doc = file ? await this.deps.readNotebook(file).catch(() => null) : null;
			this.index.upsert(entryFromFile(info, doc, this.index.get(info.path)));
			await new Promise<void>((r) => window.setTimeout(r, 0));
		}
		this.fresh = true;
	}

	async pagesOf(entry: LibraryEntry): Promise<NotebookPages | null> {
		const key = `${entry.path}@${entry.mtime}`;
		let doc = this.docs.get(key);
		if (doc === undefined) {
			const file = this.deps.app.vault.getFileByPath(entry.path);
			doc = file ? await this.deps.readNotebook(file).catch(() => null) : null;
			this.docs.set(key, doc);
			if (this.docs.size > DOCS_MAX) this.docs.delete(this.docs.keys().next().value as string);
		}
		if (!doc) return null;
		return notebookPagesOf({ pages: doc.pages, bookmarks: doc.meta?.bookmarks }, this.deps.bookmarks().filter((b) => b.path === entry.path).map((b) => b.pageId));
	}

	context(): GalleryContext {
		const tt = this.deps.timetable();
		const marks = this.deps.bookmarks();
		return {
			courseOf: (path) => (tt ? tt.entries.filter((e) => linkCovers(e.notebook, path)).map((e) => e.course) : []),
			globalBookmarks: (path) => marks.filter((b) => b.path === path).map((b) => ({ pageId: b.pageId, num: b.num })),
		};
	}

	courses(): string[] {
		const seen = new Map<string, string>();
		for (const e of this.deps.timetable()?.entries ?? []) if (e.course && !seen.has(e.course.toLowerCase())) seen.set(e.course.toLowerCase(), e.course);
		return [...seen.values()].sort((a, b) => a.localeCompare(b));
	}

	async tags(): Promise<string[]> {
		const counts = new Map<string, { tag: string; n: number }>();
		for (const e of await this.entries()) {
			for (const p of e.pageTags ?? []) {
				for (const tag of p.tags) {
					const c = counts.get(tag.toLowerCase());
					if (c) c.n++;
					else counts.set(tag.toLowerCase(), { tag, n: 1 });
				}
			}
		}
		return [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map((c) => c.tag);
	}

	// --------------------------------------------------------------------------------------------------- changes

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		if (this.listeners.size === 1) this.watch();
		return () => {
			this.listeners.delete(fn);
			if (this.listeners.size === 0) this.unwatch();
		};
	}

	/** Vault and bookmark events are listened to only while some block is on screen. */
	private watch(): void {
		const { vault } = this.deps.app;
		const touched = (f: unknown) => {
			if (f instanceof TFile && isNotebookFile(f)) this.changed();
		};
		this.refs = [
			vault.on("modify", touched), vault.on("create", touched), vault.on("delete", touched),
			// A renamed notebook, or a folder of notebooks: the notebooks are listed from the vault again on the next look.
			vault.on("rename", () => this.changed()),
		];
		this.stopBookmarks = this.deps.onBookmarksChange?.(() => this.notify()) ?? null;
	}

	private unwatch(): void {
		for (const r of this.refs) this.deps.app.vault.offref(r);
		this.refs = [];
		this.stopBookmarks?.();
		this.stopBookmarks = null;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private changed(): void {
		this.fresh = false;
		this.docs.clear();
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void writing.idle().then(() => this.notify());
		}, DEBOUNCE_MS);
	}

	private notify(): void {
		for (const fn of [...this.listeners]) fn();
	}

	/** Plugin unload: stops listening. */
	dispose(): void {
		this.listeners.clear();
		this.unwatch();
	}
}
