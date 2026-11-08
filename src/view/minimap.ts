import { setIcon } from "obsidian";
import { t } from "../i18n";
import { MAP_BL_VAR, mapOffset, publish, watchBox } from "../ui/dock-metrics";
import type { Size, Viewport } from "../ink/viewport";
import { PAGE_MARGIN } from "../ink/viewport";
import type { PageBox } from "../ink/layout";
import {
	DEFAULT_MINIMAP_PREFS, fitScaleFor, mapSize, nearestCorner, normaliseMinimapPrefs, refreshDelay, shouldShowMinimap,
	viewportCentredOn, viewRectOnMap, wholePageVisible, type MapSize, type MinimapCorner, type MinimapMode, type MinimapPrefs,
} from "../model/minimap-geometry";

/** What the minimap reads from the page in view. */
export interface MinimapState {
	pageId: string;
	/** Page size in pt and whether it is an infinite page. */
	page: { width: number; height: number; infinite: boolean };
	box: PageBox;
	viewport: Viewport;
	view: Size;
}

export interface MinimapHost {
	/** The page in view, or null (no document, or nothing laid out yet). */
	state(): MinimapState | null;
	mode(): MinimapMode;
	/** The pen is writing (or a drag is going on): the picture of the map is not drawn then. */
	busy(): boolean;
	/** Moves the view to this viewport (the view clamps it). */
	panTo(v: Viewport): void;
	/** The whole page as a picture `width` px wide (data URL; empty when it cannot be drawn). */
	render(pageId: string, width: number): string;
	loadPrefs(): unknown;
	savePrefs(prefs: MinimapPrefs): void;
}

/** The map area is never narrower than this (CSS px), so a tall thin page is still easy to hit. */
const MIN_STAGE_W = 56;
const KEY_STEP = 0.1;

/**
 * The minimap (roadmap #173): a small floating overview of the page in view with the rectangle the view shows. Tap or
 * drag on it to pan, collapse it to a small button, drag its handle to another corner. It shows on infinite pages and at
 * high zoom (setting: automatic / always / never). The picture is the page rendered once through the library's thumbnail
 * renderer, cached, and redrawn at most once per `MAP_REFRESH_MS` after the page changed and never while the pen writes.
 * The geometry is `model/minimap-geometry.ts`; nothing here touches the document, the ink pipeline or the renderer.
 */
export class Minimap {
	readonly el: HTMLElement;
	private readonly map: HTMLElement;
	private readonly pageBox: HTMLElement;
	private readonly img: HTMLImageElement;
	private readonly rect: HTMLElement;
	private readonly collapseBtn: HTMLButtonElement;
	private readonly grip: HTMLButtonElement;
	private readonly pill: HTMLButtonElement;
	private prefs: MinimapPrefs;
	private shown = false;
	private pic: { key: string; at: number } | null = null;
	private dirty = true;
	private timer: number | null = null;
	private panDrag: { pointerId: number } | null = null;
	private moveDrag: { pointerId: number; startX: number; startY: number } | null = null;
	private last: { x: number; y: number; w: number; h: number } | null = null;
	private lastMap: MapSize | null = null;
	private lastPageId = "";
	private stopWatch: (() => void) | null = null;

	constructor(parent: HTMLElement, private readonly host: MinimapHost) {
		this.prefs = normaliseMinimapPrefs(safe(() => host.loadPrefs()));
		this.el = parent.createDiv({ cls: "nb-ui nb-minimap notebook-hidden", attr: { role: "group", "aria-label": t("minimap.label") } });

		const bar = this.el.createDiv({ cls: "nb-minimap-bar" });
		this.grip = bar.createEl("button", { cls: "nb-minimap-btn nb-minimap-grip", attr: { type: "button", "aria-label": t("minimap.move"), title: t("minimap.move") } });
		setIcon(this.grip.createSpan({ attr: { "aria-hidden": "true" } }), "move");
		bar.createSpan({ cls: "nb-minimap-title", text: t("minimap.label") });
		this.collapseBtn = bar.createEl("button", { cls: "nb-minimap-btn nb-minimap-collapse", attr: { type: "button", "aria-label": t("minimap.collapse"), title: t("minimap.collapse") } });
		setIcon(this.collapseBtn.createSpan({ attr: { "aria-hidden": "true" } }), "minimize-2");

		this.map = this.el.createDiv({ cls: "nb-minimap-map", attr: { tabindex: "0", role: "application", "aria-label": t("minimap.map") } });
		this.pageBox = this.map.createDiv({ cls: "nb-minimap-page" });
		this.img = this.pageBox.createEl("img", { cls: "nb-minimap-img", attr: { alt: "", draggable: "false" } });
		this.rect = this.pageBox.createDiv({ cls: "nb-minimap-rect", attr: { "aria-hidden": "true" } });

		this.pill = this.el.createEl("button", { cls: "nb-minimap-pill", attr: { type: "button", "aria-label": t("minimap.expand"), title: t("minimap.expand") } });
		setIcon(this.pill.createSpan({ attr: { "aria-hidden": "true" } }), "map");

		this.applyPrefs();
		// The colour-filter pill and the lecture-header chip start to the right of a map parked at the bottom left (dock-metrics.ts).
		this.stopWatch = watchBox(this.el, () => this.publishDock());

		this.collapseBtn.addEventListener("click", () => this.setCollapsed(true));
		this.pill.addEventListener("click", () => this.setCollapsed(false));
		this.map.addEventListener("pointerdown", (e) => this.panBegin(e));
		this.map.addEventListener("pointermove", (e) => this.panMove(e));
		this.map.addEventListener("pointerup", (e) => this.panEnd(e));
		this.map.addEventListener("pointercancel", (e) => this.panEnd(e));
		this.map.addEventListener("lostpointercapture", (e) => this.panEnd(e));
		this.map.addEventListener("keydown", (e) => this.key(e));
		this.grip.addEventListener("pointerdown", (e) => this.moveBegin(e));
		this.grip.addEventListener("pointermove", (e) => this.moveMove(e));
		this.grip.addEventListener("pointerup", (e) => this.moveEnd(e, true));
		this.grip.addEventListener("pointercancel", (e) => this.moveEnd(e, false));
		this.grip.addEventListener("lostpointercapture", (e) => this.moveEnd(e, false));
		// Nothing here may start a tap, a menu or a gesture on the page below.
		for (const type of ["touchstart", "click", "dblclick", "contextmenu", "wheel"] as const) {
			this.el.addEventListener(type, (e) => {
				e.stopPropagation();
				if (type === "contextmenu" || type === "touchstart") e.preventDefault();
			}, { passive: false });
		}
	}

