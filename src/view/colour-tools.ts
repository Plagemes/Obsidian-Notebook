import { t } from "../i18n";
import {
	canvasPixelAt, colourPatch, currentColour, normaliseHex, pickStrokeAt, rememberColour, rgbToHex, styleOfStroke,
} from "../ink/colour";
import {
	buildContextPalette, DominantCache, dominantColours, sampleSize, usedColours, type Raster, type UsageSource,
} from "../ink/context-palette";
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

/** 0.26 (#394): what the picker's "On this page" and "From the slide" rows are made from, for the page in view. */
export interface PageColourContext {
	/** The strokes and elements of the page. */
	usage: UsageSource;
	/** Names the background (asset and page) for the cache; null when the page has none. */
	slideKey: string | null;
	/** The background as it is drawn now, or null while it is not ready (no render is started for this). */
	slide(): CanvasImageSource | null;
	/** The label a colour has in the colour meanings legend, if any. */
	labelOf(hex: string): string | undefined;
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
	/** 0.26 (#394): the page in view for the context rows; absent or null: the picker has no such rows. */
	pageContext?(): PageColourContext | null;
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
	/** 0.26 (#394): dominant colours of the backgrounds seen, per page. */
	private readonly slideCache = new DominantCache();
	private sampleTimer = 0;
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
		this.refreshContext();
	}

	closePicker(): void {
		window.clearTimeout(this.sampleTimer);
		this.picker?.destroy();
		this.picker = null;
	}

	/**
	 * The context rows (#394). The page's own colours are counted at once (a pass over its strokes); the dominant colours of the
	 * background come from a small sample taken in a timer after the picker is shown and are kept per page, so opening the picker
	 * again on that page costs nothing. A background that is not drawn yet simply gives no row; nothing here touches the input.
	 */
	private refreshContext(): void {
		const picker = this.picker;
		const ctx = this.host.pageContext?.();
		if (!picker || !ctx) return;
		const used = usedColours(ctx.usage);
		const build = (slide: readonly { hex: string; share: number }[]): void =>
			picker.setContext(buildContextPalette({ used, slide, recent: this.host.recent(), labelOf: (hex) => ctx.labelOf(hex) }));
		const key = ctx.slideKey;
		const cached = key ? this.slideCache.get(key) : undefined;
		build(cached ?? []);
		if (!key || cached) return;
		window.clearTimeout(this.sampleTimer);
		this.sampleTimer = window.setTimeout(() => {
			if (this.picker !== picker) return;
			const src = ctx.slide();
			const raster = src ? this.rasterOf(src) : null;
			if (!raster) return;
			const dominant = dominantColours(raster);
			this.slideCache.set(key, dominant);
			build(dominant);
		}, 80);
	}

	/** A small RGBA copy of a background, or null when it is not ready or the browser refuses to read it. */
	private rasterOf(src: CanvasImageSource): Raster | null {
		try {
			const s = src as { naturalWidth?: number; naturalHeight?: number; width?: unknown; height?: unknown };
			const w = s.naturalWidth || Number(s.width), h = s.naturalHeight || Number(s.height);
			if (!(w > 0) || !(h > 0)) return null;
			const size = sampleSize(w, h);
			const out = createEl("canvas");
			out.width = size.width;
			out.height = size.height;
			const g = out.getContext("2d", { willReadFrequently: true });
			if (!g) return null;
			g.drawImage(src, 0, 0, size.width, size.height);
			const d = g.getImageData(0, 0, size.width, size.height);
			return { width: d.width, height: d.height, data: d.data };
		} catch {
			return null;
		}
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
			this.refreshContext(); // a colour that is now recent leaves the context rows
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
			tool: t(style.tool === "pen" ? (style.penKind ? (`tool.${style.penKind}` as const) : "tool.pen") : "tool.highlighter"),
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
