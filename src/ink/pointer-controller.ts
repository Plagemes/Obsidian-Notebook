import { InputPolicy, heldToolOf, opensRadial } from "./input-policy";
import {
	DEFAULT_BUTTON_WINDOWS, EraserNextArm, HoverClickTracker, clampWindows, hoverClickAction,
	hoverMenuPosition, isTextField, type ButtonWindows, type ClientPoint,
} from "./pen-hover";
import { ButtonContact, barrelAtContact, type ContactAction } from "./button-contact";
import { ErrorOnce } from "./errors";
import {
	BarrelDetector, ChordDetector, FINGER_HOLD_MS, FINGER_HOLD_RADIUS_PX, HOLD_MS, StillHold, fingerHoldMayStart, isBarrelSignal, isEraserSignal,
	penHoldMayStart, type PointerKind,
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
	/**
	 * `eraser`: the pen has its eraser button pressed or is flipped. Return false to reject the stroke. `continued`: the
	 * same contact goes on after its ink so far was committed (the side button pressed while writing): what that ink
	 * committed is kept as it is, so this part of the contact (eraser or held tool) never touches it.
	 */
	drawStart(sample: InkSample, eraser: boolean, held?: "lasso" | "previous" | "gesture", continued?: boolean): boolean;
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
	/**
	 * The side button turned out to be held at a contact that has already lifted (its `contextmenu` came after a short
	 * flick): drop the stroke that contact committed, as one undo step, so it can be replayed as the button's tool.
	 * False when that stroke cannot be dropped (nothing committed, or the history moved on): nothing is replayed then.
	 */
	retractStroke?(): boolean;
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
	/** Side button pressed during contact (chord event): one of the signals that the button was held at the landing. */
	private readonly chord = new ChordDetector();
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
	 * 0.12.4: the side button as one decision per pen contact (tap with the button: the radial menu; drag with it: the
	 * eraser for the whole contact; anything else: ink). See `button-contact.ts`.
	 */
	private readonly btn = new ButtonContact(() => this.windows());
	/** After a `pointercancel` of a button contact: waits for the same contact to go on as a new pointer. */
	private orphanTimer: number | null = null;
	/** Where the last pen contact landed (client px): where a tap with the button opens the menu. */
	private landing: ClientPoint = { x: 0, y: 0 };
	/**
	 * 0.11.2 (device finding): the side button shows only around a pen contact. The samples of the contact (to replay them
	 * as the eraser once the button is known: while it waits for tap or drag, and for the first `afterMs` otherwise), when it
	 * started, and the last pressure delivered.
	 */
	private readonly trail = new SampleBuffer(128);
	private trailOn = false;
	private contactDownT = -Infinity;
	private lastP = 0;
	/**
	 * The last pen contact that lifted: whether it was an ordinary stroke whose whole path is in `trail` (it can be
	 * replayed as the button's tool if the button's `contextmenu` comes late).
	 */
	private lastContact: { replayable: boolean } | null = null;
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
		this.clearOrphanTimer();
		this.btn.reset();
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

	/** `fromMove`: not a pointerdown but the first pen event of a button contact the WebView cancelled (see `resumeOrphan`). */
	private onDown(e: PointerEvent, fromMove = false): void {
		this.rect = this.el.getBoundingClientRect();
		this.stopInertia();
		this.notePointer("down", e);
		const pressed = this.barrelPointer("down", e);
		if (pressed) this.handlers.sideButtonSeen?.();
		// A pen near ends a finger long-press in the making (a second finger does too, in armFingerHold).
		if (e.pointerType === "pen") {
			this.cancelFingerHold();
			// A new contact: a late contextmenu can no longer be the button held at the previous one.
			this.lastContact = null;
		}
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
		// 0.12.4: the nib touches with the barrel bit set: the button was held at contact. Tap or drag decides (button-contact.ts),
		// so it is never the menu on contact, and never ink-or-eraser from the first sample.
		this.syncButton();
		const barrelAtDown = e.pointerType === "pen" && this.btn.enabled && barrelAtContact(e.button, e.buttons, e.pressure);
		if (barrelAtDown && route === "menu") route = "draw";
		if (fromMove) route = "draw";
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
			const eraserBit = pen && isEraserSignal(e.button, e.buttons);
			let eraser = pen && (eraserBit || (!barrelAtDown && this.policy.penErases(e.button, e.buttons, e.pressure)));
			let held = (pen && !eraser && !barrelAtDown && this.policy.penHeld(e.button, e.buttons)) || undefined;
			// 0.12.4: a bare contextmenu just before this contact, or the barrel bit on it: the button was held when the nib
			// landed. The tracker waits for tap (the menu) or drag (the eraser from the first sample) unless the setting has no menu.
			if (eraserBit) this.btn.reset(); // the flipped pen is the eraser on its own: no button contact is left over
			const hadOrphan = pen && this.btn.hasOrphan;
			const state = pen && !eraserBit ? this.btn.penDown(e.timeStamp, e.clientX, e.clientY, barrelAtDown ? e.buttons : null) : "ink";
			const resumed = pen && !eraserBit && this.btn.resumed;
			if (hadOrphan) this.clearOrphanTimer();
			if (pen && state !== "ink") this.dropPendingClick();
			const waiting = state === "pending";
			if (state === "eraser" && !eraser && !held) {
				const tool = heldToolOf(this.policy.settings.penButton) ?? "eraser";
				eraser = tool === "eraser";
				held = tool === "eraser" ? undefined : tool;
				this.handlers.sideButtonSeen?.();
			} else if (waiting) {
				this.handlers.sideButtonSeen?.();
			}
			// 0.11.2: "next stroke erases" (armed by a hover click or the pen key) takes the next ordinary pen stroke.
			const armed = pen && !eraser && !held && !waiting && this.eraserNextArm.armed;
			if (armed) eraser = true;
			const replay = resumed && state === "eraser" && this.btn.resumedFromPending && this.trail.count > 0;
			if (!this.beginDraw(e, eraser, held, false, replay ? this.trailStart() : undefined)) {
				if (pen) this.btn.reset();
				return;
			}
			if (armed) this.eraserNextArm.consume();
			if (pen) {
				this.drawHeld = eraser || !!held;
				if (!resumed) {
					this.landing = { x: e.clientX, y: e.clientY };
					this.contactDownT = e.timeStamp;
					this.trail.clear("pen");
				}
				this.lastP = e.pressure;
				this.trailOn = !this.drawHeld;
				if (this.trailOn) this.trail.push(e.clientX - this.rect.left, e.clientY - this.rect.top, e.pressure, e.timeStamp);
				if (replay) this.replayTrail(1, e);
				this.armHold(e, eraser);
				// A stroke started with the eraser end or the barrel bit already is the button's doing: no chord event then.
				if (!eraser && !held && !resumed) this.chord.down(e.timeStamp);
			}
		} else if (route === "navigate") {
			this.addNav(e);
			if (e.pointerType === "touch") this.armFingerHold(e);
			e.preventDefault();
		}
	}

	/** Starts a stroke for the contact `e`; false when the view refuses it. */
	private beginDraw(e: PointerEvent, eraser: boolean, held?: "lasso" | "previous" | "gesture", continued = false, start?: InkSample): boolean {
		if (e.pointerType === "pen") this.nav.clear();
		if (!this.handlers.drawStart(start ?? this.sample(e), eraser, held, continued)) return false;
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
				if (this.beginDraw(e, tool === "eraser", tool === "eraser" ? undefined : tool)) {
					// Already the button's tool: a contextmenu during (or right after) this contact changes nothing.
					this.drawHeld = true;
					this.trailOn = false;
				} else {
					this.policy.setPenDown(false, e.timeStamp);
				}
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
	 * Side button seen as a move with `button 0` while the nib touches (see `ChordDetector`). Since 0.12.4 it no longer
	 * switches a stroke in progress: within the after-window of the landing it is one more sign that the button was held
	 * at contact (tap: the menu, drag: the eraser from the first sample); later, in the middle of a stroke, ink goes on.
	 */
	private chordStep(e: PointerEvent): void {
		if (e.pointerType !== "pen" || !this.chord.move(e.button, e.buttons, e.pressure, e.timeStamp)) return;
		if (this.policy.settings.chordButton === false || e.pointerId !== this.drawId || this.drawType !== "pen" || this.drawHeld) return;
		this.syncButton();
		this.applyButtonAction(this.btn.buttonMove("chord", e.timeStamp, e.buttons));
	}

	/** Feeds a pointer event to the side-button detector (with the pressure and the pointer id, and the zero-pressure setting). */
	private barrelPointer(kind: PointerKind, e: PointerEvent): boolean {
		this.barrel.zeroPressureEnabled = this.policy.settings.zeroPressureButton !== false;
		return this.barrel.pointer(kind, e.pointerType, e.button, e.buttons, e.timeStamp, e.pressure, e.pointerId);
	}

	/**
	 * Opens the radial menu at a client position if the side button is set to do that (a press while hovering). Never
	 * while a stroke is in progress (0.12.4): a button signal during a pen contact is judged by `ButtonContact` (tap: the
	 * menu, drag: the eraser, mid-stroke: ink goes on).
	 */
	private requestMenu(clientX: number, clientY: number, _t: number): boolean {
		if (!opensRadial(this.policy.settings.penButton) || this.drawId !== null) return false;
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
		this.syncButton();
		if (this.drawId !== null && this.drawType === "pen") {
			if (e.cancelable) e.preventDefault();
			// A finger or palm on the page (or just lifted) explains it: a palm long-press while writing, never the
			// button. The stroke goes on as it is.
			if (this.hover.touchRecent(t)) return true;
			if (!this.drawHeld) this.applyButtonAction(this.btn.contextMenuDuring(t));
			return true;
		}
		const focused = this.el.ownerDocument?.activeElement ?? null;
		const textFocused = isTextField(focused) || isTextEditing(e.target);
		if (!textFocused && this.lateContactButton(e)) return true;
		if (this.hover.classify(raw ? raw : undefined, t, textFocused) !== "hover-click") return false;
		// A pen contact that lands within the before-window is the one this contextmenu belongs to (the button held at contact),
		// also when a press was handled a moment ago (two taps in a row): it is remembered before the dedupe below.
		this.btn.contextMenuNoContact(t);
		if (!this.barrel.claimClick(t)) return false;
		if (e.cancelable) e.preventDefault();
		this.handlers.sideButtonSeen?.();
		// Held, then touching: the contextmenu may come just before the pointerdown. Wait that long before acting.
		this.dropPendingClick();
		this.pendingClick = { t, x: e.clientX, y: e.clientY };
		this.pendingClickTimer = window.setTimeout(() => {
			this.pendingClickTimer = null;
			this.errors.run("hoverclick", () => this.firePendingClick());
		}, this.btn.linkBeforeMs());
		return true;
	}

	private windows(): ButtonWindows {
		return clampWindows(this.policy.settings.buttonWindows ?? DEFAULT_BUTTON_WINDOWS);
	}

	/**
	 * A bare contextmenu soon after a pen contact lifted (its `pointerup` came first). It belongs to that contact: a tap
	 * that never moved opens the menu (the dot it left is undone first), a short drag within the after-window is
	 * replayed as the button's tool (its stroke is undone, one undo step), anything later is ignored: no menu ever opens
	 * after a drag. A finger or palm on the page (or just lifted) leaves it at that. True when it was taken (and cancelled).
	 */
	private lateContactButton(e: MouseEvent): boolean {
		const t = e.timeStamp;
		if (this.drawId !== null) return false;
		if (this.btn.hasOrphan) {
			if (e.cancelable) e.preventDefault();
			return true;
		}
		const c = this.lastContact;
		// A pen-typed contextmenu is a hover click of a pen that passes hover (Windows): never the button of the last contact.
		if (!c || (e as Partial<PointerEvent>).pointerType === "pen" || this.hover.touchRecent(t)) return false;
		this.syncButton();
		const action = this.btn.contextMenuAfter(t);
		if (action === "unlinked") return false;
		if (e.cancelable) e.preventDefault();
		if (action === "quiet") {
			// Too late for that contact and no click while hovering either (it follows a drag): no menu. The button may be
			// held for the contact that lands next, so it is remembered for that.
			this.btn.contextMenuNoContact(t);
			return true;
		}
		if (action === "menu-late") {
			this.handlers.sideButtonSeen?.();
			this.handlers.retractStroke?.();
			this.openClickMenu({ ...this.landing });
			return true;
		}
		if (action !== "eraser-late") return true;
		this.handlers.sideButtonSeen?.();
		const tr = this.trail;
		if (!c.replayable || tr.count === 0 || !this.handlers.retractStroke?.()) return true;
		const tool = heldToolOf(this.policy.settings.penButton) ?? "eraser";
		const eraser = tool === "eraser";
		this.rect = this.el.getBoundingClientRect();
		if (!this.handlers.drawStart(this.trailStart(), eraser, eraser ? undefined : tool)) return true;
		if (tr.count > 1) this.replayTrail(1);
		this.handlers.drawEnd(false);
		return true;
	}

	/** Brings the controller's view of the side-button setting up to date (a menu to wait for, or none). */
	private syncButton(): void {
		const a = this.policy.settings.penButton;
		this.btn.enabled = !!a && a !== "off";
		this.btn.menuAllowed = opensRadial(a);
	}

	/** The first sample of the contact's trail, as the start of a stroke. */
	private trailStart(): InkSample {
		const tr = this.trail;
		return { x: tr.x[0]!, y: tr.y[0]!, pressure: tr.p[0]!, t: tr.t[0]!, pointerType: "pen" };
	}

	/** Delivers the trail from sample `from` on (and the sample of `e`, if given) as one move of the stroke in progress. */
	private replayTrail(from: number, e?: PointerEvent): void {
		const tr = this.trail;
		const buf = this.samples;
		buf.clear("pen");
		for (let i = from; i < tr.count; i++) buf.push(tr.x[i]!, tr.y[i]!, tr.p[i]!, tr.t[i]!);
		if (e) {
			const x = e.clientX - this.rect.left, y = e.clientY - this.rect.top;
			if (buf.count === 0 || buf.x[buf.count - 1] !== x || buf.y[buf.count - 1] !== y) buf.push(x, y, e.pressure, e.timeStamp);
		}
		if (buf.count === 0) return;
		this.predicted.clear("pen");
		this.handlers.drawMove(buf, this.predicted);
	}

	private dropPendingClick(): void {
		if (this.pendingClickTimer !== null) window.clearTimeout(this.pendingClickTimer);
		this.pendingClickTimer = null;
		this.pendingClick = null;
	}

	/** No contact followed the bare contextmenu: it was a click of the button while hovering. */
	private firePendingClick(): void {
		const p = this.pendingClick;
		this.pendingClick = null;
		if (!p) return;
		this.btn.hoverFired();
		const s = this.policy.settings;
		const action = hoverClickAction({ eraserNext: s.eraserNextOnClick === true, opensMenu: opensRadial(s.penButton), off: !s.penButton || s.penButton === "off" });
		if (action === "eraser-next") this.eraserNextArm.toggle();
		else if (action === "menu") this.openClickMenu({ x: p.x, y: p.y });
	}

	/**
	 * What a button signal during a pen contact decided (see `ButtonContact`): wait for tap or drag, or the whole contact is
	 * the button's tool from here (the ink so far is dropped, the contact replayed as the tool). Ignored signals change nothing.
	 */
	private applyButtonAction(action: ContactAction): void {
		if (action === "wait") this.handlers.sideButtonSeen?.();
		else if (action === "eraser") {
			this.handlers.sideButtonSeen?.();
			this.toButtonTool();
		}
	}

	/**
	 * The button was held at the landing and the nib has moved (or the setting has no menu): the whole contact is the
	 * button's tool, from its first sample. The live ink of the contact is dropped (nothing committed as ink, no undo
	 * step) and the trail is replayed as the tool; the contact goes on as that tool until the lift.
	 */
	private toButtonTool(): void {
		if (this.drawId === null || this.drawType !== "pen" || this.drawHeld) return;
		const s = this.policy.settings;
		const tool = heldToolOf(s.penButton) ?? "eraser";
		const eraser = tool === "eraser";
		const held = eraser ? undefined : tool;
		this.clearHoldTimer();
		this.hold.end();
		this.chord.up();
		this.rect = this.el.getBoundingClientRect();
		const tr = this.trail;
		const replay = this.trailOn && tr.count > 0;
		const start: InkSample = replay ? this.trailStart() : { x: this.lastX - this.rect.left, y: this.lastY - this.rect.top, pressure: this.lastP, t: this.lastT, pointerType: "pen" };
		this.handlers.drawEnd(true);
		this.trailOn = false;
		if (!this.handlers.drawStart(start, eraser, held, false)) {
			this.releaseDraw();
			this.policy.setPenDown(false, start.t);
			this.btn.reset();
			return;
		}
		this.drawHeld = true;
		if (replay && tr.count > 1) this.replayTrail(1);
	}

	/** The radial menu for a click (hover click, pen key): at the event, the last pen position or the centre of the page area. */
	private openClickMenu(at: ClientPoint | null): void {
		if (this.drawId !== null) return;
		this.rect = this.el.getBoundingClientRect();
		const p = hoverMenuPosition(at, this.lastPenClient, this.rect);
		this.handlers.penMenu?.(p.x, p.y, "click");
	}

	/**
	 * The eraser (`buttons & 32` or `button` 5: the flipped pen) appears while the nib writes an ordinary stroke: the ink so
	 * far is kept as it is, and the rest of the contact erases. The side button (`buttons & 2` or `button` 2) does not do that
	 * (0.12.4): within the after-window of the landing it means the button was held at contact (tap: the menu, drag: the
	 * eraser from the first sample); later, in the middle of a stroke, ink goes on.
	 */
	private buttonStep(e: PointerEvent, strict: boolean): void {
		if (e.pointerType !== "pen" || e.pointerId !== this.drawId || this.drawType !== "pen" || this.drawHeld) return;
		const eraserBit = isEraserSignal(e.button, e.buttons);
		if (!eraserBit) {
			if (isBarrelSignal(e.button, e.buttons)) {
				this.syncButton();
				this.applyButtonAction(this.btn.buttonMove("pointermove", e.timeStamp, e.buttons));
			}
			return;
		}
		this.deliver(e, strict);
		this.finishPenStroke(e.timeStamp);
		this.policy.setPenDown(true, e.timeStamp);
		this.chord.up();
		this.btn.reset();
		// The ink just committed stays: the rest of the contact never touches it.
		if (this.beginDraw(e, true, undefined, true)) this.drawHeld = true;
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
				this.btn.reset();
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
			this.chordStep(e);
		}
		if (e.pointerId !== this.drawId) return;
		this.rawSeen = true;
		this.deliver(e, false);
		this.afterMove();
	}

	private onMove(e: PointerEvent): void {
		this.notePointer("move", e);
		if (e.pointerType === "pen") {
			this.policy.notePen(e.timeStamp);
			this.cancelFingerHold();
			this.trackBarrel(e, "move");
			this.buttonStep(e, this.rawSeen);
			this.chordStep(e);
		}

		if (e.pointerId === this.drawId) {
			// With pointerrawupdate these samples were already delivered and are skipped by timestamp.
			this.deliver(e, this.rawSeen);
			const last = this.drawLast;
			if (last) {
				last.x = e.clientX;
				last.y = e.clientY;
			}
			this.afterMove();
			return;
		}
		// A button contact the WebView cancelled goes on with the next pen events of the same pointer (no new pointerdown).
		if (e.pointerType === "pen" && this.btn.hasOrphan && (e.buttons & 1) !== 0) {
			this.resumeOrphan(e);
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

	/** A button contact was cancelled: if nothing continues it soon, a contact that never moved was a tap. */
	private armOrphanTimer(): void {
		this.clearOrphanTimer();
		this.orphanTimer = window.setTimeout(() => {
			this.orphanTimer = null;
			this.errors.run("orphan", () => {
				if (this.btn.orphanExpired() === "menu") {
					this.handlers.sideButtonSeen?.();
					this.openClickMenu({ ...this.landing });
				}
			});
		}, this.btn.resumeMs + 30);
	}

	private clearOrphanTimer(): void {
		if (this.orphanTimer !== null) window.clearTimeout(this.orphanTimer);
		this.orphanTimer = null;
	}

	/** A button contact that waited for tap or drag and has now moved beyond the still radius: the whole contact is the tool. */
	private afterMove(): void {
		if (this.btn.state === "eraser" && this.btn.inContact && !this.drawHeld) this.toButtonTool();
	}

	/**
	 * The pen events of a contact the WebView cancelled go on as the same pointer, without a new `pointerdown`: treat the
	 * first one as the landing of the same contact (see `ButtonContact.penDown`).
	 */
	private resumeOrphan(e: PointerEvent): void {
		this.errors.run("pointerdown", () => this.onDown(e, true));
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
		// Asked before the move is judged: the sample that takes the nib out of the radius is part of the trail to replay.
		const waiting = this.btn.pending;
		if (this.drawType === "pen") this.btn.penMove(x, y);
		if (!isNewSample(this.lastT, this.lastX, this.lastY, t, x, y, strict)) return;
		this.lastT = t;
		this.lastX = x;
		this.lastY = y;
		this.lastP = ce.pressure;
		buf.push(x - left, y - top, ce.pressure, t);
		if (this.trailOn) {
			// While the button waits for tap or drag the whole contact is kept (it may all be replayed as the eraser).
			if (waiting || t - this.contactDownT <= this.windows().afterMs) this.trail.push(x - left, y - top, ce.pressure, t);
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
			}
		}
		if (e.pointerType === "pen" && e.type !== "lostpointercapture") this.policy.setPenDown(false, e.timeStamp);
		if (e.pointerId === this.drawId) {
			if (this.drawType === "pen" && e.type !== "lostpointercapture") {
				const wasPending = this.btn.pending;
				const wasHeld = this.drawHeld;
				if (e.type === "pointercancel") {
					if (this.btn.penCancel(e.timeStamp) === "orphan") {
						// The WebView cancelled a button contact (it does that after a contextmenu it handles itself): it may go on
						// as a new pointer. What was waiting for tap or drag drops its live ink; an eraser contact keeps its erasure.
						this.releaseDraw(e.pointerId);
						this.handlers.drawEnd(wasPending);
						this.lastContact = { replayable: false };
						this.armOrphanTimer();
						return;
					}
				} else if (this.btn.penUp(e.timeStamp) === "menu") {
					// Tap with the button held: no ink, the radial menu where the nib landed.
					this.releaseDraw(e.pointerId);
					this.handlers.drawEnd(true);
					// Its other trace (a second contextmenu just after the lift) belongs to this contact and is a repeat.
					this.lastContact = { replayable: false };
					this.openClickMenu({ ...this.landing });
					return;
				}
				// For a late contextmenu (the button held at this contact): an ordinary stroke whose whole path is in the trail.
				this.lastContact = { replayable: !wasHeld && this.trailOn };
			}
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
