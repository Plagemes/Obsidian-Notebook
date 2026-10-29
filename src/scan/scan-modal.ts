import { Modal, Notice, type App } from "obsidian";
import { t } from "../i18n";
import { pickFromDevice, type PickedFile } from "../view/pick";
import { detectDocument } from "./detect";
import { applyFilter, toGray } from "./filters";
import { insetQuad, orderCorners, outputSize, rotatePoint90, warpPerspective } from "./geometry";
import type { ImageDataLike, Pt, Quad, ScanFilter } from "./types";

export interface ScannedSheet {
	jpeg: ArrayBuffer;
	width: number;
	height: number;
	name: string;
}

/** Longest side of the working copy of a photo (memory on Android WebViews). */
const MAX_WORK_SIDE = 2400;
/** Longest side of the on-screen preview of the processed result. */
const MAX_PREVIEW_SIDE = 1100;
const JPEG_QUALITY = 0.85;
const FILTERS: readonly ScanFilter[] = ["original", "document", "whiteboard"];

type Mode = "crop" | "preview";

function baseName(name: string): string {
	const stem = name.replace(/\.[^./\\]+$/, "").trim();
	return stem || "scan";
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
	const c = activeDocument.createEl("canvas");
	c.width = w;
	c.height = h;
	return c;
}

function toImageData(img: ImageDataLike): ImageData {
	return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) return reject(new Error("could not encode JPEG"));
				blob.arrayBuffer().then(resolve, reject);
			},
			"image/jpeg",
			JPEG_QUALITY,
		);
	});
}

class ScanModal extends Modal {
	private readonly queue: PickedFile[];
	private index = 0;
	private readonly results: ScannedSheet[] = [];
	private settled = false;
	private closed = false;

	// Current sheet.
	private work: HTMLCanvasElement | null = null;
	private srcData: ImageData | null = null;
	private corners: Quad = insetQuad(1, 1);
	private preview: HTMLCanvasElement | null = null;
	private previewValid = false;
	private filter: ScanFilter = "document";
	private mode: Mode = "crop";
	private busy = false;
	private failed = false;
	private loadToken = 0;
	private activeCorner = -1;

	// UI.
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private hintEl!: HTMLElement;
	private toggleBtn!: HTMLButtonElement;
	private nextBtn!: HTMLButtonElement;
	private rotateBtn!: HTMLButtonElement;
	private filterBtns = new Map<ScanFilter, HTMLButtonElement>();
	private observer: ResizeObserver | null = null;

	constructor(app: App, sheets: PickedFile[], private readonly finish: (r: ScannedSheet[]) => void) {
		super(app);
		this.queue = [...sheets];
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-scan-modal");
		const body = this.contentEl.createDiv({ cls: "notebook-scan-body" });
		this.hintEl = body.createDiv({ cls: "notebook-scan-hint" });
		const stage = body.createDiv({ cls: "notebook-scan-stage" });
		this.canvas = stage.createEl("canvas", { cls: "notebook-scan-canvas", attr: { "aria-label": t("scan.stage") } });
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("2D canvas is not available");
		this.ctx = ctx;

		const tools = body.createDiv({ cls: "notebook-scan-bar" });
		this.rotateBtn = this.button(tools, t("scan.rotate"), () => this.rotate());
		this.button(tools, t("scan.retake"), () => void this.retake());
		this.button(tools, t("scan.skip"), () => void this.skip());
		tools.createDiv({ cls: "notebook-scan-spacer" });
		this.toggleBtn = this.button(tools, t("scan.preview"), () => void this.setMode(this.mode === "crop" ? "preview" : "crop"));

		const filters = body.createDiv({ cls: "notebook-scan-bar notebook-scan-filters" });
		for (const f of FILTERS) {
			const b = this.button(filters, t(`scan.${f}`), () => void this.setFilter(f));
			this.filterBtns.set(f, b);
		}

		const actions = body.createDiv({ cls: "notebook-scan-bar" });
		this.button(actions, t("scan.cancel"), () => this.close());
		actions.createDiv({ cls: "notebook-scan-spacer" });
		this.nextBtn = this.button(actions, t("scan.next"), () => void this.commit(), true);

		this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
		this.canvas.addEventListener("pointerup", (e) => this.onPointerEnd(e));
		this.canvas.addEventListener("pointercancel", (e) => this.onPointerEnd(e));
		this.observer = new ResizeObserver(() => this.resizeCanvas());
		this.observer.observe(stage);

		this.refreshUi();
		void this.loadCurrent();
	}

	onClose(): void {
		this.closed = true;
		this.loadToken++;
		this.observer?.disconnect();
		this.observer = null;
		this.releaseSheet();
		this.contentEl.empty();
		this.complete([]);
	}

	// --- flow ---

