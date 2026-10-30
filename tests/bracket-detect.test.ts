import { describe, expect, it } from "vitest";
import { bracketShape, isOpenPair, openBracketsAt, penLinkCandidate, simplify, type BracketStroke } from "../src/ink/bracket-detect";

type P = [number, number, number];

/** Deterministic pseudo-random jitter so the tests do not depend on luck. */
function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296;
		return s / 4294967296 - 0.5;
	};
}

function poly(corners: Array<[number, number]>, jitter = 0, seed = 1, perSegment = 8): P[] {
	const r = rng(seed);
	const out: P[] = [];
	for (let i = 0; i < corners.length - 1; i++) {
		const [x0, y0] = corners[i]!;
		const [x1, y1] = corners[i + 1]!;
		for (let k = 0; k < perSegment; k++) {
			const t = k / perSegment;
			out.push([x0 + (x1 - x0) * t + r() * jitter, y0 + (y1 - y0) * t + r() * jitter, 0.5]);
		}
	}
	const [lx, ly] = corners[corners.length - 1]!;
	out.push([lx, ly, 0.5]);
	return out;
}

/** "[" with its spine at x, height h, hooks of width hook (to the right). */
function open(x: number, y: number, h: number, hook = h * 0.35, jitter = 0, seed = 1, up = false): P[] {
	const corners: Array<[number, number]> = [[x + hook, y], [x, y], [x, y + h], [x + hook, y + h]];
	return poly(up ? corners.reverse() : corners, jitter, seed);
}

/** "]" with its spine at x, hooks to the left. */
function close(x: number, y: number, h: number, hook = h * 0.35): P[] {
	return poly([[x - hook, y], [x, y], [x, y + h], [x - hook, y + h]]);
}

function stroke(id: string, points: P[], tool: "pen" | "highlighter" | "shape" = "pen"): BracketStroke {
	return { id, tool, points };
}

/** "(" as a smooth arc: spine bulging to the left. */
function paren(x: number, y: number, h: number, bulge = h * 0.3, rightSide = false): P[] {
	const out: P[] = [];
	for (let i = 0; i <= 24; i++) {
		const t = i / 24;
		const dx = Math.sin(t * Math.PI) * bulge;
		out.push([rightSide ? x + dx : x - dx + bulge, y + t * h, 0.5]);
	}
	return out;
}

describe("bracketShape", () => {
	it("recognises a hand-drawn [ in either direction and with wobble", () => {
		expect(bracketShape(open(100, 100, 24))?.side).toBe("open");
		expect(bracketShape(open(100, 100, 24, 8, 0, 1, true))?.side).toBe("open");
		const failed = [];
		for (let seed = 1; seed <= 40; seed++) if (bracketShape(open(100, 100, 26, 9, 1.2, seed))?.side !== "open") failed.push(seed);
		expect(failed).toEqual([]);
	});

	it("tells ] from [", () => {
		expect(bracketShape(close(100, 100, 24))?.side).toBe("close");
	});

	it("accepts slanted hooks and unequal hooks", () => {
		const slanted = poly([[110, 104], [100, 100], [100, 124], [111, 120]]);
		expect(bracketShape(slanted)?.side).toBe("open");
		expect(bracketShape(poly([[112, 100], [100, 100], [100, 124], [106, 124]]))?.side).toBe("open");
	});

	it("rejects plain strokes: l, |, a slash", () => {
		expect(bracketShape(poly([[100, 100], [100, 124]], 0.6))).toBeNull();
		expect(bracketShape(poly([[100, 100], [103, 124]], 0.6))).toBeNull();
		expect(bracketShape(poly([[110, 100], [100, 124]], 0.6))).toBeNull();
	});

	it("rejects 1 (a spine with one flag)", () => {
		expect(bracketShape(poly([[96, 106], [102, 100], [102, 124]]))).toBeNull();
	});

	it("rejects parentheses, drawn smooth", () => {
		expect(bracketShape(paren(100, 100, 24))).toBeNull();
		expect(bracketShape(paren(100, 100, 24, 10))).toBeNull();
		expect(bracketShape(paren(100, 100, 24, 6, true))).toBeNull();
	});

	it("rejects an S, a Z and a square-ish letter", () => {
		expect(bracketShape(poly([[110, 100], [100, 100], [100, 112], [110, 112], [110, 124], [100, 124]]))).toBeNull();
		expect(bracketShape(poly([[100, 100], [110, 100], [100, 124], [110, 124]]))).toBeNull();
		expect(bracketShape(poly([[130, 100], [100, 100], [100, 124], [130, 124]]))).toBeNull();
	});

	it("rejects a brace that is too small or too big", () => {
		expect(bracketShape(open(100, 100, 3))).toBeNull();
		expect(bracketShape(open(100, 100, 400))).toBeNull();
	});
});

