import { describe, expect, it } from "vitest";
import { burnPixelRects, burnPlan, coveredExcerpt, cutStroke, hasRedactions, headerAfterRedaction, metaWithoutRedactedTitles, outsideRuns, pessimisticMeasure, redactBounds, redactionOf, redactPage, redactPages, redactReach } from "../src/ink/redact";
import { layoutText } from "../src/ink/text-layout";
import { cleanPageForExport } from "../src/model/clean-export";
import { pageTexts } from "../src/model/export-markdown";
import { liveStateView, pageCopy } from "../src/model/states";
import { addBox, boxFromDrag, boxesOf, cleanBox, clearPage, countBoxes, countPages, isArmed, normaliseRedactions, pointToPage, removeBox, removeLast, REDACT_MAX_PER_PAGE, REDACT_MAX_TOTAL, type Redactions } from "../src/model/redact";
import { A4_HEIGHT, A4_WIDTH, PAPER_SPACING, RENDER_INK, type NotebookMeta, type Page, type PageElement, type Point, type Stroke } from "../src/model/types";

const box = { x: 100, y: 100, width: 100, height: 40 };

/** The last item of a list that is not empty. */
function last<T>(items: readonly T[]): T {
	return items[items.length - 1]!;
}

function stroke(id: string, points: Array<[number, number]>, extra: Partial<Stroke> = {}): Stroke {
	return { id, tool: "pen", color: "#1e1e1e", width: 2, render: RENDER_INK, points: points.map(([x, y]): Point => [x, y, 0.5]), ...extra };
}

function page(extra: Partial<Page> = {}): Page {
	return { id: "p1", width: A4_WIDTH, height: A4_HEIGHT, paper: { kind: "ruled", spacing: PAPER_SPACING.ruled }, strokes: [], ...extra };
}

const text = (id: string, x: number, y: number, body = "SECRET name", width = 150): PageElement => ({ id, type: "text", x, y, width, text: body, fontSize: 14, color: "#000000" });

describe("the redaction model", () => {
	it("accepts a box only when it is a usable rectangle", () => {
		expect(cleanBox({ x: 1.234, y: 2, width: 30, height: 20 })).toEqual({ x: 1.23, y: 2, width: 30, height: 20 });
		expect(cleanBox({ x: 1, y: 2, width: 3, height: 20 })).toBeNull();
		expect(cleanBox({ x: NaN, y: 2, width: 30, height: 20 })).toBeNull();
		expect(cleanBox({ x: 1e9, y: 2, width: 30, height: 20 })).toBeNull();
		expect(cleanBox("box")).toBeNull();
		expect(cleanBox(null)).toBeNull();
	});

	it("reads a stored set leniently and keeps it bounded", () => {
		const good = { x: 1, y: 2, width: 30, height: 20 };
		const read = normaliseRedactions({ p1: [good, good, { x: 1 }, 7], "bad id!": [good], p2: "no", p3: [] });
		expect(read).toEqual({ p1: [good] });
		expect(normaliseRedactions(null)).toEqual({});
		expect(normaliseRedactions([good])).toEqual({});
		const many = Array.from({ length: REDACT_MAX_PER_PAGE + 20 }, (_, i) => ({ x: i, y: 0, width: 20, height: 20 }));
		expect(boxesOf(normaliseRedactions({ p1: many }), "p1")).toHaveLength(REDACT_MAX_PER_PAGE);
		const wide: Record<string, unknown> = {};
		for (let i = 0; i < 100; i++) wide[`page${i}`] = many.slice(0, 30);
		expect(countBoxes(normaliseRedactions(wide))).toBeLessThanOrEqual(REDACT_MAX_TOTAL);
		expect(normaliseRedactions({ p1: [good], p2: [good] }, new Set(["p2"]))).toEqual({ p2: [good] });
	});

	it("adds, removes and clears boxes without changing the set it was given", () => {
		const a = { x: 10, y: 10, width: 40, height: 40 };
		const b = { x: 60, y: 60, width: 40, height: 40 };
		const one: Redactions = addBox({}, "p1", a);
		const two = addBox(one, "p1", b);
		expect(one).toEqual({ p1: [a] });
		expect(two).toEqual({ p1: [a, b] });
		expect(addBox(two, "p1", a)).toBe(two);
		expect(addBox(two, "p1", { x: 0, y: 0, width: 2, height: 2 })).toBe(two);
		expect(removeBox(two, "p1", 0)).toEqual({ p1: [b] });
		expect(removeBox(one, "p1", 0)).toEqual({});
		expect(removeLast(two, "p1")).toEqual({ p1: [a] });
		expect(clearPage(two, "p1")).toEqual({});
		expect(clearPage(two, "other")).toBe(two);
		expect(countBoxes(two)).toBe(2);
		expect(countPages(two)).toBe(1);
		expect(isArmed({ on: true, boxes: two })).toBe(true);
		expect(isArmed({ on: false, boxes: two })).toBe(false);
		expect(isArmed({ on: true, boxes: {} })).toBe(false);
	});

	it("makes a box from a drag in any direction, cut at the page edges, and refuses a tap", () => {
		const size = { width: 200, height: 300 };
		expect(boxFromDrag([50, 60], [10, 20], size)).toEqual({ x: 10, y: 20, width: 40, height: 40 });
		expect(boxFromDrag([-30, -30], [20, 20], size)).toEqual({ x: 0, y: 0, width: 20, height: 20 });
		expect(boxFromDrag([150, 250], [900, 900], size)).toEqual({ x: 150, y: 250, width: 50, height: 50 });
		expect(boxFromDrag([10, 10], [12, 12], size)).toBeNull();
		expect(boxFromDrag([NaN, 10], [12, 12], size)).toBeNull();
	});

	it("maps a screen point to page coordinates", () => {
		expect(pointToPage(150, 250, { left: 100, top: 200, width: 100, height: 200 }, { width: 600, height: 800 })).toEqual([300, 200]);
	});
});

