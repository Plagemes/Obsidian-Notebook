/**
 * Pen side (barrel) button detection: pure decision logic, no DOM and no `obsidian`.
 *
 * How the S Pen button reaches a web page is not verified on a device (see docs/research.md), so
 * every plausible signal is accepted and de-duplicated into "one press = one menu":
 *   - `pointerdown` of the pen with `button` 2 or `buttons & 2` (button held while the nib lands);
 *   - `pointermove` / `pointerrawupdate` of the pen where `buttons & 2` turns on (button pressed
 *     while hovering, or while touching);
 *   - a `contextmenu` event that comes from the pen (never from a touch long-press);
 *   - an `auxclick` with button 2 from the pen;
 *   - Samsung / Chromium (reported on a Galaxy tablet): the button pressed while the pen HOVERS arrives as a
 *     primary press with no pressure: `pointerdown` with `button 0`, `buttons 1` and `pressure` exactly 0 (a
 *     real nib contact has pressure > 0). It is accepted only for a pointer that was hovering just before
 *     (events with `buttons 0` seen for the same `pointerId`), and can be switched off in the settings.
 *   - After 0.10.1: a `mousedown` that no pointer event announced (an "orphan": no `pointerdown` just before, no finger,
 *     not derived from touch) with `button` 0 or 2, while the pen hovers: in case the WebView delivers the button
 *     only as a mouse event. The view feeds this from window-level capture listeners (`PointerController`).
 * The eraser (`buttons & 32`, `button 5`) is never a barrel press.
 */

/** PointerEvent.buttons bit of the pen's side (barrel) button. */
export const BARREL_BUTTONS = 2;
/** PointerEvent.buttons bit of the pen's eraser button / flipped pen. */
export const ERASER_BUTTONS = 32;

/** The eraser bit or `button` 5: this event is the eraser, never the side button. */
export function isEraserSignal(button: number, buttons: number): boolean {
	return button === 5 || (buttons & ERASER_BUTTONS) !== 0;
}

/** A press of the side button is part of this `pointerdown`-like event (`button` 2, or bit 2 of `buttons`). */
export function isBarrelSignal(button: number, buttons: number): boolean {
	return !isEraserSignal(button, buttons) && (button === 2 || (buttons & BARREL_BUTTONS) !== 0);
}

/** How long after pen activity a plain `MouseEvent` (no `pointerType`) or a `mouse` pointer is still attributed to the pen. */
export const PEN_RECENT_MS = 700;
/** A barrel signal this recent makes a `contextmenu` during pen contact a button press and not a long-press. */
export const BARREL_RECENT_MS = 1000;
/** A `mousedown` this soon after any `pointerdown` is that pointer's compatibility mouse event, not a press of its own. */
export const COMPAT_MOUSE_MS = 500;
/** A `mousedown` this soon after any finger activity may be the finger's compatibility click: never the pen button. */
export const TOUCH_RECENT_MS = 1000;

export type PointerKind = "down" | "move" | "up" | "cancel";

export type ZeroPressureTransition = "none" | "press" | "contact-start" | "contact-end" | "release-click" | "release";

export class BarrelDetector {
	private penContact = false;
	private touches = 0;
	private lastPenT = -Infinity;
	private lastBarrelT = -Infinity;
	/** Last `pointerdown` of any pointer type (a compat `mousedown` follows it). */
	private lastDownT = -Infinity;
	/** Last pointer event of a finger. */
	private lastTouchT = -Infinity;
	/** The pointer that last reported `buttons 0` (hovering, or just lifted): a pressure-0 press is only believed after that. */
	private hoverId: number | null = null;
	/** A pressure-0 primary press is the side button (the setting; on by default). */
	zeroPressureEnabled = true;
	/** The press in progress (or the last one) came as a pressure-0 primary press, not as `buttons & 2`. */
	private zp = false;
	/**
	 * What the last event did to a pressure-0 press (Samsung): `press` (the button went down while hovering),
	 * `contact-start` / `contact-end` (the nib touches / leaves while the button stays down),
	 * `release-click` (the button came up and the nib never touched: a click), `release` (it came up after
	 * contact, or the pointer was cancelled), or `none`.
	 */
	transition: ZeroPressureTransition = "none";
	/** In a pressure-0 press: the nib is touching, and whether it touched at all. */
	private contact = false;
	private used = false;
	/** Time of the last event of a pressure-0 press. */
	private zpT = -Infinity;
	/** The side button is down (a press was reported and no release has been seen yet). */
	private held = false;
	/** A press was handled and its trailing `contextmenu` / `auxclick` are still expected. */
	private armed = false;
	private armedT = -Infinity;

