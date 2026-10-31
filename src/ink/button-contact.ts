/**
 * The pen's side button as one decision per pen contact (0.12.4): pure logic, no DOM and no `obsidian`.
 *
 * What the device showed (Samsung tablet, S Pen, Obsidian for Android): pressing the button with the pen in the air
 * sends nothing the page can see. The button shows only when the nib TOUCHES with it already held, and then only as
 * a trace around the contact: a bare `contextmenu` a little before or after the pen's `pointerdown`, or after its
 * lift, or a `pointerdown` / `pointermove` that carries the barrel bit (`button` 2, `buttons & 2`), or the
 * `pointercancel` the WebView sends right after a `contextmenu` (the contact then goes on as a new pointer).
 *
 * The behaviour is exactly two cases, whatever the form of the signal:
 *   1. the nib touches with the button held and lifts without moving (a tap, within `STILL_RADIUS_PX`): the radial menu;
 *   2. the nib touches with the button held and moves beyond that radius: the eraser (or the button's tool) for the
 *      WHOLE contact, from its first sample, with no ink.
 * Nothing else: a button pressed in the middle of an ordinary stroke (later than the after-window) keeps writing ink,
 * a resting nib's long-press is not the button, and no menu ever opens during or after a drag.
 */
import {
	DEFAULT_BUTTON_WINDOWS, NIB_LONG_PRESS_MS, STILL_RADIUS_PX, clampWindows, contactVerdict, formatDelta, hoverClickAction, type ButtonWindows,
} from "./pen-hover";

/** A bare `contextmenu` this soon after a pen contact lifted still belongs to it, ms. */
export const LATE_AFTER_LIFT_MS = 400;
/**
 * A bare `contextmenu` this soon after a contact that moved (or was already decided) lifted never opens the menu: past
 * `LATE_AFTER_LIFT_MS` it is no longer linked to that contact, but it is no click while hovering either. It may still be
 * the button held for the contact that lands next.
 */
export const QUIET_AFTER_LIFT_MS = 800;
/**
 * A rest of the nib that another feature claims (the long-press gesture rests 650 ms, the hold-still radial menu 700 ms).
 * Until then the rest has not been taken: a tap with a weak button signal is still a tap (the menu), a move still a drag.
 * Equal to `DWELL_MS` (checked in the tests).
 */
export const REST_CLAIM_MS = 650;
/** After a `pointercancel`, a pen landing farther than this from the last sample is a new contact, not the same one (CSS px). */
export const RESUME_RADIUS_PX = 2 * STILL_RADIUS_PX;
/** After a `pointercancel`, a pen landing within this long is the same contact going on, ms. */
export const RESUME_MS = 250;

/** What the button signal looked like (for the Pen button test). `dt`: ms from the pen's landing (negative: before). */
export interface ButtonSignal {
	kind: "contextmenu" | "pointerdown" | "pointermove" | "chord" | "pointercancel";
	dt?: number;
	buttons?: number;
}

export type IgnoreReason = "off" | "resting" | "mid-stroke" | "after-drag" | "no-contact" | "repeat";

/**
 * What opened the menu (0.12.5, for the Pen button test): `tap` (the nib touched with the button held and lifted without
 * moving), `late-tap` (the same, the `contextmenu` came after the lift), `hover` (a bare `contextmenu` and no pen contact
 * within the before-window: read as a click of the button while hovering).
 */
export type MenuVia = "tap" | "late-tap" | "hover";

/** What the contact became: waiting for the tap or the drag, the menu (tap), the eraser (drag), or nothing. */
export interface ButtonDecision {
	kind: "waiting" | "menu" | "eraser" | "eraser-next" | "ignored";
	reason?: IgnoreReason;
	via?: MenuVia;
	/** For `hover`: the before-window that elapsed without a pen contact, ms. */
	ms?: number;
}

/** What the caller does about a signal. */
export type ContactAction = "none" | "wait" | "eraser" | "menu" | "menu-late" | "eraser-late" | "ignore" | "unlinked" | "quiet";

/** `rested`: the nib rested on a weak signal and another feature has the rest; terminal, no later signal upgrades it. */
export type ButtonState = "ink" | "pending" | "eraser" | "menu" | "rested";

/**
 * Does a `pointerdown` carry the side button with the nib touching (pressure above 0)? A press with pressure 0 is the
 * button pressed while hovering (Samsung's zero-pressure press, handled elsewhere), not a contact.
 */
export function barrelAtContact(button: number, buttons: number, pressure: number): boolean {
	return pressure > 0 && button !== 5 && (buttons & 32) === 0 && (button === 2 || (buttons & 2) !== 0);
}