	destroy(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.stopWatch?.();
		publish(this.el.parentElement, MAP_BL_VAR, 0);
		this.el.remove();
	}

	/** Whether the map is on screen. */
	get visible(): boolean {
		return this.shown;
	}

	/** The page changed (ink, paper, size): the picture is redrawn soon, throttled. */
	invalidate(): void {
		this.dirty = true;
		if (this.shown && !this.prefs.collapsed) this.schedule();
	}

	/** The view moved, zoomed or changed size, or a setting changed (called after every viewport change). */
	update(): void {
		const s = this.host.state();
		if (!s) return this.hide();
		const whole = wholePageVisible(s.viewport, s.view, s.box);
		const show = shouldShowMinimap({
			mode: this.host.mode(),
			infinite: s.page.infinite,
			scale: s.viewport.scale,
			fitScale: fitScaleFor(s.view.width, s.page.width, PAGE_MARGIN),
			whole,
		});
		if (!show) return this.hide();
		if (!this.shown) {
			this.shown = true;
			this.el.removeClass("notebook-hidden");
		}
		if (this.prefs.collapsed) return;
		const map = mapSize(s.page);
		const mapChanged = !this.lastMap || this.lastMap.width !== map.width || this.lastMap.height !== map.height;
		if (mapChanged || this.lastPageId !== s.pageId) {
			this.lastMap = map;
			this.pageBox.setCssProps({ "--nb-mm-w": `${map.width}px`, "--nb-mm-h": `${map.height}px` });
			this.map.setCssProps({ "--nb-mm-stage-w": `${Math.max(map.width, MIN_STAGE_W)}px` });
		}
		if (this.lastPageId !== s.pageId) {
			this.lastPageId = s.pageId;
			this.dirty = true;
		}
		const r = viewRectOnMap(s.viewport, s.view, s.box, map);
		const prev = this.last;
		if (!prev || Math.abs(prev.x - r.x) >= 0.4 || Math.abs(prev.y - r.y) >= 0.4 || Math.abs(prev.w - r.width) >= 0.4 || Math.abs(prev.h - r.height) >= 0.4) {
			this.last = { x: r.x, y: r.y, w: r.width, h: r.height };
			this.rect.setCssProps({ "--nb-mm-rx": `${r.x.toFixed(1)}px`, "--nb-mm-ry": `${r.y.toFixed(1)}px`, "--nb-mm-rw": `${r.width.toFixed(1)}px`, "--nb-mm-rh": `${r.height.toFixed(1)}px` });
			this.rect.toggleClass("is-empty", r.width < 1 || r.height < 1);
		}
		if (this.dirty || !this.pic) this.schedule();
	}

	private hide(): void {
		if (!this.shown) return;
		this.shown = false;
		this.el.addClass("notebook-hidden");
		this.cancelDrags();
	}

	private cancelDrags(): void {
		this.panDrag = null;
		this.moveDrag = null;
		this.el.removeClass("is-moving");
		this.el.setCssProps({ "--nb-mm-dx": "0px", "--nb-mm-dy": "0px" });
	}

	// --- picture ---

