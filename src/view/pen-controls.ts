import { Menu, Notice } from "obsidian";
import { t } from "../i18n";
import {
	activeFavourite, captureFavourite, DEFAULT_FAVOURITES, ERASER_SIZES, FAVOURITE_SLOTS, favouritePatch, withFavourite,
	type FavouritePen,
} from "./favourites";
import type { Toolbar, ToolbarState } from "./toolbar";

/** Where favourite pens, the eraser size and the pen-only switch are persisted (the plugin settings). */
export interface PenStore {
	favourites(): FavouritePen[];
	saveFavourites(favs: FavouritePen[]): void;
	/** Fingers do not draw (they still pan and zoom). */
	penOnly(): boolean;
	setPenOnly(on: boolean): void;
	eraserSize(): number;
	saveEraserSize(size: number): void;
}

/** Long press that saves the current pen into a slot, ms. */
export const LONG_PRESS_MS = 450;

/**
 * Toolbar controls for favourite pens and eraser size, the pen-only switch (an action of the registry), plus the circle that shows the eraser
 * under the pen. Passive: it only listens to the stage and never takes part in the writing pipeline.
 */
export class PenControls {
	private readonly abort = new AbortController();
	private readonly slotButtons: HTMLButtonElement[] = [];
	private readonly sizeButtons = new Map<number, HTMLButtonElement>();
	private readonly cursor: HTMLElement;
	private editable = false;
	private pos: { x: number; y: number } | null = null;
	private raf = 0;
	private cursorShown = false;
	private lastLongPress = -Infinity;
	private lastActive = -1;

