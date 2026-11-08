// 0.23 (#280): "Export written area / selection": the written part of a page (or the selected items) as a picture with a transparent
// background, PNG at 1x/2x/3x or SVG (vector). The pictures come from the existing renderers (page-images for the PNG, export-svg for
// the SVG, ink layer only), the file goes next to the notebook through the vault API (recorded as written by the plugin, never
// overwriting), and the picture can be copied to the clipboard where the device allows it. The notebook is only read.
import { Modal, Setting, normalizePath, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { AREA_SCALES, DEFAULT_AREA_SCALE, areaSuffix, areaSvg, planArea, type AreaFormat, type AreaPlan, type AreaScale, type AreaScope } from "../ink/export-area";
import { pageToSvg, type SvgPlacedImage } from "../ink/export-svg";
import type { Page, PageElement, Stroke } from "../model/types";
import { scaleDpi } from "../model/export-pages";
import { recordPluginWrite } from "../storage/plugin-written";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { collectPageImages, freePath, jpegDataUrl, type ExportOptions } from "./export";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer, type PageImageOptions } from "./page-images";

export interface AreaHost {
	app: App;
	file: TFile;
	/** The page as the view shows it (the live view of a page with states). */
	page: Page;
	pageNumber: number;
	/** The selected items of that page, or null when nothing is selected (then only the page area is offered). */
	selection: { strokes: readonly Stroke[]; elements: readonly PageElement[] } | null;
	media: NotebookMedia | null;
	exportOptions: ExportOptions;
	render: PageImageOptions;
}

export interface AreaRequest {
	scope: AreaScope;
	format: AreaFormat;
	scale: AreaScale;
}

/** The choices of the last export in this session (not saved). */
const last: AreaRequest = { scope: "page", format: "png", scale: DEFAULT_AREA_SCALE };

export interface AreaPicture {
	png: Blob | null;
	svg: string | null;
	/** Pictures that could not be loaded (the export is made without them). */
	skipped: number;
}

/** Draws the picture of a plan; throws when it cannot be made. Transparent: the ink layer only (no sheet, background or paper). */
export async function drawAreaPicture(host: AreaHost, plan: AreaPlan, request: AreaRequest): Promise<AreaPicture> {
	const options = host.exportOptions;
	await options.prepare?.([plan.page]);
	if (request.format === "svg") {
		const { images, skipped } = await collectPageImages(host.media, [plan.page], "ink");
		const placed = (p: Page): SvgPlacedImage[] => (images.get(p) ?? []).map((img) => ({
			href: jpegDataUrl(img.jpeg), x: img.x, y: img.y, width: img.width, height: img.height,
			...(img.rotation !== undefined ? { rotation: img.rotation } : {}),
			...(img.layer !== undefined ? { layer: img.layer } : {}),
		}));
		const svg = pageToSvg(plan.page, {
			paper: false, layers: "ink", images: placed, hiddenInk: options.hiddenInk?.(host.page) ?? false,
			...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
			...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
		});
		const cropped = areaSvg(svg, plan.rect);
		if (!cropped) throw new Error("could not build the SVG");
		return { png: null, svg: cropped, skipped };
	}
	const renderer = new PageImageRenderer(host.media, { ...host.render, layers: "ink" });
	try {
		const drawn = await renderer.renderRegions(plan.page, scaleDpi(request.scale), [plan.rect]);
		const blob = drawn.blobs[0];
		if (!blob) throw new Error("could not encode PNG");
		return { png: blob, svg: null, skipped: drawn.skipped };
	} finally {
		renderer.close();
	}
}

/** The plan of a request, or null (and a notice) when there is nothing written to export. */
function planOf(host: AreaHost, scope: AreaScope): AreaPlan | null {
	const hidden = host.exportOptions.hiddenInk?.(host.page) ?? false;
	const plan = planArea(host.page, scope === "selection" ? host.selection : null, hidden);
	if (!plan) showNotice(t(scope === "selection" ? "exportArea.emptySelection" : "exportArea.empty"), 6000);
	return plan;
}

/**
 * Saves the picture next to the notebook; returns the path or null (nothing written, the reason is shown). Never throws. `quiet`: the caller
 * says the outcome itself (Copy as image), so the "working" and "saved" notices are left to it; a failure is still told.
 */
export async function saveArea(host: AreaHost, request: AreaRequest, quiet = false): Promise<string | null> {
	const plan = planOf(host, request.scope);
	if (!plan) return null;
	const working = quiet ? null : showNotice(t("export.working"), 0);
	try {
		const picture = await drawAreaPicture(host, plan, request);
		const path = freePath(host.app, host.file, areaSuffix(host.pageNumber, request.scope), request.format);
		recordPluginWrite(host.app, [normalizePath(path)]); // before the write: the inbox must not offer this picture
		if (picture.png) await host.app.vault.createBinary(path, await picture.png.arrayBuffer());
		else await host.app.vault.create(path, picture.svg ?? "");
		if (!quiet) showNotice(t("export.done", { path }));
		if (picture.skipped > 0) showNotice(t("export.skipped", { n: String(picture.skipped) }), 8000);
		return path;
	} catch (e) {
		console.error("[notebook] export area", e);
		showNotice(t("export.failed", { error: e instanceof Error ? e.message : String(e) }), 9000);
		return null;
	} finally {
		working?.hide();
	}
}

