import type { Layout } from "../ink/layout";
import {
	clampToAnchor, decideTurn, easeOutCubic, fitPageViewport, lerpViewport, nearestPageByX, panRoom, recentVelocity,
	resistDrag, SwipeLock, turnViewport, TURN_MS, type SwipeAxis,
} from "../ink/page-mode";
import { PAGE_MARGIN, screenToPage, type Size, type Viewport } from "../ink/viewport";

/** What the page-by-page mode needs from the view. */
export interface PageModeHost {
	viewport(): Viewport;
	viewSize(): Size;
	layout(): Layout | null;
	/** Applies a viewport (through `PageMode.clamp`). `interactive`: part of a gesture or animation. */
	setViewport(v: Viewport, interactive: boolean): void;
	/** Fit-width mode: the page is re-fitted when the view changes size. */
	fitMode(): boolean;
}

type Source = "touch" | "wheel" | "inertia";

/** Wheel / trackpad: a sideways travel of this many px turns the page; then the wheel is ignored for a moment. */
const WHEEL_TURN_PX = 70;
const WHEEL_LOCK_MS = 450;
const WHEEL_IDLE_MS = 200;
/** A wheel event counts as the source of a pan if it arrived this recently (ms). */
const WHEEL_SOURCE_MS = 60;
/** Two-finger gesture whose spacing changed by more than this (ln of the ratio) is a pinch, not a swipe. */
const PINCH_LN = 0.06;

/**
 * One page at a time (#14). Owns the swipe gesture, the drag towards the neighbouring page and the turn
 * animation; the stroke pipeline is untouched (it never sees these gestures: the pen draws, only fingers and the
 * wheel arrive here through the view's pan handler). Pages sit side by side in the layout, so turning is just a
 * viewport move.
 *
 * The viewport the view holds is what is on screen: the page's own (clamped) viewport plus the sideways `drag`.
 */
