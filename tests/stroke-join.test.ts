import { describe, expect, it } from "vitest";
import { isDropoutPair, JOIN_RULES, joinStrokes, planJoin } from "../src/ink/stroke-join";
import { planCleanup } from "../src/ink/hook-clean";
import { createDocument, createStroke } from "../src/model/document";
import { AddStroke, History } from "../src/model/history";
import { pageTimes } from "../src/model/page-times";
import { freezeElement, freezeStroke, parse, serialize } from "../src/model/serialize";
import { createSticky } from "../src/model/sticky";
import { RENDER_FREEHAND, RENDER_INK, type BoxElement, type Point, type Stroke } from "../src/model/types";

/** A line through the vertices, a point about every `step` pt, pressure `p`. */
function poly(vertices: Array<[number, number]>, step = 1, p = 0.5): Point[] {
	const out: Point[] = [[vertices[0]![0], vertices[0]![1], p]];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!;
		const [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
		for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, p]);
	}
	return out;
}

let seq = 0;
function stroke(points: Point[], over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#111111", 2, points, "pen", RENDER_INK), id: `s${++seq}`, ...over });
}

/** A dropout: one line along the vertices cut after `cut` pt of arc, `gap` pt lost, two strokes. */
function split(vertices: Array<[number, number]>, cut: number, gap: number, over: Partial<Stroke> = {}, over2: Partial<Stroke> = {}): [Stroke, Stroke] {
	const pts = poly(vertices, 1);
	let walked = 0;
	let at = 1;
	for (; at < pts.length; at++) {
		walked += Math.hypot(pts[at]![0] - pts[at - 1]![0], pts[at]![1] - pts[at - 1]![1]);
		if (walked >= cut) break;
	}
	const skip = Math.round(gap);
	return [stroke(pts.slice(0, at + 1), over), stroke(pts.slice(at + 1 + skip), over2)];
}

