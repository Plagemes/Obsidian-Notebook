/**
 * Auto-scroll while writing: when a stroke ends in the bottom band of the view, the view scrolls up
 * smoothly a moment after the pen has lifted, so the next line is not at the very edge. It never
 * moves while the pen is down (that would shift the page under the stroke being written).
 */

/** The bottom part of the view that counts as "near the bottom". */
export const AUTO_SCROLL_BAND = 0.18;
/** Where the pen tip should end up (fraction of the view height from the top). */
export const AUTO_SCROLL_TARGET = 0.4;
/** Wait this long after the pen lifted before scrolling (ms), so the pause between letters and words does not move the page. */
export const AUTO_SCROLL_DELAY_MS = 700;
/** Duration of the scroll (ms). */
export const AUTO_SCROLL_MS = 320;
/** Scrolls shorter than this (CSS px) are not worth doing. */
const MIN_SCROLL_PX = 24;

/**
 * How far (CSS px) the content should move up for a stroke that ended at `tipY` (CSS px from the
 * top of a view `viewHeight` high), or 0 when the tip is not in the bottom band.
 */
export function autoScrollDistance(tipY: number, viewHeight: number, band = AUTO_SCROLL_BAND, target = AUTO_SCROLL_TARGET): number {
	if (!(viewHeight > 0) || !Number.isFinite(tipY)) return 0;
	if (tipY < viewHeight * (1 - band) || tipY > viewHeight * 1.5) return 0;
	const distance = tipY - viewHeight * target;
	return distance >= MIN_SCROLL_PX ? Math.min(distance, viewHeight * 0.8) : 0;
}

export function easeOutCubic(x: number): number {
	const k = 1 - Math.min(1, Math.max(0, x));
	return 1 - k * k * k;
}

/** Timers and animation frames, injected so the controller is testable. */
export interface AutoScrollClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(handle: number): void;
	requestFrame(fn: () => void): number;
	cancelFrame(handle: number): void;
}

export interface AutoScrollHost {
	/** The setting is on and the notebook can be written to. */
	enabled(): boolean;
	/** Height of the view (CSS px). */
	viewHeight(): number;
	/** Current vertical offset of the page (CSS px; decreases as the view scrolls down). */
	offsetY(): number;
	/** Moves the page by `dy` CSS px (negative = scroll down the document). Clamped by the view. */
	panBy(dy: number): void;
	/** A pen or finger contact is in progress: never scroll then. */
	busy(): boolean;
}

/**
 * Schedules and runs the scroll. `strokeEnded` after a stroke; `cancel` when anything touches the
 * screen. Every frame re-checks that no contact is active.
 */
export class AutoScroller {
	private timer: number | null = null;
	private frame: number | null = null;

	constructor(
		private readonly host: AutoScrollHost,
		private readonly clock: AutoScrollClock,
		private readonly delayMs = AUTO_SCROLL_DELAY_MS,
		private readonly durationMs = AUTO_SCROLL_MS,
	) {}

	get pending(): boolean {
		return this.timer !== null || this.frame !== null;
	}

	/** A stroke ended with its tip at `tipY` (CSS px from the top of the view). */
	strokeEnded(tipY: number): void {
		this.cancel();
		if (!this.host.enabled()) return;
		const distance = autoScrollDistance(tipY, this.host.viewHeight());
		if (distance <= 0) return;
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			this.start(distance);
		}, this.delayMs);
	}

	cancel(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		if (this.frame !== null) this.clock.cancelFrame(this.frame);
		this.timer = null;
		this.frame = null;
	}

	private start(distance: number): void {
		if (!this.host.enabled() || this.host.busy()) return;
		const from = this.host.offsetY();
		const t0 = this.clock.now();
		const step = () => {
			this.frame = null;
			if (!this.host.enabled() || this.host.busy()) return;
			const k = this.durationMs <= 0 ? 1 : Math.min(1, (this.clock.now() - t0) / this.durationMs);
			const want = from - distance * easeOutCubic(k);
			const before = this.host.offsetY();
			this.host.panBy(want - before);
			// The end of the document stops the scroll.
			const stuck = Math.abs(this.host.offsetY() - before) < 1e-6 && Math.abs(want - before) > 0.5;
			if (k >= 1 || stuck) return;
			this.frame = this.clock.requestFrame(step);
		};
		this.frame = this.clock.requestFrame(step);
	}
}
