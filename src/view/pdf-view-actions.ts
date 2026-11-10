/**
 * 0.28 (#76, format v26): "Rotate PDF page" and "Crop PDF page…". The logic is in pure modules (model/pdf-view.ts, pdf-view-command.ts,
 * pdf-view-ops.ts, view/pdf-crop-logic.ts); this file is the Obsidian glue: reading the PDF page size, the dialog, the notices.
 * One edit = one undo step, on this page or on every page that shows a page of the same PDF.
 */
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { Batch, type Command } from "../model/history";
import { rotationOf, viewOf, viewSize } from "../model/pdf-view";
import { buildViewCommands, pagesOfSamePdf, type ViewBuild, type ViewEdit } from "../model/pdf-view-ops";
import { MM, type Page } from "../model/types";
import { iconButton } from "../ui/components/dom";
import { modalShell, shellButton, shellCheck, shellNote, type ModalShell } from "../ui/components/modal-shell";
import { CROP_HANDLES, cropToFrame, dragFrame, frameToCrop, sameFrame, wholeFrame, type CropHandle, type Frame } from "./pdf-crop-logic";
import { showNotice } from "./notice";
import type { PdfActionHost } from "./pdf-actions";

type Size = { width: number; height: number };

/** The size of the PDF page (pt at scale 1) behind `page`, or null (and a notice) when it cannot be read. */
async function sourceSizes(host: PdfActionHost, page: Page): Promise<Size[] | null> {
	const bg = page.background;
	if (bg?.kind !== "pdf") {
		showNotice(t("pdf.noPdfPage"));
		return null;
	}
	try {
		return await host.media.pdf.pageSizes(bg.asset);
	} catch (e) {
		console.error("[notebook] PDF page size", e);
		showNotice(t("pdfView.unreadable"));
		return null;
	}
}

/** Runs the commands of a build as one undo step and says what could not be done. */
function runBuild(host: PdfActionHost, page: Page, build: ViewBuild): void {
	if (build.commands.length > 0) {
		const cmds: Command[] = build.commands;
		host.run(cmds.length === 1 ? cmds[0]! : new Batch("Rotate or crop PDF page", cmds), host.doc.pages.indexOf(page));
		if (build.grown > 0) showNotice(t("pdfView.grown", { n: String(build.grown) }), 6000);
	}
	if (build.blocked > 0) showNotice(t("pdfView.blocked", { n: String(build.blocked) }), 9000);
}

/** The targets of an edit: `pages` with the size of the PDF page each one shows. */
function targetsOf(sizes: readonly Size[], pages: readonly Page[]): Array<{ page: Page; source: Size }> {
	const out: Array<{ page: Page; source: Size }> = [];
	for (const page of pages) {
		const bg = page.background;
		const source = bg?.kind === "pdf" ? sizes[bg.page - 1] : undefined;
		if (source) out.push({ page, source });
	}
	return out;
}

/** Page sheet action: turns the PDF page a quarter turn (`turns` 1 = clockwise, -1 = anticlockwise) on this page. */
export async function rotatePdfPage(host: PdfActionHost, page: Page, turns: 1 | -1): Promise<void> {
	if (!host.editable() || page.background?.kind !== "pdf") {
		showNotice(t("pdf.noPdfPage"));
		return;
	}
	const sizes = await sourceSizes(host, page);
	if (!sizes || !host.editable() || !host.doc.pages.includes(page)) return;
	runBuild(host, page, buildViewCommands(targetsOf(sizes, [page]), { turns }));
}

/** Page sheet action: the dialog to turn and crop the PDF page, on this page or on every page of the same PDF. */
export async function openPdfCropModal(host: PdfActionHost, page: Page): Promise<void> {
	if (!host.editable() || page.background?.kind !== "pdf") {
		showNotice(t("pdf.noPdfPage"));
		return;
	}
	const sizes = await sourceSizes(host, page);
	const bg = page.background;
	const source = sizes?.[bg.page - 1];
	if (!sizes || !source || !host.editable() || !host.doc.pages.includes(page)) return;
	new PdfCropModal(host.app, host, page, sizes, source).open();
}

const toMm = (pt: number): number => Math.round((pt / MM) * 10) / 10;
/** The longest side of the preview, CSS px (it is drawn at the screen's density, capped). */
const PREVIEW_PX = 520;