	/** Is the button held (hover or contact) according to the last pointer events? */
	get isHeld(): boolean {
		return this.held;
	}

	/** The press just reported (or still held) is a pressure-0 primary press: never a stroke, even when the nib touches while it is held. */
	get zeroPressureHeld(): boolean {
		return this.held && this.zp;
	}

	reset(): void {
		this.penContact = false;
		this.touches = 0;
		this.held = false;
		this.zp = false;
		this.armed = false;
		this.hoverId = null;
		this.contact = false;
		this.used = false;
		this.transition = "none";
		this.lastDownT = -Infinity;
		this.lastTouchT = -Infinity;
	}

	/**
	 * Any pointer event seen at window level before it reaches its target (capture phase), also for pointers the
	 * detector is not fed: a `pointerdown` makes the next `mousedown` its compatibility event, a finger blocks
	 * mouse-only presses for a while.
	 */
	noteAny(kind: PointerKind, pointerType: string, t: number): void {
		if (kind === "down") this.lastDownT = Math.max(this.lastDownT, t);
		if (pointerType === "touch") this.lastTouchT = Math.max(this.lastTouchT, t);
	}

	/**
	 * A `mousedown` (window level). True when it is a pen side-button press that came ONLY as a mouse event: no
	 * `pointerdown` just before it (else it is that pointer's compatibility event), no finger on or near the page,
	 * not derived from touch (`sourceCapabilities.firesTouchEvents`), the pen seen hovering (not touching) just
	 * before, `button` 0 or 2, not the eraser, and no press already handled.
	 */
	mouseDown(button: number, buttons: number, t: number, firesTouchEvents = false): boolean {
		if (firesTouchEvents || (button !== 0 && button !== 2) || isEraserSignal(button, buttons)) return false;
		if (t - this.lastDownT < COMPAT_MOUSE_MS || this.touches > 0 || t - this.lastTouchT < TOUCH_RECENT_MS) return false;
		if (!this.penRecent(t) || this.penContact || this.held || this.nearZeroPress(t)) return false;
		if (this.armed && t - this.armedT < 1500) return false;
		this.lastBarrelT = t;
		this.armed = true;
		this.armedT = t;
		return true;
	}

