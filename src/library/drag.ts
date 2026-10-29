/**
 * Pointer-based press handling for library cards: context menu (right click, keyboard, touch long-press) and
 * drag-and-drop onto elements carrying `data-drop-folder`. Works with mouse, pen and touch.
 *
 * Mouse and pen start dragging after a few pixels. Touch needs a long press first (the card lifts); lifting the
 * finger without moving then opens the menu, moving starts the drag. A touch that moves before the long press
 * is a scroll and is left to the browser.
 */

export const DROP_ATTR = "data-drop-folder";
const LONG_PRESS_MS = 420;
const DRAG_SLOP = 6;
const SCROLL_SLOP = 10;

export interface PressOptions {
	el: HTMLElement;
	/** Right click, menu key or touch long-press without drag. Coordinates are client coordinates. */
	onMenu(x: number, y: number): void;
	/** Dragging is possible only if this returns a ghost element (it is added to the body and removed afterwards). */
	startDrag?(): HTMLElement | null;
	/** Whether dropping on this target is meaningful (used for the highlight and for the drop). */
	canDrop?(target: HTMLElement): boolean;
	onDrop?(target: HTMLElement): void;
	onDragEnd?(): void;
}

export function dropTargetAt(doc: Document, x: number, y: number): HTMLElement | null {
	return doc.elementFromPoint(x, y)?.closest<HTMLElement>(`[${DROP_ATTR}]`) ?? null;
}

export function attachPress(o: PressOptions): void {
	const { el } = o;
	const doc = el.ownerDocument;
	let state: "idle" | "pending" | "armed" | "dragging" = "idle";
	let pointerId = -1;
	let pointerType = "";
	let lastType = "";
	let startX = 0, startY = 0, x = 0, y = 0;
	let timer = 0;
	let ghost: HTMLElement | null = null;
	let hover: HTMLElement | null = null;

	const swallowClick = () => {
		const stop = (e: Event) => {
			e.stopPropagation();
			e.preventDefault();
		};
		el.addEventListener("click", stop, { capture: true, once: true });
		window.setTimeout(() => el.removeEventListener("click", stop, { capture: true }), 80);
	};
	const blockScroll = (e: TouchEvent) => {
		if (e.cancelable) e.preventDefault();
	};
	const setHover = (target: HTMLElement | null) => {
		if (target === hover) return;
		hover?.removeClass("is-drop-target");
		hover = target;
		hover?.addClass("is-drop-target");
	};
	const moveGhost = () => ghost?.setCssProps({ "--notebook-drag-x": `${x}px`, "--notebook-drag-y": `${y}px` });

	const cleanup = () => {
		window.clearTimeout(timer);
		doc.removeEventListener("pointermove", move);
		doc.removeEventListener("pointerup", up);
		doc.removeEventListener("pointercancel", cancel);
		doc.removeEventListener("touchmove", blockScroll);
		el.removeClass("is-lifted");
		el.removeClass("is-dragging");
		setHover(null);
		ghost?.remove();
		ghost = null;
		state = "idle";
	};

	const beginDrag = () => {
		const g = o.startDrag?.() ?? null;
		if (!g) {
			if (state === "armed") o.onMenu(x, y);
			cleanup();
			return;
		}
		state = "dragging";
		ghost = g;
		doc.body.appendChild(g);
		el.removeClass("is-lifted");
		el.addClass("is-dragging");
		swallowClick();
		moveGhost();
	};

	function move(e: PointerEvent): void {
		if (e.pointerId !== pointerId) return;
		x = e.clientX;
		y = e.clientY;
		const dist = Math.hypot(x - startX, y - startY);
		if (state === "pending") {
			if (pointerType === "touch") {
				if (dist > SCROLL_SLOP) cleanup();
			} else if (dist > DRAG_SLOP) {
				beginDrag();
			}
		} else if (state === "armed") {
			if (dist > DRAG_SLOP) beginDrag();
		} else if (state === "dragging") {
			e.preventDefault();
			moveGhost();
			const target = dropTargetAt(doc, x, y);
			setHover(target && (o.canDrop?.(target) ?? true) ? target : null);
		}
	}

	function up(e: PointerEvent): void {
		if (e.pointerId !== pointerId) return;
		x = e.clientX;
		y = e.clientY;
		if (state === "dragging") {
			const target = dropTargetAt(doc, x, y);
			cleanup();
			if (target && (o.canDrop?.(target) ?? true)) o.onDrop?.(target);
			o.onDragEnd?.();
			return;
		}
		if (state === "armed") {
			swallowClick();
			cleanup();
			o.onMenu(x, y);
			return;
		}
		cleanup();
	}

	function cancel(e: PointerEvent): void {
		if (e.pointerId !== pointerId) return;
		const was = state;
		cleanup();
		if (was === "dragging") o.onDragEnd?.();
		else if (was === "armed") o.onMenu(x, y);
	}

	el.addEventListener("pointerdown", (e) => {
		lastType = e.pointerType;
		if (state !== "idle" || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
		state = "pending";
		pointerId = e.pointerId;
		pointerType = e.pointerType;
		startX = x = e.clientX;
		startY = y = e.clientY;
		doc.addEventListener("pointermove", move);
		doc.addEventListener("pointerup", up);
		doc.addEventListener("pointercancel", cancel);
		if (pointerType === "touch") {
			timer = window.setTimeout(() => {
				if (state !== "pending") return;
				state = "armed";
				el.addClass("is-lifted");
				doc.addEventListener("touchmove", blockScroll, { passive: false });
				try {
					navigator.vibrate?.(12);
				} catch {
					// Vibration is optional.
				}
			}, LONG_PRESS_MS);
		}
	});

	el.addEventListener("keydown", () => (lastType = "key"));
	el.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		if (lastType === "touch") return; // touch long-press is handled by the press state machine
		let cx = e.clientX;
		let cy = e.clientY;
		if (lastType === "key" || (cx === 0 && cy === 0)) {
			const r = el.getBoundingClientRect();
			cx = r.left + Math.min(r.width / 2, 48);
			cy = r.top + Math.min(r.height / 2, 48);
		}
		o.onMenu(cx, cy);
	});
}