describe("ink under a box", () => {
	it("keeps a stroke the box does not reach as the very same object", () => {
		const far = stroke("far", [[400, 400], [450, 420]]);
		expect(cutStroke(far, [box])).toEqual([far]);
		expect(cutStroke(far, [box])[0]).toBe(far);
	});

	it("drops a stroke that lies wholly inside a box", () => {
		expect(cutStroke(stroke("in", [[120, 110], [150, 120], [180, 130]]), [box])).toEqual([]);
		expect(cutStroke(stroke("dot", [[150, 120]]), [box])).toEqual([]);
		expect(cutStroke(stroke("dotOut", [[400, 400]]), [box])).toHaveLength(1);
	});

	it("cuts a stroke that crosses a box into the parts outside it, with no point under the box", () => {
		const across = stroke("x", [[20, 120], [150, 120], [300, 120]]);
		const pieces = cutStroke(across, [box]);
		expect(pieces).toHaveLength(2);
		expect(pieces.map((p) => p.id)).toEqual(["x", "x.r1"]);
		const reach = 2 * 0.8 + 1; // the widest a 2 pt pen draws (0.8 of its width at full pressure, review fix P8) plus the pad
		for (const p of pieces) {
			expect(p.tool).toBe("pen");
			expect(p.color).toBe("#1e1e1e");
			expect(p.width).toBe(2);
			for (const [x, y] of p.points) {
				const insideBox = x > box.x - reach + 1e-6 && x < box.x + box.width + reach - 1e-6 && y > box.y - reach && y < box.y + box.height + reach;
				expect(insideBox).toBe(false);
			}
		}
		// The first piece ends where the line meets the box edge (grown by the reach), the second starts at the other edge.
		expect(last(pieces[0]!.points)[0]).toBeCloseTo(box.x - reach, 5);
		expect(pieces[1]!.points[0]![0]).toBeCloseTo(box.x + box.width + reach, 5);
		// Every piece keeps the pressure it had where the line was cut.
		expect(last(pieces[0]!.points)[2]).toBeCloseTo(0.5, 5);
	});

	it("cuts a stroke whose points are all outside but whose line crosses a box", () => {
		const jump = stroke("j", [[20, 120], [300, 120]]);
		const pieces = cutStroke(jump, [box]);
		expect(pieces).toHaveLength(2);
	});

	it("cuts the margin the width of a thick pen reaches into", () => {
		const thick = stroke("thick", [[20, 120], [300, 120]], { tool: "highlighter", width: 20 });
		const pieces = cutStroke(thick, [box]);
		expect(last(pieces[0]!.points)[0]).toBeCloseTo(box.x - 11, 5);
	});

	it("drops a filled shape that a box reaches, and cuts an unfilled one", () => {
		const square: Array<[number, number]> = [[90, 90], [210, 90], [210, 150], [90, 150], [90, 90]];
		expect(cutStroke(stroke("f", square, { tool: "shape", fill: "#ff0000" }), [box])).toEqual([]);
		const open = cutStroke(stroke("o", square, { tool: "shape" }), [box]);
		expect(open.length).toBeGreaterThanOrEqual(1);
		for (const s of open) expect(s.fill).toBeUndefined();
	});

	it("cuts around several boxes in one pass", () => {
		const second = { x: 300, y: 100, width: 50, height: 40 };
		const pieces = outsideRuns([[0, 120, 0.5], [500, 120, 0.5]], [
			{ minX: 100, minY: 100, maxX: 200, maxY: 140 }, { minX: second.x, minY: second.y, maxX: second.x + second.width, maxY: second.y + second.height },
		]);
		expect(pieces).toHaveLength(3);
		expect(pieces.map((r) => [r[0]![0], last(r)[0]])).toEqual([[0, 100], [200, 300], [350, 500]]);
	});
});

