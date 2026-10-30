import { Notice, Plugin, type TFile } from "obsidian";
import { t } from "./i18n";
import { readSettings, type NotebookSettings } from "./settings";
import { stressDocument } from "./model/stress";
import { NOTEBOOK_EXTENSIONS } from "./storage/format";
import { AdapterJournalStore, journalFolder } from "./storage/vault-io";
import { createNotebook } from "./storage/notebooks";
import { BenchmarkModal } from "./view/benchmark";
import { PenTestModal, penSignalInfo } from "./view/pen-test-modal";
import { NotebookLibraryHost } from "./library/host";
import { registerIntegration } from "./integration";
import type { NotebookApi } from "./integration/api";
import { registerReliability } from "./integration/reliability";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./library/library-view";
import { registerToolCommands } from "./view/commands";
import { registerReadingCommands } from "./view/reading-commands";
import { OpenNotebookModal } from "./view/modals";
import { openNotebookAtPage } from "./integration/open";
import { exportPdfAnnotations, openMarginsModal, updatePdfFromNewVersion } from "./view/pdf-actions";
import { NotebookView, VIEW_TYPE } from "./view/notebook-view";
import { NotebookSettingTab } from "./view/settings-tab";
import { registerLectureCommands } from "./view/lecture-commands";
import { TimetableService } from "./timetable/service";
import { registerPdfSyncCommands } from "./view/pdf-sync";
import { registerZettel } from "./zettel";

export default class NotebookPlugin extends Plugin {
	settings!: NotebookSettings;
	private host!: NotebookLibraryHost;
	journal!: AdapterJournalStore;
	/** Class timetable (wave 0.6). */
	timetable!: TimetableService;
	/** Public API for other plugins and scripts (docs/api.md). */
	api?: NotebookApi;

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

		this.addCommand({ id: "create", name: t("command.new"), callback: () => this.askNewNotebook() });
		this.addCommand({ id: "open", name: t("command.open"), callback: () => this.openPicker() });
		this.addCommand({ id: "continue-last", name: t("command.continue"), callback: () => void this.continueLast() });
		this.addCommand({ id: "open-library", name: t("command.library"), callback: () => void this.openLibrary() });
		this.addCommand({ id: "import-pdf", name: t("command.importPdf"), callback: () => this.host.importPdf(this.settings.folder) });
		this.addCommand({ id: "lecture-from-slides", name: t("command.lectureFromSlides"), callback: () => this.host.lectureFromSlides() });
		this.addCommand({ id: "exercise-page", name: t("command.exercisePage"), checkCallback: (checking) => this.withView(checking, (v) => v.exercisePageAfter()) });
		this.addCommand({ id: "exercise-paper", name: t("command.exercisePaper"), checkCallback: (checking) => this.withView(checking, (v) => v.chooseExercisePaper()) });
		this.addCommand({ id: "undo", name: t("command.undo"), checkCallback: (checking) => this.withView(checking, (v) => v.undo()) });
		this.addCommand({ id: "redo", name: t("command.redo"), checkCallback: (checking) => this.withView(checking, (v) => v.redo()) });
		this.addCommand({ id: "fit-width", name: t("command.fit"), checkCallback: (checking) => this.withView(checking, (v) => v.fitToWidth()) });
		this.addCommand({ id: "add-page", name: t("command.addPage"), checkCallback: (checking) => this.withView(checking, (v) => v.addPage()) });
		this.addCommand({ id: "scan-into", name: t("command.scanInto"), checkCallback: (checking) => this.withView(checking, (v) => void v.scanPagesAfter(v.currentPage())) });
		this.addCommand({ id: "scan-new", name: t("command.scanNew"), callback: () => this.host.scanToNotebook(this.settings.folder) });
		this.addCommand({ id: "pen-button-test", name: t("command.penTest"), callback: () => new PenTestModal(this.app, penSignalInfo(this)).open() });
		this.addCommand({ id: "benchmark", name: t("command.benchmark"), callback: () => this.openBenchmark() });
		this.addCommand({ id: "create-stress-test", name: t("command.stress"), callback: () => void this.createStressNotebook() });
		this.addCommand({ id: "export-pdf", name: t("command.exportPdf"), checkCallback: (checking) => this.withView(checking, (v) => void v.exportNotebookPdf()) });

		// wave p1b: repair (#140), conflicted copies (#122), page restore (#180).
		registerReliability(this, this, () => this.views(), () => this.app.workspace.getActiveViewOfType(NotebookView));

		// Wave p1a: PDF margins, re-published slides, annotation export (view/pdf-actions.ts).
		this.addCommand({ id: "pdf-margins", name: t("command.pdfMargins"), checkCallback: (checking) => this.withView(checking, (v) => {
			const host = v.pdfActionHost();
			const page = host?.doc.pages[v.currentPage()];
			if (!host || !page?.background || !host.editable()) new Notice(t("pdf.noPdfPage"));
			else openMarginsModal(host, page);
		}) });
		this.addCommand({ id: "pdf-update", name: t("command.pdfUpdate"), checkCallback: (checking) => this.withView(checking, (v) => {
			const host = v.pdfActionHost();
			if (host) void updatePdfFromNewVersion(host, v.currentPage());
		}) });
		this.addCommand({ id: "pdf-annotations", name: t("command.pdfAnnotations"), checkCallback: (checking) => this.withView(checking, (v) => {
			const host = v.pdfActionHost();
			if (host) void exportPdfAnnotations(host);
		}) });

		registerLectureCommands(this, (file) => this.host.openNotebook(file));

		// Wave 0.6: synchronised PDF <-> notes view (view/pdf-sync.ts).
		registerPdfSyncCommands(this, () => this.app.workspace.getActiveViewOfType(NotebookView), () => this.settings.folder);

		registerToolCommands(this, (checking, run) => this.withView(checking, run));
		registerReadingCommands(this, (checking, run) => this.withView(checking, run));

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
		this.addCommand({ id: "timetable", name: t("command.timetable"), callback: () => void this.timetable.edit() });
		this.addCommand({ id: "open-class", name: t("command.openClass"), callback: () => this.timetable.openNow() });

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

	private withView(checking: boolean, run: (view: NotebookView) => void): boolean {
		const view = this.app.workspace.getActiveViewOfType(NotebookView);
		if (!view) return false;
		if (!checking) run(view);
		return true;
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
