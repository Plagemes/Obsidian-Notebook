import { describe, expect, it } from "vitest";
import {
	buildContextPalette, deltaE, DominantCache, dominantColours, isPaperLike, ON_PAGE_MAX, sampleSize, SLIDE_MAX, usedColours, type Raster,
} from "../src/ink/context-palette";

const stroke = (color: string, tool = "pen", fill?: string) => ({ tool, color, ...(fill ? { fill } : {}) });

/** A raster of horizontal bands: `[hex, rows]`. */
function bands(w: number, spec: Array<[string, number]>): Raster {
	const rows = spec.reduce((n, [, r]) => n + r, 0);
	const data = new Uint8ClampedArray(w * rows * 4);
	let y = 0;
	for (const [hex, r] of spec) {
		const v = parseInt(hex.slice(1), 16);
		for (let j = 0; j < r; j++, y++) for (let x = 0; x < w; x++) data.set([(v >> 16) & 255, (v >> 8) & 255, v & 255, 255], (y * w + x) * 4);
	}
	return { width: w, height: rows, data };
}

describe("deltaE", () => {
	it("is 0 for the same colour and large for black against white", () => {
		expect(deltaE("#336699", "#336699")).toBe(0);
		expect(deltaE("#000000", "#ffffff")).toBeGreaterThan(95);
		expect(deltaE("#dc2626", "#d92b2b")).toBeLessThan(8);
		expect(deltaE("#dc2626", "#1d4ed8")).toBeGreaterThan(40);
		expect(deltaE("nope", "#ffffff")).toBe(Infinity);
	});
});

describe("usedColours", () => {
	it("ranks by use, ties by the one used last, and counts fills and elements", () => {
		const used = usedColours({
			strokes: [stroke("#1d4ed8"), stroke("#dc2626"), stroke("#dc2626"), stroke("#15803d", "shape", "#facc15"), stroke("#15803d", "highlighter")],
			elements: [{ type: "text", color: "#000000" }, { type: "area", color: "#facc15" }, { type: "sticky", color: "#ff00ff" }, { type: "image" }],
		});
		expect(used.map((u) => u.hex)).toEqual(["#facc15", "#15803d", "#dc2626", "#000000", "#1d4ed8"]);
		expect(used[0]!.uses).toBe(2);
		expect(used.some((u) => u.hex === "#ff00ff")).toBe(false);
	});

	it("merges near shades into the most used one", () => {
		const used = usedColours({ strokes: [stroke("#dc2626"), stroke("#dc2626"), stroke("#d92b2b"), stroke("#1d4ed8")] });
		expect(used.map((u) => u.hex)).toEqual(["#dc2626", "#1d4ed8"]);
		expect(used[0]!.uses).toBe(3);
	});

	it("is empty for an empty page and ignores invalid colours", () => {
		expect(usedColours({ strokes: [] })).toEqual([]);
		expect(usedColours({ strokes: [stroke("red")], elements: [{ type: "text", color: "" }] })).toEqual([]);
	});

	it("reads a short hex", () => {
		expect(usedColours({ strokes: [stroke("#f00")] })[0]!.hex).toBe("#ff0000");
	});
});

describe("dominantColours", () => {
	it("finds the bands of a synthetic slide, biggest first, without the paper", () => {
		const r = bands(20, [["#ffffff", 30], ["#1e3a8a", 20], ["#f97316", 10], ["#10b981", 4]]);
		const d = dominantColours(r);
		expect(d.map((x) => x.hex)).toEqual(["#1e3a8a", "#f97316", "#10b981"]);
		expect(d[0]!.share).toBeCloseTo(20 / 64, 5);
	});

	it("merges the shades of one band and ignores transparent pixels", () => {
		const r = bands(10, [["#1e3a8a", 10], ["#203c8c", 10]]);
		(r.data as Uint8ClampedArray).fill(0, 0, 40 * 4); // a transparent strip
		const d = dominantColours(r);
		expect(d).toHaveLength(1);
		expect(d[0]!.share).toBeCloseTo(1, 5);
	});

	it("drops specks under the minimum share and caps the list", () => {
		const r = bands(100, [["#1e3a8a", 50], ["#dc2626", 49], ["#00ff00", 1]]);
		expect(dominantColours(r).map((x) => x.hex)).not.toContain("#00ff00");
		const many = bands(10, [["#7f1d1d", 4], ["#1e3a8a", 4], ["#065f46", 4], ["#713f12", 4], ["#4c1d95", 4], ["#831843", 4], ["#0c4a6e", 4], ["#365314", 4]]);
		expect(dominantColours(many, 3)).toHaveLength(3);
		expect(dominantColours(many).length).toBeLessThanOrEqual(SLIDE_MAX);
	});

	it("is empty for a white, empty or short raster", () => {
		expect(dominantColours(bands(8, [["#ffffff", 8]]))).toEqual([]);
		expect(dominantColours({ width: 0, height: 0, data: [] })).toEqual([]);
		expect(dominantColours({ width: 4, height: 4, data: new Uint8ClampedArray(8) })).toEqual([]);
	});

	it("is deterministic", () => {
		const r = bands(16, [["#102a43", 9], ["#f0b429", 5], ["#ffffff", 2]]);
		expect(dominantColours(r)).toEqual(dominantColours(r));
	});

	it("handles a 56 px sample quickly", () => {
		const r = bands(56, [["#1e3a8a", 20], ["#f97316", 20], ["#ffffff", 16]]);
		const t = Date.now();
		dominantColours(r);
		expect(Date.now() - t).toBeLessThan(250);
	});
});

