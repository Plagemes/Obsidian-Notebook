import type { Tool } from "../model/types";
import { addCapsule, addTrapezoid, inkRadius, type InkBuilder } from "./ink-geometry";

/** Integer device-pixel rectangle, `x1`/`y1` exclusive; empty when x1 <= x0 or y1 <= y0. */
export interface DeviceRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Page → device pixels: x_dev = k·x + tx (same for y), and the page size for clipping. */
export interface PageTransform {
	k: number;
	tx: number;
	ty: number;
	pageW: number;
	pageH: number;
}

/** Antialiasing margin around painted geometry, device px. */
export const AA_MARGIN = 2;

export function emptyRect(): DeviceRect {
	return { x0: 0, y0: 0, x1: 0, y1: 0 };
}

export function isEmpty(r: DeviceRect): boolean {
	return r.x1 <= r.x0 || r.y1 <= r.y0;
}

/**
 * Device rectangle covering the page-space box (plus the antialiasing margin), clamped to the
 * canvas. Written to `out` (no allocation).
 */
export function pageBoxToDevice(
	t: PageTransform, minX: number, minY: number, maxX: number, maxY: number, canvasW: number, canvasH: number, out: DeviceRect,
): DeviceRect {
	out.x0 = Math.max(0, Math.floor(minX * t.k + t.tx) - AA_MARGIN);
	out.y0 = Math.max(0, Math.floor(minY * t.k + t.ty) - AA_MARGIN);
	out.x1 = Math.min(canvasW, Math.ceil(maxX * t.k + t.tx) + AA_MARGIN);
	out.y1 = Math.min(canvasH, Math.ceil(maxY * t.k + t.ty) + AA_MARGIN);
	return out;
}

/** `a` grows to include `b`. */
export function unionInto(a: DeviceRect, b: DeviceRect): void {
	if (isEmpty(b)) return;
	if (isEmpty(a)) {
		a.x0 = b.x0;
		a.y0 = b.y0;
		a.x1 = b.x1;
		a.y1 = b.y1;
		return;
	}
	a.x0 = Math.min(a.x0, b.x0);
	a.y0 = Math.min(a.y0, b.y0);
	a.x1 = Math.max(a.x1, b.x1);
	a.y1 = Math.max(a.y1, b.y1);
}

/** Capsules per chunk of the spatial index. */
const CHUNK = 64;

/**
 * Bounding boxes (page coordinates) of consecutive chunks of 64 capsules, grown as nodes are
 * added, so finding the capsules under a small rectangle skips whole chunks: the work per input
 * event does not grow with the length of the stroke.
 */
export class CapsuleIndex {
	private boxes = new Float64Array(4 * 16);
	private indexed = 0;

	reset(): void {
		this.indexed = 0;
	}

	/** Chunk count after indexing every node of `g`. */
	update(g: InkBuilder): number {
		const { nx, ny, nr, nodeCount } = g;
		const chunks = Math.ceil(nodeCount / CHUNK);
		if (4 * chunks > this.boxes.length) {
			const b = new Float64Array(Math.max(4 * chunks, this.boxes.length * 2));
			b.set(this.boxes);
			this.boxes = b;
		}
		const bx = this.boxes;
		for (let i = this.indexed; i < nodeCount; i++) {
			const c = 4 * Math.floor(i / CHUNK);
			if (i % CHUNK === 0) {
				bx[c] = Infinity;
				bx[c + 1] = Infinity;
				bx[c + 2] = -Infinity;
				bx[c + 3] = -Infinity;
			}
			for (let j = i > 0 ? i - 1 : i; j <= i; j++) {
				const x = nx[j]!, y = ny[j]!, r = nr[j]!;
				if (x - r < bx[c]!) bx[c] = x - r;
				if (y - r < bx[c + 1]!) bx[c + 1] = y - r;
				if (x + r > bx[c + 2]!) bx[c + 2] = x + r;
				if (y + r > bx[c + 3]!) bx[c + 3] = y + r;
			}
		}
		this.indexed = nodeCount;
		return chunks;
	}

	/** Does chunk `c` meet the page-space box? */
	meets(c: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
		const bx = this.boxes, k = 4 * c;
		return bx[k + 2]! >= minX && bx[k]! <= maxX && bx[k + 3]! >= minY && bx[k + 1]! <= maxY;
	}
}

/**
 * The capsules (node i with the trapezoid from node i-1) whose box meets the device rectangle:
 * the ones to repaint after the rectangle is cleared. `cb` is called for each, in order. With an
 * index, chunks of capsules far from the rectangle are skipped as a whole. Returns how many
 * capsules were looked at.
 */
