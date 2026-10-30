import { describe, expect, it } from "vitest";
import i18n from "../src/i18n.ts?raw";
import { ACTIONS, baseContext, isChecked, type UiContext } from "../src/ui/actions";
import { buildSheet, contextBar } from "../src/ui/layout";
import toolbarSource from "../src/view/toolbar.ts?raw";
import { ALIGN_MODES, alignItems, alignPlacement, clusterStrokes, distributePlacement, GROUP_GAP } from "../src/ink/align";
import { elementBounds } from "../src/ink/elements";
import { strokeBounds } from "../src/ink/hit-test";
import { pointInPolygon, rectanglePolygon, strokesInLasso } from "../src/ink/lasso";
import {
	applyPlacement, inkOwnership, itemsBounds, lockedSize, mirrorPlacement, rotate90Matrix, sizeMatrix, uniformPlacement,
} from "../src/ink/selection-transform";
import { styleCatalog, selectByStyle, selectSimilar } from "../src/ink/select-similar";
import { apply } from "../src/ink/transform";
import { createDocument, createId, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { serializeChecked } from "../src/model/serialize";
import type { BoxElement, ImageElement, NotebookDocument, Stroke, TextElement } from "../src/model/types";
import { line } from "./helpers";

const NOW = new Date("2026-10-29T10:00:00.000Z");

/** A short horizontal stroke with varying pressure, so that "pressure kept" is checked on real values. */
function bar(x: number, y: number, len = 40, width = 2, color = "#1e1e1e", tool: "pen" | "highlighter" = "pen"): Stroke {
	const pts = [0, 0.25, 0.5, 0.75, 1].map((k, i) => quantizePoint(x + len * k, y, 0.2 + 0.15 * i));
	return createStroke(color, width, pts, tool);
}
const image = (x: number, y: number, w = 80, h = 60, rotation = 0): ImageElement => ({ id: createId(), type: "image", asset: "a1", x, y, width: w, height: h, rotation });
const text = (x: number, y: number, color = "#1e1e1e"): TextElement => ({ id: createId(), type: "text", x, y, width: 100, text: "hello", fontSize: 14, color });
const box = (x: number, y: number, w = 50, h = 30): BoxElement => ({ id: createId(), type: "box", kind: "definition", x, y, width: w, height: h });

function pageWith(strokes: Stroke[], elements: Array<ImageElement | TextElement | BoxElement> = []): { doc: NotebookDocument; page: NotebookDocument["pages"][number]; history: History } {
	const doc = createDocument(NOW);
	const page = doc.pages[0]!;
	page.strokes.push(...strokes);
	if (elements.length > 0) page.elements = [...elements];
	return { doc, page, history: new History(() => doc) };
}

describe("rectangle selection (63)", () => {
	it("builds a closed box polygon from two corners, whichever way it is dragged", () => {
		const poly = rectanglePolygon([10, 20], [50, 80]);
		expect(poly).toEqual([[10, 20], [50, 20], [50, 80], [10, 80]]);
		const back = rectanglePolygon([50, 80], [10, 20]);
		expect(pointInPolygon(30, 50, back)).toBe(true);
		expect(pointInPolygon(60, 50, back)).toBe(false);
	});

	it("picks the same strokes as a lasso of the same outline, and respects the ink it is given (hidden ink stays out)", () => {
		const inside = bar(20, 30, 20);
		const outside = bar(200, 200, 20);
		const hidden = createStroke("#ff0000", 2, [quantizePoint(25, 35, 0.5), quantizePoint(35, 35, 0.5)]);
		hidden.hidden = true;
		const poly = rectanglePolygon([0, 0], [100, 100]);
		// The view hands the rectangle the visible ink only, exactly as it does for the lasso.
		const visible = [inside, outside];
		expect(strokesInLasso(visible, poly)).toEqual([inside]);
		expect(strokesInLasso([inside, outside, hidden], poly)).toContain(hidden);
		expect(strokesInLasso(visible, poly)).not.toContain(hidden);
	});

	it("selects nothing for a degenerate (flat) rectangle", () => {
		const s = bar(20, 30, 20);
		expect(strokesInLasso([s], rectanglePolygon([0, 30], [100, 30]))).toEqual([]);
	});
});

describe("select by colour or tool (64)", () => {
	const red = bar(10, 10, 20, 2, "#dc2626");
	const red2 = bar(10, 40, 20, 3, "#DC2626");
	const blue = bar(10, 70, 20, 2, "#1d4ed8");
	const yellow = bar(10, 100, 30, 14, "#facc15", "highlighter");
	const green = bar(10, 130, 30, 14, "#4ade80", "highlighter");
	const all = [red, red2, blue, yellow, green];
	const redText = text(100, 10, "#dc2626");
	const blueText = text(100, 50, "#1d4ed8");

	it("the same colour takes strokes and text boxes of that colour, ignoring letter case", () => {
		const got = selectSimilar(all, [redText, blueText], { strokes: [red], elements: [] }, "colour");
		expect(got.strokes).toEqual([red, red2]);
		expect(got.elements).toEqual([redText]);
	});

	it("the same tool takes every stroke of the tool and never a text box", () => {
		const got = selectSimilar(all, [redText], { strokes: [yellow], elements: [] }, "tool");
		expect(got.strokes).toEqual([yellow, green]);
		expect(got.elements).toEqual([]);
	});

	it("a seed with several colours takes all of them", () => {
		const got = selectSimilar(all, [], { strokes: [red, blue], elements: [] }, "colour");
		expect(got.strokes).toEqual([red, red2, blue]);
	});

	it("the picker lists tools, colours and tool-colour pairs, most used first", () => {
		const cat = styleCatalog(all, [redText, blueText]);
		expect(cat.tools).toEqual([{ tool: "pen", count: 3 }, { tool: "highlighter", count: 2 }]);
		expect(cat.colours[0]).toEqual({ colour: "#dc2626", count: 3 });
		expect(cat.colours.map((c) => c.colour)).toContain("#facc15");
		expect(cat.combos.find((c) => c.tool === "highlighter" && c.colour === "#facc15")?.count).toBe(1);
		expect(styleCatalog([], [])).toEqual({ tools: [], colours: [], combos: [] });
	});

	it("picks by tool, by colour, or by both (all highlighter strokes on this page)", () => {
		expect(selectByStyle(all, [redText], { tool: "highlighter" }).strokes).toEqual([yellow, green]);
		expect(selectByStyle(all, [redText], { colour: "#DC2626" })).toEqual({ strokes: [red, red2], elements: [redText] });
		expect(selectByStyle(all, [redText], { tool: "pen", colour: "#dc2626" })).toEqual({ strokes: [red, red2], elements: [] });
		expect(selectByStyle(all, [], {})).toEqual({ strokes: [], elements: [] });
	});

	it("only sees the strokes it is given: hidden ink that the view withholds is not selected", () => {
		const hidden = bar(10, 160, 20, 2, "#dc2626");
		hidden.hidden = true;
		const visible = all.filter((s) => !s.hidden);
		expect(selectByStyle(visible, [], { colour: "#dc2626" }).strokes).not.toContain(hidden);
	});
});

describe("align and distribute (38)", () => {
	it("gathers strokes that touch or lie within the gap into one group, and leaves far ones apart", () => {
		const a = bar(0, 0, 20), b = bar(22, 0, 20), c = bar(100, 0, 20), d = bar(0, 200, 20);
		const groups = clusterStrokes([a, b, c, d]);
		expect(groups.map((g) => g.length).sort()).toEqual([1, 1, 2]);
		expect(groups.find((g) => g.length === 2)).toEqual([a, b]);
		// Just beyond the gap, two strokes are two groups.
		const e = bar(0, 0, 20, 2), f = bar(20 + 2 + GROUP_GAP + 1, 0, 20, 2);
		expect(clusterStrokes([e, f]).length).toBe(2);
	});

	it("aligns left, centre, right, top, middle and bottom on the edges of the whole selection", () => {
		const a = bar(10, 10, 20), b = bar(100, 60, 40), c = bar(200, 140, 10);
		const items = alignItems([a, b, c], []);
		expect(items.length).toBe(3);
		const u = itemsBounds([a, b, c], [])!;
		const apply1 = (mode: (typeof ALIGN_MODES)[number]) => {
			const { page } = pageWith([a, b, c]);
			const plan = applyPlacement(page, [a, b, c], [], alignPlacement(items, mode)!)!;
			return plan.strokes.map(strokeBounds);
		};
		const left = apply1("left");
		for (const bb of left) expect(bb.minX).toBeCloseTo(u.minX, 1);
		const right = apply1("right");
		for (const bb of right) expect(bb.maxX).toBeCloseTo(u.maxX, 1);
		const centre = apply1("centre");
		for (const bb of centre) expect((bb.minX + bb.maxX) / 2).toBeCloseTo((u.minX + u.maxX) / 2, 1);
		const top = apply1("top");
		for (const bb of top) expect(bb.minY).toBeCloseTo(u.minY, 1);
		const bottom = apply1("bottom");
		for (const bb of bottom) expect(bb.maxY).toBeCloseTo(u.maxY, 1);
		const middle = apply1("middle");
		for (const bb of middle) expect((bb.minY + bb.maxY) / 2).toBeCloseTo((u.minY + u.maxY) / 2, 1);
	});

	it("moves groups rigidly: handwriting keeps its shape, pressure and ids", () => {
		const w1 = [bar(10, 10, 20), bar(12, 14, 20)]; // one word of two strokes
		const w2 = [bar(100, 60, 20)];
		const { page, history } = pageWith([...w1, ...w2]);
		const items = alignItems([...w1, ...w2], []);
		expect(items.length).toBe(2);
		const before = w1.map((s) => s.points.map((p) => [p[0], p[1], p[2]]));
		const placement = alignPlacement(items, "left")!;
		const plan = applyPlacement(page, [...w1, ...w2], [], placement)!;
		history.execute(plan.command);
		const moved = plan.strokes.slice(0, 2);
		// The word 1 is already at the left edge: it did not move at all; word 2 moved left by 90.
		expect(moved.map((s) => s.points.map((p) => [p[0], p[1], p[2]]))).toEqual(before);
		const second = plan.strokes[2]!;
		expect(second.points.map((p) => p[2])).toEqual(w2[0]!.points.map((p) => p[2]));
		expect(second.points[0]![0]).toBeCloseTo(10, 5);
		expect(second.id).toBe(w2[0]!.id);
		expect(page.strokes.length).toBe(3);
	});

	it("is one undo step and survives the checked writer", () => {
		const a = bar(10, 10), b = bar(100, 80), c = bar(200, 150);
		const { doc, page, history } = pageWith([a, b, c]);
		const plan = applyPlacement(page, [a, b, c], [], alignPlacement(alignItems([a, b, c], []), "top")!, undefined, "Align selection")!;
		history.execute(plan.command);
		expect(page.strokes.map((s) => strokeBounds(s).minY.toFixed(1))).toEqual(["9.0", "9.0", "9.0"]);
		expect(() => serializeChecked(doc)).not.toThrow();
		history.undo();
		expect(page.strokes).toEqual([a, b, c]);
		expect(history.canUndo()).toBe(false);
		history.redo();
		expect(page.strokes.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
	});

	it("aligns strokes and elements together, each element as one item", () => {
		const s = bar(0, 0, 30);
		const img = image(100, 50, 80, 60);
		const txt = text(220, 120);
		const { page } = pageWith([s], [img, txt]);
		const items = alignItems([s], [img, txt]);
		expect(items.length).toBe(3);
		const plan = applyPlacement(page, [s], [img, txt], alignPlacement(items, "top")!)!;
		const top = itemsBounds(plan.strokes, plan.elements)!.minY;
		expect(strokeBounds(plan.strokes[0]!).minY).toBeCloseTo(top, 1);
		expect(elementBounds(plan.elements[0]!).minY).toBeCloseTo(top, 1);
		expect(elementBounds(plan.elements[1]!).minY).toBeCloseTo(top, 1);
	});

	it("does nothing for one item, and aligning twice changes nothing the second time", () => {
		const a = bar(10, 10), b = bar(100, 80);
		expect(alignPlacement(alignItems([a], []), "left")).toBeNull();
		const { page } = pageWith([a, b]);
		const plan = applyPlacement(page, [a, b], [], alignPlacement(alignItems([a, b], []), "bottom")!)!;
		expect(alignPlacement(alignItems(plan.strokes, []), "bottom")).toBeNull();
	});

	it("distributes with equal gaps between neighbours and keeps both ends", () => {
		const a = bar(0, 0, 20), b = bar(40, 0, 20), c = bar(200, 0, 20), d = bar(300, 0, 20);
		const { page } = pageWith([a, b, c, d]);
		const items = alignItems([a, b, c, d], []);
		const plan = applyPlacement(page, [a, b, c, d], [], distributePlacement(items, "horizontal")!)!;
		const boxes = plan.strokes.map(strokeBounds).sort((p, q) => p.minX - q.minX);
		const gaps = [1, 2, 3].map((i) => boxes[i]!.minX - boxes[i - 1]!.maxX);
		expect(gaps[0]).toBeCloseTo(gaps[1]!, 1);
		expect(gaps[1]).toBeCloseTo(gaps[2]!, 1);
		expect(boxes[0]!.minX).toBeCloseTo(strokeBounds(a).minX, 1);
		expect(boxes[3]!.maxX).toBeCloseTo(strokeBounds(d).maxX, 1);
	});

	it("distributes vertically, mixing a picture and ink", () => {
		const a = bar(0, 0, 20), img = image(0, 40, 50, 20), c = bar(0, 300, 20);
		const { page } = pageWith([a, c], [img]);
		const items = alignItems([a, c], [img]);
		const plan = applyPlacement(page, [a, c], [img], distributePlacement(items, "vertical")!)!;
		const boxes = [strokeBounds(plan.strokes[0]!), elementBounds(plan.elements[0]!), strokeBounds(plan.strokes[1]!)];
		expect(boxes[1]!.minY - boxes[0]!.maxY).toBeCloseTo(boxes[2]!.minY - boxes[1]!.maxY, 1);
	});

	it("needs three items to distribute", () => {
		const a = bar(0, 0), b = bar(100, 0);
		expect(distributePlacement(alignItems([a, b], []), "horizontal")).toBeNull();
	});

	it("keeps ink written on a selected picture with the picture (ink follows objects)", () => {
		const img = image(100, 100, 100, 80);
		const onPicture = bar(120, 130, 40); // lies on the picture
		const other = bar(0, 0, 20);
		const { page } = pageWith([onPicture, other], [img]);
		const own = inkOwnership(page, [onPicture, other], [img]);
		expect(own.owner.get(onPicture)).toBe(img);
		const items = alignItems([onPicture, other], [img], own);
		expect(items.length).toBe(2); // the picture with its ink, and the free stroke
		const plan = applyPlacement(page, [onPicture, other], [img], alignPlacement(items, "left")!)!;
		const dx = elementBounds(plan.elements[0]!).minX - elementBounds(img).minX;
		expect(dx).toBeLessThan(0);
		expect(plan.strokes[0]!.points[0]![0] - onPicture.points[0]![0]).toBeCloseTo(dx, 1);
	});

	it("moves unselected ink written on a selected picture along with it", () => {
		const img = image(100, 100, 100, 80);
		const note = bar(120, 130, 40);
		const free = bar(0, 0, 20);
		const { page } = pageWith([note, free], [img]);
		const own = inkOwnership(page, [free], [img]);
		expect(own.followers).toEqual([note]);
		const plan = applyPlacement(page, [free], [img], alignPlacement(alignItems([free], [img], own), "left")!)!;
		expect(plan).not.toBeNull();
		expect(page.strokes.includes(note)).toBe(true);
	});
});

describe("rotate by 90 degrees (65)", () => {
	it("rotates points a quarter turn about the centre of the selection, keeping pressure", () => {
		const s = bar(0, 0, 40);
		const { page, history } = pageWith([s]);
		const b = itemsBounds([s], [])!;
		const m = rotate90Matrix(b, true);
		const plan = applyPlacement(page, [s], [], uniformPlacement([s], [], [], m))!;
		history.execute(plan.command);
		const r = plan.strokes[0]!;
		expect(r.points.map((p) => p[2])).toEqual(s.points.map((p) => p[2]));
		// A horizontal bar becomes a vertical one, centred where it was.
		const rb = itemsBounds([r], [])!;
		expect(rb.maxX - rb.minX).toBeCloseTo(b.maxY - b.minY, 1);
		expect(rb.maxY - rb.minY).toBeCloseTo(b.maxX - b.minX, 1);
		expect((rb.minX + rb.maxX) / 2).toBeCloseTo((b.minX + b.maxX) / 2, 1);
		expect((rb.minY + rb.maxY) / 2).toBeCloseTo((b.minY + b.maxY) / 2, 1);
		// Clockwise on the page: the left end goes up, the right end goes down.
		expect(r.points[0]![1]).toBeLessThan(r.points[4]![1]);
	});

	it("four quarter turns bring the points back; clockwise then anticlockwise is the identity", () => {
		const s = line(10, 20, 90, 60, 12);
		let cur = [s];
		const b = itemsBounds(cur, [])!;
		const { page } = pageWith(cur);
		for (let i = 0; i < 4; i++) {
			const plan = applyPlacement(page, cur, [], uniformPlacement(cur, [], [], rotate90Matrix(b, true)))!;
			page.strokes.splice(0, page.strokes.length, ...plan.strokes);
			cur = plan.strokes;
		}
		cur[0]!.points.forEach((p, i) => {
			expect(p[0]).toBeCloseTo(s.points[i]![0], 1);
			expect(p[1]).toBeCloseTo(s.points[i]![1], 1);
		});
		const m = rotate90Matrix(b, true);
		const n = rotate90Matrix(b, false);
		const [x, y] = apply(n, ...apply(m, 33, 44));
		expect([x, y]).toEqual([33, 44]);
	});

	it("turns a picture by 90 degrees (rotation field) and swaps the box of an axis-aligned element, in one undo step", () => {
		const img = image(100, 100, 80, 60, 0);
		const bx = box(300, 100, 50, 30);
		const s = bar(100, 300, 40);
		const { doc, page, history } = pageWith([s], [img, bx]);
		const b = itemsBounds([s], [img, bx])!;
		const plan = applyPlacement(page, [s], [img, bx], uniformPlacement([s], [img, bx], [], rotate90Matrix(b, true)))!;
		history.execute(plan.command);
		const ri = plan.elements[0] as ImageElement;
		expect(ri.rotation).toBeCloseTo(Math.PI / 2, 6);
		expect(ri.width).toBe(80);
		expect(ri.height).toBe(60);
		const rb = plan.elements[1] as BoxElement;
		expect([rb.width, rb.height]).toEqual([30, 50]);
		expect(() => serializeChecked(doc)).not.toThrow();
		history.undo();
		expect(page.elements).toEqual([img, bx]);
		expect(page.strokes).toEqual([s]);
	});
});

describe("mirror (65)", () => {
	it("flips ink left to right about the centre of the selection and keeps the ends' pressure", () => {
		const a = line(0, 0, 40, 10, 8);
		const b = line(60, 30, 100, 50, 8);
		const bounds = itemsBounds([a, b], [])!;
		const { page } = pageWith([a, b]);
		const plan = applyPlacement(page, [a, b], [], mirrorPlacement([a, b], [], bounds, "horizontal"))!;
		const [ma, mb] = plan.strokes as [Stroke, Stroke];
		const cx = (bounds.minX + bounds.maxX) / 2;
		a.points.forEach((p, i) => {
			expect(ma.points[i]![0]).toBeCloseTo(2 * cx - p[0], 1);
			expect(ma.points[i]![1]).toBeCloseTo(p[1], 1);
			expect(ma.points[i]![2]).toBe(p[2]);
		});
		// The right-hand stroke ends up on the left.
		expect(strokeBounds(mb).maxX).toBeLessThan(strokeBounds(ma).minX);
		const after = itemsBounds(plan.strokes, [])!;
		expect(after.minX).toBeCloseTo(bounds.minX, 1);
		expect(after.maxX).toBeCloseTo(bounds.maxX, 1);
	});

	it("flips top to bottom, and mirroring twice restores the points", () => {
		const s = line(10, 10, 80, 60, 8);
		const bounds = itemsBounds([s], [])!;
		const { page } = pageWith([s]);
		const once = applyPlacement(page, [s], [], mirrorPlacement([s], [], bounds, "vertical"))!;
		expect(once.strokes[0]!.points[0]![1]).toBeCloseTo(s.points[s.points.length - 1]![1], 1);
		page.strokes.splice(0, 1, ...once.strokes);
		const twice = applyPlacement(page, once.strokes, [], mirrorPlacement(once.strokes, [], bounds, "vertical"))!;
		twice.strokes[0]!.points.forEach((p, i) => {
			expect(p[0]).toBeCloseTo(s.points[i]![0], 1);
			expect(p[1]).toBeCloseTo(s.points[i]![1], 1);
		});
	});

	it("moves pictures and text boxes to the mirrored place without flipping them, and ink on a picture goes with it", () => {
		const img = image(200, 100, 80, 60, 0.3);
		const onPicture = bar(215, 125, 30);
		const free = bar(0, 100, 40);
		const { page } = pageWith([onPicture, free], [img]);
		const own = inkOwnership(page, [onPicture, free], [img]);
		const bounds = itemsBounds([onPicture, free], [img])!;
		const plan = applyPlacement(page, [onPicture, free], [img], mirrorPlacement([onPicture, free], [img], bounds, "horizontal", own))!;
		const mi = plan.elements[0] as ImageElement;
		expect(mi.rotation).toBe(0.3);
		expect([mi.width, mi.height]).toEqual([80, 60]);
		const cx = (bounds.minX + bounds.maxX) / 2;
		const before = elementBounds(img);
		expect((elementBounds(mi).minX + elementBounds(mi).maxX) / 2).toBeCloseTo(2 * cx - (before.minX + before.maxX) / 2, 1);
		// The ink on the picture was translated like the picture (not flipped).
		const dx = elementBounds(mi).minX - before.minX;
		expect(plan.strokes[0]!.points[0]![0] - onPicture.points[0]![0]).toBeCloseTo(dx, 1);
		expect(plan.strokes[0]!.points[4]![0] - plan.strokes[0]!.points[0]![0]).toBeGreaterThan(0);
	});
});

describe("exact size (65)", () => {
	it("gives ink the requested width and height, keeping the top-left corner and the pressure", () => {
		const a = line(10, 20, 110, 70, 20, 2);
		const b = line(30, 40, 90, 90, 20, 2);
		const before = itemsBounds([a, b], [])!;
		const m = sizeMatrix([a, b], [], 200, 50)!;
		const { page, history } = pageWith([a, b]);
		const plan = applyPlacement(page, [a, b], [], uniformPlacement([a, b], [], [], m))!;
		history.execute(plan.command);
		const after = itemsBounds(plan.strokes, [])!;
		expect(after.maxX - after.minX).toBeCloseTo(200, 0);
		expect(after.maxY - after.minY).toBeCloseTo(50, 0);
		expect(after.minX).toBeCloseTo(before.minX, 0);
		expect(after.minY).toBeCloseTo(before.minY, 0);
		expect(plan.strokes[0]!.points.map((p) => p[2])).toEqual(a.points.map((p) => p[2]));
		history.undo();
		expect(page.strokes).toEqual([a, b]);
	});

	it("sizes pictures and boxes exactly", () => {
		const img = image(10, 10, 100, 50);
		const bx = box(200, 10, 40, 40);
		const before = itemsBounds([], [img, bx])!;
		const w = (before.maxX - before.minX) * 2, h = (before.maxY - before.minY) * 3;
		const m = sizeMatrix([], [img, bx], w, h)!;
		const { page } = pageWith([], [img, bx]);
		const plan = applyPlacement(page, [], [img, bx], uniformPlacement([], [img, bx], [], m))!;
		const after = itemsBounds([], plan.elements)!;
		expect(after.maxX - after.minX).toBeCloseTo(w, 1);
		expect(after.maxY - after.minY).toBeCloseTo(h, 1);
	});

	it("refuses sizes that are not positive finite numbers and flat selections", () => {
		const a = bar(0, 0);
		expect(sizeMatrix([a], [], 0, 10)).toBeNull();
		expect(sizeMatrix([a], [], 10, -1)).toBeNull();
		expect(sizeMatrix([a], [], Number.NaN, 10)).toBeNull();
		expect(sizeMatrix([], [], 10, 10)).toBeNull();
	});

	it("limits the size so that numbers stay sane", () => {
		const a = line(0, 0, 10, 10, 4);
		const m = sizeMatrix([a], [], 1e9, 1e9)!;
		expect(Number.isFinite(m[0])).toBe(true);
		expect(m[0]).toBeLessThanOrEqual(20);
	});

	it("keeps proportions when locked: the other side follows the typed one", () => {
		expect(lockedSize({ width: 200, height: 100 }, "width", 50)).toEqual({ width: 50, height: 25 });
		expect(lockedSize({ width: 200, height: 100 }, "height", 30)).toEqual({ width: 60, height: 30 });
		expect(lockedSize({ width: 200, height: 100 }, "width", -3)).toEqual({ width: 200, height: 100 });
	});
});

describe("placement plan", () => {
	it("skips identity matrices and items that left the page, and is null when nothing changes", () => {
		const a = bar(0, 0), b = bar(50, 0);
		const { page } = pageWith([a]);
		expect(applyPlacement(page, [a], [], uniformPlacement([a], [], [], [1, 0, 0, 1, 0, 0]))).toBeNull();
		const plan = applyPlacement(page, [a, b], [], uniformPlacement([a, b], [], [], [1, 0, 0, 1, 10, 0]))!;
		expect(plan.strokes.length).toBe(1);
	});
});

describe("registry and bar placement (wave 0.10)", () => {
	const sel = (strokes: number, elements = 0, images = 0) => baseContext({ tool: "lasso", selection: { strokes, elements, images } });
	const idsOf = (c: UiContext, kind: "all" | "page" = "all") =>
		buildSheet(c, { kind, usage: {}, now: 0, label: (a) => a.id }).flatMap((s) => s.actions.map((a) => a.id));

	it("puts select similar, align and transform on the second row of a selection bar, within the width", () => {
		for (const width of [360, 800, 1280]) {
			const bar = contextBar(sel(3, 1), width, {}, 0)!;
			expect(bar.kind).toBe("selection");
			expect(bar.second, String(width)).toEqual(["selection-similar", "selection-align-menu", "selection-transform-menu"]);
			// The first row keeps its basics (the layer moves stay where wave 0.9 put them).
			expect(bar.actions).toContain("selection-copy");
		}
		expect(contextBar(sel(3, 1), 1280, {}, 0)!.actions).toEqual(expect.arrayContaining(["layer-front", "layer-back"]));
	});

	it("offers only what applies: align needs two things, similar needs ink, transform needs a selection", () => {
		expect(contextBar(sel(1), 800, {}, 0)!.second).toEqual(["selection-similar", "selection-transform-menu"]);
		expect(contextBar(sel(0, 1, 1), 800, {}, 0)!.second).toEqual(["selection-transform-menu"]);
		expect(contextBar(sel(0, 2, 2), 800, {}, 0)!.second).toEqual(["selection-align-menu", "selection-transform-menu"]);
		// Nothing selected: no second row at all.
		expect(contextBar(baseContext({ tool: "lasso" }), 800, {}, 0)).not.toHaveProperty("second");
	});

	it("lists every operation in the All actions sheet with a selection, and none of them without one", () => {
		const withSel = idsOf(sel(3, 1));
		for (const id of [
			"selection-align-left", "selection-align-centre", "selection-align-right", "selection-align-top", "selection-align-middle", "selection-align-bottom",
			"selection-distribute-h", "selection-distribute-v", "selection-rotate-cw", "selection-rotate-ccw", "selection-mirror-h", "selection-mirror-v",
			"selection-resize", "select-same-colour", "select-same-tool", "select-rectangle", "select-by-style",
		]) expect(withSel, id).toContain(id);
		const none = idsOf(baseContext());
		for (const id of ["selection-align-left", "selection-rotate-cw", "select-same-colour", "select-rectangle", "select-by-style"]) expect(none, id).not.toContain(id);
		// Distribute needs three things; with two it is not offered.
		expect(idsOf(sel(2))).not.toContain("selection-distribute-h");
		expect(idsOf(sel(2))).toContain("selection-align-left");
	});

	it("rectangle mode is a checked toggle of the lasso bar", () => {
		const a = ACTIONS.find((x) => x.id === "select-rectangle")!;
		expect(isChecked(a, baseContext({ tool: "lasso" }))).toBe(false);
		expect(isChecked(a, baseContext({ tool: "lasso", toggles: { ruler: false, penOnly: false, navigator: false, selectRectangle: true } }))).toBe(true);
		expect(a.command).toBeTruthy();
		expect(a.surfaces).toContain("context");
	});

	it("gives every new action an English and an Italian string for its label and command", () => {
		const src = i18n;
		const en = src.slice(0, src.indexOf("} as const;"));
		const it = src.slice(src.indexOf("const it:"));
		const mine = ACTIONS.filter((a) => /^(select-|selection-(align|distribute|rotate|mirror|resize|transform|similar))/.test(a.id));
		expect(mine.length).toBeGreaterThanOrEqual(20);
		for (const a of mine) {
			const keys = [a.label, ...(typeof a.command === "string" ? [a.command] : [])];
			for (const k of keys) {
				expect(en.includes(`"${k}":`), `${a.id} en ${k}`).toBe(true);
				expect(it.includes(`"${k}":`), `${a.id} it ${k}`).toBe(true);
			}
		}
	});

	it("keeps the toolbar's default selection mode the lasso", () => {
		// (the toolbar imports Obsidian, so its source is read instead)
		expect(/DEFAULT_TOOLS[^]*?selectMode: "lasso"/.test(toolbarSource)).toBe(true);
	});
});
