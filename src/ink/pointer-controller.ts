import { InputPolicy, heldToolOf, opensRadial } from "./input-policy";
import {
	DEFAULT_BUTTON_WINDOWS, EraserNextArm, HoverClickTracker, contactVerdict, heldBeforeContact, hoverClickAction, hoverMenuPosition, isTextField,
	type ButtonWindows, type ClientPoint,
} from "./pen-hover";
import { ErrorOnce } from "./errors";
import {
	BarrelDetector, ChordDetector, FINGER_HOLD_MS, FINGER_HOLD_RADIUS_PX, HOLD_MS, StillHold, fingerHoldMayStart, isBarrelSignal, isEraserSignal,
	penHoldMayStart, strokeIsYoung, type PointerKind,
} from "./pen-button";

/**
 * How the radial menu was asked for: the pen's side button pressed (barrel bit: opens on the press), a click of
 * the Samsung pressure-0 button (opens on the release), a still pen on the page, or a finger long-press.
 */
export type MenuSource = "button" | "click" | "pen-hold" | "finger";

/** A pointer sample in CSS px relative to the element. */
export interface InkSample {
	x: number;
	y: number;
	pressure: number;
	t: number;
	pointerType: string;
}

/**
 * Pointer samples of one event in preallocated typed arrays (CSS px relative to the element,
 * pressure, timestamp in ms): the drawing hot path creates no object per sample. The buffer is
 * reused for the next event, so handlers must copy what they keep.
 */
export class SampleBuffer {
	count = 0;
	pointerType = "";
	x: Float64Array;
	y: Float64Array;
	p: Float64Array;
	t: Float64Array;

	constructor(capacity = 64) {
		this.x = new Float64Array(capacity);
		this.y = new Float64Array(capacity);
		this.p = new Float64Array(capacity);
		this.t = new Float64Array(capacity);
	}

	clear(pointerType = this.pointerType): void {
		this.count = 0;
		this.pointerType = pointerType;
	}

	push(x: number, y: number, p: number, t: number): void {
		const i = this.count;
		if (i >= this.x.length) this.grow();
		this.x[i] = x;
		this.y[i] = y;
		this.p[i] = p;
		this.t[i] = t;
		this.count = i + 1;
	}

	private grow(): void {
		const n = this.x.length * 2;
		const g = (a: Float64Array) => {
			const b = new Float64Array(n);
			b.set(a);
			return b;
		};
		this.x = g(this.x);
		this.y = g(this.y);
		this.p = g(this.p);
		this.t = g(this.t);
	}
}

/**
 * Is a sample at (t, x, y) new after the last delivered one? `pointerrawupdate` and the coalesced
 * list of the next `pointermove` report the same samples: timestamps only move forward. `strict`
 * (a `pointermove` after `pointerrawupdate` delivered samples): only later timestamps are new, so a
 * batch of samples sharing one timestamp is not delivered twice.
 */
export function isNewSample(lastT: number, lastX: number, lastY: number, t: number, x: number, y: number, strict = false): boolean {
	return t > lastT || (!strict && t === lastT && (x !== lastX || y !== lastY));
}

export interface PointerHandlers {
	/** `eraser`: the pen has its eraser button pressed or is flipped. Return false to reject the stroke. */
	drawStart(sample: InkSample, eraser: boolean, held?: "lasso" | "previous" | "gesture"): boolean;
	/**
	 * New samples of the drawing pointer (never repeated: each sample is delivered once, whether it
	 * came from `pointerrawupdate` or `pointermove`) and the browser's predicted samples (may be empty).
	 */
	drawMove(samples: SampleBuffer, predicted: SampleBuffer): void;
	/** `cancelled`: discard the stroke (e.g. palm, finger turned into a pinch). */
	drawEnd(cancelled: boolean): void;
	pan(dx: number, dy: number): void;
	zoom(factor: number, fx: number, fy: number): void;
	/**
	 * Open the radial menu at (x, y) (CSS px relative to the element): the pen's side button was pressed (and its
	 * action is the radial menu), the pen was held still, or a finger was long-pressed. No stroke is started and
	 * the contact that asked for it is no longer a stroke or a pan.
	 */
	penMenu?(x: number, y: number, source: MenuSource): void;
	/** A signal of the pen's side button reached the page (whatever the button is set to do). */
	sideButtonSeen?(): void;
	/** 0.11.2: "next stroke erases" was armed or disarmed (the toolbar shows it on the current-pen indicator). */
	eraserNextChanged?(armed: boolean): void;
}

interface NavPointer {
	x: number;
	y: number;
}

/**
 * Turns Pointer Events into strokes and navigation gestures.
 * Only one pointer draws at a time; the pen takes precedence over everything.
 */
export interface PointerControllerOptions {
	/**
	 * Also listen to `pointerrawupdate` (Chromium, secure contexts): samples arrive as soon as the OS
	 * delivers them, not once per frame. Part of the experimental low-latency ink; off by default.
	 */
	rawUpdates?: boolean;
	/**
	 * The view's root element (0.11.1). With it, the side-button detector also listens at window level in the
	 * capture phase: pen events over the view that never reach the element (they target the toolbar or another
	 * part of the view, or a handler above the element stopped them) and mouse-only presses still count. Events
	 * outside the scope (other views, modals, Obsidian's own UI) are ignored. Only the side button is detected
	 * there: strokes, panning and zooming come from the element's own listeners, as before.
	 */
	scope?: ScopeTarget;
	/** Where the window-level listeners go (default: the element's window). For tests. */
	windowTarget?: EventTarget;
}

/** The view's root as the controller uses it: a node that receives events and can say what it contains. */
export type ScopeTarget = EventTarget & { contains(node: Node | null): boolean };

/**
 * Event types the window-level side-button watch listens to (capture phase). `contextmenu` is listened on the
 * scope instead (capture, not passive), so that only the notebook view's native menu is ever blocked.
 */
const WINDOW_TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel", "auxclick", "mousedown"] as const;
/** The stage marks these as "reached" in its capture phase (the window and scope copies are then left to it). */
const STAGE_MARKED = [...WINDOW_TYPES, "contextmenu"] as const;

/** Is the target a text field (text box editor, equation input, ...)? Its native menu (paste, select) stays. */
function isTextEditing(target: EventTarget | null): boolean {
	const el = target as Partial<HTMLElement> | null;
	if (!el) return false;
	if (el.isContentEditable === true) return true;
	const closest = typeof el.closest === "function" ? el.closest.bind(el) : null;
	return !!closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}