	private complete(result: ScannedSheet[]): void {
		if (this.settled) return;
		this.settled = true;
		this.finish(result);
	}

	private button(parent: HTMLElement, text: string, onClick: () => void, cta = false): HTMLButtonElement {
		const b = parent.createEl("button", { text, cls: cta ? "mod-cta" : "" });
		b.addEventListener("click", onClick);
		return b;
	}

	private releaseSheet(): void {
		if (this.work) {
			this.work.width = 0;
			this.work.height = 0;
		}
		if (this.preview) {
			this.preview.width = 0;
			this.preview.height = 0;
		}
		this.work = null;
		this.preview = null;
		this.srcData = null;
		this.previewValid = false;
	}

	private refreshUi(): void {
		if (this.closed) return;
		const last = this.index >= this.queue.length - 1;
		this.setTitle(t("scan.title", { n: String(this.index + 1), total: String(this.queue.length) }));
		this.nextBtn.setText(last ? t("scan.done") : t("scan.next"));
		this.toggleBtn.setText(this.mode === "crop" ? t("scan.preview") : t("scan.adjust"));
		this.hintEl.setText(this.busy ? t("scan.processing") : this.failed ? t("scan.unreadable") : this.mode === "crop" ? t("scan.hint") : "");
		const ready = !this.busy && !this.failed && this.work !== null;
		this.nextBtn.disabled = !ready;
		this.toggleBtn.disabled = !ready;
		this.rotateBtn.disabled = !ready;
		for (const [f, b] of this.filterBtns) {
			b.toggleClass("is-active", f === this.filter);
			b.setAttr("aria-pressed", f === this.filter ? "true" : "false");
			b.disabled = !ready;
		}
	}

	private async loadCurrent(): Promise<void> {
		const token = ++this.loadToken;
		const file = this.queue[this.index];
		this.releaseSheet();
		this.failed = false;
		this.mode = "crop";
		this.busy = true;
		this.refreshUi();
		this.draw();
		if (!file) return;
		try {
			const bmp = await createImageBitmap(new Blob([file.bytes]));
			if (token !== this.loadToken) {
				bmp.close();
				return;
			}
			const k = Math.min(1, MAX_WORK_SIDE / Math.max(bmp.width, bmp.height));
			const w = Math.max(1, Math.round(bmp.width * k));
			const h = Math.max(1, Math.round(bmp.height * k));
			const work = newCanvas(w, h);
			const wctx = work.getContext("2d", { willReadFrequently: true });
			if (!wctx) throw new Error("2D canvas is not available");
			wctx.imageSmoothingQuality = "high";
			wctx.drawImage(bmp, 0, 0, w, h);
			bmp.close();
			this.work = work;
			this.srcData = wctx.getImageData(0, 0, w, h);
			await nextFrame();
			if (token !== this.loadToken) return;
			this.corners = detectDocument(toGray(this.srcData), w, h) ?? insetQuad(w, h);
		} catch (err) {
			if (token !== this.loadToken) return;
			console.error("Notebook: could not decode the photo", err);
			this.failed = true;
			this.work = null;
			this.srcData = null;
		}
		this.busy = false;
		this.refreshUi();
		this.draw();
	}

	private async advance(): Promise<void> {
		if (this.index >= this.queue.length - 1) {
			this.complete(this.results);
			this.close();
			return;
		}
		this.index++;
		await this.loadCurrent();
	}

	private async skip(): Promise<void> {
		if (this.busy) return;
		await this.advance();
	}

	private async retake(): Promise<void> {
		if (this.busy) return;
		const files = await pickFromDevice("image", true, false);
		const file = files[0];
		if (!file || this.closed) return;
		this.queue[this.index] = file;
		await this.loadCurrent();
	}

	private rotate(): void {
		if (!this.work || this.busy) return;
		const src = this.work;
		const w = src.width;
		const h = src.height;
		const rotated = newCanvas(h, w);
		const rctx = rotated.getContext("2d", { willReadFrequently: true });
		if (!rctx) return;
		rctx.translate(h, 0);
		rctx.rotate(Math.PI / 2);
		rctx.drawImage(src, 0, 0);
		src.width = 0;
		src.height = 0;
		this.work = rotated;
		this.srcData = rctx.getImageData(0, 0, h, w);
		this.corners = orderCorners(this.corners.map((p) => rotatePoint90(p, w, h, true)));
		this.previewValid = false;
		if (this.mode === "preview") void this.renderPreview();
		else this.draw();
	}

	private async setFilter(f: ScanFilter): Promise<void> {
		if (this.busy) return;
		if (f !== this.filter) {
			this.filter = f;
			this.previewValid = false;
		}
		await this.setMode("preview");
	}

	private async setMode(mode: Mode): Promise<void> {
		if (this.busy || !this.work) return;
		this.mode = mode;
		if (mode === "preview") await this.renderPreview();
		else {
			this.refreshUi();
			this.draw();
		}
	}

