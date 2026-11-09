/**
 * 0.22 (pens, #35): the pen kinds in the toolbar state, the favourites and the pen sets, the defaults in the settings, the style
 * eyedropper and the nib of a new stroke. Pure logic only (the toolbar itself is checked by the harness and by hand).
 */
import { describe, expect, it } from "vitest";
import { styleOfStroke } from "../src/ink/colour";
import { isPenKind, kindHasNib, kindTool, normaliseNib, PEN_KINDS, strokeNib } from "../src/ink/pen-kinds";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { settingSpecs } from "../src/view/settings-schema";
import { activeFavourite, captureFavourite, DEFAULT_FAVOURITES, favouritePatch, favouriteToolKey, normaliseFavourites, sameFavourite, validPen, type FavouritePen, type PenState } from "../src/view/favourites";
import { cloneSet, normalisePenSets } from "../src/view/pen-sets";
import { en } from "../src/i18n/en";
import { it as itMessages } from "../src/i18n/it";
import { TOOLS } from "../src/model/types";

const state = (over: Partial<PenState> = {}): PenState => ({ tool: "pen", penColor: "#1e1e1e", penWidth: 2, highlighterColor: "#facc15", highlighterWidth: 14, ...over });

describe("pen kinds", () => {
	it("every kind is a tool of the document, and the highlighter is not a kind", () => {
		for (const k of PEN_KINDS) expect(TOOLS).toContain(kindTool(k));
		expect(PEN_KINDS).toEqual(["pen", "fountain", "brush", "marker"]);
		expect(isPenKind("highlighter")).toBe(false);
		expect(isPenKind("brush")).toBe(true);
		expect(isPenKind(3)).toBe(false);
	});

	it("only the fountain pen and the marker have a nib", () => {
		expect(PEN_KINDS.filter(kindHasNib)).toEqual(["fountain", "marker"]);
	});

	it("folds the nib angle into whole degrees [0, 179]", () => {
		expect(normaliseNib(45)).toBe(45);
		expect(normaliseNib(180)).toBe(0);
		expect(normaliseNib(-30)).toBe(150);
		expect(normaliseNib(44.6)).toBe(45);
		expect(normaliseNib(359.9)).toBe(0);
		expect(normaliseNib("x")).toBe(45);
		expect(normaliseNib(NaN)).toBe(45);
		expect(normaliseNib(undefined)).toBe(45);
	});

	it("a new stroke stores a nib only for the nib pens and only when it is not the default", () => {
		expect(strokeNib("fountain", 45)).toBeUndefined();
		expect(strokeNib("fountain", 120)).toBe(120);
		expect(strokeNib("marker", 200)).toBe(20);
		expect(strokeNib("brush", 120)).toBeUndefined();
		expect(strokeNib("pen", 120)).toBeUndefined();
		expect(strokeNib("highlighter", 10)).toBeUndefined();
	});
});

