/**
 * The temporary way out of the snap (roadmap #71): a finger held on the screen while a selection is dragged (the second
 * finger when a finger drags; any finger when the pen drags), or Alt on a keyboard. Pure bookkeeping, no DOM: the view
 * feeds it the pointer and key events of the stage. The toolbar toggle (`snapPaused` in the view) is the other way.
 */

/** A touch contact wider or taller than this (CSS px) is a resting palm, not a finger held on purpose. */
export const FINGER_MAX_PX = 40;
/** More contacts than this at once cannot all be real: the bookkeeping missed a release, so it starts over. */
const MAX_TRACKED = 6;

export interface HoldEvent {
	type: string;
	pointerId: number;
	pointerType: string;
	width?: number;
	height?: number;
}

export class SnapHold {
	private readonly fingers = new Set<number>();
	private alt = false;

	/** Feed every pointerdown, pointerup and pointercancel of the stage. */
	pointer(e: HoldEvent): void {
		if (e.pointerType !== "touch") return;
		if (e.type === "pointerdown") {
			// A palm is not a finger held on purpose (it would switch the snap off for a whole writing session).
			if ((e.width ?? 0) > FINGER_MAX_PX || (e.height ?? 0) > FINGER_MAX_PX) return;
			if (this.fingers.size >= MAX_TRACKED) this.fingers.clear();
			this.fingers.add(e.pointerId);
		} else if (e.type === "pointerup" || e.type === "pointercancel") {
			this.fingers.delete(e.pointerId);
		}
	}

	key(e: { type: string; key: string }): void {
		if (e.key === "Alt") this.alt = e.type === "keydown";
	}

	/** Focus lost: no key or finger can still be down. */
	reset(): void {
		this.fingers.clear();
		this.alt = false;
	}

	/** Is the snap held off for a drag made with `dragType` ("pen", "touch" or "mouse")? */
	held(dragType: string): boolean {
		if (this.alt) return true;
		return this.fingers.size >= (dragType === "touch" ? 2 : 1);
	}
}
