// Recording the art as a flat list of numbers, to be drawn later (in a Worker with an OffscreenCanvas). Pure logic.
//
// The families run on the calling thread against a `RecordingCanvasContext`, which only appends numbers to an array:
// that is much cheaper than driving a real canvas context. The array (plus a small table of colour strings) is then
// posted to a worker that replays it on an OffscreenCanvas and encodes the PNG, so the rasterising and the encoding,
// which are the slow parts, never run on the UI thread.
import type { ImageContext } from "./generative-art";

/** The recorded drawing: every op is a code followed by its arguments; colour strings live in `strings`. */
export interface Recording {
	ops: number[];
	strings: string[];
}

/** Op codes. `replayOps` below uses the same numbers: keep them in step (a test replays a recording and compares). */
const SAVE = 1, RESTORE = 2, BEGIN = 3, CLOSE = 4, MOVE = 5, LINE = 6, QUAD = 7, BEZIER = 8, ARC = 9, ELLIPSE = 10, STROKE = 11, FILL = 12,
	FILL_RECT = 13, CLEAR_RECT = 14, TRANSFORM = 15, DASH = 16, LINEAR = 17, RADIAL = 18, STOP = 19, STROKE_STR = 20, STROKE_GRAD = 21,
	FILL_STR = 22, FILL_GRAD = 23, WIDTH = 24, ALPHA = 25, CAP = 26, JOIN = 27;

const CAPS: CanvasLineCap[] = ["butt", "round", "square"];
const JOINS: CanvasLineJoin[] = ["round", "bevel", "miter"];

class RecordedGradient {
	constructor(readonly id: number, private readonly rec: RecordingCanvasContext) {}
	addColorStop(offset: number, colour: string): void {
		this.rec.stop(this.id, offset, colour);
	}
}

/** A 2D context that records instead of drawing. Implements what the art and the image functions use. */
export class RecordingCanvasContext implements ImageContext {
	readonly ops: number[] = [];
	readonly strings: string[] = [];
	private readonly stringIndex = new Map<string, number>();
	private gradients = 0;
	private stroke_: string | CanvasGradient | CanvasPattern = "#000";
	private fill_: string | CanvasGradient | CanvasPattern = "#000";
	private width_ = 1;
	private alpha_ = 1;
	private cap_: CanvasLineCap = "butt";
	private join_: CanvasLineJoin = "miter";

	private str(s: string): number {
		let i = this.stringIndex.get(s);
		if (i === undefined) {
			i = this.strings.length;
			this.strings.push(s);
			this.stringIndex.set(s, i);
		}
		return i;
	}

	stop(id: number, offset: number, colour: string): void {
		this.ops.push(STOP, id, offset, this.str(colour));
	}

	/** The recording so far. */
	recording(): Recording {
		return { ops: this.ops, strings: this.strings };
	}