describe("redactPage", () => {
	it("returns the page itself when there are no boxes, and never changes the page it is given", () => {
		const p = page({ strokes: [stroke("a", [[110, 110], [150, 120]])], elements: [text("t", 110, 105)] });
		expect(redactPage(p, [])).toBe(p);
		const before = JSON.stringify(p);
		const out = redactPage(p, [box]);
		expect(out).not.toBe(p);
		expect(JSON.stringify(p)).toBe(before);
	});

	it("drops every element that touches a box whole, with its text, and keeps the others", () => {
		const inside = text("in", 110, 105, "SECRET inside");
		const half = text("half", 150, 60, "SECRET half under the box and half above it so it is long enough to wrap onto more lines than one", 140);
		const away = text("away", 20, 500, "public");
		const p = page({ elements: [inside, half, away] });
		const out = redactPage(p, [box]);
		expect(out.elements?.map((e) => e.id)).toEqual(["away"]);
		expect(JSON.stringify(out)).not.toContain("SECRET");
	});

	it("drops pictures, equations, graphs, boxes, notes, markers, checkboxes and excerpts that touch a box", () => {
		const els: PageElement[] = [
			{ id: "img", type: "image", asset: "a1", x: 90, y: 90, width: 40, height: 40, rotation: 0 },
			{ id: "eq", type: "equation", x: 120, y: 105, width: 60, height: 20, latex: "SECRET", fontSize: 14, color: "#000000" },
			{ id: "gr", type: "graph", x: 150, y: 90, width: 100, height: 80, view: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 }, functions: [] },
			{ id: "bx", type: "box", kind: "definition", x: 110, y: 120, width: 50, height: 30, title: "SECRET" },
			{ id: "st", type: "sticky", x: 140, y: 100, width: 40, height: 30, color: "#ffd966", fontSize: 12, text: "SECRET" },
			{ id: "mk", type: "marker", kind: "question", x: 120, y: 110, text: "SECRET" },
			{ id: "ck", type: "checkbox", x: 130, y: 110, size: 20, color: "#000000", label: "SECRET" },
			{ id: "ex", type: "excerpt", x: 100, y: 100, width: 50, height: 50, asset: "snap", source: { notebook: "n", doc: "d", page: "q", x: 0, y: 0, width: 5, height: 5 } },
			{ id: "keep", type: "checkbox", x: 400, y: 400, size: 20, color: "#000000", label: "public" },
		];
		const out = redactPage(page({ elements: els }), [box]);
		expect(out.elements?.map((e) => e.id)).toEqual(["keep"]);
	});

	it("reaches an equation's number and a note's shadow, which are drawn beside the stored box", () => {
		const eq: PageElement = { id: "eq", type: "equation", x: 20, y: 105, width: 60, height: 20, latex: "x", fontSize: 14, color: "#000000", numbered: true };
		// The number sits to the right of the equation, in the box.
		expect(redactBounds(eq).maxX).toBeGreaterThan(100);
		expect(redactPage(page({ elements: [eq] }), [box]).elements).toBeUndefined();
	});

	it("cuts the ink and draws the box as the last, solid stroke", () => {
		const out = redactPage(page({ strokes: [stroke("a", [[20, 120], [300, 120]]), stroke("b", [[400, 400], [420, 420]])] }), [box]);
		expect(out.strokes.map((s) => s.id).slice(0, 3)).toEqual(["a", "a.r1", "b"]);
		const drawn = last(out.strokes);
		expect(drawn.tool).toBe("shape");
		expect(drawn.fill).toBe("#000000");
		expect(drawn.color).toBe("#000000");
		expect(drawn.points[0]).toEqual([100, 100, 0.5]);
		expect(last(drawn.points)).toEqual(drawn.points[0]);
		// The outline never leaves the rectangle (a smooth curve through the corners would bulge past it), and it reaches all four corners.
		for (const [x, y] of drawn.points) {
			expect(x).toBeGreaterThanOrEqual(100);
			expect(x).toBeLessThanOrEqual(200);
			expect(y).toBeGreaterThanOrEqual(100);
			expect(y).toBeLessThanOrEqual(140);
		}
		for (const corner of [[200, 100], [200, 140], [100, 140]]) expect(drawn.points.some((p) => p[0] === corner[0] && p[1] === corner[1])).toBe(true);
		expect(redactionOf(out)).toEqual([box]);
		expect(redactionOf(page())).toEqual([]);
	});

	it("cuts an area highlighter around the box instead of dropping it", () => {
		const area: PageElement = { id: "ar", type: "area", x: 50, y: 90, width: 300, height: 80, color: "#f5c400" };
		const out = redactPage(page({ elements: [area] }), [box]);
		const parts = (out.elements ?? []).filter((e) => e.type === "area");
		expect(parts.length).toBe(4);
		for (const a of parts) {
			if (a.type !== "area") continue;
			const overlapX = a.x < box.x + box.width && box.x < a.x + a.width;
			const overlapY = a.y < box.y + box.height && box.y < a.y + a.height;
			expect(overlapX && overlapY).toBe(false);
			expect(a.color).toBe("#f5c400");
		}
		const covered = parts.reduce((n, a) => n + (a.type === "area" ? a.width * a.height : 0), 0);
		expect(covered).toBeCloseTo(300 * 80 - 100 * 40, 5);
	});

	it("never draws the ink a collapsed note keeps hidden, even when the note itself goes", () => {
		const hidden = stroke("hid", [[500, 500], [520, 520]]);
		const note: PageElement = { id: "n", type: "sticky", x: 120, y: 105, width: 40, height: 20, color: "#ffd966", fontSize: 12, collapsed: true, ink: ["hid"] };
		const out = redactPage(page({ strokes: [hidden, stroke("vis", [[400, 400], [420, 420]])], elements: [note] }), [box]);
		expect(out.strokes.some((s) => s.id === "hid")).toBe(false);
		expect(out.strokes.some((s) => s.id === "vis")).toBe(true);
	});

	it("drops the ink bound to a graph that goes", () => {
		const graph: PageElement = { id: "g1", type: "graph", x: 90, y: 90, width: 200, height: 100, view: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 }, functions: [] };
		const bound = stroke("g1~1", [[600, 700], [610, 710]]);
		const out = redactPage(page({ strokes: [bound, stroke("free", [[600, 700], [610, 710]])], elements: [graph] }), [box]);
		expect(out.strokes.some((s) => s.id === "g1~1")).toBe(false);
		expect(out.strokes.some((s) => s.id === "free")).toBe(true);
	});

	it("drops margin comments anchored on a box with their replies, and the tags and states that no export draws", () => {
		const comments = [
			{ id: "c1", region: { x: 110, y: 105, width: 30, height: 20 }, text: "SECRET", author: "me", created: 1 },
			{ id: "r1", parent: "c1", text: "SECRET reply", author: "me", created: 2 },
			{ id: "c2", region: { x: 10, y: 600, width: 30, height: 20 }, text: "fine", author: "me", created: 3 },
		];
		const out = redactPage(page({ comments, tags: ["SECRET"], states: { parts: [], states: [] } as never }), [box]);
		expect(out.comments?.map((c) => c.id)).toEqual(["c2"]);
		expect(out.tags).toBeUndefined();
		expect(out.states).toBeUndefined();
		expect(JSON.stringify(out)).not.toContain("SECRET");
	});

	it("is idempotent, and a second pass with other boxes keeps both", () => {
		const p = page({ strokes: [stroke("a", [[20, 120], [300, 120]]), stroke("b", [[20, 400], [300, 400]])] });
		const once = redactPage(p, [box]);
		expect(redactPage(once, [box])).toBe(once);
		const other = { x: 100, y: 380, width: 60, height: 40 };
		const twice = redactPage(once, [other]);
		expect(redactionOf(twice)).toEqual([box, other]);
		expect(twice.strokes.filter((s) => s.id.startsWith("redact-"))).toHaveLength(2);
		expect(twice.strokes.some((s) => s.id === "b.r1")).toBe(true);
	});

	it("redacts a list by page id and leaves pages without boxes untouched", () => {
		const a = page({ id: "pa", elements: [text("t", 110, 105)] });
		const b = page({ id: "pb", elements: [text("t", 110, 105)] });
		const out = redactPages([a, b], { pa: [box] });
		expect(out[0]).not.toBe(a);
		expect(out[0]!.elements).toBeUndefined();
		expect(out[1]).toBe(b);
	});

	it("survives a shallow copy: the boxes ride along", () => {
		const out = redactPage(page(), [box]);
		expect(redactionOf({ ...out })).toEqual([box]);
	});
});