/** Whether this device lets the plugin put a picture or text on the clipboard. */
export function canCopyPicture(): boolean {
	return typeof navigator !== "undefined" && !!navigator.clipboard && typeof navigator.clipboard.writeText === "function";
}

/** Copies the picture (PNG as an image, SVG as its source text) to the clipboard. Never throws. */
export async function copyArea(host: AreaHost, request: AreaRequest): Promise<boolean> {
	const plan = planOf(host, request.scope);
	if (!plan) return false;
	try {
		const picture = await drawAreaPicture(host, plan, request);
		if (picture.png) {
			if (typeof ClipboardItem === "undefined") throw new Error(t("exportArea.noImageClipboard"));
			await navigator.clipboard.write([new ClipboardItem({ "image/png": picture.png })]);
		} else await navigator.clipboard.writeText(picture.svg ?? "");
		showNotice(t("exportArea.copied"), 4000);
		return true;
	} catch (e) {
		console.error("[notebook] copy area", e);
		showNotice(t("exportArea.copyFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		return false;
	}
}

export class AreaExportModal extends Modal {
	private request: AreaRequest;
	private scaleSetting: Setting | null = null;
	private note: HTMLElement | null = null;

	constructor(private readonly host: AreaHost, initial: Partial<AreaRequest> = {}) {
		super(host.app);
		const wantsSelection = (initial.scope ?? last.scope) === "selection" && host.selection !== null;
		this.request = { ...last, ...initial, scope: wantsSelection ? "selection" : "page" };
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("exportArea.title"), icon: "crop", size: "medium", cls: "notebook-export-area-modal" });
		const body = shell.body;
		new Setting(body).setName(t("exportArea.scope")).addDropdown((dd) => {
			dd.addOption("page", t("exportArea.scope.page", { n: String(this.host.pageNumber) }));
			if (this.host.selection) dd.addOption("selection", t("exportArea.scope.selection"));
			dd.setValue(this.request.scope).onChange((v) => {
				this.request.scope = v === "selection" && this.host.selection ? "selection" : "page";
				this.describe();
			});
		});
		new Setting(body).setName(t("exportArea.format")).addDropdown((dd) => {
			dd.addOption("png", t("exportArea.format.png")).addOption("svg", t("exportArea.format.svg"));
			dd.setValue(this.request.format).onChange((v) => {
				this.request.format = v === "svg" ? "svg" : "png";
				this.scaleSetting?.settingEl.toggle(this.request.format === "png");
				this.describe();
			});
		});
		this.scaleSetting = new Setting(body).setName(t("export.png.scale"));
		this.scaleSetting.addDropdown((dd) => {
			for (const s of AREA_SCALES) dd.addOption(String(s), t("export.png.scale.option", { scale: String(s), dpi: String(scaleDpi(s)) }));
			dd.setValue(String(this.request.scale)).onChange((v) => {
				const s = AREA_SCALES.find((x) => x === Number(v));
				if (s) this.request.scale = s;
				this.describe();
			});
		});
		this.scaleSetting.settingEl.toggle(this.request.format === "png");
		this.note = shellNote(body, "");
		this.note.addClass("notebook-export-note");
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		if (canCopyPicture()) {
			shellButton(shell.foot, "secondary", t("exportArea.copy"), () => {
				this.remember();
				void copyArea(this.host, { ...this.request }).then((ok) => { if (ok) this.close(); });
			}, { icon: "copy" });
		}
		shellButton(shell.foot, "primary", t("exportArea.save"), () => {
			this.remember();
			void saveArea(this.host, { ...this.request }).then((path) => { if (path) this.close(); });
		}, { icon: "save" });
		this.describe();
	}

	private remember(): void {
		last.scope = this.request.scope;
		last.format = this.request.format;
		last.scale = this.request.scale;
	}

	/** The sentence that says what will be written and how big it is. */
	private describe(): void {
		const plan = planArea(this.host.page, this.request.scope === "selection" ? this.host.selection : null, this.host.exportOptions.hiddenInk?.(this.host.page) ?? false);
		if (!plan) {
			this.note?.setText(t(this.request.scope === "selection" ? "exportArea.emptySelection" : "exportArea.empty"));
			return;
		}
		const { width, height } = plan.rect;
		this.note?.setText(t(this.request.format === "png" ? "exportArea.note.png" : "exportArea.note.svg", {
			w: String(Math.round(width)), h: String(Math.round(height)),
			px: String(Math.round(width * this.request.scale)), py: String(Math.round(height * this.request.scale)),
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
