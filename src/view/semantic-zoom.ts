import type { Layout } from "../ink/layout";
import { drawPageRaster } from "../ink/page-raster";
import {
	bandOf, hitLabel, jumpViewport, semanticAlpha, SemanticLayoutCache, SEMANTIC_MIN_ALPHA, SEMANTIC_TAP_ALPHA, visibleLabels,
	type ScreenLabel, type SemanticLayout, type SemanticSource,
} from "../ink/semantic-zoom";
import { fitWidth, type Size, type Viewport } from "../ink/viewport";
import type { OutlineItem } from "../model/outline-builder";
import { buildSemanticSources } from "../model/semantic-sources";
import type { Asset, Page, Stroke } from "../model/types";

export interface SemanticZoomHost {
	/** The element the layer lives in (the stage: the labels are positioned over the pages). */
	stage(): HTMLElement;
	/** The setting is on, the pages are scrolled continuously and no presentation is going on. */
	enabled(): boolean;
	pages(): readonly Page[];
	assets(): Readonly<Record<string, Asset>> | undefined;
	layout(): Layout | null;
	viewport(): Viewport;
	view(): Size;
	/** The pen is writing, or a drag is going on: the sources are not worked out then. */
	busy(): boolean;
	/** The generated outline with the sources of the overview (headings only when the outline lists them). */
	outline(): OutlineItem[];
	/** Analyses stale pages for at most `budgetMs`; returns how many are still stale. */
	warm(budgetMs: number): number;
	/** Whether a finger tap navigates (it would not draw) with this pointer event. */
	fingerNavigates(e: PointerEvent): boolean;
	/** Moves the view (the view clamps it) after a tap on a label; `pageIndex` is where it lands. */
	jump(v: Viewport, pageIndex: number): void;
}

/** Labels on the screen at once. */
const MAX_NODES = 40;
/** Pictures of headings drawn in one frame (each is a small canvas; the rest wait for the next frame). */
const PICTURES_PER_FRAME = 2;
const MAX_PICTURES = 72;
/** A contact that moves farther than this (CSS px) or stays longer (ms) is not a tap; a label is hit within `HIT_SLOP`. */
const TAP_SLOP = 10;
const TAP_MS = 450;
const HIT_SLOP = 6;
/** Slice of heading analysis per frame while the pages are still being read, and the wait before the next one, ms. */
const WARM_MS = 6;
const RETRY_MS = 140;
/** The overlay stays hidden this long after the pen lifts, ms. */
const WRITING_HOLD_MS = 500;

interface Node {
	el: HTMLElement;
	/** What the element shows now: the label's key and the version of the sources it came from. */
	bound: string;
	on: boolean;
	x: string;
	y: string;
	w: string;
	h: string;
	font: string;
}

interface Picture {
	url: string;
	strokes: readonly Stroke[];
	rect: string;
	height: number;
	checked: number;
}

/**
 * The semantic zoom overlay (roadmap #130): over the stage, the labels of the headings and objects of the pages, large enough
 * to read when the notebook is zoomed far out (see `ink/semantic-zoom.ts`). A view overlay only: the document, the static canvas
 * and the stroke pipeline are not touched, exports and the presentation do not draw it. The DOM is a small pool of elements
 * moved by CSS variables; the layout is cached per zoom band; a frame runs only when the viewport, the document or a setting
 * changed (`requestAnimationFrame`), and nothing runs while the overlay is invisible except a comparison of two numbers.
 */
export class SemanticZoomLayer {
	readonly el: HTMLElement;
	private readonly nodes: Node[] = [];
	private readonly pool: ScreenLabel[] = [];
	private readonly cache = new SemanticLayoutCache();
	private readonly pictures = new Map<string, Picture>();
	private sources: SemanticSource[] | null = null;
	private version = 0;
	private shown = false;
	private alpha = 0;
	private count = 0;
	private current: SemanticLayout | null = null;
	private frame: number | null = null;
	private retryTimer: number | null = null;
	private writingTimer: number | null = null;
	private tap: { id: number; x: number; y: number; t: number; source: SemanticSource; mouse: boolean } | null = null;
	private hover = -1;
	private readonly off: Array<() => void> = [];
	/** Frames drawn (for the benchmark and the harness). */
	frames = 0;