const WINDOW_KIND: Record<string, PointerKind | undefined> = { pointerdown: "down", pointermove: "move", pointerup: "up", pointercancel: "cancel" };

export class PointerController {
	predictionEnabled = false;
	private rawListener: ((e: Event) => void) | null = null;
	private readonly errors = new ErrorOnce("input");

	private drawId: number | null = null;
	private drawType = "";
	private drawLast: NavPointer | null = null;
	private readonly nav = new Map<number, NavPointer>();
	private rect: DOMRect;
	private readonly disposers: Array<() => void> = [];
	/** Recent one-finger pan movements, for the fling (inertial scroll) velocity. */
	private panTrail: Array<{ t: number; dx: number; dy: number }> = [];
	private inertiaFrame: number | null = null;
	private readonly samples = new SampleBuffer();
	private readonly predicted = new SampleBuffer(16);
	/** Last delivered sample of the drawing pointer (deduplicates rawupdate/move and coalesced lists). */
	private lastT = -Infinity;
	private lastX = NaN;
	private lastY = NaN;
	/** pointerrawupdate delivered samples during this stroke: pointermove only adds later ones. */
	private rawSeen = false;
	/** Pen side-button detection from every signal (pointer buttons, contextmenu, auxclick), one menu per press. */
	private readonly barrel = new BarrelDetector();
	/** Whether the pen stroke in progress has stayed still since it started (young-stroke cancel, still-hold fallback). */
	private readonly hold = new StillHold();
	private holdTimer: number | null = null;
	private drawDownT = 0;
	/** Finger long-press: the finger that may open the menu, its stillness and its timer. */
	private readonly fingerHold = new StillHold(FINGER_HOLD_RADIUS_PX);
	private fingerHoldId: number | null = null;
	private fingerTimer: number | null = null;
	/** Side button pressed during contact (chord event): the stroke was finished and the contact now acts as the button's tool. */
	private readonly chord = new ChordDetector();
	private chordHeld = false;
	/** Events that reached the element (its capture phase): the window-level watch leaves them to the element's listeners. */
	private readonly reached = new WeakSet<Event>();
	/** Events over the element seen at window level, checked once their dispatch is over (did they reach the element?). */
	private pending: Event[] = [];
	private pendingTimer: number | null = null;
	/** 0.11.2: pointers down on the view, to tell the side button clicked while hovering (a bare contextmenu) from a long-press. */
	private readonly hover = new HoverClickTracker();
	/** 0.11.2: "next stroke erases", armed by a hover click or the pen key. */
	private readonly eraserNextArm = new EraserNextArm((armed) => this.handlers.eraserNextChanged?.(armed));
	/** Last client position of the pen (hover never reaches Obsidian on Android: in practice, where it last touched). */
	private lastPenClient: ClientPoint | null = null;
	/** The pen stroke in progress already erases or acts as the button's tool (started so, or switched by the button). */
	private drawHeld = false;
	/**
	 * 0.11.2 (device finding): the side button shows only as a `contextmenu` around or during a pen contact. The samples of
	 * the contact's first `afterMs` (to replay them as the eraser), when it started, and the last pressure delivered.
	 */
	private readonly trail = new SampleBuffer(128);
	private trailOn = false;
	private contactDownT = -Infinity;
	private lastP = 0;
	/** A bare contextmenu with no contact: the button clicked while hovering, unless a pen contact starts within `beforeMs`. */
	private pendingClick: { t: number; x: number; y: number } | null = null;
	private pendingClickTimer: number | null = null;

	constructor(
		private readonly el: HTMLElement,
		private readonly policy: InputPolicy,
		private readonly handlers: PointerHandlers,
		options: PointerControllerOptions = {},
	) {
		this.rect = el.getBoundingClientRect();
		// Handlers are guarded: an exception in one event must not leave a stroke half-open or stop the next ones.
		this.listen("pointerdown", (e) => {
			this.errors.run("pointerdown", () => this.onDown(e));
			// As pen-tracker does: the pen's pointerdown on the drawing surface (the stage, touch-action none, or one of
			// its canvases) is always cancelled, also when it draws nothing (read-only, palm edge), so the WebView
			// starts no long-press, selection or compatibility mouse handling of its own. Strokes are unchanged: a
			// stroke start already cancelled it. Controls inside the stage (text boxes, panels) keep theirs.
			if (e.pointerType === "pen" && e.cancelable && !e.defaultPrevented && this.isSurface(e.target)) e.preventDefault();
		});
		this.listen("pointermove", (e) => this.errors.run("pointermove", () => this.onMove(e)));
		this.setRawUpdates(options.rawUpdates === true);
		this.disposers.push(() => this.setRawUpdates(false));
		this.listen("pointerup", (e) => this.guardedUp(e));
		this.listen("pointercancel", (e) => this.guardedUp(e));
		this.listen("lostpointercapture", (e) => this.guardedUp(e));
		this.listen("wheel", (e) => this.onWheel(e), { passive: false });
		// The native menu never opens on the page; a contextmenu that comes from the pen's button opens the radial menu.
		this.listen("contextmenu", (e) => this.errors.run("contextmenu", () => this.onContextMenu(e)));
		this.listen("auxclick", (e) => this.errors.run("auxclick", () => this.onAuxClick(e)));
		// Keep Obsidian mobile (side drawers) and the WebView from interpreting gestures on the page.
		this.listen("touchstart", (e) => e.stopPropagation(), { passive: true });
		this.listen("touchmove", (e) => {
			e.stopPropagation();
			if (e.cancelable) e.preventDefault();
		}, { passive: false });
		const win = options.windowTarget ?? el.ownerDocument?.defaultView ?? null;
		if (win && options.scope) this.watchWindow(win, options.scope);
	}

	/**
	 * Side-button signals at window level, capture phase (pen-tracker style: whatever element the pen is over).
	 * An event over the element is left to the element's listeners when it reaches them (the normal case); one
	 * that was stopped before it got there, or that targets another part of the view, is fed to the detector here.
	 */
	/** The stage itself or one of its canvases (not a control placed on the page). */
	private isSurface(target: EventTarget | null): boolean {
		if (target === (this.el as unknown as EventTarget)) return true;
		const tag = (target as Partial<Element> | null)?.tagName;
		return typeof tag === "string" && tag.toUpperCase() === "CANVAS" && this.el.contains(target as Node);
	}

