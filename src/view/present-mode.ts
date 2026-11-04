/**
 * Presentation mode (roadmap #87): the pages full screen, one at a time, on a black surround, with a laser pointer.
 *
 * It is an overlay on the notebook view's container (the Fullscreen API is asked for on that container; where it is not
 * there, as in the Android WebView, the overlay simply fills the window). The page is drawn as an image, so the editor is
 * untouched; the state of a drawing with states is this overlay's own "shown" choice (`liveStateView`), never written. With
 * "write while presenting" on, the overlay turns transparent and the notebook's own canvas takes the pen (the view puts the
 * same page in front of it). Pen button, pen hover and input policy are not involved: the pen only moves the laser here.
 */
import { setIcon } from "obsidian";
import { t } from "../i18n";
import { liveStateView } from "../model/states";
import type { Page } from "../model/types";
import {
	classifyGesture, counterText, fitPage, LaserTrail, nextPos, prevPos, presentKeyAction, startPos, tapZone,
	type PresentAction, type PresentPos, type PresentSettings,
} from "./present-logic";

export interface PresentHost {
	/** The element the overlay goes into (and that goes full screen). */
	container(): HTMLElement;
	pages(): readonly Page[];
	/** The page in view when the presentation starts. */
	startIndex(): number;
	settings(): PresentSettings;
	/** The image (data URL) of `page` (already the view of its state), `widthPx` wide. */
	render(page: Page, widthPx: number): Promise<string>;
	/** "Write while presenting": the notebook's own view takes over (true) or is given back (false: returns the page index in view). */
	inkMode(on: boolean, pos: PresentPos): number | null;
	/** The page (and state) to show behind the transparent overlay while writing. */
	inkGo(pos: PresentPos): void;
	/** The presentation ended on page `index`. */
	closed(index: number): void;
}

const COUNTER_MS = 1800;
const BAR_MS = 2800;
const MAX_CANVAS_PX = 2600;
const CACHE_MAX = 4;
const LASER_IDLE_MS = 1600;

interface Down {
	id: number;
	x: number;
	y: number;
	t: number;
	type: string;
	laser: boolean;
}

export class PresentationMode {
	private root: HTMLElement | null = null;
	private img: HTMLImageElement | null = null;
	private laserCanvas: HTMLCanvasElement | null = null;
	private counterEl: HTMLElement | null = null;
	private barEl: HTMLElement | null = null;
	private inkBtn: HTMLButtonElement | null = null;
	private laserBtn: HTMLButtonElement | null = null;

	private pos: PresentPos = { page: 0, state: null };
	private readonly shown = new Map<string, string | null>();
	private blank = false;
	private ink = false;
	private laserOn = true;
	private token = 0;
	private readonly cache = new Map<string, string>();
	private readonly trail = new LaserTrail();
	private laserAt: { x: number; y: number } | null = null;
	private raf = 0;
	private down: Down | null = null;
	private counterTimer = 0;
	private barTimer = 0;
	private laserTimer = 0;
	private prefetchTimer = 0;
	private resizeTimer = 0;
	private fullscreen = false;
	private done = false;
	private readonly cleanups: Array<() => void> = [];

	constructor(private readonly host: PresentHost) {}

	get isOpen(): boolean {
		return this.root !== null && !this.done;
	}

	get position(): PresentPos {
		return this.pos;
	}

	get writing(): boolean {
		return this.ink;
	}

	/** Starts presenting from the page in view. False when the notebook has no page. */
	open(): boolean {
		if (this.isOpen) return true;
		const pages = this.host.pages();
		if (pages.length === 0) return false;
		const container = this.host.container();
		this.done = false;
		this.laserOn = this.host.settings().presentLaser;
		this.pos = startPos(pages, this.host.startIndex(), this.host.settings().presentSteps);
		this.build(container);
		this.requestFullscreen(container);
		void this.show();
		this.reveal();
		return true;
	}

	// --- build ---