describe("favourite pens and pen sets with the new pens", () => {
	const fountain: FavouritePen = { tool: "pen", color: "#1d4ed8", width: 2.4, kind: "fountain", nib: 120 };

	it("a plain favourite reads and captures as before", () => {
		expect(validPen({ tool: "pen", color: "#DC2626", width: 3 })).toEqual({ tool: "pen", color: "#dc2626", width: 3 });
		expect(captureFavourite(state({ penKind: "pen", nibAngle: 120 }))).toEqual({ tool: "pen", color: "#1e1e1e", width: 2 });
		expect(captureFavourite(state())).toEqual({ tool: "pen", color: "#1e1e1e", width: 2 });
		expect(normaliseFavourites(undefined)).toEqual(DEFAULT_FAVOURITES);
	});

	it("keeps the kind and the nib of a new pen", () => {
		expect(validPen(fountain)).toEqual(fountain);
		expect(captureFavourite(state({ penKind: "fountain", nibAngle: 120 }))).toEqual({ tool: "pen", color: "#1e1e1e", width: 2, kind: "fountain", nib: 120 });
		// The default angle is left out; a brush has none.
		expect(captureFavourite(state({ penKind: "fountain", nibAngle: 45 }))).toEqual({ tool: "pen", color: "#1e1e1e", width: 2, kind: "fountain" });
		expect(captureFavourite(state({ penKind: "brush", nibAngle: 120 }))).toEqual({ tool: "pen", color: "#1e1e1e", width: 2, kind: "brush" });
		expect(validPen({ tool: "pen", color: "#000000", width: 2, kind: "brush", nib: 30 })).toEqual({ tool: "pen", color: "#000000", width: 2, kind: "brush" });
	});

	it("reads an invalid kind or nib as a ballpoint pen / the default angle, never as a failure", () => {
		expect(validPen({ tool: "pen", color: "#000000", width: 2, kind: "quill" })).toEqual({ tool: "pen", color: "#000000", width: 2 });
		expect(validPen({ tool: "pen", color: "#000000", width: 2, kind: "pen" })).toEqual({ tool: "pen", color: "#000000", width: 2 });
		expect(validPen({ tool: "highlighter", color: "#facc15", width: 14, kind: "brush" })).toEqual({ tool: "highlighter", color: "#facc15", width: 14 });
		expect(validPen({ tool: "pen", color: "#000000", width: 2, kind: "marker", nib: "x" })).toEqual({ tool: "pen", color: "#000000", width: 2, kind: "marker" });
		expect(validPen({ tool: "pen", color: "#000000", width: 2, kind: "fountain", nib: 45 })).toEqual({ tool: "pen", color: "#000000", width: 2, kind: "fountain" });
	});

	it("selecting a favourite sets the kind and the nib, a plain one goes back to the ballpoint pen", () => {
		expect(favouritePatch(fountain)).toEqual({ tool: "pen", penColor: "#1d4ed8", penWidth: 2.4, penKind: "fountain", nibAngle: 120, penOpacity: 1 });
		expect(favouritePatch({ tool: "pen", color: "#000000", width: 2 })).toMatchObject({ penKind: "pen", nibAngle: 45 });
		expect(favouritePatch({ tool: "highlighter", color: "#facc15", width: 14 })).not.toHaveProperty("penKind");
	});

	it("tells a fountain pen from a ballpoint pen of the same colour and width, and finds the active slot", () => {
		const plain: FavouritePen = { tool: "pen", color: "#1d4ed8", width: 2.4 };
		expect(sameFavourite(plain, fountain)).toBe(false);
		expect(sameFavourite(fountain, { ...fountain })).toBe(true);
		expect(sameFavourite({ ...fountain, nib: undefined }, { ...fountain, nib: 45 })).toBe(true);
		const favs = [plain, fountain];
		expect(activeFavourite(favs, state({ penColor: "#1d4ed8", penWidth: 2.4 }))).toBe(0);
		expect(activeFavourite(favs, state({ penColor: "#1d4ed8", penWidth: 2.4, penKind: "fountain", nibAngle: 120 }))).toBe(1);
		expect(activeFavourite(favs, state({ penColor: "#1d4ed8", penWidth: 2.4, penKind: "fountain", nibAngle: 90 }))).toBe(-1);
	});

	it("names the pen of a favourite", () => {
		expect(favouriteToolKey({ tool: "pen", color: "#000000", width: 1 })).toBe("tool.pen");
		expect(favouriteToolKey({ tool: "highlighter", color: "#000000", width: 1 })).toBe("tool.highlighter");
		for (const kind of ["fountain", "brush", "marker"] as const) {
			const key = favouriteToolKey({ tool: "pen", color: "#000000", width: 1, kind });
			expect(key).toBe(`tool.${kind}`);
			expect(key in en).toBe(true);
			expect(key in itMessages).toBe(true);
		}
	});

	it("a pen set keeps the kinds and the nib through reading and copying", () => {
		const sets = normalisePenSets([{ id: "mine", name: "Calligraphy", pens: [fountain, { tool: "pen", color: "#000000", width: 2, kind: "bad" }, { tool: "pen", color: "#000000", width: 4, kind: "marker" }] }]);
		expect(sets).toHaveLength(1);
		expect(sets[0]!.pens).toEqual([fountain, { tool: "pen", color: "#000000", width: 2 }, { tool: "pen", color: "#000000", width: 4, kind: "marker" }]);
		expect(cloneSet(sets[0]!).pens).toEqual(sets[0]!.pens);
		expect(cloneSet(sets[0]!).pens[0]).not.toBe(sets[0]!.pens[0]);
	});
});

