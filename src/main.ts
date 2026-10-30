import { Notice, Plugin, type TFile } from "obsidian";
import { t } from "./i18n";
import { readSettings, type NotebookSettings } from "./settings";
import { stressDocument } from "./model/stress";
import { NOTEBOOK_EXTENSIONS } from "./storage/format";
import { AdapterJournalStore, journalFolder } from "./storage/vault-io";
import { createNotebook } from "./storage/notebooks";
import { BenchmarkModal } from "./view/benchmark";
import { PenTestModal } from "./view/pen-test-modal";
import { NotebookLibraryHost } from "./library/host";
import { registerIntegration } from "./integration";
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
import { registerZettel } from "./zettel";

export default class NotebookPlugin extends Plugin {
	settings!: NotebookSettings;
	private host!: NotebookLibraryHost;
	journal!: AdapterJournalStore;
	/** Class timetable (wave 0.6). */
	timetable!: TimetableService;
	/** Public API for other plugins and scripts (docs/api.md). */
	api?: NotebookApi;
	/** ui redesign: the plugin-level actions of the registry (ui/actions.ts), by id. */
	private globalActions: Record<string, () => void> = {};

	async onload(): Promise<void> {
		this.settings = readSettings(await this.loadData());

		this.journal = new AdapterJournalStore(this.app.vault.adapter, journalFolder(this.app, this.manifest.id));
		this.registerView(VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
		this.registerExtensions([...NOTEBOOK_EXTENSIONS], VIEW_TYPE);
		this.host = new NotebookLibraryHost(this);
		this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new LibraryView(leaf, this.host));
		// wave 0.6: library trash auto-empty (setting, off by default)
		this.app.workspace.onLayoutReady(() => void this.host.trash.purgeExpired().catch((e) => console.error("[notebook] trash auto-empty failed", e)));

		this.addRibbonIcon("library", t("command.library"), () => void this.openLibrary());

		// wave p1b: repair (#140), conflicted copies (#122), page restore (#180).
		registerReliability(this, this, () => this.views(), () => this.app.workspace.getActiveViewOfType(NotebookView));

		registerLectureRibbon(this, (file) => this.host.openNotebook(file));
		// Wave 0.6: synchronised PDF <-> notes view (view/pdf-sync.ts).
		initPdfSync(this, () => this.settings.folder);

		// ui redesign: every command of the plugin comes from the action registry (ui/actions.ts); ids are unchanged.
		this.globalActions = {
			"create": () => this.askNewNotebook(),
			"open": () => this.openPicker(),
			"continue-last": () => void this.continueLast(),
			"open-library": () => void this.openLibrary(),
			"import-pdf": () => this.host.importPdf(this.settings.folder),
			"lecture-from-slides": () => this.host.lectureFromSlides(),
			"scan-new": () => this.host.scanToNotebook(this.settings.folder),
			"loose-sheet": () => void openLooseSheet(this, (file) => this.host.openNotebook(file)),
			"timetable": () => void this.timetable.edit(),
			"open-class": () => this.timetable.openNow(),
			"pen-button-test": () => new PenTestModal(this.app).open(),
			"benchmark": () => this.openBenchmark(),
			"create-stress-test": () => void this.createStressNotebook(),
		};
		const missing = registerActionCommands(this, {
			activeView: () => this.app.workspace.getActiveViewOfType(NotebookView),
			globals: this.globalActions,
		});
		if (missing.length) console.error("[notebook] actions without a handler:", missing.join(", "));

		registerIntegration(this, {
			background: (doc, page, width) => this.host.thumbnailBackground(doc, page, width),
			newNotebookIn: (folder) => this.host.createNotebook(folder),
			annotatePdf: (pdf) => this.host.importPdf(this.settings.folder, pdf),
		});
		// wave 0.6: zettelkasten (M15 Z1–Z3, Z11, Z12)
		registerZettel(this);

		// wave 0.6: timetable (src/timetable/): current class offer, library shortcut, editor.
		this.timetable = new TimetableService(this, (file) => this.host.openNotebook(file));
		this.timetable.start();

		this.addSettingTab(new NotebookSettingTab(this.app, this));

		// Best effort only (not guaranteed, unreliable on mobile): views also flush on visibilitychange/pagehide.
		this.registerEvent(this.app.workspace.on("quit", () => void this.flushAll()));
	}

	onunload(): void {
		void this.flushAll();
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

	/** ui redesign: the course of the class on now (timetable), for the lecture contextual bar; null when none. */
	classNow(): string | null {
		return this.timetable?.nowClass()?.course ?? null;
	}

	/** Instant start: remembers the page being read (called a moment after it changes). Only the plugin settings are written. */
	remember(path: string, page: number): void {
		if (this.settings.lastNotebookPath === path && this.settings.lastNotebookPage === page) return;
		this.settings.lastNotebookPath = path;
		this.settings.lastNotebookPage = page;
		void this.saveData(this.settings).catch((e) => console.error("[notebook] could not save the last location", e));
	}

	/** Opens the notebook that was open last, on the page that was in view. */
	private async continueLast(): Promise<void> {
		const { lastNotebookPath: path, lastNotebookPage: page } = this.settings;
		if (!path) {
			new Notice(t("notice.noLastNotebook"));
			return;
		}
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			new Notice(t("notice.lastNotebookGone", { path }));
			return;
		}
		await openNotebookAtPage(this.app, file, page);
	}

	private openPicker(): void {
		new OpenNotebookModal(this.app, this.settings.folder, (file) => void this.openFile(file), () => this.askNewNotebook()).open();
	}

	private askNewNotebook(): void {
		this.host.createNotebook(this.settings.folder);
	}

	/** Shows the library in its existing tab, or opens it in a new one. */
	private async openLibrary(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
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
			new Notice(t("notice.createFailed", { error: (e as Error).message }));
		}
	}

	private async openFile(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(file);
	}
}