describe("the parts around the page", () => {
	it("drops the header or footer a box covers", () => {
		const header = { text: "Maths · 3 Jun", x: 28, align: "left" as const, y: 13, size: 9, maxWidth: 400, footer: false };
		const redacted = redactPage(page(), [{ x: 20, y: 0, width: 200, height: 30 }]);
		expect(headerAfterRedaction(header, redacted)).toBeNull();
		expect(headerAfterRedaction(header, redactPage(page(), [box]))).toBe(header);
		expect(headerAfterRedaction(header, page())).toBe(header);
		expect(headerAfterRedaction(null, redacted)).toBeNull();
	});

	it("takes the bookmark title of a covered page out of the meta", () => {
		const meta = { tags: [], favorite: false, bookmarks: ["p1", "p2"], bookmarkInfo: { p1: { title: "SECRET plan", category: "important" }, p2: { title: "Open" } } } as unknown as NotebookMeta;
		const pages = [redactPage(page({ id: "p1" }), [box]), page({ id: "p2" })];
		const out = metaWithoutRedactedTitles(meta, pages);
		expect(out?.bookmarkInfo?.p1).toEqual({ category: "important" });
		expect(out?.bookmarkInfo?.p2).toEqual({ title: "Open" });
		expect(JSON.stringify(meta)).toContain("SECRET");
		expect(metaWithoutRedactedTitles(meta, [page({ id: "p1" })])).toBe(meta);
	});
});