	private watchWindow(win: EventTarget, scope: ScopeTarget): void {
		for (const type of STAGE_MARKED) {
			this.listen(type, (e: Event) => this.reached.add(e), { capture: true, passive: true });
		}
		// The view's native context menu: capture phase on the view, not passive (it must be cancellable).
		const onMenu = (e: Event): void => {
			this.errors.run("contextmenu", () => this.onScopeContextMenu(e as MouseEvent, scope));
		};
		const menuOpts: AddEventListenerOptions = { capture: true, passive: false };
		scope.addEventListener("contextmenu", onMenu, menuOpts);
		this.disposers.push(() => scope.removeEventListener("contextmenu", onMenu, menuOpts));
		const fn = (e: Event): void => {
			this.errors.run("window", () => this.onWindowEvent(e, scope));
		};
		for (const type of WINDOW_TYPES) {
			// auxclick of the pen button is prevented (no native action over the view).
			const opts: AddEventListenerOptions = { capture: true, passive: type !== "auxclick" };
			win.addEventListener(type, fn, opts);
			this.disposers.push(() => win.removeEventListener(type, fn, opts));
		}
		this.disposers.push(() => {
			if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
			this.pending = [];
		});
	}

	/**
	 * A `contextmenu` anywhere in the view (capture phase, before the page's elements). On Samsung the side button may
	 * surface as one, or as a long-press: left alone, the WebView starts its own long-press or selection handling and
	 * cancels the pen stream (`pointercancel`). With the pen near (hovering or touching), from the pen, or with no
	 * `pointerType` it is cancelled, as pen-tracker does, and judged by the detector like every other button signal.
	 * Text fields keep their menu.
	 */
	private onScopeContextMenu(e: MouseEvent, scope: ScopeTarget): void {
		const target = e.target as Node | null;
		if (!target || !scope.contains(target) || isTextEditing(target)) return;
		if (this.barrel.blocksContextMenu((e as Partial<PointerEvent>).pointerType, e.timeStamp) && e.cancelable) e.preventDefault();
		if (target === (this.el as unknown as Node) || this.el.contains(target)) {
			// The stage's own listener judges it when it gets there (and always cancels it).
			this.pending.push(e);
			if (this.pendingTimer === null) this.pendingTimer = window.setTimeout(() => this.flushPending(), 0);
			return;
		}
		this.sideButtonElsewhere(e);
	}

	private onWindowEvent(e: Event, scope: ScopeTarget): void {
		const target = e.target as Node | null;
		if (!target || !scope.contains(target)) return;
		const pe = e as Partial<PointerEvent>;
		const kind = WINDOW_KIND[e.type];
		if (kind) {
			this.barrel.noteAny(kind, pe.pointerType ?? "", e.timeStamp);
			this.notePointer(kind, pe);
		}
		if (e.type === "mousedown") {
			this.onWindowMouseDown(e as MouseEvent);
			return;
		}
		// Fingers: the element's own listeners count them; a finger elsewhere only blocks mouse-only presses (noteAny).
		if (kind && pe.pointerType === "touch") return;
		if (target === (this.el as unknown as Node) || this.el.contains(target)) {
			// The stroke in progress is captured by the element: its events always reach it.
			if (kind && this.drawId !== null && pe.pointerId === this.drawId) return;
			this.pending.push(e);
			if (this.pendingTimer === null) this.pendingTimer = window.setTimeout(() => this.flushPending(), 0);
			return;
		}
		this.sideButtonElsewhere(e);
	}

	private flushPending(): void {
		this.pendingTimer = null;
		const list = this.pending;
		this.pending = [];
		for (const e of list) {
			if (this.reached.has(e)) continue;
			this.errors.run("window", () => this.sideButtonElsewhere(e));
		}
	}

	/**
	 * A side-button signal that did not reach the element: detector only. A press (or a click of the Samsung
	 * pressure-0 button) opens the menu when the pen is over the element; it never starts a stroke.
	 */
	private sideButtonElsewhere(e: Event): void {
		if (e.type === "contextmenu" && this.buttonContextMenu(e as MouseEvent)) return;
		if (e.type === "contextmenu" || e.type === "auxclick") {
			const me = e as MouseEvent;
			const pointerType = (e as Partial<PointerEvent>).pointerType;
			const press = e.type === "contextmenu" ? this.barrel.contextMenu(pointerType, e.timeStamp) : this.barrel.auxClick(pointerType, me.button, e.timeStamp);
			if (!press) return;
			if (e.cancelable) e.preventDefault();
			this.handlers.sideButtonSeen?.();
			this.menuIfOver(me.clientX, me.clientY, e.timeStamp, "button");
			return;
		}
		const kind = WINDOW_KIND[e.type];
		if (!kind) return;
		const pe = e as PointerEvent;
		if (this.barrelPointer(kind, pe)) {
			this.handlers.sideButtonSeen?.();
			if (!this.barrel.zeroPressureHeld) this.menuIfOver(pe.clientX, pe.clientY, pe.timeStamp, "button");
		}
		if (pe.pointerType !== "pen") return;
		const tr = this.barrel.transition;
		if (tr === "release-click") {
			if (opensRadial(this.policy.settings.penButton)) this.menuIfOver(pe.clientX, pe.clientY, pe.timeStamp, "click");
		} else if (tr === "contact-end" || tr === "release") {
			this.finishPenStroke(pe.timeStamp);
		}
	}

