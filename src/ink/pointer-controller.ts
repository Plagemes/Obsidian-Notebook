import { InputPolicy } from "./input-policy";

/** A pointer sample in CSS px relative to the element. */
export interface InkSample {
	x: number;
	y: number;
	pressure: number;
	t: number;
	pointerType: string;
}

export interface PointerHandlers {
	/** `eraser`: the pen has its eraser button pressed or is flipped. Return false to reject the stroke. */
	drawStart(sample: InkSample, eraser: boolean): boolean;
	drawMove(samples: InkSample[], predicted: InkSample[]): void;
	/** `cancelled`: discard the stroke (e.g. palm, finger turned into a pinch). */
	drawEnd(cancelled: boolean): void;
	pan(dx: number, dy: number): void;
	zoom(factor: number, fx: number, fy: number): void;
}

/** `PointerEvent.buttons` bit for the pen eraser (Pointer Events "eraser button"). */
const ERASER_BUTTONS = 32;

interface NavPointer {
	x: number;
	y: number;
}

/**
 * Turns Pointer Events into strokes and navigation gestures.
 * Only one pointer draws at a time; the pen takes precedence over everything.
 */
export class PointerController {
	predictionEnabled = true;

	private drawId: number | null = null;
	private drawType = "";
	private drawLast: NavPointer | null = null;
	private readonly nav = new Map<number, NavPointer>();
	private rect: DOMRect;
	private readonly disposers: Array<() => void> = [];

	constructor(
		private readonly el: HTMLElement,
		private readonly policy: InputPolicy,
		private readonly handlers: PointerHandlers,
	) {
		this.rect = el.getBoundingClientRect();
		this.listen("pointerdown", (e) => this.onDown(e));
		this.listen("pointermove", (e) => this.onMove(e));
		this.listen("pointerup", (e) => this.onUp(e));
		this.listen("pointercancel", (e) => this.onUp(e));
		this.listen("lostpointercapture", (e) => this.onUp(e));
		this.listen("wheel", (e) => this.onWheel(e), { passive: false });
		this.listen("contextmenu", (e) => e.preventDefault());
		// Keep Obsidian mobile (side drawers) and the WebView from interpreting gestures on the page.
		this.listen("touchstart", (e) => e.stopPropagation(), { passive: true });
		this.listen("touchmove", (e) => {
			e.stopPropagation();
			if (e.cancelable) e.preventDefault();
		}, { passive: false });
	}

	get drawing(): boolean {
		return this.drawId !== null;
	}

	/** Ends the stroke in progress and keeps it (app going to background, view closing). */
	finishActiveStroke(): void {
		if (this.drawId === null) return;
		this.releaseDraw();
		this.handlers.drawEnd(false);
	}

	destroy(): void {
		this.finishActiveStroke();
		for (const d of this.disposers) d();
		this.disposers.length = 0;
	}

	private listen<K extends keyof HTMLElementEventMap>(
		type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions,
	): void {
		this.el.addEventListener(type, fn as EventListener, opts);
		this.disposers.push(() => this.el.removeEventListener(type, fn as EventListener, opts));
	}

	private sample(e: PointerEvent): InkSample {
		return {
			x: e.clientX - this.rect.left,
			y: e.clientY - this.rect.top,
			pressure: e.pressure,
			t: e.timeStamp,
			pointerType: e.pointerType,
		};
	}

