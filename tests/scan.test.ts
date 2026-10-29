import { describe, expect, it } from "vitest";
import {
	applyHomography,
	detectDocument,
	enhanceDocument,
	enhanceWhiteboard,
	homography,
	orderCorners,
	outputSize,
	rotate90,
	rotatePoint90,
	toGray,
	warpPerspective,
	type ImageDataLike,
	type Pt,
	type Quad,
} from "../src/scan";

function makeImage(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): ImageDataLike {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const [r, g, b] = fn(x, y);
			const i = (y * w + x) * 4;
			data[i] = r;
			data[i + 1] = g;
			data[i + 2] = b;
			data[i + 3] = 255;
		}
	}
	return { data, width: w, height: h };
}

function pointInQuad(p: Pt, q: readonly Pt[]): boolean {
	let sign = 0;
	for (let i = 0; i < q.length; i++) {
		const a = q[i]!;
		const b = q[(i + 1) % q.length]!;
		const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
		if (c === 0) continue;
		if (sign === 0) sign = Math.sign(c);
		else if (Math.sign(c) !== sign) return false;
	}
	return true;
}

function noise(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

describe("homography", () => {
	const src: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
	const dst: Quad = [{ x: 10, y: 5 }, { x: 90, y: 12 }, { x: 110, y: 70 }, { x: -5, y: 60 }];

	it("maps the four points exactly", () => {
		const h = homography(src, dst);
		for (let i = 0; i < 4; i++) {
			const p = applyHomography(h, src[i]!.x, src[i]!.y);
			expect(p.x).toBeCloseTo(dst[i]!.x, 6);
			expect(p.y).toBeCloseTo(dst[i]!.y, 6);
		}
	});

	it("is invertible", () => {
		const fwd = homography(src, dst);
		const back = homography(dst, src);
		for (const [x, y] of [[0, 0], [50, 25], [100, 50], [17, 33]] as const) {
			const p = applyHomography(fwd, x, y);
			const q = applyHomography(back, p.x, p.y);
			expect(q.x).toBeCloseTo(x, 6);
			expect(q.y).toBeCloseTo(y, 6);
		}
	});

	it("rejects degenerate input", () => {
		const line: Quad = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
		expect(() => homography(line, dst)).toThrow();
	});
});

describe("warpPerspective", () => {
	it("rectifies a white quadrilateral on a dark background to all white", () => {
		const quad: Quad = [{ x: 60, y: 40 }, { x: 250, y: 55 }, { x: 270, y: 190 }, { x: 45, y: 170 }];
		const img = makeImage(320, 240, (x, y) => (pointInQuad({ x, y }, quad) ? [255, 255, 255] : [20, 20, 20]));
		// Inset the corners by a pixel so edge anti-aliasing of the synthetic image cannot leak in.
		const inner: Quad = [{ x: 62, y: 43 }, { x: 247, y: 57 }, { x: 267, y: 188 }, { x: 48, y: 168 }];
		const { width, height } = outputSize(inner, 400);
		const out = warpPerspective(img, inner, width, height);
		expect(out.width).toBe(width);
		let min = 255;
		for (let i = 0; i < out.data.length; i += 4) min = Math.min(min, out.data[i]!, out.data[i + 1]!, out.data[i + 2]!);
		expect(min).toBeGreaterThanOrEqual(250);
	});

	it("is the identity for the full-frame rectangle", () => {
		const img = makeImage(20, 10, (x, y) => [x * 10, y * 20, 7]);
		const out = warpPerspective(img, [{ x: 0, y: 0 }, { x: 19, y: 0 }, { x: 19, y: 9 }, { x: 0, y: 9 }], 20, 10);
		expect(Array.from(out.data)).toEqual(Array.from(img.data));
	});
});

describe("outputSize", () => {
	it("uses the average side lengths", () => {
		const q: Quad = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }];
		expect(outputSize(q, 1000)).toEqual({ width: 200, height: 100 });
	});

	it("caps the longest side and keeps the aspect ratio", () => {
		const q: Quad = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }];
		expect(outputSize(q, 2000)).toEqual({ width: 2000, height: 1500 });
	});

	it("averages unequal opposite sides", () => {
		const q: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 120, y: 50 }, { x: -20, y: 50 }];
		expect(outputSize(q, 1000)).toEqual({ width: 120, height: 54 });
	});
});