/** The signal as one plain-English line, e.g. `contextmenu Δ=+40 ms`, `pointerdown buttons=3`. */
export function describeSignal(s: ButtonSignal): string {
	switch (s.kind) {
		case "contextmenu": return s.dt === undefined ? "contextmenu (no pen contact)" : `contextmenu Δ=${formatDelta(s.dt)}`;
		case "pointerdown": return `pointerdown buttons=${s.buttons ?? "?"}`;
		case "pointermove": return `pointermove buttons=${s.buttons ?? "?"} Δ=${formatDelta(s.dt ?? 0)}`;
		case "chord": return `pointermove button=0 Δ=${formatDelta(s.dt ?? 0)}`;
		default: return "pointercancel after contextmenu";
	}
}

/** The decision as one plain-English line, e.g. `menu (tap)`, `eraser (drag)`, `ignored: nib resting`. */
export function describeDecision(d: ButtonDecision): string {
	switch (d.kind) {
		case "waiting": return "waiting (tap: menu, drag: eraser)";
		case "menu":
			if (d.via === "hover") return `menu (hover click: no pen contact within ${Math.round(d.ms ?? 0)} ms of the contextmenu)`;
			return d.via === "late-tap" ? "menu (tap, contextmenu after the lift)" : "menu (tap)";
		case "eraser": return "eraser (drag)";
		case "eraser-next": return `eraser armed for the next stroke (hover click: no pen contact within ${Math.round(d.ms ?? 0)} ms of the contextmenu)`;
		default: return `ignored: ${IGNORE_TEXT[d.reason ?? "repeat"]}`;
	}
}
const IGNORE_TEXT: Record<IgnoreReason, string> = {
	off: "side button set to Nothing",
	resting: "nib resting (a long-press, not the button)",
	"mid-stroke": "pressed in the middle of a stroke",
	"after-drag": "arrived after a drag",
	"no-contact": "no pen contact",
	repeat: "same contact, already decided",
};

/**
 * Tracks the pen contact the side button may belong to, and decides what it does. Fed with the pen's pointer events and
 * with every button signal; the caller applies the returned actions (ink, eraser replay, menu).
 */
export class ButtonContact {
	/** The side button is not set to "Nothing". */
	enabled = true;
	/**
	 * A tap with the button opens the radial menu (the setting has one). Without it ("Erase while held", "Lasso while
	 * held", ...) there is nothing to wait for: a contact with the button held is the button's tool at once.
	 */
	menuAllowed = true;
	/**
	 * A rest of the nib is claimed by another feature (the hold-still radial menu, or the long-press gesture). Then a nib that
	 * rests for a long-press time on a weak button signal is a rest, not a drag with the button (see `restedOut`). Without such
	 * a feature the old rule stands: a slow move that leaves the radius late is still a drag.
	 */
	restClaimed = false;
	/** "Button click: next stroke erases" is on: a click while hovering arms the eraser instead of opening the menu. */
	eraserNextOnClick = false;
	state: ButtonState = "ink";
	/** The latest signal and decision, for the Pen button test. */
	signal: ButtonSignal | null = null;
	decision: ButtonDecision | null = null;

	private open = false;
	/**
	 * The button is known from the pen's own report (`pointerdown` / `pointermove` carrying the barrel bit), not only from a
	 * `contextmenu` around the contact. A `contextmenu` alone is weak: a nib that then rests for a long-press time was a
	 * long-press (the WebView's own `contextmenu`, or a stray one from the contact before), not the button.
	 */
	private strong = false;
	private downT = 0;
	private x0 = 0;
	private y0 = 0;
	private moved = false;
	/** The last sample of the contact (client px), to tell the same contact going on after a cancel from a new one. */
	private lastX = 0;
	private lastY = 0;
	private upT: number | null = null;
	/** A bare contextmenu with no contact yet, and when it came. */
	private beforeT: number | null = null;
	private orphan: { t: number; pending: boolean } | null = null;
	/** The contact that just went on after a `pointercancel` was still waiting (nothing erased yet): replay it from its first sample. */
	resumedFromPending = false;
	/** The latest `penDown` was the same contact going on after a `pointercancel`. */
	resumed = false;

	constructor(private readonly windows: () => ButtonWindows = () => DEFAULT_BUTTON_WINDOWS) {}

	private w(): ButtonWindows {
		return clampWindows(this.windows());
	}

	/** A contact is down. */
	get inContact(): boolean {
		return this.open;
	}

	/** The nib has stayed within `STILL_RADIUS_PX` of where it landed. */
	get still(): boolean {
		return !this.moved;
	}

	/** When the contact landed (also the start of a contact that went on after a `pointercancel`). */
	get landedAt(): number {
		return this.downT;
	}

	get pending(): boolean {
		return this.state === "pending";
	}

	/**
	 * How long before a pen landing a bare contextmenu still belongs to it, ms: also how long a bare contextmenu waits for a
	 * pen contact to follow before it counts as a click while hovering. The setting "Button before contact".
	 */
	linkBeforeMs(): number {
		return this.w().beforeMs;
	}

