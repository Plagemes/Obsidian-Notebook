// 0.24 iconhelp (#429): the pure part of the long-press explanation bubble. Timing, movement tolerance, which pointers may
// start it and where the bubble goes. No DOM and no 'obsidian' import: tested in Node.

/** How long a finger rests on an icon before the explanation shows, ms. */
export const HELP_PRESS_MS = 500;
/** How far the finger may drift (CSS px) before the press counts as a swipe and the explanation is not shown. */
export const HELP_SLOP_PX = 10;
/** How long the bubble stays after the finger lifts, ms (long enough to finish reading it). */
export const HELP_LINGER_MS = 1200;
/** The click that ends a long press is swallowed for this long after the bubble showed, ms. */
export const HELP_CLICK_GUARD_MS = 800;

/**
 * Only a finger asks for the explanation: a mouse already has the hover tooltip and the pen belongs to writing and to the S Pen
 * button rules (it must never be delayed or intercepted by a help gesture).
 */
export function startsHelp(pointerType: string, primary: boolean): boolean {
	return pointerType === "touch" && primary;
}

/** Tracks one press: arm it at pointerdown, feed it the moves, ask whether it is due. */
export class LongPressTracker {
	private origin: { x: number; y: number; at: number } | null = null;
	private cancelled = false;

	constructor(private readonly pressMs = HELP_PRESS_MS, private readonly slopPx = HELP_SLOP_PX) {}

	begin(x: number, y: number, now: number): void {
		this.origin = { x, y, at: now };
		this.cancelled = false;
	}

	/** True while a press is being timed. */
	get active(): boolean {
		return this.origin !== null && !this.cancelled;
	}

	/** Feeds a pointer move. Returns true when the press just became a swipe (the caller drops its timer). */
	move(x: number, y: number): boolean {
		if (!this.origin || this.cancelled) return false;
		if (Math.hypot(x - this.origin.x, y - this.origin.y) > this.slopPx) {
			this.cancelled = true;
			return true;
		}
		return false;
	}

	/** The press is old enough and has not drifted. */
	due(now: number): boolean {
		return this.origin !== null && !this.cancelled && now - this.origin.at >= this.pressMs;
	}

	/** Remaining time before it is due, ms (0 when due or not active). */
	remaining(now: number): number {
		if (!this.origin || this.cancelled) return 0;
		return Math.max(0, this.pressMs - (now - this.origin.at));
	}

	end(): void {
		this.origin = null;
		this.cancelled = false;
	}
}

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface BubblePlacement {
	left: number;
	top: number;
	/** The bubble sits above the icon (otherwise below). */
	above: boolean;
	/** Where the arrow points on the bubble's x axis, px from its left edge. */
	arrowX: number;
}

/**
 * Anchors a bubble of `w` × `h` to `anchor`: centred on it, below when there is room (toolbars are at the top), above
 * otherwise, and always inside the viewport with `margin` px to spare.
 */
export function placeBubble(anchor: Rect, w: number, h: number, viewport: { width: number; height: number }, margin = 8, gap = 10): BubblePlacement {
	const cx = (anchor.left + anchor.right) / 2;
	const maxLeft = Math.max(margin, viewport.width - w - margin);
	const left = Math.min(Math.max(margin, cx - w / 2), maxLeft);
	const roomBelow = viewport.height - anchor.bottom - gap - margin;
	const roomAbove = anchor.top - gap - margin;
	const above = roomBelow < h && roomAbove > roomBelow;
	const rawTop = above ? anchor.top - gap - h : anchor.bottom + gap;
	const top = Math.min(Math.max(margin, rawTop), Math.max(margin, viewport.height - h - margin));
	const arrowX = Math.min(Math.max(14, cx - left), Math.max(14, w - 14));
	return { left, top, above, arrowX };
}

/** What a bubble says. */
export interface HelpContent {
	name: string;
	/** One line on what the control does (absent: the name alone). */
	description?: string;
	/** A shortcut or gesture, when there is one. */
	hint?: string;
}

/** Drops empty parts and trims, so a missing description never leaves a blank line. */
export function cleanHelp(c: HelpContent): HelpContent | null {
	const name = c.name.trim();
	if (!name) return null;
	const out: HelpContent = { name };
	const d = c.description?.trim();
	if (d) out.description = d;
	const h = c.hint?.trim();
	if (h) out.hint = h;
	return out;
}