describe("what counts as a dropout", () => {
	it("joins the two halves of a straight line split by a 2 pt dropout", () => {
		const [a, b] = split([[10, 50], [110, 50]], 50, 2);
		expect(a.points.length).toBeGreaterThan(10);
		expect(isDropoutPair(a, b)).toBe(true);
	});

	it("joins the halves of a curve (a letter's bowl) and of a diagonal", () => {
		const arc: Point[] = Array.from({ length: 80 }, (_, i) => [50 + 20 * Math.cos(Math.PI + (i / 79) * Math.PI), 60 + 20 * Math.sin(Math.PI + (i / 79) * Math.PI), 0.5]);
		const a = stroke(arc.slice(0, 40));
		const b = stroke(arc.slice(41));
		expect(isDropoutPair(a, b)).toBe(true);
		const [d1, d2] = split([[0, 0], [80, 80]], 50, 2);
		expect(isDropoutPair(d1, d2)).toBe(true);
	});

	it("joins a line that has no gap at all (the second stroke starts where the first ended)", () => {
		const pts = poly([[0, 0], [60, 0]], 1);
		expect(isDropoutPair(stroke(pts.slice(0, 31)), stroke(pts.slice(30)))).toBe(true);
	});

	it("never joins when the gap is large: the next letter, the next word", () => {
		const [a, b] = split([[10, 50], [110, 50]], 50, 12);
		expect(isDropoutPair(a, b)).toBe(false);
		// Just over the absolute reach for this pen.
		const [c, d] = split([[10, 90], [110, 90]], 50, 7);
		expect(isDropoutPair(c, d)).toBe(false);
	});

	it("the reach follows the pen width and the speed of the pen", () => {
		// A thin pen (1 pt): reach is 1.5 pt, a 3 pt gap on a densely sampled line is not a dropout.
		const [a, b] = split([[10, 50], [110, 50]], 50, 3, { width: 1 }, { width: 1 });
		expect(isDropoutPair(a, b)).toBe(false);
		// A slow pen (points 0.2 pt apart) that jumped 2 pt did not drop out, it lifted.
		const slow = poly([[10, 20], [60, 20]], 0.2);
		const slowA = stroke(slow.slice(0, 120));
		const slowB = stroke(slow.slice(130));
		expect(Math.hypot(slowB.points[0]![0] - slowA.points[119]![0], 0)).toBeCloseTo(2.2, 3);
		expect(isDropoutPair(slowA, slowB)).toBe(false);
		// The same gap at a fast pace (points 2 pt apart, a 2 pt gap is one missed report).
		const fast = poly([[10, 20], [110, 20]], 2);
		expect(isDropoutPair(stroke(fast.slice(0, 25)), stroke(fast.slice(26)))).toBe(true);
	});

	it("never joins a sharp change of direction: the corner of an L, a V, the foot of a 2", () => {
		const down = stroke(poly([[50, 10], [50, 60]]));
		const foot = stroke(poly([[51, 61], [100, 61]]));
		expect(isDropoutPair(down, foot)).toBe(false);
		const v1 = stroke(poly([[10, 10], [30, 50]]));
		const v2 = stroke(poly([[31, 49], [50, 10]]));
		expect(isDropoutPair(v1, v2)).toBe(false);
		// Turning back along the line is not a continuation either.
		const back = stroke(poly([[101, 50], [60, 50]]));
		const fwd = stroke(poly([[10, 50], [100, 50]]));
		expect(isDropoutPair(fwd, back)).toBe(false);
	});

	it("allows a gentle bend (under 30 degrees) and refuses a larger one", () => {
		const a = stroke(poly([[10, 10], [60, 10]]));
		const gentle = stroke(poly([[62, 10.5], [62 + 40 * Math.cos(0.3), 10.5 + 40 * Math.sin(0.3)]]));
		expect(isDropoutPair(a, gentle)).toBe(true);
		const steep = stroke(poly([[62, 10.5], [62 + 40 * Math.cos(0.8), 10.5 + 40 * Math.sin(0.8)]]));
		expect(isDropoutPair(a, steep)).toBe(false);
	});

	it("never joins a stroke that starts beside or behind the end of the other, only ahead of it", () => {
		const a = stroke(poly([[10, 50], [60, 50]]));
		const beside = stroke(poly([[60, 53], [110, 53]]));
		expect(isDropoutPair(a, beside)).toBe(false);
		const behind = stroke(poly([[56, 50], [110, 50]]));
		expect(isDropoutPair(a, behind)).toBe(false);
		const ahead = stroke(poly([[62, 50], [110, 50]]));
		expect(isDropoutPair(a, ahead)).toBe(true);
	});

	it("never joins dots, or a dot to a line (the i-dot, a full stop, a bounce)", () => {
		const line = stroke(poly([[10, 50], [60, 50]]));
		const dot = stroke([[62, 50, 0.5]]);
		expect(isDropoutPair(line, dot)).toBe(false);
		expect(isDropoutPair(dot, line)).toBe(false);
		const two = stroke([[62, 50, 0.5], [62.5, 50, 0.5]]);
		expect(isDropoutPair(line, two)).toBe(false);
		// A tiny tick that is three points but shorter than three pen widths.
		const tick = stroke([[62, 50, 0.5], [62.8, 50, 0.5], [63.6, 50, 0.5]]);
		expect(isDropoutPair(line, tick)).toBe(false);
		// Two dots in a row, however close.
		expect(isDropoutPair(dot, stroke([[63, 50, 0.5]]))).toBe(false);
	});

	it("never joins dashes: a short gap compared with long pieces is a dropout, a gap as long as a quarter of a dash is not", () => {
		const dash1 = stroke(poly([[10, 50], [22, 50]]));
		const dash2 = stroke(poly([[25, 50], [37, 50]]));
		expect(isDropoutPair(dash1, dash2)).toBe(false);
	});

	it("never joins strokes of a different style", () => {
		const [a, b] = split([[10, 50], [110, 50]], 50, 2);
		expect(isDropoutPair(a, b)).toBe(true);
		const diff = (over: Partial<Stroke>) => stroke(b.points, over);
		expect(isDropoutPair(a, diff({ color: "#ff0000" }))).toBe(false);
		expect(isDropoutPair(a, diff({ width: 3 }))).toBe(false);
		expect(isDropoutPair(a, diff({ tool: "fountain" }))).toBe(false);
		expect(isDropoutPair(a, diff({ render: RENDER_FREEHAND }))).toBe(false);
		expect(isDropoutPair(a, diff({ slide: "sl1" }))).toBe(false);
		expect(isDropoutPair(a, diff({ hidden: true }))).toBe(false);
		// The same colour in another case is the same colour.
		expect(isDropoutPair(a, diff({ color: "#111111".toUpperCase() }))).toBe(true);
	});

	it("never joins fountain strokes of different nibs, but joins the same nib", () => {
		const [a, b] = split([[10, 50], [110, 50]], 50, 2, { tool: "fountain", nib: 45 }, { tool: "fountain", nib: 45 });
		expect(isDropoutPair(a, b)).toBe(true);
		expect(isDropoutPair(a, stroke(b.points, { tool: "fountain", nib: 90 }))).toBe(false);
		expect(isDropoutPair(a, stroke(b.points, { tool: "fountain" }))).toBe(false);
	});

	it("only looks at line pens: a highlighter or a marker is left alone", () => {
		for (const tool of ["highlighter", "marker"] as const) {
			const [a, b] = split([[10, 50], [110, 50]], 50, 2, { tool }, { tool });
			expect(isDropoutPair(a, b), tool).toBe(false);
		}
		const [a, b] = split([[10, 50], [110, 50]], 50, 2, { tool: "brush" }, { tool: "brush" });
		expect(isDropoutPair(a, b)).toBe(true);
	});

	it("refuses a jump in pressure at the joint", () => {
		const a = stroke(poly([[10, 50], [60, 50]], 1, 0.9));
		const b = stroke(poly([[62, 50], [110, 50]], 1, 0.2));
		expect(isDropoutPair(a, b)).toBe(false);
		const soft = stroke(poly([[62, 50], [110, 50]], 1, 0.7));
		expect(isDropoutPair(a, soft)).toBe(true);
	});

	it("exposes its limits", () => {
		expect(JOIN_RULES.maxTurn).toBeLessThan(45);
		expect(JOIN_RULES.gapMaxPt).toBeLessThanOrEqual(8);
	});
});

