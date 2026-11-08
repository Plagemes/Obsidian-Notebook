import { Modal, Notice, type App } from "obsidian";
import { t } from "../i18n";
import type { ClipContent } from "../ink/clipboard";
import { measureText } from "../ink/renderer";
import { padStroke, signatureClip } from "../ink/signature";
import { stampPreview } from "../ink/stamps";
import type { Point, Stroke } from "../model/types";
import { loadSignature, saveSignature } from "../storage/signature";
import { modalShell, shellButton, shellCheck, shellNote } from "../ui/components/modal-shell";

/** Ink of the signature pad: a dark blue-black that reads on any page paper. */
const PAD_INK = "#1f2a44";
const PAD_WIDTH = 2.4;
/** A new point is kept when it is at least this far (CSS px) from the last one. */
const MIN_STEP = 1.2;

/** The part of the notebook view the sign dialog needs. */
export interface SignHost {
	app: App;
	folder(): string;
	/** The date text a stamp would carry now (the setting's format). */
	dateText(): string;
	/** Places the signature and/or the date (one undo step); the view picks the spot. */
	place(signature: ClipContent | null, withDate: boolean): void;
}

function drawSvg(parent: HTMLElement, clip: ClipContent): void {
	const p = stampPreview(clip, measureText);
	const svg = parent.createSvg("svg", {
		attr: { viewBox: `${p.box.x} ${p.box.y} ${p.box.w} ${p.box.h}`, preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" },
	});
	for (const s of p.strokes) {
		svg.createSvg("path", {
			attr: { d: s.d, fill: "none", stroke: s.color, "stroke-width": String(s.width), "stroke-linecap": "round", "stroke-linejoin": "round" },
		});
	}
}

/**
 * "Sign and date" (roadmap 154): shows the saved signature, opens the pad to draw or redraw it, and places the signature
 * with or without today's date. The signature is a personal stamp, so it is stored like any other.
 */
export class SignDialog extends Modal {
	private signature: ClipContent | null = null;
	private withDate = true;
	private previewEl: HTMLElement | null = null;
	private placeBtn: HTMLButtonElement | null = null;
	private drawBtn: HTMLButtonElement | null = null;
	private closed = false;

	constructor(app: App, private readonly host: SignHost) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("sign.title"), subtitle: t("sign.subtitle"), icon: "signature", size: "narrow", cls: "nb-sign" });
		this.previewEl = shell.body.createDiv({ cls: "nb-sign-preview", attr: { role: "img", "aria-label": t("sign.previewLabel") } });
		shellCheck(shell.body, t("sign.addDate", { date: this.host.dateText() }), this.withDate, (on) => {
			this.withDate = on;
			this.update();
		});
		shellNote(shell.body, t("sign.hint"));
		shellButton(shell.foot, "secondary", t("library.modal.cancel"), () => this.close());
		this.drawBtn = shellButton(shell.foot, "secondary", t("sign.draw"), () => this.openPad(), { icon: "pen-line" });
		this.placeBtn = shellButton(shell.foot, "primary", t("sign.place"), () => this.place(), { icon: "signature" });
		this.update();
		void loadSignature(this.app, this.host.folder()).then((clip) => {
			if (this.closed) return;
			this.signature = clip;
			this.update();
		}, () => undefined);
	}

	private update(): void {
		const prev = this.previewEl;
		if (!prev) return;
		prev.empty();
		if (this.signature) drawSvg(prev, this.signature);
		else prev.createDiv({ cls: "nb-sign-empty", text: t("sign.none") });
		const label = this.drawBtn?.querySelector(".nb-modal-btn-label");
		if (label) label.textContent = this.signature ? t("sign.redraw") : t("sign.draw");
		if (this.placeBtn) this.placeBtn.disabled = !this.signature && !this.withDate;
	}

	private openPad(): void {
		new SignaturePadModal(this.app, this.host.folder(), (clip) => {
			this.signature = clip;
			this.update();
		}).open();
	}

	private place(): void {
		this.close();
		this.host.place(this.signature, this.withDate);
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}
}

/** The pad: draw the signature with a finger, a pen or a mouse; Save keeps it as the stamp "My signature". */
export class SignaturePadModal extends Modal {
	private strokes: Stroke[] = [];
	private current: Point[] | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private saveBtn: HTMLButtonElement | null = null;
	private clearBtn: HTMLButtonElement | null = null;
	private undoBtn: HTMLButtonElement | null = null;
	private saving = false;

