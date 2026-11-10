import { describe, expect, it } from "vitest";
import { cluster1d, connectorBetween, distanceToShape, insideShape, layoutBoxes, MIN_GAP, type LayoutBox } from "../src/ink/flowchart-layout";
import { DEFAULT_GRID, FLOWCHART_LABEL, flowGrid, planFlowchart, readFlowchart, type FlowPlan } from "../src/ink/flowchart";
import { strokeBounds } from "../src/ink/hit-test";
import { arrowPoints, ellipsePoints, polygonPoints, rectPoints } from "../src/ink/shapes";
import type { RedactGuard } from "../src/ink/redact";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { History } from "../src/model/history";
import { computeScope } from "../src/model/page-undo";
import { freezeElement, freezeStroke, parse, serialize } from "../src/model/serialize";
import { createTape } from "../src/model/tape";
import { RENDER_INK, type Page, type PageElement, type Point, type Stroke, type TextElement, type Tool } from "../src/model/types";
import { arrowEnds } from "../src/zettel/arrows";

let seq = 0;
const noise = (i: number, salt: number): number => {
	const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
	return (x - Math.floor(x)) * 2 - 1;
};
const pt = (x: number, y: number, p = 0.6): Point => [Math.round(x * 100) / 100, Math.round(y * 100) / 100, p];

function stroke(points: Point[], tool: Tool = "pen", over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#1e1e1e", 1.6, points, tool, RENDER_INK), id: `s${++seq}`, ...over });
}

