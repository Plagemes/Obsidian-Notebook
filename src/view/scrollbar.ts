import { t } from "../i18n";
import { MAX_ASPECT } from "../library/thumbnail";
import { offsetForPosition, pageAtOffset, positionAtPointer, scrollMetrics, thumbBox } from "../ink/scrollbar";
import type { Layout } from "../ink/layout";
import type { Size, Viewport } from "../ink/viewport";
import { writing } from "../ink/writing-guard";

export interface ScrollbarHost {
	/** Layout, viewport and view size while continuous scrolling applies and a document is open; null otherwise. */
	state(): { layout: Layout; viewport: Viewport; view: Size } | null;
	/** The setting is on. */
	enabled(): boolean;
	/** The pen is writing (or a selection is being dragged): the thumb does not appear then. */
	busy(): boolean;
	/** Scrolls so that the viewport's `offsetY` is the given one (interactive: cheap redraw). */
	scrollTo(offsetY: number): void;
	/** Height / width of page `index`, for the preview's placeholder. */
	pageRatio(index: number): number;
	/** The thumbnail of page `index` if it is already drawn (the page panel's cache), else null. */
	cachedThumbnail(index: number): string | null;
	/** Draws (and caches) the thumbnail of page `index`; null if the page is gone. */
	drawThumbnail(index: number): string | null;
	/** A drag ended: the reader jumped from page `from` to page `to` (0-based). */
	dragged(from: number, to: number): void;
}

/** The thumb stays visible this long (ms) after the last scroll. */
const SHOW_MS = 1600;
/** The preview of a page is drawn once the thumb has rested on it this long (ms): dragging fast draws nothing. */
const PREVIEW_DELAY_MS = 110;
/** The track is the view height minus this inset at the top and at the bottom (styles.css: top and bottom of .notebook-scrollbar). */
const TRACK_INSET_PX = 8;
/** A mouse this close to the right edge (CSS px) reveals the thumb. */
const EDGE_REVEAL_PX = 28;

/**
 * The fast scrollbar (roadmap 50): a thumb along the right edge of the page in continuous scroll. It shows after a
 * scroll (or when a mouse comes near the edge) and fades; dragging it scrolls through the notebook and a bubble
 * beside the thumb shows the page number and a thumbnail of the page in the middle of the view. The thumbnail comes
 * from the page panel's cache and is only drawn when the thumb rests, never once per move. The geometry is
 * `ink/scrollbar.ts`; nothing here touches the document.
 */
export class FastScrollbar {
	readonly el: HTMLElement;
	private readonly thumb: HTMLElement;
	private readonly bubble: HTMLElement;
	private readonly preview: HTMLImageElement;
	private readonly label: HTMLElement;
	private drag: { pointerId: number; grab: number; from: number; page: number } | null = null;
	private hovering = false;
	private hideTimer: number | null = null;
	private previewTimer: number | null = null;
	private ariaPage = -1;
	private last: { position: number; size: number; length: number; top: number } | null = null;
	private readonly onEdgeMove: (e: PointerEvent) => void;

	constructor(private readonly parent: HTMLElement, private readonly host: ScrollbarHost) {
		this.el = parent.createDiv({ cls: "notebook-scrollbar" });
		this.thumb = this.el.createDiv({
			cls: "notebook-scrollbar-thumb",
			attr: { role: "scrollbar", "aria-orientation": "vertical", "aria-label": t("scrollbar.label") },
		});
		this.bubble = this.el.createDiv({ cls: "notebook-scrollbar-bubble" });
		this.preview = this.bubble.createEl("img", { cls: "notebook-scrollbar-preview", attr: { alt: "", draggable: "false" } });
		this.label = this.bubble.createDiv({ cls: "notebook-scrollbar-label" });

		this.thumb.addEventListener("pointerdown", (e) => this.begin(e));
		this.thumb.addEventListener("pointermove", (e) => this.move(e));
		this.thumb.addEventListener("pointerup", (e) => this.end(e));
		this.thumb.addEventListener("pointercancel", (e) => this.end(e));
		this.thumb.addEventListener("lostpointercapture", (e) => this.end(e));
		this.thumb.addEventListener("pointerenter", (e) => {
			if (e.pointerType === "mouse") this.hovering = true;
		});
		this.thumb.addEventListener("pointerleave", () => {
			this.hovering = false;
			this.scheduleHide();
		});
		// The thumb must not start a tap or a menu on the page below it.
		for (const type of ["touchstart", "click", "dblclick", "contextmenu"] as const) {
			this.thumb.addEventListener(type, (e) => {
				e.stopPropagation();
				if (type === "contextmenu" || type === "touchstart") e.preventDefault();
			}, { passive: false });
		}

		this.onEdgeMove = (e) => {
			if (e.pointerType !== "mouse" || this.drag || !this.host.enabled()) return;
			if (this.parent.getBoundingClientRect().right - e.clientX <= EDGE_REVEAL_PX) this.reveal();
		};
		this.parent.addEventListener("pointermove", this.onEdgeMove);
		this.el.addClass("notebook-hidden");
	}

	destroy(): void {
		this.parent.removeEventListener("pointermove", this.onEdgeMove);
		if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.hideTimer = this.previewTimer = null;
		this.el.remove();
	}

	/** Whether the thumb is being dragged. */
	get dragging(): boolean {
		return this.drag !== null;
	}