describe("joining points", () => {
	it("keeps the first stroke's id and fields, concatenates points and leaves pressure untouched", () => {
		const a = stroke(poly([[10, 50], [60, 50]], 1, 0.3), { group: "g1", nib: 30, tool: "fountain" });
		const b = stroke(poly([[62, 50], [110, 50]], 1, 0.6));
		const j = joinStrokes(a, [b]);
		expect(j.id).toBe(a.id);
		expect(j.group).toBe("g1");
		expect(j.nib).toBe(30);
		expect(j.tool).toBe("fountain");
		expect(j.points).toHaveLength(a.points.length + b.points.length);
		expect(j.points.slice(0, a.points.length)).toEqual(a.points);
		expect(j.points.slice(a.points.length)).toEqual(b.points);
		for (const p of j.points) expect(p).toHaveLength(3);
		expect(Object.isFrozen(j)).toBe(true);
		expect(Object.isFrozen(j.points)).toBe(true);
	});

	it("does not repeat a start that coincides with the end before it", () => {
		const pts = poly([[0, 0], [60, 0]]);
		const a = stroke(pts.slice(0, 31));
		const b = stroke(pts.slice(30));
		expect(joinStrokes(a, [b]).points).toHaveLength(pts.length);
	});
});

describe("planJoin", () => {
	function scene() {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const [a1, a2] = split([[10, 50], [110, 50]], 50, 2);
		const other = stroke(poly([[10, 100], [100, 100]]));
		const [c1, c2] = split([[10, 150], [110, 170]], 55, 2);
		page.strokes.push(a1, a2, other, c1, c2);
		return { doc, page, a1, a2, other, c1, c2 };
	}

	it("joins every split pair in ONE undoable step, in the place of the first piece", () => {
		const { doc, page, a1, a2, other, c1, c2 } = scene();
		const plan = planJoin(page, [...page.strokes])!;
		expect(plan).not.toBeNull();
		expect(plan.joints).toBe(2);
		expect(plan.runs).toBe(2);
		const hist = new History(() => doc);
		expect(hist.execute(plan.command)).toBe(true);
		expect(page.strokes).toHaveLength(3);
		expect(page.strokes[0]!.id).toBe(a1.id);
		expect(page.strokes[0]!.points).toHaveLength(a1.points.length + a2.points.length);
		expect(page.strokes[1]).toBe(other);
		expect(page.strokes[2]!.id).toBe(c1.id);
		expect(page.strokes[2]!.points).toHaveLength(c1.points.length + c2.points.length);
		expect(plan.strokes).toEqual([page.strokes[0], other, page.strokes[2]]);
		// One undo gives everything back, in place, as the very same objects.
		hist.undo();
		expect(page.strokes).toEqual([a1, a2, other, c1, c2]);
		expect(page.strokes[0]).toBe(a1);
		expect(page.strokes[1]).toBe(a2);
		expect(page.strokes[4]).toBe(c2);
		expect(hist.canUndo()).toBe(false);
		hist.redo();
		expect(page.strokes).toHaveLength(3);
		expect(page.strokes[0]).toBe(plan.strokes[0]);
	});

	it("chains three or more fragments into one stroke, and undoes them in one step", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const pts = poly([[10, 40], [150, 40]]);
		const parts = [pts.slice(0, 40), pts.slice(41, 90), pts.slice(91, 120), pts.slice(121)].map((p) => stroke(p));
		page.strokes.push(...parts);
		const plan = planJoin(page, [...page.strokes])!;
		expect(plan.joints).toBe(3);
		expect(plan.runs).toBe(1);
		const hist = new History(() => doc);
		hist.execute(plan.command);
		expect(page.strokes).toHaveLength(1);
		expect(page.strokes[0]!.id).toBe(parts[0]!.id);
		expect(page.strokes[0]!.points).toHaveLength(parts.reduce((n, s) => n + s.points.length, 0));
		hist.undo();
		expect(page.strokes).toEqual(parts);
		expect(page.strokes.every((s, i) => s === parts[i])).toBe(true);
	});

	it("only joins strokes that are next to each other in the page order", () => {
		const { page, a1, a2, other } = scene();
		// Something was drawn between the two halves: they are not one gesture.
		page.strokes.splice(1, 0, stroke(poly([[200, 10], [260, 10]])));
		expect(planJoin(page, [a1, a2])).toBeNull();
		expect(planJoin(page, [a1, a2, other])).toBeNull();
	});

	it("only joins strokes that were asked for", () => {
		const { page, a1, a2, c1, c2 } = scene();
		expect(planJoin(page, [a1])).toBeNull();
		expect(planJoin(page, [a2, c2])).toBeNull();
		const plan = planJoin(page, [c1, c2])!;
		expect(plan.joints).toBe(1);
		expect(plan.strokes).toHaveLength(1);
		expect(plan.changes.get(c2)).toBeNull();
		expect(plan.changes.get(c1)!.id).toBe(c1.id);
		expect(a1).toBeDefined();
		expect(a2).toBeDefined();
	});

	it("returns null when nothing is split, for no strokes, and for strokes that are not on the page", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		page.strokes.push(stroke(poly([[0, 0], [100, 0]])), stroke(poly([[0, 20], [100, 20]])), stroke([[50, 40, 0.5]]));
		expect(planJoin(page, [...page.strokes])).toBeNull();
		expect(planJoin(page, [])).toBeNull();
		const [x, y] = split([[10, 50], [110, 50]], 50, 2);
		expect(planJoin(page, [x, y])).toBeNull();
	});

	it("does not take letters of a word, an L, the dot of an i or dashes", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const stem = stroke(poly([[20, 20], [20, 50]]));
		const iDot = stroke([[20, 14, 0.5]]);
		const next = stroke(poly([[28, 20], [28, 50]]));
		const l1 = stroke(poly([[60, 10], [60, 50]]));
		const l2 = stroke(poly([[61, 51], [90, 51]]));
		const d1 = stroke(poly([[100, 50], [112, 50]]));
		const d2 = stroke(poly([[115, 50], [127, 50]]));
		page.strokes.push(iDot, stem, next, l1, l2, d1, d2);
		expect(planJoin(page, [...page.strokes])).toBeNull();
	});

	it("keeps the first stroke's position when other strokes sit around the pieces", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const before = stroke(poly([[0, 0], [80, 0]]));
		const [a, b] = split([[10, 50], [110, 50]], 50, 2);
		const after = stroke(poly([[0, 100], [80, 100]]));
		page.strokes.push(before, a, b, after);
		const hist = new History(() => doc);
		hist.execute(planJoin(page, [a, b])!.command);
		expect(page.strokes.map((s) => s.id)).toEqual([before.id, a.id, after.id]);
		hist.undo();
		expect(page.strokes).toEqual([before, a, b, after]);
	});

	it("keeps a group when it keeps two members, and refuses to dissolve one", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const [a, b] = split([[10, 50], [110, 50]], 50, 2, { group: "g" }, { group: "g" });
		const mate = stroke(poly([[0, 100], [80, 100]]), { group: "g" });
		page.strokes.push(a, b, mate);
		const plan = planJoin(page, [a, b])!;
		expect(plan).not.toBeNull();
		expect(plan.changes.get(a)!.group).toBe("g");
		// A group made of just the two pieces would be a group of one: not joined.
		const solo = createDocument().pages[0]!;
		const [c, d] = split([[10, 50], [110, 50]], 50, 2, { group: "h" }, { group: "h" });
		solo.strokes.push(c, d);
		expect(planJoin(solo, [c, d])).toBeNull();
	});

	it("never joins strokes of different groups, or a grouped one with an ungrouped one", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const [a, b] = split([[10, 50], [110, 50]], 50, 2, { group: "g1" }, { group: "g2" });
		const mate1 = stroke(poly([[0, 100], [80, 100]]), { group: "g1" });
		const mate2 = stroke(poly([[0, 120], [80, 120]]), { group: "g2" });
		page.strokes.push(a, b, mate1, mate2);
		expect(planJoin(page, [...page.strokes])).toBeNull();
		const [c, d] = split([[10, 150], [110, 150]], 50, 2, { group: "g1" });
		const p2 = createDocument().pages[0]!;
		p2.strokes.push(c, d, mate1);
		expect(planJoin(p2, [...p2.strokes])).toBeNull();
	});

	it("never joins strokes of a group that holds a locked element", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const [a, b] = split([[10, 50], [110, 50]], 50, 2, { group: "g" }, { group: "g" });
		const mate = stroke(poly([[0, 100], [80, 100]]), { group: "g" });
		const locked: BoxElement = freezeElement({ id: "e1", type: "box", kind: "definition", x: 0, y: 300, width: 80, height: 40, group: "g", locked: true, lockAt: 1 });
		page.strokes.push(a, b, mate);
		page.elements = [locked];
		expect(planJoin(page, [a, b])).toBeNull();
		page.elements = [freezeElement({ ...locked, locked: undefined, lockAt: undefined })];
		expect(planJoin(page, [a, b])).not.toBeNull();
	});

	it("leaves ink a collapsed sticky note keeps hidden alone", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const [h1, h2] = split([[10, 50], [110, 50]], 50, 2);
		const [v1, v2] = split([[10, 150], [110, 150]], 50, 2);
		page.strokes.push(h1, h2, v1, v2);
		page.elements = [{ ...createSticky(200, 200, page), collapsed: true as const, ink: [h1.id, h2.id] }];
		const plan = planJoin(page, [...page.strokes])!;
		expect(plan.joints).toBe(1);
		new History(() => doc).execute(plan.command);
		expect(page.strokes).toHaveLength(3);
		expect(page.strokes[0]).toBe(h1);
		expect(page.strokes[1]).toBe(h2);
		expect(planJoin(page, [h1, h2])).toBeNull();
		// A note that is open does not hide its ink.
		page.elements = [{ ...createSticky(200, 200, page), ink: [h1.id, h2.id] }];
		expect(planJoin(page, [h1, h2])).not.toBeNull();
	});

	it("is refused on a locked page, and the page is left as it was", () => {
		const { doc, page, a1, a2, other, c1, c2 } = scene();
		page.locked = true;
		const plan = planJoin(page, [...page.strokes])!;
		const hist = new History(() => doc);
		expect(hist.execute(plan.command)).toBe(false);
		expect(page.strokes).toEqual([a1, a2, other, c1, c2]);
		expect(hist.canUndo()).toBe(false);
	});

	it("does not move the page times (joining is tidying, not writing)", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const hist = new History(() => doc, 500, null, null, null, null, () => 1_800_000_000_000);
		const [a, b] = split([[10, 50], [110, 50]], 50, 2);
		hist.execute(new AddStroke(page.id, a, 0));
		hist.execute(new AddStroke(page.id, b, 1));
		const times = JSON.stringify(pageTimes(page));
		const later = new History(() => doc, 500, null, null, null, null, () => 1_900_000_000_000);
		expect(later.execute(planJoin(page, [a, b])!.command)).toBe(true);
		expect(JSON.stringify(pageTimes(page))).toBe(times);
		later.undo();
		expect(JSON.stringify(pageTimes(page))).toBe(times);
	});

	it("the joined page still saves and reads back with the same ids", () => {
		const { doc, page } = scene();
		new History(() => doc).execute(planJoin(page, [...page.strokes])!.command);
		const parsed = parse(serialize(doc));
		if (!parsed.ok) throw new Error("did not read back");
		const back = parsed.doc;
		expect(back.pages[0]!.strokes.map((s) => s.id)).toEqual(page.strokes.map((s) => s.id));
		expect(back.pages[0]!.strokes[0]!.points).toHaveLength(page.strokes[0]!.points.length);
	});

	it("is a different step from the hook clean-up: cleaning does not join, joining does not trim", () => {
		const { page } = scene();
		expect(planCleanup(page, [...page.strokes])).toBeNull();
		const doc = createDocument();
		const p = doc.pages[0]!;
		const hooked = stroke(poly([[40, 50], [100, 50], [96, 52]]));
		p.strokes.push(hooked);
		expect(planJoin(p, [hooked])).toBeNull();
	});

	it("handles a large page quickly (linear in the strokes)", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		for (let i = 0; i < 4000; i++) {
			const [a, b] = split([[10, 10 + i], [110, 10 + i]], 50, 2);
			page.strokes.push(a, b);
		}
		const t0 = Date.now();
		const plan = planJoin(page, [...page.strokes])!;
		expect(plan.joints).toBe(4000);
		expect(Date.now() - t0).toBeLessThan(3000);
	});
});

