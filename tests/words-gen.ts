import { createStroke } from "../src/model/document";
import type { Point, Stroke, Tool } from "../src/model/types";

/** Deterministic synthetic handwriting for the word-segmentation tests and benchmark. */
let seed = 7;
export const reseed = (n: number) => { seed = n; };
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 0x100000000;
};

const ASC = new Set("bdfhklt");
const DESC = new Set("gjpqy");
const LOW = new Set("aceimnorsuvwxz");

export interface LineSpec {
	x: number;
	baseY: number;
	H?: number;
	slope?: number;
	letterGap?: number;
	wordGap?: number;
	tool?: Tool;
}

/** Synthetic handwriting: one stroke per letter (zigzag), ids "tag:wordIndex:letterIndex". */
export function writeLine(tag: string, text: string, spec: LineSpec): Stroke[] {
	const H = spec.H ?? 16;
	const slope = spec.slope ?? 0;
	let x = spec.x;
	const out: Stroke[] = [];
	text.split(" ").forEach((word, wi) => {
		[...word].forEach((ch, li) => {
			const w = H * (0.35 + 0.25 * rand());
			const base = spec.baseY + slope * (x - spec.x);
			const top = ASC.has(ch) ? base - H : LOW.has(ch) || DESC.has(ch) ? base - 0.55 * H : base - H;
			const bottom = DESC.has(ch) ? base + 0.45 * H : base;
			const pts: Point[] = [];
			for (let k = 0; k < 6; k++) pts.push([x + (w * k) / 5, k % 2 ? bottom : top, 0.5]);
			const s = createStroke("#000000", 1.5, pts, spec.tool ?? "pen");
			s.id = `${tag}:${wi}:${li}`;
			out.push(s);
			x += w + H * (spec.letterGap ?? 0.12) * (0.5 + rand());
		});
		x += H * (spec.wordGap ?? 0.9);
	});
	return out;
}

