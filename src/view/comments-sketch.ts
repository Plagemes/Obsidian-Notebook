import { COMMENT_SKETCH_H, COMMENT_SKETCH_POINTS, COMMENT_SKETCH_STROKES, COMMENT_SKETCH_TOTAL, COMMENT_SKETCH_W, type CommentSketch } from "../model/types";

/**
 * The small handwritten sketch of a comment (0.18, #86): drawn on a canvas in the fixed frame of the format
 * (COMMENT_SKETCH_W × COMMENT_SKETCH_H). It is not page ink; it lives inside the comment. `paintSketch` draws it (the card
 * and the editor), `SketchPad` is the editor's drawing surface. Nothing here touches the document or the ink pipeline.
 */

/** Draws `strokes` in `ctx`, scaled so the frame fills `width` × `height` CSS pixels (the context already carries the device pixel ratio). */
export function paintSketch(ctx: CanvasRenderingContext2D, strokes: readonly (readonly number[])[], width: number, height: number, color: string): void {
	ctx.clearRect(0, 0, width, height);
	const sx = width / COMMENT_SKETCH_W;
	const sy = height / COMMENT_SKETCH_H;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = Math.max(1.4, width / 170);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	for (const s of strokes) {
		if (s.length < 2) continue;
		if (s.length === 2 || (s.length === 4 && s[0] === s[2] && s[1] === s[3])) {
			ctx.beginPath();
			ctx.arc(s[0]! * sx, s[1]! * sy, ctx.lineWidth / 2, 0, Math.PI * 2);
			ctx.fill();
			continue;
		}
		ctx.beginPath();
		ctx.moveTo(s[0]! * sx, s[1]! * sy);
		for (let i = 2; i + 1 < s.length; i += 2) ctx.lineTo(s[i]! * sx, s[i + 1]! * sy);
		ctx.stroke();
	}
}

/** A canvas that shows a sketch at `width` CSS px (the height follows the frame's 2:1 shape), sharp at the device pixel ratio. */
export function sketchCanvas(parent: HTMLElement, sketch: CommentSketch, width: number, label: string, cls = "nb-cm-sketch"): HTMLCanvasElement {
	const height = Math.round((width * COMMENT_SKETCH_H) / COMMENT_SKETCH_W);
	const canvas = parent.createEl("canvas", { cls, attr: { role: "img", "aria-label": label } });
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	canvas.width = Math.round(width * dpr);
	canvas.height = Math.round(height * dpr);
	canvas.setCssProps({ "--nb-cm-sketch-w": `${width}px`, "--nb-cm-sketch-h": `${height}px` });
	const ctx = canvas.getContext("2d");
	if (ctx) {
		ctx.scale(dpr, dpr);
		paintSketch(ctx, sketch.strokes, width, height, getComputedStyle(canvas).color || "#222222");
	}
	return canvas;
}

/** Points closer than this (frame units) to the previous one are not kept: a sketch is small. */
const MIN_STEP = 2.5;

/**
 * The drawing surface of the comment editor: pen, finger or mouse draw strokes in the frame; "undo" removes the last stroke,
 * "clear" all of them. The strokes stay within the format's limits (a stroke that would exceed them simply stops growing).
 */
export class SketchPad {
	readonly canvas: HTMLCanvasElement;
	private strokes: number[][];
	private current: number[] | null = null;
	private pointerId: number | null = null;
	private total: number;
	private cssWidth = 0;

	constructor(parent: HTMLElement, start: CommentSketch | undefined, label: string, private readonly changed: () => void) {
		this.strokes = (start?.strokes ?? []).map((s) => [...s]);
		this.total = this.strokes.reduce((n, s) => n + s.length / 2, 0);
		this.canvas = parent.createEl("canvas", { cls: "nb-cm-pad", attr: { "aria-label": label } });
		this.canvas.addEventListener("pointerdown", (e) => this.down(e));
		this.canvas.addEventListener("pointermove", (e) => this.move(e));
		for (const type of ["pointerup", "pointercancel"] as const) this.canvas.addEventListener(type, (e) => this.up(e));
		// Fit to the width the dialog gives it, once it is laid out and whenever that changes (rotating a tablet).
		const fit = () => this.fit();
		window.requestAnimationFrame(fit);
		if (typeof ResizeObserver !== "undefined") {
			// Resizing the canvas changes the height of what is observed: do it on the next frame, never inside the observer's callback.
			const ro = new ResizeObserver(() => window.requestAnimationFrame(fit));
			ro.observe(parent);
		}
	}