export class PageMode {
	enabled = false;
	private anchor = 0;
	/** What the finger travelled sideways (unresisted); the screen shows `resistDrag` of it. */
	private rawDrag = 0;
	private animating: { frame: number; finish: () => void } | null = null;
	private readonly lock = new SwipeLock();
	private readonly contacts = new Set<number>();
	private readonly samples: Array<{ t: number; dx: number }> = [];
	private pinchLn = 0;
	private pinching = false;
	/** The last gesture was a sideways swipe: the fling the controller adds after the lift must not move the page. */
	private swiped = false;
	private lastWheel = -Infinity;
	private wheelLockUntil = -Infinity;
	private wheelAcc = 0;
	private wheelAt = -Infinity;
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly stage: HTMLElement, private readonly host: PageModeHost) {
		const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
			this.stage.addEventListener(type, fn as EventListener, { capture: true, passive: true });
			this.disposers.push(() => this.stage.removeEventListener(type, fn as EventListener, true));
		};
		on("pointerdown", (e) => this.onDown(e));
		on("pointerup", (e) => this.onUp(e));
		on("pointercancel", (e) => this.onUp(e));
		on("wheel", () => (this.lastWheel = performance.now()));
	}

	destroy(): void {
		for (const d of this.disposers) d();
		this.disposers.length = 0;
		this.cancelAnimation();
	}

	/** Turns the mode on or off. The caller rebuilds the layout and then calls `goTo`. */
	setEnabled(on: boolean): void {
		this.cancelAnimation();
		this.enabled = on;
		this.rawDrag = 0;
		this.contacts.clear();
		this.lock.reset();
	}

	/** A different notebook was opened: back to the first page. */
	reset(): void {
		this.cancelAnimation();
		this.anchor = 0;
		this.rawDrag = 0;
		this.contacts.clear();
		this.lock.reset();
	}

	/** Page in view: the anchor at rest, the nearest to the middle of the screen while dragging. */
	current(): number {
		const layout = this.host.layout();
		if (!layout || layout.boxes.length === 0) return 0;
		this.anchor = Math.min(layout.boxes.length - 1, Math.max(0, this.anchor));
		if (this.rawDrag === 0 && !this.animating) return this.anchor;
		const v = this.host.viewport();
		const size = this.host.viewSize();
		const [x] = screenToPage(v, size.width / 2, size.height / 2);
		return Math.max(0, nearestPageByX(layout, x));
	}

	get dragging(): boolean {
		return this.rawDrag !== 0;
	}

	get busy(): boolean {
		return this.animating !== null;
	}

	/** Viewport clamp for the view's `setViewport`: the anchor page keeps the view, the drag rides on top. */
	clamp(v: Viewport): Viewport {
		const layout = this.host.layout();
		if (!layout || layout.boxes.length === 0) return v;
		if (this.animating) return v;
		this.anchor = Math.min(layout.boxes.length - 1, Math.max(0, this.anchor));
		const drag = this.shownDrag();
		const base = clampToAnchor({ ...v, offsetX: v.offsetX - drag }, this.host.viewSize(), layout, this.anchor);
		return { ...base, offsetX: base.offsetX + drag };
	}

	/** The viewport that shows page `index` (fit mode: fitted at the top; otherwise the same zoom). */
	viewportFor(index: number): Viewport {
		const layout = this.host.layout();
		const size = this.host.viewSize();
		const v = this.host.viewport();
		if (!layout || !layout.boxes[index]) return v;
		if (this.host.fitMode()) return clampToAnchor(fitPageViewport(size, layout, index), size, layout, index);
		if (index === this.anchor) {
			// Same page: back to its top, same zoom and sideways position.
			const box = layout.boxes[index];
			return clampToAnchor({ ...v, offsetY: PAGE_MARGIN - box.y * v.scale }, size, layout, index);
		}
		return turnViewport(v, size, layout, this.anchor, index, false);
	}

	/** Fit mode: re-fit the anchor page (view resized or "Fit width"). `keepTop` keeps the line at the top of the screen. */
	refit(keepTop: boolean): void {
		const layout = this.host.layout();
		if (!layout || layout.boxes.length === 0 || this.host.viewSize().width === 0) return;
		this.cancelAnimation();
		this.rawDrag = 0;
		this.anchor = Math.min(layout.boxes.length - 1, Math.max(0, this.anchor));
		const size = this.host.viewSize();
		const old = this.host.viewport();
		const box = layout.boxes[this.anchor]!;
		const topLocal = screenToPage(old, 0, 0)[1] - box.y;
		const fitted = fitPageViewport(size, layout, this.anchor);
		if (keepTop && topLocal > 0) fitted.offsetY = -(topLocal + box.y) * fitted.scale;
		this.host.setViewport(fitted, false);
	}

	/** Shows page `index` at once (document opened, page added or deleted, link followed) or with the turn animation. */
	goTo(index: number, animate = false): void {
		const layout = this.host.layout();
		if (!layout || layout.boxes.length === 0) return;
		const target = Math.min(layout.boxes.length - 1, Math.max(0, index));
		const to = this.viewportFor(target);
		this.cancelAnimation();
		this.rawDrag = 0;
		if (animate && target !== this.anchor) {
			this.animate(to, target);
			return;
		}
		this.anchor = target;
		this.host.setViewport(to, false);
	}

	next(): boolean {
		return this.step(1);
	}

	previous(): boolean {
		return this.step(-1);
	}

	private step(dir: 1 | -1): boolean {
		const layout = this.host.layout();
		if (!layout) return false;
		const target = this.current() + dir;
		if (target < 0 || target >= layout.boxes.length) return false;
		this.goTo(target, true);
		return true;
	}

	// --- gestures ---

	private shownDrag(): number {
		const layout = this.host.layout();
		const n = layout?.boxes.length ?? 0;
		return resistDrag(this.rawDrag, this.anchor > 0, this.anchor < n - 1);
	}

	private onDown(e: PointerEvent): void {
		if (!this.enabled) return;
		if (e.pointerType !== "touch" && !(e.pointerType === "mouse" && e.button === 1)) return;
		if (this.animating) this.animating.finish();
		if (this.contacts.size === 0) {
			this.lock.reset();
			this.samples.length = 0;
			this.pinchLn = 0;
			this.pinching = false;
			this.swiped = false;
		}
		this.contacts.add(e.pointerId);
	}

	private onUp(e: PointerEvent): void {
		if (!this.contacts.delete(e.pointerId)) return;
		if (this.contacts.size === 0) this.release();
	}

	/** The controller's `zoom` handler calls this: a pinch cancels a sideways drag. */
	zoomed(factor: number): void {
		if (!this.enabled || this.contacts.size < 2 || !(factor > 0)) return;
		this.pinchLn += Math.log(factor);
		if (!this.pinching && Math.abs(this.pinchLn) > PINCH_LN) {
			this.pinching = true;
			if (this.rawDrag !== 0) {
				this.rawDrag = 0;
				this.host.setViewport(this.host.viewport(), true);
			}
			this.lock.axis = "free";
		}
	}

	/** The view's pan handler (fingers, mouse wheel, and the fling the controller adds after a lift). */
	pan(dx: number, dy: number): void {
		const layout = this.host.layout();
		if (!layout || this.animating) return;
		const now = performance.now();
		const source: Source = this.contacts.size > 0 ? "touch" : now - this.lastWheel < WHEEL_SOURCE_MS ? "wheel" : "inertia";
		const v = this.host.viewport();
		const room = panRoom(v, this.host.viewSize(), layout, this.anchor);
		if (source === "wheel") {
			this.wheel(dx, dy, room, now);
			return;
		}
		if (source === "inertia") {
			// A sideways swipe's fling must not move the page; vertical and zoomed-in flings scroll inside it.
			if (this.swiped || this.rawDrag !== 0) return;
			this.host.setViewport({ ...v, offsetX: v.offsetX + (room.x ? dx : 0), offsetY: v.offsetY + (room.y ? dy : 0) }, true);
			return;
		}
		const step = this.lock.add(dx, dy, { panX: room.x, panY: room.y });
		if (step.dragX !== 0) {
			this.swiped = true;
			this.drag(step.dragX, now);
		} else if (step.panX !== 0 || step.panY !== 0) {
			this.panInside(step.panX, step.panY, now, this.lock.axis);
		}
	}

	private drag(dx: number, now: number): void {
		this.samples.push({ t: now, dx });
		while (this.samples.length > 1 && now - this.samples[0]!.t > 120) this.samples.shift();
		const before = this.shownDrag();
		this.rawDrag += dx;
		const v = this.host.viewport();
		this.host.setViewport({ ...v, offsetX: v.offsetX + this.shownDrag() - before }, true);
	}

	/** Pans inside the page; when zoomed in, going on past the page edge builds up a drag towards the neighbour. */
	private panInside(px: number, py: number, now: number, axis: SwipeAxis): void {
		const layout = this.host.layout()!;
		const v = this.host.viewport();
		// The page's own viewport, without the drag that rides on top of it.
		const base0 = { ...v, offsetX: v.offsetX - this.shownDrag() };
		let remaining = px;
		// Moving back first takes the drag back.
		if (this.rawDrag !== 0 && Math.sign(remaining) === -Math.sign(this.rawDrag)) {
			const take = Math.min(Math.abs(remaining), Math.abs(this.rawDrag));
			this.rawDrag += Math.sign(remaining) * take;
			remaining -= Math.sign(remaining) * take;
		}
		const want = { ...base0, offsetX: base0.offsetX + remaining, offsetY: base0.offsetY + py };
		const clamped = clampToAnchor(want, this.host.viewSize(), layout, this.anchor);
		const residual = want.offsetX - clamped.offsetX;
		if (axis === "free" && residual !== 0 && !this.pinching && this.contacts.size === 1) {
			this.rawDrag += residual;
			this.samples.push({ t: now, dx: residual });
			while (this.samples.length > 1 && now - this.samples[0]!.t > 120) this.samples.shift();
			this.swiped = true;
		}
		this.host.setViewport({ ...clamped, offsetX: clamped.offsetX + this.shownDrag() }, true);
	}

	private wheel(dx: number, dy: number, room: { x: boolean; y: boolean }, now: number): void {
		const v = this.host.viewport();
		let turnAxis = 0;
		if (!room.x && Math.abs(dx) > 0) turnAxis = dx;
		else if (!room.y && Math.abs(dy) > 0 && Math.abs(dy) >= Math.abs(dx)) turnAxis = dy;
		const pannedX = room.x ? dx : 0;
		const pannedY = room.y ? dy : 0;
		if (pannedX !== 0 || pannedY !== 0) this.host.setViewport({ ...v, offsetX: v.offsetX + pannedX, offsetY: v.offsetY + pannedY }, true);
		if (turnAxis === 0) return;
		if (now - this.wheelAt > WHEEL_IDLE_MS) this.wheelAcc = 0;
		this.wheelAt = now;
		if (now < this.wheelLockUntil) return;
		this.wheelAcc += turnAxis;
		if (Math.abs(this.wheelAcc) < WHEEL_TURN_PX) return;
		// Wheel down / content moving up (dy < 0) = next; content moving right (dx > 0) = previous.
		const forward = turnAxis < 0;
		this.wheelAcc = 0;
		this.wheelLockUntil = now + WHEEL_LOCK_MS;
		if (forward) this.next();
		else this.previous();
	}

	/** The last finger lifted: turn the page if the drag or the flick was enough, otherwise settle back. */
	private release(): void {
		this.lock.reset();
		const layout = this.host.layout();
		if (!layout || this.rawDrag === 0) {
			this.rawDrag = 0;
			return;
		}
		const size = this.host.viewSize();
		const n = layout.boxes.length;
		const velocity = recentVelocity(this.samples, performance.now());
		const dir = decideTurn(this.shownDrag(), velocity, size.width, this.anchor > 0, this.anchor < n - 1);
		const target = this.anchor + dir;
		const from = this.host.viewport();
		this.rawDrag = 0;
		// Settling back: the clamp drops the drag; turning: the neighbour's own viewport.
		const to = dir === 0 ? clampToAnchor(from, size, layout, this.anchor) : this.viewportFor(target);
		this.animate(to, target, from);
	}

	// --- animation ---

	private animate(to: Viewport, target: number, fromViewport = this.host.viewport()): void {
		this.cancelAnimation();
		const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const duration = reduce ? 0 : TURN_MS;
		const done = (): void => {
			this.animating = null;
			this.anchor = target;
			this.rawDrag = 0;
			this.host.setViewport(to, false);
		};
		if (duration === 0) {
			done();
			return;
		}
		const start = performance.now();
		const state = { frame: 0, finish: () => {
			window.cancelAnimationFrame(state.frame);
			done();
		} };
		this.animating = state;
		const tick = (now: number): void => {
			if (this.animating !== state) return;
			const p = Math.min(1, (now - start) / duration);
			if (p >= 1) {
				done();
				return;
			}
			this.host.setViewport(lerpViewport(fromViewport, to, easeOutCubic(p)), true);
			state.frame = window.requestAnimationFrame(tick);
		};
		state.frame = window.requestAnimationFrame(tick);
	}

	private cancelAnimation(): void {
		if (!this.animating) return;
		window.cancelAnimationFrame(this.animating.frame);
		this.animating = null;
	}
}
