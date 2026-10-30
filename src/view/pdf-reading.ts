/**
 * Wave 0.6, reading PDFs: search the PDF text with the hits shown on the pages (#44), a highlighter that snaps to the
 * text lines (#43), show/hide all annotations (#188) and dim the background (#199). The logic is in pure modules
 * (pdf/text-search.ts, pdf/text-snap.ts, pdf/text-index.ts, view/reading-logic.ts); this file is the glue with the
 * view: the toolbar entries, the search panel, the overlay that marks the hits and the reading options of the
 * renderer. Nothing here changes a notebook file: hits, hidden annotations and dimming are view state.
 */
import { t } from "../i18n";
import type { BBox } from "../ink/hit-test";
import type { InputSettings } from "../ink/input-policy";
import { visiblePages, type Layout } from "../ink/layout";
import type { Renderer } from "../ink/renderer";
import type { Size, Viewport } from "../ink/viewport";
import { createStroke } from "../model/document";
import { backgroundRect } from "../model/margins";
import { freezeStroke } from "../model/serialize";
import { RENDER_INK, type NotebookDocument, type Page, type Stroke } from "../model/types";
import { PageTextCache, runSearch, type SearchHit } from "../pdf/text-index";
import { boxesOnPage, type PageTextContent, type TextMeasure } from "../pdf/text-items";
import { hitBoxes, normalizeQuery } from "../pdf/text-search";
import { bandPoints, bandWidth, snapHighlight } from "../pdf/text-snap";
import { SearchPanel } from "./pdf-search-panel";
import { backgroundAlpha, hasPdfPages, insertHits, revealViewport, searchTargets, stepIndex, type Rect } from "./reading-logic";
import { DIM_MAX, DIM_MIN, DIM_STEP, normaliseDim, type ReadingSettings } from "./reading-settings";
import type { Toolbar } from "./toolbar";

/** What the reading tools need from the notebook view. */
export interface ReadingHost {
	/** The page area: the overlay that marks the hits goes here. */
	stage: HTMLElement;
	/** Around the page area and the page panel: the search bar and the "annotations hidden" banner go here. */
	body: HTMLElement;
	toolbar: Toolbar;
	/** The live plugin settings (the reading options are read from and written to this object). */
	settings(): ReadingSettings;
	/** Persists the plugin settings. */
	save(): void;
	doc(): NotebookDocument | null;
	/** Text runs of a PDF page (`PdfStore.pageText`). */
	pageText(asset: string, page: number): Promise<PageTextContent>;
	viewport(): Viewport;
	viewSize(): Size;
	layout(): Layout | null;
	/** The visible part of the document, in document coordinates. */
	visibleRect(): BBox;
	currentPage(): number;
	setViewport(v: Viewport): void;
	renderer(): Renderer | null;
	isNarrow(): boolean;
	/** Annotations are about to be hidden: finish the stroke being written, commit the text being edited, clear the selection. */
	beforeHide(): void;
	/** Whether editing is possible changed (annotations hidden or shown): update the toolbar, history buttons, input. */
	editingChanged(): void;
}

/** Marks of the hits on the pages. */
const HIT_FILL = "rgba(250, 204, 21, 0.5)";
const ACTIVE_FILL = "rgba(251, 146, 60, 0.6)";
const ACTIVE_STROKE = "rgba(234, 88, 12, 0.95)";
/** Results streaming in are shown at most this often, ms. */
const FLUSH_MS = 150;

interface RectCache {
	key: string;
	rects: Rect[];
}

export class PdfReading {
	/** The canvas that marks the hits: in the page area only while there is something to mark (a full-size canvas costs memory on a phone). */
	private overlay: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private readonly panel: SearchPanel;
	private readonly banner: HTMLElement;
	private readonly cache: PageTextCache;
	/** ui redesign: the dimming strength slider, shown in the "PDF & reading" section of the sheet while dimming is on. */
	readonly dimControl: HTMLElement;
	private readonly dimRange: HTMLInputElement;
	private readonly snapButton: HTMLButtonElement;
	private readonly rects = new WeakMap<SearchHit, RectCache>();
	private measureCtx: CanvasRenderingContext2D | null | undefined;
	private measureFont = "";

