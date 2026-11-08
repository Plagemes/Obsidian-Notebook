import { describe, expect, it } from "vitest";
import { AUTO_HOOK_OPTIONS, findHooks, HOOK_RULES, isStrayDot, pathLength, planCleanup, planPenUpTrim, trimHooks } from "../src/ink/hook-clean";
import { createDocument, createStroke } from "../src/model/document";
import { createSticky } from "../src/model/sticky";
import { AddStroke, History } from "../src/model/history";
import { pageTimes } from "../src/model/page-times";
import { RENDER_INK, type Point, type Stroke } from "../src/model/types";

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

function stroke(points: Point[], over: Partial<Stroke> = {}): Stroke {
	return Object.freeze({ ...createStroke("#111111", 2, points, "pen", RENDER_INK), ...over });
}

/** A point `len` away from (x, y) at `deg` degrees (0 = right, 90 = down: page coordinates). */
function away(x: number, y: number, deg: number, len: number): [number, number] {
	const r = (deg * Math.PI) / 180;
	return [x + Math.cos(r) * len, y + Math.sin(r) * len];
}

describe("hooks at the end of a stroke", () => {
	it("cuts a short tick that turns back against the line", () => {
		// Left to right, then a 4 pt tick back and a little down (a 150 degree turn).
		const tip: [number, number] = [100, 50];
		const s = stroke(poly([[40, 50], tip, away(100, 50, 150, 4)]));
		const hooks = findHooks(s)!;
		expect(hooks.head).toBe(0);
		expect(hooks.tail).toBeGreaterThanOrEqual(3);
		const t = trimHooks(s);
		expect(t).not.toBe(s);
		expect(t.points[t.points.length - 1]![0]).toBeCloseTo(100, 5);
		expect(t.points[t.points.length - 1]![1]).toBeCloseTo(50, 5);
		expect(t.points[0]).toEqual(s.points[0]);
	});

	it("keeps the id, the style and every field, and the points stay [x, y, pressure]", () => {
		const base = poly([[40, 50], [100, 50], away(100, 50, 160, 4)]);
		const withPressure: Point[] = base.map((p, i) => [p[0], p[1], 0.2 + (i % 5) / 10]);
		const s = stroke(withPressure, { tool: "fountain", nib: 30, group: "g1", slide: "sl1", render: RENDER_INK });
		const t = trimHooks(s);
		expect(t).not.toBe(s);
		expect(t.id).toBe(s.id);
		expect(t.tool).toBe("fountain");
		expect(t.nib).toBe(30);
		expect(t.group).toBe("g1");
		expect(t.slide).toBe("sl1");
		expect(t.color).toBe(s.color);
		expect(t.width).toBe(s.width);
		for (const p of t.points) {
			expect(p).toHaveLength(3);
			expect(Object.isFrozen(p)).toBe(true);
		}
		// The kept points are the very same triples: pressure is untouched.
		expect(t.points[5]).toBe(s.points[5]);
		expect(Object.isFrozen(t)).toBe(true);
	});

	it("also works for a brush and leaves the original stroke untouched", () => {
		const s = stroke(poly([[0, 0], [60, 0], away(60, 0, 135, 4)]), { tool: "brush" });
		const before = JSON.stringify(s);
		expect(trimHooks(s)).not.toBe(s);
		expect(JSON.stringify(s)).toBe(before);
	});
});

describe("hooks at the start of a stroke", () => {
	it("cuts a tick where the pen landed", () => {
		// The pen lands, ticks back left, then writes the line to the right.
		const start = away(40, 50, 10, 4);
		const s = stroke(poly([start, [40, 50], [100, 50]]));
		const hooks = findHooks(s)!;
		expect(hooks.tail).toBe(0);
		expect(hooks.head).toBeGreaterThanOrEqual(3);
		const t = trimHooks(s);
		expect(t.points[0]![0]).toBeCloseTo(40, 5);
		expect(t.points[0]![1]).toBeCloseTo(50, 5);
		expect(t.points[t.points.length - 1]).toEqual(s.points[s.points.length - 1]);
	});

	it("cuts both ends in one pass", () => {
		const s = stroke(poly([away(40, 50, 20, 4), [40, 50], [120, 50], away(120, 50, 150, 4)]));
		const hooks = findHooks(s)!;
		expect(hooks.head).toBeGreaterThan(0);
		expect(hooks.tail).toBeGreaterThan(0);
		const t = trimHooks(s);
		expect(t.points[0]![0]).toBeCloseTo(40, 5);
		expect(t.points[t.points.length - 1]![0]).toBeCloseTo(120, 5);
	});
});

