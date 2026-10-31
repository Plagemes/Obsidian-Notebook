// wave 0.9: the two export dialogs. "Export…" (381) chooses format, page or notebook, and what is drawn (ink only,
// background only, both); wave 0.10 (81) adds PNG images (a vault folder and a scale), Print, and "some pages" with a typed
// range for every format. "Export as Markdown…" (382) chooses the vault folder and the resolution of the page images.
// Both only collect choices: the files are written by view/export.ts, view/export-png.ts, view/print.ts and
// view/export-markdown.ts.
import { Modal, Setting, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { EXPORT_LAYERS, type ExportFormat, type ExportLayers, type ExportScope } from "../ink/export-layers";
import { DEFAULT_MARKDOWN_DPI, MARKDOWN_DPI, isMarkdownDpi, type MarkdownDpi } from "../model/export-markdown";
import { DEFAULT_PNG_SCALE, PNG_SCALES, isPngScale, scaleDpi, type PngScale } from "../model/export-pages";
import { parsePageRange } from "../model/page-range";
import { folderProblem } from "./export-markdown";
import type { ExportRequest } from "./export";
import { rangeProblem } from "./range-text";
import { modalShell, setShellButtonLabel, shellButton, shellNote } from "../ui/components/modal-shell";

export interface ExportDialogHost {
	app: App;
	pageCount: number;
	/** 0-based page the dialog was opened for (the page in view, or the page of the page sheet). */
	pageIndex: number;
	/** Preselect "this page" (opened from a page's sheet) instead of the whole notebook. */
	pageFirst: boolean;
	/** wave 0.10: the folder suggested for PNG images (next to the notebook). */
	defaultFolder: string;
	/** wave 0.10: this device can print (desktop); Print is not offered otherwise. */
	canPrint: boolean;
	/** wave 0.10: start on this format (the PNG and Print shortcuts), instead of the last one used. */
	initialFormat?: ExportFormat;
	run(request: ExportRequest): void;
}

/** The choices of the last export in this session (not saved). */
const last: { format: ExportFormat; layers: ExportLayers; dpi: MarkdownDpi; scale: PngScale } = {
	format: "pdf", layers: "both", dpi: DEFAULT_MARKDOWN_DPI, scale: DEFAULT_PNG_SCALE,
};

const LAYER_LABEL = { both: "export.layers.both", ink: "export.layers.ink", background: "export.layers.background" } as const;
const LAYER_DESC = { both: "export.layers.both.desc", ink: "export.layers.ink.desc", background: "export.layers.background.desc" } as const;

export class ExportModal extends Modal {
	private format: ExportFormat;
	private exportScope: ExportScope;
	private layers: ExportLayers = last.layers;
	private scale: PngScale = last.scale;
	private folder: string;
	private rangeText = "";
	private layersDesc: HTMLElement | null = null;
	private fileDesc: HTMLElement | null = null;
	private problem: HTMLElement | null = null;
	private rangeSetting: Setting | null = null;
	private folderSetting: Setting | null = null;
	private scaleSetting: Setting | null = null;
	private submitButton: HTMLButtonElement | null = null;

	constructor(private readonly host: ExportDialogHost) {
		super(host.app);
		this.exportScope = host.pageFirst || host.pageCount <= 1 ? "page" : "notebook";
		this.folder = host.defaultFolder;
		const wanted = host.initialFormat ?? last.format;
		this.format = wanted === "print" && !host.canPrint ? "pdf" : wanted;
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("export.dialog.title"), icon: "file-output", size: "medium", cls: "notebook-export-modal" });
		const contentEl = shell.body;
		new Setting(contentEl).setName(t("export.dialog.format")).addDropdown((dd) => {
			dd.addOption("pdf", "PDF").addOption("svg", "SVG").addOption("png", t("export.format.png"));
			if (this.host.canPrint) dd.addOption("print", t("export.format.print"));
			dd.setValue(this.format).onChange((v) => {
				this.format = v === "svg" || v === "png" || (v === "print" && this.host.canPrint) ? v : "pdf";
				this.refresh();
			});
		});
		new Setting(contentEl).setName(t("export.dialog.scope")).addDropdown((dd) => {
			dd.addOption("page", t("export.dialog.scope.page", { n: String(this.host.pageIndex + 1) }));
			if (this.host.pageCount > 1) {
				dd.addOption("notebook", t("export.dialog.scope.notebook", { n: String(this.host.pageCount) }));
				dd.addOption("range", t("export.dialog.scope.range"));
			}
			dd.setValue(this.exportScope).onChange((v) => {
				this.exportScope = v === "notebook" || v === "range" ? v : "page";
				this.refresh();
			});
		});
		this.rangeSetting = new Setting(contentEl).setName(t("export.dialog.range")).setDesc(t("export.dialog.range.desc", { n: String(this.host.pageCount) }));
		this.rangeSetting.addText((tx) => {
			tx.setPlaceholder("1-3, 5, 8-").setValue(this.rangeText).onChange((v) => {
				this.rangeText = v;
				this.problem?.setText("");
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
		this.folderSetting = new Setting(contentEl).setName(t("export.markdown.folder")).setDesc(t("export.markdown.folder.desc"));
		this.folderSetting.addText((tx) => {
			tx.setValue(this.folder).onChange((v) => {
				this.folder = v;
				this.problem?.setText("");
			});
		});
		this.scaleSetting = new Setting(contentEl).setName(t("export.png.scale"));
		this.scaleSetting.addDropdown((dd) => {
			for (const s of PNG_SCALES) dd.addOption(String(s), t("export.png.scale.option", { scale: String(s), dpi: String(scaleDpi(s)) }));
			dd.setValue(String(this.scale)).onChange((v) => {
				const n = Number(v);
				if (isPngScale(n)) this.scale = n;
			});
		});
		this.fileDesc = shellNote(contentEl, "");
		this.fileDesc.addClass("notebook-export-note");
		shellNote(contentEl, t("export.dialog.hidden")).addClass("notebook-export-note");
		this.problem = shellNote(contentEl, "", "error");
		this.problem.addClass("notebook-export-problem");
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		this.submitButton = shellButton(shell.foot, "primary", t("export.dialog.export"), () => this.submit());
		this.refresh();
	}

	/** Shows the choices the format and the scope need, and the sentence that says what will happen. */
	private refresh(): void {
		this.rangeSetting?.settingEl.toggle(this.exportScope === "range");
		this.folderSetting?.settingEl.toggle(this.format === "png");
		this.scaleSetting?.settingEl.toggle(this.format === "png");
		if (this.submitButton) setShellButtonLabel(this.submitButton, t(this.format === "print" ? "export.print.button" : "export.dialog.export"));
		this.problem?.setText("");
		this.describeFiles();
	}

	/** The pages of the choice, or null while a typed range is not valid. */
	private selectedCount(): number | null {
		if (this.exportScope === "page") return 1;
		if (this.exportScope === "notebook") return this.host.pageCount;
		const r = parsePageRange(this.rangeText, this.host.pageCount);
		return r.ok ? r.pages.length : null;
	}

	private describeFiles(): void {
		const n = this.selectedCount();
		let key: MessageKey;
		if (this.format === "png") key = "export.png.note";
		else if (this.format === "print") key = "export.print.note";
		else key = this.format === "svg" && (n ?? 1) > 1 ? "export.dialog.files.many" : "export.dialog.files.one";
		this.fileDesc?.setText(t(key, { n: String(n ?? this.host.pageCount) }));
	}

	private submit(): void {
		let range: number[] | undefined;
		if (this.exportScope === "range") {
			const parsed = parsePageRange(this.rangeText, this.host.pageCount);
			const problem = rangeProblem(parsed, this.host.pageCount);
			if (problem || !parsed.ok) {
				this.problem?.setText(problem ?? "");
				return;
			}
			range = parsed.pages;
		}
		if (this.format === "png") {
			const problem = folderProblem(this.host.app, this.folder);
			if (problem) {
				this.problem?.setText(problem);
				return;
			}
		}
		last.format = this.format;
		last.layers = this.layers;
		last.scale = this.scale;
		this.close();
		this.host.run({
			format: this.format, scope: this.exportScope, pageIndex: this.host.pageIndex, layers: this.layers,
			...(range ? { range } : {}),
			...(this.format === "png" ? { folder: this.folder, scale: this.scale } : {}),
		});
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
		const shell = modalShell(this, { title: t("export.markdown.title"), icon: "file-text", size: "medium", cls: "notebook-export-modal" });
		const contentEl = shell.body;
		shellNote(contentEl, t("export.markdown.desc", { n: String(this.host.pageCount) })).addClass("notebook-export-note");
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
		this.problem = shellNote(contentEl, "", "error");
		this.problem.addClass("notebook-export-problem");
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("export.dialog.export"), () => this.submit());
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
