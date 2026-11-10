/**
 * Select and copy the text of a PDF page (0.16, roadmap #45). A mode of the view, not a tool: while it is on, every contact
 * (pen, finger, mouse) selects text instead of writing, so no ink can be drawn by accident; leaving the mode (Done, Escape,
 * another tool) gives the pen back. Nothing here changes a notebook file.
 *
 * There is no text layer in the DOM. The text of a page is read when it is needed (`PdfStore.pageText`, cached per page by
 * `PageTextCache`) and the selection is geometry: a drag becomes a range of the page text (pdf/text-select.ts), drawn on one
 * canvas over the pages and offered for copying in a small bubble next to it. A tap selects the word, or follows a link.
 */
import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { BBox } from "../ink/hit-test";
import { visiblePages, type Layout } from "../ink/layout";
import type { Size, Viewport } from "../ink/viewport";
import { backgroundRect } from "../model/margins";
import { viewOf, type PdfView } from "../model/pdf-view";
import type { NotebookDocument } from "../model/types";
import { PageTextCache, type CachedPage } from "../pdf/text-index";
import type { PdfPageLinks } from "../pdf/pdf-outline";
import type { PageTextContent, TextMeasure } from "../pdf/text-items";
import {
	caretAt, formatQuote, pageToPdf, pdfRectToPage, rangeBetween, rangeHasText, selectionBoxes, selectionText, unionBox, wordRange,
	type RectLike,
} from "../pdf/text-select";
import type { TextHit } from "../pdf/text-search";
import { writeSystemText } from "./clipboard";
import { showNotice } from "./notice";

/** What the selection needs from the notebook view. */
export interface PdfTextHost {
	/** The page area: the overlay and the bubble go here. */
	stage: HTMLElement;
	/** Around the page area: the mode bar goes here. */
	body: HTMLElement;
	/** The document shown (also while it is read-only). */
	doc(): NotebookDocument | null;
	layout(): Layout | null;
	viewport(): Viewport;
	viewSize(): Size;
	visibleRect(): BBox;
	/** Text runs of a PDF page (`PdfStore.pageText`). */
	pageText(asset: string, page: number): Promise<PageTextContent>;
	/** Link boxes: read in the background, outlined while the mode is on, and followed by a tap (view/pdf-links.ts). */
	links: {
		prefetch(asset: string, page: number): void;
		peek(asset: string, page: number): PdfPageLinks | null;
		tapAt(pageIndex: number, local: readonly [number, number]): Promise<boolean>;
	};
	/** A link back to a notebook page for a quote (Markdown, in the user's link style); empty when there is none. */
	quoteLink(pageIndex: number): string;
	/** Name of a PDF for a quote. */
	pdfName(asset: string): string;
	/** The mode was turned on or off: the view updates its input policy, selection and bars. */
	modeChanged(on: boolean): void;
	/** Phone-sized view. */
	isNarrow(): boolean;
}

/** A contact moves further than this (CSS px) and it is a drag, not a tap. */
const SLOP_PX = 8;
/** A tap this far from any text (in line heights) selects nothing. */
const TAP_REACH = 1.5;
/** Pages whose text is read ahead around the view while the mode is on. */
const AHEAD = 6;
const SELECTION_FILL = "rgba(37, 99, 235, 0.32)";
const LINK_STROKE = "rgba(37, 99, 235, 0.55)";

interface Drag {
	/** -1: the contact began outside a PDF page; it is taken and does nothing. */
	pageIndex: number;
	pageId: string;
	asset: string;
	pdfPage: number;
	start: [number, number];
	focus: [number, number];
	sx: number;
	sy: number;
	moved: boolean;
	/** Offset of the first point in the page text; -1 when it fell on no text. Null until the text is read. */
	anchor: number | null;
	prev: Selected | null;
}

interface Selected {
	pageIndex: number;
	pageId: string;
	asset: string;
	pdfPage: number;
	range: TextHit;
	/** Boxes on the notebook page, cached while the PDF's box on the page is unchanged. */
	rects: { key: string; list: RectLike[] } | null;
}