describe("review fixes (0.26 privacy review)", () => {
	/** The lines a text box fills on a canvas whose glyphs are `em` wide (a stand-in for the real font: CJK 1 em, emoji ~1.2 em, W ~0.94 em). */
	const canvasHeight = (el: Extract<PageElement, { type: "text" }>, em: (ch: string) => number): number =>
		layoutText(el.text, el.fontSize, el.width, (s) => Array.from(s).reduce((w, ch) => w + em(ch), 0) * el.fontSize).height;
	const realEm = (ch: string): number => (ch.codePointAt(0)! > 0xffff ? 1.25 : ch.codePointAt(0)! >= 0x1100 ? 1 : /[WM]/.test(ch) ? 0.94 : 0.6);

	/** A box over the last line the canvas draws of `el`, and nothing above it. */
	function boxOverLastLine(el: Extract<PageElement, { type: "text" }>): { x: number; y: number; width: number; height: number } {
		const h = canvasHeight(el, realEm);
		return { x: el.x, y: el.y + h - el.fontSize * 1.25 + 2, width: 80, height: el.fontSize };
	}

	it("P1: drops a text box whose last line (CJK, emoji, capitals) is under a box, which the old two-width measure kept", () => {
		const cases = [
			"漢".repeat(120) + " SECRET",
			"😀".repeat(60) + " SECRET",
			"WWWW MMMM ".repeat(14) + "SECRET",
		];
		for (const body of cases) {
			const el = { id: "t", type: "text" as const, x: 100, y: 300, width: 200, text: body, fontSize: 14, color: "#000000" };
			const covering = boxOverLastLine(el);
			// The box is below what the old measure (0.55 / 0.66 em per character) said the text box covers: the leak the review found.
			const old = Math.max(
				layoutText(body, 14, 200, (s) => Array.from(s).length * 14 * 0.55).height,
				layoutText(body, 14, 200, (s) => Array.from(s).length * 14 * 0.66).height,
			);
			expect(covering.y).toBeGreaterThan(el.y + old + 3);
			// Positive control: the same page with the box far away keeps the marker.
			expect(JSON.stringify(redactPage(page({ elements: [el] }), [{ x: 400, y: 20, width: 40, height: 40 }]))).toContain("SECRET");
			const out = redactPage(page({ elements: [el] }), [covering]);
			expect(out.elements).toBeUndefined();
			expect(JSON.stringify(out)).not.toContain("SECRET");
			// The bounds are never shorter than the canvas draws it.
			expect(redactBounds(el).maxY).toBeGreaterThanOrEqual(el.y + canvasHeight(el, realEm));
		}
	});

	it("P1: a single character wider than a narrow text box widens its area", () => {
		const el: PageElement = { id: "t", type: "text", x: 100, y: 100, width: 4, text: "漢SECRET", fontSize: 20, color: "#000000" };
		expect(redactBounds(el).maxX).toBeGreaterThanOrEqual(100 + 1.5 * 20);
		expect(pessimisticMeasure("漢", 10)).toBe(15);
		expect(pessimisticMeasure("ab", 10)).toBe(16);
		expect(pessimisticMeasure("Wm", 10)).toBe(20);
	});

	it("P2: an excerpt whose SOURCE region is under a box is left out of every page that shows it", () => {
		const source = page({ id: "src" });
		const ex: PageElement = { id: "ex", type: "excerpt", x: 50, y: 50, width: 100, height: 60, asset: "SECRETSNAP", source: { notebook: "n", doc: "d", page: "src", x: 110, y: 110, width: 40, height: 20 } };
		const shows = page({ id: "dst", elements: [ex] });
		// Positive control: no box over the source, or a box elsewhere: the excerpt and its snapshot stay.
		expect(JSON.stringify(redactPages([source, shows], {}))).toContain("SECRETSNAP");
		const elsewhere = redactPages([source, shows], { src: [{ x: 400, y: 400, width: 40, height: 40 }] });
		expect(elsewhere[1]).toBe(shows);
		const out = redactPages([source, shows], { src: [box] });
		expect(out[1]).not.toBe(shows);
		expect(out[1]!.id).toBe("dst");
		expect(JSON.stringify(out)).not.toContain("SECRETSNAP");
		expect(coveredExcerpt(ex, { src: [box] })).toBe(true);
		expect(coveredExcerpt(ex, { dst: [box] })).toBe(false);
		expect(hasRedactions([shows], { src: [box] })).toBe(true);
		// The page that shows it can have its own boxes too.
		const both = redactPage(shows, [{ x: 400, y: 400, width: 40, height: 40 }], { src: [box] });
		expect(both.elements).toBeUndefined();
	});

	it("P3: the copy of a page shown in a drawing state keeps its id, size, paper and background", () => {
		const bg = { kind: "pdf" as const, asset: "pdf1", page: 1 };
		const base = page({ id: "ps", background: bg, strokes: [stroke("a", [[20, 120], [300, 120]])], elements: [text("t", 110, 105)], states: { parts: [], list: [] } });
		const view = liveStateView(base);
		expect(view).not.toBe(base);
		expect(Object.keys({ ...view })).toEqual(["strokes"]); // what the old spread kept
		const out = redactPage(view, [box]);
		expect(out.id).toBe("ps");
		expect(out.width).toBe(A4_WIDTH);
		expect(out.height).toBe(A4_HEIGHT);
		expect(out.paper).toEqual(base.paper);
		expect(out.background).toEqual(bg);
		expect(out.states).toBeUndefined();
		expect(out.elements).toBeUndefined();
		expect(burnPlan(out)?.boxes).toEqual([box]);
		const copy = pageCopy(view);
		expect(copy.id).toBe("ps");
		expect(copy.strokes).toBe(view.strokes);
		// A clean copy of a page with states keeps them as well, so its boxes are still found by id.
		const marker: PageElement = { id: "mk", type: "marker", kind: "question", x: 400, y: 400 };
		const clean = cleanPageForExport(liveStateView({ ...base, elements: [marker] }));
		expect(clean.id).toBe("ps");
		expect(clean.width).toBe(A4_WIDTH);
	});

	it("P8: a high-pressure pen stroke is cut by the widest the pen can draw, not half its width", () => {
		const heavy: Stroke = { id: "h", tool: "pen", color: "#000000", width: 10, render: RENDER_INK, points: [[20, 120, 1], [300, 120, 1]] };
		expect(redactReach(heavy)).toBeCloseTo(8, 6);
		const pieces = cutStroke(heavy, [box]);
		expect(pieces).toHaveLength(2);
		// No kept point is closer to the box than the radius the pen draws at full pressure (0.8 w) plus the pad.
		for (const p of pieces) for (const [x] of p.points) expect(x <= box.x - 9 + 1e-6 || x >= box.x + box.width + 9 - 1e-6).toBe(true);
		// Control: the old reach (half the width) would have kept ink 6 to 9 pt from the box, under its edge once drawn.
		expect(last(pieces[0]!.points)[0]).toBeLessThan(box.x - 6);
		// A stored pressure above 1 widens it further; the new pens keep their own maxima.
		expect(redactReach({ tool: "pen", width: 10, points: [[0, 0, 1.5]] })).toBeCloseTo(10 * (0.2 + 0.6 * 1.5), 6);
		expect(redactReach({ tool: "fountain", width: 10, points: [[0, 0, 1]] })).toBeCloseTo(6.5, 6);
		expect(redactReach({ tool: "brush", width: 10, points: [[0, 0, 1]] })).toBeCloseTo(8, 6);
		expect(redactReach({ tool: "highlighter", width: 10, points: [[0, 0, 1]] })).toBeCloseTo(5, 6);
	});

	it("P13: a checkbox whose handwritten label is under a box loses its typed label (and keeps it otherwise)", () => {
		const cb: PageElement = { id: "cb", type: "checkbox", x: 60, y: 110, size: 20, color: "#000000", label: "SECRET account" };
		const hand = stroke("hand", [[90, 118], [130, 122], [180, 120]]);
		const p = page({ strokes: [hand], elements: [cb] });
		// Positive control: a box elsewhere leaves the typed label, which the Markdown text writes.
		const control = redactPage(p, [{ x: 400, y: 400, width: 40, height: 40 }]);
		expect(pageTexts(control).join("\n")).toContain("SECRET");
		const out = redactPage(p, [{ x: 120, y: 105, width: 80, height: 30 }]);
		const kept = out.elements?.find((e) => e.id === "cb");
		expect(kept).toBeDefined();
		expect(JSON.stringify(out.elements)).not.toContain("SECRET");
		expect(pageTexts(out).join("\n")).not.toContain("SECRET");
	});
});