	/** A `mousedown` that no pointer event announced, while the pen hovers: the side button reported only as a mouse event. */
	private onWindowMouseDown(e: MouseEvent): void {
		const caps = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null }).sourceCapabilities;
		if (!this.barrel.mouseDown(e.button, e.buttons, e.timeStamp, caps?.firesTouchEvents === true)) return;
		this.handlers.sideButtonSeen?.();
		this.menuIfOver(e.clientX, e.clientY, e.timeStamp, "button");
	}

	/** Opens the menu for a window-level signal, only when the pen is over the element (client coordinates). */
	private menuIfOver(clientX: number, clientY: number, t: number, source: "button" | "click"): void {
		this.rect = this.el.getBoundingClientRect();
		const r = this.rect;
		if (clientX < r.left || clientX > r.left + r.width || clientY < r.top || clientY > r.top + r.height) return;
		if (source === "button") {
			this.requestMenu(clientX, clientY, t);
			return;
		}
		if (this.drawId !== null) return;
		this.handlers.penMenu?.(clientX - r.left, clientY - r.top, "click");
	}

	/** `pointerrawupdate` is listened to. */
	get rawUpdates(): boolean {
		return this.rawListener !== null;
	}

	/** Listens to `pointerrawupdate` when `on` and the browser has it; pointermove alone otherwise. */
	setRawUpdates(on: boolean): void {
		const supported = typeof window !== "undefined" && "onpointerrawupdate" in window;
		const want = on && supported;
		if (want === this.rawUpdates) return;
		if (this.rawListener) {
			this.el.removeEventListener("pointerrawupdate", this.rawListener);
			this.rawListener = null;
		} else {
			this.rawListener = (e: Event) => this.errors.run("pointerrawupdate", () => this.onRawUpdate(e as PointerEvent));
			this.el.addEventListener("pointerrawupdate", this.rawListener);
		}
	}

	get drawing(): boolean {
		return this.drawId !== null;
	}

	/** True while a finger or mouse pans or zooms. */
	get navigating(): boolean {
		return this.nav.size > 0;
	}

	/** Ends the stroke in progress and keeps it (app going to background, view closing). */
	finishActiveStroke(): void {
		if (this.drawId === null) return;
		this.releaseDraw();
		this.handlers.drawEnd(false);
	}

	/** 0.11.2: "next stroke erases" is armed. */
	get eraserNextArmed(): boolean {
		return this.eraserNextArm.armed;
	}

	/** Arms "next stroke erases", or disarms it when it is armed (a second click). Returns the new state. */
	toggleEraserNext(): boolean {
		return this.eraserNextArm.toggle();
	}

	/** Disarms "next stroke erases" (tool change, Escape). */
	disarmEraserNext(): void {
		this.eraserNextArm.disarm();
	}

	/**
	 * 0.11.2: the pen key (a key the S Pen is mapped to with Key Mapper): the radial menu at the last pen position (or the
	 * centre of the page area), or "next stroke erases" toggled. The menu never opens while a stroke is in progress.
	 */
	penKey(action: "menu" | "eraser-next"): void {
		if (action === "eraser-next") {
			this.eraserNextArm.toggle();
			return;
		}
		this.openClickMenu(null);
	}

	destroy(): void {
		this.dropPendingClick();
		this.stopInertia();
		this.clearHoldTimer();
		this.cancelFingerHold();
		this.finishActiveStroke();
		for (const d of this.disposers) d();
		this.disposers.length = 0;
	}

	private listen<K extends keyof HTMLElementEventMap>(
		type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions,
	): void {
		this.el.addEventListener(type, fn as EventListener, opts);
		this.disposers.push(() => this.el.removeEventListener(type, fn as EventListener, opts));
	}

	private sample(e: PointerEvent): InkSample {
		return {
			x: e.clientX - this.rect.left,
			y: e.clientY - this.rect.top,
			pressure: e.pressure,
			t: e.timeStamp,
			pointerType: e.pointerType,
		};
	}

	/** Feeds a pointer event over the view to the hover-click tracker and remembers where the pen is. */
	private notePointer(kind: PointerKind, e: Partial<PointerEvent>): void {
		const type = e.pointerType ?? "";
		if (typeof e.pointerId === "number") this.hover.pointer(kind, type, e.pointerId, e.timeStamp ?? 0, e.buttons ?? 0);
		if (type === "pen" && typeof e.clientX === "number" && typeof e.clientY === "number") this.lastPenClient = { x: e.clientX, y: e.clientY };
	}

	private onDown(e: PointerEvent): void {
		this.rect = this.el.getBoundingClientRect();
		this.stopInertia();
		this.notePointer("down", e);
		const pressed = this.barrelPointer("down", e);
		if (pressed) this.handlers.sideButtonSeen?.();
		// A pen near ends a finger long-press in the making (a second finger does too, in armFingerHold).
		if (e.pointerType === "pen") this.cancelFingerHold();
		// Samsung: the button pressed while hovering arrives as a pointerdown with pressure 0. It never draws, nor erases:
		// a click opens the menu on release; touching while it is held acts as the button's tool (zpStep).
		if (e.pointerType === "pen" && this.barrel.zeroPressureHeld) {
			this.policy.notePen(e.timeStamp);
			this.zpStep(e);
			e.preventDefault();
			return;
		}
		const contact = Math.max(e.width || 0, e.height || 0);
		// A right-button "mouse" press right after pen activity is the pen's side button reported as a mouse.
		const asPen = this.barrel.asPen(e.pointerType, e.button, e.buttons, e.timeStamp);
		// 0.11.2: the pen's pressure tells "button held while the nib touches" (pressure > 0: the button's tool) from a
		// press while hovering (pressure 0: the menu).
		const pressure = e.pointerType === "pen" ? e.pressure : undefined;
		let route = this.policy.route(asPen ? "pen" : e.pointerType, e.timeStamp, e.button, contact, e.buttons, pressure);
		if (asPen && route !== "menu") route = this.policy.route(e.pointerType, e.timeStamp, e.button, contact, e.buttons);
		// A palm resting on an edge does nothing: no drawing, no panning.
		if (route !== "ignore" && this.policy.edgeRejects(e.pointerType, e.clientX - this.rect.left, e.clientY - this.rect.top, this.rect.width, this.rect.height)) {
			route = "ignore";
		}
		// A finger that lands among fingers that are already panning or pinching joins them: it never starts a stroke.
		if (route === "draw" && e.pointerType === "touch" && this.nav.size > 0) route = "navigate";
		// The menu route has no stroke whose end would clear this: the pen is not "down" for palm rejection.
		if (e.pointerType === "pen") {
			if (route === "menu") this.policy.notePen(e.timeStamp);
			else this.policy.setPenDown(true, e.timeStamp);
		}

		if (route === "menu") {
			if (this.drawId !== null && this.drawType !== "pen") this.cancelDraw();
			// The pen is captured by the stage on contact; release it so the menu receives the movement and the lift.
			if (this.el.hasPointerCapture?.(e.pointerId)) {
				try {
					this.el.releasePointerCapture(e.pointerId);
				} catch {
					// The pointer is gone: nothing to release.
				}
			}
			e.preventDefault();
			this.handlers.penMenu?.(e.clientX - this.rect.left, e.clientY - this.rect.top, "button");
			return;
		}

		if (route === "draw") {
			if (this.drawId !== null) {
				// The pen replaces a finger stroke (likely a palm); a second finger turns into a pinch.
				if (e.pointerType === "pen" && this.drawType !== "pen") {
					this.cancelDraw();
				} else if (e.pointerType === "touch" && this.drawType === "touch") {
					this.convertDrawToNav();
					this.addNav(e);
					return;
				} else {
					return;
				}
			}
			const pen = e.pointerType === "pen";
			// 0.11.2: a bare contextmenu just before this contact: the button was held when the nib landed.
			const heldAtContact = pen && this.takePendingClick(e.timeStamp);
			let eraser = pen && (this.policy.penErases(e.button, e.buttons, e.pressure) || heldAtContact);
			const held = (pen && !eraser && this.policy.penHeld(e.button, e.buttons)) || undefined;
			// 0.11.2: "next stroke erases" (armed by a hover click or the pen key) takes the next ordinary pen stroke.
			const armed = pen && !eraser && !held && this.eraserNextArm.armed;
			if (armed) eraser = true;
			if (!this.beginDraw(e, eraser, held)) return;
			if (armed) this.eraserNextArm.consume();
			if (pen) {
				this.drawHeld = eraser || !!held;
				this.contactDownT = e.timeStamp;
				this.lastP = e.pressure;
				this.trail.clear("pen");
				this.trailOn = !this.drawHeld;
				if (this.trailOn) this.trail.push(e.clientX - this.rect.left, e.clientY - this.rect.top, e.pressure, e.timeStamp);
				this.armHold(e, eraser);
				this.chordHeld = false;
				// A stroke started with the eraser end or the barrel bit already is the button's doing: no chord event then.
				if (!eraser && !held) this.chord.down(e.timeStamp);
			}
		} else if (route === "navigate") {
			this.addNav(e);
			if (e.pointerType === "touch") this.armFingerHold(e);
			e.preventDefault();
		}
	}

	/** Starts a stroke for the contact `e`; false when the view refuses it. */
	private beginDraw(e: PointerEvent, eraser: boolean, held?: "lasso" | "previous" | "gesture"): boolean {
		if (e.pointerType === "pen") this.nav.clear();
		if (!this.handlers.drawStart(this.sample(e), eraser, held)) return false;
		this.drawId = e.pointerId;
		this.drawType = e.pointerType;
		this.rawSeen = false;
		this.lastT = e.timeStamp;
		this.lastX = e.clientX;
		this.lastY = e.clientY;
		this.drawLast = { x: e.clientX, y: e.clientY };
		this.drawDownT = e.timeStamp;
		this.capture(e.pointerId);
		e.preventDefault();
		return true;
	}

	/** The pen's button state in a pointer event (hover or contact): a new press opens the menu. */
	private trackBarrel(e: PointerEvent, kind: PointerKind): void {
		if (this.barrelPointer(kind, e)) {
			this.handlers.sideButtonSeen?.();
			// A pressure-0 press (Samsung) is judged when it ends (click) or when the nib touches (zpStep).
			if (!this.barrel.zeroPressureHeld) this.requestMenu(e.clientX, e.clientY, e.timeStamp);
		}
		if (e.pointerType === "pen") this.zpStep(e);
	}

	/** What the last event did to a pressure-0 side-button press: see `BarrelDetector.transition`. */
	private zpStep(e: PointerEvent): void {
		switch (this.barrel.transition) {
			case "contact-start": {
				// The nib touches while the button is held: the button's tool (eraser, lasso, previous tool), never ink.
				const tool = heldToolOf(this.policy.settings.penButton);
				if (!tool) return;
				if (this.drawId !== null) {
					if (this.drawType === "pen") return;
					this.cancelDraw();
				}
				this.rect = this.el.getBoundingClientRect();
				this.policy.setPenDown(true, e.timeStamp);
				if (!this.beginDraw(e, tool === "eraser", tool === "eraser" ? undefined : tool)) this.policy.setPenDown(false, e.timeStamp);
				return;
			}
			case "contact-end":
			case "release":
				this.finishPenStroke(e.timeStamp);
				return;
			case "release-click":
				if (!opensRadial(this.policy.settings.penButton)) return;
				this.rect = this.el.getBoundingClientRect();
				this.handlers.penMenu?.(e.clientX - this.rect.left, e.clientY - this.rect.top, "click");
				return;
			default:
		}
	}

	/** Ends the pen stroke in progress, keeping it (the nib left or the button state changed). */
	private finishPenStroke(t: number): void {
		if (this.drawId !== null && this.drawType === "pen") {
			this.releaseDraw();
			this.handlers.drawEnd(false);
			this.policy.setPenDown(false, t);
		}
	}

	/**
	 * Side button pressed while the nib touches (see `ChordDetector`). The stroke so far is committed as it is, never
	 * discarded; the contact then acts as the button's tool until the next such event or the lift.
	 */
	private chordStep(e: PointerEvent, strict: boolean): void {
		if (e.pointerType !== "pen" || !this.chord.move(e.button, e.buttons, e.pressure, e.timeStamp)) return;
		const s = this.policy.settings;
		if (s.chordButton === false || e.pointerId !== this.drawId || this.drawType !== "pen") return;
		const tool = heldToolOf(s.penButton);
		if (!tool && !opensRadial(s.penButton)) return;
		this.handlers.sideButtonSeen?.();
		// The samples this event brings still belong to the stroke that ends here.
		this.deliver(e, strict);
		this.finishPenStroke(e.timeStamp);
		this.policy.setPenDown(true, e.timeStamp);
		if (this.chordHeld) {
			this.chordHeld = false;
			this.beginDraw(e, false);
		} else if (tool) {
			this.chordHeld = true;
			if (this.beginDraw(e, tool === "eraser", tool === "eraser" ? undefined : tool)) this.drawHeld = true;
		} else {
			// Radial menu only: it takes over the contact (its lift is swallowed).
			this.policy.setPenDown(false, e.timeStamp);
			this.barrel.pointer("cancel", "pen", 0, 0, e.timeStamp);
			if (this.el.hasPointerCapture?.(e.pointerId)) {
				try {
					this.el.releasePointerCapture(e.pointerId);
				} catch {
					// The pointer is gone: nothing to release.
				}
			}
			this.rect = this.el.getBoundingClientRect();
			this.handlers.penMenu?.(e.clientX - this.rect.left, e.clientY - this.rect.top, "button");
		}
	}

	/** Feeds a pointer event to the side-button detector (with the pressure and the pointer id, and the zero-pressure setting). */
	private barrelPointer(kind: PointerKind, e: PointerEvent): boolean {
		this.barrel.zeroPressureEnabled = this.policy.settings.zeroPressureButton !== false;
		return this.barrel.pointer(kind, e.pointerType, e.button, e.buttons, e.timeStamp, e.pressure, e.pointerId);
	}

	/**
	 * Opens the radial menu at a client position if the side button is set to do that. While a stroke is in
	 * progress it only does so for a stroke that has just landed and not moved (the button was pressed after the
	 * nib touched): that stroke is discarded, so no dot remains. Never interrupts real writing.
	 */
	private requestMenu(clientX: number, clientY: number, t: number): boolean {
		if (!opensRadial(this.policy.settings.penButton)) return false;
		if (this.drawId !== null) {
			if (this.drawType !== "pen" || !strokeIsYoung(this.drawDownT, t, !this.hold.still)) return false;
			this.cancelDraw();
		}
		this.rect = this.el.getBoundingClientRect();
		this.handlers.penMenu?.(clientX - this.rect.left, clientY - this.rect.top, "button");
		return true;
	}

	/**
	 * 0.11.2: a `contextmenu` that no pointer on the view explains (no pen or finger down, no long finger contact just
	 * ended, no mouse button, no text field focused) is the side button clicked while the pen hovers: Obsidian's Android
	 * app drops stylus hover, and this event is the only trace of the click. A press already handled (pointer events, a
	 * pressure-0 press, a mouse-only press) is not repeated. True when it was taken.
	 */
	private buttonContextMenu(e: MouseEvent): boolean {
		const t = e.timeStamp;
		const raw = (e as Partial<PointerEvent>).pointerType;
		if (raw === "touch" || raw === "mouse") return false;
		// Device finding: the button pressed with the nib on the page (held when it landed, or pressed while writing).
		if (this.drawId !== null && this.drawType === "pen") {
			if (e.cancelable) e.preventDefault();
			this.contactButton(t);
			return true;
		}
		const focused = this.el.ownerDocument?.activeElement ?? null;
		const textFocused = isTextField(focused) || isTextEditing(e.target);
		if (this.hover.classify(raw ? raw : undefined, t, textFocused) !== "hover-click") return false;
		if (!this.barrel.claimClick(t)) return false;
		if (e.cancelable) e.preventDefault();
		this.handlers.sideButtonSeen?.();
		// Held, then touching: the contextmenu may come just before the pointerdown. Wait that long before acting.
		this.dropPendingClick();
		this.pendingClick = { t, x: e.clientX, y: e.clientY };
		this.pendingClickTimer = window.setTimeout(() => {
			this.pendingClickTimer = null;
			this.errors.run("hoverclick", () => this.firePendingClick());
		}, this.windows().beforeMs);
		return true;
	}

	private windows(): ButtonWindows {
		return this.policy.settings.buttonWindows ?? DEFAULT_BUTTON_WINDOWS;
	}

	private dropPendingClick(): void {
		if (this.pendingClickTimer !== null) window.clearTimeout(this.pendingClickTimer);
		this.pendingClickTimer = null;
		this.pendingClick = null;
	}

	/** A pen contact starts at `t`: was the button held when it landed (a pending bare contextmenu just before)? */
	private takePendingClick(t: number): boolean {
		const p = this.pendingClick;
		if (!p || !heldBeforeContact(p.t, t, this.windows())) return false;
		this.dropPendingClick();
		return true;
	}

	/** No contact followed the bare contextmenu: it was a click of the button while hovering. */
	private firePendingClick(): void {
		const p = this.pendingClick;
		this.pendingClick = null;
		if (!p) return;
		const s = this.policy.settings;
		const action = hoverClickAction({ eraserNext: s.eraserNextOnClick === true, opensMenu: opensRadial(s.penButton), off: !s.penButton || s.penButton === "off" });
		if (action === "eraser-next") this.eraserNextArm.toggle();
		else if (action === "menu") this.openClickMenu({ x: p.x, y: p.y });
	}

	/**
	 * A contextmenu during the pen contact (device finding): within `afterMs` of the landing, the button was held when the
	 * nib landed: the live ink of the contact is dropped (nothing committed) and its samples so far are replayed as the
	 * eraser. Later, the button was pressed while writing: the ink so far is kept and the rest of the contact erases. A nib
	 * that has rested still since it landed is a long-press, not the button. Lifting ends it; the tool never changed.
	 */
	private contactButton(t: number): void {
		const s = this.policy.settings;
		if (this.drawHeld || !s.penButton || s.penButton === "off") return;
		const verdict = contactVerdict(t - this.contactDownT, this.hold.still, this.windows());
		if (verdict === "none") return;
		this.handlers.sideButtonSeen?.();
		const tool = heldToolOf(s.penButton) ?? "eraser";
		const eraser = tool === "eraser";
		const held = eraser ? undefined : tool;
		this.clearHoldTimer();
		this.hold.end();
		this.chord.up();
		this.chordHeld = false;
		this.rect = this.el.getBoundingClientRect();
		const tr = this.trail;
		const replay = verdict === "held-at-contact" && this.trailOn && tr.count > 0;
		let start: InkSample;
		if (replay) {
			start = { x: tr.x[0]!, y: tr.y[0]!, pressure: tr.p[0]!, t: tr.t[0]!, pointerType: "pen" };
			this.handlers.drawEnd(true);
		} else {
			start = { x: this.lastX - this.rect.left, y: this.lastY - this.rect.top, pressure: this.lastP, t: Math.max(t, this.lastT), pointerType: "pen" };
			this.handlers.drawEnd(false);
		}
		this.trailOn = false;
		if (!this.handlers.drawStart(start, eraser, held)) {
			this.releaseDraw();
			this.policy.setPenDown(false, t);
			return;
		}
		this.drawHeld = true;
		if (replay && tr.count > 1) {
			const buf = this.samples;
			buf.clear("pen");
			for (let i = 1; i < tr.count; i++) buf.push(tr.x[i]!, tr.y[i]!, tr.p[i]!, tr.t[i]!);
			this.predicted.clear("pen");
			this.handlers.drawMove(buf, this.predicted);
		}
	}

	/** The radial menu for a click (hover click, pen key): at the event, the last pen position or the centre of the page area. */
	private openClickMenu(at: ClientPoint | null): void {
		if (this.drawId !== null) return;
		this.rect = this.el.getBoundingClientRect();
		const p = hoverMenuPosition(at, this.lastPenClient, this.rect);
		this.handlers.penMenu?.(p.x, p.y, "click");
	}

	/**
	 * 0.11.2: the button (`buttons & 2` or `button` 2) or the eraser (`buttons & 32` or `button` 5) appears while the nib
	 * writes an ordinary stroke: the ink so far is kept as it is, and the rest of the contact erases (or acts as the
	 * button's tool). Once per contact; never for a stroke that already erases or acts as the button's tool.
	 */
	private buttonStep(e: PointerEvent, strict: boolean): void {
		if (e.pointerType !== "pen" || e.pointerId !== this.drawId || this.drawType !== "pen" || this.drawHeld) return;
		const eraserBit = isEraserSignal(e.button, e.buttons);
		const barrelBit = !eraserBit && isBarrelSignal(e.button, e.buttons);
		if (!eraserBit && !barrelBit) return;
		const tool = eraserBit ? "eraser" : heldToolOf(this.policy.settings.penButton);
		if (!tool) return;
		if (barrelBit) this.handlers.sideButtonSeen?.();
		this.deliver(e, strict);
		this.finishPenStroke(e.timeStamp);
		this.policy.setPenDown(true, e.timeStamp);
		this.chord.up();
		this.chordHeld = false;
		if (this.beginDraw(e, tool === "eraser", tool === "eraser" ? undefined : tool)) this.drawHeld = true;
		else this.policy.setPenDown(false, e.timeStamp);
	}

	private onContextMenu(e: MouseEvent): void {
		e.preventDefault();
		if (this.buttonContextMenu(e)) return;
		if (this.barrel.contextMenu((e as Partial<PointerEvent>).pointerType, e.timeStamp)) {
			this.handlers.sideButtonSeen?.();
			this.requestMenu(e.clientX, e.clientY, e.timeStamp);
		}
	}

	private onAuxClick(e: MouseEvent): void {
		e.preventDefault();
		if (this.barrel.auxClick((e as Partial<PointerEvent>).pointerType, e.button, e.timeStamp)) {
			this.handlers.sideButtonSeen?.();
			this.requestMenu(e.clientX, e.clientY, e.timeStamp);
		}
	}

	/**
	 * Starts watching a pen stroke for stillness from its very first contact. With the hold-still fallback on, a
	 * pen that has not left a small radius for `HOLD_MS` opens the menu and the young stroke is discarded (no dot,
	 * nothing for undo). A stroke that has moved never becomes a hold: stillness is judged from the first contact only.
	 */
	private armHold(e: PointerEvent, eraser: boolean): void {
		this.hold.begin(e.clientX, e.clientY);
		this.clearHoldTimer();
		if (!this.penHoldAllowed(eraser)) return;
		const id = e.pointerId;
		this.holdTimer = window.setTimeout(() => {
			this.holdTimer = null;
			this.errors.run("hold", () => {
				if (this.drawId !== id || this.drawType !== "pen" || !this.hold.still || !this.penHoldAllowed(eraser)) return;
				const at = this.drawLast ?? { x: e.clientX, y: e.clientY };
				const t = Math.max(this.lastT, e.timeStamp);
				this.hold.end();
				this.cancelDraw();
				// The menu swallows the lift: the pen must not stay "down" for palm rejection or the side-button detector.
				this.policy.setPenDown(false, t);
				this.barrel.pointer("cancel", "pen", 0, 0, t);
				this.rect = this.el.getBoundingClientRect();
				this.handlers.penMenu?.(at.x - this.rect.left, at.y - this.rect.top, "pen-hold");
			});
		}, HOLD_MS);
	}

	private penHoldAllowed(eraser: boolean): boolean {
		const s = this.policy.settings;
		return penHoldMayStart({ enabled: s.penLongPress === true, radialAction: opensRadial(s.penButton), eraser });
	}

	/** A finger that landed alone, with the pen away and finger drawing off, may become a long-press after `FINGER_HOLD_MS`. */
	private armFingerHold(e: PointerEvent): void {
		const s = this.policy.settings;
		const may = fingerHoldMayStart({
			enabled: s.fingerLongPress === true,
			fingerDrawing: s.fingerDrawing,
			penNear: this.policy.penRecentlyActive(e.timeStamp),
			fingersDown: this.nav.size,
		});
		// A second finger (pinch, two-finger tap) ends the one in the making.
		if (this.nav.size > 1) this.cancelFingerHold();
		if (!may) return;
		this.cancelFingerHold();
		const id = e.pointerId;
		this.fingerHoldId = id;
		this.fingerHold.begin(e.clientX, e.clientY);
		this.fingerTimer = window.setTimeout(() => {
			this.fingerTimer = null;
			this.errors.run("fingerhold", () => {
				const p = this.nav.get(id);
				if (this.fingerHoldId !== id || !p || this.nav.size !== 1 || !this.fingerHold.still) return;
				this.cancelFingerHold();
				// The finger leaves the gesture bookkeeping: its lift is swallowed by the menu, and it is not a pan.
				this.nav.delete(id);
				this.panTrail = [];
				this.barrel.pointer("cancel", "touch", 0, 0, e.timeStamp);
				if (this.el.hasPointerCapture?.(id)) {
					try {
						this.el.releasePointerCapture(id);
					} catch {
						// The pointer is gone: nothing to release.
					}
				}
				this.rect = this.el.getBoundingClientRect();
				this.handlers.penMenu?.(p.x - this.rect.left, p.y - this.rect.top, "finger");
			});
		}, FINGER_HOLD_MS);
	}

	private cancelFingerHold(): void {
		if (this.fingerTimer !== null) window.clearTimeout(this.fingerTimer);
		this.fingerTimer = null;
		this.fingerHoldId = null;
		this.fingerHold.end();
	}

	private clearHoldTimer(): void {
		if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
		this.holdTimer = null;
	}

	private onRawUpdate(e: PointerEvent): void {
		if (e.pointerType === "pen") {
			this.trackBarrel(e, "move");
			this.buttonStep(e, false);
			this.chordStep(e, false);
		}
		if (e.pointerId !== this.drawId) return;
		this.rawSeen = true;
		this.deliver(e, false);
	}

	private onMove(e: PointerEvent): void {
		this.notePointer("move", e);
		if (e.pointerType === "pen") {
			this.policy.notePen(e.timeStamp);
			this.cancelFingerHold();
			this.trackBarrel(e, "move");
			this.buttonStep(e, this.rawSeen);
			this.chordStep(e, this.rawSeen);
		}

		if (e.pointerId === this.drawId) {
			// With pointerrawupdate these samples were already delivered and are skipped by timestamp.
			this.deliver(e, this.rawSeen);
			const last = this.drawLast;
			if (last) {
				last.x = e.clientX;
				last.y = e.clientY;
			}
			return;
		}

		const p = this.nav.get(e.pointerId);
		if (!p) return;
		if (e.pointerId === this.fingerHoldId) {
			this.fingerHold.move(e.clientX, e.clientY);
			if (!this.fingerHold.still) this.cancelFingerHold();
		}
		if (this.nav.size === 1) {
			const dx = e.clientX - p.x;
			const dy = e.clientY - p.y;
			this.handlers.pan(dx, dy);
			this.panTrail.push({ t: e.timeStamp, dx, dy });
			while (this.panTrail.length && e.timeStamp - this.panTrail[0]!.t > 80) this.panTrail.shift();
		} else if (this.nav.size === 2) {
			this.panTrail = [];
			const other = [...this.nav.entries()].find(([id]) => id !== e.pointerId)?.[1];
			if (other) {
				const before = Math.hypot(p.x - other.x, p.y - other.y);
				const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
				// The midpoint moves by half of this finger's movement.
				this.handlers.pan((e.clientX - p.x) / 2, (e.clientY - p.y) / 2);
				if (before > 0 && after > 0) {
					const mx = (e.clientX + other.x) / 2 - this.rect.left;
					const my = (e.clientY + other.y) / 2 - this.rect.top;
					this.handlers.zoom(after / before, mx, my);
				}
			}
		}
		p.x = e.clientX;
		p.y = e.clientY;
	}

	/** Passes the samples of `e` not delivered yet (and its predicted ones) to the handler. */
	private deliver(e: PointerEvent, strict: boolean): void {
		const buf = this.samples;
		buf.clear(e.pointerType);
		const left = this.rect.left, top = this.rect.top;
		const events = e.getCoalescedEvents?.();
		if (events && events.length > 0) {
			for (const ce of events) this.addSample(buf, ce, left, top, strict);
		} else {
			this.addSample(buf, e, left, top, strict);
		}
		const pred = this.predicted;
		pred.clear(e.pointerType);
		if (this.predictionEnabled) {
			const list = e.getPredictedEvents?.();
			if (list) for (const pe of list) pred.push(pe.clientX - left, pe.clientY - top, pe.pressure, pe.timeStamp);
		}
		if (buf.count === 0 && pred.count === 0) return;
		this.handlers.drawMove(buf, pred);
	}

	private addSample(buf: SampleBuffer, ce: PointerEvent, left: number, top: number, strict: boolean): void {
		const t = ce.timeStamp, x = ce.clientX, y = ce.clientY;
		this.hold.move(x, y);
		if (!isNewSample(this.lastT, this.lastX, this.lastY, t, x, y, strict)) return;
		this.lastT = t;
		this.lastX = x;
		this.lastY = y;
		this.lastP = ce.pressure;
		buf.push(x - left, y - top, ce.pressure, t);
		if (this.trailOn) {
			if (t - this.contactDownT <= this.windows().afterMs) this.trail.push(x - left, y - top, ce.pressure, t);
			else this.trailOn = false;
		}
	}

	/** Pointer up/cancel; if the handler throws, the stroke is still closed so the next one can start. */
	private guardedUp(e: PointerEvent): void {
		const ok = this.errors.run(e.type, () => this.onUp(e));
		if (!ok && e.pointerId === this.drawId) this.releaseDraw(e.pointerId);
	}

	private onUp(e: PointerEvent): void {
		if (e.type !== "lostpointercapture") {
			this.notePointer(e.type === "pointercancel" ? "cancel" : "up", e);
			this.barrelPointer(e.type === "pointercancel" ? "cancel" : "up", e);
			if (e.pointerType === "pen") {
				this.zpStep(e);
				this.chord.up();
				this.chordHeld = false;
			}
		}
		if (e.pointerType === "pen" && e.type !== "lostpointercapture") this.policy.setPenDown(false, e.timeStamp);
		if (e.pointerId === this.drawId) {
			this.releaseDraw(e.pointerId);
			this.handlers.drawEnd(false);
			return;
		}
		if (e.pointerId === this.fingerHoldId) this.cancelFingerHold();
		const wasSingle = this.nav.size === 1 && this.nav.has(e.pointerId);
		this.nav.delete(e.pointerId);
		if (wasSingle && e.type === "pointerup") this.startInertia(e.timeStamp);
		this.panTrail = [];
	}

	/** Continues a one-finger fling with exponentially decaying speed. */
	private startInertia(t: number): void {
		const trail = this.panTrail.filter((s) => t - s.t <= 80);
		if (trail.length < 2) return;
		const span = Math.max(16, t - trail[0]!.t);
		let vx = trail.reduce((a, s) => a + s.dx, 0) / span;
		let vy = trail.reduce((a, s) => a + s.dy, 0) / span;
		if (Math.hypot(vx, vy) < 0.3) return;
		let last = performance.now();
		const step = (now: number) => {
			const dt = Math.min(48, now - last);
			last = now;
			this.handlers.pan(vx * dt, vy * dt);
			const decay = Math.exp(-dt / 325);
			vx *= decay;
			vy *= decay;
			this.inertiaFrame = Math.hypot(vx, vy) > 0.02 ? window.requestAnimationFrame(step) : null;
		};
		this.inertiaFrame = window.requestAnimationFrame(step);
	}

	private stopInertia(): void {
		if (this.inertiaFrame !== null) window.cancelAnimationFrame(this.inertiaFrame);
		this.inertiaFrame = null;
	}

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		this.stopInertia();
		this.rect = this.el.getBoundingClientRect();
		const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.rect.height : 1;
		if (e.ctrlKey || e.metaKey) {
			this.handlers.zoom(Math.exp(-e.deltaY * scale * 0.002), e.clientX - this.rect.left, e.clientY - this.rect.top);
		} else {
			const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
			const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
			this.handlers.pan(-dx * scale, -dy * scale);
		}
	}

	private addNav(e: PointerEvent): void {
		this.nav.set(e.pointerId, { x: e.clientX, y: e.clientY });
		this.capture(e.pointerId);
	}

	private convertDrawToNav(): void {
		const id = this.drawId;
		const last = this.drawLast;
		this.cancelDraw();
		if (id !== null && last) this.nav.set(id, { ...last });
	}

	private cancelDraw(): void {
		this.releaseDraw();
		this.handlers.drawEnd(true);
	}

	private releaseDraw(id = this.drawId): void {
		this.clearHoldTimer();
		this.hold.end();
		this.drawHeld = false;
		this.drawId = null;
		this.drawType = "";
		this.drawLast = null;
		if (id !== null && this.el.hasPointerCapture?.(id)) {
			try {
				this.el.releasePointerCapture(id);
			} catch {
				// The pointer is gone: nothing to release.
			}
		}
	}

	private capture(id: number): void {
		try {
			this.el.setPointerCapture(id);
		} catch {
			// Some WebViews refuse capture for pointers that already ended.
		}
	}
}