	/**
	 * A pointer event. Returns true when it starts a new press of the side button (the caller opens the
	 * menu), false for everything else: releases, repeated reports of the same press, the eraser, touch.
	 */
	pointer(kind: PointerKind, pointerType: string, button: number, buttons: number, t: number, pressure?: number, pointerId?: number): boolean {
		this.noteAny(kind, pointerType, t);
		if (pointerType === "touch") {
			if (kind === "down") this.touches++;
			else if (kind === "up" || kind === "cancel") this.touches = Math.max(0, this.touches - 1);
			return false;
		}
		if (pointerType === "mouse") {
			// Some stacks may report the pen with the button held as a mouse: only while the pen was just seen.
			if (!this.penRecent(t) || !isBarrelSignal(button, buttons)) return false;
		} else if (pointerType === "pen") {
			this.lastPenT = t;
			if (buttons === 0 && pointerId !== undefined) this.hoverId = pointerId;
		} else {
			return false;
		}

		// Samsung: the side button pressed while hovering is a primary press with pressure exactly 0. A real
		// contact has pressure > 0, so a stroke that merely ends with pressure 0 is no press (the pen is in contact).
		let zeroPress = false;
		if (pointerType === "pen" && this.zeroPressureEnabled && kind !== "up" && kind !== "cancel" && pressure === 0 && (buttons & 1) !== 0) {
			const hovering = pointerId !== undefined && this.hoverId === pointerId;
			zeroPress = hovering && !isEraserSignal(button, buttons) && (kind === "down" ? button === 0 : !this.penContact);
		}
		if (pointerType === "pen") {
			if (kind === "down") this.penContact = !zeroPress && !(this.zp && this.held && (buttons & 1) !== 0);
			else if (kind === "up" || kind === "cancel") this.penContact = false;
			// The up may never arrive (the radial menu swallows it): a move without the contact bit heals the state.
			else if ((buttons & 1) === 0) this.penContact = false;
		}

		this.transition = "none";
		const wasZero = this.held && this.zp;
		if (wasZero) this.zpT = t;
		if (kind === "up" || kind === "cancel") {
			if (wasZero) this.transition = kind === "up" && !this.used ? "release-click" : "release";
			this.held = false;
			return false;
		}
		// While a pressure-0 press is held the nib may touch (pressure > 0, still `buttons & 1`): same press.
		const zeroContinues = pointerType === "pen" && wasZero && (buttons & 1) !== 0 && !isEraserSignal(button, buttons);
		// A move reports the state in `buttons`; `button` there is -1 or the button that changed (maybe released).
		const sideBit = kind === "down" ? isBarrelSignal(button, buttons) : !isEraserSignal(button, buttons) && (buttons & BARREL_BUTTONS) !== 0;
		const pressed = sideBit || zeroPress || zeroContinues;
		if (!pressed) {
			if (wasZero) this.transition = this.used ? "release" : "release-click";
			this.held = false;
			return false;
		}
		this.lastBarrelT = t;
		if (this.held) {
			if (wasZero) {
				// The nib touches (pressure > 0) or leaves again (pressure 0) while the button stays down.
				if (pressure !== undefined && pressure > 0 && !this.contact) {
					this.contact = true;
					this.used = true;
					this.transition = "contact-start";
				} else if (pressure === 0 && this.contact) {
					this.contact = false;
					this.transition = "contact-end";
				}
			}
			return false;
		}
		this.zp = zeroPress && !sideBit;
		this.held = true;
		this.armed = true;
		this.armedT = t;
		if (this.zp) {
			this.zpT = t;
			this.contact = false;
			this.used = false;
			this.transition = "press";
		}
		return true;
	}

	/**
	 * A `contextmenu` event. `pointerType` is the PointerEvent one when the browser sends a PointerEvent
	 * (undefined for a plain MouseEvent). True when it is a pen button press that was not handled yet.
	 */
	contextMenu(pointerType: string | undefined, t: number): boolean {
		if (this.nearZeroPress(t) || !this.fromPen(pointerType, t, true)) return false;
		if (this.armed && t - this.armedT < 1500) return false;
		this.armed = true;
		this.armedT = t;
		return true;
	}

	/** An `auxclick`. True when it is a pen side-button click that was not handled yet. */
	auxClick(pointerType: string | undefined, button: number, t: number): boolean {
		if (button !== 2 || this.nearZeroPress(t) || !this.fromPen(pointerType, t, false)) return false;
		if (this.armed) {
			// The click that closes a press already handled by its pointer events / contextmenu.
			this.armed = false;
			return false;
		}
		return true;
	}

	/** A pressure-0 press is down or just ended: its trailing contextmenu / auxclick are part of it. */
	private nearZeroPress(t: number): boolean {
		return (this.held && this.zp) || t - this.zpT < 1500;
	}

	private penRecent(t: number): boolean {
		return t - this.lastPenT < PEN_RECENT_MS;
	}

	/**
	 * Does a `contextmenu` / `auxclick` come from the pen's button? Never from touch (long-press). A pen
	 * long-press on the page also produces a contextmenu: while the pen touches the page that is only a
	 * button press if a barrel signal was seen just before.
	 */
	private fromPen(pointerType: string | undefined, t: number, isContextMenu: boolean): boolean {
		if (pointerType === "touch") return false;
		if (pointerType === "pen") {
			if (isContextMenu && this.penContact && t - this.lastBarrelT > BARREL_RECENT_MS) return false;
			return true;
		}
		if (pointerType === "mouse") return false;
		// A plain MouseEvent (or an empty pointerType): attributed by recent pen activity, never while a finger is down.
		if (this.touches > 0 || !this.penRecent(t)) return false;
		if (isContextMenu && this.penContact && t - this.lastBarrelT > BARREL_RECENT_MS) return false;
		return true;
	}

