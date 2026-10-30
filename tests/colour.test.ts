import { describe, expect, it } from "vitest";
import {
	canvasPixelAt, colourPatch, colourTarget, currentColour, hexToHsv, hexToRgb, hsvToHex, hsvToRgb, normaliseHex, normaliseRecentColours, pickStrokeAt,
	RECENT_COLOURS_MAX, rememberColour, rgbToHex, rgbToHsv, styleOfStroke,
} from "../src/ink/colour";
import { createStroke } from "../src/model/document";
import type { Point } from "../src/model/types";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";

const pts = (...xy: Array<[number, number]>): Point[] => xy.map(([x, y]) => [x, y, 0.5]);

describe("hex colours", () => {
	it("normalises short, upper case and hash-less forms; rejects the rest", () => {
		expect(normaliseHex("#ABC")).toBe("#aabbcc");
		expect(normaliseHex("1E1e1E")).toBe("#1e1e1e");
		expect(normaliseHex("  #00ff7f ")).toBe("#00ff7f");
		for (const bad of ["", "#12", "#12345", "#1234567", "#ggg", "red", "#12 456"]) expect(normaliseHex(bad), bad).toBeNull();
	});

	it("converts hex and rgb both ways", () => {
		expect(hexToRgb("#1d4ed8")).toEqual({ r: 29, g: 78, b: 216 });
		expect(rgbToHex({ r: 29, g: 78, b: 216 })).toBe("#1d4ed8");
		expect(rgbToHex({ r: -5, g: 300, b: 12.4 })).toBe("#00ff0c");
		expect(hexToRgb("nope")).toBeNull();
	});
});

describe("hue, saturation, value", () => {
	it("knows the primaries, white, black and grey", () => {
		expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
		expect(rgbToHsv({ r: 0, g: 255, b: 0 }).h).toBeCloseTo(120);
		expect(rgbToHsv({ r: 0, g: 0, b: 255 }).h).toBeCloseTo(240);
		expect(rgbToHsv({ r: 255, g: 255, b: 255 })).toEqual({ h: 0, s: 0, v: 1 });
		expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
		expect(hsvToHex({ h: 60, s: 1, v: 1 })).toBe("#ffff00");
		expect(hsvToHex({ h: 180, s: 1, v: 0.5 })).toBe("#008080");
		expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
		expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe("#0000ff");
	});

	it("clamps wild input and survives NaN", () => {
		expect(hsvToRgb({ h: 10, s: 5, v: 9 })).toEqual(hsvToRgb({ h: 10, s: 1, v: 1 }));
		expect(hsvToRgb({ h: Number.NaN, s: 0, v: 0.5 })).toEqual({ r: 128, g: 128, b: 128 });
	});

	it("round-trips every colour of a coarse grid through hsv", () => {
		for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
			const hex = rgbToHex({ r, g, b });
			expect(hsvToHex(hexToHsv(hex)!), hex).toBe(hex);
		}
	});
});

describe("recent custom colours", () => {
	it("puts the newest first, once, in lower case", () => {
		let list: string[] = [];
		list = rememberColour(list, "#AA0000");
		list = rememberColour(list, "#00aa00");
		list = rememberColour(list, "#aa0000");
		expect(list).toEqual(["#aa0000", "#00aa00"]);
	});

	it("keeps at most N and ignores invalid colours", () => {
		let list: string[] = [];
		for (let i = 0; i < 30; i++) list = rememberColour(list, rgbToHex({ r: i * 8, g: 0, b: 0 }));
		expect(list).toHaveLength(RECENT_COLOURS_MAX);
		expect(list[0]).toBe("#e80000");
		expect(rememberColour(list, "not a colour")).toEqual(list);
		expect(rememberColour(["#111111", "#222222", "#333333"], "#444444", 3)).toEqual(["#444444", "#111111", "#222222"]);
	});

	it("reads a saved list defensively", () => {
		expect(normaliseRecentColours(undefined)).toEqual([]);
		expect(normaliseRecentColours("#fff")).toEqual([]);
		expect(normaliseRecentColours(["#ABC", 5, null, "#aabbcc", "nope", "#123456"])).toEqual(["#aabbcc", "#123456"]);
		expect(normaliseRecentColours(Array.from({ length: 40 }, (_, i) => rgbToHex({ r: i, g: 0, b: 0 })))).toHaveLength(RECENT_COLOURS_MAX);
	});

	it("is part of the plugin settings with an empty default", () => {
		expect(DEFAULT_SETTINGS.recentColours).toEqual([]);
		expect(readSettings({}).recentColours).toEqual([]);
		expect(readSettings({ recentColours: ["#FF0000", "x", "#ff0000"] }).recentColours).toEqual(["#ff0000"]);
		// One reader result never shares its list with the defaults.
		const a = readSettings({});
		a.recentColours.push("#000000");
		expect(readSettings({}).recentColours).toEqual([]);
	});
});

describe("which colour a tool edits", () => {
	it("pen, shape and text use the pen colour, the highlighter its own, the eraser only when filtering by colour", () => {
		expect(colourTarget("pen", "all")).toBe("pen");
		expect(colourTarget("shape", "all")).toBe("pen");
		expect(colourTarget("highlighter", "all")).toBe("highlighter");
		expect(colourTarget("eraser", "color")).toBe("eraser");
		expect(colourTarget("eraser", "all")).toBe("pen");
		expect(colourTarget("lasso", "all")).toBe("pen");
	});

	it("builds the toolbar change; a tool without a colour switches to the pen", () => {
		expect(colourPatch("pen", "all", "#123456")).toEqual({ penColor: "#123456" });
		expect(colourPatch("highlighter", "all", "#123456")).toEqual({ highlighterColor: "#123456" });
		expect(colourPatch("eraser", "color", "#123456")).toEqual({ eraserColor: "#123456" });
		expect(colourPatch("eraser", "all", "#123456")).toEqual({ tool: "pen", penColor: "#123456" });
		expect(colourPatch("lasso", "all", "#123456")).toEqual({ tool: "pen", penColor: "#123456" });
		const s = { tool: "highlighter", eraserFilter: "all", penColor: "#111111", highlighterColor: "#222222", eraserColor: "#333333" };
		expect(currentColour(s)).toBe("#222222");
		expect(currentColour({ ...s, tool: "eraser", eraserFilter: "color" })).toBe("#333333");
		expect(currentColour({ ...s, tool: "space" })).toBe("#111111");
	});
});