	private build(container: HTMLElement): void {
		const root = container.createDiv({ cls: "nb-ui nb-present", attr: { role: "dialog", "aria-modal": "true", "aria-label": t("present.title"), tabindex: "-1" } });
		this.root = root;
		this.img = root.createEl("img", { cls: "nb-present-page", attr: { alt: "", draggable: "false" } });
		this.laserCanvas = root.createEl("canvas", { cls: "nb-present-laser", attr: { "aria-hidden": "true" } });
		this.counterEl = root.createDiv({ cls: "nb-present-counter", attr: { "aria-live": "polite" } });
		const bar = root.createDiv({ cls: "nb-present-bar" });
		this.barEl = bar;
		this.laserBtn = this.button(bar, "locate-fixed", t("present.laser"), () => this.toggleLaser());
		this.inkBtn = this.button(bar, "pen-line", t("present.ink"), () => this.toggleInk());
		this.button(bar, "x", t("present.exit"), () => this.exit(), "nb-present-exit");
		this.syncButtons();

		this.on<PointerEvent>(root, "pointerdown", (e) => this.onDown(e));
		this.on<PointerEvent>(root, "pointermove", (e) => this.onMove(e));
		this.on<PointerEvent>(root, "pointerup", (e) => this.onUp(e));
		this.on(root, "pointercancel", () => this.onCancel());
		this.on<PointerEvent>(root, "pointerleave", (e) => this.onLeave(e));
		this.on(root, "contextmenu", (e) => e.preventDefault());
		this.on<KeyboardEvent>(window, "keydown", (e) => this.onKey(e), true);
		this.on(window, "resize", () => this.onResize());
		this.on(document, "fullscreenchange", () => this.onFullscreenChange());
		root.focus({ preventScroll: true });
	}

	private button(parent: HTMLElement, icon: string, label: string, run: () => void, cls = ""): HTMLButtonElement {
		const b = parent.createEl("button", { cls: `nb-present-btn ${cls}`.trim(), attr: { type: "button", "aria-label": label, title: label } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			run();
		});
		// Buttons are not page taps: their own pointer events stop here.
		for (const type of ["pointerdown", "pointerup"]) b.addEventListener(type, (e) => e.stopPropagation());
		return b;
	}

	private on<T extends Event>(target: EventTarget, type: string, fn: (e: T) => void, capture = false): void {
		const listener = fn as unknown as EventListener;
		target.addEventListener(type, listener, capture);
		this.cleanups.push(() => target.removeEventListener(type, listener, capture));
	}

	private syncButtons(): void {
		this.laserBtn?.toggleClass("is-on", this.laserOn);
		this.laserBtn?.setAttribute("aria-pressed", String(this.laserOn));
		this.inkBtn?.toggleClass("is-on", this.ink);
		this.inkBtn?.setAttribute("aria-pressed", String(this.ink));
		this.root?.toggleClass("is-ink", this.ink);
		this.root?.toggleClass("is-blank", this.blank);
	}

	// --- full screen ---

	private requestFullscreen(container: HTMLElement): void {
		const request = (container as { requestFullscreen?: () => Promise<void> }).requestFullscreen;
		if (typeof request !== "function") return;
		try {
			request.call(container).then(() => {
				this.fullscreen = document.fullscreenElement === container;
				// The window changed size: lay the page out again.
				this.onResize();
			}, () => undefined);
		} catch {
			// No full screen here: the overlay fills the window instead.
		}
	}

	private onFullscreenChange(): void {
		if (this.fullscreen && !document.fullscreenElement) {
			this.fullscreen = false;
			this.exit();
		} else this.onResize();
	}

	// --- navigation ---

	private steps(): boolean {
		return this.host.settings().presentSteps;
	}

