import { trackWriting } from "./view/writing-quiet";
import { showNotice } from "./view/notice";
import { Platform, Plugin, type TFile } from "obsidian";
import { onLanguageChanged, setUiLanguage, t } from "./i18n";
import { readSettings, type NotebookSettings } from "./settings";
import { positionEquals, type SavedPosition } from "./ink/view-position";
import { stressDocument } from "./model/stress";
import { NOTEBOOK_EXTENSIONS } from "./storage/format";
import { AdapterJournalStore, journalFolder, sidecarDeviceId, vaultDeviceFileAdapter } from "./storage/vault-io";
import { SharedClipStore } from "./storage/shared-clip-store";
import { createNotebook } from "./storage/notebooks";
import { BenchmarkModal } from "./view/benchmark";
import { PenTestModal, penSignalInfo } from "./view/pen-test-modal";
import { NotebookLibraryHost } from "./library/host";
import { registerIntegration } from "./integration";
import type { HistoryService } from "./integration/history-service";
import type { NotebookApi } from "./integration/api";
import { registerReliability } from "./integration/reliability";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./library/library-view";
import { registerActionCommands } from "./view/commands";
import { openLooseSheet } from "./library/loose-sheet";
import { OpenNotebookModal } from "./view/modals";
import { openNotebookAtPage } from "./integration/open";
import { NotebookView, VIEW_TYPE } from "./view/notebook-view";
import { NotebookSettingTab } from "./view/settings-tab";
import { registerLectureRibbon } from "./view/lecture-commands";
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
import { NotebookStatusBar } from "./view/status-bar";
import { registerResilience, type ResilienceServices } from "./view/resilience";

export default class NotebookPlugin extends Plugin {
	settings!: NotebookSettings;
	private host!: NotebookLibraryHost;
	journal!: AdapterJournalStore;
	/** Class timetable (wave 0.6). */
	timetable!: TimetableService;
	/** wave 0.7: quick navigation (364-366). */
	recentPages!: RecentPagesService;
	/** wave 0.10 (18): back/forward history of visited pages (view/nav-controller.ts). */
	nav!: NavController;
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
	/** wave 0.10 (362): the clipboard shared between devices; one store (one write queue) for every view. */
	private sharedClipStore: SharedClipStore | null = null;

	async onload(): Promise<void> {
		this.settings = readSettings(await this.loadData());
		// Command names (below) are registered once, so they follow the language at startup.
		setUiLanguage(this.settings.uiLanguage);
		this.register(onLanguageChanged(() => showNotice(t("settings.uiLanguage.changed"))));
		// wave 0.8 (374): notices and non-urgent background work wait while the pen is on the screen.
		trackWriting(this);

		this.practice = new PracticeService(this);
		this.journal = new AdapterJournalStore(this.app.vault.adapter, journalFolder(this.app, this.manifest.id));
		this.syncSafety = new SyncSafetyService(this);
		this.syncSafety.register();
		// wave 0.7: resilience (#346 safe mode, #347 storage full, #390 integrity check); before the views exist.
		this.resilience = registerResilience(this, () => this.history);
		this.registerView(VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
		this.registerExtensions([...NOTEBOOK_EXTENSIONS], VIEW_TYPE);
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
		});
		// wave 0.6: library trash auto-empty (setting, off by default)
		this.app.workspace.onLayoutReady(() => void this.host.trash.purgeExpired().catch((e) => console.error("[notebook] trash auto-empty failed", e)));

		this.addRibbonIcon("home", t("home.command"), () => void this.openLibrary("home"));

		// wave p1b: repair (#140), conflicted copies (#122), page restore (#180).
		registerReliability(this, this, () => this.views(), () => this.app.workspace.getActiveViewOfType(NotebookView));

		registerLectureRibbon(this, (file) => this.host.openNotebook(file));
		// Wave 0.6: synchronised PDF <-> notes view (view/pdf-sync.ts).
		initPdfSync(this, () => this.settings.folder);