describe("burning boxes into a background picture", () => {
	it("turns boxes into pixel rectangles of the picture, grown a little and cut at its edge", () => {
		const rects = burnPixelRects([{ x: 100, y: 50, width: 100, height: 40 }], { x: 0, y: 0, width: 400, height: 200 }, 800, 400);
		expect(rects).toEqual([{ x: 198, y: 98, width: 204, height: 84 }]);
		const edge = burnPixelRects([{ x: 380, y: 190, width: 100, height: 100 }], { x: 0, y: 0, width: 400, height: 200 }, 400, 200);
		expect(edge).toEqual([{ x: 378, y: 188, width: 22, height: 12 }]);
	});

	it("follows the margins: the picture fills only the background rectangle", () => {
		const rects = burnPixelRects([{ x: 150, y: 20, width: 20, height: 20 }], { x: 100, y: 0, width: 100, height: 100 }, 200, 200);
		expect(rects).toEqual([{ x: 98, y: 38, width: 44, height: 44 }]);
	});

	it("gives nothing for a box outside the picture or a picture with no size", () => {
		expect(burnPixelRects([{ x: 500, y: 500, width: 10, height: 10 }], { x: 0, y: 0, width: 100, height: 100 }, 100, 100)).toEqual([]);
		expect(burnPixelRects([box], { x: 0, y: 0, width: 0, height: 100 }, 100, 100)).toEqual([]);
	});

	it("plans a burn only for a redacted page with a background that a box touches", () => {
		const bg = { kind: "pdf" as const, asset: "pdf1", page: 1 };
		expect(burnPlan(page({ background: bg }))).toBeNull();
		const covered = redactPage(page({ background: bg }), [box]);
		expect(burnPlan(covered)?.boxes).toEqual([box]);
		expect(burnPlan(redactPage(page(), [box]))).toBeNull();
		const margins = redactPage(page({ background: bg, margins: { left: 400, right: 50, bottom: 0 } }), [box]);
		expect(burnPlan(margins)).toBeNull();
	});
});