class PdfCropModal extends Modal {
	private shell!: ModalShell;
	/** Rotation shown, degrees. */
	private turned: 0 | 90 | 180 | 270;
	private readonly initialTurn: 0 | 90 | 180 | 270;
	private frame: Frame;
	private readonly initialFrame: Frame;
	private all = false;
	private stage!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private frameEl!: HTMLElement;
	private shadeEl!: HTMLElement;
	private readout!: HTMLElement;
	private applyButton!: HTMLButtonElement;
	private renderSeq = 0;
	private readonly siblings: Page[];

	constructor(app: App, private readonly host: PdfActionHost, private readonly page: Page, private readonly sizes: readonly Size[], private readonly source: Size) {
		super(app);
		const view = viewOf(page.background);
		this.initialTurn = rotationOf(view);
		this.turned = this.initialTurn;
		this.frame = cropToFrame(view?.crop, this.turned, source);
		this.initialFrame = { ...this.frame };
		this.siblings = pagesOfSamePdf(host.doc.pages, page);
	}

	/** Size of the PDF page as shown with the rotation the dialog is at. */
	private shown(): Size {
		return viewSize({ rotate: this.turned === 0 ? undefined : this.turned }, this.source);
	}

	onOpen(): void {
		this.shell = modalShell(this, {
			title: t("pdfView.title"), subtitle: t("pdfView.subtitle"), icon: "crop", size: "wide", cls: "nb-pdfview", seed: "pdf-view",
		});
		const body = this.shell.body;
		shellNote(body, t("pdfView.hint"));
		// The stage is padded so the handles on the edge of the page can be reached; the page inside it is the picture.
		this.stage = body.createDiv({ cls: "nb-pdfview-stage" }).createDiv({ cls: "nb-pdfview-page" });
		this.canvas = this.stage.createEl("canvas", { cls: "nb-pdfview-canvas", attr: { "aria-hidden": "true" } });
		// Decoration: the shade over what the frame leaves out (clipped to the page, never takes a touch).
		this.shadeEl = this.stage.createDiv({ cls: "nb-pdfview-shade", attr: { "aria-hidden": "true" } }).createDiv({ cls: "nb-pdfview-shadefill" });
		this.frameEl = this.stage.createDiv({ cls: "nb-pdfview-frame", attr: { "aria-label": t("pdfView.frame"), role: "group" } });
		this.buildFrame();
		const bar = body.createDiv({ cls: "nb-pdfview-bar" });
		iconButton(bar, "rotate-ccw", t("pdfView.rotateLeft"), () => this.turn(-1), "nb-pdfview-btn", "help.pdfRotateLeft");
		iconButton(bar, "rotate-cw", t("pdfView.rotateRight"), () => this.turn(1), "nb-pdfview-btn", "help.pdfRotateRight");
		shellButton(bar, "secondary", t("pdfView.reset"), () => this.reset(), { icon: "scan" });
		this.readout = bar.createDiv({ cls: "nb-pdfview-readout", attr: { "aria-live": "polite" } });
		if (this.siblings.length > 1) {
			shellCheck(body, t("pdfView.all", { n: String(this.siblings.length) }), this.all, (on) => (this.all = on));
		}
		shellButton(this.shell.foot, "secondary", t("pdf.cancel"), () => this.close());
		this.applyButton = shellButton(this.shell.foot, "primary", t("pdfView.apply"), () => this.apply());
		this.sync();
		void this.drawPreview();
	}

	onClose(): void {
		this.renderSeq++;
		this.contentEl.empty();
	}

	private buildFrame(): void {
		const move = this.frameEl.createDiv({ cls: "nb-pdfview-move", attr: { "data-handle": "move" } });
		this.drag(move, "move");
		for (const h of CROP_HANDLES) {
			const el = this.frameEl.createDiv({ cls: `nb-pdfview-handle is-${h}`, attr: { "data-handle": h, role: "slider", tabindex: "0", "aria-label": t("pdfView.handle") } });
			this.drag(el, h);
		}
	}

