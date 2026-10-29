import { Notice, Plugin, type TFile } from "obsidian";
import { t } from "./i18n";
import { FILE_EXTENSION } from "./model/types";
import { readSettings, type NotebookSettings } from "./settings";
import { createNotebook } from "./storage/notebooks";
import { NewNotebookModal, OpenNotebookModal } from "./view/modals";
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
		new NewNotebookModal(this.app, (name) => void this.createAndOpen(name)).open();
	}

	private async createAndOpen(name: string): Promise<void> {
		try {
			const file = await createNotebook(this.app, this.settings.folder, name);
			await this.openFile(file);
		} catch (e) {
			new Notice(t("notice.createFailed", { error: (e as Error).message }));
		}
	}

	private async openFile(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf(false).openFile(file);
	}
}
