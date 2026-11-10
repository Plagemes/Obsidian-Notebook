import { describe, expect, it } from "vitest";
import {
	markerGroupId, markerRadius, markerSets, markerTarget, needsRenumber, newSetId, nextSpot, parseMarkerGroup, planAddMarker, planRenumber, renumbered,
	selectionMarkerKind, setIdOfFigure, type MarkerPlan, type MarkerTarget,
} from "../src/ink/figure-markers";
import { createDocument } from "../src/model/document";
import { parseLegend } from "../src/model/figure-legend";
import { History } from "../src/model/history";
import { duplicatePage } from "../src/model/pages";
import { computeScope, pageRules } from "../src/model/page-undo";
import { serializeChecked } from "../src/model/serialize";
import type { ImageElement, NotebookDocument, Page, Stroke, TextElement } from "../src/model/types";
import { line } from "./helpers";

const NOW = new Date("2026-11-10T10:00:00.000Z");
let n = 0;
const ids = () => `m${++n}`;
const rnd = () => `r${++n}`;
const opts = { color: "#c0392b", fontSize: 12, newId: ids, random: rnd };

function setup(): { doc: NotebookDocument; page: Page; history: History; picture: ImageElement } {
	const doc = createDocument(NOW);
	const page = doc.pages[0]!;
	const picture: ImageElement = { id: "pic-1", type: "image", asset: "a1", x: 60, y: 100, width: 300, height: 200, rotation: 0 };
	page.elements = [picture];
	const history = new History(() => doc, 100, null, null, null, null);
	return { doc, page, history, picture };
}

const figure = (page: Page, el: ImageElement): MarkerTarget => markerTarget(page, { strokes: [], elements: [el] })!;
const texts = (page: Page): TextElement[] => (page.elements ?? []).filter((e): e is TextElement => e.type === "text");
function add(page: Page, history: History, target: MarkerTarget): Extract<MarkerPlan, { ok: true }> {
	const plan = planAddMarker(page, target, opts);
	if (!plan.ok) throw new Error(plan.reason);
	expect(history.execute(plan.cmd)).toBe(true);
	return plan;
}

describe("the group ids of markers (#247)", () => {
	it("round-trip and stay inside the group id limit", () => {
		const g = markerGroupId("m", "pic-1", "ab12cd34");
		expect(g).toBe("nbm1.m.pic-1.ab12cd34");
		expect(parseMarkerGroup(g)).toEqual({ role: "m", set: "pic-1" });
		expect(parseMarkerGroup(markerGroupId("l", "x", "y"))).toEqual({ role: "l", set: "x" });
		const long = markerGroupId("m", "a".repeat(36), "12345678");
		expect(long.length).toBeLessThanOrEqual(64);
		expect(markerGroupId("l", newSetId(), "12345678").length).toBeLessThanOrEqual(64);
	});

	it("are read leniently: anything else is just a group", () => {
		for (const bad of ["nbm1.m.pic", "nbm1.x.pic.r", "nbm1.m..r", "nbm1.m.a.b.c", "nbc1.m.pic.r", "nbm1.m.a b.r", "nbm1.m.pic.", "", "uuid-1"]) expect(parseMarkerGroup(bad), bad).toBeNull();
		expect(parseMarkerGroup(undefined)).toBeNull();
		expect(setIdOfFigure("pic-1")).toBe("pic-1");
		expect(setIdOfFigure("a.b")).toBeNull();
		expect(setIdOfFigure("x".repeat(41))).toBeNull();
	});
});