	/** Should a pointer event of type `pointerType` be routed as the pen (a `mouse` event with the button right after pen activity is)? */
	asPen(pointerType: string, button: number, buttons: number, t: number): boolean {
		return pointerType === "mouse" && this.penRecent(t) && isBarrelSignal(button, buttons);
	}
}

/** CSS px the pen may drift during a still hold (measured from the very first contact). */
export const HOLD_RADIUS_PX = 6;
/**
 * How long the pen must stay still from the first contact to open the menu, ms. Longer than a tap or a dot
 * (well under 300 ms) and than the pause before a slow, careful first stroke; short enough to feel deliberate.
 */
export const HOLD_MS = 700;
/** A finger must stay still this long to open the radial menu, ms (a pan or a two-finger tap starts earlier). */
export const FINGER_HOLD_MS = 500;
/** CSS px a finger may drift during a long-press (fingers are less steady than the nib). */
export const FINGER_HOLD_RADIUS_PX = 10;

/**
 * The still-hold fallback for devices whose side button never reaches the page: holding a contact on the page
 * without moving opens the radial menu. Only a hold that never left a small radius around the *first* contact
 * counts: once it has moved it never becomes a hold again, however still it gets afterwards.
 */
export class StillHold {
	private ox = 0;
	private oy = 0;
	private moved = true;
	private active = false;

	constructor(private readonly radius = HOLD_RADIUS_PX) {}

	begin(x: number, y: number): void {
		this.ox = x;
		this.oy = y;
		this.moved = false;
		this.active = true;
	}

	move(x: number, y: number): void {
		if (!this.active || this.moved) return;
		if (Math.hypot(x - this.ox, y - this.oy) > this.radius) this.moved = true;
	}

	end(): void {
		this.active = false;
		this.moved = true;
	}

	/** The hold is armed and the contact has not left the radius. */
	get still(): boolean {
		return this.active && !this.moved;
	}
}

/**
 * Does the pen hold-still fallback apply? `choice` is the user's explicit setting (null = never chosen): it always
 * wins. Without a choice it is on only while this device has never delivered a side-button signal; once one has
 * arrived the button works and resting the pen must not open anything.
 */
export function effectivePenHold(choice: boolean | null | undefined, sideButtonSeen: boolean): boolean {
	return typeof choice === "boolean" ? choice : !sideButtonSeen;
}

/** What decides whether a pen contact may become a hold-still menu. */
export interface PenHoldFacts {
	/** The effective hold-still setting. */
	enabled: boolean;
	/** The side-button action is the radial menu. */
	radialAction: boolean;
	/** The contact is the eraser (flipped pen / eraser button). */
	eraser: boolean;
}

export function penHoldMayStart(f: PenHoldFacts): boolean {
	return f.enabled && f.radialAction && !f.eraser;
}

/** What decides whether a finger contact may become a long-press menu. */
export interface FingerHoldFacts {
	enabled: boolean;
	/** Finger drawing is on: the finger writes, so a still finger is a dot or a pause, not a menu request. */
	fingerDrawing: boolean;
	/** The palm-rejection window says a pen is (or was just) near. */
	penNear: boolean;
	/** Fingers on the page including this one: a second finger means pinch or a two-finger tap. */
	fingersDown: number;
}

export function fingerHoldMayStart(f: FingerHoldFacts): boolean {
	return f.enabled && !f.fingerDrawing && !f.penNear && f.fingersDown === 1;
}

/** Does the test say "no side-button signal yet"? Not once the log or an earlier session saw one. */
export function noSignalYet(seenBefore: boolean, loggedSideButtonEvents: number): boolean {
	return !seenBefore && loggedSideButtonEvents === 0;
}

/** A chord event this soon after the nib landed is ignored (the pointerdown itself has `button 0`). */
export const CHORD_MIN_AFTER_DOWN_MS = 40;
/** Two chord events closer than this are one (`pointerrawupdate` and `pointermove` report the same change). */
export const CHORD_DEBOUNCE_MS = 120;

