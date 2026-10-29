import type { TapGestureMode } from "./gesture-settings";

/** What a finished multi-finger tap asks for. */
export type TapAction = "undo" | "redo";

export interface FingerTapOptions {
	/** A finger that moves farther than this (CSS px) from where it landed makes the contact a pan or pinch, not a tap. */
	maxMovePx: number;
	/** All fingers must land within this time (ms) of the first one. */
	landingMs: number;
	/** ...and lift within this time (ms) of the first one to lift. */
	liftMs: number;
	/** From the first landing to the last lift. */
	maxDurationMs: number;
}

export const DEFAULT_TAP_OPTIONS: FingerTapOptions = { maxMovePx: 12, landingMs: 150, liftMs: 150, maxDurationMs: 350 };

/** A series with no event for this long (ms) is forgotten. */
const STALE_MS = 3000;

/** The action of a tap with `fingers` fingers under `mode`, or null. */
export function tapActionFor(fingers: number, mode: TapGestureMode): TapAction | null {
	if (mode === "off") return null;
	if (fingers === 2) return mode === "undo-redo" ? "undo" : "redo";
	if (fingers === 3) return mode === "undo-redo" ? "redo" : "undo";
	return null;
}

interface Contact {
	x: number;
	y: number;
}

/**
 * Recognises a multi-finger tap from the touch contacts: 2 or 3 fingers that land together, hardly
 * move and lift together within a short time. Anything that moves, lands late, lifts late or is
 * interrupted (a pen, a cancelled pointer, a finger added afterwards) is not a tap, so a two-finger
 * pan or pinch never triggers it. It only observes: it knows nothing about the view.
 */
export class FingerTapDetector {
	private readonly contacts = new Map<number, Contact>();
	private total = 0;
	private lifted = 0;
	private valid = false;
	private firstDown = 0;
	private firstUp = 0;
	private lastT = -Infinity;

	constructor(private readonly options: FingerTapOptions = DEFAULT_TAP_OPTIONS) {}

	/** Fingers on the screen that belong to the current series of contacts. */
	get active(): number {
		return this.contacts.size;
	}

	/** Contacts landed in this series so far (including lifted ones). */
	get landed(): number {
		return this.total;
	}

	/** A finger landed. Returns true when it started a new series (no other finger was down). */
	down(id: number, x: number, y: number, t: number): boolean {
		// A contact that never reported its end (lost pointer) must not block the next taps for ever.
		if (this.total > 0 && t - this.lastT > STALE_MS) this.reset();
		this.lastT = t;
		if (this.contacts.has(id)) return false;
		const fresh = this.total === 0;
		if (fresh) {
			this.valid = true;
			this.firstDown = t;
			this.lifted = 0;
		} else if (this.lifted > 0 || t - this.firstDown > this.options.landingMs) {
			// A finger added after others lifted, or too late to belong to the same tap.
			this.valid = false;
		}
		this.contacts.set(id, { x, y });
		this.total++;
		return fresh;
	}

	move(id: number, x: number, y: number): void {
		const c = this.contacts.get(id);
		if (!c || !this.valid) return;
		if (Math.hypot(x - c.x, y - c.y) > this.options.maxMovePx) this.valid = false;
	}

	/** Anything that is not a finger (the pen touched down): the series cannot be a tap. */
	interrupt(): void {
		this.valid = false;
	}

	/** A finger lifted. Returns the number of fingers of the tap when this was its last lift, else 0. */
	up(id: number, t: number, cancelled = false): number {
		if (!this.contacts.delete(id)) return 0;
		this.lastT = t;
		if (cancelled) this.valid = false;
		if (this.lifted === 0) this.firstUp = t;
		this.lifted++;
		if (this.contacts.size > 0) {
			if (t - this.firstUp > this.options.liftMs || t - this.firstDown > this.options.maxDurationMs) this.valid = false;
			return 0;
		}
		const ok = this.valid && t - this.firstUp <= this.options.liftMs && t - this.firstDown <= this.options.maxDurationMs;
		const fingers = this.total;
		this.reset();
		return ok ? fingers : 0;
	}

	reset(): void {
		this.contacts.clear();
		this.total = 0;
		this.lifted = 0;
		this.valid = false;
	}
}