describe("adding markers (#247)", () => {
	it("puts a numbered circle on a picture and a legend under it, in one step", () => {
		const { doc, page, history, picture } = setup();
		const plan = add(page, history, figure(page, picture));
		expect(plan.number).toBe(1);
		expect(plan.legendCreated).toBe(true);
		const sets = markerSets(page);
		const s = sets.get("pic-1")!;
		expect(s.markers).toHaveLength(1);
		expect(s.markers[0]!.number).toBe(1);
		expect(s.legend?.text.text).toBe("1.");
		// the circle is a closed shape with a tint and the number a text box, both of one group; the legend a rule and a text box
		const m = s.markers[0]!;
		expect(m.circle.tool).toBe("shape");
		expect(m.circle.fillTint).toBe(true);
		expect(m.text.group).toBe(m.group);
		expect(s.legend!.rule?.group).toBe(s.legend!.group);
		expect(page.strokes).toHaveLength(2);
		// it sits inside the picture and the legend is below it
		expect(m.cx).toBeGreaterThan(picture.x);
		expect(m.cx).toBeLessThan(picture.x + picture.width);
		expect(m.cy).toBeGreaterThan(picture.y);
		expect(m.cy).toBeLessThan(picture.y + picture.height);
		expect(s.legend!.text.y).toBeGreaterThan(picture.y + picture.height);
		// one undo takes it all away, one redo brings it back
		history.undo();
		expect(page.strokes).toHaveLength(0);
		expect(texts(page)).toHaveLength(0);
		history.redo();
		expect(markerSets(page).get("pic-1")!.markers).toHaveLength(1);
		expect(() => serializeChecked(doc)).not.toThrow();
	});

	it("numbers the next marker after the highest and appends to the legend without touching typed words", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const legend = markerSets(page).get("pic-1")!.legend!;
		const typed = { ...legend.text, text: "Key\n1. Cell wall" };
		const el = (page.elements ?? []).indexOf(legend.text);
		page.elements![el] = typed;
		add(page, history, figure(page, picture));
		add(page, history, figure(page, picture));
		const s = markerSets(page).get("pic-1")!;
		expect(s.markers.map((m) => m.number)).toEqual([1, 2, 3]);
		expect(s.legend!.text.text).toBe("Key\n1. Cell wall\n2.\n3.");
		// a legend is created once
		expect(texts(page).filter((t) => t.group?.startsWith("nbm1.l.")).length).toBe(1);
	});

	it("places markers on distinct spots inside the picture", () => {
		const { page, history, picture } = setup();
		for (let i = 0; i < 9; i++) add(page, history, figure(page, picture));
		const ms = markerSets(page).get("pic-1")!.markers;
		expect(ms).toHaveLength(9);
		for (const m of ms) {
			expect(m.cx - m.r).toBeGreaterThanOrEqual(picture.x);
			expect(m.cx + m.r).toBeLessThanOrEqual(picture.x + picture.width);
		}
		for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) expect(Math.hypot(ms[i]!.cx - ms[j]!.cx, ms[i]!.cy - ms[j]!.cy)).toBeGreaterThan(ms[0]!.r * 2);
		expect(new Set(ms.map((m) => m.r)).size).toBe(1);
		expect(new Set(ms.map((m) => m.circle.color)).size).toBe(1);
	});

	it("centres the number in its circle", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const m = markerSets(page).get("pic-1")!.markers[0]!;
		// the stub measure is 0.55 em per character
		const w = 1 * m.text.fontSize * 0.55;
		expect(m.text.x + w / 2).toBeCloseTo(m.cx, 1);
		expect(m.text.y + (m.text.fontSize * 1.25) / 2).toBeCloseTo(m.cy, 1);
		expect(m.text.width).toBeGreaterThanOrEqual(w);
	});

	it("refuses when the figure already has the largest number", () => {
		const { page, history, picture } = setup();
		// an endless page: a legend of 99 lines runs past the bottom of a fixed one (refused as "edge", below)
		page.infinite = true;
		const target = figure(page, picture);
		const big = { ...picture, x: 10, y: 20, width: 570, height: 790, id: "big" };
		page.elements!.push(big);
		const bigTarget = figure(page, big);
		for (let i = 0; i < 99; i++) add(page, history, bigTarget);
		const plan = planAddMarker(page, bigTarget, opts);
		expect(plan).toEqual({ ok: false, reason: "full" });
		expect(target.set).toBe("pic-1");
	});

	it("refuses an insert that touches a redaction box, or when the boxes cannot be read", () => {
		const { page, picture } = setup();
		const target = figure(page, picture);
		const free = planAddMarker(page, target, opts, { boxes: [] });
		expect(free.ok).toBe(true);
		const plan = planAddMarker(page, target, opts, { boxes: [{ x: picture.x, y: picture.y, width: picture.width, height: picture.height }] });
		expect(plan).toEqual({ ok: false, reason: "redacted" });
		expect(planAddMarker(page, target, opts, { boxes: [], unreadable: true })).toEqual({ ok: false, reason: "redacted" });
	});

	it("refuses when the legend is locked or part of a drawing with states", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const legend = markerSets(page).get("pic-1")!.legend!;
		const i = page.elements!.indexOf(legend.text);
		page.elements![i] = { ...legend.text, locked: true };
		expect(planAddMarker(page, figure(page, picture), opts)).toEqual({ ok: false, reason: "locked" });
		page.elements![i] = legend.text;
		page.states = { parts: [{ id: "p", items: [legend.text.id] }] } as never;
		expect(planAddMarker(page, figure(page, picture), opts)).toEqual({ ok: false, reason: "states" });
	});

	it("review I2: refuses when the legend it rewrites touches a redaction box, before or after, and changes nothing", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const legend = markerSets(page).get("pic-1")!.legend!.text;
		// a box over the legend only (the new marker lies on the picture, far from it)
		const box = { x: legend.x, y: legend.y, width: legend.width, height: 10 };
		const before = JSON.stringify(page);
		expect(planAddMarker(page, figure(page, picture), opts, { boxes: [box] })).toEqual({ ok: false, reason: "redacted" });
		expect(JSON.stringify(page)).toBe(before);
		expect(planAddMarker(page, figure(page, picture), opts, { boxes: [{ x: 500, y: 700, width: 20, height: 20 }] }).ok).toBe(true);
	});

	it("review I2: the legend keeps the person's blank lines, indentation and notes when a marker is added", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const legend = markerSets(page).get("pic-1")!.legend!;
		page.elements![page.elements!.indexOf(legend.text)] = { ...legend.text, text: "Key\n\n  1) Wall\n       thick\n\nSource: p.4" };
		add(page, history, figure(page, picture));
		expect(markerSets(page).get("pic-1")!.legend!.text.text).toBe("Key\n\n  1) Wall\n       thick\n  2)\n\nSource: p.4");
	});

	it("review I6: refuses when the legend it rewrites lies under a study tape", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const legend = markerSets(page).get("pic-1")!.legend!.text;
		page.elements!.push({ id: "tape-1", type: "tape", x: legend.x, y: legend.y, width: 40, height: 10, color: "#f5d76e" });
		expect(planAddMarker(page, figure(page, picture), opts)).toEqual({ ok: false, reason: "tape" });
		// a tape elsewhere does not matter
		page.elements![page.elements!.length - 1] = { id: "tape-1", type: "tape", x: 500, y: 700, width: 40, height: 10, color: "#f5d76e" };
		expect(planAddMarker(page, figure(page, picture), opts).ok).toBe(true);
	});

	it("review I11: refuses when the legend would grow past the bottom of a fixed page", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const legend = markerSets(page).get("pic-1")!.legend!;
		const lh = legend.text.fontSize * 1.25;
		page.elements![page.elements!.indexOf(legend.text)] = { ...legend.text, y: page.height - lh - 1 };
		expect(planAddMarker(page, figure(page, picture), opts)).toEqual({ ok: false, reason: "edge" });
		page.infinite = true;
		expect(planAddMarker(page, figure(page, picture), opts).ok).toBe(true);
	});

	it("review I12: with only the legend left, the new marker goes just above the legend, not to the page centre", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const s = markerSets(page).get("pic-1")!;
		page.strokes.splice(page.strokes.indexOf(s.markers[0]!.circle), 1);
		page.elements!.splice(page.elements!.indexOf(s.markers[0]!.text), 1);
		const legend = s.legend!.text;
		const plan = planAddMarker(page, { kind: "set", set: "pic-1", box: null }, opts);
		if (!plan.ok) throw new Error(plan.reason);
		const ring = plan.strokes[0]!.points;
		const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
		expect(cy).toBeLessThan(legend.y);
		expect(cy).toBeGreaterThan(legend.y - 80);
	});

	it("review I3 (c): a marker whose number the person edited keeps its number taken", () => {
		const { page, history, picture } = setup();
		for (let i = 0; i < 3; i++) add(page, history, figure(page, picture));
		const m3 = markerSets(page).get("pic-1")!.markers[2]!;
		page.elements![page.elements!.indexOf(m3.text)] = { ...m3.text, text: "3a" };
		const plan = add(page, history, figure(page, picture));
		expect(plan.number).toBe(4);
	});

	it("works for a region of ink and joins its set when selected again", () => {
		const { page, history } = setup();
		const a = line(100, 500, 300, 500);
		const b = line(100, 500, 100, 650);
		page.strokes.push(a, b);
		const t1 = markerTarget(page, { strokes: [a, b], elements: [] })!;
		expect(t1.kind).toBe("region");
		add(page, history, t1);
		add(page, history, t1);
		const t2 = markerTarget(page, { strokes: [a, b], elements: [] })!;
		expect(t2.set).toBe(t1.set);
		add(page, history, t2);
		expect(markerSets(page).get(t1.set)!.markers.map((m) => m.number)).toEqual([1, 2, 3]);
		expect(markerSets(page).size).toBe(1);
	});

	it("keeps the set of a marker selected on its own and finds the figure through it", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const m = markerSets(page).get("pic-1")!.markers[0]!;
		const target = markerTarget(page, { strokes: [m.circle], elements: [m.text] })!;
		expect(target).toMatchObject({ kind: "set", set: "pic-1", box: { x: 60, y: 100, width: 300, height: 200 } });
		add(page, history, target);
		expect(markerSets(page).get("pic-1")!.markers).toHaveLength(2);
	});

	it("says nothing is a target for an empty selection, a text box alone, or two sets at once", () => {
		const { page, history, picture } = setup();
		expect(markerTarget(page, { strokes: [], elements: [] })).toBeNull();
		expect(selectionMarkerKind({ strokes: [], elements: [{ id: "t", type: "text", x: 0, y: 0, width: 10, text: "a", fontSize: 12, color: "#000" }] })).toBeNull();
		const other = { ...picture, id: "pic-2", y: 400 };
		page.elements!.push(other);
		add(page, history, figure(page, picture));
		add(page, history, figure(page, other));
		const sets = [...markerSets(page).values()];
		const mixed = markerTarget(page, { strokes: sets.map((s) => s.markers[0]!.circle), elements: sets.map((s) => s.markers[0]!.text) });
		expect(mixed).toBeNull();
		expect(selectionMarkerKind({ strokes: [], elements: [picture] })).toBe("figure");
		expect(selectionMarkerKind({ strokes: [line(0, 0, 5, 5)], elements: [] })).toBe("region");
	});

	it("sizes the disc from the figure and keeps its spots on the page", () => {
		expect(markerRadius({ x: 0, y: 0, width: 100, height: 100 })).toBe(10);
		expect(markerRadius({ x: 0, y: 0, width: 1000, height: 1000 })).toBe(17);
		expect(markerRadius(null)).toBe(11);
		expect(nextSpot({ x: 0, y: 0, width: 100, height: 100 }, { width: 100, height: 100, infinite: false }, [], 10)).toEqual({ x: 14, y: 14 });
		// no room left on a page
		const full = Array.from({ length: 200 }, (_, i) => ({ cx: 14 + (i % 3) * 30, cy: 14 + Math.floor(i / 3) * 30 }));
		expect(nextSpot({ x: 0, y: 0, width: 100, height: 100 }, { width: 100, height: 100, infinite: false }, full, 10)).toBeNull();
	});
});