export class PdfTextTools {
	private on = false;
	private readonly cache: PageTextCache;
	/** Pages whose text could not be read: not asked for again while the view moves (a tap or a drag still tries). */
	private readonly unreadable = new Set<string>();
	private drag: Drag | null = null;
	private sel: Selected | null = null;
	private overlay: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private bar: HTMLElement | null = null;
	private bubble: HTMLElement | null = null;
	private drawFrame = 0;
	private updateFrame = 0;
	private lastNotice = { text: "", at: 0 };
	private destroyed = false;
	private measureCtx: CanvasRenderingContext2D | null | undefined;
	private measureFont = "";

	constructor(private readonly host: PdfTextHost) {
		this.cache = new PageTextCache({ pageText: (asset, page) => host.pageText(asset, page) });
	}

	// --- state the view asks about ---

	/** The mode is on. */
	get active(): boolean {
		return this.on;
	}

	/** A contact is being handled by the mode (the view feeds it the moves and the end). */
	get dragging(): boolean {
		return this.drag !== null;
	}

	/** The page of the drag in progress, or null (no drag, or one that began outside a PDF page). */
	get gesturePage(): number | null {
		return this.drag && this.drag.pageIndex >= 0 ? this.drag.pageIndex : null;
	}

	get hasSelection(): boolean {
		return this.sel !== null;
	}

	// --- the mode ---

	toggle(): void {
		if (this.on) this.exit();
		else this.enter();
	}

	enter(): void {
		if (this.on || this.destroyed) return;
		this.on = true;
		this.buildBar();
		this.host.modeChanged(true);
		this.prefetchVisible();
		this.requestDraw();
	}

	exit(): void {
		if (!this.on) return;
		this.on = false;
		this.drag = null;
		this.clearSelection();
		this.bar?.remove();
		this.bar = null;
		this.requestDraw();
		this.host.modeChanged(false);
	}

	private buildBar(): void {
		const bar = this.host.body.createDiv({ cls: "nb-ui notebook-pdftext-bar", attr: { role: "status", "aria-label": t("pdfText.bar") } });
		setIcon(bar.createSpan({ cls: "notebook-pdftext-bar-icon", attr: { "aria-hidden": "true" } }), "text-cursor-input");
		bar.createSpan({ cls: "notebook-pdftext-bar-text", text: t("pdfText.hint") });
		const done = bar.createEl("button", { cls: "notebook-pdftext-done", text: t("pdfText.done"), attr: { type: "button" } });
		done.addEventListener("click", (e) => {
			e.preventDefault();
			this.exit();
		});
		this.bar = bar;
	}

	// --- input (called by the view's pointer handlers while the mode is on) ---

	/** A contact started. Always taken: nothing is drawn in this mode. */
	begin(pageIndex: number, local: readonly [number, number] | null, sample: { x: number; y: number }): boolean {
		const doc = this.host.doc();
		const page = pageIndex >= 0 ? doc?.pages[pageIndex] : undefined;
		const bg = page?.background;
		const prev = this.sel;
		if (!page || !local || bg?.kind !== "pdf") {
			this.drag = { pageIndex: -1, pageId: "", asset: "", pdfPage: 0, start: [0, 0], focus: [0, 0], sx: sample.x, sy: sample.y, moved: false, anchor: -1, prev };
			if (page && !bg) this.say(t("pdfText.noPdf"));
			return true;
		}
		this.drag = {
			pageIndex, pageId: page.id, asset: bg.asset, pdfPage: bg.page, start: [local[0], local[1]], focus: [local[0], local[1]],
			sx: sample.x, sy: sample.y, moved: false, anchor: null, prev,
		};
		this.ensureText(bg.asset, bg.page);
		return true;
	}

	/** The pen or finger moved (`local`: the point on the drag's page; `last`: its position in the stage). */
	move(local: readonly [number, number] | null, last: { x: number; y: number } | null): void {
		const d = this.drag;
		if (!d || d.pageIndex < 0) return;
		if (local) d.focus = [local[0], local[1]];
		if (!d.moved && last && Math.hypot(last.x - d.sx, last.y - d.sy) > SLOP_PX) d.moved = true;
		if (d.moved) this.requestUpdate();
	}

	/** The contact ended (`cancelled`: it turned into a pinch or was interrupted). True when the mode owned it. */
	end(cancelled: boolean): boolean {
		const d = this.drag;
		if (!d) return false;
		this.drag = null;
		if (this.updateFrame) {
			window.cancelAnimationFrame(this.updateFrame);
			this.updateFrame = 0;
		}
		if (cancelled) {
			this.sel = d.prev;
			this.requestDraw();
			return true;
		}
		if (d.pageIndex < 0) {
			this.clearSelection();
			return true;
		}
		if (!d.moved) {
			this.sel = d.prev;
			void this.tap(d);
			return true;
		}
		this.applyDrag(d);
		this.requestDraw();
		return true;
	}