	reset(): void {
		this.open = false;
		this.upT = null;
		this.moved = false;
		this.state = "ink";
		this.signal = null;
		this.decision = null;
		this.beforeT = null;
		this.orphan = null;
	}

	private set(state: ButtonState, decision: ButtonDecision): void {
		this.state = state;
		this.decision = decision;
	}

	private ignore(reason: IgnoreReason): ContactAction {
		this.decision = { kind: "ignored", reason };
		return "ignore";
	}

	/** A bare `contextmenu` with no pen contact: waits `linkBeforeMs()` for one to land. */
	contextMenuNoContact(t: number): void {
		this.beforeT = t;
		this.signal = { kind: "contextmenu" };
		this.decision = this.enabled ? { kind: "waiting" } : { kind: "ignored", reason: "off" };
	}

	/** The wait is over with no contact: it was a click while hovering. */
	hoverFired(): void {
		this.beforeT = null;
		const ms = this.linkBeforeMs();
		const action = hoverClickAction({ eraserNext: this.eraserNextOnClick, opensMenu: this.menuAllowed, off: !this.enabled });
		this.decision = action === "menu" ? { kind: "menu", via: "hover", ms } : action === "eraser-next" ? { kind: "eraser-next", ms } : { kind: "ignored", reason: "no-contact" };
	}

	/** When the bare `contextmenu` that still waits for a pen contact came, or null. */
	get hoverWaitingSince(): number | null {
		return this.beforeT;
	}

	/** The before-window has run out at `t` with no pen contact: it was a click while hovering. True when that was just decided. */
	settleHover(t: number): boolean {
		if (this.beforeT === null || t - this.beforeT <= this.linkBeforeMs()) return false;
		this.hoverFired();
		return true;
	}

	/**
	 * The pen lands. `barrel`: the `buttons` value when the `pointerdown` itself carries the side button (with pressure),
	 * else null. Returns the state of the contact: `pending` (button held: tap or drag decides), `eraser` (a contact that
	 * went on after a `pointercancel` and had already moved), or `ink`.
	 */
	penDown(t: number, x: number, y: number, barrel: number | null): ButtonState {
		const resume = this.orphan && t >= this.orphan.t && t - this.orphan.t <= RESUME_MS
			&& Math.hypot(x - this.lastX, y - this.lastY) <= RESUME_RADIUS_PX ? this.orphan : null;
		this.orphan = null;
		this.resumedFromPending = resume?.pending === true;
		this.resumed = resume !== null;
		const before = this.beforeT;
		this.beforeT = null;
		if (resume) {
			this.open = true;
			this.upT = null;
			this.lastX = x;
			this.lastY = y;
			if (Math.hypot(x - this.x0, y - this.y0) > STILL_RADIUS_PX) this.moved = true;
			if (resume.pending && !this.moved) this.set("pending", { kind: "waiting" });
			else this.set("eraser", { kind: "eraser" });
			this.signal = { kind: "pointercancel" };
			return this.state;
		}
		this.open = true;
		this.upT = null;
		this.strong = barrel !== null;
		this.downT = t;
		this.x0 = x;
		this.y0 = y;
		this.lastX = x;
		this.lastY = y;
		this.moved = false;
		this.state = "ink";
		this.signal = null;
		this.decision = null;
		if (!this.enabled) {
			if (barrel !== null || before !== null) this.ignore("off");
			return "ink";
		}
		const held = (): void => (this.menuAllowed ? this.set("pending", { kind: "waiting" }) : this.set("eraser", { kind: "eraser" }));
		if (barrel !== null) {
			this.signal = { kind: "pointerdown", buttons: barrel };
			held();
		} else if (before !== null && t - before >= 0 && t - before <= this.linkBeforeMs()) {
			this.signal = { kind: "contextmenu", dt: before - t };
			held();
		}
		return this.state;
	}

	/**
	 * The contact waits for tap or drag on a weak signal only, and the nib has rested still for a long-press time (the
	 * same rule as `contactVerdict`): it was a long-press of the nib, so the contact is ink after all. True when it was just decided.
	 */
	private restedOut(t: number): boolean {
		if (!this.restClaimed || this.state !== "pending" || this.strong || t - this.downT < REST_CLAIM_MS) return false;
		this.set("rested", { kind: "ignored", reason: "resting" });
		return true;
	}

	/** A sample of the contact. True when this move ended the wait: the button was held and the nib has left the radius (the eraser). */
	penMove(x: number, y: number, t?: number): boolean {
		if (this.open) {
			this.lastX = x;
			this.lastY = y;
		}
		if (!this.open || this.moved) return false;
		if (Math.hypot(x - this.x0, y - this.y0) <= STILL_RADIUS_PX) return false;
		this.moved = true;
		// A nib that rested for a long-press time before it moved is writing (or drawing a gesture), not dragging with the button.
		if (t !== undefined && this.restedOut(t)) return false;
		if (this.state !== "pending") return false;
		this.set("eraser", { kind: "eraser" });
		return true;
	}

