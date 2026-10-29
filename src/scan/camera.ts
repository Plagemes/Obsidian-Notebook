import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { pickFromDevice, type PickedFile } from "../view/pick";
import { detectDocument } from "./detect";
import { toGray } from "./filters";
import { safeSize } from "./image-bytes";

/**
 * In-app camera: getUserMedia in the scanner, frames grabbed to a canvas and encoded as JPEG, so the format of the
 * system camera (HEIF on many Samsung phones) never matters. Obsidian's mobile WebView may refuse camera access: then
 * the camera-app file input is used, and the refusal is remembered for the rest of the session.
 */

const JPEG_QUALITY = 0.92;
const DETECT_EVERY_MS = 300;
const DETECT_WIDTH = 320;

let cameraRefused = false;

export function inAppCameraAvailable(): boolean {
	return !cameraRefused && typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";
}

type CameraResult = { kind: "photos"; files: PickedFile[] } | { kind: "cancel" } | { kind: "picker" };

/** Takes one or more photos: in-app camera when possible, otherwise the camera app through a file input. */
export async function takePhotos(app: App, multiple: boolean): Promise<PickedFile[]> {
	if (inAppCameraAvailable()) {
		const result = await new Promise<CameraResult>((resolve) => new CameraModal(app, multiple, resolve).open());
		if (result.kind === "photos") return result.files;
		if (result.kind === "cancel") return [];
	}
	return pickFromDevice("image", true, multiple);
}

class CameraModal extends Modal {
	private readonly files: PickedFile[] = [];
	private stream: MediaStream | null = null;
	private video!: HTMLVideoElement;
	private overlay!: HTMLCanvasElement;
	private hintEl!: HTMLElement;
	private shutterBtn!: HTMLButtonElement;
	private doneBtn!: HTMLButtonElement;
	private timer = 0;
	private settled = false;
	private closed = false;
	private busy = false;
	private probe: HTMLCanvasElement | null = null;

	constructor(app: App, private readonly multiple: boolean, private readonly finish: (r: CameraResult) => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-scan-modal");
		this.setTitle(t("scan.cameraTitle"));
		const body = this.contentEl.createDiv({ cls: "notebook-scan-body" });
		this.hintEl = body.createDiv({ cls: "notebook-scan-hint", text: t("scan.cameraHint") });
		const stage = body.createDiv({ cls: "notebook-scan-stage" });
		this.video = stage.createEl("video", { cls: "notebook-scan-canvas notebook-scan-video" });
		this.video.muted = true;
		this.video.autoplay = true;
		this.video.setAttribute("playsinline", "");
		this.overlay = stage.createEl("canvas", { cls: "notebook-scan-canvas notebook-scan-overlay" });

		const bar = body.createDiv({ cls: "notebook-scan-bar" });
		this.button(bar, t("scan.cancel"), () => this.complete({ kind: "cancel" }));
		this.button(bar, t("scan.useFilePicker"), () => this.complete({ kind: "picker" }));
		bar.createDiv({ cls: "notebook-scan-spacer" });
		this.doneBtn = this.button(bar, t("scan.capturedDone", { n: "0" }), () => this.complete({ kind: "photos", files: this.files }));
		this.shutterBtn = this.button(bar, t("scan.capture"), () => void this.shoot(), true);
		this.doneBtn.toggle(this.multiple);
		this.doneBtn.disabled = true;
		this.shutterBtn.disabled = true;
		void this.start();
	}

	onClose(): void {
		this.closed = true;
		this.stop();
		this.contentEl.empty();
		if (this.settled) return;
		this.settled = true;
		this.finish({ kind: "cancel" });
	}

	private button(parent: HTMLElement, text: string, onClick: () => void, cta = false): HTMLButtonElement {
		const b = parent.createEl("button", { text, cls: cta ? "mod-cta" : "" });
		b.addEventListener("click", onClick);
		return b;
	}

	private complete(result: CameraResult): void {
		if (this.settled) return;
		this.settled = true;
		this.stop();
		this.finish(result);
		this.close();
	}

	private stop(): void {
		if (this.timer) window.clearInterval(this.timer);
		this.timer = 0;
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		if (this.video) this.video.srcObject = null;
		if (this.probe) {
			this.probe.width = 0;
			this.probe.height = 0;
			this.probe = null;
		}
	}

