/** A position in CSS px relative to the drawing area. */
type Pos = [number, number];

export interface RulerGestureHooks {
	/** Is the ruler shown? Nothing is intercepted when it is not. */
	enabled(): boolean;
	/** Should two fingers centred on `mid` (stage px) move the ruler instead of zooming the page? */
	grabs(mid: Pos): boolean;
	/** The two fingers moved: place the ruler between them (stage px). */
	update(a: Pos, b: Pos): void;
}

/**
 * Two-finger drag of the ruler. It listens in the capture phase on the drawing area, ahead of the pointer controller,
 * and swallows the touch events of the gesture so the page does not pan or zoom at the same time.
 */
export class RulerGesture {
	private readonly touches = new Map<number, Pos>();
	private active = false;
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly el: HTMLElement, private readonly hooks: RulerGestureHooks) {
		this.listen("pointerdown", (e) => this.onDown(e));
		this.listen("pointermove", (e) => this.onMove(e));
		this.listen("pointerup", (e) => this.onUp(e));
		this.listen("pointercancel", (e) => this.onUp(e));
	}

	get dragging(): boolean {
		return this.active;
	}

	destroy(): void {
		for (const d of this.disposers) d();
		this.disposers.length = 0;
		this.touches.clear();
		this.active = false;
	}

	private listen(type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", fn: (e: PointerEvent) => void): void {
		this.el.addEventListener(type, fn, true);
		this.disposers.push(() => this.el.removeEventListener(type, fn, true));
	}

	private pos(e: PointerEvent): Pos {
		const r = this.el.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	}

	private pair(): [Pos, Pos] | null {
		const all = [...this.touches.values()];
		return all.length >= 2 ? [all[0]!, all[1]!] : null;
	}

	private onDown(e: PointerEvent): void {
		if (e.pointerType !== "touch" || !this.hooks.enabled()) return;
		this.touches.set(e.pointerId, this.pos(e));
		if (this.active) {
			e.stopImmediatePropagation();
			return;
		}
		const pair = this.touches.size === 2 ? this.pair() : null;
		if (!pair) return;
		const mid: Pos = [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2];
		if (!this.hooks.grabs(mid)) return;
		this.active = true;
		e.stopImmediatePropagation();
		this.hooks.update(pair[0], pair[1]);
	}

	private onMove(e: PointerEvent): void {
		if (!this.touches.has(e.pointerId)) return;
		this.touches.set(e.pointerId, this.pos(e));
		if (!this.active) return;
		e.stopImmediatePropagation();
		const pair = this.pair();
		if (pair) this.hooks.update(pair[0], pair[1]);
	}

	private onUp(e: PointerEvent): void {
		// Lifts are never swallowed: the pointer controller must see the first finger go up to clean its own state.
		if (!this.touches.delete(e.pointerId)) return;
		if (this.active && this.touches.size < 2) this.active = false;
	}
}