export function capsulesIn(g: InkBuilder, t: PageTransform, r: DeviceRect, cb: (i: number) => void, index?: CapsuleIndex): number {
	if (isEmpty(r)) return 0;
	// The rectangle in page coordinates, widened by the antialiasing margin.
	const m = AA_MARGIN / t.k;
	const minX = (r.x0 - t.tx) / t.k - m, maxX = (r.x1 - t.tx) / t.k + m;
	const minY = (r.y0 - t.ty) / t.k - m, maxY = (r.y1 - t.ty) / t.k + m;
	const { nx, ny, nr, nodeCount } = g;
	const chunks = index ? index.update(g) : 1;
	let scanned = 0;
	for (let c = 0; c < chunks; c++) {
		if (index && !index.meets(c, minX, minY, maxX, maxY)) continue;
		const end = index ? Math.min(nodeCount, (c + 1) * CHUNK) : nodeCount;
		for (let i = index ? c * CHUNK : 0; i < end; i++) {
			let x0 = nx[i]! - nr[i]!, x1 = nx[i]! + nr[i]!, y0 = ny[i]! - nr[i]!, y1 = ny[i]! + nr[i]!;
			if (i > 0) {
				x0 = Math.min(x0, nx[i - 1]! - nr[i - 1]!);
				x1 = Math.max(x1, nx[i - 1]! + nr[i - 1]!);
				y0 = Math.min(y0, ny[i - 1]! - nr[i - 1]!);
				y1 = Math.max(y1, ny[i - 1]! + nr[i - 1]!);
			}
			if (x1 >= minX && x0 <= maxX && y1 >= minY && y0 <= maxY) cb(i);
			scanned++;
		}
	}
	return scanned;
}

/**
 * The stroke being written, painted on its own canvas as the samples arrive ("wet ink").
 *
 * - Final geometry (nodes of an InkBuilder) is painted once, when it becomes final: only the new
 *   capsules, never the whole stroke.
 * - The provisional tip (points whose curve is not final yet, the raw pen position and the
 *   optional predicted points) is drawn on top and erased before the next paint: its dirty
 *   rectangle is cleared and the final capsules that meet it are repainted, clipped to it.
 * - Nothing waits for an animation frame: `paint()` runs in the input handler.
 *
 * Ink is always painted opaque; a highlighter canvas gets its translucency and multiply blending
 * from CSS (`.notebook-canvas-wet.is-highlighter`), so overlapping capsules never darken twice.
 */
export class WetInk {
	readonly ctx: CanvasRenderingContext2D;
	g: InkBuilder | null = null;
	tool: Tool = "pen";
	private color = "#000000";
	private t: PageTransform = { k: 1, tx: 0, ty: 0, pageW: 0, pageH: 0 };
	private painted = 0;
	/** Everything painted since begin (device px). */
	readonly inkRect = emptyRect();
	/** Where the provisional tip is (device px). */
	readonly tipRect = emptyRect();
	private readonly scratch = emptyRect();
	/** Extra tip points after the builder's pending points: x, y, radius. */
	private extra = new Float64Array(3 * 32);
	private extraCount = 0;
	/** Tip construction state (previous tip point). */
	private tx = 0;
	private ty = 0;
	private tr = 0;
	private tipAny = false;
	private readonly index = new CapsuleIndex();
	/** Capsules looked at by the last tip erase (benchmarks and tests). */
	lastScanned = 0;
	private readonly repaintOne = (i: number) => addCapsule(this.ctx, this.g!.nx, this.g!.ny, this.g!.nr, i, true);

	constructor(readonly canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
		this.ctx = ctx;
	}

	get active(): boolean {
		return this.g !== null;
	}

	get transform(): Readonly<PageTransform> {
		return this.t;
	}

	begin(g: InkBuilder, tool: Tool, color: string, t: PageTransform): void {
		this.clear();
		this.g = g;
		this.tool = tool;
		this.color = color;
		this.t = { ...t };
		this.painted = 0;
		this.index.reset();
		this.extraCount = 0;
	}

	/** Same stroke, new view (zoom, scroll, resize): everything is painted again. */
	setTransform(t: PageTransform): void {
		this.t = { ...t };
		if (!this.g) return;
		this.wipe();
		this.painted = 0;
		this.index.reset();
		this.paint();
	}

	/** Tip points beyond the stored ones: the raw pen position, predicted points (page coordinates). */
	clearExtra(): void {
		this.extraCount = 0;
	}