	private async requestStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
		return navigator.mediaDevices.getUserMedia(constraints);
	}

	private async start(): Promise<void> {
		let stream: MediaStream;
		try {
			try {
				stream = await this.requestStream({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } } });
			} catch (e) {
				if (!(e instanceof DOMException) || e.name !== "OverconstrainedError") throw e;
				stream = await this.requestStream({ audio: false, video: true });
			}
		} catch (e) {
			console.error("Notebook: in-app camera unavailable", e);
			cameraRefused = true;
			if (this.closed) return;
			// A fresh tap is needed to open the camera app (browsers ignore a file input click without a recent gesture).
			this.hintEl.setText(t("scan.cameraFailed"));
			this.video.hide();
			return;
		}
		if (this.closed) {
			stream.getTracks().forEach((track) => track.stop());
			return;
		}
		this.stream = stream;
		this.video.srcObject = stream;
		try {
			await this.video.play();
		} catch (e) {
			console.error("Notebook: camera preview did not start", e);
		}
		this.shutterBtn.disabled = false;
		this.timer = window.setInterval(() => this.detect(), DETECT_EVERY_MS);
	}

	/** Draws the detected page outline over the live preview (cheap: a 320 px frame every 300 ms). */
	private detect(): void {
		const v = this.video;
		if (this.closed || this.busy || v.videoWidth === 0 || v.videoHeight === 0) return;
		try {
			const k = DETECT_WIDTH / v.videoWidth;
			const w = DETECT_WIDTH;
			const h = Math.max(1, Math.round(v.videoHeight * k));
			if (!this.probe) this.probe = activeDocument.createEl("canvas");
			this.probe.width = w;
			this.probe.height = h;
			const pctx = this.probe.getContext("2d", { willReadFrequently: true });
			if (!pctx) return;
			pctx.drawImage(v, 0, 0, w, h);
			const quad = detectDocument(toGray(pctx.getImageData(0, 0, w, h)), w, h);

			const o = this.overlay;
			const cw = o.clientWidth;
			const ch = o.clientHeight;
			if (o.width !== cw || o.height !== ch) {
				o.width = cw;
				o.height = ch;
			}
			const octx = o.getContext("2d");
			if (!octx) return;
			octx.clearRect(0, 0, cw, ch);
			if (!quad || cw === 0 || ch === 0) return;
			// The video is letterboxed (object-fit: contain): map frame coordinates into the visible rectangle.
			const scale = Math.min(cw / v.videoWidth, ch / v.videoHeight);
			const dw = v.videoWidth * scale;
			const dh = v.videoHeight * scale;
			const ox = (cw - dw) / 2;
			const oy = (ch - dh) / 2;
			octx.lineWidth = 3;
			octx.strokeStyle = "#3ddc84";
			octx.beginPath();
			quad.forEach((p, i) => {
				const x = ox + (p.x / w) * dw;
				const y = oy + (p.y / h) * dh;
				if (i === 0) octx.moveTo(x, y);
				else octx.lineTo(x, y);
			});
			octx.closePath();
			octx.stroke();
		} catch {
			// The overlay is a nicety: never let it break the camera.
		}
	}

	private async shoot(): Promise<void> {
		const v = this.video;
		if (this.busy || this.closed || v.videoWidth === 0) return;
		this.busy = true;
		this.shutterBtn.disabled = true;
		try {
			const size = safeSize(v.videoWidth, v.videoHeight);
			const canvas = activeDocument.createEl("canvas");
			canvas.width = size.width;
			canvas.height = size.height;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("2D canvas is not available");
			ctx.drawImage(v, 0, 0, size.width, size.height);
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
			canvas.width = 0;
			canvas.height = 0;
			if (!blob) throw new Error("could not encode JPEG");
			const bytes = await blob.arrayBuffer();
			if (this.closed) return;
			this.files.push({ name: `photo-${this.files.length + 1}.jpg`, bytes, type: "image/jpeg" });
			if (!this.multiple) {
				this.complete({ kind: "photos", files: this.files });
				return;
			}
			this.doneBtn.setText(t("scan.capturedDone", { n: String(this.files.length) }));
			this.doneBtn.disabled = false;
		} catch (e) {
			console.error("Notebook: could not grab a camera frame", e);
			this.hintEl.setText(t("scan.cameraFailed"));
		} finally {
			this.busy = false;
			if (!this.closed) this.shutterBtn.disabled = false;
		}
	}
}