	private hidden = false;
	private searchOpen = false;
	private hits: SearchHit[] = [];
	private byPage = new Map<string, SearchHit[]>();
	private order = new Map<string, number>();
	private active: SearchHit | null = null;
	private running = false;
	private done = 0;
	private total = 0;
	private truncated = false;
	private unreadable = false;
	private tooShort = true;
	private noPdf = false;
	private signal: { cancelled: boolean } | null = null;
	private flushTimer: number | null = null;
	private drawFrame = 0;
	private destroyed = false;

	constructor(private readonly host: ReadingHost) {
		this.cache = new PageTextCache({ pageText: (asset, page) => host.pageText(asset, page) });

		this.panel = new SearchPanel(host.body, {
			query: (text) => this.startSearch(text),
			step: (delta) => this.step(delta),
			pick: (index) => {
				const hit = this.hits[index];
				if (hit) this.activate(hit, true);
			},
			close: () => this.closeSearch(),
		}, () => host.isNarrow());

		this.banner = host.body.createDiv({ cls: "notebook-reading-banner notebook-hidden", attr: { role: "status" } });
		this.banner.createSpan({ text: t("reading.annotations.banner") });
		const show = this.banner.createEl("button", { cls: "mod-cta", text: t("reading.annotations.show"), attr: { type: "button" } });
		show.addEventListener("click", (e) => {
			e.preventDefault();
			this.setAnnotationsHidden(false);
		});

		// Search, hide annotations and dim are actions of the registry (ui/actions.ts): contextual bar and sheet.
		this.dimControl = createDiv({ cls: "notebook-menu-range" });
		this.dimRange = this.dimControl.createEl("input", {
			attr: { type: "range", min: String(Math.round(DIM_MIN * 100)), max: String(Math.round(DIM_MAX * 100)), step: String(Math.round(DIM_STEP * 100)), "aria-label": t("reading.dim.strength") },
		});
		this.dimRange.addEventListener("input", () => {
			this.host.settings().dimStrength = normaliseDim(Number(this.dimRange.value) / 100);
			this.applyRenderer();
		});
		this.dimRange.addEventListener("change", () => this.host.save());

		this.snapButton = host.toolbar.highlighterOptionsEl.createEl("button", {
			cls: "notebook-tool clickable-icon notebook-text-tool",
			text: t("reading.snap"),
			attr: { type: "button" },
		});
		this.snapButton.addEventListener("click", (e) => {
			e.preventDefault();
			this.host.settings().snapHighlighter = !this.host.settings().snapHighlighter;
			this.host.save();
			this.refreshControls();
			this.prefetchVisible();
		});

		this.refreshControls();
		this.applyRenderer();
	}

	// --- state the view asks about ---

	/** Backgrounds are dimmed (setting). */
	get dimmed(): boolean {
		return this.host.settings().dimBackground;
	}

	/** Annotations on PDF pages are hidden: the view is read-only. */
	get annotationsHidden(): boolean {
		return this.hidden;
	}

	/** Input settings while the view is read-only: a finger pans and zooms instead of drawing. */
	policy(settings: InputSettings): InputSettings {
		return this.hidden ? { ...settings, fingerDrawing: false } : settings;
	}

	// --- annotations ---

	toggleAnnotations(): void {
		this.setAnnotationsHidden(!this.hidden);
	}

	setAnnotationsHidden(hidden: boolean): void {
		if (hidden === this.hidden || this.destroyed) return;
		if (hidden) {
			const doc = this.host.doc();
			if (!doc || !hasPdfPages(doc.pages)) return;
			// Close what is being written while editing is still possible, so nothing is lost.
			this.host.beforeHide();
		}
		this.hidden = hidden;
		this.applyRenderer();
		this.refreshControls();
		this.host.editingChanged();
	}

	// --- dimming ---

	toggleDim(): void {
		const s = this.host.settings();
		s.dimBackground = !s.dimBackground;
		this.host.save();
		this.applyRenderer();
		this.refreshControls();
	}

	// --- search ---