	/** Runs a navigation or display action (keys, taps, swipes and the buttons all come here). */
	act(action: PresentAction): void {
		if (!this.isOpen) return;
		const pages = this.host.pages();
		if (action === "exit") return this.exit();
		if (action === "blank") {
			this.blank = !this.blank;
			this.syncButtons();
			return;
		}
		let target: PresentPos | null = null;
		if (action === "next") target = nextPos(pages, this.pos, this.steps());
		else if (action === "prev") target = prevPos(pages, this.pos, this.steps());
		else if (action === "first") target = startPos(pages, 0, this.steps());
		else target = startPos(pages, pages.length - 1, this.steps());
		if (!target) {
			this.flashCounter();
			return;
		}
		this.go(target);
	}

	private go(target: PresentPos): void {
		this.pos = target;
		if (this.blank) {
			this.blank = false;
			this.syncButtons();
		}
		this.trail.clear();
		this.laserAt = null;
		this.clearLaser();
		if (this.ink) {
			this.applyShown();
			this.host.inkGo(this.pos);
			this.flashCounter();
			return;
		}
		void this.show();
	}

	/** The state this view shows the page in: its own choice when stepping, else the page's saved default. */
	private applyShown(): void {
		const page = this.host.pages()[this.pos.page];
		if (!page) return;
		if (this.steps() && (page.states?.list.length ?? 0) > 0) this.shown.set(page.id, this.pos.state);
		else this.shown.delete(page.id);
	}

	// --- drawing the page ---

	private box(page: Page): { x: number; y: number; width: number; height: number } {
		const root = this.root;
		return fitPage(page.width, page.height, root?.clientWidth || window.innerWidth, root?.clientHeight || window.innerHeight);
	}

	private async show(): Promise<void> {
		const page = this.host.pages()[this.pos.page];
		const img = this.img;
		if (!page || !img || this.done) return;
		const token = ++this.token;
		this.applyShown();
		this.updateCounter();
		const box = this.box(page);
		const url = await this.imageFor(page, this.pos.state, box.width);
		if (token !== this.token || this.done) return;
		img.setCssProps({ "--nb-present-w": `${Math.round(box.width)}px`, "--nb-present-h": `${Math.round(box.height)}px` });
		if (url) img.src = url;
		this.flashCounter();
		this.layoutLaser();
		this.schedulePrefetch();
	}

	private async imageFor(page: Page, state: string | null, cssWidth: number): Promise<string> {
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const widthPx = Math.max(64, Math.min(MAX_CANVAS_PX, Math.round(cssWidth * dpr)));
		const key = `${page.id}|${this.steps() ? state : "-"}|${widthPx}`;
		const hit = this.cache.get(key);
		if (hit) return hit;
		let url = "";
		try {
			url = await this.host.render(liveStateView(page, this.shownFor(page, state)), widthPx);
		} catch (e) {
			console.error("[notebook] presentation: drawing a page failed", e);
		}
		if (url) {
			this.cache.set(key, url);
			while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
		}
		return url;
	}

	/** A "shown" map that shows `state` for `page` (when stepping), else the view's own choice (the saved default). */
	private shownFor(page: Page, state: string | null): ReadonlyMap<string, string | null> {
		if (!this.steps() || (page.states?.list.length ?? 0) === 0) return new Map();
		return new Map([[page.id, state]]);
	}

	private schedulePrefetch(): void {
		window.clearTimeout(this.prefetchTimer);
		this.prefetchTimer = window.setTimeout(() => {
			const next = nextPos(this.host.pages(), this.pos, this.steps());
			const page = next ? this.host.pages()[next.page] : null;
			if (!next || !page || this.done) return;
			void this.imageFor(page, next.state, this.box(page).width);
		}, 350);
	}

	private onResize(): void {
		window.clearTimeout(this.resizeTimer);
		this.resizeTimer = window.setTimeout(() => {
			if (!this.isOpen) return;
			this.cache.clear();
			if (!this.ink) void this.show();
			else this.layoutLaser();
		}, 150);
	}

	// --- counter and controls ---

	private updateCounter(): void {
		this.counterEl?.setText(counterText(this.host.pages(), this.pos, this.steps()));
	}

	private flashCounter(): void {
		this.updateCounter();
		this.counterEl?.addClass("is-shown");
		window.clearTimeout(this.counterTimer);
		this.counterTimer = window.setTimeout(() => this.counterEl?.removeClass("is-shown"), COUNTER_MS);
	}

