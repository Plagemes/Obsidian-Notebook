/**
 * Pen side (barrel) button detection: pure decision logic, no DOM and no `obsidian`.
 *
 * How the S Pen button reaches a web page is not verified on a device (see docs/research.md), so
 * every plausible signal is accepted and de-duplicated into "one press = one menu":
 *   - `pointerdown` of the pen with `button` 2 or `buttons & 2` (button held while the nib lands);
 *   - `pointermove` / `pointerrawupdate` of the pen where `buttons & 2` turns on (button pressed
 *     while hovering, or while touching);
 *   - a `contextmenu` event that comes from the pen (never from a touch long-press);
 *   - an `auxclick` with button 2 from the pen.
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

export type PointerKind = "down" | "move" | "up" | "cancel";

export class BarrelDetector {
	private penContact = false;
	private touches = 0;
	private lastPenT = -Infinity;
	private lastBarrelT = -Infinity;
	/** The side button is down (a press was reported and no release has been seen yet). */
	private held = false;
	/** A press was handled and its trailing `contextmenu` / `auxclick` are still expected. */
	private armed = false;
	private armedT = -Infinity;

	/** Is the button held (hover or contact) according to the last pointer events? */
	get isHeld(): boolean {
		return this.held;
	}

	reset(): void {
		this.penContact = false;
		this.touches = 0;
		this.held = false;
		this.armed = false;
	}

	/**
	 * A pointer event. Returns true when it starts a new press of the side button (the caller opens the
	 * menu), false for everything else: releases, repeated reports of the same press, the eraser, touch.
	 */
	pointer(kind: PointerKind, pointerType: string, button: number, buttons: number, t: number): boolean {
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
			if (kind === "down") this.penContact = true;
			else if (kind === "up" || kind === "cancel") this.penContact = false;
			// The up may never arrive (the radial menu swallows it): a move without the contact bit heals the state.
			else if ((buttons & 1) === 0) this.penContact = false;
		} else {
			return false;
		}

		if (kind === "up" || kind === "cancel") {
			this.held = false;
			return false;
		}
		// A move reports the state in `buttons`; `button` there is -1 or the button that changed (maybe released).
		const pressed = kind === "down" ? isBarrelSignal(button, buttons) : !isEraserSignal(button, buttons) && (buttons & BARREL_BUTTONS) !== 0;
		if (!pressed) {
			this.held = false;
			return false;
		}
		this.lastBarrelT = t;
		if (this.held) return false;
		this.held = true;
		this.armed = true;
		this.armedT = t;
		return true;
	}

	/**
	 * A `contextmenu` event. `pointerType` is the PointerEvent one when the browser sends a PointerEvent
	 * (undefined for a plain MouseEvent). True when it is a pen button press that was not handled yet.
	 */
	contextMenu(pointerType: string | undefined, t: number): boolean {
		if (!this.fromPen(pointerType, t, true)) return false;
		if (this.armed && t - this.armedT < 1500) return false;
		this.armed = true;
		this.armedT = t;
		return true;
	}

	/** An `auxclick`. True when it is a pen side-button click that was not handled yet. */
	auxClick(pointerType: string | undefined, button: number, t: number): boolean {
		if (button !== 2 || !this.fromPen(pointerType, t, false)) return false;
		if (this.armed) {
			// The click that closes a press already handled by its pointer events / contextmenu.
			this.armed = false;
			return false;
		}
		return true;
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

/** CSS px the pen may drift during a still hold. */
export const HOLD_RADIUS_PX = 6;
/** Default duration of the still-hold fallback, ms. */
export const HOLD_MS = 600;

/**
 * The still-hold fallback for pens whose button never reaches the page: holding the nib on the page
 * without moving for `HOLD_MS` opens the same menu. Only a hold that never left a small radius counts.
 */
export class StillHold {
	private ox = 0;
	private oy = 0;
	private moved = true;
	private active = false;

	begin(x: number, y: number): void {
		this.ox = x;
		this.oy = y;
		this.moved = false;
		this.active = true;
	}

	move(x: number, y: number): void {
		if (!this.active || this.moved) return;
		if (Math.hypot(x - this.ox, y - this.oy) > HOLD_RADIUS_PX) this.moved = true;
	}

	end(): void {
		this.active = false;
		this.moved = true;
	}

	/** The hold is armed and the pen has not left the radius. */
	get still(): boolean {
		return this.active && !this.moved;
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
}

/** Would the plugin treat this event as the side button (for the "Pen button test" log)? */
export function describeSideButton(f: PenEventFacts): "side-button" | "eraser" | "no" {
	const button = f.button ?? -1;
	const buttons = f.buttons ?? 0;
	const penLike = f.pointerType === "pen" || f.pointerType === "mouse" || f.pointerType === undefined || f.pointerType === "";
	if (f.kind.startsWith("pointer")) {
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
}

/** The log keeps this many lines. */
export const LOG_LINES = 30;

const fix = (n: number | undefined, d: number): string => (n === undefined || Number.isNaN(n) ? "-" : n.toFixed(d));

/** One plain-text line for an event. */
export function formatEvent(ev: LoggedEvent): string {
	const time = `${(ev.t / 1000).toFixed(3)}s`;
	if (ev.kind === "keydown" || ev.kind === "keyup") return `${time} ${ev.kind} key=${JSON.stringify(ev.key ?? "")} code=${ev.code ?? ""}`;
	const parts = [time, ev.kind, `type=${ev.pointerType || "-"}`];
	if (ev.button !== undefined) parts.push(`button=${ev.button}`);
	if (ev.buttons !== undefined) parts.push(`buttons=${ev.buttons}`);
	if (ev.pressure !== undefined) parts.push(`pressure=${fix(ev.pressure, 2)}`);
	if (ev.isPrimary !== undefined) parts.push(`primary=${ev.isPrimary}`);
	const verdict = describeSideButton(ev);
	parts.push(verdict === "side-button" ? "=> SIDE BUTTON" : verdict === "eraser" ? "=> eraser" : "=> -");
	return parts.join(" ");
}

/**
 * The last `LOG_LINES` events as lines. Repeated pointer moves with the same type, button, buttons and primary
 * flag fold into one line with a counter, so hovering does not push the interesting events out.
 */
export class EventLog {
	private lines: Array<{ key: string; text: string; count: number }> = [];
	/** Events that would be treated as the side button. */
	sideButtonCount = 0;

	constructor(private readonly max = LOG_LINES) {}

	add(ev: LoggedEvent): void {
		if (describeSideButton(ev) === "side-button") this.sideButtonCount++;
		const text = formatEvent(ev);
		const foldable = ev.kind === "pointermove" || ev.kind === "pointerrawupdate";
		const key = `${ev.kind}|${ev.pointerType}|${ev.button}|${ev.buttons}|${ev.isPrimary}`;
		const last = this.lines[this.lines.length - 1];
		if (foldable && last && last.key === key) {
			last.count++;
			last.text = text;
			return;
		}
		this.lines.push({ key, text, count: 1 });
		if (this.lines.length > this.max) this.lines.shift();
	}

	clear(): void {
		this.lines = [];
		this.sideButtonCount = 0;
	}

	get length(): number {
		return this.lines.length;
	}

	text(): string {
		return this.lines.map((l) => (l.count > 1 ? `${l.text} (x${l.count})` : l.text)).join("\n");
	}
}
