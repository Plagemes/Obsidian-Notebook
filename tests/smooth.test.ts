import { describe, expect, it } from "vitest";
import { planSmooth, smoothedPoints, straightenedPoints, SMOOTH_LABEL, STRAIGHTEN_LABEL } from "../src/ink/smooth";
import { createArea } from "../src/model/area";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { History } from "../src/model/history";
import { pageTimes } from "../src/model/page-times";
import { freezeElement, freezeStroke, parse, serialize } from "../src/model/serialize";
import { createSticky } from "../src/model/sticky";
import { RENDER_INK, type PageElement, type Page, type Point, type Stroke, type Tool } from "../src/model/types";

let seq = 0;
function stroke(points: Point[], over: Partial<Stroke> = {}, tool: Tool = "pen"): Stroke {
	return freezeStroke({ ...createStroke("#111111", 1.5, points, tool, RENDER_INK), id: `s${++seq}`, ...over });
}
/** Deterministic noise in [-1, 1]. */
function noise(i: number, salt = 0): number {
	const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
	return (x - Math.floor(x)) * 2 - 1;
}
function jittery(f: (t: number) => [number, number], n: number, amp: number, salt = 0): Point[] {
	return Array.from({ length: n + 1 }, (_, i) => {
		const [x, y] = f(i / n);
		const edge = i === 0 || i === n;
		return [x + (edge ? 0 : amp * noise(i, salt)), y + (edge ? 0 : amp * noise(i, salt + 1)), 0.3 + 0.4 * Math.sin((i / n) * Math.PI)] as Point;
	});
}
const circle = (t: number): [number, number] => [100 + 30 * Math.cos(t * Math.PI), 100 + 30 * Math.sin(t * Math.PI)]; // a half circle
const ruler = (t: number): [number, number] => [20 + 160 * t, 50 + 6 * t];

function pageWith(strokes: readonly Stroke[], elements: PageElement[] = []): { doc: ReturnType<typeof createDocument>; page: Page } {
	const doc = createDocument();
	const page = createPage();
	page.strokes.push(...strokes);
	if (elements.length > 0) page.elements = elements;
	doc.pages = [page];
	return { doc, page };
}

/** Largest distance of a point of `pts` to the polyline `ref`'s nearest vertex. */
function maxDistance(pts: readonly Point[], ref: readonly Point[]): number {
	let worst = 0;
	for (const p of pts) {
		let best = Infinity;
		for (const q of ref) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
		worst = Math.max(worst, best);
	}
	return worst;
}
function roughness(pts: readonly Point[]): number {
	let sum = 0;
	for (let i = 1; i < pts.length - 1; i++) sum += Math.hypot((pts[i - 1]![0] + pts[i + 1]![0]) / 2 - pts[i]![0], (pts[i - 1]![1] + pts[i + 1]![1]) / 2 - pts[i]![1]);
	return sum / (pts.length - 2);
}
function displacement(a: readonly Point[], b: readonly Point[]): number {
	return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1])));
}