describe("real corners and shapes are never trimmed", () => {
	const cases: Record<string, Point[]> = {
		"the foot of an L": poly([[50, 20], [50, 60], [62, 60]]),
		"a right angle with a short leg (90 degrees, not a reversal)": poly([[20, 50], [100, 50], [100, 54]]),
		"a check mark": poly([[20, 40], [28, 50], [52, 14]]),
		"an arrow with its barb in one stroke": poly([[20, 50], [120, 50], away(120, 50, 150, 10)]),
		"a Z": poly([[20, 20], [50, 20], [20, 50], [50, 50]]),
		"a W": poly([[20, 20], [30, 50], [40, 20], [50, 50], [60, 20]]),
		"a V": poly([[20, 20], [35, 50], [50, 20]]),
		"a straight line": poly([[0, 0], [100, 0]]),
		"a short stroke": poly([[0, 0], [3, 0], [1, 1]]),
	};
	for (const [name, points] of Object.entries(cases)) {
		it(`keeps ${name}`, () => {
			const s = stroke(points);
			expect(findHooks(s)).toBeNull();
			expect(trimHooks(s)).toBe(s);
		});
	}

	it("keeps a circle written as one stroke, and an arc", () => {
		const circle: Point[] = [];
		for (let a = 0; a <= 360; a += 6) circle.push([100 + 8 * Math.cos((a * Math.PI) / 180), 100 + 8 * Math.sin((a * Math.PI) / 180), 0.5]);
		const sc = stroke(circle);
		expect(findHooks(sc)).toBeNull();
		expect(trimHooks(sc)).toBe(sc);
		const arc: Point[] = [];
		for (let a = 0; a <= 270; a += 5) arc.push([100 + 12 * Math.cos((a * Math.PI) / 180), 100 + 12 * Math.sin((a * Math.PI) / 180), 0.5]);
		const sa = stroke(arc);
		expect(findHooks(sa)).toBeNull();
	});

	it("keeps a wavy line of cursive loops", () => {
		const wave: Point[] = [];
		for (let x = 0; x <= 80; x += 1) wave.push([x, 50 + 6 * Math.sin(x / 3), 0.5]);
		expect(findHooks(stroke(wave))).toBeNull();
	});

	it("keeps a turn of less than a reversal even when it is tiny", () => {
		// A 4 pt flick at 90 degrees from a 60 pt line.
		const s = stroke(poly([[0, 0], [60, 0], [60, 4]]));
		expect(findHooks(s)).toBeNull();
		// 110 degrees is still under the limit.
		const s2 = stroke(poly([[0, 0], [60, 0], away(60, 0, 180 - 70, 4)]));
		expect(findHooks(s2)).toBeNull();
	});

	it("keeps a hook-like leg that is longer than a few pen widths or a tenth of the stroke", () => {
		const longTick = stroke(poly([[0, 0], [100, 0], away(100, 0, 150, HOOK_RULES.capMax + 3)]));
		expect(findHooks(longTick)).toBeNull();
		// 4 pt tick on a 30 pt stroke is 13 % of it: over the share.
		const shortStroke = stroke(poly([[0, 0], [26, 0], away(26, 0, 150, 4)]));
		expect(findHooks(shortStroke)).toBeNull();
	});

	it("does not look at the highlighter, the shape pen, the marker or hidden ink", () => {
		const pts = poly([[40, 50], [100, 50], away(100, 50, 150, 4)]);
		for (const tool of ["highlighter", "shape", "marker"] as const) expect(findHooks(stroke(pts, { tool }))).toBeNull();
		expect(findHooks(stroke(pts, { hidden: true }))).toBeNull();
	});

	it("leaves strokes with fewer than the minimum points alone", () => {
		const s = stroke([[0, 0, 0.5], [10, 0, 0.5], [5, 0, 0.5], [4, 0, 0.5], [3, 0, 0.5]]);
		expect(s.points.length).toBeLessThan(HOOK_RULES.minPoints);
		expect(findHooks(s)).toBeNull();
	});

	it("never leaves fewer than three points", () => {
		for (let len = 5; len < 12; len++) {
			const s = stroke(poly([away(50, 50, 10, 4), [50, 50], away(50, 50, 20, len)], 1));
			const t = trimHooks(s);
			expect(t.points.length).toBeGreaterThanOrEqual(3);
		}
	});

	it("does not trim the tick of a pen so wide that the tick is part of the line", () => {
		// Width 5: the cap is 6 pt, so a 6.5 pt tail is a stroke leg, not a hook.
		const s = stroke(poly([[0, 0], [120, 0], away(120, 0, 150, 6.5)]), { width: 5 });
		expect(findHooks(s)).toBeNull();
	});
});

