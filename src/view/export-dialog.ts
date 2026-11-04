// wave 0.9: the two export dialogs. "Export…" (381) chooses format, page or notebook, and what is drawn (ink only,
// background only, both); wave 0.10 (81) adds PNG images (a vault folder and a scale), Print, and "some pages" with a typed
// range for every format. "Export as Markdown…" (382) chooses the vault folder and the resolution of the page images.
// Both only collect choices: the files are written by view/export.ts, view/export-png.ts, view/print.ts and
// view/export-markdown.ts.
import { Modal, Setting, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { EXPORT_LAYERS, type ExportFormat, type ExportLayers, type ExportScope } from "../ink/export-layers";
import { DEFAULT_SPLIT, planSplit, SPLIT_MARGINS, SPLIT_OVERLAPS, SPLIT_PAPERS, type SplitPlan, type SplitSettings } from "../ink/export-tiles";
import { renderThumbnail } from "../library/thumbnail";
import type { Page } from "../model/types";
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
	/** 0.18 (#178): the pages as they are exported; with them the dialog offers "Split into sheets" for infinite pages and previews the cuts. */
	pages?: () => readonly Page[];
	run(request: ExportRequest): void;
}

/** The choices of the last export in this session (not saved). */
const last: { format: ExportFormat; layers: ExportLayers; dpi: MarkdownDpi; scale: PngScale; split: SplitSettings; splitOn: boolean } = {
	format: "pdf", layers: "both", dpi: DEFAULT_MARKDOWN_DPI, scale: DEFAULT_PNG_SCALE, split: { ...DEFAULT_SPLIT }, splitOn: false,
};
/** Width of the cut preview, CSS px (drawn twice as large). */
const PREVIEW_W = 300;
const PREVIEW_MAX_H = 340;

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
	// 0.18 (#178): split an infinite page into sheets of paper.
	private splitOn = last.splitOn;
	private split: SplitSettings = { ...last.split };
	private splitSetting: Setting | null = null;
	private splitBody: HTMLElement | null = null;
	private splitNumbers: Setting | null = null;
	private splitPng: HTMLElement | null = null;
	private splitSummary: HTMLElement | null = null;
	private splitPreview: HTMLElement | null = null;
	/** The picture of the page under the cuts: drawn once per page and region, kept while the dialog is open. */
	private readonly previewPictures = new Map<string, string>();
	private previewTimer = 0;

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
				this.refreshSplit();
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
		if (this.host.pages) this.buildSplit(contentEl);
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
		this.refreshSplit();
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
		last.split = { ...this.split };
		last.splitOn = this.splitOn;
		const split = this.splitActive();
		this.close();
		this.host.run({
			format: this.format, scope: this.exportScope, pageIndex: this.host.pageIndex, layers: this.layers,
			...(range ? { range } : {}),
			...(this.format === "png" ? { folder: this.folder, scale: this.scale } : {}),
			...(split ? { split: { ...this.split } } : {}),
		});
	}

	// --- 0.18 (#178): split an infinite page into sheets of paper ---

	/** The 0-based pages of the choice (a typed range that is not valid chooses none). */
	private selectedPages(): number[] {
		if (this.exportScope === "page") return [this.host.pageIndex];
		if (this.exportScope === "notebook") return Array.from({ length: this.host.pageCount }, (_, i) => i);
		const r = parsePageRange(this.rangeText, this.host.pageCount);
		return r.ok ? r.pages : [];
	}

	/** The infinite pages of the choice: the only ones that can be split. */
	private infinitePages(): number[] {
		const pages = this.host.pages?.();
		if (!pages || (this.format !== "pdf" && this.format !== "png")) return [];
		return this.selectedPages().filter((i) => pages[i]?.infinite === true);
	}

	/** Whether the export will split: the switch is on and the choice has an infinite page. */
	private splitActive(): boolean {
		return this.splitOn && this.infinitePages().length > 0;
	}

	private buildSplit(parent: HTMLElement): void {
		this.splitSetting = new Setting(parent).setName(t("export.split")).setDesc(t("export.split.desc"));
		this.splitSetting.addToggle((tg) => tg.setValue(this.splitOn).onChange((v) => {
			this.splitOn = v;
			this.refreshSplit();
		}));
		const body = parent.createDiv({ cls: "nb-split-body" });
		this.splitBody = body;
		const set = (patch: Partial<SplitSettings>): void => {
			this.split = { ...this.split, ...patch };
			this.refreshSplit();
		};
		new Setting(body).setName(t("export.split.paper")).addDropdown((dd) => {
			for (const p of SPLIT_PAPERS) dd.addOption(p, p === "a4" ? "A4" : p === "a5" ? "A5" : "Letter");
			dd.setValue(this.split.paper).onChange((v) => set({ paper: SPLIT_PAPERS.find((p) => p === v) ?? "a4" }));
		});
		new Setting(body).setName(t("export.split.orientation")).addDropdown((dd) => {
			dd.addOption("portrait", t("export.split.portrait")).addOption("landscape", t("export.split.landscape"));
			dd.setValue(this.split.orientation).onChange((v) => set({ orientation: v === "landscape" ? "landscape" : "portrait" }));
		});
		new Setting(body).setName(t("export.split.scale")).addDropdown((dd) => {
			dd.addOption("fit", t("export.split.scale.fit")).addOption("actual", t("export.split.scale.actual"));
			dd.setValue(this.split.scale).onChange((v) => set({ scale: v === "actual" ? "actual" : "fit" }));
		});
		const mmLabel = (pt: number): string => (pt === 0 ? t("export.split.none") : t("export.split.mm", { mm: String(Math.round(pt / 2.8346)) }));
		new Setting(body).setName(t("export.split.margin")).addDropdown((dd) => {
			for (const m of SPLIT_MARGINS) dd.addOption(String(m), mmLabel(m));
			dd.setValue(String(this.split.margin)).onChange((v) => set({ margin: Number(v) }));
		});
		new Setting(body).setName(t("export.split.overlap")).setDesc(t("export.split.overlap.desc")).addDropdown((dd) => {
			for (const o of SPLIT_OVERLAPS) dd.addOption(String(o), mmLabel(o));
			dd.setValue(String(this.split.overlap)).onChange((v) => set({ overlap: Number(v) }));
		});
		new Setting(body).setName(t("export.split.smart")).setDesc(t("export.split.smart.desc")).addToggle((tg) => tg.setValue(this.split.smartCuts).onChange((v) => set({ smartCuts: v })));
		this.splitNumbers = new Setting(body).setName(t("export.split.numbers")).setDesc(t("export.split.numbers.desc"));
		this.splitNumbers.addToggle((tg) => tg.setValue(this.split.pageNumbers).onChange((v) => set({ pageNumbers: v })));
		new Setting(body).setName(t("export.split.blank")).addToggle((tg) => tg.setValue(this.split.skipBlank).onChange((v) => set({ skipBlank: v })));
		this.splitPng = shellNote(body, t("export.split.png"));
		this.splitPng.addClass("notebook-export-note");
		this.splitSummary = shellNote(body, "");
		this.splitSummary.addClass("notebook-export-note");
		this.splitPreview = body.createDiv({ cls: "nb-split-preview-wrap" });
	}

	/** Shows the split choices when they apply, and redraws the cuts (after a short pause, so a run of changes draws once). */
	private refreshSplit(): void {
		const available = this.infinitePages().length > 0;
		this.splitSetting?.settingEl.toggle(available);
		const open = available && this.splitOn;
		this.splitBody?.toggle(open);
		this.splitNumbers?.settingEl.toggle(this.format === "pdf");
		this.splitPng?.toggle(this.format === "png");
		window.clearTimeout(this.previewTimer);
		if (open) this.previewTimer = window.setTimeout(() => this.drawPreview(), 40);
	}

	private drawPreview(): void {
		const wrap = this.splitPreview;
		const index = this.infinitePages()[0];
		const page = index === undefined ? undefined : this.host.pages?.()[index];
		if (!wrap || !page || index === undefined) return;
		wrap.empty();
		const plan = planSplit(page, this.split);
		if (!plan) {
			this.splitSummary?.setText(t("export.split.summary.empty"));
			return;
		}
		this.describeSplit(plan);
		const { region } = plan;
		let w = PREVIEW_W;
		let h = (w * region.height) / region.width;
		if (h > PREVIEW_MAX_H) {
			h = PREVIEW_MAX_H;
			w = (h * region.width) / region.height;
		}
		wrap.createDiv({ cls: "nb-split-caption", text: t("export.split.preview", { n: String(index + 1) }) });
		const box = wrap.createDiv({ cls: "nb-split-preview" });
		box.setCssProps({ "--nb-split-w": `${Math.max(40, Math.round(w))}px`, "--nb-split-h": `${Math.max(40, Math.round(h))}px` });
		const url = this.previewPicture(page, plan);
		if (url) box.createEl("img", { cls: "nb-split-img", attr: { src: url, alt: "" } });
		else box.createDiv({ cls: "nb-split-failed", text: t("export.split.preview.failed") });
		const pct = (v: number): string => `${Math.round(v * 10000) / 100}%`;
		for (const tile of plan.tiles) {
			const el = box.createDiv({ cls: "nb-split-tile" });
			el.setCssProps({
				"--nb-split-l": pct((tile.x - region.x) / region.width), "--nb-split-t": pct((tile.y - region.y) / region.height),
				"--nb-split-tw": pct(tile.width / region.width), "--nb-split-th": pct(tile.height / region.height),
			});
			el.createSpan({ cls: "nb-split-n", text: String(tile.index + 1) });
		}
	}

	/** The page's picture under the cuts, drawn once for a page and region and kept while the dialog is open. */
	private previewPicture(page: Page, plan: SplitPlan): string {
		const { region } = plan;
		const key = `${page.id}:${page.strokes.length}:${Math.round(region.x)}:${Math.round(region.y)}:${Math.round(region.width)}:${Math.round(region.height)}`;
		const have = this.previewPictures.get(key);
		if (have !== undefined) return have;
		let url = "";
		try {
			url = renderThumbnail(page, PREVIEW_W * 2, { region, mime: "image/jpeg", quality: 0.8 });
		} catch (e) {
			console.error("[notebook] split preview", e);
		}
		this.previewPictures.set(key, url);
		return url;
	}

	private describeSplit(plan: SplitPlan): void {
		const percent = String(Math.round(plan.scale * 100));
		const n = plan.tiles.length;
		const parts = [n === 1 ? t("export.split.summary.one", { percent }) : t("export.split.summary", { sheets: String(n), cols: String(plan.cols), rows: String(plan.rows), percent })];
		if (plan.skippedBlank > 0) parts.push(t("export.split.skipped", { n: String(plan.skippedBlank) }));
		if (plan.truncated) parts.push(t("export.split.truncated", { max: String(n) }));
		this.splitSummary?.setText(parts.join(" "));
	}

	onClose(): void {
		window.clearTimeout(this.previewTimer);
		this.previewPictures.clear();
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
