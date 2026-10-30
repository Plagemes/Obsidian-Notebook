import { Notice, SuggestModal, type App, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { openNotebookAtPage } from "../integration/open";
import { LibraryIndex, type LibraryEntry } from "../library/index";
import { renderThumbnail, type ThumbnailOptions } from "../library/thumbnail";
import { entryFromFile, filesToRead } from "../library/scan";
import { searchPages, type PageHit } from "../library/page-search";
import { listNotebooks } from "../storage/notebooks";
import type { NotebookDocument, Page } from "../model/types";
import { formatAgo, type RecentPagesService } from "./recent-pages";
import type { RecentItem } from "../library/recent-log";

/** What the quick switcher needs from the plugin host. */
export interface QuickNavHost {
	root(): string;
	loadIndex(): Promise<unknown>;
	/** Saves the library index (the library's own file): entries read here are not read again next session. */
	saveIndex?(data: unknown): Promise<void>;
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	thumbnailBackground(doc: NotebookDocument, page: Page, width: number): Promise<ThumbnailOptions["drawBackground"] | null>;
}

const THUMB_WIDTH = 72;
const THUMB_CACHE = 80;

/** The library index, loaded once from the saved cache and brought up to date a few notebooks at a time. */
class PageDirectory {
	index = new LibraryIndex();
	private loaded = false;
	private running: Promise<void> | null = null;

	constructor(private readonly app: App, private readonly host: QuickNavHost) {}

	refresh(progress: (done: number, total: number) => void): Promise<void> {
		this.running ??= this.run(progress).finally(() => (this.running = null));
		return this.running;
	}

	private async run(progress: (done: number, total: number) => void): Promise<void> {
		if (!this.loaded) {
			this.loaded = true;
			try {
				this.index = LibraryIndex.fromJSON(await this.host.loadIndex());
			} catch {
				this.index = new LibraryIndex();
			}
		}
		const files = listNotebooks(this.app, this.host.root());
		this.index.prune(files.map((f) => f.path));
		const todo = filesToRead(files.map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })), this.index);
		let done = 0;
		const updated: LibraryEntry[] = [];
		for (const info of todo) {
			const file = this.app.vault.getFileByPath(info.path);
			const doc = file ? await this.host.readNotebook(file) : null;
			const entry = entryFromFile(info, doc, this.index.get(info.path));
			this.index.upsert(entry);
			updated.push(entry);
			progress(++done, todo.length);
			await new Promise<void>((r) => window.setTimeout(r, 0));
		}
		if (updated.length > 0) await this.save(updated);
	}

	/**
	 * Review: what was read goes into the library index file, so the next session does not read every notebook again.
	 * Merged into the file as it is now (the library view may have saved meanwhile); an index of a newer plugin version
	 * is never saved over.
	 */
	private async save(updated: LibraryEntry[]): Promise<void> {
		const saveIndex = this.host.saveIndex?.bind(this.host);
		if (!saveIndex || this.index.keepsNewerVersion) return;
		try {
			const onDisk = LibraryIndex.fromJSON(await this.host.loadIndex());
			if (onDisk.keepsNewerVersion) return;
			for (const entry of updated) {
				const have = onDisk.get(entry.path);
				// The library view may have a newer thumbnail of the same version of the file: keep it.
				const thumb = have && have.mtime === entry.mtime && have.thumb !== undefined ? { thumb: have.thumb, thumbMtime: have.thumbMtime } : {};
				onDisk.upsert({ ...entry, ...thumb });
			}
			await saveIndex(onDisk.toJSON());
		} catch (e) {
			console.error("[notebook] saving the library index failed", e);
		}
	}
}

/** Page thumbnails, drawn on demand one at a time (never while the modal is closed) and kept in a small cache. */
class PageThumbs {
	private readonly cache = new Map<string, string>();
	private queue: Array<() => Promise<void>> = [];
	private busy = false;
	private generation = 0;
	private lastDoc: { key: string; doc: NotebookDocument | null } | null = null;

	constructor(private readonly app: App, private readonly host: QuickNavHost, private readonly dir: PageDirectory) {}

	cancel(): void {
		this.generation++;
		this.queue = [];
		this.lastDoc = null;
	}