	constructor(private readonly host: SemanticZoomHost) {
		this.el = host.stage().createDiv({ cls: "nb-ui nb-sz-layer is-off", attr: { "aria-hidden": "true" } });
		const stage = host.stage();
		this.listen(stage, "pointerdown", (e) => this.onDown(e as PointerEvent), true);
		this.listen(stage, "pointerup", (e) => this.onUp(e as PointerEvent), true);
		this.listen(stage, "pointercancel", () => this.cancel(), true);
		this.listen(stage, "pointermove", (e) => this.onMove(e as PointerEvent));
		this.listen(stage, "pointerleave", () => this.setHover(-1));
	}

	destroy(): void {
		for (const o of this.off) o();
		this.off.length = 0;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		if (this.writingTimer !== null) window.clearTimeout(this.writingTimer);
		this.frame = this.retryTimer = this.writingTimer = null;
		this.pictures.clear();
		this.el.remove();
	}

	/** The overlay is on screen. */
	get visible(): boolean {
		return this.shown;
	}

	/** Opacity of the overlay now (0 to 1). */
	get opacity(): number {
		return this.shown ? this.alpha : 0;
	}

	/** Labels on screen now (for the harness). */
	get labelCount(): number {
		return this.shown ? this.count : 0;
	}

	/** The view moved, zoomed or changed size (called after every viewport change): cheap when the overlay is, and stays, off. */
	viewChanged(): void {
		if (!this.shown && !this.maybeOn()) return;
		this.schedule();
	}

	/** The document, the layout or a setting changed: the sources are worked out again the next time they are needed. */
	invalidate(): void {
		this.sources = null;
		this.version++;
		this.cache.clear();
		if (this.shown || this.maybeOn()) this.schedule();
	}