	/** Shows the controls (exit, laser, write) and the counter for a moment. */
	private reveal(): void {
		this.barEl?.addClass("is-shown");
		window.clearTimeout(this.barTimer);
		this.barTimer = window.setTimeout(() => this.barEl?.removeClass("is-shown"), BAR_MS);
		this.flashCounter();
	}

	private toggleLaser(): void {
		this.laserOn = !this.laserOn;
		if (!this.laserOn) {
			this.trail.clear();
			this.laserAt = null;
			this.clearLaser();
		}
		this.syncButtons();
		this.reveal();
	}

	private toggleInk(): void {
		this.ink = !this.ink;
		this.trail.clear();
		this.laserAt = null;
		this.clearLaser();
		this.cache.clear();
		this.syncButtons();
		if (this.ink) {
			this.applyShown();
			this.host.inkMode(true, this.pos);
		} else {
			const index = this.host.inkMode(false, this.pos);
			// The reader may have turned pages by hand while writing: carry on from where the view is.
			if (index !== null && index !== this.pos.page) this.pos = startPos(this.host.pages(), index, this.steps());
			void this.show();
		}
		this.reveal();
	}

	// --- keys ---

	private onKey(e: KeyboardEvent): void {
		if (!this.isOpen) return;
		const action = presentKeyAction(e);
		if (!action) return;
		const target = e.target as HTMLElement | null;
		if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
		if (activeDocument.querySelector(".modal-container, .menu, .suggestion-container")) return;
		// The notebook's own page turner and the pen key never see these.
		e.preventDefault();
		e.stopImmediatePropagation();
		if (e.repeat && action === "exit") return;
		this.act(action);
		if (action !== "exit") this.reveal();
	}

	// --- pointer: laser pointer, taps and swipes ---

	private isLaser(e: PointerEvent): boolean {
		return this.laserOn && !this.ink && (e.pointerType === "pen" || e.pointerType === "mouse");
	}

	private local(e: PointerEvent): { x: number; y: number } {
		const r = this.root?.getBoundingClientRect();
		return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
	}

	private onDown(e: PointerEvent): void {
		if (!this.isOpen || this.ink) return;
		const { x, y } = this.local(e);
		this.down = { id: e.pointerId, x, y, t: e.timeStamp, type: e.pointerType, laser: e.pointerType === "pen" && this.laserOn };
		if (this.isLaser(e)) this.point(x, y);
		this.reveal();
	}

	private onMove(e: PointerEvent): void {
		if (!this.isOpen || this.ink) return;
		if (this.isLaser(e)) {
			const { x, y } = this.local(e);
			this.point(x, y);
		}
		if (e.pointerType !== "touch") this.reveal();
	}

	private onUp(e: PointerEvent): void {
		const down = this.down;
		this.down = null;
		if (!down || down.id !== e.pointerId || !this.isOpen || this.ink) return;
		// The pen is the laser: it never turns the page (a remote, a tap on a side or the keys do).
		if (down.laser) {
			this.fadeLaserSoon();
			return;
		}
		const { x, y } = this.local(e);
		const gesture = classifyGesture(x - down.x, y - down.y, e.timeStamp - down.t);
		if (gesture === "swipe-next") this.act("next");
		else if (gesture === "swipe-prev") this.act("prev");
		else if (gesture === "tap") {
			const zone = tapZone(x, y, this.root?.clientWidth ?? 1);
			if (zone === "reveal") this.reveal();
			else {
				this.act(zone);
				this.reveal();
			}
		}
	}

	private onCancel(): void {
		this.down = null;
		this.fadeLaserSoon();
	}

	private onLeave(e: PointerEvent): void {
		if (e.pointerType === "pen" || e.pointerType === "mouse") this.fadeLaserSoon(0);
	}

	// --- the laser ---