	get value(): CommentSketch | undefined {
		return this.strokes.length > 0 ? { strokes: this.strokes.map((s) => [...s]) } : undefined;
	}

	get empty(): boolean {
		return this.strokes.length === 0;
	}

	undo(): void {
		if (this.strokes.length === 0) return;
		const gone = this.strokes.pop()!;
		this.total -= gone.length / 2;
		this.paint();
		this.changed();
	}

	clear(): void {
		if (this.strokes.length === 0) return;
		this.strokes = [];
		this.total = 0;
		this.paint();
		this.changed();
	}

	private fit(): void {
		const parentWidth = this.canvas.parentElement?.clientWidth ?? 0;
		const width = Math.max(120, Math.min(560, parentWidth || 320));
		if (width === this.cssWidth) return;
		this.cssWidth = width;
		const height = Math.round((width * COMMENT_SKETCH_H) / COMMENT_SKETCH_W);
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		this.canvas.width = Math.round(width * dpr);
		this.canvas.height = Math.round(height * dpr);
		this.canvas.setCssProps({ "--nb-cm-sketch-w": `${width}px`, "--nb-cm-sketch-h": `${height}px` });
		this.paint();
	}

	private paint(): void {
		const ctx = this.canvas.getContext("2d");
		if (!ctx || this.cssWidth === 0) return;
		const dpr = this.canvas.width / this.cssWidth;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		paintSketch(ctx, this.current ? [...this.strokes, this.current] : this.strokes, this.cssWidth, this.canvas.height / dpr, getComputedStyle(this.canvas).color || "#222222");
	}

	private frame(e: PointerEvent): [number, number] {
		const r = this.canvas.getBoundingClientRect();
		const x = ((e.clientX - r.left) / Math.max(1, r.width)) * COMMENT_SKETCH_W;
		const y = ((e.clientY - r.top) / Math.max(1, r.height)) * COMMENT_SKETCH_H;
		return [Math.round(Math.min(COMMENT_SKETCH_W, Math.max(0, x))), Math.round(Math.min(COMMENT_SKETCH_H, Math.max(0, y)))];
	}

	private down(e: PointerEvent): void {
		if (this.pointerId !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
		if (this.strokes.length >= COMMENT_SKETCH_STROKES || this.total >= COMMENT_SKETCH_TOTAL) return;
		e.preventDefault();
		this.pointerId = e.pointerId;
		try {
			this.canvas.setPointerCapture(e.pointerId);
		} catch {
			// a pointer that is no longer active (a synthetic event): the drawing goes on without capture
		}
		const [x, y] = this.frame(e);
		this.current = [x, y];
		this.total += 1;
		this.paint();
	}

	private move(e: PointerEvent): void {
		if (e.pointerId !== this.pointerId || !this.current) return;
		e.preventDefault();
		const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		for (const ev of events.length > 0 ? events : [e]) this.extend(this.frame(ev));
		this.paint();
	}

	private extend([x, y]: [number, number]): void {
		const s = this.current;
		if (!s || s.length / 2 >= COMMENT_SKETCH_POINTS || this.total >= COMMENT_SKETCH_TOTAL) return;
		const lx = s[s.length - 2]!;
		const ly = s[s.length - 1]!;
		if (Math.hypot(x - lx, y - ly) < MIN_STEP) return;
		s.push(x, y);
		this.total += 1;
	}

	private up(e: PointerEvent): void {
		if (e.pointerId !== this.pointerId) return;
		this.pointerId = null;
		const s = this.current;
		this.current = null;
		if (s) {
			// A tap is a dot: two equal points make a stroke the format accepts.
			if (s.length === 2) {
				s.push(s[0]!, s[1]!);
				this.total += 1;
			}
			this.strokes.push(s);
			this.changed();
		}
		this.paint();
	}
}
