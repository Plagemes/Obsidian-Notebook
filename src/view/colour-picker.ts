import { setIcon } from "obsidian";
import { t } from "../i18n";
import { hexToHsv, hsvToHex, normaliseHex, type Hsv } from "../ink/colour";

export interface ColourPickerHandlers {
	/** The colour changed. `commit`: the choice is final (finger lifted, hex entered, recent colour tapped): remember it. */
	change(hex: string, commit: boolean): void;
	/** The eyedropper button: pick a colour from the page. Absent: no eyedropper button (nothing to pick from, e.g. a dialog). */
	eyedropper?(): void;
	close(): void;
}

/** Events that belong to the panel: the pen and the page behind it must not see them. */
const ISOLATED = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown", "click", "keyup"] as const;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * The free colour picker (roadmap 7): a saturation / brightness area, a hue slider, a hex field, the recent custom
 * colours and the eyedropper. A floating panel over the page; every control works with a pen, a finger or a mouse.
 */
export class ColourPicker {
	readonly el: HTMLElement;
	private hsv: Hsv = { h: 0, s: 0, v: 0 };
	private readonly area: HTMLElement;
	private readonly areaThumb: HTMLElement;
	private readonly hueBar: HTMLElement;
	private readonly hueThumb: HTMLElement;
	private readonly hexInput: HTMLInputElement;
	private readonly preview: HTMLElement;
	private readonly recentBox: HTMLElement;