	private point(x: number, y: number): void {
		const last = this.laserAt;
		this.laserAt = { x, y };
		if (!last || Math.hypot(x - last.x, y - last.y) >= 2) this.trail.add(x, y, performance.now());
		window.clearTimeout(this.laserTimer);
		this.laserTimer = window.setTimeout(() => this.fadeLaserSoon(0), LASER_IDLE_MS);
		this.scheduleDraw();
	}

	private fadeLaserSoon(delay = 250): void {
		window.clearTimeout(this.laserTimer);
		this.laserTimer = window.setTimeout(() => {
			this.laserAt = null;
			this.scheduleDraw();
		}, delay);
	}

	private layoutLaser(): void {
		const c = this.laserCanvas;
		const root = this.root;
		if (!c || !root) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const w = Math.max(1, Math.round(root.clientWidth * dpr));
		const h = Math.max(1, Math.round(root.clientHeight * dpr));
		if (c.width !== w || c.height !== h) {
			c.width = w;
			c.height = h;
		}
	}

	private clearLaser(): void {
		const c = this.laserCanvas;
		c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
	}

	/** The loop runs only while there is a trail to fade; a resting dot is drawn once. */
	private scheduleDraw(): void {
		if (this.raf !== 0 || this.done) return;
		this.raf = window.requestAnimationFrame(() => {
			this.raf = 0;
			this.drawLaser();
		});
	}

	private drawLaser(): void {
		const c = this.laserCanvas;
		const ctx = c?.getContext("2d");
		const root = this.root;
		if (!c || !ctx || !root || this.done) return;
		if (c.width === 1 || c.height === 1) this.layoutLaser();
		const k = c.width / Math.max(1, root.clientWidth);
		const now = performance.now();
		const pts = this.trail.alive(now);
		ctx.clearRect(0, 0, c.width, c.height);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1]!;
			const b = pts[i]!;
			const alpha = this.trail.alpha(b.t, now);
			ctx.strokeStyle = `rgba(255, 40, 40, ${(alpha * 0.28).toFixed(3)})`;
			ctx.lineWidth = 14 * k * alpha;
			ctx.beginPath();
			ctx.moveTo(a.x * k, a.y * k);
			ctx.lineTo(b.x * k, b.y * k);
			ctx.stroke();
			ctx.strokeStyle = `rgba(255, 90, 90, ${(alpha * 0.9).toFixed(3)})`;
			ctx.lineWidth = 5 * k * alpha;
			ctx.stroke();
		}
		const dot = this.laserAt;
		if (dot) {
			const r = 11 * k;
			const g = ctx.createRadialGradient(dot.x * k, dot.y * k, 0, dot.x * k, dot.y * k, r);
			g.addColorStop(0, "rgba(255, 255, 255, 0.95)");
			g.addColorStop(0.35, "rgba(255, 60, 60, 0.95)");
			g.addColorStop(1, "rgba(255, 40, 40, 0)");
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(dot.x * k, dot.y * k, r, 0, Math.PI * 2);
			ctx.fill();
		}
		if (this.trail.size > 0) this.scheduleDraw();
	}

	// --- leaving ---

	exit(): void {
		if (this.done || !this.root) return;
		this.done = true;
		this.token++;
		let index = this.pos.page;
		if (this.ink) {
			const now = this.host.inkMode(false, this.pos);
			if (now !== null) index = now;
			this.ink = false;
		}
		for (const id of [this.counterTimer, this.barTimer, this.laserTimer, this.prefetchTimer, this.resizeTimer]) window.clearTimeout(id);
		if (this.raf !== 0) window.cancelAnimationFrame(this.raf);
		this.raf = 0;
		for (const off of this.cleanups.splice(0)) off();
		if (this.fullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
		this.fullscreen = false;
		this.root.remove();
		this.root = null;
		this.img = null;
		this.laserCanvas = null;
		this.counterEl = null;
		this.barEl = null;
		this.cache.clear();
		this.host.closed(index);
	}

	/** The view is closing: end the presentation without moving the view. */
	destroy(): void {
		if (this.root) this.exit();
	}
}