describe("open pairs", () => {
	it("reads two [ side by side as [[", () => {
		const strokes = [stroke("a", open(100, 100, 24)), stroke("b", open(112, 101, 23))];
		const pair = openBracketsAt(strokes, 0);
		expect(pair).not.toBeNull();
		expect(isOpenPair(pair!.first, pair!.second)).toBe(true);
	});

	it("does not read [] , ]], or ][ as [[", () => {
		expect(openBracketsAt([stroke("a", open(100, 100, 24)), stroke("b", close(130, 100, 24))], 0)).toBeNull();
		expect(openBracketsAt([stroke("a", close(100, 100, 24)), stroke("b", close(115, 100, 24))], 0)).toBeNull();
		expect(openBracketsAt([stroke("a", close(100, 100, 24)), stroke("b", open(115, 100, 24))], 0)).toBeNull();
	});

	it("does not read l1, ||, or a pair of parentheses", () => {
		const l = stroke("l", poly([[100, 100], [100, 124]], 0.5));
		const one = stroke("1", poly([[108, 106], [114, 100], [114, 124]]));
		expect(openBracketsAt([l, one], 0)).toBeNull();
		expect(openBracketsAt([l, stroke("m", poly([[112, 100], [112, 124]], 0.5))], 0)).toBeNull();
		expect(openBracketsAt([stroke("p", paren(100, 100, 24)), stroke("q", paren(112, 100, 24))], 0)).toBeNull();
	});

	it("does not read brackets of very different size, on different lines, or far apart", () => {
		expect(openBracketsAt([stroke("a", open(100, 100, 24)), stroke("b", open(112, 100, 60))], 0)).toBeNull();
		expect(openBracketsAt([stroke("a", open(100, 100, 24)), stroke("b", open(112, 140, 24))], 0)).toBeNull();
		expect(openBracketsAt([stroke("a", open(100, 100, 24)), stroke("b", open(250, 100, 24))], 0)).toBeNull();
		// The same spot twice (a stroke redrawn over itself).
		expect(openBracketsAt([stroke("a", open(100, 100, 24)), stroke("b", open(101, 100, 24))], 0)).toBeNull();
	});

	it("ignores highlighter and shape strokes", () => {
		expect(openBracketsAt([stroke("a", open(100, 100, 24), "highlighter"), stroke("b", open(112, 100, 24))], 0)).toBeNull();
		expect(openBracketsAt([stroke("a", open(100, 100, 24)), stroke("b", open(112, 100, 24), "shape")], 0)).toBeNull();
	});
});

describe("penLinkCandidate", () => {
	const word = (id: string, x: number): BracketStroke => stroke(id, poly([[x, 106], [x + 6, 118], [x + 10, 106]], 0.3));

	it("offers the brackets just written", () => {
		const c = penLinkCandidate([stroke("t", poly([[10, 10], [60, 12]])), stroke("a", open(100, 100, 24)), stroke("b", open(112, 100, 24))]);
		expect(c?.brackets).toEqual(["a", "b"]);
		expect(c?.strokeIds).toEqual(["a", "b"]);
	});

	it("keeps offering while the name is written to the right on the same line", () => {
		const c = penLinkCandidate([stroke("a", open(100, 100, 24)), stroke("b", open(112, 100, 24)), word("w1", 128), word("w2", 144)]);
		expect(c?.strokeIds).toEqual(["a", "b", "w1", "w2"]);
		expect(c?.bounds.maxX).toBeGreaterThan(150);
	});

	it("stops when the writer moves on: next line, elsewhere or back to the left", () => {
		const base = [stroke("a", open(100, 100, 24)), stroke("b", open(112, 100, 24))];
		expect(penLinkCandidate([...base, stroke("n", poly([[100, 170], [140, 172]]))])).toBeNull();
		expect(penLinkCandidate([...base, stroke("f", poly([[400, 106], [410, 118]]))])).toBeNull();
		expect(penLinkCandidate([...base, stroke("l", poly([[20, 106], [30, 118]]))])).toBeNull();
	});

	it("finds nothing in ordinary writing", () => {
		const text = ["h", "e", "l", "l", "o"].map((c, i) => stroke(c + i, poly([[100 + i * 9, 100], [100 + i * 9, 124]], 0.4)));
		expect(penLinkCandidate(text)).toBeNull();
		expect(penLinkCandidate([])).toBeNull();
	});
});

describe("simplify", () => {
	it("keeps the corners of an L and drops the points on its sides", () => {
		const v = simplify(poly([[0, 0], [0, 20], [15, 20]], 0.1), 1);
		expect(v.length).toBe(3);
	});
});
