export interface InputSettings {
	/** Fingers draw (unless the pen was seen in the last `palmRejectionMs`). */
	fingerDrawing: boolean;
	palmRejectionMs: number;
	/** Touch contacts larger than this (CSS px) are ignored as palms; 0 = off. */
	palmContactPx?: number;
}

export type Route = "draw" | "navigate" | "ignore";

/**
 * Basic palm rejection: while the pen is down, or was seen (hover included) in the last
 * N ms, touch does not draw and only pans/zooms.
 */
export class InputPolicy {
	private lastPenTime = -Infinity;
	private penDown = false;

	constructor(public settings: InputSettings) {}

	/** Any pen event, hover included. */
	notePen(t: number): void {
		this.lastPenTime = Math.max(this.lastPenTime, t);
	}

	setPenDown(down: boolean, t: number): void {
		this.penDown = down;
		this.notePen(t);
	}

	penRecentlyActive(t: number): boolean {
		return this.penDown || t - this.lastPenTime < this.settings.palmRejectionMs;
	}

	/** What a new contact does. `button` is PointerEvent.button (0 = primary); `contact` the contact size in CSS px. */
	route(pointerType: string, t: number, button = 0, contact = 0): Route {
		switch (pointerType) {
			case "pen":
				this.notePen(t);
				return button === 0 || button === 5 ? "draw" : "ignore";
			case "mouse":
				if (button === 0) return "draw";
				return button === 1 ? "navigate" : "ignore";
			case "touch":
				if (this.penDown) return "ignore";
				if (this.settings.palmContactPx && contact > this.settings.palmContactPx) return "ignore";
				if (this.settings.fingerDrawing && !this.penRecentlyActive(t)) return "draw";
				return "navigate";
			default:
				return "ignore";
		}
	}
}