	constructor(app: App, private readonly folder: string, private readonly done: (clip: ClipContent) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("sign.padTitle"), subtitle: t("sign.padSubtitle"), icon: "pen-line", size: "narrow", cls: "nb-sign nb-sign-pad" });
		const wrap = shell.body.createDiv({ cls: "nb-sign-pad-wrap" });
		wrap.createDiv({ cls: "nb-sign-baseline", attr: { "aria-hidden": "true" } });
		this.canvas = wrap.createEl("canvas", { cls: "nb-sign-canvas", attr: { role: "img", "aria-label": t("sign.padLabel") } });
		this.attach(this.canvas);
		shellButton(shell.foot, "secondary", t("library.modal.cancel"), () => this.close());
		this.undoBtn = shellButton(shell.foot, "secondary", t("sign.undo"), () => this.undo(), { icon: "undo-2", disabled: true });
		this.clearBtn = shellButton(shell.foot, "secondary", t("sign.clear"), () => this.clear(), { icon: "eraser", disabled: true });
		this.saveBtn = shellButton(shell.foot, "primary", t("sign.save"), () => void this.save(), { icon: "check", disabled: true });
		window.requestAnimationFrame(() => this.fit());
	}

	/** Backing store at the device pixel ratio of the laid-out size. */
	private fit(): void {
		const c = this.canvas;
		if (!c) return;
		const r = c.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		c.width = Math.max(1, Math.round(r.width * dpr));
		c.height = Math.max(1, Math.round(r.height * dpr));
		this.paint();
	}

	private attach(c: HTMLCanvasElement): void {
		let id: number | null = null;
		const at = (e: PointerEvent): Point => {
			const r = c.getBoundingClientRect();
			return [Math.round((e.clientX - r.left) * 100) / 100, Math.round((e.clientY - r.top) * 100) / 100, e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : 0.5];
		};
		const add = (p: Point) => {
			const cur = this.current;
			if (!cur) return;
			const last = cur[cur.length - 1];
			if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= MIN_STEP) cur.push(p);
		};
		c.addEventListener("pointerdown", (e) => {
			if (id !== null || e.button !== 0) return;
			e.preventDefault();
			id = e.pointerId;
			try {
				c.setPointerCapture(e.pointerId);
			} catch {
				// Capture only keeps the stroke going outside the canvas.
			}
			this.current = [at(e)];
			this.paint();
		});
		c.addEventListener("pointermove", (e) => {
			if (e.pointerId !== id) return;
			const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
			for (const ev of events.length > 0 ? events : [e]) add(at(ev));
			this.paint();
		});
		const end = (e: PointerEvent) => {
			if (e.pointerId !== id) return;
			id = null;
			const cur = this.current;
			this.current = null;
			if (cur && cur.length > 0) {
				if (cur.length === 1) cur.push([cur[0]![0] + 0.1, cur[0]![1], cur[0]![2]]);
				this.strokes.push(padStroke(PAD_INK, PAD_WIDTH, cur));
			}
			this.paint();
			this.buttons();
		};
		c.addEventListener("pointerup", end);
		c.addEventListener("pointercancel", end);
	}

	private paint(): void {
		const c = this.canvas;
		const ctx = c?.getContext("2d");
		if (!c || !ctx) return;
		const dpr = c.width / Math.max(1, c.getBoundingClientRect().width);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, c.width, c.height);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.strokeStyle = PAD_INK;
		ctx.lineWidth = PAD_WIDTH;
		const line = (pts: readonly Point[]) => {
			ctx.beginPath();
			ctx.moveTo(pts[0]![0], pts[0]![1]);
			for (let i = 1; i < pts.length - 1; i++) {
				const m: [number, number] = [(pts[i]![0] + pts[i + 1]![0]) / 2, (pts[i]![1] + pts[i + 1]![1]) / 2];
				ctx.quadraticCurveTo(pts[i]![0], pts[i]![1], m[0], m[1]);
			}
			const last = pts[pts.length - 1]!;
			ctx.lineTo(last[0], last[1]);
			ctx.stroke();
		};
		for (const s of this.strokes) line(s.points);
		if (this.current && this.current.length > 0) line(this.current.length === 1 ? [this.current[0]!, this.current[0]!] : this.current);
	}

	private buttons(): void {
		const none = this.strokes.length === 0;
		if (this.saveBtn) this.saveBtn.disabled = none || this.saving;
		if (this.clearBtn) this.clearBtn.disabled = none;
		if (this.undoBtn) this.undoBtn.disabled = none;
	}

	private undo(): void {
		this.strokes.pop();
		this.paint();
		this.buttons();
	}

	private clear(): void {
		this.strokes = [];
		this.paint();
		this.buttons();
	}

	private async save(): Promise<void> {
		const clip = signatureClip(this.strokes, measureText);
		if (!clip || this.saving) return;
		this.saving = true;
		this.buttons();
		try {
			const file = await saveSignature(this.app, this.folder, clip);
			new Notice(t("sign.saved", { name: file.basename }));
			this.close();
			this.done(clip);
		} catch (e) {
			console.error("[notebook] save signature", e);
			new Notice(t("stamps.saveFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
			this.saving = false;
			this.buttons();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