describe("Smooth (0.26, #66)", () => {
	const raw = jittery(circle, 80, 0.5);
	const s = stroke(raw);

	it("takes the jitter out and keeps the shape", () => {
		const out = smoothedPoints(s)!;
		expect(out).not.toBeNull();
		expect(roughness(out)).toBeLessThan(roughness(raw) * 0.5);
		// Close to the clean half circle it came from, and no farther from the raw points than the jitter was.
		const clean = Array.from({ length: 81 }, (_, i) => circle(i / 80)).map(([x, y]) => [x, y, 0] as Point);
		expect(maxDistance(out, clean)).toBeLessThan(maxDistance(raw, clean));
		expect(displacement(raw, out)).toBeLessThanOrEqual(1.5);
	});

	it("keeps the end points, the number of points and every pressure", () => {
		const out = smoothedPoints(s)!;
		expect(out).toHaveLength(raw.length);
		expect(out[0]).toEqual(raw[0]);
		expect(out[out.length - 1]).toEqual(raw[raw.length - 1]);
		out.forEach((p, i) => expect(p[2]).toBe(raw[i]![2]));
	});

	it("holds a sharp corner in place (the foot of an L)", () => {
		const L: Point[] = [
			...jittery((t) => [50, 20 + 60 * t], 30, 0.4, 3).slice(0, -1),
			...jittery((t) => [50 + 40 * t, 80], 30, 0.4, 5),
		];
		const l = stroke(L);
		const out = smoothedPoints(l)!;
		expect(out).not.toBeNull();
		const corner = out[30]!;
		expect(corner[0]).toBeCloseTo(50, 0);
		expect(corner[1]).toBeCloseTo(80, 0);
		// The long legs keep their direction: the end of the L is still to the right of and level with the corner.
		expect(out[out.length - 1]![1]).toBeCloseTo(80, 0);
	});

	it("stays bounded when run again: each run changes less than 1.5 pt and the roughness never grows", () => {
		let pts: Point[] = raw;
		let last = roughness(raw);
		for (let k = 0; k < 4; k++) {
			const next = smoothedPoints(stroke(pts));
			if (!next) break;
			expect(displacement(pts, next)).toBeLessThanOrEqual(1.5);
			expect(roughness(next)).toBeLessThanOrEqual(last + 1e-9);
			last = roughness(next);
			pts = next;
		}
	});

	it("leaves an already smooth stroke, a tiny one and the non-handwriting tools alone", () => {
		const clean = Array.from({ length: 40 }, (_, i) => circle(i / 39)).map(([x, y]) => [x, y, 0.5] as Point);
		expect(smoothedPoints(stroke(clean))).toBeNull();
		expect(smoothedPoints(stroke(raw.slice(0, 4)))).toBeNull();
		for (const tool of ["highlighter", "marker", "shape"] as const) expect(smoothedPoints(stroke(raw, {}, tool)), tool).toBeNull();
		for (const tool of ["fountain", "brush"] as const) expect(smoothedPoints(stroke(raw, {}, tool)), tool).not.toBeNull();
		expect(smoothedPoints(stroke(raw, { hidden: true }))).toBeNull();
	});
});

describe("Straighten (0.26, #66)", () => {
	const wobbly = jittery(ruler, 40, 0.8, 7);

	it("turns an almost straight stroke into a clean line between its ends", () => {
		const out = straightenedPoints(stroke(wobbly))!;
		expect(out).not.toBeNull();
		const a = wobbly[0]!;
		const b = wobbly[wobbly.length - 1]!;
		expect(out[0]).toEqual(a);
		expect(out[out.length - 1]).toEqual(b);
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		for (const p of out) expect(Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / len).toBeLessThan(1e-9);
		out.forEach((p, i) => expect(p[2]).toBe(wobbly[i]![2]));
		// In order along the line.
		for (let i = 1; i < out.length; i++) expect(out[i]![0]).toBeGreaterThanOrEqual(out[i - 1]![0]);
	});

	it("is idempotent: a second run changes nothing", () => {
		const once = straightenedPoints(stroke(wobbly))!;
		expect(straightenedPoints(stroke(once))).toBeNull();
	});

	it("leaves curves, loops, zig-zags and doubled-back strokes untouched", () => {
		expect(straightenedPoints(stroke(jittery(circle, 60, 0.3)))).toBeNull();
		expect(straightenedPoints(stroke(jittery((t) => [100 + 20 * Math.cos(t * 2 * Math.PI), 100 + 20 * Math.sin(t * 2 * Math.PI)], 60, 0.2)))).toBeNull();
		expect(straightenedPoints(stroke(jittery((t) => [20 + 100 * t, 50 + 14 * Math.sin(t * 6 * Math.PI)], 80, 0)))).toBeNull();
		const back: Point[] = [[20, 50, 0.5], [120, 50.5, 0.5], [60, 50.2, 0.5], [160, 50, 0.5]];
		expect(straightenedPoints(stroke(back))).toBeNull();
		// A short tick (a dot or a very short mark) is not a line.
		expect(straightenedPoints(stroke([[10, 10, 0.5], [10.5, 10.1, 0.5], [11, 10, 0.5]]))).toBeNull();
	});

	it("does not touch shapes, the highlighter or hidden ink", () => {
		for (const tool of ["highlighter", "marker", "shape"] as const) expect(straightenedPoints(stroke(wobbly, {}, tool)), tool).toBeNull();
		expect(straightenedPoints(stroke(wobbly, { hidden: true }))).toBeNull();
	});
});