	/** A tap: follows the link under it, otherwise selects the word, otherwise clears the selection. */
	private async tap(d: Drag): Promise<void> {
		if (await this.host.links.tapAt(d.pageIndex, d.start)) {
			this.clearSelection();
			return;
		}
		const cached = await this.cache.get(d.asset, d.pdfPage);
		if (!this.on || this.destroyed) return;
		if (!cached) {
			this.clearSelection();
			return;
		}
		const page = this.host.doc()?.pages[d.pageIndex];
		if (!page || page.id !== d.pageId) return;
		const p = pageToPdf({ x: d.start[0], y: d.start[1] }, backgroundRect(page), cached.content, viewOf(page.background));
		const caret = caretAt(cached.content, cached.text, p, this.measure, TAP_REACH);
		const word = caret ? wordRange(cached.text.text, caret.offset) : null;
		if (!word) {
			if (cached.content.items.length === 0) this.say(t("pdfText.noText"));
			this.clearSelection();
			return;
		}
		this.sel = { pageIndex: d.pageIndex, pageId: d.pageId, asset: d.asset, pdfPage: d.pdfPage, range: word, rects: null };
		this.requestDraw();
	}

	/** Turns the drag so far into the selection. */
	private applyDrag(d: Drag): void {
		const cached = this.cache.peek(d.asset, d.pdfPage);
		const page = this.host.doc()?.pages[d.pageIndex];
		if (!cached || !page || page.id !== d.pageId) return;
		const rect = backgroundRect(page);
		const view = viewOf(page.background);
		if (d.anchor === null) {
			const c = caretAt(cached.content, cached.text, pageToPdf({ x: d.start[0], y: d.start[1] }, rect, cached.content, view), this.measure);
			d.anchor = c ? c.offset : -1;
		}
		if (d.anchor < 0) return;
		const f = caretAt(cached.content, cached.text, pageToPdf({ x: d.focus[0], y: d.focus[1] }, rect, cached.content, view), this.measure);
		const range = f ? rangeBetween(d.anchor, f.offset) : null;
		this.sel = range && rangeHasText(cached.text, range)
			? { pageIndex: d.pageIndex, pageId: d.pageId, asset: d.asset, pdfPage: d.pdfPage, range, rects: null }
			: null;
	}

	private requestUpdate(): void {
		if (this.updateFrame || this.destroyed) return;
		this.updateFrame = window.requestAnimationFrame(() => {
			this.updateFrame = 0;
			const d = this.drag;
			if (d && d.pageIndex >= 0) this.applyDrag(d);
			this.draw();
		});
	}

	private ensureText(asset: string, page: number, retry = true): void {
		const key = `${asset}|${page}`;
		if (this.cache.peek(asset, page) || (!retry && this.unreadable.has(key))) return;
		void this.cache.get(asset, page).then((got) => {
			if (this.destroyed) return;
			if (got) this.unreadable.delete(key);
			else this.unreadable.add(key);
			if (this.drag && this.drag.pageIndex >= 0) this.requestUpdate();
			else if (!got) this.requestDraw();
		});
	}

	// --- clearing ---

	clearSelection(): void {
		if (!this.sel) return;
		this.sel = null;
		this.requestDraw();
	}

	// --- copying ---

	/** The selected text, or null. */
	copyText(): string | null {
		const s = this.sel;
		const cached = s ? this.cache.peek(s.asset, s.pdfPage) : null;
		if (!s || !cached) return null;
		const text = selectionText(cached.content, cached.text, s.range);
		return text.length > 0 ? text : null;
	}

	/** The selected text as a Markdown quote with its source and a link back to the notebook page, or null. */
	quoteText(): string | null {
		const s = this.sel;
		const text = this.copyText();
		if (!s || text === null) return null;
		return formatQuote(text, { pdf: this.host.pdfName(s.asset), pdfPage: s.pdfPage, link: this.host.quoteLink(s.pageIndex) });
	}

