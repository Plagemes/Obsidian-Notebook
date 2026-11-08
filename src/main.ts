import { setLongPressHelpEnabled } from "./ui/long-press-help";
import { trackWriting } from "./view/writing-quiet";
import { registerHints } from "./ui/hints";
import { showNotice } from "./view/notice";
import { setArtCacheScope } from "./ui/art/generative-art";
import { Platform, Plugin, TFile } from "obsidian";
import { onLanguageChanged, setUiLanguage, t } from "./i18n";
import { readSettings, type NotebookSettings } from "./settings";
import { positionEquals, type SavedPosition } from "./ink/view-position";
import { stressDocument } from "./model/stress";
import { NOTEBOOK_EXTENSIONS } from "./storage/format";
import { recordRename } from "./storage/renamed-notes";
import { journalReader } from "./library/library-check-modal";
import type { StorageEnv } from "./library/storage-actions";
import { AdapterJournalStore, journalFolder, sidecarDeviceId, vaultDeviceFileAdapter } from "./storage/vault-io";
import { SharedClipStore } from "./storage/shared-clip-store";
import { createNotebook } from "./storage/notebooks";
import { registerFolderMeta } from "./library/folder-meta-events";
import { registerCollections } from "./library/collections-events";
import { BenchmarkModal } from "./view/benchmark";
import { PenTestModal, penSignalInfo } from "./view/pen-test-modal";
import { NotebookLibraryHost } from "./library/host";
import { SharedInbox } from "./library/shared-inbox";
import { registerIntegration } from "./integration";
import { registerGalleryBlock } from "./integration/gallery";
import type { GalleryService } from "./integration/gallery-service";
import { annotatePdfFlow, registerAnnotatePdf, type AnnotatePdfHost } from "./library/annotate-pdf";
import { registerHoverPreview } from "./view/hover-preview";
import { registerReferenceMenu } from "./view/ref-window-open";
import type { HistoryService } from "./integration/history-service";
import type { NotebookApi } from "./integration/api";
import { registerReliability } from "./integration/reliability";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./library/library-view";
import { registerActionCommands } from "./view/commands";
import { openLooseSheet } from "./library/loose-sheet";
import { openTodaysPage } from "./library/daily";
import { OpenNotebookModal } from "./view/modals";
import { openNotebookAtPage } from "./integration/open";
import { NotebookView, VIEW_TYPE } from "./view/notebook-view";
import { NotebookSettingTab } from "./view/settings-tab";
import { registerLectureRibbon } from "./view/lecture-commands";
import type { LectureClass } from "./timetable/lecture-mode";
import { LectureLogService } from "./library/lecture-log";
import type { LectureSnapshot } from "./library/lecture-log-logic";
import { TimetableService } from "./timetable/service";
import { initPdfSync } from "./view/pdf-sync";
import { inboxService, registerZettel } from "./zettel";
import { HOME_VIEW_TYPE, HomeView } from "./library/home-view";
import type { InboxPort } from "./library/inbox-bell";
import type { LibraryPlace } from "./library/library-view";
import { openInbox, processNextInbox } from "./zettel/inbox";
import type { InboxService } from "./zettel/inbox-service";
import { registerTextbookRefs } from "./view/textbook-ref-ui";
import { PracticeService } from "./view/practice";
import { openPageSwitcher, QuickNavService } from "./view/quick-switcher";
import { openRecentPages, RecentPagesService } from "./view/recent-pages";
import { SyncSafetyService } from "./view/sync-safety";
import type { NavController } from "./view/nav-controller";
import { registerNavigation } from "./view/nav-service";
import { QuickTabsStore } from "./library/quicktabs-store";
import { MeaningsStore } from "./library/meanings-store";
import { QuickTabsService } from "./view/quick-tabs-service";
import { BookmarksStore } from "./library/bookmarks-store";
import { BookmarksService } from "./view/bookmarks-service";
import { openBookmarks } from "./view/bookmarks-dialog";
import { NotebookStatusBar } from "./view/status-bar";
import { registerResilience, type ResilienceServices } from "./view/resilience";
import { PdfCopyService } from "./storage/pdf-copy-service";
import { PdfCopyStore } from "./storage/pdf-copy-store";
import { BackupService } from "./storage/backup-service";
import { obsidianSyncAuth } from "./sync/auth/obsidian-auth";
import { CloudSyncService } from "./sync/sync-service";
import { CloudDeletesModal, CloudLargeModal } from "./view/cloud-sync-modals";

