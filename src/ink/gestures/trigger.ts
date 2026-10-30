import { StillHold } from "../pen-button";

/**
 * When may a pen contact become a gesture? Only when the user has asked for it explicitly: gesture mode is on (the
 * toolbar menu or a command), the side button is held and its action is "gesture", or (an opt-in setting) the nib
 * stayed still for a moment before the stroke moved. Normal writing never qualifies, whatever it draws.
 */
export interface TriggerFacts {
	pointerType: string;
	/** The contact is the eraser (flipped pen or eraser button): it keeps erasing. */
	eraser: boolean;
	/** The side button is held and its action is the gesture. */
	buttonGesture: boolean;
	/** Gesture mode was switched on. */
	modeOn: boolean;
}

export function gestureStarts(f: TriggerFacts): boolean {
	if (f.eraser || f.pointerType === "touch") return false;
	return f.buttonGesture || f.modeOn;
}

/** How long the nib must rest on the page before it moves for the stroke to become a gesture, ms. */
export const DWELL_MS = 650;
/** CSS px the nib may drift during the rest (measured from the first contact). */
export const DWELL_RADIUS_PX = 5;

export interface DwellFacts {
	enabled: boolean;
	pointerType: string;
	eraser: boolean;
	/** The side button already gave this contact a tool. */
	held: boolean;
	modeOn: boolean;
	/** The tool is an ink tool (pen or highlighter). */
	inking: boolean;
}

/** May this ink stroke turn into a gesture if the nib rests? Only a pen, with the setting on, writing ink. */
export function dwellMayStart(f: DwellFacts): boolean {
	return f.enabled && f.pointerType === "pen" && !f.eraser && !f.held && !f.modeOn && f.inking;
}

/**
 * Watches a contact for the rest-then-draw trigger. The rest counts from the very first contact and only if the
 * nib never left the small radius: a pause in the middle of a word never counts.
 */
export class DwellTracker {
	private readonly hold = new StillHold(DWELL_RADIUS_PX);
	private t0 = 0;

	begin(x: number, y: number, t: number): void {
		this.hold.begin(x, y);
		this.t0 = t;
	}

	move(x: number, y: number): void {
		this.hold.move(x, y);
	}

	end(): void {
		this.hold.end();
	}

	/** The nib has not left the radius since the first contact. */
	get resting(): boolean {
		return this.hold.still;
	}

	/** The rest has lasted long enough at time `now`. */
	ready(now: number): boolean {
		return this.hold.still && now - this.t0 >= DWELL_MS;
	}
}