	/** Whether the zoom is in the range where the overlay shows (two comparisons, no allocation). */
	private maybeOn(): boolean {
		const h = this.host;
		if (!h.enabled()) return false;
		const layout = h.layout();
		const view = h.view();
		if (!layout || view.width <= 0 || layout.boxes.length === 0) return false;
		return semanticAlpha(h.viewport().scale, fitWidth(view, layout).scale) >= SEMANTIC_MIN_ALPHA;
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			try {
				this.run();
			} catch (e) {
				console.error("[notebook] semantic zoom", e);
				this.hide();
			}
		});
	}

	private retry(): void {
		if (this.retryTimer !== null) return;
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			this.schedule();
		}, RETRY_MS);
	}

	private hide(): void {
		this.count = 0;
		this.setHover(-1);
		if (!this.shown) return;
		this.shown = false;
		this.el.addClass("is-off");
		for (const n of this.nodes) {
			if (n.on) {
				n.on = false;
				n.el.addClass("is-off");
			}
		}
	}

	// --- the frame ---

	private run(): void {
		const h = this.host;
		const layout = h.layout();
		const view = h.view();
		if (!h.enabled() || !layout || view.width <= 0 || layout.boxes.length === 0) return this.hide();
		const vp = h.viewport();
		const alpha = semanticAlpha(vp.scale, fitWidth(view, layout).scale);
		if (alpha < SEMANTIC_MIN_ALPHA) return this.hide();
		const sources = this.ensureSources();
		if (!sources) return;
		this.frames++;
		const band = this.cache.get({ sources, layout, view, band: bandOf(vp.scale) });
		this.current = band;
		const n = visibleLabels(band, vp, view, this.pool, MAX_NODES);
		this.count = n;
		if (!this.shown) {
			this.shown = true;
			this.el.removeClass("is-off");
		}
		if (alpha !== this.alpha) {
			this.alpha = alpha;
			this.el.style.setProperty("--nb-sz-alpha", alpha.toFixed(3));
		}
		let pending = false;
		let budget = PICTURES_PER_FRAME;
		for (let i = 0; i < n; i++) {
			const slot = this.pool[i]!;
			const node = this.nodes[i] ?? this.makeNode();
			const label = slot.label!;
			const bound = `${label.source.key}#${this.version}`;
			if (node.bound !== bound) {
				node.bound = "";
				if (label.source.aspect !== undefined) {
					if (budget <= 0) {
						pending = true;
					} else {
						const drew = this.bindPicture(node, label.source, label.height * band.scale);
						budget--;
						if (drew) node.bound = bound;
						else pending = true;
					}
				} else {
					this.bindText(node, label.source);
					node.bound = bound;
				}
			}
			if (node.bound === "") {
				// Its picture is not ready: nothing (and not the previous label) is shown there for now.
				if (node.on) {
					node.on = false;
					node.el.addClass("is-off");
				}
				continue;
			}
			this.place(node, slot);
		}
		for (let i = n; i < this.nodes.length; i++) {
			const node = this.nodes[i]!;
			if (node.on) {
				node.on = false;
				node.el.addClass("is-off");
			}
		}
		if (pending) this.schedule();
	}

	/** The label sources, worked out when they are stale. Null while the headings of the pages are still being read. */
	private ensureSources(): SemanticSource[] | null {
		if (this.sources) return this.sources;
		const h = this.host;
		if (h.busy() || h.warm(WARM_MS) > 0) {
			this.retry();
			return null;
		}
		this.sources = buildSemanticSources({ pages: h.pages(), outline: h.outline(), assets: h.assets() });
		return this.sources;
	}

	private makeNode(): Node {
		const el = this.el.createDiv({ cls: "nb-sz-label is-off" });
		const node: Node = { el, bound: "", on: false, x: "", y: "", w: "", h: "", font: "" };
		this.nodes.push(node);
		return node;
	}

	private place(node: Node, slot: ScreenLabel): void {
		const x = `${slot.x.toFixed(1)}px`;
		const y = `${slot.y.toFixed(1)}px`;
		const w = `${slot.width.toFixed(1)}px`;
		const hh = `${slot.height.toFixed(1)}px`;
		const f = `${slot.font.toFixed(1)}px`;
		const el = node.el;
		if (node.x !== x) { node.x = x; el.style.setProperty("--nb-sz-x", x); }
		if (node.y !== y) { node.y = y; el.style.setProperty("--nb-sz-y", y); }
		if (node.w !== w) { node.w = w; el.style.setProperty("--nb-sz-w", w); }
		if (node.h !== hh) { node.h = hh; el.style.setProperty("--nb-sz-h", hh); }
		if (node.font !== f) { node.font = f; el.style.setProperty("--nb-sz-font", f); }
		if (!node.on) {
			node.on = true;
			el.removeClass("is-off");
		}
	}

	private bindText(node: Node, src: SemanticSource): void {
		const el = node.el;
		el.empty();
		el.className = `nb-sz-label is-text is-l${src.level} is-${src.kind}`;
		el.createSpan({ cls: "nb-sz-text", text: src.text ?? "" });
	}

	private bindPicture(node: Node, src: SemanticSource, heightPx: number): boolean {
		const url = this.pictureOf(src, heightPx);
		if (!url) return false;
		const el = node.el;
		el.empty();
		el.className = `nb-sz-label is-picture is-l${src.level} is-${src.kind}`;
		el.createEl("img", { cls: "nb-sz-picture", attr: { src: url, alt: "", draggable: "false" } });
		return true;
	}

	/** The picture of a heading's ink (on its own, on a white sheet), cached by the identity of its strokes. Null when it cannot be drawn. */
	private pictureOf(src: SemanticSource, heightPx: number): string | null {
		const page = this.host.pages()[src.pageIndex];
		if (!page || !src.ink) return null;
		const rect = `${src.x},${src.y},${src.width},${src.height}`;
		const height = Math.round(heightPx / 8) * 8;
		const have = this.pictures.get(src.key);
		if (have && have.rect === rect && have.height === height) {
			if (have.checked === this.version) return this.touch(src.key, have);
			const strokes = strokesOf(page, src.ink);
			if (sameStrokes(have.strokes, strokes)) {
				have.checked = this.version;
				return this.touch(src.key, have);
			}
		}
		const strokes = strokesOf(page, src.ink);
		if (strokes.length === 0) return null;
		const url = drawHeading(page, strokes, src, height, Math.min(2, window.devicePixelRatio || 1));
		if (!url) return null;
		this.pictures.delete(src.key);
		this.pictures.set(src.key, { url, strokes, rect, height, checked: this.version });
		while (this.pictures.size > MAX_PICTURES) {
			const oldest = this.pictures.keys().next().value;
			if (oldest === undefined) break;
			this.pictures.delete(oldest);
		}
		return url;
	}

	private touch(key: string, p: Picture): string {
		this.pictures.delete(key);
		this.pictures.set(key, p);
		return p.url;
	}

	// --- taps ---

	private listen(el: HTMLElement, type: string, fn: (e: Event) => void, capture = false): void {
		el.addEventListener(type, fn, capture);
		this.off.push(() => el.removeEventListener(type, fn, capture));
	}

	private hitAt(clientX: number, clientY: number, slop = HIT_SLOP): number {
		if (!this.shown || this.alpha < SEMANTIC_TAP_ALPHA || this.count === 0) return -1;
		const r = this.host.stage().getBoundingClientRect();
		return hitLabel(this.pool, this.count, clientX - r.left, clientY - r.top, slop);
	}

	private onDown(e: PointerEvent): void {
		if (e.pointerType === "pen") return this.writing();
		if (this.tap && this.tap.id !== e.pointerId) this.tap = null; // a second contact: a pinch, not a tap
		if (!this.shown) return;
		const mouse = e.pointerType === "mouse";
		if (mouse ? e.button !== 0 : e.pointerType !== "touch" || !e.isPrimary || !this.host.fingerNavigates(e)) return;
		const i = this.hitAt(e.clientX, e.clientY);
		const source = i >= 0 ? this.pool[i]?.label?.source : undefined;
		if (!source) return;
		this.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, source, mouse };
		// A click with the mouse must not also leave a dot of ink; a finger keeps its pan and pinch.
		if (mouse) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	}

	private onUp(e: PointerEvent): void {
		if (e.pointerType === "pen") {
			this.writing();
			return;
		}
		const tap = this.tap;
		if (!tap || tap.id !== e.pointerId) return;
		this.tap = null;
		if (tap.mouse) e.stopImmediatePropagation();
		if (e.timeStamp - tap.t > TAP_MS || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) return;
		this.jump(tap.source);
	}

	private cancel(): void {
		this.tap = null;
	}

	private onMove(e: PointerEvent): void {
		if (e.pointerType !== "mouse" || e.buttons !== 0) return this.setHover(-1);
		this.setHover(this.hitAt(e.clientX, e.clientY, 0));
	}

	private setHover(i: number): void {
		if (i === this.hover) return;
		this.nodes[this.hover]?.el.removeClass("is-hover");
		this.hover = i;
		if (i >= 0) this.nodes[i]?.el.addClass("is-hover");
	}

	/** The pen is on the screen: the labels step aside until it has been up for a moment. */
	private writing(): void {
		if (!this.shown) return;
		this.el.addClass("is-writing");
		if (this.writingTimer !== null) window.clearTimeout(this.writingTimer);
		this.writingTimer = window.setTimeout(() => {
			this.writingTimer = null;
			this.el.removeClass("is-writing");
		}, WRITING_HOLD_MS);
	}

	private jump(src: SemanticSource): void {
		const layout = this.host.layout();
		const v = layout ? jumpViewport(layout, this.host.view(), src) : null;
		if (v) this.host.jump(v, src.pageIndex);
	}

	/** The label under a client position (for the harness). */
	labelAt(clientX: number, clientY: number): SemanticSource | null {
		const i = this.hitAt(clientX, clientY);
		return i >= 0 ? this.pool[i]?.label?.source ?? null : null;
	}

	/** The labels now on screen, with their screen boxes (for the harness). */
	snapshot(): Array<{ key: string; kind: string; text: string; x: number; y: number; width: number; height: number }> {
		const out: Array<{ key: string; kind: string; text: string; x: number; y: number; width: number; height: number }> = [];
		if (!this.shown) return out;
		for (let i = 0; i < this.count; i++) {
			const s = this.pool[i]!;
			const src = s.label!.source;
			out.push({ key: src.key, kind: src.kind, text: src.text ?? "", x: s.x, y: s.y, width: s.width, height: s.height });
		}
		return out;
	}
}