	/** Warps and filters the current sheet at preview size. */
	private async renderPreview(): Promise<void> {
		if (!this.srcData || this.previewValid) {
			this.refreshUi();
			this.draw();
			return;
		}
		const token = this.loadToken;
		this.busy = true;
		this.refreshUi();
		this.draw();
		await nextFrame();
		try {
			if (token !== this.loadToken || !this.srcData) return;
			const { width, height } = outputSize(this.corners, MAX_PREVIEW_SIDE);
			const out = applyFilter(warpPerspective(this.srcData, this.corners, width, height), this.filter);
			const canvas = this.preview ?? newCanvas(width, height);
			canvas.width = width;
			canvas.height = height;
			canvas.getContext("2d")?.putImageData(toImageData(out), 0, 0);
			this.preview = canvas;
			this.previewValid = true;
		} catch (err) {
			console.error("Notebook: could not process the photo", err);
			new Notice(t("scan.unreadable"));
			this.mode = "crop";
		} finally {
			this.busy = false;
			this.refreshUi();
			this.draw();
		}
	}

	/** Full-resolution result of the current sheet; pushes it and moves on. */
	private async commit(): Promise<void> {
		if (this.busy || !this.srcData) return;
		const token = this.loadToken;
		this.busy = true;
		this.refreshUi();
		this.draw();
		await nextFrame();
		try {
			const { width, height } = outputSize(this.corners, MAX_WORK_SIDE);
			const out = applyFilter(warpPerspective(this.srcData, this.corners, width, height), this.filter);
			const canvas = newCanvas(width, height);
			canvas.getContext("2d")?.putImageData(toImageData(out), 0, 0);
			const jpeg = await canvasToJpeg(canvas);
			canvas.width = 0;
			canvas.height = 0;
			if (token !== this.loadToken || this.closed) return;
			const file = this.queue[this.index];
			this.results.push({ jpeg, width, height, name: `${baseName(file?.name ?? "scan")}-scan.jpg` });
		} catch (err) {
			console.error("Notebook: could not save the scan", err);
			new Notice(t("scan.unreadable"));
			this.busy = false;
			this.refreshUi();
			return;
		}
		this.busy = false;
		await this.advance();
	}

	// --- canvas ---

	private dpr(): number {
		return Math.max(1, window.devicePixelRatio || 1);
	}