describe("orderCorners", () => {
	it("returns tl, tr, br, bl whatever the input order", () => {
		const tl = { x: 10, y: 10 };
		const tr = { x: 200, y: 20 };
		const br = { x: 210, y: 150 };
		const bl = { x: 0, y: 140 };
		const perms = [[tl, tr, br, bl], [br, tl, bl, tr], [bl, br, tr, tl], [tr, bl, tl, br], [tl, bl, br, tr]];
		for (const p of perms) expect(orderCorners(p)).toEqual([tl, tr, br, bl]);
	});

	it("handles a page rotated by about 40 degrees", () => {
		const a = (40 * Math.PI) / 180;
		const rot = (x: number, y: number): Pt => ({ x: 300 + x * Math.cos(a) - y * Math.sin(a), y: 300 + x * Math.sin(a) + y * Math.cos(a) });
		const pts = [rot(-100, -60), rot(100, -60), rot(100, 60), rot(-100, 60)];
		const ordered = orderCorners([pts[2]!, pts[0]!, pts[3]!, pts[1]!]);
		// The top-left of the result has the smallest x + y.
		const sums = ordered.map((p) => p.x + p.y);
		expect(sums[0]).toBe(Math.min(...sums));
		// Orientation is clockwise on screen: every consecutive cross product is positive.
		for (let i = 0; i < 4; i++) {
			const o = ordered[i]!, p = ordered[(i + 1) % 4]!, q = ordered[(i + 2) % 4]!;
			expect((p.x - o.x) * (q.y - p.y) - (p.y - o.y) * (q.x - p.x)).toBeGreaterThan(0);
		}
	});

	it("rejects a wrong number of points", () => {
		expect(() => orderCorners([{ x: 0, y: 0 }])).toThrow();
	});
});

describe("rotate90", () => {
	it("rotates pixels and points consistently", () => {
		const img = makeImage(6, 4, (x, y) => [x * 30, y * 50, 0]);
		for (const cw of [true, false]) {
			const out = rotate90(img, cw);
			expect([out.width, out.height]).toEqual([4, 6]);
			for (const [x, y] of [[0, 0], [5, 0], [5, 3], [2, 1]] as const) {
				// Point coordinates are continuous: a pixel centre is (x + 0.5, y + 0.5).
				const p = rotatePoint90({ x: x + 0.5, y: y + 0.5 }, 6, 4, cw);
				const i = (Math.floor(p.y) * out.width + Math.floor(p.x)) * 4;
				expect([out.data[i], out.data[i + 1]]).toEqual([x * 30, y * 50]);
			}
		}
		const back = rotate90(rotate90(img, true), false);
		expect(Array.from(back.data)).toEqual(Array.from(img.data));
	});
});