	/** The nib lifts. `menu` when the button was held and the nib never moved (a tap). */
	penUp(t: number): ContactAction {
		if (!this.open) return "none";
		this.open = false;
		this.upT = t;
		if (this.restedOut(t)) return "none";
		if (this.state !== "pending") return "none";
		this.set("menu", { kind: "menu" });
		return "menu";
	}

	/**
	 * The WebView cancelled the contact (it does so after a `contextmenu` it handles itself). A contact that was waiting
	 * for tap or drag, or already erases, may go on as a new pointer within `RESUME_MS`: `orphan`. Otherwise `none`.
	 */
	penCancel(t: number): "orphan" | "none" {
		if (!this.open) return "none";
		this.open = false;
		this.upT = t;
		if (this.restedOut(t)) return "none";
		if (this.state !== "pending" && this.state !== "eraser") return "none";
		this.orphan = { t, pending: this.state === "pending" };
		return "orphan";
	}

	/** No pen came back after a cancel: a button contact that never moved was a tap (the pen is gone). */
	orphanExpired(): ContactAction {
		const o = this.orphan;
		this.orphan = null;
		if (!o?.pending || this.moved) return "none";
		this.set("menu", { kind: "menu" });
		return "menu";
	}

	get hasOrphan(): boolean {
		return this.orphan !== null;
	}

	/** Ms after which an orphan that nothing continued is settled. */
	get resumeMs(): number {
		return RESUME_MS;
	}

	/**
	 * A bare `contextmenu` while the pen touches. Within the after-window of the landing the button was held at contact
	 * (still nib: wait for tap or drag; a nib that already moved: the eraser from the first sample); a nib that has rested
	 * still for a long-press time is not the button; later, in the middle of a stroke: ink goes on.
	 */
	contextMenuDuring(t: number): ContactAction {
		const dt = t - this.downT;
		this.signal = { kind: "contextmenu", dt };
		if (!this.open) return "unlinked";
		if (!this.enabled) return this.ignore("off");
		if (this.state !== "ink") return "none";
		switch (contactVerdict(dt, !this.moved, this.w())) {
			case "none": return this.ignore("resting");
			case "during-stroke": return this.ignore("mid-stroke");
			default: return this.heldAtContact();
		}
	}

	/** A button bit in a `pointermove` (`kind` "pointermove": `buttons & 2`; "chord": the experimental `button 0` move). */
	buttonMove(kind: "pointermove" | "chord", t: number, buttons: number): ContactAction {
		const dt = t - this.downT;
		this.signal = { kind, dt, buttons };
		if (!this.open) return "unlinked";
		if (kind === "pointermove") this.strong = true;
		if (!this.enabled) return this.ignore("off");
		if (this.state !== "ink") return "none";
		if (dt > this.w().afterMs) return this.ignore("mid-stroke");
		return this.heldAtContact();
	}

	private heldAtContact(): ContactAction {
		if (this.moved || !this.menuAllowed) {
			this.set("eraser", { kind: "eraser" });
			return "eraser";
		}
		this.set("pending", { kind: "waiting" });
		return "wait";
	}

	/**
	 * A bare `contextmenu` after the contact lifted (its `pointerup` came first). Linked to it when it follows the lift
	 * closely: a tap that never moved is the menu, a short drag within the after-window is the eraser (the caller undoes
	 * the ink and replays it), anything else is ignored, never a menu. `unlinked` when it follows no contact: the caller
	 * decides (a click while hovering).
	 */
	contextMenuAfter(t: number): ContactAction {
		if (this.orphan !== null) return "none";
		if (this.open || this.upT === null) return "unlinked";
		const gap = t - this.upT;
		if (gap < 0) return "unlinked";
		if (gap > LATE_AFTER_LIFT_MS) return gap <= QUIET_AFTER_LIFT_MS && (this.moved || this.state !== "ink") ? "quiet" : "unlinked";
		const dt = t - this.downT;
		this.signal = { kind: "contextmenu", dt };
		if (!this.enabled) return this.ignore("off");
		if (this.state === "rested") return this.ignore("resting");
		if (this.state !== "ink") return this.ignore("repeat");
		if (!this.moved) {
			if (this.upT - this.downT >= NIB_LONG_PRESS_MS) return this.ignore("resting");
			if (this.menuAllowed) {
				this.set("menu", { kind: "menu", via: "late-tap" });
				return "menu-late";
			}
		}
		if (dt <= this.w().afterMs) {
			this.set("eraser", { kind: "eraser" });
			return "eraser-late";
		}
		return this.ignore("after-drag");
	}
}
