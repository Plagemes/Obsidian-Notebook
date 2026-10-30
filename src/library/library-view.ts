import { getLanguage, ItemView, Menu, normalizePath, Platform, Scope, setIcon, TFile, TFolder, Vault, type TAbstractFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { NotebookDocument, NotebookMeta, Page } from "../model/types";
import { isNotebookFile } from "../storage/format";
import { sanitizeName } from "../storage/notebooks";
import { attachPress, DROP_ATTR, DROP_CARD_ATTR } from "./drag";
import { breadcrumb, buildFolderTree, flattenTree, isReservedPath, type FolderNode } from "./folders";
import { relativeTime, uniquePath } from "./format";
import { folderOf, isInside, LibraryIndex, normalizeText, SORTS, type Highlight, type LibraryEntry, type LibraryScope, type LibrarySort, type SearchHit } from "./index";
import { openTagEditor } from "../integration/tags";
import { ConfirmModal, CoverModal, FolderSuggestModal, PromptModal } from "./library-modals";
import { arrangeEntries, planMove, type LibraryMap, type LibraryOp } from "./library-state";
import { LibraryStateBlockedError, type LibraryStateStore } from "./library-state-store";
import { entryFromFile, filesToRead, type NotebookFileInfo } from "./scan";
import { folderContents, type LibraryTrash } from "../storage/trash";
import { confirmMoveToTrash, FolderToTrashModal, TrashModal } from "./trash-modal";
import { writing } from "../ink/writing-guard";
import { renderThumbnail, type ThumbnailOptions } from "./thumbnail";
import { showNotice } from "../view/notice";
import { colorFor, SUBJECT_COLORS } from "../ui/palette";
import { artImage, artStyleFor, coverImage, folderIconSvg, type ArtStyle } from "../ui/art/generative-art";
import type { FolderMeta } from "./folder-meta";
import { iconButton, svgDataUrl } from "../ui/components/dom";
import { filterChips, type FilterChip } from "../ui/components/chip";
import { listRow, type ListRowOptions, type Pill } from "../ui/components/list-row";
import { railBrand, railItem, railLabel } from "../ui/components/nav-rail";
import { searchPill } from "../ui/components/search-pill";
import { sectionHeader } from "../ui/components/section-header";
import { subjectCard, type SubjectCardOptions } from "../ui/components/subject-card";
import type { FavouriteRowOptions } from "../ui/components/favourite-row";
import type { KpiTileOptions } from "../ui/components/kpi-tile";
import type { QuickActionOptions } from "../ui/components/quick-action";
import {
	collectionsOf, deltaPercent, inCollection, stampTime, STAT_PERIODS, statsOf, subjectsOf, topFolderOf,
	type CollectionContext, type CollectionId, type KpiId, type StatPeriod, type Subject,
} from "./dashboard";
import { renderHome } from "./home-surface";
import { renderLibrarySections, renderTagChips, type TagChip } from "./library-sections";
import { InboxBell, type InboxPort } from "./inbox-bell";

/** The missing-styles diagnostic (LibraryView.checkStyles) is shown once per session. */
let stylesWarned = false;

export const LIBRARY_VIEW_TYPE = "notebook-library";

/** The read API of the folder metadata (library/folder-meta-store.ts) that the cards use. */
export interface FolderMetaSource {
	getFolderMeta(path: string): FolderMeta | null;
	onFolderMetaChange(fn: () => void): () => void;
}

/** What the library needs from the plugin. */
export interface LibraryHost {
	/** Notebooks folder path. */
	root(): string;
	/** Parsed document, or null if the file cannot be read. */
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	/** Opens the notebook; `pageIndex` (0-based) is the page to show, e.g. for a search hit. */
	openNotebook(file: TFile, pageIndex?: number): Promise<void>;
	/** Opens the creation dialog (view/create-dialog.ts) on its Notebook tab, in that folder. */
	createNotebook(folder: string): void;
	/** Opens the creation dialog on its Folder tab, with that folder as the location. */
	createFolder(parent: string): void;
	/** wave 0.12: the folders' colour, icon, description and art style (library/folder-meta-store.ts); absent: from the name. */
	folderMeta?: FolderMetaSource;
	/** Opens the PDF import flow for that folder. */
	importPdf(folder: string): void;
	/** Opens "New lecture from slides…" (course PDF, layout, header) for that folder. */
	lectureFromSlides?(folder: string): void;
	/** Scans pages with the camera into a new notebook in that folder. */
	scanToNotebook?(folder: string): void;
	/** Opens the loose sheet (quick notes), creating it the first time. */
	openLooseSheet?(): void;
	/** Class in progress according to the timetable (wave 0.6), for the "Now: <course>" shortcut. */
	nowClass?(): { course: string; room?: string } | null;
	openNowClass?(): void;
	/** Called when the library opens (offers the class in progress). */
	libraryOpened?(): void;
	/** Writes metadata into the notebook (routed through an open view if there is one). */
	updateMeta(file: TFile, patch: Partial<NotebookMeta>): Promise<void>;
	/** Loads what a page shows under the ink (PDF page, image) so the cover can draw it. Null if there is none. */
	thumbnailBackground?(doc: NotebookDocument, page: Page, width: number): Promise<ThumbnailOptions["drawBackground"] | null>;
	/** Called after the library copied a notebook, so the copy can get its own identity. */
	afterDuplicate?(file: TFile): Promise<void>;
	/** Library trash (#160): deleting moves to the plugin trash instead of deleting. */
	trash?: LibraryTrash;
	/** wave 0.7: opens the list of recently edited pages (roadmap 365). */
	openRecentPages?(): void;
	/** Roadmap 54: pinned, archived and manual order, kept per device in `_meta` (library/library-state.ts). */
	state?: LibraryStateStore;
	/** The notebook's document id from the start of its file (no full parse), or null. */
	readNotebookId?(file: TFile): Promise<string | null>;
	/** Roadmap 27: opens the library check (unreadable notebooks, unused files). */
	checkLibrary?(): void;
	loadIndex(): Promise<unknown>;
	saveIndex(data: unknown): Promise<void>;
	/** 0.12: runs a plugin-level action of the registry (ui/actions.ts) by id; false when it has no handler. */
	runAction?(id: string): boolean;
	/** 0.12: opens the plugin's settings tab. */
	openSettings?(): void;
	/** 0.12: this device's recently edited pages, newest first (the recent pages log, roadmap 365). */
	recentEdits?(): Array<{ path: string; page: string; num: number; at: number }>;
	/** 0.12: the Zettelkasten Inbox for the header bell; null when the feature is not available. */
	inbox?(): InboxPort | null;
}

/**
 * 0.12: where the view is. The library's scopes, plus Home, the subjects page, the tags page and a smart collection.
 * Home and the library are two surfaces of one view, so they share one index, one reading pass and one thumbnail queue.
 */
export type LibraryPlace = LibraryScope | "home" | "subjects" | "tags" | { collection: CollectionId };

/** Width classes (DESIGN.md §5): phone (rail as a sheet), tablet portrait (icon rail), wide tablet and desktop (full rail). */
type WidthMode = "phone" | "medium" | "wide";
const PHONE_PX = 600;
const WIDE_PX = 1100;
const THUMB_WIDTH = 320;
const SAVE_DELAY_MS = 2000;
/** Saves of an open notebook come often: wait for it to settle before reading it again. */
const MODIFY_DELAY_MS = 3000;
/** Looking again this soon after finding the pen on the screen. */
const QUIET_RETRY_MS = 1500;
const STRUCTURE_DELAY_MS = 300;
/** Cards of a notebook grid drawn at once; "Show more" adds this many (no layout thrash with thousands of notebooks). */
const GRID_PAGE = 60;
/** Dashboard sizes. */
const DASH_SUBJECTS = 4;
const DASH_ROWS = 5;
const DASH_FAVOURITES = 4;
const DASH_TAGS = 11;

const tick = (ms = 0) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const COLLECTION_IDS: readonly CollectionId[] = ["study", "favourites", "pdf", "recent", "exams"];

function parsePlace(v: unknown, fallback: LibraryPlace): LibraryPlace {
	// The favourites filter of 0.11 is the Favourites smart collection now (starred or pinned).
	if (v === "favorites") return { collection: "favourites" };
	if (v === "all" || v === "recent" || v === "archived" || v === "home" || v === "subjects" || v === "tags") return v;
	if (typeof v === "object" && v !== null) {
		const o = v as { folder?: unknown; tag?: unknown; collection?: unknown };
		if (typeof o.folder === "string") return { folder: o.folder };
		if (typeof o.tag === "string") return { tag: o.tag };
		if (COLLECTION_IDS.includes(o.collection as CollectionId)) return { collection: o.collection as CollectionId };
	}
	return fallback;
}

const isFolderPlace = (p: LibraryPlace): p is { folder: string; recursive?: boolean } => typeof p === "object" && "folder" in p;
const isTagPlace = (p: LibraryPlace): p is { tag: string } => typeof p === "object" && "tag" in p;
const isCollectionPlace = (p: LibraryPlace): p is { collection: CollectionId } => typeof p === "object" && "collection" in p;

/** The base colour of a palette entry by name (the smart collections and quick actions use fixed ones). */
function paletteColor(name: string): string {
	return SUBJECT_COLORS.find((c) => c.name === name)?.base ?? SUBJECT_COLORS[0]!.base;
}

const COLLECTION_LOOK: Record<CollectionId, { icon: string; color: string; label: MessageKey }> = {
	study: { icon: "play", color: paletteColor("Blue"), label: "lib.collection.study" },
	favourites: { icon: "sparkles", color: paletteColor("Violet"), label: "lib.collection.favourites" },
	pdf: { icon: "file-text", color: paletteColor("Pink"), label: "lib.collection.pdf" },
	recent: { icon: "clock", color: paletteColor("Indigo"), label: "lib.collection.recent" },
	exams: { icon: "graduation-cap", color: paletteColor("Amber"), label: "lib.collection.exams" },
};

type ChipId = "all" | "subjects" | "recent" | "favourites" | "pdf" | "archived";

export class LibraryView extends ItemView {
	private index = new LibraryIndex();
	private place: LibraryPlace;
	private sort: LibrarySort = "modified";
	private search = "";
	/** Search the whole library (true) or only the current view (false); null = automatic. */
	private searchWide: boolean | null = null;
	/** 0.12: notebook grid as cards or as a list. */
	private layoutMode: "grid" | "list" = "grid";
	/** 0.12: the period of Home's statistics, in weeks. */
	private weeks: StatPeriod = 4;
	/** Wide view: the rail folded to icons by the user. */
	private railFolded = false;
	private mode: WidthMode = "wide";
	private railOpen = false;
	private readonly expanded = new Set<string>();
	/** Cards of the notebook grid drawn so far (grows with "Show more"). */
	private gridLimit = GRID_PAGE;

	private built = false;
	private closed = false;
	private rootEl!: HTMLElement;
	private railEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private headerArtEl!: HTMLElement;
	private subtitleEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private toolsEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private observer: IntersectionObserver | null = null;
	private resizeObserver: ResizeObserver | null = null;

	private renderQueued = false;
	/** "Now: <course>" shortcut (timetable); hidden when no class is in progress. */
	private nowBtn: HTMLButtonElement | null = null;
	private saveTimer = 0;
	private reconcileTimer = 0;
	private reconcileAt = 0;
	private reconciling = false;
	private reconcileAgain = false;
	private dirty = false;
	private searchTimer = 0;

	/** Roadmap 54: pinned / archived / manual order, merged from every device's file in `_meta`. */
	private state: LibraryMap = new Map();
	private stateTimer = 0;
	/** The notebooks of the grid as shown (paths), per group, so a move up / down / drop knows its neighbours. */
	private arrangement: { pinned: string[]; rest: string[] } = { pinned: [], rest: [] };
	private backfilling = false;

	private readonly thumbQueue: string[] = [];
	private readonly thumbPending = new Set<string>();
	private readonly thumbFailed = new Set<string>();
	private thumbRunning = false;
	/** 0.12: the inbox bell of the header (null without the Zettelkasten Inbox). */
	private bell: InboxBell | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly host: LibraryHost, private readonly startPlace: LibraryPlace = "all") {
		super(leaf);
		this.place = startPlace;
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
		return { ...super.getState(), scope: this.place, sort: this.sort, layout: this.layoutMode, weeks: this.weeks };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (typeof state === "object" && state !== null) {
			const s = state as { scope?: unknown; sort?: unknown; layout?: unknown; weeks?: unknown };
			this.place = parsePlace(s.scope, this.startPlace);
			if (SORTS.includes(s.sort as LibrarySort)) this.sort = s.sort as LibrarySort;
			if (s.layout === "grid" || s.layout === "list") this.layoutMode = s.layout;
			if (STAT_PERIODS.includes(s.weeks as StatPeriod)) this.weeks = s.weeks as StatPeriod;
			if (this.built) this.requestRender();
		}
		await super.setState(state, result);
	}

	/** 0.12: shows Home or a place of the library in this view (the ribbon, the commands, the rail). */
	show(place: LibraryPlace): void {
		if (!this.built) {
			this.place = place;
			return;
		}
		this.navigate(place);
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("notebook-lib");
		try {
			this.index = LibraryIndex.fromJSON(await this.host.loadIndex());
		} catch (e) {
			console.error("[notebook] library index unreadable, rebuilding", e);
		}
		try {
			this.state = (await this.host.state?.load()) ?? new Map();
		} catch (e) {
			console.error("[notebook] library state unreadable", e);
		}
		this.buildShell();
		window.requestAnimationFrame(() => this.checkStyles());
		const inbox = this.host.inbox?.() ?? null;
		if (inbox) {
			this.bell = new InboxBell(inbox, {
				container: this.rootEl,
				phone: () => this.mode === "phone",
				colorOf: (path) => {
					const e = this.index.get(path);
					return e ? (this.subjectOf(e)?.color ?? null) : null;
				},
				when: (path) => {
					const e = this.index.get(path);
					return e && e.modified > 0 ? stampTime(e.modified, Date.now(), getLanguage()) : "";
				},
			});
		}
		this.built = true;
		this.expanded.add(this.root());
		this.render();
		this.refreshNow();
		this.registerInterval(window.setInterval(() => this.refreshNow(), 30_000));
		this.host.libraryOpened?.();

		const vault = this.app.vault;
		this.registerEvent(vault.on("create", (f) => this.onVaultChange(f)));
		this.registerEvent(vault.on("modify", (f) => this.onVaultChange(f, MODIFY_DELAY_MS)));
		this.registerEvent(vault.on("delete", (f) => this.onVaultDelete(f)));
		// A device synced its library file: pinned, archived and order change here too.
		this.registerEvent(vault.on("create", (f) => this.onStateFile(f)));
		this.registerEvent(vault.on("modify", (f) => this.onStateFile(f)));
		this.registerEvent(vault.on("delete", (f) => this.onStateFile(f)));
		this.registerEvent(vault.on("rename", (f, oldPath) => this.onVaultRename(f, oldPath)));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.revealed()));
		// wave 0.12: a folder's colour, icon or art changed (creation dialog, another device): redraw the cards.
		const offMeta = this.host.folderMeta?.onFolderMetaChange(() => this.requestRender());
		if (offMeta) this.register(offMeta);

		// The bell's first look through the notebooks waits for the library's own reading and for a pause in writing.
		void this.reconcile(true).then(() => writing.idle()).then(() => {
			if (!this.closed) this.bell?.scanIfStale();
		});
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.bell?.dispose();
		window.clearTimeout(this.saveTimer);
		window.clearTimeout(this.reconcileTimer);
		window.clearTimeout(this.searchTimer);
		window.clearTimeout(this.stateTimer);
		this.observer?.disconnect();
		this.resizeObserver?.disconnect();
		this.thumbQueue.length = 0;
		try {
			// An index written by a newer plugin version on another device is never saved over (review).
			if (!this.index.keepsNewerVersion) await this.host.saveIndex(this.index.toJSON());
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
		// nb-ui: the scope of the design-system styles (styles.css, 0.12 section), above Obsidian's own button and input rules.
		this.rootEl = el.createDiv({ cls: "notebook-lib-root nb-app nb-ui nb-no-anim" });
		this.railEl = this.rootEl.createEl("aside", { cls: "nb-rail", attr: { "aria-label": t("nav.label") } });
		this.rootEl.createDiv({ cls: "nb-rail-backdrop" }).addEventListener("click", () => this.setRailOpen(false));

		const main = this.rootEl.createDiv({ cls: "nb-main" });
		this.scrollEl = main.createDiv({ cls: "notebook-lib-scroll nb-scroll" });
		const header = this.scrollEl.createEl("header", { cls: "nb-page-header" });
		this.headerArtEl = header.createDiv({ cls: "nb-header-art", attr: { "aria-hidden": "true" } });
		const lead = header.createDiv({ cls: "nb-header-lead" });
		iconButton(lead, "menu", t("nav.open"), () => this.setRailOpen(!this.railOpen), "nb-rail-toggle");
		const titles = lead.createDiv({ cls: "nb-header-titles" });
		this.titleEl = titles.createEl("h1", { cls: "nb-page-title" });
		this.subtitleEl = titles.createDiv({ cls: "nb-page-subtitle" });
		this.statusEl = titles.createDiv({ cls: "notebook-lib-status nb-status", attr: { "aria-live": "polite" } });

		const tools = header.createDiv({ cls: "nb-header-tools" });
		const { input } = searchPill(tools, {
			placeholder: t("lib.search.placeholder"),
			label: t("library.search.label"),
			hint: Platform.isDesktop ? (Platform.isMacOS ? "⌘ K" : "Ctrl K") : null,
			onInput: (value) => {
				window.clearTimeout(this.searchTimer);
				this.searchTimer = window.setTimeout(() => {
					this.search = value;
					this.requestRender();
				}, 150);
			},
		});
		this.searchEl = input;
		this.toolsEl = tools.createDiv({ cls: "nb-header-buttons" });
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "k", () => {
			this.searchEl.focus();
			this.searchEl.select();
			return false;
		});

		this.gridEl = this.scrollEl.createDiv({ cls: "notebook-lib-content nb-content" });

		this.observer = new IntersectionObserver((records) => this.onIntersect(records), { root: this.scrollEl, rootMargin: "240px 0px" });
		this.resizeObserver = new ResizeObserver(() => {
			const w = this.contentEl.clientWidth;
			if (w === 0) return;
			const mode = this.widthMode(w);
			// The first size known: from now on the rail may slide.
			if (this.rootEl.hasClass("nb-no-anim")) window.requestAnimationFrame(() => window.requestAnimationFrame(() => this.rootEl.removeClass("nb-no-anim")));
			if (mode !== this.mode) {
				this.mode = mode;
				this.railOpen = false;
				this.requestRender();
			}
			this.applyLayout();
			if (this.dirty) void this.reconcile();
		});
		this.resizeObserver.observe(this.contentEl);
		this.mode = this.widthMode(this.contentEl.clientWidth);
		this.applyLayout();
	}

	/**
	 * 0.12.1 diagnostic: Obsidian did not apply the plugin's styles.css (0.12.0 rendered unstyled on a device; the likely
	 * cause was a failed start-up, after which the sheet is not applied). Said once per session, in the console and a notice.
	 */
	private checkStyles(): void {
		if (stylesWarned || this.closed || !this.rootEl.isConnected || this.contentEl.clientWidth === 0) return;
		if (getComputedStyle(this.rootEl).display === "flex") return;
		stylesWarned = true;
		console.error("[notebook] the plugin's styles.css is not applied: Home and the library cannot be drawn as designed");
		showNotice(t("notice.stylesMissing"), 15000);
	}

	private widthMode(w: number): WidthMode {
		if (w <= 0) return this.mode;
		return w < PHONE_PX ? "phone" : w < WIDE_PX ? "medium" : "wide";
	}

	private applyLayout(): void {
		const r = this.rootEl;
		r.toggleClass("is-phone", this.mode === "phone");
		r.toggleClass("is-medium", this.mode === "medium");
		r.toggleClass("is-wide", this.mode === "wide");
		// A folded rail on a wide view, and always on a tablet in portrait: icons only.
		r.toggleClass("is-rail-compact", this.mode === "medium" || (this.mode === "wide" && this.railFolded));
		r.toggleClass("is-rail-open", this.mode === "phone" && this.railOpen);
		r.toggleClass("is-list", this.layoutMode === "list");
	}

	private setRailOpen(open: boolean): void {
		this.railOpen = open;
		this.applyLayout();
	}

	private setStatus(done: number, total: number): void {
		this.statusEl.setText(total >= 3 && done < total ? t("library.status.indexing", { done: String(done), total: String(total) }) : "");
	}

	// -------------------------------------------------------------- vault

	// ---------------------------------------------------------- pinned, archived, manual order (roadmap 54)

	private keyOf = (e: LibraryEntry): string => this.index.stateKey(e);
	private isArchived = (e: LibraryEntry): boolean => this.state.get(this.keyOf(e))?.archived === true;
	private isPinned = (e: LibraryEntry): boolean => this.state.get(this.keyOf(e))?.pinned === true;
	private notArchived = (e: LibraryEntry): boolean => !this.isArchived(e);

	private onStateFile(f: TAbstractFile): void {
		if (!(f instanceof TFile) || !this.host.state?.watches(f.path)) return;
		window.clearTimeout(this.stateTimer);
		this.stateTimer = window.setTimeout(() => {
			void this.host.state?.load().then((state) => {
				if (this.closed) return;
				this.state = state;
				this.requestRender();
			}).catch((e) => console.error("[notebook] library state unreadable", e));
		}, 600);
	}

	/** Writes the changes to this device's file, then shows the merged result. A file that cannot be read is never overwritten. */
	private async updateState(ops: LibraryOp[]): Promise<boolean> {
		const store = this.host.state;
		if (!store || ops.length === 0) return false;
		try {
			this.state = await store.update(ops);
			this.requestRender();
			return true;
		} catch (e) {
			if (e instanceof LibraryStateBlockedError) showNotice(t("library.notice.stateBlocked", { error: e.message }));
			else this.fail(e);
			return false;
		}
	}

	/** Reads the id of notebooks the index has no id for (an index from before ids were kept), so their state is keyed by id. */
	private async ensureIds(paths: readonly string[]): Promise<void> {
		for (const path of paths) {
			if (!this.index.needsId(path)) continue;
			const file = this.app.vault.getFileByPath(path);
			if (!file) continue;
			try {
				const id = await this.host.readNotebookId?.(file);
				if (id) this.index.patch(path, { id });
			} catch (e) {
				console.error("[notebook] could not read the notebook id", path, e);
			}
		}
	}

	/** In the background, after indexing: gives every entry its id (cheap: the start of the file). */
	private async backfillIds(): Promise<void> {
		if (this.backfilling || !this.host.readNotebookId) return;
		this.backfilling = true;
		try {
			let n = 0;
			for (const e of this.index.all()) {
				if (this.closed) return;
				if (!this.index.needsId(e.path)) continue;
				await writing.idle();
				await this.ensureIds([e.path]);
				if (++n % 16 === 0) {
					this.afterIndexChange();
					await tick();
				}
			}
			if (n > 0) this.afterIndexChange();
		} finally {
			this.backfilling = false;
		}
	}

	private setSort(sort: LibrarySort): void {
		this.sort = sort;
		this.app.workspace.requestSaveLayout();
	}

	private async togglePinned(path: string): Promise<void> {
		await this.ensureIds([path]);
		const e = this.index.get(path);
		if (!e) return;
		await this.updateState([{ kind: "pinned", key: this.keyOf(e), value: !this.isPinned(e) }]);
	}

	private async toggleArchived(path: string): Promise<void> {
		await this.ensureIds([path]);
		const e = this.index.get(path);
		if (!e) return;
		const archive = !this.isArchived(e);
		if (await this.updateState([{ kind: "archived", key: this.keyOf(e), value: archive }])) {
			showNotice(t(archive ? "library.notice.archived" : "library.notice.unarchived", { name: e.name }));
		}
	}

	/** The group (pinned or the rest) of the grid that shows `path`, as paths in the order shown. */
	private groupOf(path: string): string[] | null {
		if (this.arrangement.pinned.includes(path)) return this.arrangement.pinned;
		return this.arrangement.rest.includes(path) ? this.arrangement.rest : null;
	}

	/** Whether the order of the grid can be changed by hand: a plain list (not a search, not Recent or Archived) with two or more in a group. */
	private reorderable(path: string): boolean {
		const group = this.groupOf(path);
		return !!group && group.length > 1 && this.search.trim() === "" && this.place !== "recent" && this.place !== "archived";
	}

	/** Puts `path` at `toIndex` of its group. A grid that is not in manual order is first fixed as it is shown, then moved. */
	private async placeAt(path: string, toIndex: number): Promise<void> {
		const group = this.groupOf(path);
		if (!group || !this.reorderable(path)) return;
		await this.ensureIds(group);
		const manual = this.sort === "manual";
		const entries = group.map((p) => this.index.get(p));
		if (entries.some((e) => !e)) return;
		const keys = entries.map((e) => this.keyOf(e!));
		const own = this.index.get(path);
		if (!own) return;
		const changes = planMove(keys, this.keyOf(own), toIndex, manual ? (k) => this.state.get(k)?.rank : () => undefined);
		if (changes.length === 0) return;
		if (!manual) this.setSort("manual");
		await this.updateState(changes.map((c): LibraryOp => ({ kind: "rank", key: c.key, value: c.rank })));
	}

	private moveBy(path: string, delta: number): Promise<void> {
		const group = this.groupOf(path);
		return group ? this.placeAt(path, group.indexOf(path) + delta) : Promise.resolve();
	}

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
			// Wave 0.8 (374): reading and indexing notebooks waits while the pen is on the screen (the save that caused it can wait).
			if (writing.writing()) {
				this.scheduleReconcile(QUIET_RETRY_MS);
				return;
			}
			void this.reconcile();
		}, delay);
	}

	/** The view became visible again: catch up with what changed meanwhile. */
	private revealed(): void {
		if (!this.contentEl.isShown()) return;
		if (this.dirty) void this.reconcile();
		this.bell?.scanIfStale();
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
			void this.backfillIds();
		} finally {
			this.reconciling = false;
			this.setStatus(0, 0);
		}
	}

	private scheduleSave(): void {
		if (this.closed) return;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			if (this.index.keepsNewerVersion) return;
			this.host.saveIndex(this.index.toJSON()).catch((e) => console.error("[notebook] saving the library index failed", e));
		}, SAVE_DELAY_MS);
	}


	// ------------------------------------------------------------- thumbnails

	private onIntersect(records: IntersectionObserverEntry[]): void {
		for (const r of records) {
			if (!r.isIntersecting) continue;
			const el = r.target as HTMLElement;
			this.observer?.unobserve(el);
			const path = el.dataset.thumbPath;
			const entry = path ? this.index.get(path) : undefined;
			if (!path || !entry) continue;
			this.fillThumb(el, entry);
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
				// Wave 0.8 (374): drawing cover thumbnails waits for a pause in writing.
				await writing.idle();
				if (this.closed) break;
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
							if (next) for (const el of this.thumbsOf(path)) this.fillThumb(el, next);
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

	/** Every thumbnail box that shows this notebook (a grid card, a favourite row). */
	private thumbsOf(path: string): HTMLElement[] {
		return Array.from(this.gridEl.querySelectorAll<HTMLElement>("[data-thumb-path]")).filter((el) => el.dataset.thumbPath === path);
	}

	private fillThumb(el: HTMLElement, entry: LibraryEntry): void {
		el.empty();
		if (entry.thumb) el.createEl("img", { attr: { src: entry.thumb, alt: "", draggable: "false", decoding: "async" } });
		else setIcon(el.createDiv({ cls: "notebook-lib-page-empty" }), "file-text");
	}

	/** Watches a thumbnail box: it is filled (and rendered if missing) when it scrolls into view. */
	private watchThumb(el: HTMLElement): void {
		this.observer?.observe(el);
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

	/** Falls back to the library when the folder or tag of the current place no longer exists. */
	private fixScope(): void {
		const s = this.place;
		if (isFolderPlace(s)) {
			const known = s.folder === this.root() || this.app.vault.getFolderByPath(s.folder);
			if (!known) this.place = "all";
		} else if (isTagPlace(s)) {
			const tag = s.tag.toLowerCase();
			if (!this.index.tags(this.notArchived).some((x) => x.tag.toLowerCase() === tag)) this.place = "all";
		}
	}

	private render(): void {
		this.refreshNow();
		this.fixScope();
		const active = this.contentEl.ownerDocument.activeElement;
		const focus = active instanceof HTMLElement && this.contentEl.contains(active) ? active.dataset.key : undefined;
		const tree = this.tree();
		this.applyLayout();
		this.renderRail(tree);
		this.renderHeader();
		this.renderContent(tree);
		if (focus) {
			for (const el of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-key]"))) {
				if (el.dataset.key === focus) {
					el.focus({ preventScroll: true });
					break;
				}
			}
		}
	}

	/** Shows or hides the "Now: <course>" shortcut for the class in progress. */
	private refreshNow(): void {
		const btn = this.nowBtn;
		if (!btn) return;
		const now = this.host.nowClass?.() ?? null;
		btn.toggleClass("is-hidden", !now);
		if (!now) return;
		const label = t("library.now", { course: now.course });
		btn.setAttribute("aria-label", label);
		btn.querySelector(".nb-now-label")?.setText(label);
	}

	private currentFolder(): string {
		return isFolderPlace(this.place) ? this.place.folder : this.root();
	}

	private navigate(place: LibraryPlace): void {
		this.place = place;
		this.searchWide = null;
		this.gridLimit = GRID_PAGE;
		if (this.search) {
			this.search = "";
			this.searchEl.value = "";
		}
		if (isFolderPlace(place)) {
			// Make the folder visible in the tree.
			let p = place.folder;
			while (p !== "" && p.length > this.root().length) {
				p = folderOf(p);
				this.expanded.add(p);
			}
		}
		if (this.mode === "phone") this.railOpen = false;
		this.app.workspace.requestSaveLayout();
		this.render();
		this.scrollEl.scrollTop = 0;
	}

	private folderCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		const root = this.root();
		for (const e of this.index.all().filter(this.notArchived)) {
			let p = e.folder;
			for (;;) {
				counts.set(p, (counts.get(p) ?? 0) + 1);
				if (p === root || p === "") break;
				p = folderOf(p);
			}
		}
		return counts;
	}

	// ---------------------------------------------------------- subjects and colours

	/** The subject (top-level folder) a folder belongs to, or null for the notebooks root. */
	private subjectFolderOf(folder: string): string | null {
		return topFolderOf(`${folder}/_`, this.root());
	}

	/**
	 * wave 0.12: what a folder's card shows: its stored look (folder metadata, set in the creation dialog), else the
	 * colour and the art style that follow from its name.
	 */
	private folderLook(path: string): { color: string; icon?: string; artStyle: ArtStyle; description?: string } {
		const name = path.slice(path.lastIndexOf("/") + 1);
		const m = this.host.folderMeta?.getFolderMeta(path) ?? null;
		return { color: m?.color ?? colorFor(name), icon: m?.icon, artStyle: m?.art ?? artStyleFor(name), description: m?.description };
	}

	/** The colour of a folder: its own stored colour, else its subject's (top-level folder's); null at the root. */
	private folderColor(folder: string): string | null {
		const top = this.subjectFolderOf(folder);
		if (top === null) return null;
		return this.host.folderMeta?.getFolderMeta(folder)?.color ?? this.folderLook(top).color;
	}

	/** The subject of a notebook: its top-level folder's name and colour, or null for a notebook at the root. */
	private subjectOf(e: LibraryEntry): { label: string; color: string } | null {
		const top = topFolderOf(e.path, this.root());
		if (top === null) return null;
		const label = top.slice(top.lastIndexOf("/") + 1);
		return { label, color: this.folderLook(top).color };
	}

	private visible(): LibraryEntry[] {
		return this.index.all().filter(this.notArchived);
	}

	private subjects(tree: FolderNode): Subject[] {
		return subjectsOf(this.visible(), this.root(), tree.children.map((c) => c.path));
	}

	private collectionCtx(): CollectionContext {
		return { now: Date.now(), pinned: this.isPinned };
	}

	/** Procedural artwork is off when the system asks for reduced motion and effects (DESIGN.md §2.6, §7). */
	private artOn(): boolean {
		return !activeWindow.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	}

	/** Decoration (DESIGN.md §2.6): a cached generated artwork, or undefined when effects are reduced. */
	private art(seed: string, color: string, w: number, h: number): string | undefined {
		if (!this.artOn()) return undefined;
		const surface = activeDocument.body.hasClass("theme-light") ? "light" : "dark";
		return artImage({ seed, color, surface }, w, h, Math.min(2, activeWindow.devicePixelRatio || 1)) || undefined;
	}

	private subjectCardOptions(s: Subject, shape: "row" | "tile"): SubjectCardOptions {
		const lines = shape === "row"
			? [this.plural(s.notebooks, "library.notebooks.one", "library.notebooks.many")]
			: [this.plural(s.notebooks, "library.notebooks.one", "library.notebooks.many"), this.plural(s.pages, "library.pages.one", "library.pages.many")];
		const look = this.folderLook(s.path);
		return {
			name: s.name, color: look.color, icon: look.icon, artStyle: look.artStyle, seed: s.path, lines, shape, art: this.artOn(),
			key: `subject:${s.path}`, onOpen: () => this.navigate({ folder: s.path }),
		};
	}

	/** A subject card is also a drop target (move a notebook into the subject) and has the folder menu. */
	private wireFolderCard(card: HTMLElement, path: string): void {
		card.setAttribute(DROP_ATTR, path);
		attachPress({ el: card, onMenu: (x, y) => this.folderMenu(path, x, y) });
	}

	private notebookPills(e: LibraryEntry): Pill[] {
		const out: Pill[] = [];
		const subject = this.subjectOf(e);
		if (subject) out.push(subject);
		const tag = e.tags.find((x) => !subject || normalizeText(x) !== normalizeText(subject.label));
		if (tag) out.push({ label: tag });
		return out;
	}

	private notebookRow(e: LibraryEntry, now: number, meta?: string, open?: () => void): ListRowOptions {
		return {
			icon: (e.pdfPages ?? 0) > 0 ? "file-type" : "file-text",
			title: e.name,
			meta: meta ?? t("lib.modified", { time: stampTime(e.modified, now, getLanguage()) }),
			pills: this.notebookPills(e),
			key: `row:${e.path}`,
			menuLabel: t("library.menu.more"),
			onOpen: open ?? (() => this.openEntry(e.path)),
			onMenu: (anchor) => this.notebookMenu(e.path, 0, 0, anchor),
		};
	}

	private favouriteOptions(e: LibraryEntry, now: number): FavouriteRowOptions {
		return {
			path: e.path,
			title: e.name,
			subject: this.subjectOf(e),
			count: this.plural(e.pages, "library.pages.one", "library.pages.many"),
			updated: t("lib.updated", { time: stampTime(e.modified, now, getLanguage()) }),
			starred: e.favorite,
			starLabel: e.favorite ? t("library.favorite.remove") : t("library.favorite.add"),
			menuLabel: t("library.menu.more"),
			key: `fav:${e.path}`,
			onOpen: () => this.openEntry(e.path),
			onStar: () => void this.toggleFavorite(e.path),
			onMenu: (anchor) => this.notebookMenu(e.path, 0, 0, anchor),
		};
	}

	/** Colours of tags that name a subject (the dot of a tag chip). */
	private tagColor(tag: string, subjects: readonly Subject[]): string | null {
		const key = normalizeText(tag.split("/").pop() ?? tag);
		const s = subjects.find((x) => normalizeText(x.name) === key);
		return s ? this.folderLook(s.path).color : null;
	}

	private tagChips(tags: ReadonlyArray<{ tag: string; count: number }>, subjects: readonly Subject[]): TagChip[] {
		return tags.map(({ tag, count }) => ({ tag, count, color: this.tagColor(tag, subjects), onClick: () => this.navigate({ tag }) }));
	}

	// ---------------------------------------------------------------- rail

	private renderRail(tree: FolderNode): void {
		const el = this.railEl;
		el.empty();
		const top = el.createDiv({ cls: "nb-rail-top" });
		railBrand(top, t("nav.brand"), t("nav.brandSub"));
		if (this.mode === "phone") iconButton(top, "x", t("library.sidebar.close"), () => this.setRailOpen(false), "nb-rail-close");
		else if (this.mode === "wide") {
			iconButton(top, this.railFolded ? "panel-left-open" : "panel-left-close", t("library.sidebar.toggle"), () => {
				this.railFolded = !this.railFolded;
				this.applyLayout();
				this.renderRail(this.tree());
			}, "nb-rail-fold");
		}

		const visible = this.visible();
		const archived = this.index.size - visible.length;
		const nav = el.createEl("nav", { cls: "nb-rail-nav" });
		const p = this.place;
		const libraryActive = !(p === "home" || p === "tags" || p === "archived" || isFolderPlace(p) || isTagPlace(p) || (isCollectionPlace(p) && p.collection === "pdf"));
		railItem(nav, { key: "nav:home", icon: "home", label: t("nav.home"), active: p === "home", onClick: () => this.navigate("home") });
		railItem(nav, { key: "nav:all", icon: "folder", label: t("nav.notebooks"), active: libraryActive, onClick: () => this.navigate("all") });
		if (visible.some((e) => (e.pdfPages ?? 0) > 0)) {
			railItem(nav, { key: "nav:pdf", icon: "file-text", label: t("nav.pdf"), active: isCollectionPlace(p) && p.collection === "pdf", onClick: () => this.navigate({ collection: "pdf" }) });
		}
		railItem(nav, { key: "nav:tags", icon: "tag", label: t("nav.tags"), active: p === "tags" || isTagPlace(p), onClick: () => this.navigate("tags") });
		const settings = this.host.openSettings?.bind(this.host);
		if (settings) {
			railItem(nav, { key: "nav:settings", icon: "settings", label: t("nav.settings"), onClick: () => {
				this.setRailOpen(false);
				settings();
			} });
		}

		railLabel(el, t("nav.vault"));
		const counts = this.folderCounts();
		const treeEl = el.createDiv({ cls: "nb-rail-tree", attr: { role: "tree" } });
		const walk = (node: FolderNode, depth: number) => {
			const hasChildren = node.children.length > 0;
			const open = this.expanded.has(node.path);
			const row = treeEl.createDiv({ cls: `nb-tree-row nb-depth-${Math.min(depth, 3)}`, attr: { role: "treeitem", [DROP_ATTR]: node.path } });
			if (hasChildren) row.setAttribute("aria-expanded", String(open));
			row.setCssProps({ "--notebook-depth": String(depth) });
			const color = this.folderColor(node.path);
			railItem(row, {
				key: `folder:${node.path}`,
				icon: open && hasChildren ? "folder-open" : "folder",
				image: color ? svgDataUrl(folderIconSvg(color, 24)) : undefined,
				color: color ?? undefined,
				label: node.path === this.root() ? this.rootLabel() : node.name,
				count: counts.get(node.path) ?? 0,
				active: isFolderPlace(p) && p.folder === node.path,
				onClick: () => this.navigate({ folder: node.path }),
			});
			if (hasChildren) {
				const tg = iconButton(row, open ? "chevron-down" : "chevron-right", t("library.folder.toggle"), () => {
					if (open) this.expanded.delete(node.path);
					else this.expanded.add(node.path);
					this.renderRail(this.tree());
				}, "nb-tree-toggle");
				tg.dataset.key = `toggle:${node.path}`;
			}
			attachPress({ el: row, onMenu: (x, y) => this.folderMenu(node.path, x, y) });
			if (open) node.children.forEach((c) => walk(c, depth + 1));
		};
		walk(tree, 0);

		const bottom = el.createDiv({ cls: "nb-rail-bottom" });
		railItem(bottom, { key: "nav:archived", icon: "archive", label: t("nav.archive"), count: archived, active: p === "archived", onClick: () => this.navigate("archived") });
		const trash = this.host.trash;
		if (trash) {
			railItem(bottom, { key: "nav:trash", icon: "trash-2", label: t("library.nav.trash"), onClick: () => {
				this.setRailOpen(false);
				new TrashModal(this.app, trash).open();
			} });
		}
		const check = this.host.checkLibrary?.bind(this.host); // roadmap 27
		if (check) {
			railItem(bottom, { key: "nav:check", icon: "hard-drive", label: t("libcheck.nav"), onClick: () => {
				this.setRailOpen(false);
				check();
			} });
		}
	}

	// ---------------------------------------------------------------- header

	private placeTitle(): { title: string; subtitle: string } {
		const p = this.place;
		if (p === "home") return { title: t("home.title"), subtitle: t("home.subtitle") };
		if (isFolderPlace(p)) {
			const parts = breadcrumb(this.root(), p.folder);
			const names = parts.map((x) => (x.path === this.root() ? this.rootLabel() : x.name));
			return { title: names[names.length - 1] ?? this.rootLabel(), subtitle: names.slice(0, -1).join(" › ") };
		}
		if (isTagPlace(p)) return { title: `#${p.tag}`, subtitle: t("lib.subtitle.tag") };
		if (p === "tags") return { title: t("nav.tags"), subtitle: t("lib.subtitle.tags") };
		if (p === "archived") return { title: t("nav.archive"), subtitle: t("library.archived.hint") };
		if (isCollectionPlace(p)) return { title: t(COLLECTION_LOOK[p.collection].label), subtitle: t(`lib.collection.${p.collection}.hint` as MessageKey) };
		return { title: t("lib.title"), subtitle: t("lib.subtitle") };
	}

	private renderHeader(): void {
		const { title, subtitle } = this.placeTitle();
		this.titleEl.setText(title);
		// Decoration: a faint band of generated art behind the header (quiet, never a control).
		const headerArt = this.art(this.place === "home" ? "notebook-home" : "notebook-library", paletteColor("Indigo"), 640, 140);
		this.headerArtEl.toggleClass("is-hidden", !headerArt);
		if (headerArt) this.headerArtEl.setCssProps({ "--nb-art": `url("${headerArt}")` });
		this.subtitleEl.empty();
		const p = this.place;
		if (isFolderPlace(p)) {
			// The breadcrumb: each folder above is a link (and a drop target).
			const parts = breadcrumb(this.root(), p.folder).slice(0, -1);
			parts.forEach((part, i) => {
				if (i > 0) this.subtitleEl.createSpan({ cls: "nb-crumb-sep", text: "›", attr: { "aria-hidden": "true" } });
				const b = this.subtitleEl.createEl("button", { cls: "nb-crumb", text: part.path === this.root() ? this.rootLabel() : part.name, attr: { type: "button", [DROP_ATTR]: part.path } });
				b.addEventListener("click", () => this.navigate({ folder: part.path }));
			});
		} else {
			this.subtitleEl.setText(subtitle);
		}

		const tools = this.toolsEl;
		tools.empty();
		this.nowBtn = null;
		if (this.host.nowClass && this.host.openNowClass) {
			const b = tools.createEl("button", { cls: "nb-now-btn", attr: { type: "button", title: t("library.now.tip") } });
			setIcon(b.createSpan({ cls: "nb-now-icon", attr: { "aria-hidden": "true" } }), "graduation-cap");
			b.createSpan({ cls: "nb-now-label" });
			b.addEventListener("click", () => this.host.openNowClass?.());
			this.nowBtn = b;
			this.refreshNow();
		}
		this.bell?.mount(tools);
		if (p === "home") return;
		iconButton(tools, "filter", t("lib.filter"), (b) => this.filterMenu(b), isTagPlace(p) ? "is-active" : "");
		iconButton(tools, "arrow-up-down", t("library.sort.label"), (b) => this.sortMenu(b));
		const list = this.layoutMode === "list";
		const view = iconButton(tools, list ? "list" : "layout-grid", list ? t("lib.view.grid") : t("lib.view.list"), () => {
			this.layoutMode = list ? "grid" : "list";
			this.app.workspace.requestSaveLayout();
			this.render();
		}, "is-active");
		view.setAttribute("aria-pressed", String(list));
		iconButton(tools, "plus", t("lib.new"), (b) => this.newMenu(b), "is-primary");
	}

	private showMenu(menu: Menu, anchor: HTMLElement): void {
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	private filterMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		const p = this.place;
		menu.addItem((i) => i.setTitle(t("library.nav.all")).setIcon("library").setChecked(p === "all").onClick(() => this.navigate("all")));
		const tags = this.index.tags(this.notArchived);
		if (tags.length === 0) menu.addItem((i) => i.setTitle(t("library.nav.noTags")).setDisabled(true));
		for (const { tag, count } of tags.slice(0, 30)) {
			menu.addItem((i) => i.setTitle(`#${tag} (${count})`).setIcon("tag").setChecked(isTagPlace(p) && p.tag.toLowerCase() === tag.toLowerCase()).onClick(() => this.navigate({ tag })));
		}
		this.showMenu(menu, anchor);
	}

	private sortMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		for (const s of SORTS) {
			menu.addItem((i) => i.setTitle(t(`library.sort.${s}` as MessageKey)).setChecked(this.sort === s).onClick(() => {
				this.setSort(s);
				this.render();
			}));
		}
		this.showMenu(menu, anchor);
	}

	/**
	 * Runs an action of the registry (ui/actions.ts): `new-notebook` and `new-folder` open the creation dialog
	 * (view/create-dialog.ts). Without the registry (a host that has none), the host opens the same dialog directly.
	 */
	private runCreate(id: "new-notebook" | "new-folder"): void {
		if (this.host.runAction?.(id)) return;
		if (id === "new-notebook") this.host.createNotebook(this.root());
		else this.host.createFolder(this.root());
	}

	private newNotebook(): void {
		const folder = this.currentFolder();
		// Inside a folder the notebook goes there; elsewhere the registry's creation dialog starts where it was used last.
		if (folder !== this.root()) this.host.createNotebook(folder);
		else this.runCreate("new-notebook");
	}

	private newFolder(): void {
		const folder = this.currentFolder();
		if (folder !== this.root()) this.host.createFolder(folder);
		else this.runCreate("new-folder");
	}

	private newMenu(anchor: HTMLElement): void {
		const folder = this.currentFolder();
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("library.action.newNotebook")).setIcon("file-plus").onClick(() => this.newNotebook()));
		menu.addItem((i) => i.setTitle(t("library.action.newFolder")).setIcon("folder-plus").onClick(() => this.newFolder()));
		menu.addItem((i) => i.setTitle(t("library.action.importPdf")).setIcon("file-up").onClick(() => this.host.importPdf(folder)));
		if (this.host.lectureFromSlides) menu.addItem((i) => i.setTitle(t("library.action.lectureFromSlides")).setIcon("presentation").onClick(() => this.host.lectureFromSlides?.(folder)));
		if (this.host.scanToNotebook) menu.addItem((i) => i.setTitle(t("library.action.scanNotebook")).setIcon("scan").onClick(() => this.host.scanToNotebook?.(folder)));
		if (this.host.openLooseSheet) menu.addItem((i) => i.setTitle(t("library.action.looseSheet")).setIcon("sticky-note").onClick(() => this.host.openLooseSheet?.()));
		this.showMenu(menu, anchor);
	}

	// ---------------------------------------------------------------- content

	private renderContent(tree: FolderNode): void {
		const el = this.gridEl;
		el.empty();
		this.observer?.disconnect();
		this.arrangement = { pinned: [], rest: [] };
		if (this.search.trim().length > 0) {
			this.renderSearch(el, tree);
			return;
		}
		if (this.place === "home") {
			this.renderHomeSurface(el, tree);
			return;
		}
		this.renderChips(el);
		const p = this.place;
		if (p === "all") {
			this.renderDashboard(el, tree);
			const sec = el.createEl("section", { cls: "nb-section nb-all" });
			sectionHeader(sec, { icon: "library", title: t("library.nav.all") });
			this.renderGrid(sec, tree);
		} else if (p === "subjects") {
			this.renderSubjectsPage(el, tree);
		} else if (p === "tags") {
			this.renderTagsPage(el, tree);
		} else {
			this.renderGrid(el, tree);
		}
	}

	private activeChip(): ChipId | null {
		const p = this.place;
		if (p === "all" || p === "subjects" || p === "recent" || p === "archived") return p;
		if (isCollectionPlace(p) && (p.collection === "favourites" || p.collection === "pdf")) return p.collection;
		return null;
	}

	private renderChips(el: HTMLElement): void {
		const items: Array<FilterChip<ChipId>> = [
			{ id: "all", label: t("lib.chip.all") },
			{ id: "subjects", label: t("lib.chip.subjects") },
			{ id: "recent", label: t("lib.chip.recent"), icon: "clock" },
			{ id: "favourites", label: t("lib.chip.favourites"), icon: "star" },
			{ id: "pdf", label: t("lib.chip.pdf"), icon: "file-text" },
			{ id: "archived", label: t("lib.chip.archived"), icon: "archive" },
		];
		filterChips(el, items, this.activeChip(), (id) => this.navigate(id === "favourites" || id === "pdf" ? { collection: id } : id), t("lib.chips"));
	}

	private renderDashboard(el: HTMLElement, tree: FolderNode): void {
		const now = Date.now();
		const visible = this.visible();
		const subjects = this.subjects(tree);
		const c = this.collectionCtx();
		const byModified = [...visible].sort((a, b) => b.modified - a.modified);
		const favourites = byModified.filter((e) => inCollection("favourites", e, c));
		const tags = this.index.tags(this.notArchived);
		renderLibrarySections(el, {
			subjects: subjects.slice(0, DASH_SUBJECTS).map((s) => this.subjectCardOptions(s, "tile")),
			moreSubjects: subjects.length > DASH_SUBJECTS ? () => this.navigate("subjects") : null,
			collections: collectionsOf(visible, c).map(({ id, count }): QuickActionOptions => ({
				icon: COLLECTION_LOOK[id].icon,
				color: COLLECTION_LOOK[id].color,
				title: t(COLLECTION_LOOK[id].label),
				description: this.plural(count, "library.notebooks.one", "library.notebooks.many"),
				art: this.art(`collection:${id}`, COLLECTION_LOOK[id].color, 240, 96),
				key: `collection:${id}`,
				onRun: () => this.navigate(id === "recent" ? "recent" : { collection: id }),
			})),
			tags: this.tagChips(tags.slice(0, DASH_TAGS), subjects),
			moreTags: tags.length > DASH_TAGS ? () => this.navigate("tags") : null,
			recent: byModified.slice(0, DASH_ROWS).map((e) => this.notebookRow(e, now)),
			moreRecent: byModified.length > DASH_ROWS ? () => this.navigate("recent") : null,
			favourites: favourites.slice(0, DASH_FAVOURITES).map((e) => this.favouriteOptions(e, now)),
			moreFavourites: favourites.length > DASH_FAVOURITES ? () => this.navigate({ collection: "favourites" }) : null,
		});
		for (const thumb of Array.from(el.querySelectorAll<HTMLElement>(".nb-fav-thumb"))) this.watchThumb(thumb);
		for (const card of Array.from(el.querySelectorAll<HTMLElement>(".nb-subject-card"))) {
			const path = card.dataset.key?.slice("subject:".length);
			if (path) this.wireFolderCard(card, path);
		}
	}

	private renderSubjectsPage(el: HTMLElement, tree: FolderNode): void {
		const subjects = this.subjects(tree);
		if (subjects.length === 0) {
			this.renderEmpty(el, false);
			return;
		}
		const grid = el.createDiv({ cls: "nb-subject-grid is-tiles" });
		for (const s of subjects) this.wireFolderCard(subjectCard(grid, this.subjectCardOptions(s, "tile")), s.path);
	}

	private renderTagsPage(el: HTMLElement, tree: FolderNode): void {
		const tags = this.index.tags(this.notArchived);
		if (tags.length === 0) {
			el.createDiv({ cls: "notebook-lib-hint nb-hint", text: t("library.nav.noTags") });
			return;
		}
		renderTagChips(el, this.tagChips(tags, this.subjects(tree)));
	}

	private renderHomeSurface(el: HTMLElement, tree: FolderNode): void {
		const now = Date.now();
		const visible = this.visible();
		const subjects = this.subjects(tree);
		const lang = getLanguage();
		// Recent notes: the pages this device edited last (recent pages log); without a log, the notebooks changed last.
		const recent: ListRowOptions[] = [];
		const edits = this.host.recentEdits?.() ?? [];
		for (const x of edits) {
			if (recent.length >= DASH_ROWS) break;
			const e = this.index.get(x.path);
			if (!e || this.isArchived(e)) continue;
			const bookmark = e.bookmarks?.find((b) => b.page === x.num - 1);
			const meta = t("home.recent.page", { page: String(x.num), time: stampTime(x.at, now, lang) });
			recent.push({ ...this.notebookRow(e, now, meta, () => this.openEntry(e.path, x.num - 1)), title: bookmark ? bookmark.title : e.name, key: `recent:${x.path}#${x.page}` });
		}
		if (edits.length === 0) {
			for (const e of [...visible].sort((a, b) => b.modified - a.modified).slice(0, DASH_ROWS)) recent.push(this.notebookRow(e, now, stampTime(e.modified, now, lang)));
		}
		const kpis = statsOf(visible, edits, now, this.weeks);
		const look: Record<KpiId, { icon: string; color: string; label: MessageKey }> = {
			created: { icon: "file-plus", color: paletteColor("Blue"), label: "home.stats.created" },
			edited: { icon: "pencil", color: paletteColor("Violet"), label: "home.stats.edited" },
			pdf: { icon: "file-text", color: paletteColor("Pink"), label: "home.stats.pdf" },
			tags: { icon: "tag", color: paletteColor("Indigo"), label: "home.stats.tags" },
		};
		const open: Record<KpiId, () => void> = {
			created: () => {
				this.setSort("created");
				this.navigate("all");
			},
			edited: () => (this.host.openRecentPages ? this.host.openRecentPages() : this.navigate("recent")),
			pdf: () => this.navigate({ collection: "pdf" }),
			tags: () => this.navigate("tags"),
		};
		const stats = kpis.map((k): KpiTileOptions => {
			const d = deltaPercent(k);
			return {
				icon: look[k.id].icon,
				color: look[k.id].color,
				value: k.value.toLocaleString(lang),
				label: t(look[k.id].label),
				delta: d === null ? null : { text: `${d >= 0 ? "+" : ""}${d}%`, up: d >= 0, label: t("home.stats.delta") },
				series: k.series,
				key: `kpi:${k.id}`,
				onOpen: open[k.id],
			};
		});
		const root = this.root();
		const quick: QuickActionOptions[] = [
			{ icon: "file-plus", color: paletteColor("Violet"), title: t("home.quick.newNotebook"), description: t("home.quick.newNotebook.desc"), art: this.art("quick:new-notebook", paletteColor("Violet"), 240, 96), key: "quick:new-notebook", onRun: () => this.runCreate("new-notebook") },
			{ icon: "folder-plus", color: paletteColor("Blue"), title: t("home.quick.newFolder"), description: t("home.quick.newFolder.desc"), art: this.art("quick:new-folder", paletteColor("Blue"), 240, 96), key: "quick:new-folder", onRun: () => this.runCreate("new-folder") },
			{ icon: "file-up", color: paletteColor("Pink"), title: t("home.quick.importPdf"), description: t("home.quick.importPdf.desc"), art: this.art("quick:import-pdf", paletteColor("Pink"), 240, 96), key: "quick:import-pdf", onRun: () => this.host.importPdf(root) },
		];
		if (this.host.scanToNotebook) quick.push({ icon: "scan", color: paletteColor("Teal"), title: t("home.quick.scan"), description: t("home.quick.scan.desc"), art: this.art("quick:scan", paletteColor("Teal"), 240, 96), key: "quick:scan", onRun: () => this.host.scanToNotebook?.(root) });
		renderHome(el, {
			subjects: subjects.slice(0, DASH_SUBJECTS).map((s) => this.subjectCardOptions(s, "row")),
			moreSubjects: subjects.length > DASH_SUBJECTS ? () => this.navigate("subjects") : null,
			recent,
			moreRecent: edits.length > 0 && this.host.openRecentPages ? () => this.host.openRecentPages?.() : visible.length > DASH_ROWS ? () => this.navigate("recent") : null,
			stats,
			weeks: this.weeks,
			setWeeks: (w) => {
				this.weeks = w;
				this.app.workspace.requestSaveLayout();
				this.render();
			},
			quick,
		});
		for (const card of Array.from(el.querySelectorAll<HTMLElement>(".nb-subject-card"))) {
			const path = card.dataset.key?.slice("subject:".length);
			if (path) this.wireFolderCard(card, path);
		}
	}

	// ---------------------------------------------------------------- search

	private searchesWide(): boolean {
		const p = this.place;
		return this.searchWide ?? (p === "all" || p === "home" || p === "subjects" || p === "tags");
	}

	/** The scope and filter of the current place, for the grid and for a search of "this view". */
	private placeQuery(recursive: boolean): { scope: LibraryScope; filter: (e: LibraryEntry) => boolean } {
		const p = this.place;
		if (p === "archived") return { scope: "all", filter: this.isArchived };
		if (isCollectionPlace(p)) {
			const id = p.collection;
			const c = this.collectionCtx();
			return { scope: "all", filter: (e) => this.notArchived(e) && inCollection(id, e, c) };
		}
		if (p === "home" || p === "subjects" || p === "tags") return { scope: "all", filter: this.notArchived };
		if (isFolderPlace(p)) return { scope: { folder: p.folder, recursive }, filter: this.notArchived };
		return { scope: p, filter: this.notArchived };
	}

	/** Search results grouped by type (DESIGN.md §3): folders, tags, then notebooks with their matching page. */
	private renderSearch(el: HTMLElement, tree: FolderNode): void {
		const query = this.search.trim();
		const wide = this.searchesWide();
		const p = this.place;
		const scoped = !(p === "all" || p === "home" || p === "subjects" || p === "tags");
		if (scoped) {
			const label = wide ? t("library.search.everywhere") : isFolderPlace(p) ? t("library.search.thisFolder") : t("library.search.thisView");
			const b = el.createEl("button", { cls: "nb-chip notebook-lib-search-scope is-active", text: label, attr: { type: "button", "aria-pressed": String(wide), title: t("library.search.scope") } });
			b.addEventListener("click", () => {
				this.searchWide = !wide;
				this.requestRender();
			});
		}
		const terms = normalizeText(query).split(/\s+/).filter(Boolean);
		const matches = (name: string) => {
			const n = normalizeText(name);
			return terms.every((x) => n.includes(x));
		};
		let any = false;
		if (wide) {
			const folders = flattenTree(tree).filter((n) => n.path !== this.root() && matches(n.name)).slice(0, 8);
			if (folders.length > 0) {
				any = true;
				const sec = el.createEl("section", { cls: "nb-section nb-search-group" });
				sectionHeader(sec, { icon: "folder", title: t("lib.search.folders") });
				const list = sec.createDiv({ cls: "nb-panel nb-list" });
				const counts = this.folderCounts();
				for (const n of folders) {
					const row = listRow(list, {
						icon: "folder",
						title: n.name,
						meta: this.plural(counts.get(n.path) ?? 0, "library.notebooks.one", "library.notebooks.many"),
						pills: [],
						key: `sfolder:${n.path}`,
						menuLabel: t("library.menu.more"),
						onOpen: () => this.navigate({ folder: n.path }),
						onMenu: (anchor) => {
							const r = anchor.getBoundingClientRect();
							this.folderMenu(n.path, r.left, r.bottom);
						},
					});
					row.setAttribute(DROP_ATTR, n.path);
				}
			}
			const tags = this.index.tags(this.notArchived).filter((x) => matches(x.tag)).slice(0, 12);
			if (tags.length > 0) {
				any = true;
				const sec = el.createEl("section", { cls: "nb-section nb-search-group" });
				sectionHeader(sec, { icon: "tag", title: t("lib.search.tags") });
				renderTagChips(sec, this.tagChips(tags, this.subjects(tree)));
			}
		}
		const { scope, filter } = this.placeQuery(true);
		const hits = this.index.search({ search: query, scope: wide ? "all" : scope, sort: this.sort, filter: wide ? this.notArchived : filter });
		if (hits.length > 0) {
			any = true;
			const sec = el.createEl("section", { cls: "nb-section nb-search-group" });
			sectionHeader(sec, { icon: "library", title: t("lib.search.notebooks") });
			const grid = sec.createDiv({ cls: "notebook-lib-grid is-search", attr: { role: "list" } });
			const now = Date.now();
			for (const hit of hits.slice(0, this.gridLimit)) this.notebookCard(grid, hit.entry, now, hit);
			this.moreButton(sec, hits.length);
		}
		if (!any) this.renderEmpty(el, true);
	}

	private moreButton(parent: HTMLElement, total: number): void {
		if (total <= this.gridLimit) return;
		const b = parent.createEl("button", { cls: "nb-more-btn", text: t("lib.showMore", { n: String(Math.min(GRID_PAGE, total - this.gridLimit)) }), attr: { type: "button" } });
		b.addEventListener("click", () => {
			this.gridLimit += GRID_PAGE;
			this.render();
		});
	}

	// ---------------------------------------------------------------- notebook grid

	private renderGrid(el: HTMLElement, tree: FolderNode): void {
		const archivedView = this.place === "archived";
		const { scope, filter } = this.placeQuery(false);
		const found = this.index.query({ scope, sort: this.sort, filter });
		// Pinned notebooks first (not in Recent or the archive), then each group in manual order when that sort is chosen.
		const { pinned, rest } = arrangeEntries(found, this.keyOf, this.state, { manual: this.sort === "manual", pinnedFirst: this.place !== "recent" && !archivedView });
		this.arrangement = { pinned: pinned.map((e) => e.path), rest: rest.map((e) => e.path) };
		const folder = isFolderPlace(this.place) ? this.place.folder : null;
		const subfolders = folder !== null ? (flattenTree(tree).find((n) => n.path === folder)?.children ?? []) : [];

		if (pinned.length + rest.length === 0 && subfolders.length === 0) {
			this.renderEmpty(el, false);
			return;
		}
		if (this.sort === "manual" && pinned.length + rest.length > 1 && !archivedView) el.createDiv({ cls: "notebook-lib-hint nb-hint", text: t("library.manual.hint") });
		if (subfolders.length > 0) {
			const counts = this.folderCounts();
			const grid = el.createDiv({ cls: "nb-subject-grid is-tiles nb-subfolders" });
			for (const node of subfolders) this.folderCard(grid, node, counts.get(node.path) ?? 0);
		}
		const grid = el.createDiv({ cls: "notebook-lib-grid", attr: { role: "list" } });
		const now = Date.now();
		let shown = 0;
		const limit = this.gridLimit;
		if (pinned.length > 0) grid.createDiv({ cls: "notebook-lib-group", text: t("library.group.pinned") });
		for (const entry of pinned) if (shown++ < limit) this.notebookCard(grid, entry, now);
		if (pinned.length > 0 && rest.length > 0 && shown < limit) grid.createDiv({ cls: "notebook-lib-group", text: t("library.group.others") });
		for (const entry of rest) if (shown++ < limit) this.notebookCard(grid, entry, now);
		this.moreButton(el, pinned.length + rest.length);
	}

	private renderEmpty(el: HTMLElement, searching: boolean): void {
		const box = el.createDiv({ cls: "notebook-lib-empty" });
		const s = this.place;
		let title: string;
		let body = "";
		let actions = false;
		if (searching) {
			title = t("library.empty.search", { query: this.search.trim() });
		} else if (this.index.size === 0 && (s === "all" || s === "subjects" || isFolderPlace(s))) {
			title = t("library.empty.noneTitle");
			body = t("library.empty.noneBody");
			actions = true;
		} else if (s === "archived") {
			title = t("library.empty.archived");
		} else if (s === "subjects") {
			title = t("lib.empty.subjects");
			actions = true;
		} else if (s === "all" && this.index.size > 0) {
			title = t("library.empty.allArchived");
		} else if (isCollectionPlace(s) && s.collection === "favourites") {
			title = t("library.empty.favorites");
		} else if (s === "recent") {
			title = t("library.empty.recent");
		} else if (isTagPlace(s)) {
			title = t("library.empty.tag");
		} else if (isCollectionPlace(s)) {
			title = t("lib.empty.collection");
		} else {
			title = t("library.empty.folder");
			actions = isFolderPlace(s);
		}
		const emptyArt = searching ? undefined : this.art(`empty:${typeof s === "string" ? s : JSON.stringify(s)}`, paletteColor("Indigo"), 240, 120);
		if (emptyArt) box.createDiv({ cls: "nb-empty-art", attr: { "aria-hidden": "true" } }).setCssProps({ "--nb-art": `url("${emptyArt}")` });
		else setIcon(box.createDiv({ cls: "notebook-lib-empty-icon" }), searching ? "search-x" : "library");
		box.createDiv({ cls: "notebook-lib-empty-title", text: title });
		if (body) box.createDiv({ cls: "notebook-lib-empty-body", text: body });
		if (actions) {
			const row = box.createDiv({ cls: "notebook-lib-empty-actions" });
			const button = (icon: string, label: string, run: () => void, cta = false) => {
				const b = row.createEl("button", { cls: `nb-pill-btn${cta ? " mod-cta" : ""}`, attr: { type: "button" } });
				setIcon(b.createSpan({ attr: { "aria-hidden": "true" } }), icon);
				b.createSpan({ text: label });
				b.addEventListener("click", run);
			};
			button("file-plus", t("library.action.newNotebook"), () => this.newNotebook(), true);
			if (s === "subjects") button("folder-plus", t("library.action.newFolder"), () => this.newFolder());
			else button("file-up", t("library.action.importPdf"), () => this.host.importPdf(this.currentFolder()));
		}
	}

	private plural(count: number, one: MessageKey, many: MessageKey): string {
		return count === 1 ? t(one) : t(many, { count: String(count) });
	}

	private folderCard(grid: HTMLElement, node: FolderNode, count: number): void {
		const look = this.folderLook(node.path);
		const own = this.host.folderMeta?.getFolderMeta(node.path)?.color;
		const card = subjectCard(grid, {
			name: node.name,
			color: own ?? this.folderColor(node.path) ?? look.color,
			icon: look.icon,
			artStyle: look.artStyle,
			seed: node.path,
			lines: [this.plural(count, "library.notebooks.one", "library.notebooks.many")],
			shape: "tile",
			art: this.artOn(),
			key: `fcard:${node.path}`,
			onOpen: () => this.navigate({ folder: node.path }),
		});
		card.addClass("is-folder");
		this.wireFolderCard(card, node.path);
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

	/** The v11 cover of a notebook as an image URL: its generated art (cached) or its cover image; null for a plain colour. */
	private coverUrl(entry: LibraryEntry): string | null {
		const art = entry.coverArt;
		if (!art) return null;
		if (art.kind === "image") {
			const file = this.app.vault.getFileByPath(art.path);
			return file ? this.app.vault.getResourcePath(file) : null;
		}
		const surface = activeDocument.body.hasClass("theme-light") ? "light" : "dark";
		return coverImage({ seed: art.seed, color: entry.cover, style: art.style, surface }, 150, 200, Math.min(2, activeWindow.devicePixelRatio || 1)) || null;
	}

	private notebookCard(grid: HTMLElement, entry: LibraryEntry, now: number, hit?: SearchHit): void {
		const card = grid.createDiv({ cls: "notebook-lib-card", attr: { role: "listitem" } });
		card.dataset.path = entry.path;
		const pinned = this.isPinned(entry) && this.place !== "archived";
		card.toggleClass("is-pinned", pinned);
		// In manual order another card can be dropped here to take this place (same group only).
		if (!hit && this.sort === "manual" && this.reorderable(entry.path)) card.setAttribute(DROP_CARD_ATTR, entry.path);
		const placeholder = entry.mtime < 0;
		// wave 0.7: a 0-byte file is a notebook the sync client has not downloaded yet, not a damaged one (#344).
		const meta = placeholder ? "" : entry.pages === 0 ? t(entry.size === 0 ? "sync.library.notDownloaded" : "library.unreadable") : `${this.plural(entry.pages, "library.pages.one", "library.pages.many")} · ${relativeTime(entry.modified, now, getLanguage())}`;
		const main = card.createDiv({ cls: "notebook-lib-card-main", attr: { role: "button", tabindex: "0", "data-key": `card:${entry.path}`, "aria-label": [entry.name, meta].filter(Boolean).join(", ") } });
		const cover = main.createDiv({ cls: "notebook-lib-cover" });
		cover.setCssProps({ "--notebook-cover": entry.cover });
		// wave 0.12: a notebook made with a cover (format v11) shows it instead of its first page.
		const coverUrl = this.coverUrl(entry);
		if (coverUrl) {
			cover.addClass("has-art");
			cover.setCssProps({ "--notebook-cover-art": `url("${coverUrl}")` });
		}
		cover.createDiv({ cls: "notebook-lib-spine" });
		const pageEl = cover.createDiv({ cls: "notebook-lib-page", attr: { "data-thumb-path": entry.path } });
		if (pinned) setIcon(cover.createDiv({ cls: "notebook-lib-pin", attr: { role: "img", "aria-label": t("library.pinned"), title: t("library.pinned") } }), "pin");
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
		const tagHit = hit?.pageTag;
		const first = hit?.fields[0];
		const open = () => this.openEntry(entry.path, first === "text" ? textHit?.page : first === "pageTag" ? tagHit?.page : undefined);
		if (tagHit) {
			// v7: a page tag matched: the row opens that page.
			const row = card.createDiv({
				cls: "notebook-lib-hit",
				attr: { role: "button", tabindex: "0", "data-key": `taghit:${entry.path}`, "aria-label": t("library.search.openPage", { page: String(tagHit.page + 1) }) },
			});
			row.createSpan({ cls: "notebook-lib-hit-page", text: t("library.search.page", { page: String(tagHit.page + 1) }) });
			this.appendHighlight(row.createSpan({ cls: "notebook-lib-hit-snippet" }), { text: `#${tagHit.tag.text}`, ranges: tagHit.tag.ranges.map(([a, b]): [number, number] => [a + 1, b + 1]) });
			const openPage = () => this.openEntry(entry.path, tagHit.page);
			row.addEventListener("click", openPage);
			row.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openPage();
				}
			});
		}
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
				if (this.mode === "phone") this.setRailOpen(true);
				return createDiv({ cls: "notebook-lib-ghost", text: entry.name });
			},
			canDrop: (target) => {
				const other = target.getAttribute(DROP_CARD_ATTR);
				if (other !== null) return other !== entry.path && this.groupOf(other) !== null && this.groupOf(other) === this.groupOf(entry.path);
				return target.getAttribute(DROP_ATTR) !== (this.index.get(entry.path)?.folder ?? "");
			},
			onDrop: (target) => {
				const other = target.getAttribute(DROP_CARD_ATTR);
				if (other !== null) {
					const at = this.groupOf(other)?.indexOf(other) ?? -1;
					if (at >= 0) void this.placeAt(entry.path, at);
					return;
				}
				const file = this.app.vault.getFileByPath(entry.path);
				const folder = target.getAttribute(DROP_ATTR);
				if (file && folder !== null) void this.moveFile(file, folder);
			},
			onDragEnd: () => {
				if (this.mode === "phone") this.setRailOpen(false);
			},
		});

		this.watchThumb(pageEl);
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
		showNotice(t("library.notice.failed", { error: (e as Error).message ?? String(e) }));
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
		// Roadmap 54: pin, manual order (also on touch, where dragging is a long press) and the archive.
		const archived = this.isArchived(entry);
		if (!archived) menu.addItem((i) => i.setTitle(this.isPinned(entry) ? t("library.menu.unpin") : t("library.menu.pin")).setIcon(this.isPinned(entry) ? "pin-off" : "pin").onClick(() => void this.togglePinned(path)));
		if (!archived && this.reorderable(path)) {
			const group = this.groupOf(path)!;
			const at = group.indexOf(path);
			if (at > 0) menu.addItem((i) => i.setTitle(t("library.menu.moveUp")).setIcon("arrow-up").onClick(() => void this.moveBy(path, -1)));
			if (at < group.length - 1) menu.addItem((i) => i.setTitle(t("library.menu.moveDown")).setIcon("arrow-down").onClick(() => void this.moveBy(path, 1)));
		}
		menu.addItem((i) => i.setTitle(archived ? t("library.menu.unarchive") : t("library.menu.archive")).setIcon(archived ? "archive-restore" : "archive").onClick(() => void this.toggleArchived(path)));
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
		menu.addItem((i) => i.setTitle(t("library.menu.newFolderHere")).setIcon("folder-plus").onClick(() => this.host.createFolder(path)));
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
			if (!name) return void showNotice(t("library.notice.invalidName"));
			if (name === file.basename) return;
			const target = this.joinPath(folderOf(file.path), `${name}.${file.extension}`);
			if (this.exists(target)) return void showNotice(t("library.notice.exists", { name }));
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
		const trash = this.host.trash;
		if (trash) return confirmMoveToTrash(this.app, { name: file.basename, isFolder: false }, () => trash.trash(file), (e) => this.fail(e));
		new ConfirmModal(
			this.app,
			{ title: t("library.modal.deleteTitle"), body: t("library.modal.deleteBody", { name: file.basename }), cta: t("library.modal.deleteConfirm") },
			() => void this.app.fileManager.trashFile(file).catch((e) => this.fail(e)),
		).open();
	}

	private askTags(path: string): void {
		const entry = this.index.get(path);
		if (!entry) return;
		// O2: suggestions from Obsidian's tags, Obsidian-style normalisation, hint about companion notes (integration/tags.ts).
		openTagEditor(this.app, { file: this.app.vault.getFileByPath(path), current: entry.tags, libraryTags: this.index.tags().map((x) => x.tag), onSave: (tags) => this.setMeta(path, { tags }) });
	}

	private askCover(path: string): void {
		const entry = this.index.get(path);
		if (!entry) return;
		new CoverModal(this.app, entry.cover, (cover) => void this.setMeta(path, { cover })).open();
	}

	private askRenameFolder(path: string): void {
		const folder = this.app.vault.getFolderByPath(path);
		if (!folder) return;
		new PromptModal(this.app, { title: t("library.modal.renameFolder"), label: t("library.modal.name"), value: folder.name, cta: t("library.modal.save") }, (value) => {
			const name = sanitizeName(value);
			if (!name) return void showNotice(t("library.notice.invalidName"));
			if (name === folder.name) return;
			const target = this.joinPath(folderOf(path), name);
			if (this.exists(target)) return void showNotice(t("library.notice.exists", { name }));
			this.app.fileManager.renameFile(folder, target).catch((e) => this.fail(e));
		}).open();
	}

	private askDeleteFolder(path: string): void {
		const folder = this.app.vault.getFolderByPath(path);
		if (!folder) return;
		const trash = this.host.trash;
		if (trash) {
			const { notebooks, others } = folderContents(folder);
			if (others.length === 0) return confirmMoveToTrash(this.app, { name: folder.name, isFolder: true }, () => trash.trash(folder), (e) => this.fail(e));
			// The folder holds the user's own files too: list them and let the user choose (never moved silently).
			const opts = { name: folder.name, path: folder.path, notebooks: notebooks.length, others: others.map((f) => f.path) };
			new FolderToTrashModal(this.app, opts, (choice) => {
				void (async () => {
					if (choice === "everything") {
						await trash.trash(folder);
						showNotice(t("trash.notice.moved", { name: folder.name }));
						return;
					}
					for (const nb of notebooks) await trash.trash(nb);
					showNotice(t("trash.notice.movedNotebooks", { n: String(notebooks.length), name: folder.name }));
				})().catch((e) => this.fail(e));
			}).open();
			return;
		}
		if (folder.children.length > 0) {
			showNotice(t("library.notice.folderNotEmpty", { name: folder.name }));
			return;
		}
		new ConfirmModal(
			this.app,
			{ title: t("library.modal.deleteFolderTitle"), body: t("library.modal.deleteFolderBody", { name: folder.name }), cta: t("library.modal.deleteConfirm") },
			() => void this.app.fileManager.trashFile(folder).catch((e) => this.fail(e)),
		).open();
	}
}
