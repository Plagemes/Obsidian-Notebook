import {
	getLanguage, ItemView, Menu, normalizePath, Notice, setIcon, TFile, TFolder, Vault,
	type TAbstractFile, type ViewStateResult, type WorkspaceLeaf,
} from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { NotebookDocument, NotebookMeta, Page } from "../model/types";
import { isNotebookFile } from "../storage/format";
import { sanitizeName } from "../storage/notebooks";
import { attachPress, DROP_ATTR } from "./drag";
import { breadcrumb, buildFolderTree, flattenTree, isReservedPath, type FolderNode } from "./folders";
import { relativeTime, uniquePath } from "./format";
import { folderOf, isInside, LibraryIndex, SORTS, type Highlight, type LibraryEntry, type LibraryScope, type LibrarySort, type SearchHit } from "./index";
import { ConfirmModal, CoverModal, FolderSuggestModal, PromptModal, TagsModal } from "./library-modals";
import { entryFromFile, filesToRead, type NotebookFileInfo } from "./scan";
import { renderThumbnail, type ThumbnailOptions } from "./thumbnail";

export const LIBRARY_VIEW_TYPE = "notebook-library";

/** What the library needs from the plugin. */
export interface LibraryHost {
	/** Notebooks folder path. */
	root(): string;
	/** Parsed document, or null if the file cannot be read. */
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	/** Opens the notebook; `pageIndex` (0-based) is the page to show, e.g. for a search hit. */
	openNotebook(file: TFile, pageIndex?: number): Promise<void>;
	/** Opens the "New notebook" dialog for that folder. */
	createNotebook(folder: string): void;
	/** Opens the PDF import flow for that folder. */
	importPdf(folder: string): void;
	/** Opens "New lecture from slides…" (course PDF, layout, header) for that folder. */
	lectureFromSlides?(folder: string): void;
	/** Scans pages with the camera into a new notebook in that folder. */
	scanToNotebook?(folder: string): void;
	/** Opens the loose sheet (quick notes), creating it the first time. */
	openLooseSheet?(): void;
	/** Writes metadata into the notebook (routed through an open view if there is one). */
	updateMeta(file: TFile, patch: Partial<NotebookMeta>): Promise<void>;
	/** Loads what a page shows under the ink (PDF page, image) so the cover can draw it. Null if there is none. */
	thumbnailBackground?(doc: NotebookDocument, page: Page, width: number): Promise<ThumbnailOptions["drawBackground"] | null>;
	/** Called after the library copied a notebook, so the copy can get its own identity. */
	afterDuplicate?(file: TFile): Promise<void>;
	loadIndex(): Promise<unknown>;
	saveIndex(data: unknown): Promise<void>;
}

/** Below this width of the view the sidebar becomes a drawer. */
const NARROW_PX = 680;
const THUMB_WIDTH = 320;
const SAVE_DELAY_MS = 2000;
/** Saves of an open notebook come often: wait for it to settle before reading it again. */
const MODIFY_DELAY_MS = 3000;
const STRUCTURE_DELAY_MS = 300;

const tick = (ms = 0) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function sameScope(a: LibraryScope, b: LibraryScope): boolean {
	if (typeof a === "string" || typeof b === "string") return a === b;
	if ("folder" in a && "folder" in b) return a.folder === b.folder;
	if ("tag" in a && "tag" in b) return a.tag.toLowerCase() === b.tag.toLowerCase();
	return false;
}

function parseScope(v: unknown): LibraryScope {
	if (v === "all" || v === "favorites" || v === "recent") return v;
	if (typeof v === "object" && v !== null) {
		const o = v as { folder?: unknown; tag?: unknown };
		if (typeof o.folder === "string") return { folder: o.folder };
		if (typeof o.tag === "string") return { tag: o.tag };
	}
	return "all";
}

export class LibraryView extends ItemView {
	private index = new LibraryIndex();
	private place: LibraryScope = "all";
	private sort: LibrarySort = "modified";
	private search = "";
	/** Search the whole library (true) or only the current view (false); null = automatic (everywhere in "All notebooks"). */
	private searchWide: boolean | null = null;
	private sidebarCollapsed = false;
	private narrow = false;
	private drawerOpen = false;
	private readonly expanded = new Set<string>();

	private built = false;
	private closed = false;
	private rootEl!: HTMLElement;
	private sidebarEl!: HTMLElement;
	private crumbEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private scopeEl!: HTMLButtonElement;
	private sortEl!: HTMLSelectElement;
	private observer: IntersectionObserver | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private readonly cards = new Map<string, HTMLElement>();

	private renderQueued = false;
	private saveTimer = 0;
	private reconcileTimer = 0;
	private reconcileAt = 0;
	private reconciling = false;
	private reconcileAgain = false;
	private dirty = false;
	private searchTimer = 0;

	private readonly thumbQueue: string[] = [];
	private readonly thumbPending = new Set<string>();
	private readonly thumbFailed = new Set<string>();
	private thumbRunning = false;

	constructor(leaf: WorkspaceLeaf, private readonly host: LibraryHost) {
		super(leaf);
	}

	getViewType(): string {
		return LIBRARY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t("library.title");
	}