export default class NotebookPlugin extends Plugin {
	settings!: NotebookSettings;
	private host!: NotebookLibraryHost;
	/** 0.16 (#177): PDFs and images shared to the vault from other apps. */
	private sharedInbox?: SharedInbox;
	journal!: AdapterJournalStore;
	/** Class timetable (wave 0.6). */
	timetable!: TimetableService;
	/** 0.19 (#221): one line per lecture in the daily note. */
	private lectureLog: LectureLogService | null = null;
	/** wave 0.7: quick navigation (364-366). */
	recentPages!: RecentPagesService;
	/** wave 0.10 (18): back/forward history of visited pages (view/nav-controller.ts). */
	nav!: NavController;
	/** 0.18 (#227): quick tabs, pages pinned in a notebook (one file per device in `_meta`, library/quicktabs-store.ts). */
	quickTabs!: QuickTabsService;
	/** 0.24 (#265): global bookmarks (one file per device in `_meta`, library/bookmarks-store.ts). */
	bookmarks!: BookmarksService;
	/** 0.22 (#101): per-notebook colour meanings (one file per device in `_meta`, library/meanings-store.ts). */
	meanings!: MeaningsStore;
	private statusBar: NotebookStatusBar | null = null;
	/** Public API for other plugins and scripts (docs/api.md). */
	api?: NotebookApi;
	/** Wave 0.9: practice copies of exercises (view/practice.ts); the views attach to it. */
	practice!: PracticeService;
	/** ui redesign: the plugin-level actions of the registry (ui/actions.ts), by id. */
	private globalActions: Record<string, () => void> = {};
	/** wave 0.7: sync safety (presence files, sync check). */
	syncSafety!: SyncSafetyService;
	/** wave 0.7: resilience: safe mode, storage-full warning, integrity check (view/resilience.ts). */
	resilience?: ResilienceServices;
	/** Version history (set by registerIntegration), for the integrity check. */
	private history: HistoryService | null = null;
	/** 0.17 (#23): the optional PDF copy next to each notebook (storage/pdf-copy-service.ts). */
	pdfCopy?: PdfCopyService;
	/** 0.21 (#127): scheduled zip backups into a vault folder (storage/backup-service.ts). */
	backups?: BackupService;
	/** 0.22 synccore (#126): the optional cloud sync (sync/sync-service.ts); off until a service is chosen and signed in. */
	cloudSync?: CloudSyncService;
	/** wave 0.10 (362): the clipboard shared between devices; one store (one write queue) for every view. */
	private sharedClipStore: SharedClipStore | null = null;

	/**
	 * 0.12.1: the start-up steps that failed (logged to the console, reported once in a notice). A step that throws no
	 * longer aborts `onload`: before, one failure stopped the rest of the start-up, the settings tab among them.
	 */
	readonly startupFailures: string[] = [];