function strokesOf(page: Page, ids: readonly string[]): Stroke[] {
	const set = new Set(ids);
	return page.strokes.filter((s) => set.has(s.id) && !s.hidden);
}

function sameStrokes(a: readonly Stroke[], b: readonly Stroke[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** The ink of a heading on its own, on a white sheet, `heightPx` CSS px tall at `dpr`. Null when it cannot be drawn. */
function drawHeading(page: Page, strokes: Stroke[], src: SemanticSource, heightPx: number, dpr: number): string | null {
	let canvas: HTMLCanvasElement | null = null;
	try {
		const scale = (heightPx / Math.max(1, src.height)) * dpr;
		canvas = createEl("canvas");
		canvas.width = Math.max(1, Math.min(2048, Math.round(src.width * scale)));
		canvas.height = Math.max(1, Math.min(2048, Math.round(src.height * scale)));
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		const sheet: Page = { id: page.id, width: page.width, height: page.height, paper: { kind: "blank", spacing: page.paper.spacing }, strokes, elements: [] };
		drawPageRaster(ctx, sheet, canvas.width / Math.max(1, src.width), { background: null, images: new Map(), region: { x: src.x, y: src.y, width: src.width, height: src.height } });
		return canvas.toDataURL("image/png");
	} catch (e) {
		console.error("[notebook] semantic zoom heading picture", e);
		return null;
	} finally {
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
	}
}