describe("stray dots", () => {
	const stem = stroke(poly([[50, 20], [50, 60]]));

	it("recognises a dot touching the end of the stroke written just before it", () => {
		const dot = stroke([[51.5, 61, 0.4]]);
		expect(isStrayDot(dot, stem)).toBe(true);
		expect(isStrayDot(stroke([[51.5, 61, 0.4], [51.6, 61.1, 0.4]]), stem)).toBe(true);
	});

	it("recognises a dot just before the stroke it touches the start of", () => {
		const dot = stroke([[50.5, 18.5, 0.4]]);
		expect(isStrayDot(dot, stem)).toBe(true);
	});

	it("keeps the dot of an i or a j: it sits apart from the stem", () => {
		for (const gap of [4, 5, 7, 9]) expect(isStrayDot(stroke([[50, 20 - gap, 0.6]]), stem)).toBe(false);
	});

	it("keeps a full stop apart from the word", () => {
		const word = stroke(poly([[0, 0], [30, 5], [60, 0]]));
		expect(isStrayDot(stroke([[68, 8, 0.7]]), word)).toBe(false);
	});

	it("keeps a dot in the middle of a stroke, however close", () => {
		expect(isStrayDot(stroke([[50, 40, 0.5]]), stem)).toBe(false);
	});

	it("keeps a dot of another pen, colour, width or nib", () => {
		const d = (over: Partial<Stroke>) => isStrayDot(stroke([[51.5, 61, 0.4]], over), stem);
		expect(d({})).toBe(true);
		expect(d({ color: "#ff0000" })).toBe(false);
		expect(d({ width: 3.2 })).toBe(false);
		expect(d({ tool: "fountain" })).toBe(false);
		expect(isStrayDot(stroke([[51.5, 61, 0.4]], { tool: "fountain", nib: 10 }), stroke(stem.points, { tool: "fountain", nib: 40 }))).toBe(false);
	});

	it("keeps a dot that is not a dot: too many points or too wide a scribble", () => {
		expect(isStrayDot(stroke(poly([[51, 61], [53, 61]], 0.5)), stem)).toBe(false);
		expect(isStrayDot(stroke([[51, 61, 0.5], [51.2, 61, 0.5], [51.4, 61, 0.5], [51.6, 61, 0.5], [51.8, 61, 0.5]]), stem)).toBe(false);
	});

	it("keeps grouped, hidden and non-pen dots", () => {
		expect(isStrayDot(stroke([[51.5, 61, 0.4]], { group: "g" }), stem)).toBe(false);
		expect(isStrayDot(stroke([[51.5, 61, 0.4]], { hidden: true }), stem)).toBe(false);
		expect(isStrayDot(stroke([[51.5, 61, 0.4]], { tool: "highlighter" }), stroke(stem.points, { tool: "highlighter" }))).toBe(false);
	});

	it("never takes a dot beside another dot, or beside a tiny mark, for a bounce", () => {
		expect(isStrayDot(stroke([[51.5, 61, 0.4]]), stroke([[50, 60, 0.4]]))).toBe(false);
		expect(isStrayDot(stroke([[51.5, 61, 0.4]]), undefined)).toBe(false);
	});
});