	async onload(): Promise<void> {
		this.settings = await this.readStoredSettings();
		setLongPressHelpEnabled(this.settings.iconHelp);
		// Command names (below) are registered once, so they follow the language at startup.
		this.step("language", () => setUiLanguage(this.settings.uiLanguage));
		// 0.13 polish: the picture cache (IndexedDB) is per vault; IndexedDB itself is shared by every vault on the device.
		this.step("art cache", () => setArtCacheScope(this.app.vault.getName()));
		this.step("appearance", () => this.applyAppearanceStyle());
		// 0.12.1: the settings tab first, so that no later step can take it away. It reads the services below lazily.
		this.step("settings tab", () => this.addSettingTab(new NotebookSettingTab(this.app, this)));
		this.step("language notice", () => this.register(onLanguageChanged(() => showNotice(t("settings.uiLanguage.changed")))));
		// wave 0.8 (374): notices and non-urgent background work wait while the pen is on the screen.
		this.step("writing tracker", () => trackWriting(this));
		this.step("hints", () => registerHints(this));

		this.step("practice", () => {
			this.practice = new PracticeService(this);
		});
		this.step("journal", () => {
			this.journal = new AdapterJournalStore(this.app.vault.adapter, journalFolder(this.app, this.manifest.id));
		});
		this.step("sync safety", () => {
			this.syncSafety = new SyncSafetyService(this);
			this.syncSafety.register();
		});
		// wave 0.7: resilience (#346 safe mode, #347 storage full, #390 integrity check); before the views exist.
		this.step("resilience", () => {
			this.resilience = registerResilience(this, () => this.history);
		});
		this.step("notebook view", () => {
			this.registerView(VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
			this.registerExtensions([...NOTEBOOK_EXTENSIONS], VIEW_TYPE);
		});
		this.step("library", () => {
			this.host = new NotebookLibraryHost(this);
			this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new LibraryView(leaf, this.host));
			// 0.12: Home (the library view on its Home surface); the rail, the quick actions and the bell reach the plugin through the host.
			this.registerView(HOME_VIEW_TYPE, (leaf) => new HomeView(leaf, this.host));
			Object.assign(this.host, {
				runAction: (id: string): boolean => {
					const run = this.globalActions[id];
					if (!run) return false;
					run();
					return true;
				},
				openSettings: () => {
					const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
					setting?.open();
					setting?.openTabById(this.manifest.id);
				},
				recentEdits: () => this.recentPages?.items() ?? [],
				inbox: () => {
					const service = inboxService(this);
					return service ? this.inboxPort(service) : null;
				},
				sharedInbox: () => this.sharedInbox ?? null,
			});
			// 0.16 (#177): watches the folder shared files land in.
			this.sharedInbox = new SharedInbox({
				app: this.app,
				settings: () => this.settings,
				pageSizes: (id) => this.host.pdf.pageSizes(id),
				importPdfFrom: (folder, file) => this.host.importPdfFrom(folder, file),
				openNotebook: (file) => this.host.openNotebook(file),
			});
			this.sharedInbox.start(this);
			// wave 0.6: library trash auto-empty (setting, off by default)
			this.app.workspace.onLayoutReady(() => void this.host.trash.purgeExpired().catch((e) => console.error("[notebook] trash auto-empty failed", e)));
		});
		// wave 0.12: folder colours and icons follow renames and other devices' changes (library/folder-meta-events.ts).
		this.step("folder metadata", () => registerFolderMeta(this, this.host.folderMeta));
		// 0.21 (#127): scheduled zip backups; the settings tab and the "backup-now" command reach the service through `backups`.
		this.step("backups", () => {
			this.backups = new BackupService({ app: this.app, settings: () => this.settings, flush: () => this.flushAll() });
			this.backups.register(this);
		});
		// 0.22 synccore (#126): the optional Google Drive / OneDrive sync. The providers' sign-in is plugged in with `setAuth`.
		this.step("cloud sync", () => {
			this.cloudSync = new CloudSyncService({
				app: this.app,
				pluginId: this.manifest.id,
				deviceId: sidecarDeviceId(this.app),
				settings: () => this.settings,
				flushAll: () => this.flushAll(),
				settle: async (path) => {
					const view = this.views().find((v) => v.file?.path === path);
					return view ? view.flushNow() : true;
				},
				deviceName: () => this.syncSafety?.presence.device().name ?? "",
				confirmDeletes: (items, decide) => new CloudDeletesModal(this.app, items, decide).open(),
				confirmLarge: (items, limit, decide) => new CloudLargeModal(this.app, items, limit, decide).open(),
			});
			// The providers' sign-in (device code, Google Drive / OneDrive) over the device-local token store.
			this.cloudSync.setAuth(obsidianSyncAuth(this.app));
			this.cloudSync.register(this);
		});
		// 0.17 (#23): the PDF copy of a notebook, kept up to date in the background when the reader asks for it.
		this.step("pdf copy", () => {
			const store = new PdfCopyStore(vaultDeviceFileAdapter(this.app), () => this.settings.folder, sidecarDeviceId(this.app));
			this.pdfCopy = new PdfCopyService({ app: this.app, settings: () => this.settings, saveSettings: () => this.saveSettings(), store, mobile: Platform.isMobile });
			this.pdfCopy.register(this);
		});
		// 0.17 (#120): saved collections are read at start and follow other devices' files.
		this.step("collections", () => registerCollections(this, this.host.collections));
		this.step("ribbon", () => this.addRibbonIcon("home", t("home.command"), () => void this.openLibrary("home")));

		// wave p1b: repair (#140), conflicted copies (#122), page restore (#180).
		this.step("reliability", () => registerReliability(this, this, () => this.views(), () => this.app.workspace.getActiveViewOfType(NotebookView)));

		this.step("lecture ribbon", () => registerLectureRibbon(this, (file) => this.host.openNotebook(file)));
		// Wave 0.6: synchronised PDF <-> notes view (view/pdf-sync.ts).
		this.step("pdf sync", () => initPdfSync(this, () => this.settings.folder));

		// wave 0.7: quick nav (page switcher, recently edited pages; "Go to page number" is a view action of the registry)
		this.step("recent pages", () => {
			this.recentPages = new RecentPagesService(this.app, (file) => this.host.readNotebook(file));
			this.recentPages.register(this);
			Object.assign(this.host, { openRecentPages: () => openRecentPages(this.app, this.recentPages), activity: () => this.recentPages.activity() });
		});
		// wave 0.10: back/forward history of visited pages (18) and the status bar item (O15); views reach both through the host.
		this.step("navigation", () => {
			this.nav = registerNavigation(this, (file) => this.host.readNotebook(file));
		});
		// 0.18 (#227): quick tabs follow the vault and other devices' files.
		this.step("quick tabs", () => {
			const store = new QuickTabsStore(vaultDeviceFileAdapter(this.app), () => this.settings.folder, sidecarDeviceId(this.app));
			this.quickTabs = new QuickTabsService({ app: this.app, store, readNotebook: (file) => this.host.readNotebook(file), notebooksFolder: () => this.settings.folder });
			this.quickTabs.register(this);
		});
		// 0.24 (#265): global bookmarks follow the vault, renamed notebooks and other devices' files; Home reaches the list through the library host.
		this.step("global bookmarks", () => {
			const store = new BookmarksStore(vaultDeviceFileAdapter(this.app), () => this.settings.folder, sidecarDeviceId(this.app));
			this.bookmarks = new BookmarksService({
				app: this.app, store, readNotebookId: (file) => this.host.readNotebookId(file), readNotebook: (file) => this.host.readNotebook(file), notebooksFolder: () => this.settings.folder,
			});
			this.bookmarks.register(this);
			Object.assign(this.host, { bookmarksCount: () => this.bookmarks.count(), openBookmarks: () => openBookmarks(this.app, this.bookmarks), onBookmarksChange: (fn: () => void) => this.bookmarks.onChange(fn) });
		});
		// 0.22 (#101): per-notebook colour meanings follow other devices' files.
		this.step("colour meanings", () => {
			const store = new MeaningsStore(vaultDeviceFileAdapter(this.app), () => this.settings.folder, sidecarDeviceId(this.app));
			this.meanings = store;
			const load = () => void store.load().catch((e) => console.error("[notebook] colour meanings could not be read", e));
			this.app.workspace.onLayoutReady(load);
			const changed = (file: unknown) => {
				if (file instanceof TFile && store.watches(file.path)) load();
			};
			this.registerEvent(this.app.vault.on("create", changed));
			this.registerEvent(this.app.vault.on("modify", changed));
			this.registerEvent(this.app.vault.on("delete", changed));
		});
		this.step("status bar", () => this.registerStatusBar());
		let quickNav: QuickNavService | null = null;
		this.step("quick navigation", () => {
			quickNav = new QuickNavService(this.app, {
				root: () => this.settings.folder,
				loadIndex: () => this.host.loadIndex(),
				saveIndex: (data) => this.host.saveIndex(data),
				readNotebook: (file) => this.host.readNotebook(file),
				thumbnailBackground: (doc, page, width) => this.host.thumbnailBackground(doc, page, width),
			}, this.recentPages);
		});

		// ui redesign: every command of the plugin comes from the action registry (ui/actions.ts); ids are unchanged.
		this.globalActions = {
			"create": () => this.askNewNotebook(),
			// wave 0.12: the creation dialog (library/host.ts openCreate); the library passes its current folder to the host directly.
			"new-notebook": () => this.host.createNotebook(),
			"new-folder": () => this.host.createFolder(),
			"open": () => this.openPicker(),
			"continue-last": () => void this.continueLast(),
			"open-library": () => void this.openLibrary("all"),
			"open-home": () => void this.openLibrary("home"),
			"import-pdf": () => this.host.importPdf(this.settings.folder),
			"lecture-from-slides": () => this.host.lectureFromSlides(),
			"scan-new": () => this.host.scanToNotebook(this.settings.folder),
			"loose-sheet": () => void openLooseSheet(this, (file) => this.host.openNotebook(file)),
			"todays-page": () => void openTodaysPage(this, (file) => this.host.openNotebook(file)),
			"timetable": () => void this.timetable.edit(),
			"open-class": () => this.timetable.openNow(),
			"pen-button-test": () => new PenTestModal(this.app, penSignalInfo(this)).open(),
			"go-to-page": () => {
				if (quickNav) openPageSwitcher(quickNav);
			},
			"recent-pages": () => openRecentPages(this.app, this.recentPages),
			"bookmarks-open": () => openBookmarks(this.app, this.bookmarks),
			"sync-check": () => void this.syncSafety.openCheck(),
			"check-integrity": () => void this.resilience?.check(),
			"library-check": () => this.host.checkLibrary(),
			"storage-manager": () => this.host.openStorage(),
			"backup-now": () => void this.backups?.backUpNow(),
			"cloud-sync-now": () => void this.cloudSync?.syncNow(),
			"zettel-inbox": () => void openInbox(this.app),
			"zettel-inbox-process": () => void processNextInbox(this.app),
			"benchmark": () => this.openBenchmark(),
			"create-stress-test": () => void this.createStressNotebook(),
		};
		this.step("commands", () => {
			const missing = registerActionCommands(this, {
				activeView: () => this.app.workspace.getActiveViewOfType(NotebookView),
				globals: this.globalActions,
			});
			if (missing.length) console.error("[notebook] actions without a handler:", missing.join(", "));
		});

		this.step("integration", () => {
			this.history = registerIntegration(this, {
				background: (doc, page, width) => this.host.thumbnailBackground(doc, page, width),
				newNotebookIn: (folder) => this.host.createNotebook(folder),
				annotatePdf: (pdf) => void annotatePdfFlow(this.app, this.annotateHost(), pdf),
			});
			registerAnnotatePdf(this, this.annotateHost());
		});
		// 0.17 (O5): hovering a notebook page link shows the page thumbnail (Page preview core plugin)
		this.step("hover preview", () => registerHoverPreview(this, {
			readNotebook: (file) => this.host.readNotebook(file),
			background: (doc, page, width) => this.host.thumbnailBackground(doc, page, width),
		}));
		// 0.20 (#107): "Open as reference" in the file menu
		this.step("reference window", () => registerReferenceMenu(this));
		// wave 0.6: zettelkasten (M15 Z1–Z3, Z11, Z12)
		this.step("zettelkasten", () => registerZettel(this));
		// wave 0.8: quick textbook reference (roadmap 208): "p. 134" in a text box opens the textbook at that page
		this.step("textbook references", () => registerTextbookRefs(this, () => this.settings.folder));

		// wave 0.9: redo the exercise (#303): practice copies, attempts, peek, timer (view/practice.ts)
		this.step("practice start", () => this.practice.start());

		// wave 0.6: timetable (src/timetable/): current class offer, library shortcut, editor.
		this.step("timetable", () => {
			this.timetable = new TimetableService(this, (file) => this.host.openNotebook(file));
			this.timetable.start();
		});

		// 0.26 (#421): the `notebook-gallery` block and its builder.
		this.step("gallery", () => {
			this.gallery = registerGalleryBlock(this, {
				root: () => this.settings.folder, loadIndex: () => this.host.loadIndex(), readNotebook: (file) => this.host.readNotebook(file),
				background: (doc, page, width) => this.host.thumbnailBackground(doc, page, width), timetable: () => this.timetable?.data(),
				bookmarks: () => this.bookmarks?.list() ?? [], onBookmarksChange: (fn) => this.bookmarks.onChange(fn),
			});
		});

		// 0.19 (#221): lecture log lines that waited for a daily note are written once it exists.
		this.step("lecture log", () => {
			const log = (this.lectureLog = new LectureLogService(this));
			// Registered once the layout is ready: while the vault loads, Obsidian fires "create" for every file in it.
			this.app.workspace.onLayoutReady(() => {
				void log.flushPending();
				// A waiting note that appears or changes (a sync, a template engine filling a new daily note) is looked at once it has settled.
				const changed = (f: { path: string }): void => {
					if (this.settings.lectureLog) log.noteChanged(f.path);
				};
				this.registerEvent(this.app.vault.on("create", changed));
				this.registerEvent(this.app.vault.on("modify", changed));
			});
		});

		// 0.19 (#103): notes renamed or moved are remembered on this device for a while, so a checkbox linked to a task in a note that was
		// renamed while its notebook was closed finds the note again (model/rename-map.ts). Registered once the layout is ready.
		this.step("renamed notes", () => {
			this.app.workspace.onLayoutReady(() => {
				this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
					// (a note, or a folder with notes in it)
					if (!("extension" in file) || file.extension === "md") recordRename(this.app, oldPath, file.path);
				}));
			});
		});

		// Best effort only (not guaranteed, unreliable on mobile): views also flush on visibilitychange/pagehide.
		this.step("quit flush", () => this.registerEvent(this.app.workspace.on("quit", () => void this.flushAll())));

		if (this.startupFailures.length > 0) {
			const steps = this.startupFailures.join(", ");
			this.app.workspace.onLayoutReady(() => showNotice(t("notice.startupFailed", { steps }), 15000));
		}
	}

	/**
	 * 0.12.1: runs one start-up step. A step that throws is logged and recorded in `startupFailures`, and the start-up
	 * goes on: one failing feature never takes the settings tab, the views or the commands down with it.
	 */
	private step(name: string, run: () => void): void {
		try {
			run();
		} catch (e) {
			this.startupFailures.push(name);
			console.error(`[notebook] start-up step "${name}" failed; the other features still start`, e);
		}
	}

	/**
	 * The stored settings. 0.12.1: an unreadable data.json no longer aborts the start-up: the plugin starts on the
	 * defaults and never writes them over the stored file in this session (zero data loss), so it can be repaired.
	 */
	private async readStoredSettings(): Promise<NotebookSettings> {
		try {
			return readSettings(await this.loadData());
		} catch (e) {
			this.settingsUnreadable = true;
			this.startupFailures.push("settings file");
			console.error("[notebook] the plugin settings (data.json) could not be read; using the defaults without saving them", e);
			return readSettings(null);
		}
	}

	/** Set when data.json could not be read: the settings are never saved over it (see `readStoredSettings`). */
	private settingsUnreadable = false;

	onunload(): void {
		// 0.12.1: each step is independent, and a service whose start-up step failed may not exist.
		const stop = (name: string, run: () => void): void => {
			try {
				run();
			} catch (e) {
				console.error(`[notebook] stopping "${name}" failed`, e);
			}
		};
		stop("last location", () => {
			if (this.rememberTimer !== null) this.writeLocation();
		});
		stop("recent pages", () => this.recentPages?.flush());
		stop("views", () => void this.flushAll());
		stop("sync safety", () => this.syncSafety?.dispose());
		stop("lecture log", () => this.lectureLog?.dispose());
		stop("timetable", () => this.timetable?.stop());
		stop("gallery", () => this.gallery?.dispose());
		stop("library", () => this.host?.dispose());
		stop("appearance", () => activeDocument.body.removeClass("notebook-style-obsidian"));
	}

	async saveSettings(): Promise<void> {
		if (this.settingsUnreadable) showNotice(t("notice.settingsNotSaved"));
		else await this.saveData(this.settings);
		this.applyAppearanceStyle();
		setLongPressHelpEnabled(this.settings.iconHelp);
		for (const view of this.views()) view.applySettings(this.settings);
	}

	/** DESIGN.md §2.2, Appearance → Style: "Follow Obsidian theme" maps the global `--nb-*` tokens onto Obsidian's variables. */
	private applyAppearanceStyle(): void {
		activeDocument.body.toggleClass("notebook-style-obsidian", this.settings.appearanceStyle === "obsidian");
	}

	private views(): NotebookView[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE)
			.map((leaf) => leaf.view)
			.filter((view): view is NotebookView => view instanceof NotebookView);
	}

	private flushAll(): Promise<unknown> {
		return Promise.all(this.views().map((v) => v.flushNow().catch((e) => console.error("[notebook] flush failed", e))));
	}

	/** 0.22 (#53): "Change cover…" from the notebook tab's menu. */
	changeCover(file: TFile): void {
		this.host.changeCover(file);
	}

	/** ui redesign: runs a plugin-level action of the registry (the notebook tab's menu). */
	runGlobal(id: string): void {
		this.globalActions[id]?.();
	}

	/** wave 0.10 (362): the store of this device's shared clipboard file, shared by the views so two of them never race on it. */
	sharedClips(): SharedClipStore {
		return (this.sharedClipStore ??= new SharedClipStore(vaultDeviceFileAdapter(this.app), () => this.settings.folder, sidecarDeviceId(this.app)));
	}

	/** ui redesign: the course of the class on now (timetable), for the lecture contextual bar; null when none. */
	classNow(): string | null {
		return this.timetable?.nowClass()?.course ?? null;
	}

	/** 0.14 (401): the class in progress that belongs to the notebook at `path`, for automatic lecture mode; null when none. */
	lectureClassFor(path: string): LectureClass | null {
		return this.timetable?.lectureClassFor(path) ?? null;
	}

	/** 0.22 (#210): the class for the lecture header of the notebook at `path` (the one in progress, else with `nearest` the closest of today). */
	lectureHeaderClassFor(path: string, nearest: boolean): LectureClass | null {
		return this.timetable?.headerClassFor(path, nearest) ?? null;
	}

	/**
	 * 0.19 (222): a lecture ended in the notebook at `path` (lecture mode left, class over or the notebook closed, after
	 * writing during the class). `saved` says the view's flush wrote everything; the snapshot is taken from the file on disk.
	 */
	lectureEnded(path: string, course: string, saved: boolean): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		void this.history?.lectureSnapshot(file, course, { wrote: true, saved });
	}

	/** 0.19 (#221): a lecture the user wrote in ended; its line is written to (or updated in) the daily note when the setting is on. */
	logLecture(file: TFile, cls: LectureClass, snap: LectureSnapshot, docId?: string): void {
		if (this.settings.lectureLog) void this.lectureLog?.log(file, cls, snap, docId);
	}

	/** wave 0.10 (O15): Obsidian's status bar item shows the page and save state of the active notebook. Desktop only: mobile has no status bar. */
	private registerStatusBar(): void {
		if (Platform.isMobile) return;
		const bar = new NotebookStatusBar(this.addStatusBarItem(), () => this.app.workspace.getActiveViewOfType(NotebookView)?.openNavigator());
		this.statusBar = bar;
		const refresh = (): void => bar.update(this.app.workspace.getActiveViewOfType(NotebookView)?.statusSnapshot() ?? null);
		this.registerEvent(this.app.workspace.on("active-leaf-change", refresh));
		this.app.workspace.onLayoutReady(refresh);
	}

	/** wave 0.10 (O15): the page in view or the save state of a view changed. */
	statusChanged(view: NotebookView): void {
		if (view === this.app.workspace.getActiveViewOfType(NotebookView)) this.statusBar?.update(view.statusSnapshot());
	}

	/** wave 0.7: a real edit; the recent pages log collapses and stores it (device-local). */
	edited(nb: string, path: string, pageId: string, num: number): void {
		this.recentPages?.note(nb, path, pageId, num);
	}

	/** wave 0.9 (379): when this device last edited the page, if it has a record (the recent pages log). */
	/** 0.17: the journal location for the in-view merge / split / extract (same as the library's flows). */
	transferJournal(): StorageEnv["journal"] {
		return { reader: journalReader(this.app), folder: journalFolder(this.app, this.manifest.id) };
	}

	pageEditedAt(nb: string, pageId: string): number | null {
		return this.recentPages?.pageEditedAt(nb, pageId) ?? null;
	}

	/** Instant start: remembers the page being read (called a moment after it changes). Only the plugin settings are written. */
	remember(path: string, page: number, pos: SavedPosition | null = null): void {
		const s = this.settings;
		const samePlace = s.lastNotebookPath === path && s.lastNotebookPage === page;
		if (samePlace && positionEquals(s.lastNotebookPos, pos)) return;
		s.lastNotebookPath = path;
		s.lastNotebookPage = page;
		s.lastNotebookPos = pos;
		// A new page is written at once; zoom and scroll alone only every few seconds, so a long read does not make Sync busy.
		if (this.rememberTimer !== null) window.clearTimeout(this.rememberTimer);
		this.rememberTimer = null;
		if (!samePlace) this.writeLocation();
		else this.rememberTimer = window.setTimeout(() => this.writeLocation(), 5000);
	}

	private rememberTimer: number | null = null;
	/** 0.26 (#421): the data behind the gallery blocks. */
	private gallery: GalleryService | null = null;

	private writeLocation(): void {
		if (this.rememberTimer !== null) window.clearTimeout(this.rememberTimer);
		this.rememberTimer = null;
		if (this.settingsUnreadable) return;
		void this.saveData(this.settings).catch((e) => console.error("[notebook] could not save the last location", e));
	}

	/** 0.20 (#79): a PDF dropped on a page was chosen to be annotated in a notebook of its own: a vault file takes the "Annotate in Notebook" path, a file from another app the one-file import dialog. */
	annotateDropped(source: File | TFile): void {
		if (source instanceof TFile) void annotatePdfFlow(this.app, this.annotateHost(), source);
		else this.host.importFiles(this.settings.folder, [source]);
	}

	/** 0.18 (O10): what "Annotate in Notebook" needs from the plugin. */
	private annotateHost(): AnnotatePdfHost {
		return {
			folder: () => this.settings.folder,
			readNotebook: (file) => this.host.readNotebook(file),
			importPdfFrom: (folder, file, bytes) => this.host.importPdfFrom(folder, file, bytes),
		};
	}

	/** Opens the notebook that was open last, on the page that was in view. */
	private async continueLast(): Promise<void> {
		const { lastNotebookPath: path, lastNotebookPage: page, lastNotebookPos: pos } = this.settings;
		if (!path) {
			showNotice(t("notice.noLastNotebook"));
			return;
		}
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			showNotice(t("notice.lastNotebookGone", { path }));
			return;
		}
		await openNotebookAtPage(this.app, file, page, pos?.page === page ? pos : null);
	}

	private openPicker(): void {
		new OpenNotebookModal(this.app, this.settings.folder, (file) => void this.openFile(file), () => this.askNewNotebook()).open();
	}

	private askNewNotebook(): void {
		this.host.createNotebook();
	}

	/** Shows Home or the library in the existing library or Home tab (switching its surface), or opens a new tab. */
	private async openLibrary(place: LibraryPlace): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(place === "home" ? HOME_VIEW_TYPE : LIBRARY_VIEW_TYPE)[0]
			?? workspace.getLeavesOfType(place === "home" ? LIBRARY_VIEW_TYPE : HOME_VIEW_TYPE)[0];
		if (!leaf) {
			const fresh = workspace.getLeaf("tab");
			await fresh.setViewState({ type: place === "home" ? HOME_VIEW_TYPE : LIBRARY_VIEW_TYPE, active: true });
			await workspace.revealLeaf(fresh);
			return;
		}
		await workspace.revealLeaf(leaf);
		if (leaf.view instanceof LibraryView) leaf.view.show(place);
	}

	/** 0.12: the Inbox as the header bell sees it (zettel/inbox-service.ts, public API only). */
	private inboxPort(service: InboxService): InboxPort {
		let scanned = false;
		return {
			open: () => service.all.filter((i) => service.status(i).status === "open"),
			scanned: () => scanned,
			scan: async () => {
				await service.refresh();
				scanned = true;
			},
			onChange: (fn) => service.onChange(fn),
			openItem: (item) => service.openItem(item),
			discard: (item) => service.discard(item),
			openInbox: () => void openInbox(this.app),
			processInInbox: () => void processNextInbox(this.app),
		};
	}

	private openBenchmark(): void {
		const view = this.app.workspace.getActiveViewOfType(NotebookView);
		const size = view && view.stageSize.width > 0 ? view.stageSize : { width: window.innerWidth, height: window.innerHeight };
		new BenchmarkModal(this.app, size).open();
	}

	/** 10,000 strokes on 10 pages, for manual performance tests on the device. */
	private async createStressNotebook(): Promise<void> {
		try {
			const file = await createNotebook(this.app, this.settings.folder, "Stress test 10000", stressDocument(10_000, 10, Date.now() % 100000));
			await this.openFile(file);
		} catch (e) {
			showNotice(t("notice.createFailed", { error: (e as Error).message }));
		}
	}

	private async openFile(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(file);
	}
}
