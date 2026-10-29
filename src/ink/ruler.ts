import { MM } from "../model/types";
import type { Vec } from "./shapes";

/** Straight edge placed on the page: `x`, `y` is the centre (page coordinates, pt), `angle` in radians, `length` in pt. */
export interface Ruler {
	x: number;
	y: number;
	angle: number;
	length: number;
}

/** Default ruler length: 20 cm. */
export const RULER_LENGTH = 200 * MM;

/** Ruler orientation is a line, not an arrow: keep the angle in (-π/2, π/2] so it does not flip while rotating. */
export function normalizeRulerAngle(angle: number): number {
	let a = angle % Math.PI;
	if (a > Math.PI / 2) a -= Math.PI;
	else if (a <= -Math.PI / 2) a += Math.PI;
	return a;
}

/** Ruler placed by two fingers: centred between them, along the line through them. */
export function rulerFromTwoTouches(t1: Vec, t2: Vec, length = RULER_LENGTH): Ruler {
	return {
		x: (t1[0] + t2[0]) / 2,
		y: (t1[1] + t2[1]) / 2,
		angle: normalizeRulerAngle(Math.atan2(t2[1] - t1[1], t2[0] - t1[0])),
		length,
	};
}

/** End points of the working edge (the line through the centre) as [start, end]; start is the left/top end. */
export function rulerEdge(r: Ruler): [[number, number], [number, number]] {
	const dx = (Math.cos(r.angle) * r.length) / 2;
	const dy = (Math.sin(r.angle) * r.length) / 2;
	return [[r.x - dx, r.y - dy], [r.x + dx, r.y + dy]];
}

/**
 * Snaps `p` onto the edge when it is within `snapDistance` of it (perpendicular distance, and not further than
 * `snapDistance` beyond either end); the result is clamped to the edge. Null when `p` is too far.
 */
export function projectToRuler(r: Ruler, p: Vec, snapDistance: number): [number, number] | null {
	const ux = Math.cos(r.angle);
	const uy = Math.sin(r.angle);
	const dx = p[0] - r.x;
	const dy = p[1] - r.y;
	const along = dx * ux + dy * uy;
	const across = -dx * uy + dy * ux;
	const half = r.length / 2;
	if (Math.abs(across) > snapDistance || Math.abs(along) > half + snapDistance) return null;
	const t = Math.max(-half, Math.min(half, along));
	return [r.x + t * ux, r.y + t * uy];
}

export interface RulerTick {
	/** Distance from the start of the edge, pt. */
	along: number;
	/** Position on the edge, page coordinates. */
	x: number;
	y: number;
	kind: "mm" | "half" | "cm";
	/** Suggested tick length, pt (perpendicular to the edge). */
	size: number;
	/** Centimetre number for "cm" ticks. */
	label?: number;
}

/** Tick marks every `mm` millimetres (default 1): every 5th is "half" (5 mm), every 10th is "cm" and labelled. */
export function rulerTicks(r: Ruler, mm = 1): RulerTick[] {
	const out: RulerTick[] = [];
	if (!(mm > 0) || !(r.length > 0)) return out;
	const [start] = rulerEdge(r);
	const ux = Math.cos(r.angle);
	const uy = Math.sin(r.angle);
	const count = Math.min(5000, Math.floor(r.length / (mm * MM) + 1e-9));
	for (let i = 0; i <= count; i++) {
		const along = i * mm * MM;
		const units = Math.round(i * mm * 1000) / 1000; // millimetres from the start
		const isCm = Math.abs(units % 10) < 1e-6;
		const isHalf = !isCm && Math.abs(units % 5) < 1e-6;
		out.push({
			along,
			x: start[0]! + along * ux,
			y: start[1]! + along * uy,
			kind: isCm ? "cm" : isHalf ? "half" : "mm",
			size: isCm ? 9 : isHalf ? 6 : 4,
			...(isCm ? { label: Math.round(units / 10) } : {}),
		});
	}
	return out;
}