/**
 * Side button pressed WHILE the nib touches (reported on a Galaxy tablet, medium confidence): the browser sends a
 * dispatched `pointermove` / `pointerrawupdate` with `button 0` (a button changed) instead of the usual -1, while
 * `buttons` stays 1. Each such event toggles "side button held". Conservative on purpose: only events of the pen
 * in contact, never the pointerdown, only after an ordinary move (`button -1`) was seen in this contact, never the
 * eraser bits, never closer than the debounce to the previous toggle. A device whose moves all carry `button 0` never
 * toggles. Only the dispatched event is judged, never its coalesced or predicted ones.
 */
export class ChordDetector {
	private contact = false;
	private downT = -Infinity;
	private ordinary = false;
	private lastT = -Infinity;

	/** The nib landed (a real contact with pressure, not a pressure-0 hover press). */
	down(t: number): void {
		this.contact = true;
		this.downT = t;
		this.ordinary = false;
		this.lastT = -Infinity;
	}

	up(): void {
		this.contact = false;
	}

	get inContact(): boolean {
		return this.contact;
	}

	/** A dispatched pen move during the contact. True when it is a chord event (toggles the held state). */
	move(button: number, buttons: number, pressure: number | undefined, t: number): boolean {
		if (!this.contact || (buttons & 1) === 0 || isEraserSignal(button, buttons)) return false;
		if (button === -1) {
			this.ordinary = true;
			return false;
		}
		if (button !== 0 || !this.ordinary || t - this.downT < CHORD_MIN_AFTER_DOWN_MS) return false;
		if (pressure !== undefined && pressure <= 0) return false;
		if (t - this.lastT < CHORD_DEBOUNCE_MS) return false;
		this.lastT = t;
		return true;
	}
}

/** A stroke this young that did not move is the start of a button press that landed after the nib, not writing. */
export const YOUNG_STROKE_MS = 350;

/** Can a barrel press that arrives after the nib landed still cancel that (so far dot-like) stroke? */
export function strokeIsYoung(downT: number, t: number, moved: boolean): boolean {
	return !moved && t - downT <= YOUNG_STROKE_MS;
}

/** The facts the diagnostic shows about one event. */
export interface PenEventFacts {
	kind: string;
	pointerType?: string;
	button?: number;
	buttons?: number;
	pressure?: number;
	pointerId?: number;
}

/** Would the plugin treat this event as the side button (for the "Pen button test" log)? */
export function describeSideButton(f: PenEventFacts): "side-button" | "eraser" | "no" {
	const button = f.button ?? -1;
	const buttons = f.buttons ?? 0;
	const penLike = f.pointerType === "pen" || f.pointerType === "mouse" || f.pointerType === undefined || f.pointerType === "";
	if (f.kind.startsWith("pointer") || f.kind.endsWith("pointercapture")) {
		// Enter / leave / over / out and capture changes only repeat the state: they are never a press of their own.
		if (POINTER_KIND[f.kind] === undefined) return "no";
		if (f.pointerType !== "pen" && f.pointerType !== "mouse") return "no";
		if (isEraserSignal(button, buttons)) return "eraser";
		const up = f.kind === "pointerup" || f.kind === "pointercancel";
		const pressed = f.kind === "pointerdown" ? isBarrelSignal(button, buttons) : !up && (buttons & BARREL_BUTTONS) !== 0;
		return pressed && (f.pointerType === "pen" || button === 2 || (buttons & BARREL_BUTTONS) !== 0) ? "side-button" : "no";
	}
	if (f.kind === "contextmenu") return f.pointerType === "touch" || f.pointerType === "mouse" ? "no" : "side-button";
	if (f.kind === "auxclick") return penLike && button === 2 && f.pointerType !== "mouse" ? "side-button" : "no";
	return "no";
}