	/** Pointer drag (pen, finger or mouse) and arrow keys on one handle. */
	private drag(el: HTMLElement, handle: CropHandle): void {
		let start: { x: number; y: number; frame: Frame; id: number } | null = null;
		el.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			start = { x: e.clientX, y: e.clientY, frame: { ...this.frame }, id: e.pointerId };
			try {
				el.setPointerCapture(e.pointerId);
			} catch {
				// A pointer that is already gone (or a synthetic one): the drag goes on without capture.
			}
		});
		el.addEventListener("pointermove", (e) => {
			if (!start || e.pointerId !== start.id) return;
			const rect = this.stage.getBoundingClientRect();
			const shown = this.shown();
			if (rect.width <= 0 || rect.height <= 0) return;
			const dx = ((e.clientX - start.x) / rect.width) * shown.width;
			const dy = ((e.clientY - start.y) / rect.height) * shown.height;
			this.frame = dragFrame(start.frame, handle, dx, dy, shown);
			this.sync();
		});
		const end = (e: PointerEvent): void => {
			if (start && e.pointerId === start.id) start = null;
		};
		el.addEventListener("pointerup", end);
		el.addEventListener("pointercancel", end);
		el.addEventListener("keydown", (e) => {
			const step = e.shiftKey ? 10 : 2;
			const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
			const dy = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
			if (dx === 0 && dy === 0) return;
			e.preventDefault();
			this.frame = dragFrame(this.frame, handle, dx, dy, this.shown());
			this.sync();
		});
	}

	/** Turns the shown page a quarter turn; the frame stays on the same part of the PDF. */
	private turn(dir: 1 | -1): void {
		const crop = frameToCrop(this.frame, this.turned, this.source);
		this.turned = ((this.turned + dir * 90 + 360) % 360) as 0 | 90 | 180 | 270;
		this.frame = cropToFrame(crop ?? undefined, this.turned, this.source);
		void this.drawPreview();
		this.sync();
	}

	private reset(): void {
		this.frame = wholeFrame(this.shown());
		this.sync();
	}

	/** Puts the frame on the stage and refreshes the readout and the Apply button. */
	private sync(): void {
		const shown = this.shown();
		const pct = (v: number, of: number): string => `${Math.round((v / of) * 10000) / 100}%`;
		this.stage.setCssProps({ "--nb-pv-w": String(Math.round(shown.width)), "--nb-pv-h": String(Math.round(shown.height)) });
		const place = {
			"--nb-pv-x": pct(this.frame.x, shown.width), "--nb-pv-y": pct(this.frame.y, shown.height),
			"--nb-pv-fw": pct(this.frame.width, shown.width), "--nb-pv-fh": pct(this.frame.height, shown.height),
		};
		this.frameEl.setCssProps(place);
		this.shadeEl.setCssProps(place);
		this.readout.setText(t("pdfView.kept", { w: String(toMm(this.frame.width)), h: String(toMm(this.frame.height)) }));
		this.applyButton.disabled = !this.changed();
	}

	private changed(): boolean {
		return this.turned !== this.initialTurn || !sameFrame(this.frame, this.initialFrame);
	}

	/** The preview: the whole PDF page, turned as the dialog has it. */
	private async drawPreview(): Promise<void> {
		const seq = ++this.renderSeq;
		const bg = this.page.background;
		if (bg?.kind !== "pdf") return;
		const shown = this.shown();
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const scale = (PREVIEW_PX * dpr) / Math.max(shown.width, shown.height);
		try {
			const bitmap = await this.host.media.pdf.render(bg.asset, bg.page, scale, this.turned === 0 ? undefined : { rotate: this.turned });
			if (seq !== this.renderSeq) return;
			this.canvas.width = bitmap.width;
			this.canvas.height = bitmap.height;
			this.canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
		} catch (e) {
			// A superseded render rejects with an AbortError: a newer one is on its way.
			if (seq === this.renderSeq) console.error("[notebook] crop preview", e);
		}
	}

	private apply(): void {
		if (!this.changed() || !this.host.editable()) {
			this.close();
			return;
		}
		const turns = ((((this.turned - this.initialTurn) / 90) % 4) + 4) % 4;
		const edit: ViewEdit = { turns };
		// The crop is stored on the PDF page itself (unrotated), so it is the same whatever the turn. A turn alone keeps the crop each page has.
		const cropNow = frameToCrop(this.frame, this.turned, this.source);
		const cropBefore = frameToCrop(this.initialFrame, this.initialTurn, this.source);
		if (JSON.stringify(cropNow) !== JSON.stringify(cropBefore)) edit.crop = cropNow;
		const pages = this.all ? this.siblings : [this.page];
		const build = buildViewCommands(targetsOf(this.sizes, pages.filter((p) => this.host.doc.pages.includes(p))), edit);
		this.close();
		runBuild(this.host, this.page, build);
	}
}