/** A hand-drawn closed outline through `corners`, wobbled by `amp`, with a small overshoot at the end like a real one. */
function drawn(corners: Array<[number, number]>, salt: number, amp = 0.8): Point[] {
	const out: Point[] = [];
	let k = 0;
	for (let i = 0; i < corners.length; i++) {
		const a = corners[i]!, b = corners[(i + 1) % corners.length]!;
		const n = Math.max(6, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
		for (let j = 0; j < n; j++, k++) {
			const t = j / n;
			out.push(pt(a[0] + (b[0] - a[0]) * t + amp * noise(k, salt), a[1] + (b[1] - a[1]) * t + amp * noise(k, salt + 1), 0.3 + 0.4 * noise(k, salt + 2) ** 2));
		}
	}
	out.push(pt(corners[0]![0] + 1.5, corners[0]![1] + 1));
	return out;
}
const rect = (x: number, y: number, w: number, h: number, salt = 1, tool: Tool = "pen"): Stroke =>
	stroke(drawn([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], salt), tool);
const diamond = (x: number, y: number, w: number, h: number, salt = 2): Stroke =>
	stroke(drawn([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], salt));
function ellipse(x: number, y: number, w: number, h: number, salt = 3): Stroke {
	const pts: Point[] = [];
	const n = 72;
	for (let i = 0; i <= n; i++) {
		const t = (2 * Math.PI * i) / n + 0.3;
		pts.push(pt(x + w / 2 + (w / 2) * Math.cos(t) + 0.6 * noise(i, salt), y + h / 2 + (h / 2) * Math.sin(t) + 0.6 * noise(i, salt + 1)));
	}
	return stroke(pts);
}
/** An arrow drawn in one stroke: shaft, then the two wings back from the tip. */
function arrow(a: [number, number], b: [number, number], salt = 4, tool: Tool = "pen"): Stroke {
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const back = Math.atan2(a[1] - b[1], a[0] - b[0]);
	const w = 12;
	const w1: [number, number] = [b[0] + w * Math.cos(back + 0.5), b[1] + w * Math.sin(back + 0.5)];
	const w2: [number, number] = [b[0] + w * Math.cos(back - 0.5), b[1] + w * Math.sin(back - 0.5)];
	const pts: Point[] = [];
	const leg = (p: [number, number], q: [number, number], n: number, amp: number, from: number): void => {
		for (let i = from; i <= n; i++) pts.push(pt(p[0] + ((q[0] - p[0]) * i) / n + amp * noise(pts.length, salt), p[1] + ((q[1] - p[1]) * i) / n + amp * noise(pts.length, salt + 1)));
	};
	leg(a, b, Math.max(8, Math.round(len / 5)), 0.5, 0);
	leg(b, w1, 4, 0, 1);
	leg(w1, b, 4, 0, 1);
	leg(b, w2, 4, 0, 1);
	return stroke(pts, tool);
}
const line = (a: [number, number], b: [number, number], salt = 5): Stroke => {
	const n = Math.max(8, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
	return stroke(Array.from({ length: n + 1 }, (_, i) => pt(a[0] + ((b[0] - a[0]) * i) / n + 0.4 * noise(i, salt), a[1] + ((b[1] - a[1]) * i) / n + 0.4 * noise(i, salt + 1))));
};
/** Handwriting inside a box: a few short strokes. */
const scribble = (x: number, y: number, salt = 6): Stroke[] => [0, 1, 2].map((k) => stroke(Array.from({ length: 10 }, (_, i) => pt(x + k * 12 + 3 * Math.sin(i) + noise(i, salt + k), y + i * 1.5 + noise(i, salt + k + 9)))));
const textBox = (x: number, y: number): TextElement => freezeElement({ id: `t${++seq}`, type: "text", x, y, width: 60, text: "Yes", fontSize: 14, color: "#1e1e1e" });

function pageWith(strokes: readonly Stroke[], elements: PageElement[] = []): { doc: ReturnType<typeof createDocument>; page: Page } {
	const doc = createDocument();
	const page = createPage();
	page.strokes.push(...strokes);
	if (elements.length > 0) page.elements = elements;
	doc.pages = [page];
	return { doc, page };
}

const NO_BOXES: RedactGuard = { boxes: [] };
const run = (page: Page, strokes: readonly Stroke[], elements: readonly PageElement[] = [], guard: RedactGuard = NO_BOXES): FlowPlan =>
	planFlowchart(page, { strokes, elements }, { grid: DEFAULT_GRID, guard });
const must = (plan: FlowPlan): Extract<FlowPlan, { ok: true }> => {
	if (!plan.ok) throw new Error(`refused: ${plan.reason}`);
	return plan;
};
const box = (b: { minX: number; minY: number; maxX: number; maxY: number }) => b;
const lb = (shape: LayoutBox["shape"], x: number, y: number, w: number, h: number): LayoutBox => ({ shape, box: box({ minX: x, minY: y, maxX: x + w, maxY: y + h }) });
type Outline = { minX: number; minY: number; maxX: number; maxY: number };

describe("flowchart layout (0.30, #245)", () => {
	it("clusters values into increasing clusters", () => {
		expect(cluster1d([100, 205, 98, 310, 102], 20)).toEqual([0, 1, 0, 2, 0]);
		expect(cluster1d([], 5)).toEqual([]);
	});

	it("centres boxes in columns and rows with equal gaps and the first box on the grid", () => {
		const boxes = [lb("rectangle", 101, 53, 100, 40), lb("rectangle", 96, 150, 110, 44), lb("rectangle", 99, 290, 104, 40)];
		const layout = layoutBoxes(boxes, 8)!;
		expect(layout.columns).toBe(1);
		expect(layout.rows).toBe(3);
		const placed = boxes.map((b, i) => ({ ...b.box, minX: b.box.minX + layout.deltas[i]![0], minY: b.box.minY + layout.deltas[i]![1], maxX: b.box.maxX + layout.deltas[i]![0], maxY: b.box.maxY + layout.deltas[i]![1] }));
		const centres = placed.map((b) => (b.minX + b.maxX) / 2);
		expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(1e-9);
		const gap1 = placed[1]!.minY - placed[0]!.maxY, gap2 = placed[2]!.minY - placed[1]!.maxY;
		expect(gap1).toBeCloseTo(gap2, 9);
		expect(gap1).toBeGreaterThanOrEqual(MIN_GAP);
		expect(placed[0]!.minY % 8).toBeCloseTo(0, 9);
	});

	it("keeps rows when boxes sit side by side, and lays a branch out as columns", () => {
		const boxes = [lb("diamond", 100, 100, 80, 60), lb("rectangle", 20, 230, 70, 40), lb("rectangle", 200, 236, 70, 40)];
		const layout = layoutBoxes(boxes, 8)!;
		expect(layout.columns).toBe(3);
		expect(layout.rows).toBe(2);
		const [, d2, d3] = layout.deltas;
		// the two branch boxes end on one row
		expect(boxes[1]!.box.minY + d2![1] + 20).toBeCloseTo(boxes[2]!.box.minY + d3![1] + 20, 9);
	});

	it("is null when two boxes would share a cell, and is idempotent", () => {
		expect(layoutBoxes([lb("rectangle", 100, 100, 80, 40), lb("rectangle", 104, 104, 80, 40)], 8)).toBeNull();
		const boxes = [lb("rectangle", 101, 53, 100, 40), lb("rectangle", 96, 150, 110, 44)];
		const first = layoutBoxes(boxes, 8)!;
		const moved = boxes.map((b, i) => lb(b.shape, b.box.minX + first.deltas[i]![0], b.box.minY + first.deltas[i]![1], b.box.maxX - b.box.minX, b.box.maxY - b.box.minY));
		for (const [dx, dy] of layoutBoxes(moved, 8)!.deltas) {
			expect(Math.abs(dx)).toBeLessThan(0.01);
			expect(Math.abs(dy)).toBeLessThan(0.01);
		}
	});

	it("knows what is inside a rectangle, a diamond and an ellipse", () => {
		const b = box({ minX: 0, minY: 0, maxX: 100, maxY: 60 });
		expect(insideShape("rectangle", b, 2, 2)).toBe(true);
		expect(insideShape("diamond", b, 2, 2)).toBe(false);
		expect(insideShape("ellipse", b, 2, 2)).toBe(false);
		expect(insideShape("diamond", b, 50, 30)).toBe(true);
		expect(distanceToShape("rectangle", b, 110, 30)).toBe(10);
		expect(distanceToShape("diamond", b, 100, 30)).toBe(0);
		expect(distanceToShape("ellipse", b, 50, 30)).toBe(0);
		expect(distanceToShape("ellipse", b, 120, 30)).toBeCloseTo(20, 0);
	});

	it("draws a straight square connector between stacked boxes and one between the outlines of a diamond and an ellipse", () => {
		const a = lb("rectangle", 100, 100, 100, 40), c = lb("rectangle", 90, 220, 120, 40);
		const ends = connectorBetween(a, c)!;
		expect(ends.from[0]).toBeCloseTo(ends.to[0], 9);
		expect(ends.from[1]).toBeCloseTo(140 + 1.5, 6);
		expect(ends.to[1]).toBeCloseTo(220 - 1.5, 6);
		const d = lb("diamond", 100, 100, 100, 60), e = lb("ellipse", 100, 240, 100, 60);
		const e2 = connectorBetween(d, e)!;
		expect(e2.from[1]).toBeCloseTo(160 + 1.5, 6);
		expect(e2.to[1]).toBeCloseTo(240 - 1.5, 6);
		// side by side: horizontal
		const side = connectorBetween(lb("rectangle", 0, 0, 80, 40), lb("rectangle", 160, 6, 80, 40))!;
		expect(side.from[1]).toBeCloseTo(side.to[1], 9);
		// diagonal: centre to centre, clipped
		const diag = connectorBetween(lb("rectangle", 0, 0, 60, 40), lb("rectangle", 200, 200, 60, 40))!;
		expect(diag.from[0]).toBeGreaterThan(30);
		expect(diag.from[1]).toBeGreaterThan(20);
		// touching: none
		expect(connectorBetween(lb("rectangle", 0, 0, 60, 40), lb("rectangle", 0, 40, 60, 40))).toBeNull();
	});

	it("sets two connectors between the same boxes apart", () => {
		const a = lb("rectangle", 100, 100, 100, 40), c = lb("rectangle", 100, 220, 100, 40);
		const one = connectorBetween(a, c, -6)!, two = connectorBetween(a, c, 6)!;
		expect(two.from[0] - one.from[0]).toBeCloseTo(12, 9);
	});
});

describe("reading a flowchart (0.30, #245)", () => {
	it("finds rectangles, diamonds and ellipses, and not a circle as a diamond", () => {
		const r = rect(100, 100, 120, 50), d = diamond(100, 220, 120, 70), e = ellipse(100, 340, 120, 50);
		const model = readFlowchart([r, d, e], []);
		if (model === "few" || model === "nested") throw new Error(model);
		expect(model.nodes.map((n) => n.shape)).toEqual(["rectangle", "diamond", "ellipse"]);
		const b = model.nodes[1]!.box;
		expect(b.maxX - b.minX).toBeGreaterThan(110);
		expect(b.maxY - b.minY).toBeGreaterThan(60);
	});

	it("is not fooled by handwriting, small shapes and highlighter", () => {
		const hand = scribble(100, 100);
		const dot = ellipse(300, 300, 8, 8);
		const hl = rect(100, 400, 120, 50, 9, "highlighter");
		expect(readFlowchart([...hand, dot, hl, rect(10, 10, 100, 40)], [])).toBe("few");
	});

	it("finds an arrow in one stroke and a line with a small head, and attaches both ends", () => {
		const a = rect(100, 100, 120, 50), b = rect(100, 230, 120, 50, 7);
		const one = arrow([160, 152], [160, 228]);
		const model = readFlowchart([a, b, one], []);
		if (model === "few" || model === "nested") throw new Error(model);
		expect(model.edges).toHaveLength(1);
		expect(model.edges[0]!.arrow).toBe(true);
		expect([model.edges[0]!.from, model.edges[0]!.to]).toEqual([0, 1]);
		// a line with a V next to its end
		const shaft = line([160, 152], [160, 226], 8);
		const head = stroke([pt(152, 214), pt(160, 227), pt(168, 214)]);
		const two = readFlowchart([a, b, shaft, head], []);
		if (two === "few" || two === "nested") throw new Error(two);
		expect(two.edges).toHaveLength(1);
		expect(two.edges[0]!.arrow).toBe(true);
		expect(two.edges[0]!.heads).toEqual([head]);
	});

	it("leaves a connector that does not join two boxes alone", () => {
		const a = rect(100, 100, 120, 50), b = rect(100, 230, 120, 50, 7);
		const stray = arrow([160, 152], [160, 190]);
		const model = readFlowchart([a, b, stray], []);
		if (model === "few" || model === "nested") throw new Error(model);
		expect(model.edges).toHaveLength(0);
	});

	it("takes the writing and text boxes inside a box as its label, and a ring in a box as part of the label", () => {
		const a = rect(100, 100, 200, 80), b = rect(100, 300, 200, 80, 7);
		const words = scribble(130, 125);
		const ring = ellipse(260, 125, 22, 22, 11);
		const outsideWords = scribble(400, 125, 31);
		const t = textBox(120, 320);
		const model = readFlowchart([a, b, ...words, ring, ...outsideWords], [t]);
		if (model === "few" || model === "nested") throw new Error(model);
		expect(model.nodes).toHaveLength(2);
		expect(model.nodes[0]!.strokes).toHaveLength(4);
		expect(model.nodes[1]!.elements).toEqual([t]);
		for (const s of outsideWords) expect(model.nodes.some((n) => n.strokes.includes(s))).toBe(false);
	});

	it("refuses a box inside a box of a similar size", () => {
		expect(readFlowchart([rect(100, 100, 300, 200), rect(140, 140, 200, 120, 5), rect(500, 100, 100, 50, 9)], [])).toBe("nested");
	});
});

describe("planFlowchart (0.30, #245)", () => {
	/** A wobbly vertical flowchart: box, diamond, box, with labels, a text box and two arrows. */
	function chart() {
		const top = rect(103, 52, 120, 48);
		const mid = diamond(94, 160, 138, 76, 5);
		const bottom = rect(100, 300, 124, 46, 7);
		const labelTop = scribble(125, 66);
		const labelMid = scribble(130, 190, 21);
		const note = textBox(112, 316);
		const a1 = arrow([163, 102], [163, 158], 4);
		const a2 = arrow([163, 238], [163, 298], 8);
		const strokes = [top, mid, bottom, ...labelTop, ...labelMid, a1, a2];
		const { doc, page } = pageWith(strokes, [note]);
		return { doc, page, strokes, top, mid, bottom, labelTop, labelMid, note, a1, a2 };
	}

	it("aligns the boxes, evens the gaps, keeps labels with their boxes and redraws the arrows", () => {
		const c = chart();
		const plan = must(run(c.page, c.strokes, [c.note]));
		expect(plan.boxes).toBe(3);
		expect(plan.arrows).toBe(2);
		const hist = new History(() => c.doc);
		expect(hist.execute(plan.cmd)).toBe(true);
		const get = (s: Stroke): Stroke => plan.strokes[c.strokes.indexOf(s)]!;
		// the recogniser's boxes of the result (not the raw points: a hand-drawn outline overshoots where it closes)
		const model = readFlowchart(plan.strokes, plan.elements);
		if (model === "few" || model === "nested") throw new Error(model);
		const [top, mid, bottom] = model.nodes.map((n) => n.box) as [Outline, Outline, Outline];
		const cx = [top, mid, bottom].map((b) => (b.minX + b.maxX) / 2);
		expect(Math.max(...cx) - Math.min(...cx)).toBeLessThan(0.05);
		expect(mid.minY - top.maxY).toBeCloseTo(bottom.minY - mid.maxY, 1);
		expect(top.minY % 8).toBeCloseTo(0, 0);
		// the box strokes only moved: same number of points, same pressure and style, every point shifted by one vector
		const moved = get(c.mid);
		const dx = moved.points[0]![0] - c.mid.points[0]![0], dy = moved.points[0]![1] - c.mid.points[0]![1];
		moved.points.forEach((p, i) => {
			expect(p[2]).toBeCloseTo(c.mid.points[i]![2], 3);
			expect(p[0] - c.mid.points[i]![0]).toBeCloseTo(dx, 1);
			expect(p[1] - c.mid.points[i]![1]).toBeCloseTo(dy, 1);
		});
		expect(moved.id).toBe(c.mid.id);
		expect(moved.color).toBe(c.mid.color);
		expect(moved.tool).toBe(c.mid.tool);
		// a label stroke moved by exactly its box's vector
		const label = get(c.labelMid[0]!);
		expect(label.points[0]![0] - c.labelMid[0]!.points[0]![0]).toBeCloseTo(dx, 1);
		expect(label.points[0]![1] - c.labelMid[0]!.points[0]![1]).toBeCloseTo(dy, 1);
		const note = c.page.elements![0]! as TextElement;
		expect(note.x - c.note.x).toBeCloseTo(get(c.bottom).points[0]![0] - c.bottom.points[0]![0], 1);
		// the arrows are clean shape strokes from outline to outline
		const arrows = c.page.strokes.filter((s) => arrowEnds(s.points));
		expect(arrows).toHaveLength(2);
		for (const a of arrows) {
			expect(a.tool).toBe("shape");
			expect(a.color).toBe("#1e1e1e");
			expect(a.width).toBe(1.6);
		}
		const e1 = arrowEnds(get(c.a1).points)!, e2 = arrowEnds(get(c.a2).points)!;
		expect(e1.tail[1]).toBeCloseTo(top.maxY + 1.5, 0);
		expect(e1.tip[1]).toBeCloseTo(mid.minY - 1.5, 0);
		expect(e2.tail[1]).toBeCloseTo(mid.maxY + 1.5, 0);
		expect(e2.tip[1]).toBeCloseTo(bottom.minY - 1.5, 0);
		expect(e1.tip[0]).toBeCloseTo(e1.tail[0], 6);
		// the order of the strokes on the page and their ids are kept
		expect(c.page.strokes.map((s) => s.id)).toEqual(c.strokes.map((s) => s.id));
	});

	it("is ONE undo step that restores the exact objects, and redo does it again", () => {
		const c = chart();
		const before = [...c.page.strokes];
		const note = c.page.elements![0]!;
		const plan = must(run(c.page, c.strokes, [c.note]));
		expect(plan.cmd.label).toBe(FLOWCHART_LABEL);
		const hist = new History(() => c.doc);
		expect(hist.execute(plan.cmd)).toBe(true);
		expect(c.page.strokes.some((s, i) => s !== before[i])).toBe(true);
		hist.undo();
		expect(c.page.strokes).toEqual(before);
		expect(c.page.strokes.every((s, i) => s === before[i])).toBe(true);
		expect(c.page.elements![0]).toBe(note);
		expect(hist.canUndo()).toBe(false);
		hist.redo();
		expect(c.page.strokes.some((s, i) => s !== before[i])).toBe(true);
		expect(c.page.strokes).toHaveLength(before.length);
	});

	it("the result saves and reads back, and tidying it again changes nothing", () => {
		const c = chart();
		const plan = must(run(c.page, c.strokes, [c.note]));
		new History(() => c.doc).execute(plan.cmd);
		const parsed = parse(serialize(c.doc));
		expect(parsed.ok).toBe(true);
		const again = run(c.page, plan.strokes, plan.elements);
		expect(again).toEqual({ ok: false, reason: "none" });
	});

	it("moves the writing beside an arrow (a yes or a no) with the middle of the arrow, and leaves writing farther away", () => {
		const c = chart();
		const yes = scribble(150, 118, 41);
		const far = scribble(330, 120, 42);
		c.page.strokes.push(...yes, ...far);
		const all = [...c.strokes, ...yes, ...far];
		const plan = must(run(c.page, all, [c.note]));
		new History(() => c.doc).execute(plan.cmd);
		const oldEnds = arrowEnds(c.a1.points)!;
		const newEnds = arrowEnds(plan.strokes[all.indexOf(c.a1)]!.points)!;
		const shift = [(newEnds.tail[0] + newEnds.tip[0] - oldEnds.tail[0] - oldEnds.tip[0]) / 2, (newEnds.tail[1] + newEnds.tip[1] - oldEnds.tail[1] - oldEnds.tip[1]) / 2];
		expect(Math.hypot(shift[0]!, shift[1]!)).toBeGreaterThan(1);
		for (const s of yes) {
			const moved = plan.strokes[all.indexOf(s)]!;
			// (the drawn arrow's ends are those the recogniser read; the test reads them with `arrowEnds`: a fraction of a point apart)
			expect(moved.points[0]![0] - s.points[0]![0]).toBeCloseTo(shift[0]!, 0);
			expect(moved.points[0]![1] - s.points[0]![1]).toBeCloseTo(shift[1]!, 0);
		}
		expect(c.page.strokes).toContain(far[0]);
	});

	it("leaves ink that is not a flowchart where it is, and the group of an arrow", () => {
		const c = chart();
		const far = scribble(400, 600, 44);
		c.page.strokes.push(...far);
		c.page.strokes.splice(c.page.strokes.indexOf(c.a1), 1, freezeStroke({ ...c.a1, group: "g1" }));
		c.page.strokes.splice(c.page.strokes.indexOf(c.a2), 1, freezeStroke({ ...c.a2, group: "g1" }));
		const sel = c.page.strokes;
		const plan = must(run(c.page, sel, [c.note]));
		new History(() => c.doc).execute(plan.cmd);
		for (const s of far) expect(c.page.strokes).toContain(s);
		expect(c.page.strokes.filter((s) => s.group === "g1")).toHaveLength(2);
	});

	it("turns a line with a small head into one arrow and undo brings the head back where it was", () => {
		const a = rect(103, 52, 120, 48), b = rect(96, 190, 130, 48, 7);
		const shaft = line([163, 102], [163, 186], 8);
		const head = stroke([pt(155, 174), pt(163, 187), pt(171, 174)]);
		const extra = stroke([pt(1, 1), pt(2, 2)]);
		const { doc, page } = pageWith([extra, a, shaft, head, b]);
		const order = [...page.strokes];
		const plan = must(run(page, [a, shaft, head, b]));
		expect(plan.arrows).toBe(1);
		const hist = new History(() => doc);
		hist.execute(plan.cmd);
		expect(page.strokes).toHaveLength(4);
		expect(page.strokes.filter((s) => arrowEnds(s.points))).toHaveLength(1);
		expect(plan.strokes).toHaveLength(3);
		hist.undo();
		expect(page.strokes).toEqual(order);
		expect(page.strokes.every((s, i) => s === order[i])).toBe(true);
	});

	it("draws a plain line as a plain line", () => {
		const a = rect(103, 52, 120, 48), b = rect(96, 190, 130, 48, 7);
		const l = line([163, 102], [163, 188], 8);
		const { doc, page } = pageWith([a, l, b]);
		const plan = must(run(page, [a, l, b]));
		new History(() => doc).execute(plan.cmd);
		const drawnLine = page.strokes.find((s) => s.id === l.id)!;
		expect(drawnLine.tool).toBe("shape");
		expect(arrowEnds(drawnLine.points)).toBeNull();
		const first = drawnLine.points[0]!, last = drawnLine.points[drawnLine.points.length - 1]!;
		expect(drawnLine.points).toHaveLength(Math.ceil(Math.hypot(first[0] - last[0], first[1] - last[1]) / 3) + 1);
	});

	it("separates two arrows between the same two boxes", () => {
		const a = rect(100, 52, 120, 48), b = rect(100, 200, 120, 48, 7);
		const down = arrow([140, 102], [140, 198], 4), up = arrow([180, 198], [180, 102], 9);
		const { doc, page } = pageWith([a, b, down, up]);
		const plan = must(run(page, [a, b, down, up]));
		new History(() => doc).execute(plan.cmd);
		const e1 = arrowEnds(plan.strokes[2]!.points)!, e2 = arrowEnds(plan.strokes[3]!.points)!;
		expect(Math.abs(e1.tail[0] - e2.tail[0])).toBeCloseTo(12, 1);
		expect(e1.tip[1]).toBeGreaterThan(e1.tail[1]);
		expect(e2.tip[1]).toBeLessThan(e2.tail[1]);
	});

	it("says why not: too few boxes, nested boxes", () => {
		const one = rect(100, 100, 100, 50);
		const { page } = pageWith([one]);
		expect(run(page, [one])).toEqual({ ok: false, reason: "few" });
		const a = rect(100, 100, 300, 200), b = rect(140, 140, 200, 120, 5), c = rect(500, 100, 100, 50, 9);
		expect(run(pageWith([a, b, c]).page, [a, b, c])).toEqual({ ok: false, reason: "nested" });
	});

	it("does not touch hidden ink, locked text boxes, ink of a drawing-state part, or strokes that are not on the page", () => {
		const c = chart();
		const hiddenBox = freezeStroke({ ...rect(300, 52, 120, 48, 15), hidden: true });
		const alien = rect(500, 52, 120, 48, 17);
		c.page.strokes.push(hiddenBox);
		const lockedNote = freezeElement({ ...c.note, locked: true });
		c.page.elements = [lockedNote];
		const plan = must(run(c.page, [...c.page.strokes, alien], [lockedNote]));
		expect(plan.boxes).toBe(3);
		new History(() => c.doc).execute(plan.cmd);
		expect(c.page.strokes).toContain(hiddenBox);
		expect(c.page.elements[0]).toBe(lockedNote);
		const inPart = chart();
		inPart.page.states = { parts: [{ id: "p", items: [inPart.mid.id], pivot: { x: 0, y: 0 } }], states: [] } as unknown as Page["states"];
		expect(run(inPart.page, inPart.strokes, [inPart.note])).toMatchObject({ ok: true, boxes: 2 });
	});
});

describe("planFlowchart refusals (0.30, #245): redaction, tape, page edge", () => {
	function chart() {
		const top = rect(103, 52, 120, 48), bottom = rect(96, 220, 130, 48, 7);
		const a = arrow([163, 102], [163, 218], 4);
		const { doc, page } = pageWith([top, bottom, a]);
		return { doc, page, top, bottom, a };
	}

	it("refuses when a moved box touches a redaction box before or after, and when the boxes cannot be read", () => {
		const c = chart();
		const sel = [c.top, c.bottom, c.a];
		expect(run(c.page, sel, [], { boxes: [{ x: 90, y: 40, width: 150, height: 80 }] as RedactGuard["boxes"] })).toEqual({ ok: false, reason: "redacted" });
		// after: the box is not under it now but the layout would put it there (second box is pulled up by the equal gap? use a far target)
		const probe = must(run(c.page, sel));
		const moved = probe.strokes[1]!;
		const b = strokeBounds(moved);
		expect(run(c.page, sel, [], { boxes: [{ x: b.minX + 5, y: b.minY + 5, width: 20, height: 10 }] as RedactGuard["boxes"] })).toEqual({ ok: false, reason: "redacted" });
		expect(run(c.page, sel, [], { boxes: [], unreadable: true })).toEqual({ ok: false, reason: "redacted" });
		expect(run(c.page, sel, [], { boxes: [{ x: 900, y: 900, width: 20, height: 20 }] as RedactGuard["boxes"] }).ok).toBe(true);
	});

	it("refuses when moved ink touches a study tape", () => {
		const c = chart();
		const tape = createTape([60, 40], [280, 140], c.page, "#8fd3bf")!;
		c.page.elements = [tape];
		expect(run(c.page, [c.top, c.bottom, c.a])).toEqual({ ok: false, reason: "tape" });
	});

	it("refuses when the chart would leave the page", () => {
		const a = rect(103, 52, 120, 48), b = rect(96, 220, 130, 48, 7);
		const { page } = pageWith([a, b]);
		page.height = 260;
		expect(run(page, [a, b])).toEqual({ ok: false, reason: "edge" });
	});

	it("is classified: the step names ONE page and is not global", () => {
		const c = chart();
		const plan = must(run(c.page, [c.top, c.bottom, c.a]));
		const scope = computeScope(plan.cmd);
		expect(scope.local).toBe(true);
		expect([...scope.pages]).toEqual([c.page.id]);
		expect(scope.all).toBe(false);
	});
});

describe("flowcharts drawn with the shape tool or snapped by hold-to-snap (0.30, #245)", () => {
	const shapeStroke = (points: Point[]): Stroke => stroke(points, "shape");
	it("reads clean rectangles, ellipses, diamonds (square and not) and arrows, and tidies them in one step", () => {
		const a = shapeStroke(rectPoints([100, 60], [220, 110]));
		const b = shapeStroke(ellipsePoints([172, 230], 62, 28));
		const c = shapeStroke(polygonPoints([[160, 330], [250, 380], [160, 430], [70, 380]], true));
		const d = shapeStroke(polygonPoints([[420, 330], [470, 380], [420, 430], [370, 380]], true));
		const e1 = shapeStroke(arrowPoints([160, 112], [168, 200], 12));
		const e2 = shapeStroke(arrowPoints([168, 260], [160, 326], 12));
		const { doc, page } = pageWith([a, b, c, d, e1, e2]);
		const model = readFlowchart([a, b, c, d, e1, e2], []);
		if (model === "few" || model === "nested") throw new Error(model);
		expect(model.nodes.map((n) => n.shape)).toEqual(["rectangle", "ellipse", "diamond", "diamond"]);
		expect(model.edges).toHaveLength(2);
		const plan = must(run(page, [a, b, c, d, e1, e2]));
		expect(new History(() => doc).execute(plan.cmd)).toBe(true);
		const again = run(page, plan.strokes, []);
		expect(again).toEqual({ ok: false, reason: "none" });
	});

	it("an arrow of the shape tool whose ends are already on the outlines is left alone", () => {
		// (already on the grid, with a gap that is a multiple of it)
		const a = shapeStroke(rectPoints([96, 96], [216, 144]));
		const b = shapeStroke(rectPoints([96, 224], [216, 272]));
		const link = shapeStroke(arrowPoints([156, 145.5], [156, 222.5], 12));
		const { page } = pageWith([a, b, link]);
		expect(run(page, [a, b, link])).toEqual({ ok: false, reason: "none" });
	});
});

describe("flowGrid", () => {
	it("is never finer than 8 pt and a multiple of the paper's step", () => {
		expect(flowGrid(undefined)).toBe(8);
		expect(flowGrid(0)).toBe(8);
		expect(flowGrid(14.17)).toBe(14.17);
		expect(flowGrid(2.83)).toBeCloseTo(2.83 * 3, 9);
		expect(flowGrid(20)).toBe(20);
	});
});