	openSearch(): void {
		const doc = this.host.doc();
		if (!doc || !hasPdfPages(doc.pages)) {
			this.noPdf = true;
			this.searchOpen = true;
			this.panel.open();
			this.flush();
			return;
		}
		this.searchOpen = true;
		this.panel.open();
		// Reopened with the old text: search it again (the hits were dropped when the bar closed).
		if (this.hits.length === 0 && !this.running && this.panel.query.trim()) this.startSearch(this.panel.query);
		else this.flush();
	}

	closeSearch(): void {
		this.cancelRun();
		this.searchOpen = false;
		this.hits = [];
		this.byPage.clear();
		this.active = null;
		this.running = false;
		this.panel.close();
		this.requestDraw();
	}

	/** Moves to the next (1) or previous (-1) result; opens the search when there is none yet. */
	step(delta: 1 | -1): void {
		if (!this.searchOpen) {
			this.openSearch();
			return;
		}
		const next = stepIndex(this.hits.length, this.active ? this.hits.indexOf(this.active) : -1, delta);
		const hit = this.hits[next];
		if (hit) this.activate(hit, true);
	}

	private startSearch(text: string): void {
		this.cancelRun();
		this.hits = [];
		this.byPage = new Map();
		this.active = null;
		this.truncated = false;
		this.unreadable = false;
		this.running = false;
		this.done = 0;
		this.total = 0;
		const doc = this.host.doc();
		const query = normalizeQuery(text);
		this.tooShort = query === "";
		this.noPdf = !doc || !hasPdfPages(doc.pages);
		if (!doc || this.noPdf || !query) {
			this.flush();
			return;
		}
		this.order = new Map(doc.pages.map((p, i) => [p.id, i]));
		const targets = searchTargets(doc.pages, this.host.currentPage());
		const signal = { cancelled: false };
		this.signal = signal;
		this.running = true;
		this.total = targets.length;
		void runSearch({ query, targets, cache: this.cache }, {
			onHits: (found) => {
				if (signal.cancelled) return;
				insertHits(this.hits, found, this.order);
				this.regroup();
				const first = this.hits[0];
				if (!this.active && first) this.activate(first, true);
				this.scheduleFlush();
			},
			onProgress: (done, total) => {
				if (signal.cancelled) return;
				this.done = done;
				this.total = total;
				this.scheduleFlush();
			},
		}, signal).then((result) => {
			if (signal.cancelled) return;
			this.running = false;
			this.truncated = result.truncated;
			this.unreadable = result.unreadable > 0;
			this.flush();
		}, (e) => {
			console.error("[notebook] PDF search", e);
			if (signal.cancelled) return;
			this.running = false;
			this.flush();
		});
		this.flush();
	}

	private cancelRun(): void {
		if (this.signal) this.signal.cancelled = true;
		this.signal = null;
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
	}

