import { inEdgeZone, type EdgeZones } from "./edge-zones";
import { isBarrelSignal } from "./pen-button";

/**
 * What pressing the pen's side button does: open the radial menu, erase while it is held, use the
 * lasso while it is held, use the previously used tool while it is held, or nothing.
 */
export const PEN_BUTTON_ACTIONS = ["radial", "eraser", "lasso", "lastTool", "off"] as const;
export type PenButtonAction = (typeof PEN_BUTTON_ACTIONS)[number];

/** A tool the side button selects for the contact it is held on (the eraser has its own flag). */
export type HeldTool = "lasso" | "last";

export interface InputSettings {
	/** Fingers draw (unless the pen was seen in the last `palmRejectionMs`). */
	fingerDrawing: boolean;
	palmRejectionMs: number;
	/** Touch contacts larger than this (CSS px) are ignored as palms; 0 = off. */
	palmContactPx?: number;
	/** Touches that start in these edge zones are ignored. */
	edge?: EdgeZones;
	/** Side (barrel) button of the pen; `button === 2` / `buttons & 2`. Default "off". */
	penButton?: PenButtonAction;
	/** Fallback for pens whose button never reaches the page: holding the nib still opens the radial menu. Default off. */
	penLongPress?: boolean;
}

/** `menu`: the pen's side button was pressed and the radial menu should open (nothing is drawn). */
export type Route = "draw" | "navigate" | "ignore" | "menu";

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

	/** Is a contact at (x, y) (CSS px in a `width` × `height` area) of this type rejected by the edge zones? Only touch is. */
	edgeRejects(pointerType: string, x: number, y: number, width: number, height: number): boolean {
		return pointerType === "touch" && inEdgeZone(this.settings.edge, x, y, width, height);
	}

	/** The pen's side button is part of this event (`button` 2, or bit 2 of `buttons`); the eraser (bit 32, `button` 5) is not. */
	static barrel(button: number, buttons: number): boolean {
		return isBarrelSignal(button, buttons);
	}

	/** Does a pen contact erase? The eraser button / flipped pen always do; the side button when its action is "eraser". */
	penErases(button: number, buttons: number): boolean {
		if (button === 5 || (buttons & 32) !== 0) return true;
		return this.settings.penButton === "eraser" && InputPolicy.barrel(button, buttons);
	}

	/** The tool the side button selects for a pen contact (setting "lasso" or "lastTool"), or null. Decided when the pen touches down. */
	penHeldTool(button: number, buttons: number): HeldTool | null {
		if (!InputPolicy.barrel(button, buttons)) return null;
		if (this.settings.penButton === "lasso") return "lasso";
		return this.settings.penButton === "lastTool" ? "last" : null;
	}

	/**
	 * What a new contact does. `button` is PointerEvent.button (0 = primary), `buttons` PointerEvent.buttons,
	 * `contact` the contact size in CSS px.
	 */
	route(pointerType: string, t: number, button = 0, contact = 0, buttons = 0): Route {
		switch (pointerType) {
			case "pen":
				this.notePen(t);
				if (InputPolicy.barrel(button, buttons)) {
					if (this.settings.penButton === "radial") return "menu";
					if (this.settings.penButton !== undefined && this.settings.penButton !== "off") return "draw";
				}
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
