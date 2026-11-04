import { describe, expect, it } from "vitest";
import {
	alignmentGuides, DEFAULT_SNAP_STRENGTH, gridOf, MAX_GUIDES, normaliseSnapMode, normaliseSnapStrength, scaledBox, snapMove, snapScale,
	snapTargets, transformedBox, type SnapPage, type SnapTargets,
} from "../src/model/snap";

const page = (over: Partial<SnapPage> = {}): SnapPage => ({ width: 600, height: 800, paper: { kind: "blank", spacing: 14 }, ...over });
const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
const EMPTY: SnapTargets = { vertical: [], horizontal: [] };

describe("gridOf", () => {
	it("follows the paper kind", () => {
		expect(gridOf(page({ paper: { kind: "grid", spacing: 14 } }))).toEqual({ stepX: 14, stepY: 14, originX: 0, originY: 0 });
		expect(gridOf(page({ paper: { kind: "dotted", spacing: 20 } }))?.stepX).toBe(20);
		expect(gridOf(page({ paper: { kind: "ruled", spacing: 23 } }))).toEqual({ stepX: 0, stepY: 23, originX: 0, originY: 0 });
		// millimetre paper snaps to 5 mm, not to every millimetre
		expect(gridOf(page({ paper: { kind: "millimetre", spacing: 2.83 } }))?.stepX).toBeCloseTo(14.15, 5);
	});
	it("has none for blank paper, the patterned kinds and a bad spacing", () => {
		expect(gridOf(page())).toBeNull();
		expect(gridOf(page({ paper: { kind: "cornell", spacing: 20 } }))).toBeNull();
		expect(gridOf(page({ paper: { kind: "grid", spacing: 0 } }))).toBeNull();
	});
});

describe("snapTargets", () => {
	it("has the page centre and edges, and the other boxes", () => {
		const t = snapTargets(page(), [box(100, 200, 160, 260)]);
		expect(t.vertical.map((l) => l.pos).sort((a, b) => a - b)).toEqual([0, 100, 130, 160, 300, 600]);
		expect(t.horizontal.map((l) => l.pos).sort((a, b) => a - b)).toEqual([0, 200, 230, 260, 400, 800]);
		expect(t.vertical.find((l) => l.pos === 130)?.kind).toBe("centre");
		expect(t.vertical.find((l) => l.pos === 300)?.kind).toBe("page");
	});
	it("adds the margins and the margin line of ruled paper, and no bottom on an infinite page", () => {
		const t = snapTargets(page({ margins: { left: 40, right: 30, bottom: 50 } }), []);
		expect(t.vertical.filter((l) => l.kind === "margin").map((l) => l.pos).sort((a, b) => a - b)).toEqual([40, 570]);
		expect(t.horizontal.filter((l) => l.kind === "margin").map((l) => l.pos)).toEqual([750]);
		const inf = snapTargets(page({ infinite: true, margins: { left: 0, right: 0, bottom: 50 } }), []);
		expect(inf.horizontal.map((l) => l.pos)).not.toContain(800);
		expect(inf.horizontal.filter((l) => l.kind === "margin")).toHaveLength(0);
		const ruled = snapTargets(page({ paper: { kind: "ruled", spacing: 23 } }), []);
		expect(ruled.vertical.some((l) => l.kind === "margin" && Math.abs(l.pos - 70.87) < 0.01)).toBe(true);
	});
	it("ignores broken boxes", () => {
		const t = snapTargets(page(), [box(10, 10, NaN, 20), box(50, 50, 40, 60)]);
		expect(t.vertical).toHaveLength(3);
	});
});