describe("planCleanup", () => {
	function scene() {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const hooked = stroke(poly([[40, 50], [100, 50], away(100, 50, 150, 4)]));
		const stem = stroke(poly([[50, 120], [50, 160]]));
		const bounce = stroke([[51.5, 161, 0.4]]);
		const iDot = stroke([[50, 112, 0.5]]);
		const clean = stroke(poly([[10, 200], [90, 200]]));
		page.strokes.push(hooked, stem, bounce, iDot, clean);
		return { doc, page, hooked, stem, bounce, iDot, clean };
	}

	it("trims hooks and removes bounce dots in ONE undoable step, keeping order and the i-dot", () => {
		const { doc, page, hooked, stem, bounce, iDot, clean } = scene();
		const plan = planCleanup(page, [...page.strokes])!;
		expect(plan).not.toBeNull();
		expect(plan.trimmed).toBe(1);
		expect(plan.removed).toBe(1);
		const hist = new History(() => doc);
		expect(hist.execute(plan.command)).toBe(true);
		expect(page.strokes).toHaveLength(4);
		expect(page.strokes[0]!.id).toBe(hooked.id);
		expect(page.strokes[0]).not.toBe(hooked);
		expect(page.strokes[1]).toBe(stem);
		expect(page.strokes[2]).toBe(iDot);
		expect(page.strokes[3]).toBe(clean);
		expect(plan.strokes).toEqual([page.strokes[0], stem, iDot, clean]);
		// One undo gives everything back, in place.
		hist.undo();
		expect(page.strokes).toEqual([hooked, stem, bounce, iDot, clean]);
		expect(page.strokes[0]).toBe(hooked);
		expect(page.strokes[2]).toBe(bounce);
		expect(hist.canUndo()).toBe(false);
		hist.redo();
		expect(page.strokes).toHaveLength(4);
		expect(page.strokes[0]).toBe(plan.strokes[0]);
	});

	it("restores several removed dots at their positions", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const a = stroke(poly([[10, 10], [10, 50]]));
		const da = stroke([[11, 51, 0.4]]);
		const b = stroke(poly([[60, 10], [60, 50]]));
		const db = stroke([[61, 51, 0.4]]);
		page.strokes.push(a, da, b, db);
		const hist = new History(() => doc);
		const plan = planCleanup(page, [...page.strokes])!;
		expect(plan.removed).toBe(2);
		hist.execute(plan.command);
		expect(page.strokes).toEqual([a, b]);
		hist.undo();
		expect(page.strokes).toEqual([a, da, b, db]);
		expect(page.strokes.map((s) => s.id)).toEqual([a.id, da.id, b.id, db.id]);
	});

	it("only touches the strokes it was asked for, though a neighbour outside the request still tells a dot from an i-dot", () => {
		const { page, hooked, bounce } = scene();
		// The bounce alone, the stem not asked for: the dot is still recognised by its neighbour.
		const plan = planCleanup(page, [bounce])!;
		expect(plan.removed).toBe(1);
		expect(plan.trimmed).toBe(0);
		expect(plan.strokes).toEqual([]);
		// The hooked stroke is not in the request: it stays.
		const only = planCleanup(page, [bounce])!;
		const hist = new History(() => ({ ...createDocument(), pages: [page] }));
		hist.execute(only.command);
		expect(page.strokes).toContain(hooked);
	});

	it("returns null when there is nothing to clean", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		page.strokes.push(stroke(poly([[0, 0], [100, 0]])), stroke([[50, -8, 0.5]]));
		expect(planCleanup(page, [...page.strokes])).toBeNull();
		expect(planCleanup(page, [])).toBeNull();
	});

	it("skips strokes that are no longer on the page", () => {
		const { page } = scene();
		const gone = stroke(poly([[40, 50], [100, 50], away(100, 50, 150, 4)]));
		expect(planCleanup(page, [gone])).toBeNull();
	});

	it("refuses a locked page through the history and changes nothing", () => {
		const { doc, page, hooked, bounce } = scene();
		page.locked = true;
		let told: readonly string[] = [];
		const hist = new History(() => doc, 500, null, null, null, (ids) => { told = ids; });
		const plan = planCleanup(page, [...page.strokes])!;
		expect(hist.execute(plan.command)).toBe(false);
		expect(told).toEqual([page.id]);
		expect(page.strokes[0]).toBe(hooked);
		expect(page.strokes).toContain(bounce);
		expect(page.strokes).toHaveLength(5);
		expect(hist.canUndo()).toBe(false);
	});

	it("keeps the group of a trimmed stroke", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const g = stroke(poly([[40, 50], [100, 50], away(100, 50, 150, 4)]), { group: "grp" });
		const mate = stroke(poly([[40, 70], [100, 70]]), { group: "grp" });
		page.strokes.push(g, mate);
		const plan = planCleanup(page, [g])!;
		new History(() => doc).execute(plan.command);
		expect(page.strokes[0]!.group).toBe("grp");
	});
});

describe("measures", () => {
	it("path length", () => {
		expect(pathLength(poly([[0, 0], [3, 4]]))).toBeCloseTo(5, 6);
		expect(pathLength([])).toBe(0);
	});
});