describe("detectDocument", () => {
	const W = 640;
	const H = 480;

	function rotatedRect(angleDeg: number, cx: number, cy: number, hw: number, hh: number): Quad {
		const a = (angleDeg * Math.PI) / 180;
		const rot = (x: number, y: number): Pt => ({ x: cx + x * Math.cos(a) - y * Math.sin(a), y: cy + x * Math.sin(a) + y * Math.cos(a) });
		return [rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)];
	}

	it("finds a rotated bright rectangle within a few percent", () => {
		const truth = rotatedRect(12, 330, 240, 200, 150);
		const gray = new Uint8ClampedArray(W * H);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[y * W + x] = pointInQuad({ x, y }, truth) ? 225 : 60;
		const found = detectDocument(gray, W, H);
		expect(found).not.toBeNull();
		const tol = 0.03 * Math.hypot(W, H);
		const expected = orderCorners(truth);
		for (let i = 0; i < 4; i++) {
			expect(Math.hypot(found![i]!.x - expected[i]!.x, found![i]!.y - expected[i]!.y)).toBeLessThan(tol);
		}
	});

	it("tolerates mild noise and text on the page", () => {
		const truth = rotatedRect(-8, 320, 250, 210, 160);
		const rnd = noise(7);
		const gray = new Uint8ClampedArray(W * H);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const inside = pointInQuad({ x, y }, truth);
				const ink = inside && (y % 24 < 4) && x % 60 > 10;
				gray[y * W + x] = (ink ? 70 : inside ? 215 : 70) + (rnd() - 0.5) * 24;
			}
		}
		const found = detectDocument(gray, W, H);
		expect(found).not.toBeNull();
		const expected = orderCorners(truth);
		for (let i = 0; i < 4; i++) {
			expect(Math.hypot(found![i]!.x - expected[i]!.x, found![i]!.y - expected[i]!.y)).toBeLessThan(0.04 * Math.hypot(W, H));
		}
	});

	it("returns null on noise", () => {
		const rnd = noise(42);
		const gray = new Uint8ClampedArray(W * H);
		for (let i = 0; i < gray.length; i++) gray[i] = rnd() * 255;
		expect(detectDocument(gray, W, H)).toBeNull();
	});

	it("returns null on a flat image", () => {
		expect(detectDocument(new Uint8ClampedArray(W * H).fill(128), W, H)).toBeNull();
	});
});

describe("enhanceDocument", () => {
	it("turns a shaded page with dark text into white paper and dark text", () => {
		const w = 300;
		const h = 200;
		const isText = (x: number, y: number) => y % 40 >= 18 && y % 40 < 22 && x > 30 && x < 270 && x % 20 < 14;
		// Paper brightness falls from 235 to 110 across the page.
		const img = makeImage(w, h, (x, y) => {
			const paper = 235 - (125 * x) / w;
			const v = isText(x, y) ? paper * 0.3 : paper;
			return [v, v, v * 0.95];
		});
		const out = enhanceDocument(img);
		let paperN = 0, paperWhite = 0, textN = 0, textDark = 0;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const v = out.data[(y * w + x) * 4]!;
				if (isText(x, y)) {
					textN++;
					if (v < 60) textDark++;
				} else if (x > 40 && x < 260) {
					// Skip the immediate neighbourhood of ink, which is softened on purpose.
					let near = false;
					for (let d = -2; d <= 2 && !near; d++) near = isText(x, y + d) || isText(x + d, y);
					if (near) continue;
					paperN++;
					if (v > 245) paperWhite++;
				}
			}
		}
		expect(paperWhite / paperN).toBeGreaterThan(0.99);
		expect(textDark / textN).toBeGreaterThan(0.9);
		expect(out.data[3]).toBe(255);
		expect(out.data[0]).toBe(out.data[1]);
	});
});

describe("enhanceWhiteboard", () => {
	it("flattens a shadow gradient and keeps marker strokes", () => {
		const w = 320;
		const h = 200;
		const isStroke = (x: number, y: number) => Math.abs(y - 100) < 3 && x > 40 && x < 280;
		const img = makeImage(w, h, (x, y) => {
			const light = 0.45 + (0.5 * x) / w; // 0.45 .. 0.95
			const base = 235 * light;
			return isStroke(x, y) ? [20 * light, 40 * light, 180 * light] : [base, base, base * 0.97];
		});
		const out = enhanceWhiteboard(img);
		const bgLuma = (px: number, py: number) => toGray({ data: out.data.subarray((py * w + px) * 4, (py * w + px) * 4 + 4), width: 1, height: 1 })[0]!;
		const left = bgLuma(10, 20);
		const right = bgLuma(w - 10, 20);
		const input = toGray(img);
		expect(input[20 * w + w - 10]! - input[20 * w + 10]!).toBeGreaterThan(80);
		expect(Math.abs(right - left)).toBeLessThan(12);
		expect(left).toBeGreaterThan(235);
		// The stroke stays clearly darker than the board and is still bluish.
		const si = (100 * w + 160) * 4;
		expect(out.data[si + 2]!).toBeGreaterThan(out.data[si]! + 40);
		expect(bgLuma(160, 100)).toBeLessThan(left - 100);
	});
});