	getIcon(): string {
		return "library";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), scope: this.place, sort: this.sort };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (typeof state === "object" && state !== null) {
			const s = state as { scope?: unknown; sort?: unknown };
			this.place = parseScope(s.scope);
			if (SORTS.includes(s.sort as LibrarySort)) this.sort = s.sort as LibrarySort;
			if (this.built) {
				this.sortEl.value = this.sort;
				this.requestRender();
			}
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("notebook-lib");
		try {
			this.index = LibraryIndex.fromJSON(await this.host.loadIndex());
		} catch (e) {
			console.error("[notebook] library index unreadable, rebuilding", e);
		}
		this.buildShell();
		this.built = true;
		this.expanded.add(this.root());
		this.render();

		const vault = this.app.vault;
		this.registerEvent(vault.on("create", (f) => this.onVaultChange(f)));
		this.registerEvent(vault.on("modify", (f) => this.onVaultChange(f, MODIFY_DELAY_MS)));
		this.registerEvent(vault.on("delete", (f) => this.onVaultDelete(f)));
		this.registerEvent(vault.on("rename", (f, oldPath) => this.onVaultRename(f, oldPath)));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.revealed()));

		void this.reconcile(true);
	}

	async onClose(): Promise<void> {
		this.closed = true;
		window.clearTimeout(this.saveTimer);
		window.clearTimeout(this.reconcileTimer);
		window.clearTimeout(this.searchTimer);
		this.observer?.disconnect();
		this.resizeObserver?.disconnect();
		this.thumbQueue.length = 0;
		try {
			await this.host.saveIndex(this.index.toJSON());
		} catch (e) {
			console.error("[notebook] saving the library index failed", e);
		}
	}

	// ---------------------------------------------------------------- shell

	private root(): string {
		const p = normalizePath(this.host.root() || "/");
		return p === "/" ? "" : p;
	}

	private rootLabel(): string {
		const root = this.root();
		return root === "" ? t("library.root") : root.slice(root.lastIndexOf("/") + 1);
	}

	private buildShell(): void {
		const el = this.contentEl;
		el.empty();
		this.rootEl = el.createDiv({ cls: "notebook-lib-root" });
		this.sidebarEl = this.rootEl.createEl("aside", { cls: "notebook-lib-sidebar" });
		this.rootEl.createDiv({ cls: "notebook-lib-backdrop" }).addEventListener("click", () => this.setDrawer(false));

		const main = this.rootEl.createDiv({ cls: "notebook-lib-main" });
		const bar = main.createDiv({ cls: "notebook-lib-bar" });
		const toggle = bar.createEl("button", { cls: "notebook-lib-icon-btn clickable-icon", attr: { "aria-label": t("library.sidebar.toggle"), title: t("library.sidebar.toggle") } });
		setIcon(toggle, "panel-left");
		toggle.addEventListener("click", () => {
			if (this.narrow) this.setDrawer(!this.drawerOpen);
			else {
				this.sidebarCollapsed = !this.sidebarCollapsed;
				this.applyLayout();
			}
		});
		this.crumbEl = bar.createEl("nav", { cls: "notebook-lib-crumbs", attr: { "aria-label": t("library.breadcrumb") } });
		this.statusEl = bar.createDiv({ cls: "notebook-lib-status", attr: { "aria-live": "polite" } });

		const tools = main.createDiv({ cls: "notebook-lib-tools" });
		this.searchEl = tools.createEl("input", {
			cls: "notebook-lib-search",
			attr: { type: "search", placeholder: t("library.search.placeholder"), "aria-label": t("library.search.label"), enterkeyhint: "search" },
		});
		this.searchEl.addEventListener("input", () => {
			window.clearTimeout(this.searchTimer);
			this.searchTimer = window.setTimeout(() => {
				this.search = this.searchEl.value;
				this.requestRender();
			}, 150);
		});
		this.searchEl.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && this.searchEl.value) {
				e.preventDefault();
				e.stopPropagation();
				this.searchEl.value = "";
				this.search = "";
				this.requestRender();
			}
		});
		this.scopeEl = tools.createEl("button", { cls: "notebook-lib-search-scope", attr: { type: "button", "aria-label": t("library.search.scope") } });
		this.scopeEl.addEventListener("click", () => {
			this.searchWide = !this.searchesWide();
			this.requestRender();
		});
		this.sortEl = tools.createEl("select", { cls: "dropdown notebook-lib-sort", attr: { "aria-label": t("library.sort.label"), title: t("library.sort.label") } });
		for (const s of SORTS) this.sortEl.createEl("option", { value: s, text: t(`library.sort.${s}` as MessageKey) });
		this.sortEl.value = this.sort;
		this.sortEl.addEventListener("change", () => {
			this.sort = this.sortEl.value as LibrarySort;
			this.app.workspace.requestSaveLayout();
			this.requestRender();
		});
		const actions = tools.createDiv({ cls: "notebook-lib-actions" });
		this.actionButton(actions, "file-plus", t("library.action.newNotebook"), () => this.host.createNotebook(this.currentFolder()), true);
		this.actionButton(actions, "folder-plus", t("library.action.newFolder"), () => this.askNewFolder(this.currentFolder()));
		this.actionButton(actions, "file-up", t("library.action.importPdf"), () => this.host.importPdf(this.currentFolder()));
		if (this.host.lectureFromSlides) this.actionButton(actions, "graduation-cap", t("library.action.lectureFromSlides"), () => this.host.lectureFromSlides?.(this.currentFolder()));
		if (this.host.scanToNotebook) this.actionButton(actions, "scan", t("library.action.scanNotebook"), () => this.host.scanToNotebook?.(this.currentFolder()));
		if (this.host.openLooseSheet) this.actionButton(actions, "sticky-note", t("library.action.looseSheet"), () => this.host.openLooseSheet?.());

		this.scrollEl = main.createDiv({ cls: "notebook-lib-scroll" });
		this.gridEl = this.scrollEl.createDiv({ cls: "notebook-lib-content" });

		this.observer = new IntersectionObserver((records) => this.onIntersect(records), { root: this.scrollEl, rootMargin: "240px 0px" });
		this.resizeObserver = new ResizeObserver(() => {
			const w = this.contentEl.clientWidth;
			if (w === 0) return;
			const narrow = w < NARROW_PX;
			if (narrow !== this.narrow) {
				this.narrow = narrow;
				this.drawerOpen = false;
			}
			this.applyLayout();
			if (this.dirty) void this.reconcile();
		});
		this.resizeObserver.observe(this.contentEl);
		this.narrow = this.contentEl.clientWidth > 0 && this.contentEl.clientWidth < NARROW_PX;
		this.applyLayout();
	}

	private actionButton(parent: HTMLElement, icon: string, label: string, onClick: () => void, primary = false): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "notebook-lib-btn", attr: { "aria-label": label, title: label } });
		if (primary) b.addClass("mod-cta");
		setIcon(b.createSpan({ cls: "notebook-lib-btn-icon" }), icon);
		b.createSpan({ cls: "notebook-lib-btn-label", text: label });
		b.addEventListener("click", onClick);
		return b;
	}

	private applyLayout(): void {
		const r = this.rootEl;
		r.toggleClass("is-narrow", this.narrow);
		r.toggleClass("is-sidebar-hidden", !this.narrow && this.sidebarCollapsed);
		r.toggleClass("is-drawer-open", this.narrow && this.drawerOpen);
	}

	private setDrawer(open: boolean): void {
		this.drawerOpen = open;
		this.applyLayout();
	}

	private setStatus(done: number, total: number): void {
		this.statusEl.setText(total >= 3 && done < total ? t("library.status.indexing", { done: String(done), total: String(total) }) : "");
	}

	// -------------------------------------------------------------- vault

	private notebookFiles(): TFile[] {
		const root = this.root();
		const folder = root === "" ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(root);
		if (!folder) return [];
		const out: TFile[] = [];
		Vault.recurseChildren(folder, (f) => {
			if (f instanceof TFile && isNotebookFile(f) && !isReservedPath(f.path, root)) out.push(f);
		});
		return out;
	}

	private folderPaths(): string[] {
		const root = this.root();
		const folder = root === "" ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(root);
		if (!folder) return [];
		const out: string[] = [];
		Vault.recurseChildren(folder, (f) => {
			if (f instanceof TFolder && !f.isRoot() && !isReservedPath(f.path, root)) out.push(f.path);
		});
		return out;
	}

	private tree(): FolderNode {
		return buildFolderTree(this.root(), this.folderPaths());
	}

	private inLibrary(path: string): boolean {
		const root = this.root();
		return isInside(path, root) && path !== root && !isReservedPath(path, root);
	}

	private onVaultChange(f: TAbstractFile, delay = STRUCTURE_DELAY_MS): void {
		if (f instanceof TFile && !isNotebookFile(f)) return;
		if (!this.inLibrary(f.path)) return;
		this.scheduleReconcile(delay);
		if (f instanceof TFolder) this.requestRender();
	}

	private onVaultDelete(f: TAbstractFile): void {
		if (f instanceof TFile) {
			if (this.index.remove(f.path)) this.afterIndexChange();
		} else {
			this.index.prune(this.index.all().filter((e) => !isInside(e.path, f.path)).map((e) => e.path));
			this.afterIndexChange();
		}
		this.scheduleReconcile(STRUCTURE_DELAY_MS);
	}

	private onVaultRename(f: TAbstractFile, oldPath: string): void {
		if (f instanceof TFile) {
			if (isNotebookFile(f)) {
				if (this.inLibrary(f.path)) this.index.rename(oldPath, f.path);
				else this.index.remove(oldPath);
			}
		} else {
			this.index.renameFolder(oldPath, f.path);
			if (typeof this.place === "object" && "folder" in this.place && isInside(this.place.folder, oldPath)) {
				this.place = { folder: f.path + this.place.folder.slice(oldPath.length) };
			}
			if (this.expanded.delete(oldPath)) this.expanded.add(f.path);
		}
		this.afterIndexChange();
		this.scheduleReconcile(STRUCTURE_DELAY_MS);
	}

	private afterIndexChange(): void {
		this.requestRender();
		this.scheduleSave();
	}

	private scheduleReconcile(delay: number): void {
		const at = Date.now() + delay;
		if (this.reconcileTimer && this.reconcileAt <= at) return;
		window.clearTimeout(this.reconcileTimer);
		this.reconcileAt = at;
		this.reconcileTimer = window.setTimeout(() => {
			this.reconcileTimer = 0;
			void this.reconcile();
		}, delay);
	}

	/** The view became visible again: catch up with what changed meanwhile. */
	private revealed(): void {
		if (this.dirty && this.contentEl.isShown()) void this.reconcile();
	}

	/** Brings the index in line with the vault: forget deleted files, read new and changed ones. */
	private async reconcile(force = false): Promise<void> {
		if (this.closed) return;
		if (this.reconciling) {
			this.reconcileAgain = true;
			return;
		}
		if (!force && !this.contentEl.isShown()) {
			this.dirty = true;
			return;
		}
		this.reconciling = true;
		try {
			do {
				this.reconcileAgain = false;
				this.dirty = false;
				const files = this.notebookFiles();
				const infos = new Map<string, NotebookFileInfo>(files.map((f) => [f.path, { path: f.path, mtime: f.stat.mtime, size: f.stat.size }]));
				let changed = this.index.prune(infos.keys()).length > 0;
				const todo = filesToRead([...infos.values()], this.index);
				// Show new notebooks at once, by name; the marker mtime makes them stale until read.
				for (const info of todo) {
					if (!this.index.has(info.path)) {
						this.index.upsert({ ...entryFromFile(info, null), mtime: -1, size: -1 });
						changed = true;
					}
				}
				if (changed) this.afterIndexChange();
				let done = 0;
				for (const info of todo) {
					if (this.closed) return;
					this.setStatus(done, todo.length);
					const file = this.app.vault.getFileByPath(info.path);
					if (file) {
						let doc: NotebookDocument | null = null;
						try {
							doc = await this.host.readNotebook(file);
						} catch (e) {
							console.error("[notebook] library could not read", info.path, e);
						}
						if (this.closed) return;
						this.index.upsert(entryFromFile(info, doc, this.index.get(info.path)));
					}
					done++;
					if (done % 8 === 0) {
						this.afterIndexChange();
						await tick();
					}
				}
				if (todo.length > 0) this.afterIndexChange();
			} while (this.reconcileAgain && !this.closed);
		} finally {
			this.reconciling = false;
			this.setStatus(0, 0);
		}
	}

	private scheduleSave(): void {
		if (this.closed) return;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.host.saveIndex(this.index.toJSON()).catch((e) => console.error("[notebook] saving the library index failed", e));
		}, SAVE_DELAY_MS);
	}

	// ------------------------------------------------------------- thumbnails

	private onIntersect(records: IntersectionObserverEntry[]): void {
		for (const r of records) {
			if (!r.isIntersecting) continue;
			const card = r.target as HTMLElement;
			this.observer?.unobserve(card);
			const path = card.dataset.path;
			const entry = path ? this.index.get(path) : undefined;
			if (!path || !entry) continue;
			this.fillCover(card, entry);
			this.requestThumb(entry);
		}
	}

	private requestThumb(entry: LibraryEntry): void {
		const key = `${entry.path}@${entry.mtime}`;
		if (this.thumbPending.has(entry.path) || this.thumbFailed.has(key) || !this.index.needsThumb(entry.path)) return;
		this.thumbPending.add(entry.path);
		this.thumbQueue.push(entry.path);
		void this.runThumbs();
	}

	private async runThumbs(): Promise<void> {
		if (this.thumbRunning) return;
		this.thumbRunning = true;
		try {
			while (this.thumbQueue.length > 0 && !this.closed) {
				const path = this.thumbQueue.shift()!;
				const entry = this.index.get(path);
				const file = this.app.vault.getFileByPath(path);
				if (entry && file && entry.mtime >= 0 && this.index.needsThumb(path)) {
					try {
						const doc = await this.host.readNotebook(file);
						const page = doc?.pages[0];
						const drawBackground = doc && page ? await this.host.thumbnailBackground?.(doc, page, THUMB_WIDTH) : null;
						const thumb = page ? renderThumbnail(page, THUMB_WIDTH, { drawBackground: drawBackground ?? undefined, mime: "image/jpeg", quality: 0.82 }) : "";
						if (thumb) {
							this.index.patch(path, { thumb, thumbMtime: entry.mtime });
							const next = this.index.get(path);
							const card = this.cards.get(path);
							if (next && card) this.fillCover(card, next);
							this.scheduleSave();
						} else {
							this.thumbFailed.add(`${path}@${entry.mtime}`);
						}
					} catch (e) {
						console.error("[notebook] thumbnail failed", path, e);
						this.thumbFailed.add(`${path}@${entry.mtime}`);
					}
				}
				this.thumbPending.delete(path);
				await tick(8);
			}
		} finally {
			this.thumbRunning = false;
		}
	}

	private fillCover(card: HTMLElement, entry: LibraryEntry): void {
		const page = card.querySelector<HTMLElement>(".notebook-lib-page");
		if (!page) return;
		page.empty();
		if (entry.thumb) {
			page.createEl("img", { attr: { src: entry.thumb, alt: "", draggable: "false", decoding: "async" } });
		} else {
			setIcon(page.createDiv({ cls: "notebook-lib-page-empty" }), "file-text");
		}
	}

	// ------------------------------------------------------------- rendering

	private requestRender(): void {
		if (this.renderQueued || !this.built || this.closed) return;
		this.renderQueued = true;
		window.requestAnimationFrame(() => {
			this.renderQueued = false;
			if (!this.closed) this.render();
		});
	}

	/** Falls back to "all" / the root when the folder or tag of the current scope no longer exists. */
	private fixScope(): void {
		const s = this.place;
		if (typeof s === "object" && "folder" in s) {
			const known = s.folder === this.root() || this.app.vault.getFolderByPath(s.folder);
			if (!known) this.place = "all";
		} else if (typeof s === "object" && "tag" in s) {
			const tag = s.tag.toLowerCase();
			if (!this.index.tags().some((x) => x.tag.toLowerCase() === tag)) this.place = "all";
		}
	}

	private render(): void {
		this.fixScope();
		const focus = this.contentEl.ownerDocument.activeElement instanceof HTMLElement && this.contentEl.contains(this.contentEl.ownerDocument.activeElement)
			? this.contentEl.ownerDocument.activeElement.dataset.key
			: undefined;
		const tree = this.tree();
		this.renderSidebar(tree);
		this.renderBreadcrumb();
		this.renderGrid(tree);
		if (focus) {
			for (const el of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-key]"))) {
				if (el.dataset.key === focus) {
					el.focus({ preventScroll: true });
					break;
				}
			}
		}
	}

	private currentFolder(): string {
		return typeof this.place === "object" && "folder" in this.place ? this.place.folder : this.root();
	}

	private navigate(scope: LibraryScope): void {
		this.place = scope;
		this.searchWide = null;
		if (typeof scope === "object" && "folder" in scope) {
			// Make the folder visible in the tree.
			let p = scope.folder;
			while (p !== "" && p.length > this.root().length) {
				p = folderOf(p);
				this.expanded.add(p);
			}
		}
		if (this.narrow) this.drawerOpen = false;
		this.applyLayout();
		this.app.workspace.requestSaveLayout();
		this.render();
		this.scrollEl.scrollTop = 0;
	}

	private navItem(parent: HTMLElement, o: { icon: string; label: string; count?: number; scope: LibraryScope; key: string; dropFolder?: string }): HTMLElement {
		const active = sameScope(this.place, o.scope);
		const b = parent.createEl("button", { cls: "notebook-lib-nav-item", attr: { "data-key": o.key } });
		b.toggleClass("is-active", active);
		if (active) b.setAttribute("aria-current", "page");
		setIcon(b.createSpan({ cls: "notebook-lib-nav-icon" }), o.icon);
		b.createSpan({ cls: "notebook-lib-nav-label", text: o.label });
		if (o.count !== undefined) b.createSpan({ cls: "notebook-lib-nav-count", text: String(o.count) });
		b.addEventListener("click", () => this.navigate(o.scope));
		return b;
	}

	private folderCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		const root = this.root();
		for (const e of this.index.all()) {
			let p = e.folder;
			for (;;) {
				counts.set(p, (counts.get(p) ?? 0) + 1);
				if (p === root || p === "") break;
				p = folderOf(p);
			}
		}
		return counts;
	}

	private renderSidebar(tree: FolderNode): void {
		const el = this.sidebarEl;
		el.empty();
		const close = el.createEl("button", { cls: "notebook-lib-drawer-close clickable-icon", attr: { "aria-label": t("library.sidebar.close"), title: t("library.sidebar.close") } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.setDrawer(false));

		const favorites = this.index.all().filter((e) => e.favorite).length;
		const nav = el.createEl("nav", { cls: "notebook-lib-nav" });
		this.navItem(nav, { icon: "library", label: t("library.nav.all"), count: this.index.size, scope: "all", key: "nav:all" });
		this.navItem(nav, { icon: "star", label: t("library.nav.favorites"), count: favorites, scope: "favorites", key: "nav:favorites" });
		this.navItem(nav, { icon: "clock", label: t("library.nav.recent"), scope: "recent", key: "nav:recent" });

		el.createDiv({ cls: "notebook-lib-section", text: t("library.nav.folders") });
		const counts = this.folderCounts();
		const treeEl = el.createDiv({ cls: "notebook-lib-tree", attr: { role: "tree" } });
		const walk = (node: FolderNode, depth: number) => {
			const hasChildren = node.children.length > 0;
			const open = this.expanded.has(node.path);
			const row = treeEl.createDiv({ cls: "notebook-lib-tree-row", attr: { role: "treeitem", [DROP_ATTR]: node.path, "aria-expanded": hasChildren ? String(open) : "" } });
			if (!hasChildren) row.removeAttribute("aria-expanded");
			row.setCssProps({ "--notebook-depth": String(depth) });
			if (hasChildren) {
				const tg = row.createEl("button", { cls: "notebook-lib-tree-toggle clickable-icon", attr: { "aria-label": t("library.folder.toggle"), "data-key": `toggle:${node.path}` } });
				setIcon(tg, open ? "chevron-down" : "chevron-right");
				tg.addEventListener("click", () => {
					if (open) this.expanded.delete(node.path);
					else this.expanded.add(node.path);
					this.render();
				});
			} else {
				row.createSpan({ cls: "notebook-lib-tree-toggle is-spacer" });
			}
			this.navItem(row, {
				icon: open && hasChildren ? "folder-open" : "folder",
				label: node.path === this.root() ? this.rootLabel() : node.name,
				count: counts.get(node.path) ?? 0,
				scope: { folder: node.path },
				key: `folder:${node.path}`,
			});
			attachPress({ el: row, onMenu: (x, y) => this.folderMenu(node.path, x, y) });
			if (open) node.children.forEach((c) => walk(c, depth + 1));
		};
		walk(tree, 0);

		el.createDiv({ cls: "notebook-lib-section", text: t("library.nav.tags") });
		const tags = this.index.tags();
		if (tags.length === 0) {
			el.createDiv({ cls: "notebook-lib-hint", text: t("library.nav.noTags") });
		} else {
			const list = el.createDiv({ cls: "notebook-lib-nav" });
			for (const { tag, count } of tags) {
				this.navItem(list, { icon: "tag", label: tag, count, scope: { tag }, key: `tag:${tag}` });
			}
		}
	}

	private renderBreadcrumb(): void {
		const el = this.crumbEl;
		el.empty();
		const s = this.place;
		if (typeof s === "object" && "folder" in s) {
			const parts = breadcrumb(this.root(), s.folder);
			parts.forEach((part, i) => {
				if (i > 0) el.createSpan({ cls: "notebook-lib-crumb-sep", text: "›", attr: { "aria-hidden": "true" } });
				const label = part.path === this.root() ? this.rootLabel() : part.name;
				if (i === parts.length - 1) {
					el.createSpan({ cls: "notebook-lib-crumb is-current", text: label, attr: { "aria-current": "page" } });
				} else {
					const b = el.createEl("button", { cls: "notebook-lib-crumb", text: label, attr: { [DROP_ATTR]: part.path } });
					b.addEventListener("click", () => this.navigate({ folder: part.path }));
				}
			});
			return;
		}
		const title = s === "all" ? t("library.nav.all") : s === "favorites" ? t("library.nav.favorites") : s === "recent" ? t("library.nav.recent") : `#${s.tag}`;
		el.createSpan({ cls: "notebook-lib-crumb is-current", text: title, attr: { "aria-current": "page" } });
	}

	private searchesWide(): boolean {
		return this.searchWide ?? this.place === "all";
	}

	private updateScopeButton(searching: boolean): void {
		const show = searching && this.place !== "all";
		this.scopeEl.toggleClass("is-hidden", !show);
		if (!show) return;
		const wide = this.searchesWide();
		this.scopeEl.setText(wide ? t("library.search.everywhere") : typeof this.place === "object" && "folder" in this.place ? t("library.search.thisFolder") : t("library.search.thisView"));
		this.scopeEl.setAttribute("aria-pressed", String(wide));
		this.scopeEl.setAttribute("title", t("library.search.scope"));
	}

	private renderGrid(tree: FolderNode): void {
		const el = this.gridEl;
		el.empty();
		this.observer?.disconnect();
		this.cards.clear();
		const searching = this.search.trim().length > 0;
		this.updateScopeButton(searching);
		if (searching) {
			const place: LibraryScope = typeof this.place === "object" && "folder" in this.place ? { folder: this.place.folder, recursive: true } : this.place;
			const hits = this.index.search({ search: this.search, scope: this.searchesWide() ? "all" : place, sort: this.sort });
			if (hits.length === 0) {
				this.renderEmpty(el, true);
				return;
			}
			const grid = el.createDiv({ cls: "notebook-lib-grid is-search", attr: { role: "list" } });
			const now = Date.now();
			for (const hit of hits) this.notebookCard(grid, hit.entry, now, hit);
			return;
		}
		const scope: LibraryScope = typeof this.place === "object" && "folder" in this.place ? { folder: this.place.folder, recursive: false } : this.place;
		const entries = this.index.query({ scope, sort: this.sort });
		const folder = typeof this.place === "object" && "folder" in this.place ? this.place.folder : null;
		const subfolders = folder !== null ? (flattenTree(tree).find((n) => n.path === folder)?.children ?? []) : [];

		if (entries.length === 0 && subfolders.length === 0) {
			this.renderEmpty(el, searching);
			return;
		}
		const grid = el.createDiv({ cls: "notebook-lib-grid", attr: { role: "list" } });
		const counts = this.folderCounts();
		for (const node of subfolders) this.folderCard(grid, node, counts.get(node.path) ?? 0);
		const now = Date.now();
		for (const entry of entries) this.notebookCard(grid, entry, now);
	}

	private renderEmpty(el: HTMLElement, searching: boolean): void {
		const box = el.createDiv({ cls: "notebook-lib-empty" });
		const s = this.place;
		let title: string;
		let body = "";
		let actions = false;
		if (searching) {
			title = t("library.empty.search", { query: this.search.trim() });
		} else if (this.index.size === 0 && (s === "all" || (typeof s === "object" && "folder" in s))) {
			title = t("library.empty.noneTitle");
			body = t("library.empty.noneBody");
			actions = true;
		} else if (s === "favorites") {
			title = t("library.empty.favorites");
		} else if (s === "recent") {
			title = t("library.empty.recent");
		} else if (typeof s === "object" && "tag" in s) {
			title = t("library.empty.tag");
		} else {
			title = t("library.empty.folder");
			actions = typeof s === "object" && "folder" in s;
		}
		setIcon(box.createDiv({ cls: "notebook-lib-empty-icon" }), searching ? "search-x" : "library");
		box.createDiv({ cls: "notebook-lib-empty-title", text: title });
		if (body) box.createDiv({ cls: "notebook-lib-empty-body", text: body });
		if (actions) {
			const row = box.createDiv({ cls: "notebook-lib-empty-actions" });
			this.actionButton(row, "file-plus", t("library.action.newNotebook"), () => this.host.createNotebook(this.currentFolder()), true);
			this.actionButton(row, "file-up", t("library.action.importPdf"), () => this.host.importPdf(this.currentFolder()));
		}
	}

	private plural(count: number, one: MessageKey, many: MessageKey): string {
		return count === 1 ? t(one) : t(many, { count: String(count) });
	}

	private folderCard(grid: HTMLElement, node: FolderNode, count: number): void {
		const card = grid.createDiv({ cls: "notebook-lib-card is-folder", attr: { role: "listitem", [DROP_ATTR]: node.path } });
		const main = card.createDiv({ cls: "notebook-lib-card-main", attr: { role: "button", tabindex: "0", "data-key": `fcard:${node.path}`, "aria-label": node.name } });
		setIcon(main.createDiv({ cls: "notebook-lib-folder-cover" }), "folder");
		main.createDiv({ cls: "notebook-lib-title", text: node.name, attr: { title: node.name } });
		main.createDiv({ cls: "notebook-lib-meta", text: this.plural(count, "library.notebooks.one", "library.notebooks.many") });
		const go = () => this.navigate({ folder: node.path });
		main.addEventListener("click", go);
		this.cardKeys(main, go);
		attachPress({ el: main, onMenu: (x, y) => this.folderMenu(node.path, x, y) });
	}

	/** Appends `h.text` with the highlighted ranges as <mark> nodes (no HTML parsing). */
	private appendHighlight(parent: HTMLElement, h: Highlight): void {
		let pos = 0;
		for (const [a, b] of h.ranges) {
			if (a > pos) parent.appendText(h.text.slice(pos, a));
			parent.createEl("mark", { text: h.text.slice(a, b) });
			pos = b;
		}
		if (pos < h.text.length) parent.appendText(h.text.slice(pos));
	}

	private notebookCard(grid: HTMLElement, entry: LibraryEntry, now: number, hit?: SearchHit): void {
		const card = grid.createDiv({ cls: "notebook-lib-card", attr: { role: "listitem" } });
		card.dataset.path = entry.path;
		const placeholder = entry.mtime < 0;
		const meta = placeholder ? "" : entry.pages === 0 ? t("library.unreadable") : `${this.plural(entry.pages, "library.pages.one", "library.pages.many")} · ${relativeTime(entry.modified, now, getLanguage())}`;
		const main = card.createDiv({ cls: "notebook-lib-card-main", attr: { role: "button", tabindex: "0", "data-key": `card:${entry.path}`, "aria-label": [entry.name, meta].filter(Boolean).join(", ") } });
		const cover = main.createDiv({ cls: "notebook-lib-cover" });
		cover.setCssProps({ "--notebook-cover": entry.cover });
		cover.createDiv({ cls: "notebook-lib-spine" });
		cover.createDiv({ cls: "notebook-lib-page" });
		const titleEl = main.createDiv({ cls: "notebook-lib-title", attr: { title: entry.name } });
		if (hit?.title) this.appendHighlight(titleEl, hit.title);
		else titleEl.setText(entry.name);
		main.createDiv({ cls: "notebook-lib-meta", text: meta });
		if (hit) {
			if (hit.tag) this.appendHighlight(main.createDiv({ cls: "notebook-lib-hit-tag" }), { text: `#${hit.tag.text}`, ranges: hit.tag.ranges.map(([a, b]): [number, number] => [a + 1, b + 1]) });
		} else if (entry.tags.length > 0) main.createDiv({ cls: "notebook-lib-card-tags", text: entry.tags.map((x) => `#${x}`).join(" ") });

		const star = card.createEl("button", {
			cls: "notebook-lib-star clickable-icon",
			attr: { "aria-pressed": String(entry.favorite), "aria-label": entry.favorite ? t("library.favorite.remove") : t("library.favorite.add"), title: entry.favorite ? t("library.favorite.remove") : t("library.favorite.add"), "data-key": `star:${entry.path}` },
		});
		star.toggleClass("is-on", entry.favorite);
		setIcon(star, "star");
		star.addEventListener("click", () => void this.toggleFavorite(entry.path));
		const more = card.createEl("button", { cls: "notebook-lib-more clickable-icon", attr: { "aria-label": t("library.menu.more"), title: t("library.menu.more"), "data-key": `more:${entry.path}` } });
		setIcon(more, "more-vertical");
		more.addEventListener("click", (e) => this.notebookMenu(entry.path, e.clientX, e.clientY, more));

		const textHit = hit?.text;
		const open = () => this.openEntry(entry.path, hit?.fields[0] === "text" ? textHit?.page : undefined);
		if (textHit) {
			const row = card.createDiv({
				cls: "notebook-lib-hit",
				attr: { role: "button", tabindex: "0", "data-key": `hit:${entry.path}`, "aria-label": t("library.search.openPage", { page: String(textHit.page + 1) }) },
			});
			row.createSpan({ cls: "notebook-lib-hit-page", text: t("library.search.page", { page: String(textHit.page + 1) }) });
			this.appendHighlight(row.createSpan({ cls: "notebook-lib-hit-snippet" }), textHit.snippet);
			const openPage = () => this.openEntry(entry.path, textHit.page);
			row.addEventListener("click", openPage);
			row.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openPage();
				}
			});
		}
		main.addEventListener("click", open);
		this.cardKeys(main, open);
		attachPress({
			el: main,
			onMenu: (x, y) => this.notebookMenu(entry.path, x, y),
			startDrag: () => {
				if (this.narrow) this.setDrawer(true);
				return createDiv({ cls: "notebook-lib-ghost", text: entry.name });
			},
			canDrop: (target) => target.getAttribute(DROP_ATTR) !== (this.index.get(entry.path)?.folder ?? ""),
			onDrop: (target) => {
				const file = this.app.vault.getFileByPath(entry.path);
				const folder = target.getAttribute(DROP_ATTR);
				if (file && folder !== null) void this.moveFile(file, folder);
			},
			onDragEnd: () => {
				if (this.narrow) this.setDrawer(false);
			},
		});

		this.cards.set(entry.path, card);
		this.observer?.observe(card);
	}

	/** Enter/Space activate; arrows move between cards. */
	private cardKeys(main: HTMLElement, activate: () => void): void {
		main.addEventListener("keydown", (e) => {
			if (e.target !== main) return;
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				activate();
				return;
			}
			const cards = Array.from(this.gridEl.querySelectorAll<HTMLElement>(".notebook-lib-card-main"));
			const i = cards.indexOf(main);
			let next: HTMLElement | undefined;
			if (e.key === "ArrowRight") next = cards[i + 1];
			else if (e.key === "ArrowLeft") next = cards[i - 1];
			else if (e.key === "Home") next = cards[0];
			else if (e.key === "End") next = cards[cards.length - 1];
			else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				const r = main.getBoundingClientRect();
				const down = e.key === "ArrowDown";
				const candidates = cards.filter((c) => {
					const cr = c.getBoundingClientRect();
					return down ? cr.top > r.bottom - 4 : cr.bottom < r.top + 4;
				});
				const row = down ? candidates[0] : candidates[candidates.length - 1];
				if (row) {
					const rowTop = row.getBoundingClientRect().top;
					const sameRow = candidates.filter((c) => Math.abs(c.getBoundingClientRect().top - rowTop) < 4);
					next = sameRow.reduce((best, c) => (Math.abs(c.getBoundingClientRect().left - r.left) < Math.abs(best.getBoundingClientRect().left - r.left) ? c : best), sameRow[0]!);
				}
			} else return;
			e.preventDefault();
			next?.focus();
			next?.scrollIntoView({ block: "nearest" });
		});
	}

	// --------------------------------------------------------------- actions

	private openEntry(path: string, pageIndex?: number): void {
		const file = this.app.vault.getFileByPath(path);
		if (file) void this.host.openNotebook(file, pageIndex);
	}

	private fail(e: unknown): void {
		console.error("[notebook] library", e);
		new Notice(t("library.notice.failed", { error: (e as Error).message ?? String(e) }));
	}

	private async setMeta(path: string, patch: Partial<NotebookMeta>): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		const before = this.index.get(path);
		if (!file || !before) return;
		const local: Partial<LibraryEntry> = {};
		if (patch.tags) local.tags = patch.tags;
		if (patch.favorite !== undefined) local.favorite = patch.favorite;
		if (patch.cover) local.cover = patch.cover;
		this.index.patch(path, local);
		this.afterIndexChange();
		try {
			await this.host.updateMeta(file, patch);
		} catch (e) {
			this.index.patch(path, { tags: before.tags, favorite: before.favorite, cover: before.cover });
			this.afterIndexChange();
			this.fail(e);
		}
	}

	private toggleFavorite(path: string): Promise<void> {
		return this.setMeta(path, { favorite: !this.index.get(path)?.favorite });
	}

	private notebookMenu(path: string, x: number, y: number, anchor?: HTMLElement): void {
		const entry = this.index.get(path);
		const file = this.app.vault.getFileByPath(path);
		if (!entry || !file) return;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("library.menu.open")).setIcon("book-open").onClick(() => this.openEntry(path)));
		menu.addItem((i) =>
			i.setTitle(entry.favorite ? t("library.favorite.remove") : t("library.favorite.add")).setIcon("star").onClick(() => void this.toggleFavorite(path)),
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t("library.menu.rename")).setIcon("pencil").onClick(() => this.askRename(file)));
		menu.addItem((i) => i.setTitle(t("library.menu.move")).setIcon("folder-input").onClick(() => this.askMove(file)));
		menu.addItem((i) => i.setTitle(t("library.menu.duplicate")).setIcon("copy").onClick(() => void this.duplicate(file)));
		menu.addItem((i) => i.setTitle(t("library.menu.tags")).setIcon("tag").onClick(() => this.askTags(path)));
		menu.addItem((i) => i.setTitle(t("library.menu.cover")).setIcon("palette").onClick(() => this.askCover(path)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t("library.menu.delete")).setIcon("trash-2").setWarning(true).onClick(() => this.askDelete(file)));
		if (anchor) {
			const r = anchor.getBoundingClientRect();
			menu.showAtPosition({ x: r.left, y: r.bottom });
		} else {
			menu.showAtPosition({ x, y });
		}
	}

	private folderMenu(path: string, x: number, y: number): void {
		const isRoot = path === this.root();
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("library.menu.newNotebookHere")).setIcon("file-plus").onClick(() => this.host.createNotebook(path)));
		menu.addItem((i) => i.setTitle(t("library.menu.newFolderHere")).setIcon("folder-plus").onClick(() => this.askNewFolder(path)));
		menu.addItem((i) => i.setTitle(t("library.menu.importPdfHere")).setIcon("file-up").onClick(() => this.host.importPdf(path)));
		if (this.host.lectureFromSlides) menu.addItem((i) => i.setTitle(t("library.menu.lectureFromSlidesHere")).setIcon("graduation-cap").onClick(() => this.host.lectureFromSlides?.(path)));
		if (this.host.scanToNotebook) menu.addItem((i) => i.setTitle(t("library.menu.scanHere")).setIcon("scan").onClick(() => this.host.scanToNotebook?.(path)));
		if (!isRoot) {
			menu.addSeparator();
			menu.addItem((i) => i.setTitle(t("library.menu.renameFolder")).setIcon("pencil").onClick(() => this.askRenameFolder(path)));
			menu.addItem((i) => i.setTitle(t("library.menu.deleteFolder")).setIcon("trash-2").setWarning(true).onClick(() => this.askDeleteFolder(path)));
		}
		menu.showAtPosition({ x, y });
	}

	private joinPath(dir: string, name: string): string {
		return normalizePath(dir === "" ? name : `${dir}/${name}`);
	}

	private exists(path: string): boolean {
		return !!this.app.vault.getAbstractFileByPath(path);
	}

	private askRename(file: TFile): void {
		new PromptModal(this.app, { title: t("library.modal.renameNotebook"), label: t("library.modal.name"), value: file.basename, cta: t("library.modal.save") }, (value) => {
			const name = sanitizeName(value);
			if (!name) return void new Notice(t("library.notice.invalidName"));
			if (name === file.basename) return;
			const target = this.joinPath(folderOf(file.path), `${name}.${file.extension}`);
			if (this.exists(target)) return void new Notice(t("library.notice.exists", { name }));
			this.app.fileManager.renameFile(file, target).catch((e) => this.fail(e));
		}).open();
	}

	private askMove(file: TFile): void {
		const root = this.root();
		const choices = flattenTree(this.tree())
			.filter((n) => n.path !== file.parent?.path && !(n.path === "" && file.parent?.isRoot()))
			.map((n) => ({ path: n.path, label: n.path === root ? this.rootLabel() : root === "" ? n.path : n.path.slice(root.length + 1) }));
		new FolderSuggestModal(this.app, choices, (c) => void this.moveFile(file, c.path)).open();
	}

	private async moveFile(file: TFile, folder: string): Promise<void> {
		if (folderOf(file.path) === folder) return;
		try {
			const target = uniquePath(folder, file.basename, file.extension, (p) => this.exists(normalizePath(p)));
			await this.app.fileManager.renameFile(file, normalizePath(target));
		} catch (e) {
			this.fail(e);
		}
	}

	private async duplicate(file: TFile): Promise<void> {
		try {
			const target = uniquePath(folderOf(file.path), `${file.basename} copy`, file.extension, (p) => this.exists(normalizePath(p)));
			const copy = await this.app.vault.copy(file, normalizePath(target));
			await this.host.afterDuplicate?.(copy);
		} catch (e) {
			this.fail(e);
		}
	}

	private askDelete(file: TFile): void {
		new ConfirmModal(
			this.app,
			{ title: t("library.modal.deleteTitle"), body: t("library.modal.deleteBody", { name: file.basename }), cta: t("library.modal.deleteConfirm") },
			() => void this.app.fileManager.trashFile(file).catch((e) => this.fail(e)),
		).open();
	}

	private askTags(path: string): void {
		const entry = this.index.get(path);
		if (!entry) return;
		new TagsModal(this.app, entry.tags, this.index.tags().map((x) => x.tag), (tags) => void this.setMeta(path, { tags })).open();
	}

	private askCover(path: string): void {
		const entry = this.index.get(path);
		if (!entry) return;
		new CoverModal(this.app, entry.cover, (cover) => void this.setMeta(path, { cover })).open();
	}

	private askNewFolder(parent: string): void {
		new PromptModal(this.app, { title: t("library.modal.newFolder"), label: t("library.modal.name"), cta: t("library.modal.create") }, (value) => {
			const name = sanitizeName(value);
			if (!name) return void new Notice(t("library.notice.invalidName"));
			const path = this.joinPath(parent, name);
			if (this.exists(path)) return void new Notice(t("library.notice.exists", { name }));
			this.app.vault.createFolder(path).then(() => {
				this.expanded.add(parent);
				this.navigate({ folder: path });
			}).catch((e) => this.fail(e));
		}).open();
	}

	private askRenameFolder(path: string): void {
		const folder = this.app.vault.getFolderByPath(path);
		if (!folder) return;
		new PromptModal(this.app, { title: t("library.modal.renameFolder"), label: t("library.modal.name"), value: folder.name, cta: t("library.modal.save") }, (value) => {
			const name = sanitizeName(value);
			if (!name) return void new Notice(t("library.notice.invalidName"));
			if (name === folder.name) return;
			const target = this.joinPath(folderOf(path), name);
			if (this.exists(target)) return void new Notice(t("library.notice.exists", { name }));
			this.app.fileManager.renameFile(folder, target).catch((e) => this.fail(e));
		}).open();
	}

	private askDeleteFolder(path: string): void {
		const folder = this.app.vault.getFolderByPath(path);
		if (!folder) return;
		if (folder.children.length > 0) {
			new Notice(t("library.notice.folderNotEmpty", { name: folder.name }));
			return;
		}
		new ConfirmModal(
			this.app,
			{ title: t("library.modal.deleteFolderTitle"), body: t("library.modal.deleteFolderBody", { name: folder.name }), cta: t("library.modal.deleteConfirm") },
			() => void this.app.fileManager.trashFile(folder).catch((e) => this.fail(e)),
		).open();
	}
}
