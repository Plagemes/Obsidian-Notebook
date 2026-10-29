import { describe, expect, it } from "vitest";
import { scannedPage, scannedPageSize } from "../src/scan/pages";
import { A4_WIDTH } from "../src/model/types";

describe("scanned pages", () => {
	it("keeps the A4 width and the sheet's aspect ratio", () => {
		const s = scannedPageSize(1000, 1414);
		expect(s.width).toBe(A4_WIDTH);
		expect(s.height / s.width).toBeCloseTo(1.414, 2);
		const wide = scannedPageSize(2000, 1000);
		expect(wide.height).toBeCloseTo(A4_WIDTH / 2, 1);
	});

	it("falls back to A4 for degenerate sizes", () => {
		const s = scannedPageSize(0, 10);
		expect(s.width).toBe(A4_WIDTH);
		expect(s.height).toBeGreaterThan(s.width);
	});

	it("builds a blank page with an image background", () => {
		const asset = { id: "a1", kind: "image", path: "x.jpg", name: "x.jpg", bytes: 1 } as const;
		const page = scannedPage(asset, 800, 600);
		expect(page.background).toEqual({ kind: "image", asset: "a1" });
		expect(page.paper.kind).toBe("blank");
		expect(page.strokes).toEqual([]);
	});
});
