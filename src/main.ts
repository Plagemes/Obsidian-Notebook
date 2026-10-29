import { Notice, Plugin, type TFile } from "obsidian";
import { t } from "./i18n";
import { readSettings, type NotebookSettings } from "./settings";
import { stressDocument } from "./model/stress";
import { NOTEBOOK_EXTENSIONS } from "./storage/format";
import { AdapterJournalStore, journalFolder } from "./storage/vault-io";
import { createNotebook } from "./storage/notebooks";
import { BenchmarkModal } from "./view/benchmark";
import { NotebookLibraryHost } from "./library/host";
import { registerIntegration } from "./integration";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./library/library-view";
import { OpenNotebookModal } from "./view/modals";
import { NotebookView, VIEW_TYPE } from "./view/notebook-view";
import { NotebookSettingTab } from "./view/settings-tab";

export default class NotebookPlugin extends Plugin {
	settings!: NotebookSettings;
	private host!: NotebookLibraryHost;
	journal!: AdapterJournalStore;

	async onload(): Promise<void> {
		this.settings = readSettings(await this.loadData());

		this.journal = new AdapterJournalStore(this.app.vault.adapter, journalFolder(this.app, this.manifest.id));
		this.registerView(VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
		this.registerExtensions([...NOTEBOOK_EXTENSIONS], VIEW_TYPE);
		this.host = new NotebookLibraryHost(this);
		this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new LibraryView(leaf, this.host));

		this.addRibbonIcon("library", t("command.library"), () => void this.openLibrary());

		this.addCommand({ id: "create", name: t("command.new"), callback: () => this.askNewNotebook() });
		this.addCommand({ id: "open", name: t("command.open"), callback: () => this.openPicker() });
		this.addCommand({ id: "open-library", name: t("command.library"), callback: () => void this.openLibrary() });
		this.addCommand({ id: "import-pdf", name: t("command.importPdf"), callback: () => this.host.importPdf(this.settings.folder) });
		this.addCommand({ id: "undo", name: t("command.undo"), checkCallback: (checking) => this.withView(checking, (v) => v.undo()) });
		this.addCommand({ id: "redo", name: t("command.redo"), checkCallback: (checking) => this.withView(checking, (v) => v.redo()) });
		this.addCommand({ id: "fit-width", name: t("command.fit"), checkCallback: (checking) => this.withView(checking, (v) => v.fitToWidth()) });
		this.addCommand({ id: "add-page", name: t("command.addPage"), checkCallback: (checking) => this.withView(checking, (v) => v.addPage()) });
		this.addCommand({ id: "scan-into", name: t("command.scanInto"), checkCallback: (checking) => this.withView(checking, (v) => void v.scanPagesAfter(v.currentPage())) });
		this.addCommand({ id: "scan-new", name: t("command.scanNew"), callback: () => this.host.scanToNotebook(this.settings.folder) });
		this.addCommand({ id: "benchmark", name: t("command.benchmark"), callback: () => this.openBenchmark() });
		this.addCommand({ id: "create-stress-test", name: t("command.stress"), callback: () => void this.createStressNotebook() });
		this.addCommand({ id: "export-pdf", name: t("command.exportPdf"), checkCallback: (checking) => this.withView(checking, (v) => void v.exportNotebookPdf()) });

		registerIntegration(this, { background: (doc, page, width) => this.host.thumbnailBackground(doc, page, width) });

		this.addSettingTab(new NotebookSettingTab(this.app, this));

		// Best effort only (not guaranteed, unreliable on mobile): views also flush on visibilitychange/pagehide.
		this.registerEvent(this.app.workspace.on("quit", () => void this.flushAll()));
	}

	onunload(): void {
		void this.flushAll();
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
