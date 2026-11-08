import { describe, expect, it } from "vitest";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import {
	anchorFor, AWAY_SCREENS, gapScreens, isBackInView, RETURN_AT, returnY, shouldShowBack, slideNumberOf, tracksWrite, type ShowInput,
} from "../src/model/slide-back";

const view = { top: 1000, bottom: 2000 };
const base: ShowInput = { enabled: true, spot: { top: 100, bottom: 200 }, view, shown: false, dismissed: false };

describe("gapScreens", () => {
	it("is 0 when the spot overlaps or touches the view", () => {
		expect(gapScreens({ top: 900, bottom: 1100 }, view)).toBe(0);
		expect(gapScreens({ top: 1200, bottom: 1300 }, view)).toBe(0);
		expect(gapScreens({ top: 900, bottom: 1000 }, view)).toBe(0);
	});
	it("counts view heights above and below", () => {
		expect(gapScreens({ top: 100, bottom: 500 }, view)).toBeCloseTo(0.5);
		expect(gapScreens({ top: 3500, bottom: 3600 }, view)).toBeCloseTo(1.5);
	});
	it("is 0 for an empty view", () => {
		expect(gapScreens({ top: 0, bottom: 1 }, { top: 5, bottom: 5 })).toBe(0);
	});
});

describe("shouldShowBack", () => {
	it("shows when the spot is a screen or more away", () => {
		expect(shouldShowBack(base)).toBe(true);
	});
	it("ignores tiny scrolls: less than half a screen away does not show", () => {
		expect(shouldShowBack({ ...base, spot: { top: 400, bottom: 600 } })).toBe(false);
		expect(shouldShowBack({ ...base, spot: { top: 400, bottom: 1000 - AWAY_SCREENS * 1000 + 0 } })).toBe(true);
	});
	it("keeps showing while the spot is out of view (no flicker at the threshold), hides once it is visible", () => {
		const near = { top: 500, bottom: 700 };
		expect(shouldShowBack({ ...base, spot: near, shown: false })).toBe(false);
		expect(shouldShowBack({ ...base, spot: near, shown: true })).toBe(true);
		expect(shouldShowBack({ ...base, spot: { top: 900, bottom: 1100 }, shown: true })).toBe(false);
	});
	it("is off when the setting is off, nothing was written or the user closed it", () => {
		expect(shouldShowBack({ ...base, enabled: false })).toBe(false);
		expect(shouldShowBack({ ...base, spot: null })).toBe(false);
		expect(shouldShowBack({ ...base, dismissed: true, shown: true })).toBe(false);
	});
});

describe("isBackInView", () => {
	it("is true when there is no spot or it is visible", () => {
		expect(isBackInView(null, view)).toBe(true);
		expect(isBackInView({ top: 1500, bottom: 1600 }, view)).toBe(true);
		expect(isBackInView({ top: 0, bottom: 10 }, view)).toBe(false);
	});
});

describe("returnY", () => {
	it("is 0 when the page fits in the view", () => {
		expect(returnY({ bottom: 300 }, 800, 1000)).toBe(0);
	});
	it("puts the written spot at the return fraction of the view", () => {
		expect(returnY({ bottom: 2000 }, 4000, 1000)).toBeCloseTo(2000 - 1000 * RETURN_AT);
	});
	it("stays inside the page", () => {
		expect(returnY({ bottom: 100 }, 4000, 1000)).toBe(0);
		expect(returnY({ bottom: 3990 }, 4000, 1000)).toBe(3000);
		expect(returnY({ bottom: 500 }, 4000, 0)).toBe(0);
	});
});

describe("what counts as writing", () => {
	it("any ink in the lecture mode, only slide ink otherwise", () => {
		expect(tracksWrite(true, {})).toBe(true);
		expect(tracksWrite(false, {})).toBe(false);
		expect(tracksWrite(false, { slide: "abc12345" })).toBe(true);
	});
});

describe("anchorFor and slideNumberOf", () => {
	const stroke = (y: number) => createStroke("#000", 2, [quantizePoint(10, y, 0.5), quantizePoint(50, y + 20, 0.5)]);

	it("takes the spot of the newest of the given strokes, with the slide of its link", () => {
		const doc = createDocument(new Date("2026-11-05T09:00:00Z"));
		const page = createPage();
		const a = stroke(100);
		const b = { ...stroke(300), slide: "s1" };
		page.strokes.push(a, b);
		doc.pages = [page];
		doc.slides = [{ id: "s1", source: "pdf1", page: 7 }];
		const anchor = anchorFor(doc, page, new Set([a.id, b.id]), true);
		expect(anchor?.pageId).toBe(page.id);
		expect(anchor?.slide).toBe(7);
		expect(anchor!.top).toBeLessThanOrEqual(300);
		expect(anchor!.bottom).toBeGreaterThanOrEqual(320);
	});
	it("uses the page's own PDF page when the ink has no slide link", () => {
		const doc = createDocument(new Date("2026-11-05T09:00:00Z"));
		const page = createPage();
		page.background = { kind: "pdf", asset: "x", page: 4 };
		const s = stroke(50);
		page.strokes.push(s);
		doc.pages = [page];
		expect(anchorFor(doc, page, new Set([s.id]), true)?.slide).toBe(4);
		expect(slideNumberOf(doc, page, s)).toBe(4);
	});
	it("has no slide on a plain page, and nothing when the ink does not count", () => {
		const doc = createDocument(new Date("2026-11-05T09:00:00Z"));
		const page = createPage();
		const s = stroke(50);
		page.strokes.push(s);
		doc.pages = [page];
		expect(anchorFor(doc, page, new Set([s.id]), true)?.slide).toBeNull();
		expect(anchorFor(doc, page, new Set([s.id]), false)).toBeNull();
		expect(anchorFor(doc, page, new Set(["missing"]), true)).toBeNull();
	});
	it("ignores a link to a slide that is not in the table", () => {
		const doc = createDocument(new Date("2026-11-05T09:00:00Z"));
		const page = createPage();
		const s = { ...stroke(50), slide: "gone" };
		expect(slideNumberOf(doc, page, s)).toBeNull();
	});
});
