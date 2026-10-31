// Test helpers for the art engine: a 2D context that logs every call and property write as text.
import type { ImageContext } from "../src/ui/art/generative-art";

export class LoggingContext implements ImageContext {
	log: string[] = [];
	private gradients = 0;
	strokeStyle: string | CanvasGradient | CanvasPattern = "#000";
	fillStyle: string | CanvasGradient | CanvasPattern = "#000";
	lineWidth = 1;
	globalAlpha = 1;
	lineCap: CanvasLineCap = "butt";
	lineJoin: CanvasLineJoin = "miter";

	private rec(name: string, args: ArrayLike<unknown>): void {
		const parts: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			parts.push(typeof a === "number" ? a.toFixed(2) : Array.isArray(a) ? `[${a.join(",")}]` : String(a));
		}
		this.log.push(`${name}(${parts.join(",")})`);
	}

	save(): void {
		this.rec("save", []);
	}
	restore(): void {
		this.rec("restore", []);
	}
	beginPath(): void {
		this.rec("beginPath", []);
	}
	closePath(): void {
		this.rec("closePath", []);
	}
	moveTo(...a: number[]): void {
		this.rec("M", a);
	}
	lineTo(...a: number[]): void {
		this.rec("L", a);
	}
	quadraticCurveTo(...a: number[]): void {
		this.rec("Q", a);
	}
	bezierCurveTo(...a: number[]): void {
		this.rec("C", a);
	}
	arc(...a: Array<number | boolean | undefined>): void {
		this.rec("arc", [a[0], a[1], a[2], a[3], a[4], a[5] === true]);
	}
	ellipse(...a: Array<number | boolean | undefined>): void {
		this.rec("ellipse", [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7] === true]);
	}
	stroke(): void {
		this.rec("stroke", [this.lineWidth, this.globalAlpha, this.lineCap, this.stylePart(this.strokeStyle)]);
	}
	fill(): void {
		this.rec("fill", [this.globalAlpha, this.stylePart(this.fillStyle)]);
	}
	fillRect(...a: number[]): void {
		this.rec("fillRect", a);
	}
	clearRect(...a: number[]): void {
		this.rec("clearRect", a);
	}
	setTransform(...a: number[]): void {
		this.rec("setTransform", a);
	}
	setLineDash(segments: number[]): void {
		this.rec("dash", [segments]);
	}
	private stylePart(v: string | CanvasGradient | CanvasPattern): string {
		if (typeof v === "string") return v;
		return (v as unknown as { tag?: string }).tag ?? "gradient";
	}
	private gradient(kind: string, a: number[]): CanvasGradient {
		const tag = `${kind}#${++this.gradients}:${a.map((n) => n.toFixed(2)).join(",")}`;
		const stops: string[] = [];
		const g = {
			tag,
			addColorStop: (o: number, c: string) => {
				stops.push(`${o.toFixed(3)}=${c}`);
				g.tag = `${tag}[${stops.join("|")}]`;
			},
		};
		const made: unknown = g;
		return made as CanvasGradient;
	}
	createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
		return this.gradient("linear", [x0, y0, x1, y1]);
	}
	createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
		return this.gradient("radial", [x0, y0, r0, x1, y1, r1]);
	}
}
