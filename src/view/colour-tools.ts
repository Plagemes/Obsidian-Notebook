import { t } from "../i18n";
import {
	canvasPixelAt, colourPatch, currentColour, normaliseHex, pickStrokeAt, rememberColour, rgbToHex, styleOfStroke,
} from "../ink/colour";
import type { Stroke } from "../model/types";
import { ColourPicker } from "./colour-picker";
import type { ToolbarState } from "./toolbar";

/** What the page under a point gives the style eyedropper: the strokes in view and the point in page coordinates. */
export interface PageInk {
	strokes: readonly Stroke[];
	/** Page coordinates (pt). */
	x: number;
	y: number;
	/** CSS px per pt, to turn the finger tolerance into pt. */
	scale: number;
}

export interface ColourToolsHost {
	/** The page area: the picker floats in it, the eyedropper reads its canvases. */
	stage: HTMLElement;
	editable(): boolean;
	tools(): ToolbarState;
	/** Changes the toolbar state as its buttons do. */
	apply(patch: Partial<ToolbarState>): void;
	/** The remembered custom colours (plugin settings), newest first. */
	recent(): readonly string[];
	setRecent(list: string[]): void;
	notify(text: string): void;
	/** The visible strokes of the page under a screen point, or null when there is no page there. */
	inkAt(clientX: number, clientY: number): PageInk | null;
}

export type EyedropperMode = "colour" | "style";

/** A tap on a stroke may be this far (CSS px) from its drawn ink: a finger or a pen tip a little off. */
const TAP_TOLERANCE_PX = 10;

/**
 * The free colour picker (roadmap 7), the page eyedropper (7) and the style eyedropper (68) of one notebook view.
 * Self-contained: the registry actions `colour-picker`, `colour-eyedropper` and `style-eyedropper`, the toolbar's colour
 * row and the radial dial's colour ring all call it. The eyedropper takes the next contact on the page (window
 * capture phase, like the radial dial), so nothing is drawn; a contact on the toolbar or a panel cancels it instead.
 */
export class ColourTools {
	private picker: ColourPicker | null = null;
	private mode: EyedropperMode | null = null;
	private toolAtArm = "";
	private contact: { id: number; x: number; y: number } | null = null;
	private loupe: HTMLElement | null = null;
	private sampler: HTMLCanvasElement | null = null;

	constructor(private readonly host: ColourToolsHost) {}

	get pickerOpen(): boolean {
		return this.picker !== null;
	}

	/** The eyedropper waits for a contact on the page ("colour": pixel under it; "style": stroke under it). */
	get armed(): EyedropperMode | null {
		return this.mode;
	}

	// --- the picker ---

	togglePicker(): void {
		if (this.picker) this.closePicker();
		else this.openPicker();
	}

	openPicker(): void {
		if (!this.host.editable() || this.picker) return;
		this.cancelEyedropper();
		const picker = new ColourPicker(this.host.stage, currentColour(this.host.tools()), this.host.recent(), {
			change: (hex, commit) => this.setInkColour(hex, commit),
			eyedropper: () => this.armEyedropper("colour"),
			close: () => this.closePicker(),
		});
		this.picker = picker;
		picker.focus();
	}

	closePicker(): void {
		this.picker?.destroy();
		this.picker = null;
	}

	/** Sets the colour of the tool in use; `remember` also keeps it in the recent custom colours. */
	setInkColour(hex: string, remember: boolean): void {
		const colour = normaliseHex(hex);
		if (!colour || !this.host.editable()) return;
		const s = this.host.tools();
		this.host.apply(colourPatch(s.tool, s.eraserFilter, colour));
		if (remember) {
			const list = rememberColour(this.host.recent(), colour);
			this.host.setRecent(list);
			this.picker?.setRecent(list);
		}
	}

	/** The toolbar changed (a swatch, a favourite, the dial): keep the picker on the colour in use; drop a stale eyedropper. */
	noteTools(state: ToolbarState): void {
		this.picker?.setColour(currentColour(state));
		if (this.mode && state.tool !== this.toolAtArm) this.cancelEyedropper();
	}

	// --- the eyedroppers ---

	armEyedropper(mode: EyedropperMode): void {
		if (!this.host.editable()) return;
		this.cancelEyedropper();
		this.mode = mode;
		this.toolAtArm = this.host.tools().tool;
		this.host.notify(t(mode === "style" ? "colour.styleHint" : "radial.eyedropperHint"));
		window.addEventListener("pointerdown", this.onDown, true);
		window.addEventListener("keydown", this.onKey, true);
	}

	cancelEyedropper(): void {
		window.removeEventListener("pointerdown", this.onDown, true);
		window.removeEventListener("keydown", this.onKey, true);
		this.removeContactListeners();
		this.contact = null;
		this.mode = null;
		this.loupe?.remove();
		this.loupe = null;
	}

