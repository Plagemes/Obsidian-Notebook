// 0.28 (#184): timing of the paint bucket on the largest masks it will ever see (`npm run bench`, not part of `npm test`).
import { describe, expect, it } from "vitest";
import { MAX_CELLS, bucketWindow, paintBucket } from "../src/ink/paint-bucket";

function mask(cols: number, rows: number, draw: (set: (x: number, y: number) => void) => void): Uint8Array {
	const m = new Uint8Array(cols * rows);
	draw((x, y) => {
		if (x >= 0 && y >= 0 && x < cols && y < rows) m[y * cols + x] = 1;
	});
	return m;
}

describe("paint bucket timing", () => {
	it("a page-sized area with ink scattered in it (the cell cap)", () => {
		const w = bucketWindow(595, 842, 300, 400);
		const s = w.scale;
		const m = mask(w.cols, w.rows, (set) => {
			const x0 = Math.floor(30 * s), x1 = Math.floor(565 * s), y0 = Math.floor(30 * s), y1 = Math.floor(812 * s), t = Math.ceil(1.2 * s);
			for (let x = x0; x <= x1; x++) for (let k = 0; k < t; k++) { set(x, y0 + k); set(x, y1 - k); }
			for (let y = y0; y <= y1; y++) for (let k = 0; k < t; k++) { set(x0 + k, y); set(x1 - k, y); }
			// 4000 short strokes inside, like a page of handwriting
			for (let n = 0; n < 4000; n++) {
				const cx = Math.floor((60 + ((n * 37) % 480)) * s), cy = Math.floor((60 + ((n * 91) % 700)) * s);
				for (let k = 0; k < 14 * s; k++) set(cx + k, cy + (k % 3));
			}
		});
		expect(w.cols * w.rows).toBeLessThanOrEqual(MAX_CELLS);
		const t0 = performance.now();
		const r = paintBucket({ mask: m, cols: w.cols, rows: w.rows, scale: s, originX: 0, originY: 0, x: 300, y: 20 + 30 });
		const ms = performance.now() - t0;
		expect(r.ok).toBe(true);
		expect(ms).toBeLessThan(1500);
	});

	it("an area that is not closed gives up at the first touch of the edge, long before the budget", () => {
		const w = bucketWindow(595, 842, 300, 400);
		const m = new Uint8Array(w.cols * w.rows);
		const t0 = performance.now();
		const r = paintBucket({ mask: m, cols: w.cols, rows: w.rows, scale: w.scale, originX: 0, originY: 0, x: 300, y: 400 });
		const ms = performance.now() - t0;
		expect(r).toEqual({ ok: false, reason: "open" });
		expect(ms).toBeLessThan(1500);
	});
});