describe("reading a canvas pixel under a point", () => {
	const rect = { left: 100, top: 50, width: 400, height: 300 };

	it("maps CSS px to device px with the ratio of the canvas (dpr 1, 2, 2.625)", () => {
		expect(canvasPixelAt(rect, { width: 400, height: 300 }, 100, 50)).toEqual([0, 0]);
		expect(canvasPixelAt(rect, { width: 400, height: 300 }, 250.7, 100.2)).toEqual([150, 50]);
		expect(canvasPixelAt(rect, { width: 800, height: 600 }, 250, 100)).toEqual([300, 100]);
		expect(canvasPixelAt(rect, { width: 1050, height: 788 }, 300, 200)).toEqual([525, 394]);
	});

	it("follows a canvas that is scaled by CSS or zoom (box not the bitmap size)", () => {
		expect(canvasPixelAt({ left: 0, top: 0, width: 200, height: 100 }, { width: 800, height: 400 }, 50, 25)).toEqual([200, 100]);
	});

	it("is null outside the canvas, on the far edge, or for an empty box", () => {
		expect(canvasPixelAt(rect, { width: 800, height: 600 }, 99.9, 100)).toBeNull();
		expect(canvasPixelAt(rect, { width: 800, height: 600 }, 500, 100)).toBeNull();
		expect(canvasPixelAt(rect, { width: 800, height: 600 }, 300, 351)).toBeNull();
		expect(canvasPixelAt({ left: 0, top: 0, width: 0, height: 10 }, { width: 5, height: 5 }, 0, 0)).toBeNull();
		expect(canvasPixelAt(rect, { width: 800, height: 600 }, Number.NaN, 100)).toBeNull();
	});
});

describe("style eyedropper: which stroke a tap means", () => {
	const wide = createStroke("#facc15", 12, pts([0, 0], [100, 0]), "highlighter");
	const thin = createStroke("#dc2626", 2, pts([0, 0], [100, 0]), "pen");
	const far = createStroke("#1d4ed8", 2, pts([0, 30], [100, 30]), "pen");

	it("takes the stroke under the tap, and none when nothing is near", () => {
		expect(pickStrokeAt([far], 50, 30.5, 1)).toBe(far);
		expect(pickStrokeAt([far], 50, 45, 3)).toBeNull();
		expect(pickStrokeAt([], 0, 0, 5)).toBeNull();
	});

	it("uses the tolerance for a finger a little off a thin line, in page units", () => {
		expect(pickStrokeAt([thin], 50, 4, 1)).toBeNull();
		expect(pickStrokeAt([thin], 50, 4, 3)).toBe(thin);
	});

	it("prefers the topmost stroke whose ink is under the tap", () => {
		expect(pickStrokeAt([wide, thin], 50, 0.5, 2)).toBe(thin);
		expect(pickStrokeAt([thin, wide], 50, 0.5, 2)).toBe(wide);
	});

	it("prefers ink under the tap over a stroke that is only near, even when that one is on top", () => {
		const under = createStroke("#111111", 4, pts([0, 10], [100, 10]));
		const near = createStroke("#222222", 1, pts([0, 12.6], [100, 12.6]));
		expect(pickStrokeAt([under, near], 50, 11.8, 2)).toBe(under);
	});

	it("among strokes that are only near, takes the closest", () => {
		const a = createStroke("#111111", 1, pts([0, 10], [100, 10]));
		const b = createStroke("#222222", 1, pts([0, 14], [100, 14]));
		expect(pickStrokeAt([a, b], 50, 11.5, 5)).toBe(a);
		expect(pickStrokeAt([b, a], 50, 11.5, 5)).toBe(a);
	});

	it("handles a one-point stroke (a dot) and an empty one", () => {
		const dot = createStroke("#333333", 6, pts([10, 10]));
		expect(pickStrokeAt([dot], 12, 10, 0)).toBe(dot);
		expect(pickStrokeAt([dot], 20, 10, 1)).toBeNull();
		expect(pickStrokeAt([createStroke("#333333", 6, [])], 0, 0, 100)).toBeNull();
	});

	it("turns a stroke into the pen to use", () => {
		expect(styleOfStroke(thin)).toEqual({ tool: "pen", penColor: "#dc2626", penWidth: 2 });
		expect(styleOfStroke(wide)).toEqual({ tool: "highlighter", highlighterColor: "#facc15", highlighterWidth: 12 });
		// A shape is taken as a pen (its kind is not stored); odd values are kept in range.
		expect(styleOfStroke({ tool: "shape", color: "#ABCDEF", width: 3.456 })).toEqual({ tool: "pen", penColor: "#abcdef", penWidth: 3.46 });
		expect(styleOfStroke({ tool: "pen", color: "garbage", width: Number.NaN })).toEqual({ tool: "pen", penColor: "#1e1e1e", penWidth: 1 });
		expect(styleOfStroke({ tool: "pen", color: "#000000", width: 500 })).toEqual({ tool: "pen", penColor: "#000000", penWidth: 80 });
	});
});