describe("settings", () => {
	it("default to the ballpoint pen at 45 degrees and read leniently", () => {
		expect(DEFAULT_SETTINGS.defaultPenKind).toBe("pen");
		expect(DEFAULT_SETTINGS.defaultNibAngle).toBe(45);
		expect(readSettings({ defaultPenKind: "brush", defaultNibAngle: 100 })).toMatchObject({ defaultPenKind: "brush", defaultNibAngle: 100 });
		expect(readSettings({ defaultPenKind: "quill", defaultNibAngle: "wide" })).toMatchObject({ defaultPenKind: "pen", defaultNibAngle: 45 });
		expect(readSettings({ defaultNibAngle: -45 }).defaultNibAngle).toBe(135);
		expect(readSettings(null)).toMatchObject({ defaultPenKind: "pen", defaultNibAngle: 45 });
	});

	it("are in the writing section, with a nib angle that shows only for the pens that have one", () => {
		const kind = settingSpecs().find((s) => s.id === "defaultPenKind");
		const nib = settingSpecs().find((s) => s.id === "defaultNibAngle");
		expect(kind?.section).toBe("writing");
		expect(nib?.section).toBe("writing");
		const visible = (pen: string) => nib?.visible?.({ ...DEFAULT_SETTINGS, defaultPenKind: pen as never }, { sync: false, timetable: false, timetableInUse: false });
		expect(visible("pen")).toBe(false);
		expect(visible("brush")).toBe(false);
		expect(visible("fountain")).toBe(true);
		expect(visible("marker")).toBe(true);
	});
});

describe("style eyedropper", () => {
	it("taking a stroke of a new pen selects that pen and its nib", () => {
		expect(styleOfStroke({ tool: "fountain", color: "#112233", width: 2, nib: 100 })).toEqual({ tool: "pen", penColor: "#112233", penWidth: 2, penKind: "fountain", nibAngle: 100, penOpacity: 1 });
		expect(styleOfStroke({ tool: "marker", color: "#112233", width: 6 })).toEqual({ tool: "pen", penColor: "#112233", penWidth: 6, penKind: "marker", nibAngle: 45, penOpacity: 1 });
		expect(styleOfStroke({ tool: "brush", color: "#112233", width: 6 })).toMatchObject({ penKind: "brush" });
	});

	it("a ballpoint or shape stroke selects the ballpoint again, so an eyedropper never keeps the fountain pen", () => {
		expect(styleOfStroke({ tool: "pen", color: "#112233", width: 2 })).toEqual({ tool: "pen", penColor: "#112233", penWidth: 2, penKind: "pen", nibAngle: 45, penOpacity: 1 });
		expect(styleOfStroke({ tool: "shape", color: "#112233", width: 2 })).toEqual({ tool: "pen", penColor: "#112233", penWidth: 2, penKind: "pen", nibAngle: 45, penOpacity: 1 });
		expect(styleOfStroke({ tool: "highlighter", color: "#facc15", width: 14 })).toEqual({ tool: "highlighter", highlighterColor: "#facc15", highlighterWidth: 14, highlighterOpacity: 1 });
	});
});