	private schedule(): void {
		if (this.timer !== null || this.prefs.collapsed) return;
		const wait = Math.max(this.pic ? refreshDelay(this.pic.at, Date.now()) : 0, 30);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			if (!this.shown || this.prefs.collapsed) return;
			if (this.host.busy() || this.panDrag) return void this.schedule();
			this.draw();
		}, wait);
	}

	private draw(): void {
		const s = this.host.state();
		if (!s) return;
		const map = mapSize(s.page);
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const key = `${s.pageId}:${map.width}x${map.height}:${dpr}`;
		if (!this.dirty && this.pic?.key === key) return;
		const url = this.host.render(s.pageId, Math.max(1, Math.round(map.width * dpr)));
		this.dirty = false;
		this.pic = { key, at: Date.now() };
		if (url) this.img.src = url;
	}

	// --- pan ---

	private point(e: PointerEvent): { x: number; y: number } {
		const b = this.pageBox.getBoundingClientRect();
		return { x: e.clientX - b.left, y: e.clientY - b.top };
	}

	private panTo(mx: number, my: number): void {
		const s = this.host.state();
		if (!s) return;
		this.host.panTo(viewportCentredOn(s.viewport, s.view, s.box, mapSize(s.page), mx, my));
	}

	private panBegin(e: PointerEvent): void {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		this.panDrag = { pointerId: e.pointerId };
		safe(() => this.map.setPointerCapture(e.pointerId));
		this.el.addClass("is-panning");
		const p = this.point(e);
		this.panTo(p.x, p.y);
		e.preventDefault();
	}

	private panMove(e: PointerEvent): void {
		if (!this.panDrag || this.panDrag.pointerId !== e.pointerId) return;
		const p = this.point(e);
		this.panTo(p.x, p.y);
	}

	private panEnd(e: PointerEvent): void {
		if (!this.panDrag || this.panDrag.pointerId !== e.pointerId) return;
		this.panDrag = null;
		this.el.removeClass("is-panning");
		safe(() => this.map.releasePointerCapture(e.pointerId));
		if (this.dirty) this.schedule();
	}

	private key(e: KeyboardEvent): void {
		const s = this.host.state();
		if (!s) return;
		const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
		const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
		if (!dx && !dy) return;
		e.preventDefault();
		const v = s.viewport;
		this.host.panTo({ scale: v.scale, offsetX: v.offsetX - dx * s.view.width * KEY_STEP, offsetY: v.offsetY - dy * s.view.height * KEY_STEP });
	}

	// --- collapse, corner ---

	private setCollapsed(collapsed: boolean): void {
		if (this.prefs.collapsed === collapsed) return;
		this.prefs = { ...this.prefs, collapsed };
		this.applyPrefs();
		this.persist();
		this.last = null;
		this.lastPageId = "";
		if (!collapsed) this.update();
		(collapsed ? this.pill : this.collapseBtn).focus({ preventScroll: true });
	}

	private applyPrefs(): void {
		this.el.dataset.corner = this.prefs.corner;
		this.el.toggleClass("is-collapsed", this.prefs.collapsed);
		this.publishDock();
	}

	private publishDock(): void {
		publish(this.el.parentElement, MAP_BL_VAR, mapOffset(this.prefs.corner, !this.el.hasClass("notebook-hidden"), this.el.offsetWidth));
	}

	private persist(): void {
		safe(() => this.host.savePrefs(this.prefs));
	}

	private moveBegin(e: PointerEvent): void {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		this.moveDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
		safe(() => this.grip.setPointerCapture(e.pointerId));
		this.el.addClass("is-moving");
		e.preventDefault();
	}

	private moveMove(e: PointerEvent): void {
		const d = this.moveDrag;
		if (!d || d.pointerId !== e.pointerId) return;
		this.el.setCssProps({ "--nb-mm-dx": `${e.clientX - d.startX}px`, "--nb-mm-dy": `${e.clientY - d.startY}px` });
	}

	private moveEnd(e: PointerEvent, commit: boolean): void {
		const d = this.moveDrag;
		if (!d || d.pointerId !== e.pointerId) return;
		this.moveDrag = null;
		safe(() => this.grip.releasePointerCapture(e.pointerId));
		const parent = this.el.parentElement;
		if (commit && parent) {
			const p = parent.getBoundingClientRect();
			const corner: MinimapCorner = nearestCorner(e.clientX - p.left, e.clientY - p.top, { width: p.width, height: p.height });
			if (corner !== this.prefs.corner) {
				this.prefs = { ...this.prefs, corner };
				this.applyPrefs();
				this.persist();
			}
		}
		this.el.removeClass("is-moving");
		this.el.setCssProps({ "--nb-mm-dx": "0px", "--nb-mm-dy": "0px" });
	}

	/** The stored preferences (for the harness and tests). */
	get preferences(): MinimapPrefs {
		return { ...DEFAULT_MINIMAP_PREFS, ...this.prefs };
	}
}

function safe<T>(fn: () => T): T | null {
	try {
		return fn();
	} catch {
		return null;
	}
}
