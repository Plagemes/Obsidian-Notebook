import { InputPolicy, heldToolOf, opensRadial } from "./input-policy";
import { ErrorOnce } from "./errors";
import {
	BarrelDetector, ChordDetector, FINGER_HOLD_MS, FINGER_HOLD_RADIUS_PX, HOLD_MS, StillHold, fingerHoldMayStart, penHoldMayStart, strokeIsYoung,
	type PointerKind,
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
	 * The view's root element (after 0.10.1). With it, the side-button detector also listens at window level in the
	 * capture phase: pen events over the view that never reach the element (they target the toolbar or another
	 * part of the view, or a handler above the element stopped them) and mouse-only presses still count. Events
	 * outside the scope (other views, modals, Obsidian's own UI) are ignored. Only the side button is detected
	 * there: strokes, panning and zooming come from the element's own listeners, as before.
	 */
	scope?: { contains(node: Node | null): boolean };
	/** Where the window-level listeners go (default: the element's window). For tests. */
	windowTarget?: EventTarget;
}

/** Event types the window-level side-button watch listens to (capture phase). */
const WINDOW_TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel", "contextmenu", "auxclick", "mousedown"] as const;
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

	constructor(
		private readonly el: HTMLElement,
		private readonly policy: InputPolicy,
		private readonly handlers: PointerHandlers,
		options: PointerControllerOptions = {},
	) {
		this.rect = el.getBoundingClientRect();
		// Handlers are guarded: an exception in one event must not leave a stroke half-open or stop the next ones.
		this.listen("pointerdown", (e) => this.errors.run("pointerdown", () => this.onDown(e)));
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
	private watchWindow(win: EventTarget, scope: { contains(node: Node | null): boolean }): void {
		for (const type of WINDOW_TYPES) {
			this.listen(type, (e: Event) => this.reached.add(e), { capture: true, passive: true });
		}
		const fn = (e: Event): void => {
			this.errors.run("window", () => this.onWindowEvent(e, scope));
		};
		for (const type of WINDOW_TYPES) {
			// contextmenu / auxclick of the pen button are prevented (no native menu over the view).
			const opts: AddEventListenerOptions = { capture: true, passive: type !== "contextmenu" && type !== "auxclick" };
			win.addEventListener(type, fn, opts);
			this.disposers.push(() => win.removeEventListener(type, fn, opts));
		}
		this.disposers.push(() => {
			if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
			this.pending = [];
		});
	}

	private onWindowEvent(e: Event, scope: { contains(node: Node | null): boolean }): void {
		const target = e.target as Node | null;
		if (!target || !scope.contains(target)) return;
		const pe = e as Partial<PointerEvent>;
		const kind = WINDOW_KIND[e.type];
		if (kind) this.barrel.noteAny(kind, pe.pointerType ?? "", e.timeStamp);
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

	destroy(): void {
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

	private onDown(e: PointerEvent): void {
		this.rect = this.el.getBoundingClientRect();
		this.stopInertia();
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
		let route = this.policy.route(asPen ? "pen" : e.pointerType, e.timeStamp, e.button, contact, e.buttons);
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
			const eraser = pen && this.policy.penErases(e.button, e.buttons);
			const held = (pen && this.policy.penHeld(e.button, e.buttons)) || undefined;
			if (!this.beginDraw(e, eraser, held)) return;
			if (pen) {
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
			this.beginDraw(e, tool === "eraser", tool === "eraser" ? undefined : tool);
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

	private onContextMenu(e: MouseEvent): void {
		e.preventDefault();
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
			this.chordStep(e, false);
		}
		if (e.pointerId !== this.drawId) return;
		this.rawSeen = true;
		this.deliver(e, false);
	}

	private onMove(e: PointerEvent): void {
		if (e.pointerType === "pen") {
			this.policy.notePen(e.timeStamp);
			this.cancelFingerHold();
			this.trackBarrel(e, "move");
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
		buf.push(x - left, y - top, ce.pressure, t);
	}

	/** Pointer up/cancel; if the handler throws, the stroke is still closed so the next one can start. */
	private guardedUp(e: PointerEvent): void {
		const ok = this.errors.run(e.type, () => this.onUp(e));
		if (!ok && e.pointerId === this.drawId) this.releaseDraw(e.pointerId);
	}

	private onUp(e: PointerEvent): void {
		if (e.type !== "lostpointercapture") {
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
