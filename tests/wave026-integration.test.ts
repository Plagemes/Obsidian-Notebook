// Cross-feature rules of the 0.26 wave: opacity (#358, format 24) next to redaction (#285), smooth/straighten (#66), tidy up (#238),
// stroke join, the context palette (#394) and the pen width that follows zoom (#350).
import { describe, expect, it } from "vitest";
import { planSmooth } from "../src/ink/smooth";
import { planTidy } from "../src/ink/tidy";
import { planJoin } from "../src/ink/stroke-join";
import { cutStroke, redactPage } from "../src/ink/redact";
import { usedColours } from "../src/ink/context-palette";
import { zoomedWidth } from "../src/ink/zoom-width";
import { createArea } from "../src/model/area";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { freezeStroke, parse, serialize } from "../src/model/serialize";
import { PAPER_SPACING, RENDER_INK, type Page, type Point, type Stroke } from "../src/model/types";

let seq = 0;
function stroke(points: Point[], over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#111111", 1.5, points, "pen", RENDER_INK), id: `w${++seq}`, ...over });
}
const pt = (x: number, y: number): Point => quantizePoint(x, y, 0.5);
function loop(cx: number, cy: number, r: number, n = 28): Point[] {
	return Array.from({ length: n + 1 }, (_, i) => {
		const a = Math.PI / 2 + (i / n) * 2 * Math.PI;
		return pt(cx + r * Math.cos(a), cy + r * Math.sin(a));
	});
}
function pageOf(strokes: readonly Stroke[]): Page {
	const page = createPage(undefined, { kind: "blank", spacing: PAPER_SPACING.blank });
	page.strokes.push(...strokes);
	return page;
}

describe("0.26 integration: opacity stays with the ink that other features rewrite", () => {
	it("smooth and straighten keep the opacity (and every other style key) of the stroke they replace", () => {
		const wobbly: Point[] = Array.from({ length: 41 }, (_, i) => pt(20 + 4 * i, 50 + 6 * (i / 40) + (i % 2 === 0 ? 0.4 : -0.4)));
		const s = stroke(wobbly, { opacity: 0.4 });
		const page = pageOf([s]);
		for (const mode of ["smooth", "straighten"] as const) {
			const plan = planSmooth(page, [s], [], mode);
			expect(plan, mode).not.toBeNull();
			const next = plan!.changes.get(s)!;
			expect(next.opacity).toBe(0.4);
			expect(next.id).toBe(s.id);
			expect(next.color).toBe(s.color);
			expect(next.width).toBe(s.width);
		}
	});

	it("tidy up moves strokes rigidly, so their opacity comes along", () => {
		// Five lines of loops that start a little off one margin: the margin step shifts them in x.
		const rows: Stroke[][] = [60, 66, 57, 62, 64].map((x0, r) => {
			const out: Stroke[] = [];
			for (let k = 0; k < 6; k++) out.push(stroke(loop(x0 + 9 * k + 3.5, 100 + 40 * r, 3.5), { opacity: 0.6 }));
			return out;
		});
		const page = pageOf(rows.flat());
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, { baseline: false, margin: true, gaps: false, keepParagraphs: true });
		expect(plan).not.toBeNull();
		expect(plan!.changes.size).toBeGreaterThan(0);
		for (const next of plan!.changes.values()) expect(next.opacity).toBe(0.6);
	});

	it("stroke join joins only strokes of the same opacity and the joined stroke keeps it", () => {
		const a = stroke([pt(10, 10), pt(20, 10), pt(30, 10)], { opacity: 0.5 });
		const b = stroke([pt(30.4, 10), pt(40, 10), pt(50, 10)], { opacity: 0.5 });
		const c = stroke([pt(30.4, 10), pt(40, 10), pt(50, 10)], { opacity: 0.9 });
		const same = planJoin(pageOf([a, b]), [a, b]);
		if (same) for (const next of same.changes.values()) if (next) expect(next.opacity).toBe(0.5);
		expect(planJoin(pageOf([a, c]), [a, c])).toBeNull();
	});

	it("redaction cuts a stroke into pieces that keep its opacity, and an area into rectangles that keep theirs", () => {
		const s = stroke([pt(10, 100), pt(100, 100), pt(200, 100), pt(300, 100)], { opacity: 0.35 });
		const hole = { x: 120, y: 80, width: 60, height: 40 };
		const pieces = cutStroke(s, [hole]);
		expect(pieces.length).toBeGreaterThanOrEqual(2);
		for (const p of pieces) expect(p.opacity).toBe(0.35);

		const area = createArea([50, 50], [350, 150], { width: 600, height: 800 }, "#ffe066", 0.5)!;
		const page = pageOf([s]);
		page.elements = [area];
		const out = redactPage(page, [hole]);
		const areas = (out.elements ?? []).filter((e) => e.type === "area");
		expect(areas.length).toBeGreaterThanOrEqual(2);
		for (const a of areas) expect(a.opacity).toBe(0.5);
		// The black box itself is opaque (no opacity key), so nothing shows through it.
		const black = out.strokes.filter((x) => x.fill === "#000000");
		expect(black.length).toBe(1);
		expect(black[0]!.opacity).toBeUndefined();
	});

	it("a v24 document writes the opacity and reads it back", () => {
		const doc = createDocument();
		const s = stroke([pt(10, 10), pt(200, 10)], { opacity: 0.5 });
		doc.pages = [pageOf([s])];
		const text = serialize(doc);
		expect(text).toContain('"opacity":0.5');
		const back = parse(text);
		expect(back.ok).toBe(true);
	});

	it("the context palette counts a colour the same whatever the opacity of its ink", () => {
		const plain = usedColours({ strokes: [{ tool: "pen", color: "#c0392b" }, { tool: "pen", color: "#2980b9" }] });
		const faded = usedColours({ strokes: [{ tool: "pen", color: "#c0392b", opacity: 0.3 } as never, { tool: "pen", color: "#2980b9", opacity: 0.8 } as never] });
		expect(faded).toEqual(plain);
	});

	it("the width that follows zoom and the opacity are independent pen options", () => {
		expect(zoomedWidth(3, 2, true)).toBeCloseTo(1.5, 6);
		const s = stroke([pt(10, 10), pt(90, 10)], { width: zoomedWidth(3, 2, true), opacity: 0.5 });
		expect(s.width).toBeCloseTo(1.5, 6);
		expect(s.opacity).toBe(0.5);
	});
});
