import { describe, expect, it } from "vitest";
import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";
import { ACTIONS, baseContext } from "../src/ui/actions";
import { ACTION_HELP } from "../src/ui/help-text";
import { contextBoost } from "../src/ui/context-rank";
import {
	CLIP_MAX_PIXELS, CLIP_MAX_SIDE, CLIP_MIN_SCALE, CLIP_SCALE, afterFailure, clipRoutes, clipScale, failureOf, isClipBackground, needsWhite,
} from "../src/ink/clip-image";
import { classifyShareError } from "../src/model/share-page";
import { planArea } from "../src/ink/export-area";
import { layerFlags } from "../src/ink/export-layers";
import { createArea } from "../src/model/area";
import { createDocument, createStroke, quantizePoint } from "../src/model/document";

describe("clipScale", () => {
	it("keeps 2x for an ordinary area", () => {
		expect(clipScale(300, 200)).toEqual({ scale: CLIP_SCALE, capped: false });
	});
	it("lowers the scale so the longest side stays within the limit", () => {
		const { scale, capped } = clipScale(5000, 100);
		expect(capped).toBe(true);
		expect(5000 * scale).toBeLessThanOrEqual(CLIP_MAX_SIDE + 1e-6);
	});
	it("lowers the scale so the pixel count stays within the limit", () => {
		const { scale, capped } = clipScale(2000, 2000);
		expect(capped).toBe(true);
		expect(2000 * scale * 2000 * scale).toBeLessThanOrEqual(CLIP_MAX_PIXELS * 1.0001);
	});
	it("never goes below the minimum and survives bad input", () => {
		expect(clipScale(1e7, 1e7).scale).toBe(CLIP_MIN_SCALE);
		expect(clipScale(Number.NaN, 0).scale).toBe(CLIP_SCALE);
	});
});

describe("routes and fallback", () => {
	it("prefers the image clipboard, then the share sheet, then a saved copy", () => {
		expect(clipRoutes({ imageClipboard: true, shareFiles: true })).toEqual(["clipboard", "share", "save"]);
		expect(clipRoutes({ imageClipboard: false, shareFiles: true })).toEqual(["share", "save"]);
		expect(clipRoutes({ imageClipboard: true, shareFiles: false })).toEqual(["clipboard", "save"]);
	});
	it("always ends with a saved copy, so it never fails silently", () => {
		expect(clipRoutes({ imageClipboard: false, shareFiles: false })).toEqual(["save"]);
	});
	it("moves to the next route on failure, with the one notice for that outcome", () => {
		const routes = clipRoutes({ imageClipboard: true, shareFiles: true });
		expect(afterFailure(routes, "clipboard", "other")).toEqual({ route: "share", notice: "fallback" });
		expect(afterFailure(routes, "share", "other")).toEqual({ route: "save", notice: "fallback" });
		expect(afterFailure(routes, "save", "other")).toEqual({ route: null, notice: "failed" });
		const noShare = clipRoutes({ imageClipboard: true, shareFiles: false });
		expect(afterFailure(noShare, "clipboard", "other")).toEqual({ route: "save", notice: "fallback" });
	});
	it("a closed share sheet stops with its notice, and a share that needs a new tap never saves a file", () => {
		const routes = clipRoutes({ imageClipboard: false, shareFiles: true });
		expect(routes).toEqual(["share", "save"]);
		expect(afterFailure(routes, "share", "cancelled")).toEqual({ route: null, notice: "cancelled" });
		expect(afterFailure(routes, "share", "needs-tap")).toEqual({ route: null, notice: "needsTap" });
		// Every share error class maps to one of the three, and the save route is not offered for a missing tap.
		expect(failureOf(classifyShareError({ name: "AbortError" }))).toBe("cancelled");
		expect(failureOf(classifyShareError({ name: "NotAllowedError" }))).toBe("needs-tap");
		expect(failureOf(classifyShareError({ name: "NotSupportedError" }))).toBe("other");
		expect(failureOf(classifyShareError({ name: "TypeError" }))).toBe("other");
		expect(failureOf(classifyShareError(new Error("boom")))).toBe("other");
		for (const failure of ["cancelled", "needs-tap"] as const) expect(afterFailure(routes, "share", failure).route).toBeNull();
	});
	it("the new-tap notice has both texts", () => {
		expect(enSrc).toContain("\"clipImage.needsTap\"");
		expect(itSrc).toContain("\"clipImage.needsTap\"");
	});
	it("background values", () => {
		expect(isClipBackground("white")).toBe(true);
		expect(isClipBackground("black")).toBe(false);
		expect(needsWhite("white")).toBe(true);
		expect(needsWhite("transparent")).toBe(false);
	});
});

describe("the action", () => {
	const sel = baseContext({ tool: "lasso", selection: { strokes: 2, elements: 0, images: 0 } });
	it("is on the selection bar and in the page menu, with help and both texts", () => {
		const s = ACTIONS.find((a) => a.id === "selection-copy-image")!;
		const p = ACTIONS.find((a) => a.id === "page-copy-image")!;
		expect(s.surfaces).toContain("context");
		expect(s.contexts).toContain("selection");
		expect(p.surfaces).toEqual(expect.arrayContaining(["sheet", "notebook"]));
		expect(contextBoost(s, sel)).toBeGreaterThanOrEqual(25);
		for (const id of [s.id, p.id]) expect(ACTION_HELP[id], id).toBeDefined();
		for (const key of [s.label, p.label, ACTION_HELP[s.id]!, ACTION_HELP[p.id]!, "clipImage.copied", "clipImage.shared", "clipImage.saved", "clipImage.failed"]) {
			expect(enSrc, key).toContain(`"${key}"`);
			expect(itSrc, key).toContain(`"${key}"`);
		}
	});
	it("has something to draw from the same plan as the export", () => {
		const doc = createDocument(new Date());
		const page = doc.pages[0]!;
		expect(planArea(page, null)).toBeNull();
		page.strokes.push(createStroke("#000000", 2, [quantizePoint(10, 10, 0.5), quantizePoint(60, 40, 0.5)]));
		expect(planArea(page, null)?.rect.width).toBeGreaterThan(0);
	});
	it("draws a highlighter area (format 23) like the other exports: it is on the plan and in the ink layer the copy renders", () => {
		const doc = createDocument(new Date());
		const page = doc.pages[0]!;
		const area = createArea([100, 120], [300, 180], page, "#ffd400")!;
		page.elements = [area];
		const whole = planArea(page, null)!;
		expect(whole).not.toBeNull();
		expect(whole.rect.x).toBeLessThanOrEqual(100);
		expect(whole.rect.y).toBeLessThanOrEqual(120);
		expect(whole.rect.x + whole.rect.width).toBeGreaterThanOrEqual(300);
		expect(whole.rect.y + whole.rect.height).toBeGreaterThanOrEqual(180);
		const picked = planArea(page, { strokes: [], elements: [area] })!;
		expect(picked.page.elements).toEqual([area]);
		// "Copy as image" renders with layers: "ink" (transparent), which keeps the content layer where areas are drawn.
		expect(layerFlags("ink").content).toBe(true);
		expect(layerFlags("ink").background).toBe(false);
	});
});