	private resizeCanvas(): void {
		const parent = this.canvas.parentElement;
		if (!parent) return;
		const dpr = this.dpr();
		const w = Math.max(1, Math.round(parent.clientWidth * dpr));
		const h = Math.max(1, Math.round(parent.clientHeight * dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
		this.draw();
	}

	/** Where the image sits inside the canvas (canvas pixels). */
	private layout(iw: number, ih: number): { scale: number; ox: number; oy: number } {
		const pad = 22 * this.dpr();
		const scale = Math.max(0.01, Math.min((this.canvas.width - 2 * pad) / iw, (this.canvas.height - 2 * pad) / ih));
		return { scale, ox: (this.canvas.width - iw * scale) / 2, oy: (this.canvas.height - ih * scale) / 2 };
	}

	private cssVar(name: string, fallback: string): string {
		return getComputedStyle(this.canvas).getPropertyValue(name).trim() || fallback;
	}

	private draw(): void {
		const { ctx, canvas } = this;
		const dpr = this.dpr();
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (this.mode === "preview" && this.preview && this.previewValid) {
			const l = this.layout(this.preview.width, this.preview.height);
			ctx.drawImage(this.preview, l.ox, l.oy, this.preview.width * l.scale, this.preview.height * l.scale);
			return;
		}
		if (!this.work) return;
		const w = this.work.width;
		const h = this.work.height;
		const l = this.layout(w, h);
		ctx.drawImage(this.work, l.ox, l.oy, w * l.scale, h * l.scale);
		if (this.mode !== "crop") return;
		const accent = this.cssVar("--interactive-accent", "#7c5cff");
		const pts = this.corners.map((p) => ({ x: l.ox + p.x * l.scale, y: l.oy + p.y * l.scale }));
		// Dim everything outside the quad.
		ctx.save();
		ctx.beginPath();
		ctx.rect(l.ox, l.oy, w * l.scale, h * l.scale);
		ctx.moveTo(pts[0]!.x, pts[0]!.y);
		for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i]!.x, pts[i]!.y);
		ctx.closePath();
		ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
		ctx.fill("evenodd");
		ctx.restore();
		ctx.beginPath();
		ctx.moveTo(pts[0]!.x, pts[0]!.y);
		for (let i = 1; i < 4; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
		ctx.closePath();
		ctx.lineWidth = 2 * dpr;
		ctx.strokeStyle = accent;
		ctx.stroke();
		for (let i = 0; i < 4; i++) {
			const p = pts[i]!;
			ctx.beginPath();
			ctx.arc(p.x, p.y, (i === this.activeCorner ? 9 : 11) * dpr, 0, Math.PI * 2);
			ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
			ctx.fill();
			ctx.lineWidth = 3 * dpr;
			ctx.strokeStyle = accent;
			ctx.stroke();
		}
		if (this.activeCorner >= 0) this.drawLoupe(pts[this.activeCorner]!, this.corners[this.activeCorner]!, l, accent);
	}

	/** Magnifier shown while dragging, in the stage corner farthest from the finger. */
	private drawLoupe(handle: Pt, imgPt: Pt, l: { scale: number }, accent: string): void {
		if (!this.work) return;
		const { ctx, canvas } = this;
		const dpr = this.dpr();
		const r = 56 * dpr;
		const margin = 8 * dpr;
		const left = { x: margin + r, y: margin + r };
		const right = { x: canvas.width - margin - r, y: margin + r };
		const c = Math.hypot(handle.x - left.x, handle.y - left.y) > Math.hypot(handle.x - right.x, handle.y - right.y) ? left : right;
		const zoom = 3;
		const half = r / (l.scale * zoom);
		ctx.save();
		ctx.beginPath();
		ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
		ctx.clip();
		ctx.fillStyle = "#000";
		ctx.fillRect(c.x - r, c.y - r, 2 * r, 2 * r);
		ctx.drawImage(this.work, imgPt.x - half, imgPt.y - half, 2 * half, 2 * half, c.x - r, c.y - r, 2 * r, 2 * r);
		ctx.restore();
		ctx.beginPath();
		ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
		ctx.lineWidth = 3 * dpr;
		ctx.strokeStyle = accent;
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(c.x - 10 * dpr, c.y);
		ctx.lineTo(c.x + 10 * dpr, c.y);
		ctx.moveTo(c.x, c.y - 10 * dpr);
		ctx.lineTo(c.x, c.y + 10 * dpr);
		ctx.lineWidth = 1.5 * dpr;
		ctx.strokeStyle = accent;
		ctx.stroke();
	}

	// --- pointer handling ---

	/** Event position in canvas pixels. */
	private canvasPoint(e: PointerEvent): Pt {
		const rect = this.canvas.getBoundingClientRect();
		return { x: ((e.clientX - rect.left) * this.canvas.width) / Math.max(1, rect.width), y: ((e.clientY - rect.top) * this.canvas.height) / Math.max(1, rect.height) };
	}

	private onPointerDown(e: PointerEvent): void {
		if (this.mode !== "crop" || !this.work || this.busy) return;
		const l = this.layout(this.work.width, this.work.height);
		const p = this.canvasPoint(e);
		const reach = (e.pointerType === "mouse" ? 22 : 40) * this.dpr();
		let best = -1;
		let bestD = reach;
		this.corners.forEach((c, i) => {
			const d = Math.hypot(l.ox + c.x * l.scale - p.x, l.oy + c.y * l.scale - p.y);
			if (d <= bestD) {
				bestD = d;
				best = i;
			}
		});
		if (best < 0) return;
		this.activeCorner = best;
		this.canvas.setPointerCapture(e.pointerId);
		e.preventDefault();
		this.moveCorner(p);
	}

	private onPointerMove(e: PointerEvent): void {
		if (this.activeCorner < 0) return;
		e.preventDefault();
		this.moveCorner(this.canvasPoint(e));
	}

	private onPointerEnd(e: PointerEvent): void {
		if (this.activeCorner < 0) return;
		this.activeCorner = -1;
		if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
		this.draw();
	}

	private moveCorner(p: Pt): void {
		if (!this.work || this.activeCorner < 0) return;
		const l = this.layout(this.work.width, this.work.height);
		const x = Math.min(this.work.width - 1, Math.max(0, (p.x - l.ox) / l.scale));
		const y = Math.min(this.work.height - 1, Math.max(0, (p.y - l.oy) / l.scale));
		this.corners[this.activeCorner] = { x, y };
		this.previewValid = false;
		this.draw();
	}
}

/** Shows the crop / enhance dialog for the given photos. Resolves with one page per kept sheet; empty if cancelled. */
export function openScanner(app: App, sheets: PickedFile[]): Promise<ScannedSheet[]> {
	if (sheets.length === 0) return Promise.resolve([]);
	return new Promise((resolve) => {
		new ScanModal(app, sheets, resolve).open();
	});
}

/** Opens the camera (several shots allowed) and runs the scanner on the photos. */
export async function scanFromCamera(app: App): Promise<ScannedSheet[]> {
	const photos = await pickFromDevice("image", true, true);
	if (photos.length === 0) return [];
	return openScanner(app, photos);
}