	constructor(private readonly toolbar: Toolbar, stage: HTMLElement, private readonly store: PenStore) {
		for (let i = 0; i < FAVOURITE_SLOTS; i++) this.slotButtons.push(this.buildSlot(i));

		for (const size of ERASER_SIZES) {
			const b = toolbar.eraserSizeEl.createEl("button", {
				cls: "notebook-tool clickable-icon notebook-eraser-size",
				attr: { type: "button", "aria-label": `${t("eraser.size")} ${size}` },
			});
			b.createSpan({ cls: "notebook-eraser-dot" }).setCssProps({ "--notebook-eraser-dot": `${Math.round(size * 0.6)}px` });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				this.setEraserSize(size);
			});
			this.sizeButtons.set(size, b);
		}

		this.cursor = stage.createDiv({ cls: "notebook-eraser-cursor notebook-hidden" });
		const opts = { signal: this.abort.signal, passive: true } as const;
		stage.addEventListener("pointermove", (e) => this.onPointer(e), opts);
		stage.addEventListener("pointerdown", (e) => this.onPointer(e), opts);
		stage.addEventListener("pointerup", (e) => {
			if (e.pointerType === "touch") this.hideCursor();
		}, opts);
		stage.addEventListener("pointerleave", () => this.hideCursor(), opts);
		stage.addEventListener("pointercancel", () => this.hideCursor(), opts);

		toolbar.onEditableChange = (editable) => {
			this.editable = editable;
			this.refresh();
		};
		this.refresh();
	}

	destroy(): void {
		this.abort.abort();
		if (this.raf) window.cancelAnimationFrame(this.raf);
		this.toolbar.onEditableChange = null;
		this.cursor.remove();
	}

	/** Re-reads the persisted values and redraws every control. Cheap; call after any state or settings change. */
	refresh(): void {
		const s = this.toolbar.state;
		const favourites = this.store.favourites();

		const active = activeFavourite(favourites, s);
		this.slotButtons.forEach((b, i) => {
			const fav = favourites[i];
			if (!fav) return;
			if (i === active && i !== this.lastActive) this.scrollIntoStrip(b);
			b.disabled = !this.editable;
			b.toggleClass("is-active", i === active);
			b.setAttribute("aria-pressed", String(i === active));
			b.setAttribute("aria-label", `${t("pens.slot", { n: String(i + 1) })}: ${t(fav.tool === "pen" ? "tool.pen" : "tool.highlighter")} ${fav.color}, ${fav.width}`);
			const dot = b.querySelector<HTMLElement>(".notebook-fav-dot");
			dot?.setCssProps({ "--notebook-swatch-color": fav.color, "--notebook-fav-w": `${Math.round(Math.min(18, 6 + Math.sqrt(fav.width) * 3))}px` });
			dot?.toggleClass("is-highlighter", fav.tool === "highlighter");
		});

		this.lastActive = active;

		for (const [size, b] of this.sizeButtons) {
			b.toggleClass("is-active", size === s.eraserSize);
			b.setAttribute("aria-pressed", String(size === s.eraserSize));
			b.disabled = !this.editable;
		}

		this.cursor.setCssProps({ "--notebook-eraser-d": `${s.eraserSize * 2}px` });
	}

	/** The toolbar state changed (called by the view). Persists a changed eraser size. */
	onToolsChanged(state: ToolbarState): void {
		if (state.eraserSize !== this.store.eraserSize()) this.store.saveEraserSize(state.eraserSize);
		if (state.tool !== "eraser") this.hideCursor();
		this.refresh();
	}

	/** Selects the pen saved in slot `index` (0-based). */
	applyFavourite(index: number): boolean {
		const fav = this.store.favourites()[index];
		if (!fav || !this.editable) return false;
		this.toolbar.update(favouritePatch(fav) as Partial<ToolbarState>);
		return true;
	}

	/** Stores the pen that is selected now in slot `index`. */
	saveCurrentTo(index: number): void {
		const next = withFavourite(this.store.favourites(), index, captureFavourite(this.toolbar.state));
		this.store.saveFavourites(next);
		this.refresh();
		new Notice(t("pens.saved", { n: String(index + 1) }));
	}

	resetSlot(index: number): void {
		const def = DEFAULT_FAVOURITES[index];
		if (!def) return;
		this.store.saveFavourites(withFavourite(this.store.favourites(), index, def));
		this.refresh();
	}

	setEraserSize(size: number): void {
		if (this.toolbar.state.eraserSize !== size) this.toolbar.update({ eraserSize: size });
	}

	togglePenOnly(): void {
		const next = !this.store.penOnly();
		this.store.setPenOnly(next);
		this.refresh();
		new Notice(t(next ? "pens.penOnly.on" : "pens.penOnly.off"));
	}

	/** Scrolls the favourites strip (it scrolls sideways on a narrow view) so that the pen just chosen is in sight. */
	private scrollIntoStrip(b: HTMLElement): void {
		const strip = this.toolbar.favouritesEl;
		if (strip.clientWidth === 0) return;
		const left = b.offsetLeft - strip.offsetLeft, right = left + b.offsetWidth;
		if (left < strip.scrollLeft) strip.scrollLeft = left;
		else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
	}

	// --- favourite slot buttons ---

	private buildSlot(index: number): HTMLButtonElement {
		const b = this.toolbar.favouritesEl.createEl("button", { cls: "notebook-tool clickable-icon notebook-fav", attr: { type: "button" } });
		b.createSpan({ cls: "notebook-fav-dot" });
		let timer = 0;
		const cancel = (): void => {
			window.clearTimeout(timer);
			timer = 0;
		};
		b.addEventListener("pointerdown", () => {
			cancel();
			timer = window.setTimeout(() => {
				timer = 0;
				this.lastLongPress = performance.now();
				if (!this.editable) return;
				this.saveCurrentTo(index);
				try {
					window.navigator.vibrate?.(15);
				} catch {
					// Vibration is optional.
				}
			}, LONG_PRESS_MS);
		});
		for (const type of ["pointerup", "pointerleave", "pointercancel"] as const) b.addEventListener(type, cancel);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			if (performance.now() - this.lastLongPress < 600) return; // the long press already saved
			this.applyFavourite(index);
		});
		b.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			if (performance.now() - this.lastLongPress < 900 || !this.editable) return;
			const menu = new Menu();
			menu.addItem((i) => i.setTitle(t("pens.saveHere")).setIcon("save").onClick(() => this.saveCurrentTo(index)));
			menu.addItem((i) => i.setTitle(t("pens.reset")).setIcon("rotate-ccw").onClick(() => this.resetSlot(index)));
			menu.showAtMouseEvent(e);
		});
		return b;
	}

	// --- eraser circle ---

	private onPointer(e: PointerEvent): void {
		const erasing = this.toolbar.state.tool === "eraser" || (e.pointerType === "pen" && (e.buttons & 32) !== 0);
		const visible = erasing && this.editable && (e.pointerType !== "touch" || (e.buttons & 1) !== 0);
		if (!visible) {
			this.hideCursor();
			return;
		}
		this.pos = { x: e.clientX, y: e.clientY };
		if (!this.raf) this.raf = window.requestAnimationFrame(() => this.placeCursor());
	}

	private placeCursor(): void {
		this.raf = 0;
		if (!this.pos) return;
		const rect = this.cursor.parentElement?.getBoundingClientRect();
		if (!rect) return;
		this.cursor.setCssProps({ "--notebook-eraser-x": `${this.pos.x - rect.left}px`, "--notebook-eraser-y": `${this.pos.y - rect.top}px` });
		if (!this.cursorShown) {
			this.cursorShown = true;
			this.cursor.removeClass("notebook-hidden");
		}
	}

	private hideCursor(): void {
		this.pos = null;
		if (this.raf) {
			window.cancelAnimationFrame(this.raf);
			this.raf = 0;
		}
		if (this.cursorShown) {
			this.cursorShown = false;
			this.cursor.addClass("notebook-hidden");
		}
	}
}