describe("planSmooth: the undo step (0.26, #66)", () => {
	it("is ONE step that keeps ids, order, style and fields, and undoes completely", () => {
		const a = stroke(jittery(circle, 60, 0.5), { color: "#cc0000" });
		const b = stroke(jittery(ruler, 30, 0.7, 4));
		const c = stroke([[0, 0, 0.5], [1, 0, 0.5]]);
		const { doc, page } = pageWith([a, b, c]);
		const plan = planSmooth(page, [a, b, c], [], "smooth")!;
		expect(plan.count).toBe(2);
		expect(plan.command.label).toBe(SMOOTH_LABEL);
		const hist = new History(() => doc);
		expect(hist.execute(plan.command)).toBe(true);
		expect(page.strokes.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
		expect(page.strokes[0]!.color).toBe("#cc0000");
		expect(page.strokes[0]).toBe(plan.changes.get(a));
		expect(page.strokes[2]).toBe(c);
		expect(plan.strokes).toEqual([plan.changes.get(a), plan.changes.get(b), c]);
		hist.undo();
		expect(page.strokes).toEqual([a, b, c]);
		expect(page.strokes.every((s, i) => s === [a, b, c][i])).toBe(true);
		expect(hist.canUndo()).toBe(false);
		hist.redo();
		expect(page.strokes[0]).not.toBe(a);
	});

	it("Straighten has its own label and is null when nothing is straight enough", () => {
		const bent = stroke(jittery(circle, 60, 0.3));
		const { page } = pageWith([bent]);
		expect(planSmooth(page, [bent], [], "straighten")).toBeNull();
		const line = stroke(jittery(ruler, 30, 0.6, 2));
		const { page: p2 } = pageWith([line]);
		const plan = planSmooth(p2, [line], [], "straighten")!;
		expect(plan.command.label).toBe(STRAIGHTEN_LABEL);
		expect(planSmooth(p2, plan.strokes, [], "straighten")).toBeNull();
	});

	it("does not move the page times and the result saves and reads back", () => {
		const a = stroke(jittery(ruler, 30, 0.6, 2));
		const { doc, page } = pageWith([a]);
		const hist = new History(() => doc, 500, null, null, null, null, () => 1_900_000_000_000);
		const times = JSON.stringify(pageTimes(page));
		expect(hist.execute(planSmooth(page, [a], [], "straighten")!.command)).toBe(true);
		expect(JSON.stringify(pageTimes(page))).toBe(times);
		const parsed = parse(serialize(doc));
		if (!parsed.ok) throw new Error("did not read back");
		expect(parsed.doc.pages[0]!.strokes[0]!.id).toBe(a.id);
	});

	it("only touches the strokes asked for, and not ink a collapsed sticky note keeps hidden", () => {
		const a = stroke(jittery(circle, 60, 0.5));
		const other = stroke(jittery(circle, 60, 0.5, 9));
		const hiddenInk = stroke(jittery(circle, 60, 0.5, 11));
		const note = freezeElement({ ...createSticky(300, 300, { width: 600, height: 800 }), collapsed: true, ink: [hiddenInk.id] });
		const { page } = pageWith([a, other, hiddenInk], [note]);
		const plan = planSmooth(page, [a, hiddenInk], [], "smooth")!;
		expect(plan.changes.has(a)).toBe(true);
		expect(plan.changes.has(other)).toBe(false);
		expect(plan.changes.has(hiddenInk)).toBe(false);
	});

	it("reshapes a group only when every member is asked for and none is a locked element", () => {
		const a = stroke(jittery(circle, 60, 0.5), { group: "g1" });
		const b = stroke(jittery(circle, 60, 0.5, 5), { group: "g1" });
		const { page } = pageWith([a, b]);
		expect(planSmooth(page, [a], [], "smooth")).toBeNull();
		expect(planSmooth(page, [a, b], [], "smooth")!.count).toBe(2);
		const lockedArea = freezeElement({ ...createArea([0, 0], [10, 10], { width: 600, height: 800 }, "#ffff00")!, group: "g2", locked: true });
		const c = stroke(jittery(circle, 60, 0.5, 8), { group: "g2" });
		const d = stroke(jittery(circle, 60, 0.5, 6), { group: "g2" });
		const { page: p2 } = pageWith([c, d], [lockedArea]);
		expect(planSmooth(p2, [c, d], [], "smooth")).toBeNull();
		expect(planSmooth(p2, [c, d], [lockedArea], "smooth")).toBeNull();
	});

	it("leaves area highlights, text and images (elements) alone: they are not strokes", () => {
		const a = stroke(jittery(circle, 60, 0.5));
		const area = freezeElement(createArea([0, 0], [50, 50], { width: 600, height: 800 }, "#ffff00")!);
		const { page } = pageWith([a], [area]);
		const plan = planSmooth(page, [a], [area], "smooth")!;
		expect(plan.count).toBe(1);
		expect(page.elements![0]).toBe(area);
	});
});
