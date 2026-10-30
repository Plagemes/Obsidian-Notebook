import { inEdgeZone, type EdgeZones } from "./edge-zones";
import { isBarrelSignal } from "./pen-button";

/**
 * What pressing the pen's side button does: a click opens the radial menu and holding it while the nib touches erases
 * (the default), the radial menu only, erase / lasso / the previously used tool while it is held, or nothing.
 */
export const PEN_BUTTON_ACTIONS = ["radial-eraser", "radial", "eraser", "lasso", "previous", "gesture", "radial-gesture", "off"] as const;
export type PenButtonAction = (typeof PEN_BUTTON_ACTIONS)[number];

/** A tool the pen acts as while the side button is held (and the nib touches the page). */
export type HeldTool = "eraser" | "lasso" | "previous" | "gesture";

/** Does a click of the side button open the radial menu? */
export function opensRadial(action: PenButtonAction | undefined): boolean {
	return action === "radial" || action === "radial-eraser" || action === "radial-gesture";
}

/** The tool the pen takes while the side button is held and the nib touches: undefined for the actions without one. */
export function heldToolOf(action: PenButtonAction | undefined): HeldTool | null {
	switch (action) {
		case "radial-eraser":
		case "eraser":
			return "eraser";
		case "lasso":
			return "lasso";
		case "previous":
			return "previous";
		case "gesture":
		case "radial-gesture":
			return "gesture";
		default:
			return null;
	}
}

export interface InputSettings {
	/** Fingers draw (unless the pen was seen in the last `palmRejectionMs`). */
	fingerDrawing: boolean;
	palmRejectionMs: number;
	/** Touch contacts larger than this (CSS px) are ignored as palms; 0 = off. */
	palmContactPx?: number;
	/** Touches that start in these edge zones are ignored. */
	edge?: EdgeZones;
	/** What the pen's side button does; the default is "radial-eraser" (see settings). Unset = "off". */
	penButton?: PenButtonAction;
	/**
	 * Fallback for pens whose button never reaches the page: holding the nib still from the first contact opens
	 * the radial menu. The effective value (the user's choice, or the automatic default); see `effectivePenHold`.
	 */
	penLongPress?: boolean;
	/**
	 * Samsung / Chromium report the side button, pressed while the pen hovers, as a primary press with pressure
	 * exactly 0. On by default; off for a device that reports 0 on real contact. Undefined = on.
	 */
	zeroPressureButton?: boolean;
	/**
	 * Side button pressed while the nib touches, seen as a pen move with `button 0` (see `ChordDetector`): finishes
	 * the stroke and switches to the action's tool until the next such event or the lift. Undefined = on.
	 */
	chordButton?: boolean;
	/** A finger held still on the page (pen-only mode) opens the radial menu beside it. */
	fingerLongPress?: boolean;
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

	/** The tool (other than the eraser) a contact takes because the side button (`buttons & 2`) is held with it. */
	penHeld(button: number, buttons: number): "lasso" | "previous" | "gesture" | null {
		const tool = heldToolOf(this.settings.penButton);
		return (tool === "lasso" || tool === "previous" || tool === "gesture") && InputPolicy.barrel(button, buttons) ? tool : null;
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
					// A barrel bit (`buttons & 2`) cannot be told apart from contact: radial + eraser opens the menu.
					if (opensRadial(this.settings.penButton)) return "menu";
					if (heldToolOf(this.settings.penButton)) return "draw";
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