	get strokeStyle(): string | CanvasGradient | CanvasPattern {
		return this.stroke_;
	}
	set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
		this.stroke_ = v;
		if (v instanceof RecordedGradient) this.ops.push(STROKE_GRAD, v.id);
		else this.ops.push(STROKE_STR, this.str(typeof v === "string" ? v : "#000"));
	}
	get fillStyle(): string | CanvasGradient | CanvasPattern {
		return this.fill_;
	}
	set fillStyle(v: string | CanvasGradient | CanvasPattern) {
		this.fill_ = v;
		if (v instanceof RecordedGradient) this.ops.push(FILL_GRAD, v.id);
		else this.ops.push(FILL_STR, this.str(typeof v === "string" ? v : "#000"));
	}
	get lineWidth(): number {
		return this.width_;
	}
	set lineWidth(v: number) {
		this.width_ = v;
		this.ops.push(WIDTH, v);
	}
	get globalAlpha(): number {
		return this.alpha_;
	}
	set globalAlpha(v: number) {
		this.alpha_ = v;
		this.ops.push(ALPHA, v);
	}
	get lineCap(): CanvasLineCap {
		return this.cap_;
	}
	set lineCap(v: CanvasLineCap) {
		this.cap_ = v;
		this.ops.push(CAP, Math.max(0, CAPS.indexOf(v)));
	}
	get lineJoin(): CanvasLineJoin {
		return this.join_;
	}
	set lineJoin(v: CanvasLineJoin) {
		this.join_ = v;
		this.ops.push(JOIN, Math.max(0, JOINS.indexOf(v)));
	}
	save(): void {
		this.ops.push(SAVE);
	}
	restore(): void {
		this.ops.push(RESTORE);
	}
	beginPath(): void {
		this.ops.push(BEGIN);
	}
	closePath(): void {
		this.ops.push(CLOSE);
	}
	moveTo(x: number, y: number): void {
		this.ops.push(MOVE, x, y);
	}
	lineTo(x: number, y: number): void {
		this.ops.push(LINE, x, y);
	}
	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
		this.ops.push(QUAD, cx, cy, x, y);
	}
	bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
		this.ops.push(BEZIER, c1x, c1y, c2x, c2y, x, y);
	}
	arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void {
		this.ops.push(ARC, x, y, r, a0, a1, ccw ? 1 : 0);
	}
	ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw?: boolean): void {
		this.ops.push(ELLIPSE, x, y, rx, ry, rot, a0, a1, ccw ? 1 : 0);
	}
	stroke(): void {
		this.ops.push(STROKE);
	}
	fill(): void {
		this.ops.push(FILL);
	}
	fillRect(x: number, y: number, w: number, h: number): void {
		this.ops.push(FILL_RECT, x, y, w, h);
	}
	clearRect(x: number, y: number, w: number, h: number): void {
		this.ops.push(CLEAR_RECT, x, y, w, h);
	}
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.ops.push(TRANSFORM, a, b, c, d, e, f);
	}
	setLineDash(segments: number[]): void {
		this.ops.push(DASH, segments.length, ...segments);
	}
	createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
		const id = this.gradients++;
		this.ops.push(LINEAR, id, x0, y0, x1, y1);
		return new RecordedGradient(id, this);
	}
	createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
		const id = this.gradients++;
		this.ops.push(RADIAL, id, x0, y0, r0, x1, y1, r1);
		return new RecordedGradient(id, this);
	}
}

/** The part of a 2D context (a canvas's or an OffscreenCanvas's) that a recording uses. */
export interface ReplayGradient {
	addColorStop(offset: number, colour: string): void;
}
export interface ReplayContext {
	strokeStyle: unknown;
	fillStyle: unknown;
	lineWidth: number;
	globalAlpha: number;
	lineCap: string;
	lineJoin: string;
	save(): void;
	restore(): void;
	beginPath(): void;
	closePath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
	bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
	arc(x: number, y: number, r: number, a0: number, a1: number, ccw: boolean): void;
	ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw: boolean): void;
	stroke(): void;
	fill(): void;
	fillRect(x: number, y: number, w: number, h: number): void;
	clearRect(x: number, y: number, w: number, h: number): void;
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	setLineDash(segments: number[]): void;
	createLinearGradient(x0: number, y0: number, x1: number, y1: number): ReplayGradient;
	createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): ReplayGradient;
}

/**
 * Draws a recording on a 2D context. SELF-CONTAINED ON PURPOSE: the worker is built from this function's source text
 * (`replayOps.toString()`), so it must not use anything outside itself (no imports, no constants of this module, no
 * helpers the compiler might inject). The numbers are the op codes above.
 */