	private onDown(e: PointerEvent): void {
		this.rect = this.el.getBoundingClientRect();
		const route = this.policy.route(e.pointerType, e.timeStamp, e.button);
		if (e.pointerType === "pen") this.policy.setPenDown(true, e.timeStamp);

		if (route === "draw") {
			if (this.drawId !== null) {
				// The pen replaces a finger stroke (likely a palm); a second finger turns into a pinch.
				if (e.pointerType === "pen" && this.drawType !== "pen") {
					this.cancelDraw();
				} else if (e.pointerType === "touch" && this.drawType === "touch") {
					this.convertDrawToNav();
					this.addNav(e);
					return;
				} else {
					return;
				}
			}
			if (e.pointerType === "pen") this.nav.clear();
			const eraser = e.pointerType === "pen" && ((e.buttons & ERASER_BUTTONS) !== 0 || e.button === 5);
			if (!this.handlers.drawStart(this.sample(e), eraser)) return;
			this.drawId = e.pointerId;
			this.drawType = e.pointerType;
			this.drawLast = { x: e.clientX, y: e.clientY };
			this.capture(e.pointerId);
			e.preventDefault();
		} else if (route === "navigate") {
			this.addNav(e);
			e.preventDefault();
		}
	}

	private onMove(e: PointerEvent): void {
		if (e.pointerType === "pen") this.policy.notePen(e.timeStamp);

		if (e.pointerId === this.drawId) {
			const events = e.getCoalescedEvents?.() ?? [];
			const samples = (events.length ? events : [e]).map((ce) => this.sample(ce));
			const predicted = this.predictionEnabled ? (e.getPredictedEvents?.() ?? []).map((pe) => this.sample(pe)) : [];
			this.drawLast = { x: e.clientX, y: e.clientY };
			this.handlers.drawMove(samples, predicted);
			return;
		}

		const p = this.nav.get(e.pointerId);
		if (!p) return;
		if (this.nav.size === 1) {
			this.handlers.pan(e.clientX - p.x, e.clientY - p.y);
		} else if (this.nav.size === 2) {
			const other = [...this.nav.entries()].find(([id]) => id !== e.pointerId)?.[1];
			if (other) {
				const before = Math.hypot(p.x - other.x, p.y - other.y);
				const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
				// The midpoint moves by half of this finger's movement.
				this.handlers.pan((e.clientX - p.x) / 2, (e.clientY - p.y) / 2);
				if (before > 0 && after > 0) {
					const mx = (e.clientX + other.x) / 2 - this.rect.left;
					const my = (e.clientY + other.y) / 2 - this.rect.top;
					this.handlers.zoom(after / before, mx, my);
				}
			}
		}
		p.x = e.clientX;
		p.y = e.clientY;
	}

	private onUp(e: PointerEvent): void {
		if (e.pointerType === "pen" && e.type !== "lostpointercapture") this.policy.setPenDown(false, e.timeStamp);
		if (e.pointerId === this.drawId) {
			this.releaseDraw(e.pointerId);
			this.handlers.drawEnd(false);
			return;
		}
		this.nav.delete(e.pointerId);
	}

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		this.rect = this.el.getBoundingClientRect();
		const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.rect.height : 1;
		if (e.ctrlKey || e.metaKey) {
			this.handlers.zoom(Math.exp(-e.deltaY * scale * 0.002), e.clientX - this.rect.left, e.clientY - this.rect.top);
		} else {
			const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
			const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
			this.handlers.pan(-dx * scale, -dy * scale);
		}
	}

	private addNav(e: PointerEvent): void {
		this.nav.set(e.pointerId, { x: e.clientX, y: e.clientY });
		this.capture(e.pointerId);
	}

	private convertDrawToNav(): void {
		const id = this.drawId;
		const last = this.drawLast;
		this.cancelDraw();
		if (id !== null && last) this.nav.set(id, { ...last });
	}

	private cancelDraw(): void {
		this.releaseDraw();
		this.handlers.drawEnd(true);
	}

	private releaseDraw(id = this.drawId): void {
		this.drawId = null;
		this.drawType = "";
		this.drawLast = null;
		if (id !== null && this.el.hasPointerCapture?.(id)) {
			try {
				this.el.releasePointerCapture(id);
			} catch {
				// The pointer is gone: nothing to release.
			}
		}
	}

	private capture(id: number): void {
		try {
			this.el.setPointerCapture(id);
		} catch {
			// Some WebViews refuse capture for pointers that already ended.
		}
	}
}
