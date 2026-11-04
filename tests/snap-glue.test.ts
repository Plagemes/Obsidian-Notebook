import { describe, expect, it } from "vitest";
import { elementBounds } from "../src/ink/elements";
import { strokeBounds } from "../src/ink/hit-test";
import { apply, IDENTITY, multiply, scaleAbout, translate } from "../src/ink/transform";
import { createId, createPage } from "../src/model/document";
import { transformedBox } from "../src/model/snap";
import type { ImageElement, Page } from "../src/model/types";
import { FINGER_MAX_PX, SnapHold } from "../src/view/snap-hold";
import { buildSnapSession, MAX_SNAP_STROKES, snapDragged } from "../src/view/snap-glue";
import { line } from "./helpers";

const image = (x: number, y: number, w = 80, h = 60): ImageElement => ({ id: createId(), type: "image", asset: "a1", x, y, width: w, height: h, rotation: 0 });
const gridPage = (): Page => createPage({ width: 600, height: 800 }, { kind: "grid", spacing: 20 });
const none = new Set<never>();

describe("buildSnapSession", () => {
	it("collects the other items of the page, not the selected ones", () => {
		const page = gridPage();
		const sel = image(100, 100);
		const other = image(300, 200, 100, 50);
		page.elements = [sel, other];
		const s = buildSnapSession(page, "guides", none, new Set([sel]))!;
		expect(s.grid).toBeNull();
		const xs = s.targets!.vertical.map((l) => l.pos);
		expect(xs).toContain(300);
		expect(xs).toContain(400);
		expect(xs).toContain(350);
		expect(xs).not.toContain(100);
	});

	it("groups ink into items: a written word is one box, not one per stroke", () => {
		const page = gridPage();
		const a = line(50, 400, 80, 400);
		const b = line(82, 400, 120, 400);
		const far = line(300, 500, 340, 500);
		page.strokes.push(a, b, far);
		const s = buildSnapSession(page, "guides", new Set([far]), new Set())!;
		const edges = s.targets!.vertical.filter((l) => l.kind === "edge").map((l) => l.pos);
		expect(edges).toHaveLength(2); // the word a+b: left and right
		expect(Math.min(...edges)).toBeCloseTo(strokeBounds(a).minX, 5);
		expect(Math.max(...edges)).toBeCloseTo(strokeBounds(b).maxX, 5);
	});

	it("takes the grid from the paper and only in the modes that use it", () => {
		const page = gridPage();
		expect(buildSnapSession(page, "grid", none, none)).toEqual({ targets: null, grid: { stepX: 20, stepY: 20, originX: 0, originY: 0 } });
		expect(buildSnapSession(page, "both", none, none)!.targets).not.toBeNull();
		const blank = createPage({ width: 600, height: 800 }, { kind: "blank", spacing: 14 });
		expect(buildSnapSession(blank, "grid", none, none)).toBeNull();
		expect(buildSnapSession(blank, "guides", none, none)!.grid).toBeNull();
	});

	it("leaves the ink out on a very heavy page but keeps the pictures", () => {
		const page = gridPage();
		for (let i = 0; i <= MAX_SNAP_STROKES; i++) page.strokes.push(line(10, 10, 20, 20, 2));
		page.elements = [image(300, 300)];
		const s = buildSnapSession(page, "guides", none, none)!;
		expect(s.targets!.vertical.some((l) => l.pos === 300)).toBe(true);
		expect(s.targets!.vertical.filter((l) => l.kind === "edge")).toHaveLength(2); // only the picture: no ink boxes
	});
});