export function replayOps(ctx: ReplayContext, ops: number[], strings: string[]): void {
	const gradients: ReplayGradient[] = [];
	const caps = ["butt", "round", "square"], joins = ["round", "bevel", "miter"];
	const n = ops.length;
	let i = 0;
	while (i < n) {
		const code = ops[i++]!;
		switch (code) {
			case 1: ctx.save(); break;
			case 2: ctx.restore(); break;
			case 3: ctx.beginPath(); break;
			case 4: ctx.closePath(); break;
			case 5: ctx.moveTo(ops[i]!, ops[i + 1]!); i += 2; break;
			case 6: ctx.lineTo(ops[i]!, ops[i + 1]!); i += 2; break;
			case 7: ctx.quadraticCurveTo(ops[i]!, ops[i + 1]!, ops[i + 2]!, ops[i + 3]!); i += 4; break;
			case 8: ctx.bezierCurveTo(ops[i]!, ops[i + 1]!, ops[i + 2]!, ops[i + 3]!, ops[i + 4]!, ops[i + 5]!); i += 6; break;
			case 9: ctx.arc(ops[i]!, ops[i + 1]!, ops[i + 2]!, ops[i + 3]!, ops[i + 4]!, ops[i + 5] === 1); i += 6; break;
			case 10: ctx.ellipse(ops[i]!, ops[i + 1]!, ops[i + 2]!, ops[i + 3]!, ops[i + 4]!, ops[i + 5]!, ops[i + 6]!, ops[i + 7] === 1); i += 8; break;
			case 11: ctx.stroke(); break;
			case 12: ctx.fill(); break;
			case 13: ctx.fillRect(ops[i]!, ops[i + 1]!, ops[i + 2]!, ops[i + 3]!); i += 4; break;
			case 14: ctx.clearRect(ops[i]!, ops[i + 1]!, ops[i + 2]!, ops[i + 3]!); i += 4; break;
			case 15: ctx.setTransform(ops[i]!, ops[i + 1]!, ops[i + 2]!, ops[i + 3]!, ops[i + 4]!, ops[i + 5]!); i += 6; break;
			case 16: {
				const count = ops[i++]!;
				ctx.setLineDash(ops.slice(i, i + count));
				i += count;
				break;
			}
			case 17: gradients[ops[i]!] = ctx.createLinearGradient(ops[i + 1]!, ops[i + 2]!, ops[i + 3]!, ops[i + 4]!); i += 5; break;
			case 18: gradients[ops[i]!] = ctx.createRadialGradient(ops[i + 1]!, ops[i + 2]!, ops[i + 3]!, ops[i + 4]!, ops[i + 5]!, ops[i + 6]!); i += 7; break;
			case 19: gradients[ops[i]!]!.addColorStop(ops[i + 1]!, strings[ops[i + 2]!]!); i += 3; break;
			case 20: ctx.strokeStyle = strings[ops[i]!]!; i += 1; break;
			case 21: ctx.strokeStyle = gradients[ops[i]!]; i += 1; break;
			case 22: ctx.fillStyle = strings[ops[i]!]!; i += 1; break;
			case 23: ctx.fillStyle = gradients[ops[i]!]; i += 1; break;
			case 24: ctx.lineWidth = ops[i]!; i += 1; break;
			case 25: ctx.globalAlpha = ops[i]!; i += 1; break;
			case 26: ctx.lineCap = caps[ops[i]!]!; i += 1; break;
			case 27: ctx.lineJoin = joins[ops[i]!]!; i += 1; break;
			default: throw new Error("bad op " + code);
		}
	}
}

/** The pieces of a worker scope that `workerMain` uses (real: `self`, `OffscreenCanvas`, `FileReaderSync`). */
export interface WorkerScope {
	onmessage: ((e: { data: WorkerRequest }) => void) | null;
	postMessage(message: { id: number; url?: string; error?: string }): void;
}
export interface WorkerRequest {
	id: number;
	pw: number;
	ph: number;
	dpr: number;
	ops: number[];
	strings: string[];
}
interface OffscreenLike {
	getContext(type: "2d"): ReplayContext | null;
	convertToBlob(options: { type: string }): Promise<unknown>;
}

/**
 * The message handler of the worker. SELF-CONTAINED like `replayOps` (its source text goes into the worker): it receives
 * `{ id, pw, ph, dpr, ops, strings }`, replays the recording on an OffscreenCanvas of pw x ph device pixels (scaled by
 * dpr), encodes a PNG and answers `{ id, url }` (a data URL, made with the worker-only FileReaderSync) or `{ id, error }`.
 * Taking its globals as arguments is what lets the tests run it in Node with fakes.
 */
export function workerMain(
	scope: WorkerScope,
	Offscreen: new (w: number, h: number) => OffscreenLike,
	Reader: new () => { readAsDataURL(blob: unknown): string },
	replay: (ctx: ReplayContext, ops: number[], strings: string[]) => void,
): void {
	scope.onmessage = (e) => {
		const m = e.data;
		const fail = (err: unknown): void => {
			scope.postMessage({ id: m.id, error: String(err instanceof Error ? err.message : err) });
		};
		try {
			const canvas = new Offscreen(m.pw, m.ph);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("no 2d context");
			ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
			replay(ctx, m.ops, m.strings);
			canvas.convertToBlob({ type: "image/png" }).then((blob) => {
				scope.postMessage({ id: m.id, url: new Reader().readAsDataURL(blob) });
			}, fail);
		} catch (err) {
			fail(err);
		}
	};
}

/** The source of the worker script (see `workerMain`): both functions as text, then the call with the worker's globals. */
export function workerSource(): string {
	return [
		"const replay=" + replayOps.toString() + ";",
		"const main=" + workerMain.toString() + ";",
		"main(self,OffscreenCanvas,FileReaderSync,replay);",
	].join("\n");
}