	request(hit: PageHit, img: HTMLImageElement): void {
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) return;
		const key = `${hit.path}|${file.stat.mtime}|${hit.page}`;
		const hitCache = this.cache.get(key);
		if (hitCache) {
			img.src = hitCache;
			return;
		}
		const entry = this.dir.index.get(hit.path);
		if (hit.page === 0 && entry?.thumb && entry.thumbMtime === entry.mtime) {
			img.src = entry.thumb;
			return;
		}
		const gen = this.generation;
		this.queue.push(async () => {
			if (gen !== this.generation) return;
			const url = await this.draw(file, hit.page);
			if (gen !== this.generation || !url) return;
			this.cache.set(key, url);
			if (this.cache.size > THUMB_CACHE) this.cache.delete(this.cache.keys().next().value as string);
			img.src = url;
		});
		void this.pump();
	}

	private async pump(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			for (let job = this.queue.shift(); job; job = this.queue.shift()) {
				try {
					await job();
				} catch {
					// a thumbnail is decoration: a page that cannot be drawn just has none
				}
				await new Promise<void>((r) => window.setTimeout(r, 16));
			}
		} finally {
			this.busy = false;
		}
	}

	private async draw(file: TFile, index: number): Promise<string | null> {
		const key = `${file.path}|${file.stat.mtime}`;
		if (this.lastDoc?.key !== key) this.lastDoc = { key, doc: await this.host.readNotebook(file) };
		const doc = this.lastDoc.doc;
		const page = doc?.pages[index];
		if (!doc || !page) return null;
		const bg = await this.host.thumbnailBackground(doc, page, THUMB_WIDTH).catch(() => null);
		const url = renderThumbnail(page, THUMB_WIDTH, { drawBackground: bg ?? undefined, mime: "image/jpeg", quality: 0.6 });
		return url || null;
	}
}

export class QuickNavService {
	readonly dir: PageDirectory;
	readonly thumbs: PageThumbs;

	constructor(readonly app: App, readonly host: QuickNavHost, readonly recent: RecentPagesService) {
		this.dir = new PageDirectory(app, host);
		this.thumbs = new PageThumbs(app, host, this.dir);
	}
}

/** Roadmap 364: "Go to page…". Name, page number (12 or p12), bookmark titles, page tags and text of every notebook. */
export class PageSwitcherModal extends SuggestModal<PageHit> {
	private readonly recents = new WeakMap<PageHit, RecentItem>();
	private status: HTMLElement;

	constructor(private readonly svc: QuickNavService) {
		super(svc.app);
		this.setPlaceholder(t("quicknav.placeholder"));
		this.emptyStateText = t("quicknav.empty");
		this.status = this.modalEl.createDiv({ cls: "notebook-quicknav-status" });
		this.modalEl.insertBefore(this.status, this.modalEl.querySelector(".prompt-results"));
		this.setInstructions([{ command: "12", purpose: t("quicknav.hint.page") }]);
	}

	onOpen(): void {
		void super.onOpen();
		void this.svc.dir.refresh((done, total) => {
			this.status.setText(done < total ? t("quicknav.indexing", { done: String(done), total: String(total) }) : "");
			if (done % 8 === 0 || done === total) this.inputEl.dispatchEvent(new Event("input"));
		}).then(() => {
			this.status.setText("");
			this.inputEl.dispatchEvent(new Event("input"));
		}).catch((e) => console.error("[notebook] page index refresh failed", e));
	}

	onClose(): void {
		this.svc.thumbs.cancel();
		super.onClose();
	}

	getSuggestions(query: string): PageHit[] {
		if (!query.trim()) {
			return this.svc.recent.items().slice(0, 20).map((item) => {
				const hit: PageHit = { path: item.path, name: item.path.slice(item.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""), page: item.num - 1, kind: "recent", score: 0, detail: formatAgo(item.at), modified: item.at };
				this.recents.set(hit, item);
				return hit;
			});
		}
		return searchPages(this.svc.dir.index.all(), query);
	}

	renderSuggestion(hit: PageHit, el: HTMLElement): void {
		el.addClass("notebook-quicknav-row");
		const img = el.createEl("img", { cls: "notebook-quicknav-thumb", attr: { alt: "", width: String(36) } });
		this.svc.thumbs.request(hit, img);
		const body = el.createDiv({ cls: "notebook-quicknav-body" });
		const top = body.createDiv({ cls: "notebook-quicknav-top" });
		top.createSpan({ cls: "notebook-quicknav-name", text: hit.name });
		top.createSpan({ cls: "notebook-quicknav-page", text: t("quicknav.page", { n: String(hit.page + 1) }) });
		const kind = hit.kind === "bookmark" ? t("quicknav.kind.bookmark") : hit.kind === "tag" ? t("quicknav.kind.tag") : hit.kind === "text" ? t("quicknav.kind.text") : "";
		const detail = [kind, hit.detail].filter(Boolean).join(": ");
		if (detail) body.createDiv({ cls: "notebook-quicknav-detail", text: detail });
	}

	onChooseSuggestion(hit: PageHit): void {
		const recent = this.recents.get(hit);
		if (recent) {
			void this.svc.recent.open(recent);
			return;
		}
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) {
			new Notice(t("quicknav.notebookGone"));
			return;
		}
		void openNotebookAtPage(this.app, file, hit.page + 1);
	}
}

export function openPageSwitcher(svc: QuickNavService): void {
	new PageSwitcherModal(svc).open();
}

export function registerQuickSwitcher(plugin: Plugin, svc: QuickNavService): void {
	plugin.addCommand({ id: "go-to-page", name: t("command.goToPage"), callback: () => openPageSwitcher(svc) });
}