	/** The view scrolled, zoomed or changed size (called after every viewport change): moves the thumb, shows it after a scroll. */
	update(): void {
		const s = this.host.enabled() ? this.host.state() : null;
		const m = s ? scrollMetrics(s.layout, s.viewport, s.view) : null;
		if (!s || !m || !m.scrollable) {
			this.last = null;
			this.el.addClass("notebook-hidden");
			this.cancelDrag();
			return;
		}
		this.el.removeClass("notebook-hidden");
		// The track follows the view height: no layout is read on every scroll frame.
		const box = thumbBox(m, Math.max(0, s.view.height - 2 * TRACK_INSET_PX));
		const prev = this.last;
		const moved = !!prev && (Math.abs(prev.position - m.position) > 1e-4 || Math.abs(prev.size - m.size) > 1e-4);
		if (!prev || Math.abs(prev.top - box.top) >= 0.5 || Math.abs(prev.length - box.length) >= 0.5) {
			this.thumb.setCssProps({ "--notebook-sb-top": `${box.top.toFixed(1)}px`, "--notebook-sb-length": `${box.length.toFixed(1)}px` });
		}
		this.last = { position: m.position, size: m.size, length: box.length, top: box.top };
		const index = pageAtOffset(s.layout, s.viewport, s.view, s.viewport.offsetY);
		if (index !== this.ariaPage) {
			this.ariaPage = index;
			this.thumb.setAttribute("aria-valuenow", String(index + 1));
			this.thumb.setAttribute("aria-valuemin", "1");
			this.thumb.setAttribute("aria-valuemax", String(s.layout.boxes.length));
		}
		if (moved && !this.drag && !this.host.busy()) this.reveal();
	}

	private reveal(): void {
		if (this.el.hasClass("notebook-hidden")) return;
		this.el.addClass("is-visible");
		this.scheduleHide();
	}

	private scheduleHide(): void {
		if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
		this.hideTimer = window.setTimeout(() => {
			this.hideTimer = null;
			if (this.drag || this.hovering) return;
			this.el.removeClass("is-visible");
		}, SHOW_MS);
	}

	private begin(e: PointerEvent): void {
		if (this.drag || (e.pointerType === "mouse" && e.button !== 0)) return;
		const s = this.host.state();
		if (!s) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = this.thumb.getBoundingClientRect();
		const page = pageAtOffset(s.layout, s.viewport, s.view, s.viewport.offsetY);
		this.drag = { pointerId: e.pointerId, grab: e.clientY - rect.top, from: page, page };
		try {
			this.thumb.setPointerCapture(e.pointerId);
		} catch {
			// The pointer is already gone: the drag ends with the next event.
		}
		this.el.addClass("is-visible", "is-dragging");
		this.showBubble(page);
	}

	private move(e: PointerEvent): void {
		const d = this.drag;
		if (!d || e.pointerId !== d.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const s = this.host.state();
		if (!s || !this.last) return this.cancelDrag();
		const track = this.el.getBoundingClientRect();
		const position = positionAtPointer(e.clientY - track.top, d.grab, track.height, this.last.length);
		const offset = offsetForPosition(position, s.layout, s.viewport.scale, s.view);
		if (offset === null) return;
		this.host.scrollTo(offset);
		const after = this.host.state();
		const page = after ? pageAtOffset(after.layout, after.viewport, after.view, after.viewport.offsetY) : d.page;
		if (page !== d.page) {
			d.page = page;
			this.showBubble(page);
		} else this.placeBubble();
	}

	private end(e: PointerEvent): void {
		const d = this.drag;
		if (!d || e.pointerId !== d.pointerId) return;
		e.stopPropagation();
		this.drag = null;
		if (this.thumb.hasPointerCapture?.(e.pointerId)) this.thumb.releasePointerCapture(e.pointerId);
		this.finishDrag();
		if (d.page !== d.from) this.host.dragged(d.from, d.page);
	}

	private cancelDrag(): void {
		if (!this.drag) return;
		this.drag = null;
		this.finishDrag();
	}

	private finishDrag(): void {
		this.el.removeClass("is-dragging");
		this.bubble.removeClass("is-shown");
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = null;
		this.scheduleHide();
	}

	/** The bubble for page `index`: its number at once, its thumbnail from the cache or, once the thumb rests, drawn. */
	private showBubble(index: number): void {
		const s = this.host.state();
		const total = s?.layout.boxes.length ?? 0;
		this.label.setText(t("scrollbar.page", { n: String(index + 1), total: String(total) }));
		this.preview.setCssProps({ "--notebook-thumb-ratio": String(Math.min(this.host.pageRatio(index), MAX_ASPECT)) });
		const cached = this.host.cachedThumbnail(index);
		this.setPreview(cached);
		this.bubble.addClass("is-shown");
		this.placeBubble();
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = null;
		if (cached) return;
		this.previewTimer = window.setTimeout(() => {
			this.previewTimer = null;
			// Thumbnails are drawn on the main thread: not while the pen is writing.
			writing.whenQuiet(() => {
				if (!this.drag || this.drag.page !== index) return;
				this.setPreview(this.host.drawThumbnail(index));
			});
		}, PREVIEW_DELAY_MS);
	}

	private setPreview(url: string | null): void {
		if (url) {
			if (this.preview.getAttribute("src") !== url) this.preview.src = url;
			this.preview.removeClass("is-empty");
		} else {
			this.preview.removeAttribute("src");
			this.preview.addClass("is-empty");
		}
	}

	/** The bubble sits beside the thumb, kept inside the track. */
	private placeBubble(): void {
		if (!this.last) return;
		const half = this.bubble.offsetHeight / 2;
		const track = this.el.clientHeight;
		const centre = this.last.top + this.last.length / 2;
		const y = Math.min(Math.max(centre, half), Math.max(half, track - half));
		this.bubble.setCssProps({ "--notebook-sb-bubble": `${y.toFixed(1)}px` });
	}
}