describe("review V2: trimming as you write keeps the raw stroke in the history", () => {
	const hooked = () => stroke(poly([[40, 50], [100, 50], away(100, 50, 170, 3)]));

	it("the stroke is committed as written, the trim is its own step: one Undo gives the raw points back, a second removes it", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const hist = new History(() => doc, 500, null, null, null, null, () => 1_800_000_000_000);
		const raw = hooked();
		expect(hist.execute(new AddStroke(page.id, raw, 0))).toBe(true);
		const timesAfterAdd = JSON.stringify(pageTimes(page));
		const plan = planPenUpTrim(page, raw.id)!;
		expect(plan).not.toBeNull();
		expect(plan.trimmed.points.length).toBeLessThan(raw.points.length);
		expect(hist.execute(plan.command)).toBe(true);
		expect(page.strokes).toHaveLength(1);
		expect(page.strokes[0]).toBe(plan.trimmed);
		expect(page.strokes[0]!.id).toBe(raw.id);
		// The cleanup is not "writing": the page times keep what the stroke stamped.
		expect(JSON.stringify(pageTimes(page))).toBe(timesAfterAdd);
		hist.undo();
		expect(page.strokes).toHaveLength(1);
		expect(page.strokes[0]).toBe(raw);
		expect(page.strokes[0]!.points).toHaveLength(raw.points.length);
		hist.undo();
		expect(page.strokes).toHaveLength(0);
		hist.redo();
		hist.redo();
		expect(page.strokes[0]).toBe(plan.trimmed);
	});

	it("finds the committed object by id (the one the history holds may not be the one that was drawn)", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const raw = hooked();
		page.strokes.push(stroke(poly([[0, 0], [30, 0]])), { ...raw });
		const plan = planPenUpTrim(page, raw.id)!;
		expect(plan.command.index).toBe(1);
		expect(planPenUpTrim(page, "missing")).toBeNull();
	});

	it("a locked page refuses the trim and keeps the raw stroke", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const raw = hooked();
		page.strokes.push(raw);
		page.locked = true;
		const hist = new History(() => doc);
		expect(hist.execute(planPenUpTrim(page, raw.id)!.command)).toBe(false);
		expect(page.strokes[0]).toBe(raw);
	});

	it("the writing-time rules are stricter: the exit tail of a printed a, d or u stays, a flick back along the line goes", () => {
		// A down stroke whose exit tail turns 130 degrees (a letter's tail), 3 pt long.
		const tail = stroke(poly([[50, 20], [50, 80], away(50, 80, 90 + 130, 3)]));
		expect(findHooks(tail)).not.toBeNull();
		expect(trimHooks(tail)).not.toBe(tail);
		expect(trimHooks(tail, AUTO_HOOK_OPTIONS)).toBe(tail);
		const doc = createDocument();
		doc.pages[0]!.strokes.push(tail);
		expect(planPenUpTrim(doc.pages[0]!, tail.id)).toBeNull();
		// A near reversal is trimmed by both.
		const flick = hooked();
		expect(trimHooks(flick, AUTO_HOOK_OPTIONS)).not.toBe(flick);
		// A hook that is over 6 percent of a short stroke stays for the automatic rule.
		const short = stroke(poly([[0, 0], [30, 0], away(30, 0, 170, 3)]));
		expect(trimHooks(short)).not.toBe(short);
		expect(trimHooks(short, AUTO_HOOK_OPTIONS)).toBe(short);
	});
});

describe("review V7: clean-up never edits ink a collapsed sticky note keeps hidden", () => {
	it("leaves hooks and bounce dots of hidden ink alone, and does not take a hidden stroke for a neighbour", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const hiddenHook = stroke(poly([[40, 50], [100, 50], away(100, 50, 160, 4)]));
		const hiddenStem = stroke(poly([[50, 120], [50, 160]]));
		const hiddenDot = stroke([[51.5, 161, 0.4]]);
		const visibleDot = stroke([[50, 300, 0.4]]);
		const hiddenNeighbour = stroke(poly([[50, 301], [50, 340]]));
		const visibleHook = stroke(poly([[40, 400], [100, 400], away(100, 400, 160, 4)]));
		const note = { ...createSticky(200, 200, page), collapsed: true, ink: [hiddenHook.id, hiddenStem.id, hiddenDot.id, hiddenNeighbour.id] };
		page.strokes.push(hiddenHook, hiddenStem, hiddenDot, visibleDot, hiddenNeighbour, visibleHook);
		page.elements = [note];
		const plan = planCleanup(page, [...page.strokes])!;
		expect(plan.trimmed).toBe(1);
		expect(plan.removed).toBe(0);
		new History(() => doc).execute(plan.command);
		expect(page.strokes).toHaveLength(6);
		expect(page.strokes[0]).toBe(hiddenHook);
		expect(page.strokes[2]).toBe(hiddenDot);
		expect(page.strokes[3]).toBe(visibleDot);
		expect(page.strokes[5]).not.toBe(visibleHook);
		// Only hidden ink asked for: nothing to do.
		expect(planCleanup(page, [hiddenHook, hiddenDot])).toBeNull();
	});

	it("an expanded note hides nothing: its ink is cleaned like any other", () => {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const hook = stroke(poly([[40, 50], [100, 50], away(100, 50, 160, 4)]));
		page.strokes.push(hook);
		page.elements = [{ ...createSticky(200, 200, page), ink: [hook.id] }];
		expect(planCleanup(page, [hook])).not.toBeNull();
	});
});
