import { describe, expect, it } from "vitest";
import {
	activeFavourite, captureFavourite, DEFAULT_ERASER_SIZE, DEFAULT_FAVOURITES, eraserRadiusPt, favouritePatch,
	FAVOURITE_SLOTS, normaliseEraserSize, normaliseFavourites, stepEraserSize, withFavourite, type PenState,
} from "../src/view/favourites";

const state: PenState = { tool: "pen", penColor: "#1E1E1E", penWidth: 2, highlighterColor: "#facc15", highlighterWidth: 14 };

describe("favourite pens", () => {
	it("always yields six slots, falling back per slot", () => {
		expect(normaliseFavourites(undefined)).toEqual(DEFAULT_FAVOURITES);
		const out = normaliseFavourites([{ tool: "pen", color: "#112233", width: 3 }, null, { tool: "x" }, { tool: "pen", color: "red", width: 1 }]);
		expect(out).toHaveLength(FAVOURITE_SLOTS);
		expect(out[0]).toEqual({ tool: "pen", color: "#112233", width: 3 });
		expect(out[1]).toEqual(DEFAULT_FAVOURITES[1]);
		expect(out[2]).toEqual(DEFAULT_FAVOURITES[2]);
		expect(out[3]).toEqual(DEFAULT_FAVOURITES[3]);
	});
	it("rejects non-positive or absurd widths", () => {
		expect(normaliseFavourites([{ tool: "pen", color: "#000000", width: 0 }])[0]).toEqual(DEFAULT_FAVOURITES[0]);
		expect(normaliseFavourites([{ tool: "pen", color: "#000000", width: 1e9 }])[0]).toEqual(DEFAULT_FAVOURITES[0]);
	});
	it("captures the highlighter or else the pen", () => {
		expect(captureFavourite(state)).toEqual({ tool: "pen", color: "#1e1e1e", width: 2 });
		expect(captureFavourite({ ...state, tool: "eraser" })).toEqual({ tool: "pen", color: "#1e1e1e", width: 2 });
		expect(captureFavourite({ ...state, tool: "highlighter" })).toEqual({ tool: "highlighter", color: "#facc15", width: 14 });
	});
	it("patch selects the tool and its colour and width only", () => {
		expect(favouritePatch({ tool: "highlighter", color: "#4ade80", width: 20 })).toEqual({ tool: "highlighter", highlighterColor: "#4ade80", highlighterWidth: 20 });
		expect(favouritePatch({ tool: "pen", color: "#dc2626", width: 3.2 })).toEqual({ tool: "pen", penColor: "#dc2626", penWidth: 3.2 });
	});
	it("finds the active slot, none for other tools", () => {
		expect(activeFavourite(DEFAULT_FAVOURITES, state)).toBe(0);
		expect(activeFavourite(DEFAULT_FAVOURITES, { ...state, penColor: "#9333ea" })).toBe(-1);
		expect(activeFavourite(DEFAULT_FAVOURITES, { ...state, tool: "lasso" })).toBe(-1);
	});
	it("withFavourite replaces one slot without mutating", () => {
		const pen = { tool: "pen" as const, color: "#9333ea", width: 5 };
		const out = withFavourite(DEFAULT_FAVOURITES, 2, pen);
		expect(out[2]).toEqual(pen);
		expect(DEFAULT_FAVOURITES[2]).not.toEqual(pen);
		expect(withFavourite(DEFAULT_FAVOURITES, 9, pen)).toEqual(DEFAULT_FAVOURITES);
	});
});

describe("eraser size", () => {
	it("defaults and bounds", () => {
		expect(normaliseEraserSize(undefined)).toBe(DEFAULT_ERASER_SIZE);
		expect(normaliseEraserSize(1)).toBe(DEFAULT_ERASER_SIZE);
		expect(normaliseEraserSize(24)).toBe(24);
	});
	it("steps through the presets and stops at the ends", () => {
		expect(stepEraserSize(10, 1)).toBe(16);
		expect(stepEraserSize(10, -1)).toBe(5);
		expect(stepEraserSize(36, 1)).toBe(36);
		expect(stepEraserSize(5, -1)).toBe(5);
		expect(stepEraserSize(12, 1)).toBe(16);
		expect(stepEraserSize(12, -1)).toBe(10);
	});
	it("converts to page units at the current zoom", () => {
		expect(eraserRadiusPt(10, 2)).toBe(5);
		expect(eraserRadiusPt(10, 0)).toBe(10);
	});
});