describe("snapMove", () => {
	const targets = snapTargets(page(), [box(100, 200, 200, 300)]);

	it("pulls an edge onto the edge of another item within reach, and shows the guide", () => {
		const r = snapMove(box(103, 400, 153, 450), targets, null, "guides", 5);
		expect(r.dx).toBe(-3);
		expect(r.dy).toBe(0);
		const g = r.guides.find((x) => x.axis === "x" && x.pos === 100)!;
		expect(g.kind).toBe("edge");
		// the guide runs from the moved box up to the item it aligns with
		expect(g.from).toBe(200);
		expect(g.to).toBe(450);
	});

	it("pulls the centre onto the page centre", () => {
		const r = snapMove(box(274, 10, 330, 60), targets, null, "guides", 5);
		expect(r.dx).toBe(-2); // centre 302 -> 300
		expect(r.guides.find((x) => x.pos === 300)?.kind).toBe("page");
	});

	it("does nothing out of reach", () => {
		expect(snapMove(box(110, 410, 160, 460), targets, null, "guides", 5)).toEqual({ dx: 0, dy: 0, guides: [] });
	});

	it("picks the nearest line when several are in reach", () => {
		const t = snapTargets(page(), [box(100, 0, 108, 10)]);
		const r = snapMove(box(107, 500, 130, 520), t, null, "guides", 6);
		expect(r.dx).toBe(1); // 108 is 1 from the left edge; the centre 104 is 3 away
	});

	it("snaps both axes independently", () => {
		const r = snapMove(box(98, 202, 148, 252), targets, null, "guides", 5);
		expect(r.dx).toBe(2);
		expect(r.dy).toBe(-2);
		expect([...new Set(r.guides.map((g) => g.axis))].sort()).toEqual(["x", "y"]);
	});

	it("snaps to the grid by either edge and shows a grid guide per snapped axis", () => {
		const grid = gridOf(page({ paper: { kind: "grid", spacing: 20 } }));
		const r = snapMove(box(43, 77, 93, 127), EMPTY, grid, "grid", 6);
		expect(r.dx).toBe(-3);
		expect(r.dy).toBe(3);
		expect(r.guides).toHaveLength(2);
		expect(r.guides.every((g) => g.kind === "grid")).toBe(true);
		// the far edge can be the one that lands: 81 -> 80
		expect(snapMove(box(30, 10, 81, 61), EMPTY, grid, "grid", 6).dx).toBe(-1);
	});

	it("ruled paper snaps vertically only", () => {
		const grid = gridOf(page({ paper: { kind: "ruled", spacing: 23 } }));
		const r = snapMove(box(41, 100, 91, 140), EMPTY, grid, "grid", 6);
		expect(r.dx).toBe(0);
		expect(r.dy).toBe(-2); // the bottom edge 140 -> 138 = 6 * 23 (the top edge is 8 away from 92)
	});

	it("an alignment line beats the grid on its axis; the grid still serves the other", () => {
		const grid = gridOf(page({ paper: { kind: "grid", spacing: 20 } }));
		// x: left edge 103 -> the item edge at 100 (3 away); y: 253..303, bottom edge near 300 (item edge, 3 away)
		const r = snapMove(box(103, 253, 153, 303), targets, grid, "both", 5);
		expect(r.dx).toBe(-3);
		expect(r.dy).toBe(-3);
		expect(r.guides.every((g) => g.kind !== "grid")).toBe(true);
		// away from every item the grid takes over: 44 -> 40, 507 -> 500
		const r2 = snapMove(box(44, 507, 94, 557), targets, grid, "both", 5);
		expect(r2.dx).toBe(-4);
		expect(r2.dy).toBe(3); // the bottom edge 557 -> 560 (the top edge is 7 away from 500)
	});

	it("honours the mode", () => {
		const grid = gridOf(page({ paper: { kind: "grid", spacing: 20 } }));
		expect(snapMove(box(103, 403, 153, 453), targets, grid, "off", 5)).toEqual({ dx: 0, dy: 0, guides: [] });
		const g = snapMove(box(43, 77, 93, 127), targets, grid, "grid", 5);
		expect(g.dx).toBe(-3);
		expect(g.guides.every((x) => x.kind === "grid")).toBe(true);
		// guides only: the grid is ignored
		expect(snapMove(box(43, 77, 93, 127), targets, grid, "guides", 5).dx).toBe(0);
		// grid only: the items are ignored (103 is 3 from the grid line 100, out of a reach of 2)
		expect(snapMove(box(103, 403, 153, 453), targets, grid, "grid", 2).dx).toBe(0);
	});

	it("shows a guide for a box that already lies on a line", () => {
		const r = snapMove(box(100, 10, 150, 60), targets, null, "guides", 5);
		expect(r.dx).toBe(0);
		expect(r.guides.some((g) => g.pos === 100)).toBe(true);
	});

	it("snaps nothing with a zero reach or without lines", () => {
		expect(snapMove(box(103, 400, 153, 450), targets, null, "both", 0).dx).toBe(0);
		expect(snapMove(box(103, 400, 153, 450), null, null, "both", 5)).toEqual({ dx: 0, dy: 0, guides: [] });
	});

	it("shows at most MAX_GUIDES guides and one guide for a line shared by several items", () => {
		const many = Array.from({ length: 30 }, (_, i) => box(100, i * 20, 150, i * 20 + 10));
		const t = snapTargets(page(), many);
		const r = snapMove(box(100, 0, 150, 590), t, null, "guides", 5);
		expect(r.guides.length).toBeLessThanOrEqual(MAX_GUIDES);
		expect(r.guides.filter((g) => g.axis === "x" && g.pos === 100)).toHaveLength(1);
	});
});