/** One event as the "Pen button test" shows it. */
export interface LoggedEvent extends PenEventFacts {
	/** Milliseconds since the test started. */
	t: number;
	pressure?: number;
	isPrimary?: boolean;
	key?: string;
	code?: string;
	/** The event's own `timeStamp`, ms. */
	timeStamp?: number;
	/** A short name of the element the event was dispatched to (`div.notebook-pentest-area`, `window`, ...). */
	target?: string;
	/** `MouseEvent.sourceCapabilities.firesTouchEvents` (Chromium): the mouse event was derived from touch. */
	fromTouch?: boolean;
	/** Set by the log: what the event means for a pressure-0 side-button press (see `ZeroPressureTransition`). */
	note?: string;
}

const POINTER_KIND: Record<string, PointerKind | undefined> = {
	pointerdown: "down", pointermove: "move", pointerrawupdate: "move", pointerup: "up", pointercancel: "cancel",
};

/**
 * Every event type the "Pen button test" records, at window level in the capture phase, whatever element it is
 * dispatched to (S Pen fix after 0.10.1). Types a browser never fires are harmless. `selectionchange` is listened on the document.
 */
export const PEN_TEST_EVENT_TYPES: readonly string[] = [
	"pointerover", "pointerenter", "pointerdown", "pointermove", "pointerrawupdate", "pointerup", "pointercancel", "pointerout", "pointerleave",
	"gotpointercapture", "lostpointercapture",
	"mouseover", "mouseenter", "mousedown", "mousemove", "mouseup", "mouseout", "mouseleave", "click", "dblclick", "auxclick", "contextmenu",
	"touchstart", "touchmove", "touchend", "touchcancel",
	"selectstart", "dragstart",
	"keydown", "keyup",
];

/** A short name for an event target: `window`, `document`, `div.notebook-pentest-area`, ... (`(area)` inside the test area). */
export function describeTarget(target: EventTarget | null, area: { contains(n: Node | null): boolean } | null, win: unknown, doc: unknown): string {
	if (!target) return "-";
	if (target === win) return "window";
	if (target === doc) return "document";
	const el = target as Partial<Element>;
	if (typeof el.tagName !== "string") return "?";
	const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
	const name = cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
	return area?.contains(target as Node) ? `${name}(area)` : name;
}

/** Kinds that repeat while the pen merely moves or crosses elements: they fold into one line with a counter. */
const FOLDABLE = new Set([
	"pointermove", "pointerrawupdate", "pointerover", "pointerout", "pointerenter", "pointerleave",
	"mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave", "touchmove", "selectionchange",
]);
/** How many trailing lines a repeated event may fold into (moves of pointer, mouse and rawupdate interleave). */
const FOLD_LOOKBACK = 8;

/** The log keeps this many lines. */
export const LOG_LINES = 80;

const fix = (n: number | undefined, d: number): string => (n === undefined || Number.isNaN(n) ? "-" : n.toFixed(d));

/** One plain-text line for an event. */
export function formatEvent(ev: LoggedEvent): string {
	const time = `${(ev.t / 1000).toFixed(3)}s`;
	if (ev.kind === "keydown" || ev.kind === "keyup") return `${time} ${ev.kind} key=${JSON.stringify(ev.key ?? "")} code=${ev.code ?? ""}`;
	const parts = [time, ev.kind, `type=${ev.pointerType || "-"}`];
	if (ev.pointerId !== undefined) parts.push(`id=${ev.pointerId}`);
	if (ev.button !== undefined) parts.push(`button=${ev.button}`);
	if (ev.buttons !== undefined) parts.push(`buttons=${ev.buttons}`);
	if (ev.pressure !== undefined) parts.push(`pressure=${fix(ev.pressure, 2)}`);
	if (ev.isPrimary !== undefined) parts.push(`primary=${ev.isPrimary}`);
	if (ev.fromTouch) parts.push("fromTouch");
	if (ev.target) parts.push(`@${ev.target}`);
	if (ev.timeStamp !== undefined) parts.push(`ts=${fix(ev.timeStamp, 1)}`);
	const verdict = describeSideButton(ev);
	parts.push(ev.note ? `=> ${ev.note}` : verdict === "side-button" ? "=> SIDE BUTTON" : verdict === "eraser" ? "=> eraser" : "=> -");
	return parts.join(" ");
}

/**
 * The last `LOG_LINES` events as lines. Repeated moves (and enter / leave / over / out) with the same type,
 * button, buttons and primary flag fold into one line with a counter, so hovering does not push the
 * interesting events out; a count per event type is kept for the whole test.
 */