describe("renumbering markers (#247)", () => {
	function three(): { page: Page; history: History; picture: ImageElement } {
		const s = setup();
		for (let i = 0; i < 3; i++) add(s.page, s.history, figure(s.page, s.picture));
		const legend = markerSets(s.page).get("pic-1")!.legend!;
		const i = s.page.elements!.indexOf(legend.text);
		s.page.elements![i] = { ...legend.text, text: "1. Wall\n2. Nucleus\n3. Vacuole" };
		return s;
	}

	function removeMarker(page: Page, number: number): void {
		const m = markerSets(page).get("pic-1")!.markers.find((x) => x.number === number)!;
		page.strokes.splice(page.strokes.indexOf(m.circle), 1);
		page.elements!.splice(page.elements!.indexOf(m.text), 1);
	}

	it("leaves a gap when a marker is deleted, and closes it on request in one step with the legend following", () => {
		const { page, history } = three();
		removeMarker(page, 2);
		const set = markerSets(page).get("pic-1")!;
		expect(set.markers.map((m) => m.number)).toEqual([1, 3]);
		expect(needsRenumber(page, set)).toBe(true);
		const plan = planRenumber(page, set);
		if (!plan.ok) throw new Error(plan.reason);
		expect(plan.changed).toBe(1);
		expect(plan.dropped).toBe(1);
		expect(history.execute(plan.cmd)).toBe(true);
		const after = markerSets(page).get("pic-1")!;
		expect(after.markers.map((m) => m.number)).toEqual([1, 2]);
		expect(after.legend!.text.text).toBe("1. Wall\n2. Vacuole");
		// the number is centred again and nothing else moved
		const m2 = after.markers[1]!;
		expect(m2.text.x + (m2.text.fontSize * 0.55) / 2).toBeCloseTo(m2.cx, 1);
		// one undo puts the old numbers and the old legend back
		history.undo();
		const back = markerSets(page).get("pic-1")!;
		expect(back.markers.map((m) => m.number)).toEqual([1, 3]);
		expect(back.legend!.text.text).toBe("1. Wall\n2. Nucleus\n3. Vacuole");
		expect(needsRenumber(page, markerSets(page).get("pic-1")!)).toBe(true);
		history.redo();
		expect(needsRenumber(page, markerSets(page).get("pic-1")!)).toBe(false);
	});

	it("says there is nothing to do for a figure that is already numbered", () => {
		const { page } = three();
		const set = markerSets(page).get("pic-1")!;
		expect(planRenumber(page, set)).toEqual({ ok: false, reason: "same" });
		expect(needsRenumber(page, set)).toBe(false);
	});

	it("never empties a legend whose markers are all gone", () => {
		const { page } = three();
		for (const k of [1, 2, 3]) removeMarker(page, k);
		const set = markerSets(page).get("pic-1")!;
		expect(set.markers).toHaveLength(0);
		expect(set.legend).not.toBeNull();
		expect(planRenumber(page, set)).toEqual({ ok: false, reason: "none" });
	});

	it("repairs a legend that lost a line, and numbers duplicates in turn", () => {
		const { page, history } = three();
		const set = markerSets(page).get("pic-1")!;
		const m3 = set.markers[2]!;
		// the person typed 1 into the third marker: two markers say 1
		page.elements![page.elements!.indexOf(m3.text)] = { ...m3.text, text: "1" };
		const dup = markerSets(page).get("pic-1")!;
		expect(renumbered(dup.markers).map((r) => r.to)).toEqual([1, 2, 3]);
		const plan = planRenumber(page, dup);
		if (!plan.ok) throw new Error(plan.reason);
		history.execute(plan.cmd);
		expect(markerSets(page).get("pic-1")!.markers.map((m) => m.number).sort()).toEqual([1, 2, 3]);
		expect(parseLegend(markerSets(page).get("pic-1")!.legend!.text.text).entries.map((e) => e.number)).toEqual([1, 2, 3]);
	});

	it("is refused when something that must change is locked or in a drawing with states", () => {
		const { page } = three();
		removeMarker(page, 1);
		const set = markerSets(page).get("pic-1")!;
		const legend = set.legend!;
		const i = page.elements!.indexOf(legend.text);
		page.elements![i] = { ...legend.text, locked: true };
		expect(planRenumber(page, markerSets(page).get("pic-1")!)).toEqual({ ok: false, reason: "locked" });
		page.elements![i] = legend.text;
		const m = set.markers[0]!;
		page.states = { parts: [{ id: "p", items: [m.text.id] }] } as never;
		expect(planRenumber(page, markerSets(page).get("pic-1")!)).toEqual({ ok: false, reason: "states" });
	});

	it("reports the words of the legend lines it removes (the view asks first)", () => {
		const { page } = three();
		removeMarker(page, 2);
		const plan = planRenumber(page, markerSets(page).get("pic-1")!);
		if (!plan.ok) throw new Error(plan.reason);
		expect(plan.removed).toEqual(["2. Nucleus"]);
		expect(plan.shared).toBe(0);
	});

	it("review I1: refuses when the legend touches a redaction box (a dropped line would shrink it out from under the box)", () => {
		const { page } = three();
		const legend = markerSets(page).get("pic-1")!.legend!.text;
		removeMarker(page, 2);
		const lh = legend.fontSize * 1.25;
		// the box covers the last entry only: after the renumber the legend is one line shorter and no longer reaches it
		const box = { x: legend.x, y: legend.y + 2 * lh + 2, width: legend.width, height: lh - 4 };
		const before = JSON.stringify(page);
		expect(planRenumber(page, markerSets(page).get("pic-1")!, { guard: { boxes: [box] } })).toEqual({ ok: false, reason: "redacted" });
		expect(planRenumber(page, markerSets(page).get("pic-1")!, { guard: { boxes: [], unreadable: true } })).toEqual({ ok: false, reason: "redacted" });
		expect(JSON.stringify(page)).toBe(before);
		expect(planRenumber(page, markerSets(page).get("pic-1")!, { guard: { boxes: [{ x: 500, y: 760, width: 20, height: 20 }] } }).ok).toBe(true);
	});

	it("review I1: refuses when a re-centred number box touches a redaction box", () => {
		const { page } = three();
		removeMarker(page, 1);
		const m = markerSets(page).get("pic-1")!.markers[0]!;
		const box = { x: m.cx - 2, y: m.cy - 2, width: 4, height: 4 };
		expect(planRenumber(page, markerSets(page).get("pic-1")!, { guard: { boxes: [box] } })).toEqual({ ok: false, reason: "redacted" });
	});

	it("review I6: refuses when a legend line or a number that would change lies under a study tape", () => {
		const { page } = three();
		const legend = markerSets(page).get("pic-1")!.legend!.text;
		removeMarker(page, 2);
		page.elements!.push({ id: "tape-1", type: "tape", x: legend.x, y: legend.y + 20, width: 60, height: 8, color: "#f5d76e" });
		expect(planRenumber(page, markerSets(page).get("pic-1")!)).toEqual({ ok: false, reason: "tape" });
		const m = markerSets(page).get("pic-1")!.markers[1]!;
		page.elements![page.elements!.length - 1] = { id: "tape-1", type: "tape", x: m.cx - 3, y: m.cy - 3, width: 6, height: 6, color: "#f5d76e" };
		expect(planRenumber(page, markerSets(page).get("pic-1")!)).toEqual({ ok: false, reason: "tape" });
		page.elements![page.elements!.length - 1] = { id: "tape-1", type: "tape", x: 500, y: 760, width: 6, height: 6, color: "#f5d76e" };
		expect(planRenumber(page, markerSets(page).get("pic-1")!).ok).toBe(true);
	});

	it("review I3 (c): refuses while a marker's number was edited (\"3a\") or its ring half erased, and the legend keeps every word", () => {
		const { page } = three();
		const s = markerSets(page).get("pic-1")!;
		page.elements![page.elements!.indexOf(s.markers[2]!.text)] = { ...s.markers[2]!.text, text: "3a" };
		removeMarker(page, 1);
		expect(planRenumber(page, markerSets(page).get("pic-1")!)).toEqual({ ok: false, reason: "stray" });
		// a ring the eraser took most of
		const { page: p2 } = three();
		const m = markerSets(p2).get("pic-1")!.markers[2]!;
		p2.strokes[p2.strokes.indexOf(m.circle)] = { ...m.circle, points: m.circle.points.slice(0, 2) };
		removeMarker(p2, 1);
		expect(planRenumber(p2, markerSets(p2).get("pic-1")!)).toEqual({ ok: false, reason: "stray" });
	});

	it("review I3 (b): a legend line typed twice under one number keeps its words and is reported", () => {
		const { page, history } = three();
		const legend = markerSets(page).get("pic-1")!.legend!;
		page.elements![page.elements!.indexOf(legend.text)] = { ...legend.text, text: "1. Wall\n2. Nucleus\n3. Vacuole\n3. Vacuole, again" };
		removeMarker(page, 2);
		const plan = planRenumber(page, markerSets(page).get("pic-1")!);
		if (!plan.ok) throw new Error(plan.reason);
		expect(plan.shared).toBe(1);
		expect(plan.removed).toEqual(["2. Nucleus"]);
		history.execute(plan.cmd);
		expect(markerSets(page).get("pic-1")!.legend!.text.text).toBe("1. Wall\n2. Vacuole\n2. Vacuole, again");
	});

	it("review I3 (a): a note typed after the entries stays when the last marker is deleted", () => {
		const { page, history } = three();
		const legend = markerSets(page).get("pic-1")!.legend!;
		page.elements![page.elements!.indexOf(legend.text)] = { ...legend.text, text: "1. Wall\n2. Nucleus\n3. Vacuole\n\nSource: textbook p.4" };
		removeMarker(page, 3);
		removeMarker(page, 1);
		const plan = planRenumber(page, markerSets(page).get("pic-1")!);
		if (!plan.ok) throw new Error(plan.reason);
		history.execute(plan.cmd);
		expect(markerSets(page).get("pic-1")!.legend!.text.text).toBe("1. Nucleus\n\nSource: textbook p.4");
		expect(plan.removed).toEqual(["1. Wall", "3. Vacuole"]);
	});

	it("keeps the colour and size the person gave a marker's number", () => {
		const { page, history } = three();
		const m = markerSets(page).get("pic-1")!.markers[2]!;
		page.elements![page.elements!.indexOf(m.text)] = { ...m.text, color: "#112233", fontSize: 15 };
		removeMarker(page, 1);
		const plan = planRenumber(page, markerSets(page).get("pic-1")!);
		if (!plan.ok) throw new Error(plan.reason);
		history.execute(plan.cmd);
		const last = markerSets(page).get("pic-1")!.markers.find((x) => x.number === 2)!;
		expect(last.text.color).toBe("#112233");
		expect(last.text.fontSize).toBe(15);
	});
});