	private regroup(): void {
		const by = new Map<string, SearchHit[]>();
		for (const hit of this.hits) {
			const list = by.get(hit.target.pageId);
			if (list) list.push(hit);
			else by.set(hit.target.pageId, [hit]);
		}
		this.byPage = by;
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null || this.destroyed) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, FLUSH_MS);
	}

	/** Shows the state of the search in the panel and on the pages. */
	private flush(): void {
		if (this.destroyed) return;
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.panel.render({
			hits: this.hits,
			active: this.active,
			pageNumber: (hit) => (this.order.get(hit.target.pageId) ?? -1) + 1,
			running: this.running,
			done: this.done,
			total: this.total,
			truncated: this.truncated,
			unreadable: this.unreadable,
			tooShort: this.tooShort,
			noPdf: this.noPdf,
		});
		this.requestDraw();
	}

	/** Makes `hit` the current one and, with `reveal`, scrolls it into view below the search bar. */
	private activate(hit: SearchHit, reveal: boolean): void {
		this.active = hit;
		this.flush();
		if (!reveal) return;
		const doc = this.host.doc();
		const layout = this.host.layout();
		const index = doc ? doc.pages.findIndex((p) => p.id === hit.target.pageId) : -1;
		const page = doc?.pages[index];
		const box = layout?.boxes[index];
		if (!page || !box) return;
		const rects = this.rectsOf(hit, page);
		let rect: Rect = { x: box.x, y: box.y, width: page.width, height: 1 };
		if (rects.length > 0) {
			const x0 = Math.min(...rects.map((r) => r.x));
			const y0 = Math.min(...rects.map((r) => r.y));
			const x1 = Math.max(...rects.map((r) => r.x + r.width));
			const y1 = Math.max(...rects.map((r) => r.y + r.height));
			rect = { x: box.x + x0, y: box.y + y0, width: x1 - x0, height: y1 - y0 };
		}
		this.reveal(rect);
		// At the top of the notebook the view cannot scroll further: if the list still covers the result, fold it away.
		const covered = this.panel.height;
		if (covered > 0 && rect.y * this.host.viewport().scale + this.host.viewport().offsetY < covered && this.panel.listShown) {
			this.panel.collapseList();
			this.reveal(rect);
		}
	}

	private reveal(rect: Rect): void {
		const next = revealViewport(this.host.viewport(), this.host.viewSize(), rect, this.panel.height);
		if (next !== this.host.viewport()) this.host.setViewport(next);
	}

	// --- marks on the pages ---

	/** The boxes of a hit on its notebook page (page coordinates), cached while the page's PDF box is unchanged. */
	private rectsOf(hit: SearchHit, page: Page): Rect[] {
		const { asset, pdfPage } = hit.target;
		const cached = this.cache.peek(asset, pdfPage);
		if (!cached) {
			void this.cache.get(asset, pdfPage).then(() => this.requestDraw());
			return [];
		}
		const r = backgroundRect(page);
		const key = `${r.x}|${r.y}|${r.width}|${r.height}`;
		const have = this.rects.get(hit);
		if (have && have.key === key) return have.rects;
		const onPage = boxesOnPage({ ...cached.content, items: hitBoxes(cached.content, cached.text, hit, this.measure) }, r);
		// A run's box is its font size high; the letters (with ascenders and descenders) sit lower in it.
		const rects = onPage.map((b) => ({ x: b.x, y: b.y + b.height * 0.1, width: b.width, height: b.height * 1.15 }));
		this.rects.set(hit, { key, rects });
		return rects;
	}

	/** The view moved, zoomed or changed: redraw the marks and prepare the text under the highlighter. */
	viewportChanged(): void {
		if (this.searchOpen && this.hits.length > 0) this.requestDraw();
		this.prefetchVisible();
	}

	private dropOverlay(): void {
		this.overlay?.remove();
		this.overlay = null;
		this.ctx = null;
	}

	private requestDraw(): void {
		if (this.drawFrame || this.destroyed) return;
		this.drawFrame = window.requestAnimationFrame(() => {
			this.drawFrame = 0;
			this.draw();
		});
	}

	private draw(): void {
		if (this.destroyed) return;
		const doc = this.host.doc();
		const layout = this.host.layout();
		if (!doc || !layout || !this.searchOpen || this.hits.length === 0) {
			this.dropOverlay();
			return;
		}
		const overlay = this.overlay ?? (this.overlay = this.host.stage.createEl("canvas", { cls: "notebook-reading-overlay", attr: { "aria-hidden": "true" } }));
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
		const v = this.host.viewport();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		for (const i of visiblePages(layout, this.host.visibleRect())) {
			const page = doc.pages[i];
			const box = layout.boxes[i];
			const list = page && this.byPage.get(page.id);
			if (!page || !box || !list) continue;
			for (const hit of list) {
				const current = hit === this.active;
				ctx.fillStyle = current ? ACTIVE_FILL : HIT_FILL;
				for (const r of this.rectsOf(hit, page)) {
					const x = (box.x + r.x) * v.scale + v.offsetX;
					const y = (box.y + r.y) * v.scale + v.offsetY;
					ctx.fillRect(x, y, r.width * v.scale, r.height * v.scale);
					if (current) {
						ctx.strokeStyle = ACTIVE_STROKE;
						ctx.lineWidth = 1.5;
						ctx.strokeRect(x, y, r.width * v.scale, r.height * v.scale);
					}
				}
			}
		}
	}

	// --- snapping highlighter ---

	/** Reads the text of the PDF page a highlighter stroke is starting on, so it is ready at pen-up. */
	prefetch(page: Page): void {
		const bg = page.background;
		if (!this.host.settings().snapHighlighter || bg?.kind !== "pdf" || this.cache.peek(bg.asset, bg.page)) return;
		void this.cache.get(bg.asset, bg.page);
	}

	private prefetchVisible(): void {
		if (!this.host.settings().snapHighlighter || this.host.toolbar.state.tool !== "highlighter") return;
		const doc = this.host.doc();
		const layout = this.host.layout();
		if (!doc || !layout) return;
		for (const i of visiblePages(layout, this.host.visibleRect())) {
			const page = doc.pages[i];
			if (page) this.prefetch(page);
		}
	}

	/**
	 * The strokes that replace a finished highlighter stroke when *Snap to text lines* is on: one straight highlighter
	 * stroke per line of PDF text it crossed, as wide as the line. Null (keep the hand-drawn stroke) when the option is
	 * off, the page has no PDF, its text is not read yet or has none under the stroke.
	 */
	snapStroke(page: Page, stroke: Stroke): Stroke[] | null {
		const bg = page.background;
		if (!this.host.settings().snapHighlighter || stroke.tool !== "highlighter" || bg?.kind !== "pdf") return null;
		const cached = this.cache.peek(bg.asset, bg.page);
		if (!cached || cached.content.items.length === 0) return null;
		const boxes = boxesOnPage(cached.content, backgroundRect(page)).filter((b) => b.str.length > 0);
		const bands = snapHighlight(stroke.points, boxes, this.measure);
		if (bands.length === 0) return null;
		return bands.map((band) => freezeStroke(createStroke(stroke.color, bandWidth(band), bandPoints(band), "highlighter", RENDER_INK)));
	}

	/** Width of a text in a font, from a canvas: how wide the characters of a run are relative to each other. */
	private readonly measure: TextMeasure = (text, font) => {
		if (this.measureCtx === undefined) this.measureCtx = activeDocument.createEl("canvas").getContext("2d");
		const ctx = this.measureCtx;
		if (!ctx) return 0;
		const css = `100px ${font ? `${font}, ` : ""}sans-serif`;
		if (css !== this.measureFont) {
			ctx.font = css;
			this.measureFont = css;
		}
		return ctx.measureText(text).width;
	};

	// --- view plumbing ---

	/** The document or the plugin settings changed (a page was added, removed or got a background; another view saved settings). */
	docChanged(): void {
		this.refreshControls();
		if (this.hidden) {
			const doc = this.host.doc();
			if (!doc || !hasPdfPages(doc.pages)) this.setAnnotationsHidden(false);
		}
	}

	settingsChanged(): void {
		this.applyRenderer();
		this.refreshControls();
	}

	/** A document was loaded (or reloaded): nothing is hidden, nothing is searched. */
	reset(): void {
		this.closeSearch();
		this.cache.clear();
		if (this.hidden) {
			this.hidden = false;
			this.applyRenderer();
			this.host.editingChanged();
		}
		this.refreshControls();
	}

	destroy(): void {
		this.destroyed = true;
		this.cancelRun();
		if (this.drawFrame) window.cancelAnimationFrame(this.drawFrame);
		this.panel.destroy();
		this.banner.remove();
		this.dropOverlay();
		this.dimControl.remove();
		this.host.toolbar.highlighterOptionsEl.empty();
		this.cache.clear();
	}

	private applyRenderer(): void {
		const s = this.host.settings();
		this.host.renderer()?.setReading(this.hidden, backgroundAlpha(s.dimBackground, s.dimStrength));
	}

	/** The slider, the snap toggle and the banner show the current state. */
	private refreshControls(): void {
		const s = this.host.settings();
		this.dimRange.value = String(Math.round(s.dimStrength * 100));

		this.snapButton.toggleClass("is-active", s.snapHighlighter);
		this.snapButton.setAttribute("aria-pressed", String(s.snapHighlighter));
		this.banner.toggleClass("notebook-hidden", !this.hidden);
	}
}