export class EventLog {
	private lines: Array<{ key: string; text: string; count: number; noted: boolean; foldable: boolean }> = [];
	/** Events that would be treated as the side button. */
	sideButtonCount = 0;
	/** Events of every type since the test started (or was cleared). */
	readonly counts = new Map<string, number>();
	total = 0;

	constructor(private readonly max = LOG_LINES) {}

	/** The plugin's own detector, so the log says exactly what the plugin would do with the events. */
	private readonly detector = new BarrelDetector();
	private readonly chord = new ChordDetector();

	add(logged: LoggedEvent): void {
		const ev: LoggedEvent = { ...logged };
		this.total++;
		this.counts.set(ev.kind, (this.counts.get(ev.kind) ?? 0) + 1);
		const kind = POINTER_KIND[ev.kind];
		let zero = false;
		let mouseOnly = false;
		if (kind && ev.pointerType) {
			const press = this.detector.pointer(kind, ev.pointerType, ev.button ?? -1, ev.buttons ?? 0, ev.t, ev.pressure, ev.pointerId);
			const tr = ev.pointerType === "pen" ? this.detector.transition : "none";
			if (press && tr === "press") {
				zero = true;
				ev.note = "SIDE BUTTON (pressure 0 primary press)";
			} else if (tr === "contact-start") {
				ev.note = "nib touches while the button is held (erases)";
			} else if (tr === "contact-end") {
				ev.note = "nib lifted, button still held";
			} else if (tr === "release-click") {
				ev.note = "button released without contact (click: opens the menu)";
			} else if (tr === "release") {
				ev.note = "button released";
			}
		} else if (ev.kind === "mousedown" && this.detector.mouseDown(ev.button ?? 0, ev.buttons ?? 0, ev.t, ev.fromTouch === true)) {
			mouseOnly = true;
			ev.note = "SIDE BUTTON? (mousedown with no pointerdown, pen hovering)";
		}
		if (ev.pointerType === "pen") {
			if (ev.kind === "pointerdown" && ev.pressure !== 0 && !zero) this.chord.down(ev.t);
			else if (ev.kind === "pointerup" || ev.kind === "pointercancel") this.chord.up();
			else if ((ev.kind === "pointermove" || ev.kind === "pointerrawupdate") && this.chord.move(ev.button ?? -1, ev.buttons ?? 0, ev.pressure, ev.t)) {
				ev.note = "pointermove with button 0 during contact (possible side button)";
			}
		}
		const verdict = describeSideButton(ev);
		if (zero || mouseOnly || verdict === "side-button") this.sideButtonCount++;
		const text = formatEvent(ev);
		// A line with a note (what the plugin made of the event) is never folded into or over.
		const foldable = FOLDABLE.has(ev.kind) && !ev.note;
		const key = `${ev.kind}|${ev.pointerType}|${ev.button}|${ev.buttons}|${ev.isPrimary}`;
		if (foldable) {
			// Fold into the newest matching line among the trailing foldable ones (pointermove, mousemove and
			// pointerrawupdate of one hover interleave).
			for (let i = this.lines.length - 1; i >= 0 && i >= this.lines.length - FOLD_LOOKBACK; i--) {
				const line = this.lines[i]!;
				if (line.noted || !line.foldable) break;
				if (line.key === key) {
					line.count++;
					line.text = text;
					return;
				}
			}
		}
		this.lines.push({ key, text, count: 1, noted: !!ev.note, foldable });
		if (this.lines.length > this.max) this.lines.shift();
	}

	clear(): void {
		this.lines = [];
		this.sideButtonCount = 0;
		this.counts.clear();
		this.total = 0;
		this.detector.reset();
		this.chord.up();
	}

	get length(): number {
		return this.lines.length;
	}

	text(): string {
		return this.lines.map((l) => (l.count > 1 ? `${l.text} (x${l.count})` : l.text)).join("\n");
	}

	/** "pointermove 120, pointerdown 2, ...": how many events of each type arrived, most frequent first. */
	countsText(): string {
		return [...this.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", ");
	}
}