describe("paper and sizes", () => {
	it("knows paper", () => {
		expect(isPaperLike("#ffffff")).toBe(true);
		expect(isPaperLike("#f5f5f4")).toBe(true);
		expect(isPaperLike("#fde047")).toBe(false);
		expect(isPaperLike("#111111")).toBe(false);
	});
	it("sizes the sample", () => {
		expect(sampleSize(1000, 500)).toEqual({ width: 56, height: 28 });
		expect(sampleSize(0, 10)).toEqual({ width: 1, height: 1 });
		expect(sampleSize(1, 1000).width).toBe(1);
	});
});

describe("buildContextPalette", () => {
	const used = [{ hex: "#dc2626", uses: 5 }, { hex: "#1d4ed8", uses: 3 }, { hex: "#15803d", uses: 1 }];
	const slide = [{ hex: "#1e3a8a", share: 0.5 }, { hex: "#f97316", share: 0.2 }, { hex: "#db2d2d", share: 0.1 }];

	it("leaves out what the recent row has", () => {
		const p = buildContextPalette({ used, slide: [], recent: ["#dc2626", "#d92b2b"] });
		expect(p.onPage.map((s) => s.hex)).toEqual(["#1d4ed8", "#15803d"]);
	});

	it("lets the page win over the slide for near colours", () => {
		const p = buildContextPalette({ used, slide, recent: [] });
		expect(p.onPage.map((s) => s.hex)).toEqual(["#dc2626", "#1d4ed8", "#15803d"]);
		expect(p.slide.map((s) => s.hex)).toEqual(["#1e3a8a", "#f97316"]);
	});

	it("has no near duplicates in a row and caps the rows", () => {
		const p = buildContextPalette({ used: [{ hex: "#dc2626", uses: 2 }, { hex: "#d92b2b", uses: 1 }], slide: [], recent: [] });
		expect(p.onPage).toHaveLength(1);
		const wide = Array.from({ length: 30 }, (_, i) => ({ hex: `#${((i * 8) % 256).toString(16).padStart(2, "0")}${((i * 40) % 256).toString(16).padStart(2, "0")}${((i * 90) % 256).toString(16).padStart(2, "0")}`, uses: 1 }));
		expect(buildContextPalette({ used: wide, slide: [], recent: [] }).onPage.length).toBeLessThanOrEqual(ON_PAGE_MAX);
	});

	it("labels a colour that has a meaning", () => {
		const p = buildContextPalette({ used, slide: [], recent: [], labelOf: (h) => (h === "#dc2626" ? "Definition" : undefined) });
		expect(p.onPage[0]).toEqual({ hex: "#dc2626", label: "Definition" });
		expect(p.onPage[1]).toEqual({ hex: "#1d4ed8" });
	});

	it("gives empty rows when nothing is left", () => {
		expect(buildContextPalette({ used: [], slide: [], recent: [] })).toEqual({ onPage: [], slide: [] });
	});
});

describe("DominantCache", () => {
	it("keeps the most recently used pages", () => {
		const c = new DominantCache(2);
		c.set("a", []);
		c.set("b", []);
		c.get("a");
		c.set("c", []);
		expect(c.get("b")).toBeUndefined();
		expect(c.get("a")).toBeDefined();
		expect(c.size).toBe(2);
	});
});