describe("steps of markers in the history (#247)", () => {
	it("every insert and renumber is one step on one page, classified for per-page undo", () => {
		const { page, picture } = setup();
		const plan = planAddMarker(page, figure(page, picture), opts);
		if (!plan.ok) throw new Error(plan.reason);
		const scope = computeScope(plan.cmd);
		expect(scope.local).toBe(true);
		expect(scope.all).toBe(false);
		expect([...scope.pages]).toEqual([page.id]);
		expect(pageRules.scope(plan.cmd).local).toBe(true);
	});

	it("a renumber step is page-local too", () => {
		const { page, history, picture } = setup();
		for (let i = 0; i < 2; i++) add(page, history, figure(page, picture));
		const m = markerSets(page).get("pic-1")!.markers[0]!;
		page.strokes.splice(page.strokes.indexOf(m.circle), 1);
		page.elements!.splice(page.elements!.indexOf(m.text), 1);
		const plan = planRenumber(page, markerSets(page).get("pic-1")!);
		if (!plan.ok) throw new Error(plan.reason);
		expect(computeScope(plan.cmd).local).toBe(true);
	});
});

describe("copies of markers (#247)", () => {
	it("a duplicated page shows the same numbers and legend, linked to nothing of the original", () => {
		const { page, history, picture } = setup();
		for (let i = 0; i < 3; i++) add(page, history, figure(page, picture));
		const copy = duplicatePage(page);
		// every group got a fresh id, so the copy is a picture: no set of ours is found in it, and the original is untouched
		expect(markerSets(copy).size).toBe(0);
		expect(markerSets(page).get("pic-1")!.markers).toHaveLength(3);
		const shown = texts(copy).map((t) => t.text).sort();
		expect(shown).toEqual(texts(page).map((t) => t.text).sort());
		// changing the original does not reach the copy
		const m = markerSets(page).get("pic-1")!.markers[0]!;
		page.strokes.splice(page.strokes.indexOf(m.circle), 1);
		page.elements!.splice(page.elements!.indexOf(m.text), 1);
		expect(texts(copy).some((t) => t.text === "1")).toBe(true);
		// the groups of the copy are whole (a marker is still circle + number) and none looks like ours
		for (const t of texts(copy)) expect(parseMarkerGroup(t.group)).toBeNull();
	});

	it("a damaged group is not a marker", () => {
		const { page, history, picture } = setup();
		add(page, history, figure(page, picture));
		const m = markerSets(page).get("pic-1")!.markers[0]!;
		page.elements![page.elements!.indexOf(m.text)] = { ...m.text, text: "hello" };
		expect(markerSets(page).get("pic-1")?.markers ?? []).toHaveLength(0);
		const stroke: Stroke = m.circle;
		expect(stroke.group).toBe(m.group);
	});
});