	pushExtra(x: number, y: number, pressure: number): void {
		const g = this.g;
		if (!g) return;
		const i = this.extraCount * 3;
		if (i + 3 > this.extra.length) {
			const b = new Float64Array(this.extra.length * 2);
			b.set(this.extra);
			this.extra = b;
		}
		this.extra[i] = x;
		this.extra[i + 1] = y;
		this.extra[i + 2] = inkRadius(g.tool, g.width, pressure);
		this.extraCount++;
	}

	/** Paints what became final since the last call and redraws the provisional tip. */
	paint(): void {
		const g = this.g;
		if (!g) return;
		const ctx = this.ctx;
		const t = this.t;
		const cw = this.canvas.width, ch = this.canvas.height;
		ctx.save();
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
		ctx.fillStyle = this.color;
		this.clipToPage();

		// 1. New final capsules, painted once.
		if (this.painted < g.nodeCount) {
			ctx.beginPath();
			for (let i = this.painted; i < g.nodeCount; i++) {
				addCapsule(ctx, g.nx, g.ny, g.nr, i, true);
				this.growInk(g.nx[i]!, g.ny[i]!, g.nr[i]!, cw, ch);
			}
			ctx.fill();
			this.painted = g.nodeCount;
		}

		// 2. Erase the previous tip: clear its rectangle and repaint the final capsules that meet it.
		if (!isEmpty(this.tipRect)) {
			const r = this.tipRect;
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.beginPath();
			ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
			ctx.clip();
			ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
			ctx.setTransform(t.k, 0, 0, t.k, t.tx, t.ty);
			ctx.beginPath();
			this.lastScanned = capsulesIn(g, t, r, this.repaintOne, this.index);
			ctx.fill();
			ctx.restore();
			r.x0 = r.y0 = r.x1 = r.y1 = 0;
		}

		// 3. The new tip, from the last final node.
		const last = g.nodeCount - 1;
		if (last >= 0 && !g.done) {
			this.tx = g.nx[last]!;
			this.ty = g.ny[last]!;
			this.tr = g.nr[last]!;
			this.tipAny = false;
			ctx.beginPath();
			for (let k = g.finalPoint + 1; k < g.count; k++) this.tipStep(g.px[k]!, g.py[k]!, inkRadius(g.tool, g.width, g.pp[k]!), cw, ch);
			for (let k = 0; k < this.extraCount; k++) this.tipStep(this.extra[k * 3]!, this.extra[k * 3 + 1]!, this.extra[k * 3 + 2]!, cw, ch);
			if (this.tipAny) ctx.fill();
			unionInto(this.inkRect, this.tipRect);
		}
		ctx.restore();
	}

	/** Forgets the stroke and clears what it painted. */
	clear(): void {
		this.wipe();
		this.g = null;
		this.painted = 0;
		this.index.reset();
		this.extraCount = 0;
	}

	private wipe(): void {
		const r = this.inkRect;
		unionInto(r, this.tipRect);
		if (!isEmpty(r)) {
			this.ctx.save();
			this.ctx.setTransform(1, 0, 0, 1, 0, 0);
			this.ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
			this.ctx.restore();
		}
		r.x0 = r.y0 = r.x1 = r.y1 = 0;
		const tip = this.tipRect;
		tip.x0 = tip.y0 = tip.x1 = tip.y1 = 0;
	}

	/** One provisional capsule from the previous tip point to (bx, by). */
	private tipStep(bx: number, by: number, br: number, cw: number, ch: number): void {
		const ax = this.tx, ay = this.ty, ar = this.tr;
		if (bx === ax && by === ay) return;
		const ctx = this.ctx;
		addTrapezoid(ctx, ax, ay, ar, bx, by, br);
		ctx.moveTo(bx + br, by);
		ctx.arc(bx, by, br, 0, Math.PI * 2);
		ctx.closePath();
		const s = pageBoxToDevice(this.t, Math.min(ax - ar, bx - br), Math.min(ay - ar, by - br), Math.max(ax + ar, bx + br), Math.max(ay + ar, by + br), cw, ch, this.scratch);
		unionInto(this.tipRect, s);
		this.tx = bx;
		this.ty = by;
		this.tr = br;
		this.tipAny = true;
	}

	private clipToPage(): void {
		const { k, tx, ty, pageW, pageH } = this.t;
		this.ctx.setTransform(k, 0, 0, k, tx, ty);
		this.ctx.beginPath();
		this.ctx.rect(0, 0, pageW, pageH);
		this.ctx.clip();
	}

	private growInk(x: number, y: number, r: number, cw: number, ch: number): void {
		unionInto(this.inkRect, pageBoxToDevice(this.t, x - r, y - r, x + r, y + r, cw, ch, this.scratch));
	}
}
