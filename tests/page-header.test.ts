import { describe, expect, it } from "vitest";
import { createPage } from "../src/model/document";
import { buildLecturePage } from "../src/view/lecture-logic";
import { pageToSvg } from "../src/ink/export-svg";
import { pagesToPdf } from "../src/ink/export-pdf";
import {
	bandTaken, exportHeaderFor, headerLayout, headerText, HEADER_BAND, HEADER_SIDE, isHeaderAlign, isHeaderMode,
	type HeaderNotebook, type HeaderSettings,
} from "../src/ink/page-header";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import type { TextElement } from "../src/model/types";

const nb: HeaderNotebook = { title: "  Physics   II ", createdAt: "2026-06-03T09:30:00.000Z", locale: "en" };
const base: HeaderSettings = { headerMode: "header", headerPageNumber: true, headerPageTotal: true, headerDate: false, headerTitle: false, headerAlign: "centre", headerInExport: true };
const on = (o: Partial<HeaderSettings>): HeaderSettings => ({ ...base, ...o });
const page = () => createPage({ width: 595, height: 842 });

describe("headerText", () => {
	it("shows the page number with or without the total", () => {
		expect(headerText(base, nb, 2, 12)).toBe("3 / 12");
		expect(headerText(on({ headerPageTotal: false }), nb, 2, 12)).toBe("3");
	});
	it("joins title, date and number, in that order, with the title cleaned", () => {
		const text = headerText(on({ headerTitle: true, headerDate: true }), nb, 0, 4);
		expect(text.startsWith("Physics II · ")).toBe(true);
		expect(text).toMatch(/· \d{1,2} Jun 2026 · 1 \/ 4$/);
	});
	it("leaves out a date that cannot be read and gives nothing when no field is left", () => {
		expect(headerText(on({ headerDate: true }), { ...nb, createdAt: "x" }, 0, 1)).toBe("1 / 1");
		expect(headerText(on({ headerPageNumber: false }), nb, 0, 1)).toBe("");
		expect(headerText(on({ headerTitle: true, headerPageNumber: false }), { ...nb, title: " " }, 0, 1)).toBe("");
	});
});

describe("headerLayout", () => {
	it("is nothing when off or empty", () => {
		expect(headerLayout(page(), 0, 1, on({ headerMode: "off" }), nb)).toBeNull();
		expect(headerLayout(page(), 0, 1, on({ headerPageNumber: false }), nb)).toBeNull();
	});
	it("puts the line at the top or the bottom and aligns it left, centre or right", () => {
		const p = page();
		const top = headerLayout(p, 0, 3, base, nb)!;
		expect(top.footer).toBe(false);
		expect(top.y).toBeLessThan(HEADER_BAND);
		expect(top.x).toBe(p.width / 2);
		const foot = headerLayout(p, 0, 3, on({ headerMode: "footer", headerAlign: "right" }), nb)!;
		expect(foot.footer).toBe(true);
		expect(foot.y).toBeGreaterThan(p.height - HEADER_BAND);
		expect(foot.x).toBe(p.width - HEADER_SIDE);
		expect(headerLayout(p, 0, 3, on({ headerAlign: "left" }), nb)!.x).toBe(HEADER_SIDE);
	});
	it("is not stored: it only reads the page", () => {
		const p = page();
		const before = JSON.stringify(p);
		headerLayout(p, 0, 3, base, nb);
		expect(JSON.stringify(p)).toBe(before);
	});
	it("skips pages with a PDF or picture background, unless it has margins", () => {
		const p = page();
		p.background = { kind: "pdf", asset: "a", page: 1 } as never;
		expect(headerLayout(p, 0, 1, base, nb)).toBeNull();
		p.margins = { left: 0, right: 0, bottom: 0 };
		expect(headerLayout(p, 0, 1, base, nb)).not.toBeNull();
	});
	it("does not draw a footer on an infinite page", () => {
		const p = page();
		p.infinite = true;
		expect(headerLayout(p, 0, 1, on({ headerMode: "footer" }), nb)).not.toBeNull();
		// The top is taken too: nowhere to go.
		p.elements = [textAt(5)];
		expect(headerLayout(p, 0, 1, on({ headerMode: "footer" }), nb)).toBeNull();
	});
});

function textAt(y: number): TextElement {
	return { id: "t", type: "text", x: 28, y, width: 400, text: "Title", fontSize: 16, color: "#000" };
}

describe("lecture header (#210)", () => {
	it("is clear of the strip on a lecture page, so both show", () => {
		const lecture = buildLecturePage(undefined, "Physics", new Date(2026, 5, 3));
		expect(bandTaken(lecture, false)).toBe(false);
		const h = headerLayout(lecture, 0, 5, base, nb)!;
		expect(h.footer).toBe(false);
	});
	it("shifts to the other edge when an element reaches into the strip, and skips when both are taken", () => {
		const p = page();
		p.elements = [textAt(8)];
		expect(headerLayout(p, 0, 1, base, nb)!.footer).toBe(true);
		p.elements.push(textAt(p.height - 20));
		expect(headerLayout(p, 0, 1, base, nb)).toBeNull();
	});
});

describe("exports", () => {
	it("puts the line in the SVG background layer and not in the ink layer", () => {
		const p = page();
		const h = headerLayout(p, 1, 3, base, nb)!;
		expect(pageToSvg(p, { header: h })).toContain(">2 / 3</text>");
		expect(pageToSvg(p, { header: null })).not.toContain("<text");
		expect(pageToSvg(p, { header: h, layers: "ink" })).not.toContain("2 / 3");
	});
	it("writes the text into the PDF content", () => {
		const p = page();
		const h = headerLayout(p, 0, 9, base, nb)!;
		const withHeader = new TextDecoder("latin1").decode(pagesToPdf([p], { header: () => h }));
		const without = new TextDecoder("latin1").decode(pagesToPdf([p]));
		expect(withHeader).toContain("(1 / 9) Tj");
		expect(without).not.toContain("(1 / 9) Tj");
	});
});

describe("settings", () => {
	it("defaults to off and reads leniently", () => {
		expect(DEFAULT_SETTINGS.headerMode).toBe("off");
		const s = readSettings({ headerMode: "footer", headerAlign: "nope", headerDate: "yes", headerTitle: true });
		expect(s.headerMode).toBe("footer");
		expect(s.headerAlign).toBe(DEFAULT_SETTINGS.headerAlign);
		expect(s.headerDate).toBe(DEFAULT_SETTINGS.headerDate);
		expect(s.headerTitle).toBe(true);
		expect(isHeaderMode("header") && isHeaderAlign("centre") && !isHeaderMode("x")).toBe(true);
	});
});

describe("exportHeaderFor", () => {
	it("is off when the header is off or kept out of exports", () => {
		const pages = [page()];
		expect(exportHeaderFor(pages, on({ headerMode: "off" }), nb)).toBeUndefined();
		expect(exportHeaderFor(pages, on({ headerInExport: false }), nb)).toBeUndefined();
	});
	it("numbers a page by its place in the notebook, also for a live state view of it (same id, other object)", () => {
		const pages = [page(), page(), page()];
		const header = exportHeaderFor(pages, base, nb)!;
		expect(header(pages[1]!)?.text).toBe("2 / 3");
		const view = Object.create(pages[2]!, { strokes: { enumerable: true, get: () => [] } }) as typeof pages[number];
		expect(view).not.toBe(pages[2]);
		expect(header(view)?.text).toBe("3 / 3");
		expect(header(page())).toBeNull();
	});
});