	async copy(quote: boolean): Promise<void> {
		const text = quote ? this.quoteText() : this.copyText();
		if (text === null) return;
		const ok = await writeSystemText(text);
		this.say(ok ? t(quote ? "pdfText.copiedQuote" : "pdfText.copied") : t("pdfText.copyFailed"), 3000, true);
	}

	private say(text: string, ms = 3000, force = false): void {
		const now = Date.now();
		if (!force && this.lastNotice.text === text && now - this.lastNotice.at < 3000) return;
		this.lastNotice = { text, at: now };
		showNotice(text, ms);
	}

	// --- reading ahead ---

	/** The view moved or zoomed: the marks and the bubble follow, and the text of the pages in view is read. */
	viewportChanged(): void {
		if (!this.on && !this.sel) return;
		this.prefetchVisible();
		this.requestDraw();
	}

	private prefetchVisible(): void {
		if (!this.on) return;
		const doc = this.host.doc();
		const layout = this.host.layout();
		if (!doc || !layout) return;
		let n = 0;
		for (const i of visiblePages(layout, this.host.visibleRect())) {
			const bg = doc.pages[i]?.background;
			if (bg?.kind !== "pdf" || n++ >= AHEAD) continue;
			this.ensureText(bg.asset, bg.page, false);
			this.host.links.prefetch(bg.asset, bg.page);
		}
	}

	// --- drawing ---

	private requestDraw(): void {
		if (this.drawFrame || this.destroyed) return;
		this.drawFrame = window.requestAnimationFrame(() => {
			this.drawFrame = 0;
			this.draw();
		});
	}

	private dropOverlay(): void {
		this.overlay?.remove();
		this.overlay = null;
		this.ctx = null;
	}

	private hideBubble(): void {
		this.bubble?.remove();
		this.bubble = null;
	}

	/** The selection's boxes on its notebook page. */
	private rectsOf(s: Selected, cached: CachedPage, rect: RectLike, view?: PdfView): RectLike[] {
		const key = `${rect.x}|${rect.y}|${rect.width}|${rect.height}|${view?.rotate ?? 0}|${view?.crop ? `${view.crop.x},${view.crop.y},${view.crop.width},${view.crop.height}` : ""}`;
		if (s.rects && s.rects.key === key) return s.rects.list;
		const list = selectionBoxes(cached.content, cached.text, s.range, this.measure).map((r) => pdfRectToPage(r, rect, cached.content, view));
		s.rects = { key, list };
		return list;
	}

	private draw(): void {
		if (this.destroyed) return;
		const doc = this.host.doc();
		const layout = this.host.layout();
		const s = this.sel;
		if (!doc || !layout || (!this.on && !s)) {
			this.dropOverlay();
			this.hideBubble();
			return;
		}
		const overlay = this.overlay ?? (this.overlay = this.host.stage.createEl("canvas", { cls: "notebook-reading-overlay notebook-pdftext-overlay", attr: { "aria-hidden": "true" } }));
		const ctx = this.ctx ?? (this.ctx = overlay.getContext("2d"));
		if (!ctx) return;
		const size = this.host.viewSize();
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(1, Math.round(size.width * dpr));
		const h = Math.max(1, Math.round(size.height * dpr));
		if (overlay.width !== w || overlay.height !== h) {
			overlay.width = w;
			overlay.height = h;
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, w, h);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const v = this.host.viewport();
		let shown: RectLike | null = null;
		for (const i of visiblePages(layout, this.host.visibleRect())) {
			const page = doc.pages[i];
			const box = layout.boxes[i];
			const bg = page?.background;
			if (!page || !box || bg?.kind !== "pdf") continue;
			const rect = backgroundRect(page);
			if (this.on) {
				// Links are outlined so that it is clear which parts a tap follows.
				const found = this.host.links.peek(bg.asset, bg.page);
				if (found) {
					ctx.strokeStyle = LINK_STROKE;
					ctx.lineWidth = 1;
					ctx.setLineDash([4, 3]);
					for (const l of found.links) {
						const r = pdfRectToPage(l, rect, found, viewOf(bg));
						ctx.strokeRect((box.x + r.x) * v.scale + v.offsetX, (box.y + r.y) * v.scale + v.offsetY, r.width * v.scale, r.height * v.scale);
					}
					ctx.setLineDash([]);
				}
			}
			if (s && s.pageIndex === i && s.pageId === page.id) {
				const cached = this.cache.peek(s.asset, s.pdfPage);
				if (!cached) continue;
				ctx.fillStyle = SELECTION_FILL;
				const rects = this.rectsOf(s, cached, rect, viewOf(bg));
				const screen = rects.map((r) => ({ x: (box.x + r.x) * v.scale + v.offsetX, y: (box.y + r.y) * v.scale + v.offsetY, width: r.width * v.scale, height: r.height * v.scale }));
				for (const r of screen) ctx.fillRect(r.x, r.y, r.width, r.height);
				shown = unionBox(screen);
			}
		}
		if (!this.on && !s) this.dropOverlay();
		if (shown && !this.drag) this.showBubble(shown, size);
		else this.hideBubble();
	}

