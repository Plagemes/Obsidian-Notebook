import { describe, expect, it } from "vitest";
import { armLength, axesFromCross, axesFromL, axesKind, buildAxes, defaultAxes, tickSpacing, ticksOnArm, AXES_HEAD } from "../src/ink/axes";
import { groupStats } from "../src/model/groups";
import type { Point } from "../src/model/types";

/** A hand-drawn polyline through the vertices, with a little wobble. */
function hand(vertices: Array<[number, number]>, wobble = 0.6): Point[] {
	const out: Point[] = [];
	let n = 0;
	for (let i = 0; i + 1 < vertices.length; i++) {
		const a = vertices[i]!;
		const b = vertices[i + 1]!;
		const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
		for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
			const f = k / steps;
			const w = Math.sin(n++ * 1.7) * wobble;
			out.push([a[0] + (b[0] - a[0]) * f + w, a[1] + (b[1] - a[1]) * f - w, 0.5]);
		}
	}
	return out;
}

describe("axesFromL", () => {
	it("reads an L (up, then right) as first-quadrant axes at the corner", () => {
		const spec = axesFromL(hand([[100, 40], [100, 140], [220, 140]]))!;
		expect(spec).not.toBeNull();
		expect(Math.abs(spec.ox - 100)).toBeLessThan(2);
		expect(Math.abs(spec.oy - 140)).toBeLessThan(2);
		expect(spec.right).toBeCloseTo(120, -1);
		expect(spec.up).toBeCloseTo(100, -1);
		expect(spec.left).toBe(0);
		expect(spec.down).toBe(0);
		expect(axesKind(spec)).toBe("first");
	});

	it("rejects handwriting-sized letters, curves, a slanted V and a single line", () => {
		expect(axesFromL(hand([[10, 0], [10, 14], [22, 14]]))).toBeNull();
		expect(axesFromL(hand([[100, 40], [100, 140]]))).toBeNull();
		expect(axesFromL(hand([[100, 40], [140, 140], [180, 40]]))).toBeNull();
		const arc: Point[] = [];
		for (let i = 0; i <= 40; i++) arc.push([100 + 80 * Math.cos((i / 40) * Math.PI), 100 + 80 * Math.sin((i / 40) * Math.PI), 0.5]);
		expect(axesFromL(arc)).toBeNull();
	});

	it("rejects an L whose legs are far from equal", () => {
		expect(axesFromL(hand([[100, 100], [100, 140], [300, 140]]))).toBeNull();
	});
});

describe("axesFromCross", () => {
	it("reads a + of two lines as four-quadrant axes", () => {
		const spec = axesFromCross(hand([[60, 100], [200, 100]]), hand([[130, 30], [130, 170]]))!;
		expect(spec).not.toBeNull();
		expect(Math.abs(spec.ox - 130)).toBeLessThan(2);
		expect(Math.abs(spec.oy - 100)).toBeLessThan(2);
		expect(spec.left).toBeCloseTo(70, -1);
		expect(spec.down).toBeCloseTo(70, -1);
		expect(axesKind(spec)).toBe("four");
		// The order of the strokes does not matter.
		expect(axesFromCross(hand([[130, 30], [130, 170]]), hand([[60, 100], [200, 100]]))).not.toBeNull();
	});

	it("rejects a T (crossing near the end), parallel lines, short lines and a diagonal", () => {
		expect(axesFromCross(hand([[60, 100], [200, 100]]), hand([[70, 100], [70, 170]]))).toBeNull();
		expect(axesFromCross(hand([[60, 100], [200, 100]]), hand([[60, 130], [200, 130]]))).toBeNull();
		expect(axesFromCross(hand([[120, 100], [140, 100]]), hand([[130, 90], [130, 110]]))).toBeNull();
		expect(axesFromCross(hand([[60, 60], [200, 200]]), hand([[60, 200], [200, 60]]))).toBeNull();
	});
});