describe("realistic handwriting", () => {
	/** A repeatable pseudo-random generator, so the tests do not flake. */
	function rng(seed: number) {
		let s = seed;
		return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
	}

	/** A wavy line (cursive) sampled with uneven spacing, jitter and a varying pressure. */
	function cursive(seed: number): Point[] {
		const r = rng(seed);
		const out: Point[] = [];
		let x = 20;
		while (x < 220) {
			const y = 60 + 10 * Math.sin(x / 9) + (r() - 0.5) * 0.3;
			out.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.35 + 0.2 * Math.sin(x / 15) + (r() - 0.5) * 0.04]);
			x += 0.6 + r() * 1.2;
		}
		return out;
	}

	it("joins a wavy jittery line cut anywhere with a dropout of one or two missed reports", () => {
		let joined = 0;
		let tried = 0;
		for (let seed = 1; seed <= 40; seed++) {
			const pts = cursive(seed);
			const at = 20 + ((seed * 7) % (pts.length - 40));
			const lost = 1 + (seed % 2);
			tried++;
			if (isDropoutPair(stroke(pts.slice(0, at)), stroke(pts.slice(at + lost)))) joined++;
		}
		// Not every cut is a clean one (a cut at a sharp turn of the wave would be a corner), but nearly all are joined.
		expect(joined / tried).toBeGreaterThan(0.8);
	});

	it("never joins separate words written on the same line (a gap of a space)", () => {
		const pts = cursive(3);
		const first = pts.slice(0, 120);
		const second = pts.slice(120).map((p): Point => [p[0] + 12, p[1], p[2]]);
		expect(isDropoutPair(stroke(first), stroke(second))).toBe(false);
	});
});