	// --- the bubble ---

	private showBubble(at: RectLike, size: Size): void {
		let bubble = this.bubble;
		if (!bubble) {
			bubble = this.host.stage.createDiv({ cls: "nb-ui notebook-pdftext-bubble", attr: { role: "toolbar", "aria-label": t("pdfText.bar") } });
			// The stage listens to pointer events to write: the bubble's own must not reach it.
			for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown"] as const) {
				bubble.addEventListener(type, (e) => e.stopPropagation());
			}
			const button = (icon: string, label: string, onClick: () => void, cls = ""): void => {
				const b = bubble!.createEl("button", { cls: `notebook-pdftext-btn ${cls}`.trim(), attr: { type: "button", "aria-label": label } });
				setIcon(b.createSpan({ cls: "notebook-pdftext-btn-icon", attr: { "aria-hidden": "true" } }), icon);
				if (!cls.includes("is-icon")) b.createSpan({ cls: "notebook-pdftext-btn-label", text: label });
				b.addEventListener("click", (e) => {
					e.preventDefault();
					onClick();
				});
			};
			button("copy", t("pdfText.copy"), () => void this.copy(false));
			button("quote", t("pdfText.copyQuote"), () => void this.copy(true));
			button("x", t("pdfText.clear"), () => this.clearSelection(), "is-icon");
			this.bubble = bubble;
		}
		// Above the selection if there is room, otherwise below it; centred on it and kept inside the view.
		const half = this.host.isNarrow() ? 140 : 170;
		const x = Math.min(Math.max(at.x + at.width / 2, half + 8), Math.max(half + 8, size.width - half - 8));
		const above = at.y - 56;
		const y = above >= 8 ? above : Math.min(size.height - 56, at.y + at.height + 10);
		bubble.setCssProps({ "--nb-pdftext-x": `${Math.round(x)}px`, "--nb-pdftext-y": `${Math.round(Math.max(8, y))}px` });
	}

	// --- plumbing ---

	/** Width of a text in a font, from a canvas: how wide the characters of a run are relative to each other. */
	private readonly measure: TextMeasure = (text, font) => {
		if (this.measureCtx === undefined) this.measureCtx = createEl("canvas").getContext("2d");
		const ctx = this.measureCtx;
		if (!ctx) return 0;
		const css = `100px ${font ? `${font}, ` : ""}sans-serif`;
		if (css !== this.measureFont) {
			ctx.font = css;
			this.measureFont = css;
		}
		return ctx.measureText(text).width;
	};

	/** A document was loaded (or reloaded): the mode ends and the text is read again. */
	reset(): void {
		this.exit();
		this.cache.clear();
		this.unreadable.clear();
	}

	/** The document changed (a page was removed, moved, got another background): a selection on a page that is gone ends. */
	docChanged(): void {
		const s = this.sel;
		if (!s) return;
		const page = this.host.doc()?.pages[s.pageIndex];
		const bg = page?.background;
		if (!page || page.id !== s.pageId || bg?.kind !== "pdf" || bg.asset !== s.asset || bg.page !== s.pdfPage) this.clearSelection();
		else s.rects = null;
	}

	destroy(): void {
		this.destroyed = true;
		this.on = false;
		if (this.drawFrame) window.cancelAnimationFrame(this.drawFrame);
		if (this.updateFrame) window.cancelAnimationFrame(this.updateFrame);
		this.drawFrame = 0;
		this.updateFrame = 0;
		this.bar?.remove();
		this.bar = null;
		this.hideBubble();
		this.dropOverlay();
		this.cache.clear();
	}
}