describe("alignmentGuides", () => {
	it("lists the lines a box lies on, and widens them to the aligned item", () => {
		const t = snapTargets(page(), [box(100, 200, 200, 300)]);
		const g = alignmentGuides(box(150, 250, 200, 350), t);
		const key = g.map((x) => `${x.axis}${x.pos}`).sort();
		expect(key).toEqual(["x150", "x200", "y250", "y300"]);
		const x200 = g.find((x) => x.axis === "x" && x.pos === 200)!;
		expect([x200.from, x200.to]).toEqual([200, 350]);
	});
});

describe("snapScale", () => {
	it("lands the far edge on a line", () => {
		const t = snapTargets(page(), [box(300, 0, 400, 10)]);
		// box 100..200, anchor top-left (100,100), k = 1.97 -> the right edge is at 297, a line at 300
		const r = snapScale(box(100, 100, 200, 200), [100, 100], 1.97, t, null, "guides", 5);
		expect(r.k).toBeCloseTo(2, 9);
		expect(r.guides.some((g) => g.axis === "x" && g.pos === 300)).toBe(true);
	});

	it("takes the nearest feature of either axis", () => {
		const t = snapTargets(page(), []);
		// k = 3.9: the centre x is at 295 (the page centre is 5 away), nothing else is in reach
		const r = snapScale(box(100, 100, 200, 200), [100, 100], 3.9, t, null, "guides", 6);
		expect(r.k).toBeCloseTo(4, 9);
	});

	it("snaps to the grid and keeps k when nothing is in reach", () => {
		const grid = gridOf(page({ paper: { kind: "grid", spacing: 20 } }));
		const far = snapScale(box(100, 100, 190, 190), [100, 100], 1.2, EMPTY, grid, "grid", 6);
		expect(far.k).toBe(1.2); // 208 -> 200 is 8 away
		const near = snapScale(box(100, 100, 190, 190), [100, 100], 1.15, EMPTY, grid, "grid", 6);
		expect(near.k).toBeCloseTo(100 / 90, 9);
		expect(near.guides.length).toBeGreaterThan(0);
		expect(near.guides.every((g) => g.kind === "grid")).toBe(true);
	});

	it("never returns a factor outside the scale bounds", () => {
		const t = snapTargets(page(), [box(101, 101, 102, 102)]);
		const r = snapScale(box(100, 100, 400, 400), [100, 100], 0.05, t, null, "guides", 20);
		expect(r.k).toBeGreaterThanOrEqual(0.05);
		expect(r.k).toBeLessThanOrEqual(20);
	});

	it("honours the mode", () => {
		const t = snapTargets(page(), []);
		expect(snapScale(box(100, 100, 200, 200), [100, 100], 2, t, null, "off", 5)).toEqual({ k: 2, guides: [] });
		expect(snapScale(box(100, 100, 200, 200), [100, 100], 2, t, null, "grid", 5)).toEqual({ k: 2, guides: [] });
	});
});

describe("transformedBox and scaledBox", () => {
	it("is the bounding box of the moved corners", () => {
		expect(transformedBox(box(0, 0, 10, 20), [1, 0, 0, 1, 5, 7])).toEqual(box(5, 7, 15, 27));
		expect(transformedBox(box(0, 0, 10, 20), [0, 1, -1, 0, 0, 0])).toEqual(box(-20, 0, 0, 10)); // a quarter turn
		expect(scaledBox(box(100, 100, 200, 300), [100, 100], 2)).toEqual(box(100, 100, 300, 500));
	});
});

describe("settings values", () => {
	it("normalises the mode and the strength", () => {
		expect(normaliseSnapMode("grid")).toBe("grid");
		expect(normaliseSnapMode("nope")).toBe("both");
		expect(normaliseSnapMode(3)).toBe("both");
		expect(normaliseSnapStrength(1)).toBe(3);
		expect(normaliseSnapStrength(99)).toBe(20);
		expect(normaliseSnapStrength(7.4)).toBe(7);
		expect(normaliseSnapStrength("x")).toBe(DEFAULT_SNAP_STRENGTH);
		expect(normaliseSnapStrength(NaN)).toBe(DEFAULT_SNAP_STRENGTH);
	});
});