	constructor(parent: HTMLElement, initial: string, recent: readonly string[], private readonly handlers: ColourPickerHandlers) {
		this.el = parent.createDiv({ cls: "notebook-colour-picker", attr: { role: "dialog", "aria-label": t("colour.picker.title") } });
		for (const type of ISOLATED) this.el.addEventListener(type, (e) => e.stopPropagation());
		this.el.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				e.preventDefault();
				handlers.close();
			}
		});

		this.area = this.el.createDiv({ cls: "notebook-colour-area", attr: { role: "slider", tabindex: "0", "aria-label": t("colour.picker.area") } });
		this.areaThumb = this.area.createDiv({ cls: "notebook-colour-thumb" });
		this.drag(this.area, (x, y) => this.setHsv({ ...this.hsv, s: x, v: 1 - y }));
		this.area.addEventListener("keydown", (e) => this.areaKey(e));

		this.hueBar = this.el.createDiv({ cls: "notebook-colour-hue", attr: { role: "slider", tabindex: "0", "aria-label": t("colour.picker.hue"), "aria-valuemin": "0", "aria-valuemax": "360" } });
		this.hueThumb = this.hueBar.createDiv({ cls: "notebook-colour-thumb" });
		this.drag(this.hueBar, (x) => this.setHsv({ ...this.hsv, h: x * 360 }));
		this.hueBar.addEventListener("keydown", (e) => {
			const step = e.shiftKey ? 15 : 3;
			const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
			if (!d) return;
			e.preventDefault();
			this.setHsv({ ...this.hsv, h: Math.min(360, Math.max(0, this.hsv.h + d)) }, true);
		});

		const row = this.el.createDiv({ cls: "notebook-colour-row" });
		this.preview = row.createSpan({ cls: "notebook-colour-preview" });
		this.hexInput = row.createEl("input", {
			cls: "notebook-colour-hex", attr: { type: "text", maxlength: "7", spellcheck: "false", autocapitalize: "off", "aria-label": t("colour.picker.hex") },
		});
		this.hexInput.addEventListener("input", () => {
			const hex = normaliseHex(this.hexInput.value);
			this.hexInput.toggleClass("is-invalid", !hex && this.hexInput.value.trim() !== "");
			if (hex) this.setFromHex(hex, false);
		});
		const commitHex = (): void => {
			const hex = normaliseHex(this.hexInput.value);
			if (hex) this.setFromHex(hex, true);
			else this.syncControls();
		};
		this.hexInput.addEventListener("change", commitHex);
		this.hexInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commitHex();
			}
		});
		const eyedropper = handlers.eyedropper?.bind(handlers);
		if (eyedropper) {
			const dropper = row.createEl("button", { cls: "notebook-colour-button", attr: { type: "button", "aria-label": t("radial.eyedropper"), title: t("radial.eyedropper") } });
			setIcon(dropper, "pipette");
			dropper.addEventListener("click", (e) => {
				e.preventDefault();
				eyedropper();
			});
		}
		const close = row.createEl("button", { cls: "notebook-colour-button", attr: { type: "button", "aria-label": t("colour.picker.close"), title: t("colour.picker.close") } });
		setIcon(close, "x");
		close.addEventListener("click", (e) => {
			e.preventDefault();
			handlers.close();
		});

		this.recentBox = this.el.createDiv({ cls: "notebook-colour-recent", attr: { role: "group", "aria-label": t("colour.picker.recent") } });
		this.setRecent(recent);
		this.setFromHex(initial, false, true);
	}

	/** The colour shown now. */
	get hex(): string {
		return hsvToHex(this.hsv);
	}

	/** The colour was changed from outside (the toolbar, the eyedropper): follow it unless it is what we show. */
	setColour(hex: string): void {
		const n = normaliseHex(hex);
		if (!n || n === this.hex) return;
		this.setFromHex(n, false, true);
		this.hexInput.value = n;
	}

	setRecent(recent: readonly string[]): void {
		this.recentBox.empty();
		if (recent.length === 0) {
			this.recentBox.createSpan({ cls: "notebook-colour-hint", text: t("colour.picker.noRecent") });
			return;
		}
		for (const hex of recent) {
			const b = this.recentBox.createEl("button", { cls: "notebook-colour-recent-swatch", attr: { type: "button", "aria-label": `${t("tool.color")} ${hex}`, title: hex } });
			b.setCssProps({ "--c": hex });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				this.setFromHex(hex, true);
			});
		}
	}

	focus(): void {
		this.hexInput.focus({ preventScroll: true });
	}

	destroy(): void {
		this.el.remove();
	}

	private setFromHex(hex: string, commit: boolean, silent = false): void {
		const hsv = hexToHsv(hex);
		if (!hsv) return;
		// Keep the hue when the colour has none (grey, black): the slider must not jump to red.
		this.hsv = hsv.s === 0 || hsv.v === 0 ? { ...hsv, h: this.hsv.h } : hsv;
		this.syncControls();
		if (!silent) this.handlers.change(this.hex, commit);
	}

	private setHsv(hsv: Hsv, commit = false): void {
		this.hsv = { h: hsv.h, s: clamp01(hsv.s), v: clamp01(hsv.v) };
		this.syncControls();
		this.handlers.change(this.hex, commit);
	}

	private syncControls(): void {
		const { h, s, v } = this.hsv;
		const hex = this.hex;
		this.area.setCssProps({ "--hue": hsvToHex({ h, s: 1, v: 1 }) });
		this.areaThumb.setCssProps({ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, "--c": hex });
		this.hueThumb.setCssProps({ left: `${(h / 360) * 100}%`, "--c": hsvToHex({ h, s: 1, v: 1 }) });
		this.hueBar.setAttribute("aria-valuenow", String(Math.round(h)));
		this.preview.setCssProps({ "--c": hex });
		if (activeDocument.activeElement !== this.hexInput) this.hexInput.value = hex;
		this.hexInput.removeClass("is-invalid");
	}

	private areaKey(e: KeyboardEvent): void {
		const step = e.shiftKey ? 0.1 : 0.02;
		const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
		const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
		if (!dx && !dy) return;
		e.preventDefault();
		this.setHsv({ ...this.hsv, s: this.hsv.s + dx, v: this.hsv.v + dy }, true);
	}

	/** Pointer drag on `target`: `set` gets the position as fractions 0..1 of the element; lifting commits. */
	private drag(target: HTMLElement, set: (x: number, y: number) => void): void {
		let id: number | null = null;
		const at = (e: PointerEvent): void => {
			const r = target.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) return;
			set(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
		};
		target.addEventListener("pointerdown", (e) => {
			if (id !== null) return;
			id = e.pointerId;
			e.preventDefault();
			try {
				target.setPointerCapture(e.pointerId);
			} catch {
				// A synthetic pointer has nothing to capture.
			}
			at(e);
		});
		target.addEventListener("pointermove", (e) => {
			if (e.pointerId === id) at(e);
		});
		const end = (e: PointerEvent): void => {
			if (e.pointerId !== id) return;
			id = null;
			this.handlers.change(this.hex, e.type === "pointerup");
		};
		target.addEventListener("pointerup", end);
		target.addEventListener("pointercancel", end);
	}
}
