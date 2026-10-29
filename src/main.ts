import { Notice, Plugin, type TFile } from "obsidian";
import { t } from "./i18n";
import { FILE_EXTENSION } from "./model/types";
import { readSettings, type NotebookSettings } from "./settings";
import { createDocument } from "./model/document";
import { stressDocument } from "./model/stress";
import { PAGE_SIZES, PAPER_SPACING } from "./model/types";
import { createNotebook } from "./storage/notebooks";
import { BenchmarkModal } from "./view/benchmark";
import { NewNotebookModal, OpenNotebookModal, type NewNotebookOptions } from "./view/modals";
import { NotebookView, VIEW_TYPE } from "./view/notebook-view";
import { NotebookSettingTab } from "./view/settings-tab";

export default class NotebookPlugin extends Plugin {
	settings!: NotebookSettings;

	async onload(): Promise<void> {
		this.settings = readSettings(await this.loadData());

		this.registerView(VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
		this.registerExtensions([FILE_EXTENSION], VIEW_TYPE);

		this.addRibbonIcon("book-open", t("ribbon.open"), () => this.openPicker());

		this.addCommand({ id: "create", name: t("command.new"), callback: () => this.askNewNotebook() });
		this.addCommand({ id: "open", name: t("command.open"), callback: () => this.openPicker() });
		this.addCommand({ id: "undo", name: t("command.undo"), checkCallback: (checking) => this.withView(checking, (v) => v.undo()) });
		this.addCommand({ id: "redo", name: t("command.redo"), checkCallback: (checking) => this.withView(checking, (v) => v.redo()) });
		this.addCommand({ id: "fit-width", name: t("command.fit"), checkCallback: (checking) => this.withView(checking, (v) => v.fitToWidth()) });
		this.addCommand({ id: "add-page", name: t("command.addPage"), checkCallback: (checking) => this.withView(checking, (v) => v.addPage()) });
		this.addCommand({ id: "benchmark", name: t("command.benchmark"), callback: () => this.openBenchmark() });
		this.addCommand({ id: "create-stress-test", name: t("command.stress"), callback: () => void this.createStressNotebook() });
		this.addCommand({ id: "export-pdf", name: t("command.exportPdf"), checkCallback: (checking) => this.withView(checking, (v) => void v.exportNotebookPdf()) });

		this.addSettingTab(new NotebookSettingTab(this.app, this));

		// Best effort only (not guaranteed, unreliable on mobile): views also flush on visibilitychange/pagehide.
		this.registerEvent(this.app.workspace.on("quit", () => void this.flushAll()));
	}

	onunload(): void {
		void this.flushAll();
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
		const s = this.settings;
		const defaults = { size: s.defaultPageSize, landscape: s.defaultLandscape, paper: s.defaultPaper };
		new NewNotebookModal(this.app, defaults, (options) => void this.createAndOpen(options)).open();
	}

	private async createAndOpen(o: NewNotebookOptions): Promise<void> {
		try {
			// Remember the choice for the next notebook.
			if (o.size !== this.settings.defaultPageSize || o.landscape !== this.settings.defaultLandscape || o.paper !== this.settings.defaultPaper) {
				this.settings = { ...this.settings, defaultPageSize: o.size, defaultLandscape: o.landscape, defaultPaper: o.paper };
				await this.saveSettings();
			}
			const base = PAGE_SIZES[o.size];
			const size = o.landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
			const doc = createDocument(new Date(), size, { kind: o.paper, spacing: PAPER_SPACING[o.paper] });
			const file = await createNotebook(this.app, this.settings.folder, o.name, doc);
			await this.openFile(file);
		} catch (e) {
			new Notice(t("notice.createFailed", { error: (e as Error).message }));
		}
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