		// wave 0.7: quick nav (page switcher, recently edited pages; "Go to page number" is a view action of the registry)
		this.recentPages = new RecentPagesService(this.app, (file) => this.host.readNotebook(file));
		this.recentPages.register(this);
		// wave 0.10: back/forward history of visited pages (18) and the status bar item (O15); views reach both through the host.
		this.nav = registerNavigation(this, (file) => this.host.readNotebook(file));
		this.registerStatusBar();
		Object.assign(this.host, { openRecentPages: () => openRecentPages(this.app, this.recentPages) });
		const quickNav = new QuickNavService(this.app, {
			root: () => this.settings.folder,
			loadIndex: () => this.host.loadIndex(),
			saveIndex: (data) => this.host.saveIndex(data),
			readNotebook: (file) => this.host.readNotebook(file),
			thumbnailBackground: (doc, page, width) => this.host.thumbnailBackground(doc, page, width),
		}, this.recentPages);

		// ui redesign: every command of the plugin comes from the action registry (ui/actions.ts); ids are unchanged.
		this.globalActions = {
			"create": () => this.askNewNotebook(),
			"open": () => this.openPicker(),
			"continue-last": () => void this.continueLast(),
			"open-library": () => void this.openLibrary("all"),
			"open-home": () => void this.openLibrary("home"),
			"import-pdf": () => this.host.importPdf(this.settings.folder),
			"lecture-from-slides": () => this.host.lectureFromSlides(),
			"scan-new": () => this.host.scanToNotebook(this.settings.folder),
			"loose-sheet": () => void openLooseSheet(this, (file) => this.host.openNotebook(file)),
			"timetable": () => void this.timetable.edit(),
			"open-class": () => this.timetable.openNow(),
			"pen-button-test": () => new PenTestModal(this.app, penSignalInfo(this)).open(),
			"go-to-page": () => openPageSwitcher(quickNav),
			"recent-pages": () => openRecentPages(this.app, this.recentPages),
			"sync-check": () => void this.syncSafety.openCheck(),
			"check-integrity": () => void this.resilience?.check(),
			"library-check": () => this.host.checkLibrary(),
			"zettel-inbox": () => void openInbox(this.app),
			"zettel-inbox-process": () => void processNextInbox(this.app),
			"benchmark": () => this.openBenchmark(),
			"create-stress-test": () => void this.createStressNotebook(),
		};
		const missing = registerActionCommands(this, {
			activeView: () => this.app.workspace.getActiveViewOfType(NotebookView),
			globals: this.globalActions,
		});
		if (missing.length) console.error("[notebook] actions without a handler:", missing.join(", "));

		this.history = registerIntegration(this, {
			background: (doc, page, width) => this.host.thumbnailBackground(doc, page, width),
			newNotebookIn: (folder) => this.host.createNotebook(folder),
			annotatePdf: (pdf) => this.host.importPdf(this.settings.folder, pdf),
		});
		// wave 0.6: zettelkasten (M15 Z1–Z3, Z11, Z12)
		registerZettel(this);
		// wave 0.8: quick textbook reference (roadmap 208): "p. 134" in a text box opens the textbook at that page
		registerTextbookRefs(this, () => this.settings.folder);

		// wave 0.9: redo the exercise (#303): practice copies, attempts, peek, timer (view/practice.ts)
		this.practice.start();

		// wave 0.6: timetable (src/timetable/): current class offer, library shortcut, editor.
		this.timetable = new TimetableService(this, (file) => this.host.openNotebook(file));
		this.timetable.start();

		this.addSettingTab(new NotebookSettingTab(this.app, this));

		// Best effort only (not guaranteed, unreliable on mobile): views also flush on visibilitychange/pagehide.
		this.registerEvent(this.app.workspace.on("quit", () => void this.flushAll()));
	}

	onunload(): void {
		if (this.rememberTimer !== null) this.writeLocation();
		this.recentPages.flush();
		void this.flushAll();
		this.syncSafety.dispose();
		this.timetable.stop();
		this.host.dispose();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const view of this.views()) view.applySettings(this.settings);
	}

	private views(): NotebookView[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE)
			.map((leaf) => leaf.view)
			.filter((view): view is NotebookView => view instanceof NotebookView);
	}

	private flushAll(): Promise<unknown> {
		return Promise.all(this.views().map((v) => v.flushNow().catch((e) => console.error("[notebook] flush failed", e))));
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

	private writeLocation(): void {
		if (this.rememberTimer !== null) window.clearTimeout(this.rememberTimer);
		this.rememberTimer = null;
		void this.saveData(this.settings).catch((e) => console.error("[notebook] could not save the last location", e));
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
		this.host.createNotebook(this.settings.folder);
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