describe("tick placement", () => {
	it("follows the page spacing, widened until ticks are not crowded", () => {
		expect(tickSpacing(14.17)).toBeCloseTo(14.17);
		expect(tickSpacing(2.83)).toBeCloseTo(2.83 * 5);
		expect(tickSpacing(undefined)).toBeCloseTo(14.17);
		expect(tickSpacing(0)).toBeCloseTo(14.17);
		expect(tickSpacing(22.7)).toBeCloseTo(22.7);
	});

	it("puts a whole number of ticks on an arm and leaves room for the head", () => {
		expect(ticksOnArm(100, 14)).toBe(Math.floor((100 - AXES_HEAD) / 14));
		expect(ticksOnArm(5, 14)).toBe(0);
		expect(armLength(100, 14, true)).toBeCloseTo(6 * 14 + AXES_HEAD);
		expect(armLength(100, 14, false)).toBe(100);
		expect(armLength(0, 14, true)).toBe(0);
	});
});

describe("buildAxes", () => {
	const opts = { spacing: 14, ticks: true, labels: true, color: "#112233", width: 1.6 };
	let counter = 0;
	const newId = () => `id${++counter}`;

	it("makes one shape stroke per arm and number labels, all in one fresh group", () => {
		const drawing = buildAxes({ ox: 100, oy: 140, left: 0, right: 120, up: 100, down: 0 }, opts, newId);
		expect(drawing.strokes).toHaveLength(2);
		expect(drawing.strokes.every((s) => s.tool === "shape" && s.group === drawing.group)).toBe(true);
		expect(drawing.texts.length).toBeGreaterThan(0);
		expect(drawing.texts.every((t) => t.group === drawing.group && t.type === "text")).toBe(true);
		const ids = [...drawing.strokes, ...drawing.texts].map((i) => i.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).not.toContain(drawing.group);
		expect(groupStats({ strokes: drawing.strokes, elements: drawing.texts })).toMatchObject({ groups: 1, grouped: ids.length, total: ids.length });
		// Points are on the page grid of the arm: the x axis stays at y = 140 except for ticks.
		const xAxis = drawing.strokes[0]!;
		expect(xAxis.points[0]![0]).toBeCloseTo(100);
		expect(Math.max(...xAxis.points.map((p) => p[0]))).toBeCloseTo(100 + armLength(120, 14, true), 0);
		for (const p of xAxis.points) expect(Math.abs(p[1] - 140)).toBeLessThanOrEqual(8.1);
	});

	it("labels count away from the origin, negative on the left", () => {
		const drawing = buildAxes({ ox: 200, oy: 200, left: 100, right: 100, up: 100, down: 100 }, { ...opts, spacing: 30 }, newId);
		expect(drawing.strokes).toHaveLength(4);
		const words = drawing.texts.map((t) => t.text);
		expect(words).toContain("1");
		expect(words).toContain("−1");
		const minus = drawing.texts.filter((t) => t.text.startsWith("−"));
		expect(minus.length).toBeGreaterThan(0);
	});

	it("draws no ticks or labels when they are off, and no labels without ticks", () => {
		const plain = buildAxes({ ox: 50, oy: 150, left: 0, right: 100, up: 100, down: 0 }, { ...opts, ticks: false, labels: true }, newId);
		expect(plain.texts).toHaveLength(0);
		const ticked = buildAxes({ ox: 50, oy: 150, left: 0, right: 100, up: 100, down: 0 }, opts, newId);
		expect(plain.strokes[0]!.points.length).toBeLessThan(ticked.strokes[0]!.points.length);
		const noLabels = buildAxes({ ox: 50, oy: 150, left: 0, right: 100, up: 100, down: 0 }, { ...opts, labels: false }, newId);
		expect(noLabels.texts).toHaveLength(0);
		expect(noLabels.strokes[0]!.points.length).toBe(ticked.strokes[0]!.points.length);
	});

	it("gives every drawing a different group", () => {
		const a = buildAxes({ ox: 50, oy: 150, left: 0, right: 100, up: 100, down: 0 }, opts);
		const b = buildAxes({ ox: 50, oy: 150, left: 0, right: 100, up: 100, down: 0 }, opts);
		expect(a.group).not.toBe(b.group);
	});
});

describe("defaultAxes", () => {
	it("keeps the insert inside the page", () => {
		const page = { width: 595, height: 842 };
		const spec = defaultAxes(2, 2, 14, page);
		expect(spec.ox - spec.left).toBeGreaterThanOrEqual(0);
		expect(spec.oy - spec.up).toBeGreaterThanOrEqual(0);
		const far = defaultAxes(9999, 9999, 14, page);
		expect(far.ox + far.right).toBeLessThanOrEqual(page.width);
		expect(far.oy + far.down).toBeLessThanOrEqual(page.height);
		expect(axesKind(spec)).toBe("four");
	});
});
