import { describe, expect, it } from "vitest";
import {
	cleanStampFormat, DEFAULT_STAMP_FORMAT, formatStamp, MAX_STAMP_FORMAT, PEN_POSITION_MAX_AGE_MS, stampElement, stampSpot,
} from "../src/ink/date-stamp";
import { AddElement, History } from "../src/model/history";
import { createDocument } from "../src/model/document";
import { serializeChecked } from "../src/model/serialize";

// Thursday 29 October 2026, 14:05:09 (local time; the tests only read local fields).
const when = new Date(2026, 9, 29, 14, 5, 9);

describe("date and time stamp format", () => {
	it("formats the default and the common tokens", () => {
		expect(formatStamp(when, DEFAULT_STAMP_FORMAT)).toBe("2026-10-29 14:05");
		expect(formatStamp(when, "DD/MM/YY H:mm:ss")).toBe("29/10/26 14:05:09");
		expect(formatStamp(when, "D.M.YYYY")).toBe("29.10.2026");
		expect(formatStamp(when, "hh:mm A")).toBe("02:05 PM");
		expect(formatStamp(when, "h:mm a")).toBe("2:05 pm");
	});

	it("uses 12 for midnight and noon on a 12 hour clock", () => {
		expect(formatStamp(new Date(2026, 0, 1, 0, 7), "h:mm A")).toBe("12:07 AM");
		expect(formatStamp(new Date(2026, 0, 1, 12, 0), "hh:mm a")).toBe("12:00 pm");
		expect(formatStamp(new Date(2026, 0, 1, 0, 7), "HH:mm")).toBe("00:07");
	});

	it("writes month and weekday names in the given language", () => {
		expect(formatStamp(when, "dddd D MMMM YYYY", "en")).toBe("Thursday 29 October 2026");
		expect(formatStamp(when, "ddd D MMM", "it").toLowerCase()).toBe("gio 29 ott");
		expect(formatStamp(when, "MMMM", "it")).toBe("ottobre");
		// An unknown locale falls back to English instead of throwing.
		expect(formatStamp(when, "MMMM", "not a locale!!")).toBe("October");
	});

	it("copies bracketed text and other characters as they are", () => {
		expect(formatStamp(when, "[Date:] YYYY-MM-DD")).toBe("Date: 2026-10-29");
		expect(formatStamp(when, "[YYYY] YYYY")).toBe("YYYY 2026");
		expect(formatStamp(when, "HH-mm @ #")).toBe("14-05 @ #");
		expect(formatStamp(when, "[]")).toBe("");
	});

	it("pads the year to four digits", () => {
		expect(formatStamp(new Date(2026, 0, 1), "YYYY")).toBe("2026");
	});
});

describe("saved format", () => {
	it("keeps a usable format and falls back to the default", () => {
		expect(cleanStampFormat("DD/MM/YYYY")).toBe("DD/MM/YYYY");
		expect(cleanStampFormat("  HH:mm  ")).toBe("HH:mm");
		expect(cleanStampFormat("")).toBe(DEFAULT_STAMP_FORMAT);
		expect(cleanStampFormat("   ")).toBe(DEFAULT_STAMP_FORMAT);
		expect(cleanStampFormat("[]")).toBe(DEFAULT_STAMP_FORMAT);
		expect(cleanStampFormat(42)).toBe(DEFAULT_STAMP_FORMAT);
		expect(cleanStampFormat(undefined)).toBe(DEFAULT_STAMP_FORMAT);
	});

	it("is one line and limited in length", () => {
		expect(cleanStampFormat("YYYY\nMM")).toBe("YYYY MM");
		expect(cleanStampFormat("Y".repeat(500)).length).toBeLessThanOrEqual(MAX_STAMP_FORMAT);
	});
});

describe("where the stamp goes", () => {
	const pages = [{ width: 595, height: 842 }, { width: 400, height: 500 }];

	it("goes to the last pen position when it is recent and on an existing page", () => {
		const pen = { pageIndex: 1, x: 120, y: 340, at: 1_000 };
		expect(stampSpot(pen, 1_000 + 30_000, pages, 0)).toEqual({ pageIndex: 1, x: 120, y: 340 });
	});

	it("goes to the middle of the page in view when the pen position is old, missing or on a page that is gone", () => {
		expect(stampSpot(null, 5, pages, 1)).toEqual({ pageIndex: 1, x: 200, y: 250 });
		expect(stampSpot({ pageIndex: 0, x: 10, y: 10, at: 0 }, PEN_POSITION_MAX_AGE_MS + 1, pages, 0)).toEqual({ pageIndex: 0, x: 297.5, y: 421 });
		expect(stampSpot({ pageIndex: 9, x: 10, y: 10, at: 100 }, 200, pages, 0)).toEqual({ pageIndex: 0, x: 297.5, y: 421 });
		// A clock that went backwards never trusts the old position.
		expect(stampSpot({ pageIndex: 0, x: 10, y: 10, at: 500 }, 100, pages, 1)).toEqual({ pageIndex: 1, x: 200, y: 250 });
	});

	it("uses the first page when the page in view is unknown, and nothing when there are no pages", () => {
		expect(stampSpot(null, 0, pages, 7)).toEqual({ pageIndex: 0, x: 297.5, y: 421 });
		expect(stampSpot(null, 0, [], 0)).toBeNull();
	});
});

describe("the stamp's text box", () => {
	const page = { width: 300, height: 400 };

	it("is sized to the text and placed at the spot", () => {
		const el = stampElement("2026-10-29 14:05", page, 40, 60, 14, "#1e1e1e", (s, size) => s.length * size * 0.5);
		expect(el.type).toBe("text");
		expect(el.text).toBe("2026-10-29 14:05");
		expect(el.x).toBe(40);
		expect(el.y).toBe(60);
		expect(el.width).toBe(Math.ceil(16 * 14 * 0.5) + 8);
		expect(el.fontSize).toBe(14);
	});

	it("is moved back inside the page and never wider than the page", () => {
		const el = stampElement("x".repeat(100), page, 290, 395, 14, "#000000", (s, size) => s.length * size);
		expect(el.width).toBeLessThanOrEqual(page.width - 16);
		expect(el.x + el.width).toBeLessThanOrEqual(page.width);
		expect(el.y).toBeLessThan(page.height);
		expect(el.x).toBeGreaterThanOrEqual(0);
		const corner = stampElement("hi", page, -50, -50, 14, "#000000");
		expect(corner.x).toBe(0);
		expect(corner.y).toBe(0);
	});

	it("is added to the page as one undo step and the document stays valid", () => {
		const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		const history = new History(() => doc);
		const el = stampElement(formatStamp(when, DEFAULT_STAMP_FORMAT), doc.pages[0]!, 100, 100, 14, "#1e1e1e");
		history.execute(new AddElement(doc.pages[0]!.id, el, doc.pages[0]!.elements?.length ?? 0));
		expect(doc.pages[0]!.elements).toEqual([el]);
		expect(() => serializeChecked(doc)).not.toThrow();
		history.undo();
		expect(doc.pages[0]!.elements ?? []).toHaveLength(0);
		expect(history.canUndo()).toBe(false);
	});
});