	destroy(): void {
		this.cancelEyedropper();
		this.closePicker();
		this.sampler = null;
	}

	private readonly onKey = (e: KeyboardEvent): void => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		this.cancelEyedropper();
	};

	/** Only the page itself (the stage or its canvases) is picked from; anything else the reader touches ends the mode and acts. */
	private isPage(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el || !this.host.stage.contains(el)) return false;
		return el === this.host.stage || el.tagName === "CANVAS";
	}

	private readonly onDown = (e: PointerEvent): void => {
		if (this.contact) {
			stop(e);
			return;
		}
		if (!this.isPage(e.target)) {
			// Another contact (e.g. the picker panel) is not ours; the toolbar and the rest end the mode and work as usual.
			if (!(e.target as HTMLElement | null)?.closest?.(".notebook-colour-picker")) this.cancelEyedropper();
			return;
		}
		stop(e);
		this.contact = { id: e.pointerId, x: e.clientX, y: e.clientY };
		for (const type of ["pointermove", "pointerrawupdate", "pointerup", "pointercancel"]) window.addEventListener(type, this.onContact, true);
		this.showLoupe(e.clientX, e.clientY);
	};

	private readonly onContact = (ev: Event): void => {
		const e = ev as PointerEvent;
		const c = this.contact;
		if (!c || e.pointerId !== c.id) return;
		stop(e);
		if (e.type === "pointercancel") {
			this.endContact();
			return;
		}
		c.x = e.clientX;
		c.y = e.clientY;
		if (e.type === "pointerup") {
			this.endContact();
			this.pick(c.x, c.y);
		} else {
			this.showLoupe(c.x, c.y);
		}
	};

	private removeContactListeners(): void {
		for (const type of ["pointermove", "pointerrawupdate", "pointerup", "pointercancel"]) window.removeEventListener(type, this.onContact, true);
	}

	private endContact(): void {
		this.removeContactListeners();
		this.contact = null;
		this.loupe?.remove();
		this.loupe = null;
	}

	private pick(x: number, y: number): void {
		const mode = this.mode;
		if (!mode) return;
		if (mode === "colour") {
			const hex = this.sample(x, y);
			if (!hex) {
				this.host.notify(t("colour.nothingThere"));
				return;
			}
			this.cancelEyedropper();
			this.setInkColour(hex, true);
			return;
		}
		const ink = this.host.inkAt(x, y);
		const stroke = ink ? pickStrokeAt(ink.strokes, ink.x, ink.y, TAP_TOLERANCE_PX / Math.max(0.05, ink.scale)) : null;
		if (!stroke) {
			this.host.notify(t("colour.noStroke"));
			return;
		}
		this.cancelEyedropper();
		const style = styleOfStroke(stroke);
		this.host.apply(style);
		this.host.notify(t("colour.styleTaken", {
			tool: t(style.tool === "pen" ? "tool.pen" : "tool.highlighter"),
			color: style.tool === "pen" ? style.penColor : style.highlighterColor,
			width: String(style.tool === "pen" ? style.penWidth : style.highlighterWidth),
		}));
	}

	/** A small swatch with the colour under the contact, drawn above it so a finger does not cover it. */
	private showLoupe(clientX: number, clientY: number): void {
		if (this.mode !== "colour") return;
		const stage = this.host.stage.getBoundingClientRect();
		const hex = this.sample(clientX, clientY);
		const loupe = this.loupe ?? (this.loupe = this.host.stage.createDiv({ cls: "notebook-eyedropper-loupe", attr: { "aria-hidden": "true" } }));
		loupe.setCssProps({ left: `${clientX - stage.left}px`, top: `${clientY - stage.top}px`, "--c": hex ?? "transparent" });
		loupe.setText(hex ?? "");
	}

	/** The colour at a screen point: every canvas of the stage composited over white paper, read at the canvas pixel (device pixels). */
	private sample(clientX: number, clientY: number): string | null {
		try {
			const out = this.sampler ?? (this.sampler = createEl("canvas"));
			out.width = out.height = 1;
			const g = out.getContext("2d", { willReadFrequently: true });
			if (!g) return null;
			g.fillStyle = "#ffffff";
			g.fillRect(0, 0, 1, 1);
			let hit = false;
			for (const c of Array.from(this.host.stage.querySelectorAll("canvas"))) {
				const px = canvasPixelAt(c.getBoundingClientRect(), c, clientX, clientY);
				if (!px) continue;
				hit = true;
				g.drawImage(c, px[0], px[1], 1, 1, 0, 0, 1, 1);
			}
			if (!hit) return null;
			const d = g.getImageData(0, 0, 1, 1).data;
			return rgbToHex({ r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0 });
		} catch (e) {
			console.error("[notebook] eyedropper failed", e);
			return null;
		}
	}
}

function stop(e: Event): void {
	e.stopPropagation();
	e.preventDefault();
}
