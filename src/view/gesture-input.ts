import { AutoScroller, type AutoScrollClock } from "../ink/auto-scroll";
import { FingerTapDetector, tapActionFor, type TapAction } from "../ink/finger-taps";
import type { TapGestureMode } from "../ink/gesture-settings";
import type { InputPolicy } from "../ink/input-policy";

/** What the notebook view gives the gesture layer. */
export interface GestureContext {
	policy: InputPolicy;
	tapMode(): TapGestureMode;
	/** Undo or redo, as the toolbar buttons do. */
	act(action: TapAction): void;
	/** Remembers the view (position, zoom) and returns a function that puts it back. */
	snapshotView(): () => void;
	/** A stroke or another drawing contact is in progress. */
	drawing(): boolean;
	autoScroll: {
		enabled(): boolean;
		viewHeight(): number;
		offsetY(): number;
		/** Moves the page by `dy` CSS px (the view clamps it). */
		panBy(dy: number): void;
	};
}

const browserClock: AutoScrollClock = {
	now: () => performance.now(),
	setTimeout: (fn, ms) => window.setTimeout(fn, ms),
	clearTimeout: (h) => window.clearTimeout(h),
	requestFrame: (fn) => window.requestAnimationFrame(() => fn()),
	cancelFrame: (h) => window.cancelAnimationFrame(h),
};

/**
 * Gestures around the writing engine, kept apart from the stroke pipeline. It only observes the
 * pointer events of the stage (it never stops them): multi-finger taps for undo / redo, and the
 * auto-scroll that follows the pen after a stroke ends near the bottom of the view.
 */
export class GestureInput {
	private readonly taps = new FingerTapDetector();
	private readonly scroller: AutoScroller;
	private readonly contacts = new Set<number>();

	/** True while a finger of a tap or swipe gesture is down. */
	get touching(): boolean {
		return this.contacts.size > 0;
	}
	private restoreView: (() => void) | null = null;
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly stage: HTMLElement, private readonly ctx: GestureContext, clock: AutoScrollClock = browserClock) {
		this.scroller = new AutoScroller({
			enabled: () => this.ctx.autoScroll.enabled(),
			viewHeight: () => this.ctx.autoScroll.viewHeight(),
			offsetY: () => this.ctx.autoScroll.offsetY(),
			panBy: (dy) => this.ctx.autoScroll.panBy(dy),
			busy: () => this.contacts.size > 0 || this.ctx.drawing(),
		}, clock);
		this.listen("pointerdown", (e) => this.onDown(e as PointerEvent));
		this.listen("pointermove", (e) => this.onMove(e as PointerEvent));
		this.listen("pointerup", (e) => this.onUp(e as PointerEvent, false));
		this.listen("pointercancel", (e) => this.onUp(e as PointerEvent, true));
		this.listen("wheel", () => this.scroller.cancel());
		this.disposers.push(() => this.taps.reset());
	}

	/** A pen stroke ended with its tip `tipY` CSS px from the top of the view: scroll up soon if it is near the bottom. */
	strokeEnded(tipY: number): void {
		this.scroller.strokeEnded(tipY);
	}

	/** The radial menu took the pointer events (its lifts never arrive): forget the contacts so no tap or scroll waits for them. */
	releaseContacts(): void {
		this.contacts.clear();
		this.taps.reset();
		this.restoreView = null;
	}

	destroy(): void {
		this.scroller.cancel();
		for (const d of this.disposers) d();
		this.disposers.length = 0;
	}

	private listen(type: string, fn: (e: Event) => void): void {
		this.stage.addEventListener(type, fn);
		this.disposers.push(() => this.stage.removeEventListener(type, fn));
	}

	/** Is this touch one the writing engine would treat as a finger (not a palm, not near the pen, not in an edge zone)? */
	private accepts(e: PointerEvent): boolean {
		const policy = this.ctx.policy;
		const rect = this.stage.getBoundingClientRect();
		if (policy.route("touch", e.timeStamp, 0, Math.max(e.width || 0, e.height || 0), e.buttons) === "ignore") return false;
		if (policy.penRecentlyActive(e.timeStamp)) return false;
		return !policy.edgeRejects("touch", e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
	}

	private onDown(e: PointerEvent): void {
		// Anything that touches the screen takes the view back.
		this.scroller.cancel();
		this.contacts.add(e.pointerId);
		if (e.pointerType !== "touch") {
			if (this.taps.landed > 0) this.taps.interrupt();
			return;
		}
		if (this.ctx.tapMode() === "off") return;
		if (!this.accepts(e)) {
			// A palm or a touch near the pen among the fingers: not a tap.
			this.taps.interrupt();
			return;
		}
		if (this.taps.down(e.pointerId, e.clientX, e.clientY, e.timeStamp)) this.restoreView = this.ctx.snapshotView();
	}

	private onMove(e: PointerEvent): void {
		if (e.pointerType === "touch") this.taps.move(e.pointerId, e.clientX, e.clientY);
	}

	private onUp(e: PointerEvent, cancelled: boolean): void {
		this.contacts.delete(e.pointerId);
		if (e.pointerType !== "touch") return;
		const fingers = this.taps.up(e.pointerId, e.timeStamp, cancelled);
		if (this.taps.landed === 0) {
			const restore = this.restoreView;
			this.restoreView = null;
			const action = fingers > 0 ? tapActionFor(fingers, this.ctx.tapMode()) : null;
			if (!action) return;
			// The tap may have nudged the view (a few pixels of pan or zoom): put it back, then undo / redo.
			restore?.();
			this.ctx.act(action);
		}
	}
}
