// wave 0.9: the two export dialogs. "Export…" (381) chooses format, page or notebook, and what is drawn (ink only,
// background only, both). "Export as Markdown…" (382) chooses the vault folder and the resolution of the page images.
// Both only collect choices: the files are written by view/export.ts and view/export-markdown.ts.
import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n";
import { EXPORT_LAYERS, type ExportFormat, type ExportLayers, type ExportScope } from "../ink/export-layers";
import { DEFAULT_MARKDOWN_DPI, MARKDOWN_DPI, isMarkdownDpi, type MarkdownDpi } from "../model/export-markdown";
import { folderProblem } from "./export-markdown";
import type { ExportRequest } from "./export";

export interface ExportDialogHost {
	app: App;
	pageCount: number;
	/** 0-based page the dialog was opened for (the page in view, or the page of the page sheet). */
	pageIndex: number;
	/** Preselect "this page" (opened from a page's sheet) instead of the whole notebook. */
	pageFirst: boolean;
	run(request: ExportRequest): void;
}

/** The choices of the last export in this session (not saved). */
const last: { format: ExportFormat; layers: ExportLayers; dpi: MarkdownDpi } = { format: "pdf", layers: "both", dpi: DEFAULT_MARKDOWN_DPI };

const LAYER_LABEL = { both: "export.layers.both", ink: "export.layers.ink", background: "export.layers.background" } as const;
const LAYER_DESC = { both: "export.layers.both.desc", ink: "export.layers.ink.desc", background: "export.layers.background.desc" } as const;

export class ExportModal extends Modal {
	private format: ExportFormat = last.format;
	private exportScope: ExportScope;
	private layers: ExportLayers = last.layers;
	private layersDesc: HTMLElement | null = null;
	private fileDesc: HTMLElement | null = null;

	constructor(private readonly host: ExportDialogHost) {
		super(host.app);
		this.exportScope = host.pageFirst || host.pageCount <= 1 ? "page" : "notebook";
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(t("export.dialog.title"));
		new Setting(contentEl).setName(t("export.dialog.format")).addDropdown((dd) => {
			dd.addOption("pdf", "PDF").addOption("svg", "SVG").setValue(this.format).onChange((v) => {
				this.format = v === "svg" ? "svg" : "pdf";
				this.describeFiles();
			});
		});
		new Setting(contentEl).setName(t("export.dialog.scope")).addDropdown((dd) => {
			dd.addOption("page", t("export.dialog.scope.page", { n: String(this.host.pageIndex + 1) }));
			if (this.host.pageCount > 1) dd.addOption("notebook", t("export.dialog.scope.notebook", { n: String(this.host.pageCount) }));
			dd.setValue(this.exportScope).onChange((v) => {
				this.exportScope = v === "notebook" ? "notebook" : "page";
				this.describeFiles();
			});
		});
		const layers = new Setting(contentEl).setName(t("export.dialog.layers"));
		layers.addDropdown((dd) => {
			for (const l of EXPORT_LAYERS) dd.addOption(l, t(LAYER_LABEL[l]));
			dd.setValue(this.layers).onChange((v) => {
				this.layers = EXPORT_LAYERS.find((l) => l === v) ?? "both";
				this.layersDesc?.setText(t(LAYER_DESC[this.layers]));
				this.describeFiles();
			});
		});
		this.layersDesc = layers.descEl.createSpan({ text: t(LAYER_DESC[this.layers]) });
		this.fileDesc = contentEl.createEl("p", { cls: "notebook-export-note" });
		contentEl.createEl("p", { cls: "notebook-export-note", text: t("export.dialog.hidden") });
		this.describeFiles();
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("export.dialog.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("export.dialog.export")).setCta().onClick(() => this.submit()));
	}

	private describeFiles(): void {
		const many = this.format === "svg" && this.exportScope === "notebook" && this.host.pageCount > 1;
		this.fileDesc?.setText(t(many ? "export.dialog.files.many" : "export.dialog.files.one", { n: String(this.host.pageCount) }));
	}

	private submit(): void {
		last.format = this.format;
		last.layers = this.layers;
		this.close();
		this.host.run({ format: this.format, scope: this.exportScope, pageIndex: this.host.pageIndex, layers: this.layers });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface MarkdownDialogHost {
	app: App;
	pageCount: number;
	defaultFolder: string;
	run(folder: string, dpi: MarkdownDpi): void;
}

export class MarkdownExportModal extends Modal {
	private folder: string;
	private dpi: MarkdownDpi = last.dpi;
	private problem: HTMLElement | null = null;

	constructor(private readonly host: MarkdownDialogHost) {
		super(host.app);
		this.folder = host.defaultFolder;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(t("export.markdown.title"));
		contentEl.createEl("p", { cls: "notebook-export-note", text: t("export.markdown.desc", { n: String(this.host.pageCount) }) });
		new Setting(contentEl).setName(t("export.markdown.folder")).setDesc(t("export.markdown.folder.desc")).addText((tx) => {
			tx.setValue(this.folder).onChange((v) => {
				this.folder = v;
				this.problem?.setText("");
			});
		});
		new Setting(contentEl).setName(t("export.markdown.resolution")).addDropdown((dd) => {
			for (const dpi of MARKDOWN_DPI) dd.addOption(String(dpi), t("export.markdown.dpi", { dpi: String(dpi) }));
			dd.setValue(String(this.dpi)).onChange((v) => {
				const n = Number(v);
				if (isMarkdownDpi(n)) this.dpi = n;
			});
		});
		this.problem = contentEl.createEl("p", { cls: "notebook-export-problem", attr: { role: "alert" } });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("export.dialog.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("export.dialog.export")).setCta().onClick(() => this.submit()));
	}

	private submit(): void {
		const problem = folderProblem(this.host.app, this.folder);
		if (problem) {
			this.problem?.setText(problem);
			return;
		}
		last.dpi = this.dpi;
		this.close();
		this.host.run(this.folder, this.dpi);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