describe("snapDragged", () => {
	const page = gridPage();
	const target = image(300, 100, 100, 100);
	page.elements = [target];
	const moving = image(40, 400, 80, 60);
	const bounds = elementBounds(moving);
	const session = buildSnapSession(page, "both", none, new Set([moving]))!;

	it("moves: pulls the selection onto an edge of another item", () => {
		// dragged by (+257, 0): the left edge would be at 297, the item's edge is at 300
		const raw = translate(257, 0);
		const r = snapDragged({ kind: "move", bounds, startMatrix: IDENTITY, matrix: raw, session, mode: "both", thr: 5 });
		expect(apply(r.matrix, bounds.minX, 0)[0]).toBeCloseTo(300, 9);
		expect(r.guides.some((g) => g.axis === "x" && g.pos === 300)).toBe(true);
	});

	it("moves: leaves the matrix alone when nothing is in reach", () => {
		const raw = translate(11, 7);
		const r = snapDragged({ kind: "move", bounds, startMatrix: IDENTITY, matrix: raw, session, mode: "guides", thr: 2 });
		expect(r.matrix).toBe(raw);
		expect(r.guides).toEqual([]);
	});

	it("moves a selection that was already moved before (the box, not the start, is snapped)", () => {
		const start = translate(100, 0);
		const raw = multiply(translate(157, 0), start);
		const r = snapDragged({ kind: "move", bounds, startMatrix: start, matrix: raw, session, mode: "both", thr: 5 });
		expect(transformedBox(bounds, r.matrix).minX).toBeCloseTo(300, 9);
	});

	it("scales: the far edge lands on a line", () => {
		// anchor = top-left (40,400); width 80; k = 3.2 -> right edge at 296 -> 300 (k = 3.25)
		const raw = scaleAbout(3.2, 3.2, bounds.minX, bounds.minY);
		const r = snapDragged({ kind: "scale", bounds, startMatrix: IDENTITY, matrix: raw, session, mode: "guides", thr: 5 });
		const box = transformedBox(bounds, r.matrix);
		expect(box.maxX).toBeCloseTo(300, 6);
		expect(box.minX).toBeCloseTo(bounds.minX, 6);
		expect(box.minY).toBeCloseTo(bounds.minY, 6);
	});

	it("scales a selection that already had a matrix", () => {
		const start = scaleAbout(2, 2, 0, 0);
		const k = 1.5;
		const [ax, ay] = apply(start, bounds.minX, bounds.minY);
		const raw = multiply(scaleAbout(k, k, ax, ay), start);
		const r = snapDragged({ kind: "scale", bounds, startMatrix: start, matrix: raw, session, mode: "both", thr: 0.0001 });
		expect(r.matrix).toBe(raw);
	});

	it("does nothing in off mode", () => {
		const raw = translate(257, 0);
		const r = snapDragged({ kind: "move", bounds, startMatrix: IDENTITY, matrix: raw, session, mode: "off", thr: 5 });
		expect(r.matrix).toBe(raw);
	});
});

describe("SnapHold", () => {
	const touch = (type: string, id: number, w = 10, h = 10) => ({ type, pointerId: id, pointerType: "touch", width: w, height: h });

	it("a finger held while the pen drags is the bypass; a finger drag needs a second finger", () => {
		const h = new SnapHold();
		expect(h.held("pen")).toBe(false);
		h.pointer(touch("pointerdown", 1));
		expect(h.held("pen")).toBe(true);
		expect(h.held("touch")).toBe(false); // that finger is the one dragging
		h.pointer(touch("pointerdown", 2));
		expect(h.held("touch")).toBe(true);
		h.pointer(touch("pointerup", 1));
		h.pointer(touch("pointercancel", 2));
		expect(h.held("pen")).toBe(false);
	});

	it("a resting palm does not count", () => {
		const h = new SnapHold();
		h.pointer(touch("pointerdown", 1, FINGER_MAX_PX + 1, 20));
		expect(h.held("pen")).toBe(false);
	});

	it("ignores pen and mouse contacts, and Alt holds it for any drag", () => {
		const h = new SnapHold();
		h.pointer({ type: "pointerdown", pointerId: 9, pointerType: "pen" });
		expect(h.held("pen")).toBe(false);
		h.key({ type: "keydown", key: "Alt" });
		expect(h.held("mouse")).toBe(true);
		h.key({ type: "keyup", key: "Alt" });
		expect(h.held("mouse")).toBe(false);
	});

	it("recovers from a release it never saw, and from losing focus", () => {
		const h = new SnapHold();
		for (let i = 0; i < 20; i++) h.pointer(touch("pointerdown", i));
		h.reset();
		expect(h.held("pen")).toBe(false);
		h.pointer(touch("pointerdown", 1));
		h.key({ type: "keydown", key: "Alt" });
		h.reset();
		expect(h.held("pen")).toBe(false);
	});
});
