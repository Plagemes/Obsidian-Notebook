import { describe, expect, it } from "vitest";
import { dedupe, resample, pathLength, type TrailPoint } from "../src/ink/gestures/geometry";
import { isRetrace, matchCaret, matchCircle, matchHash, matchLine, matchStar } from "../src/ink/gestures/shapes";
import { matchQuestion } from "../src/ink/gestures/question";
import { recognise, looksBuiltIn, type RecogniseOptions } from "../src/ink/gestures/resolve";
import { DwellTracker, DWELL_MS, dwellMayStart, gestureStarts } from "../src/ink/gestures/trigger";
import { GestureTrail, PreviewClock } from "../src/ink/gestures/session";
import { DEFAULT_PEN_GESTURE_SETTINGS, readPenGestureSettings } from "../src/ink/gestures/settings";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { draw, inMs, SHAPES, WRITING, world } from "./gesture-fixtures";

const opts = (over: Partial<RecogniseOptions> = {}): RecogniseOptions => ({ world: world(), disabled: new Set(), custom: [], ...over });
const ink = { enclosedInk: () => 3 };

describe("circle", () => {
	it("a circle (and one that overshoots) matches, at any size, tilt or aspect, with hand tremor", () => {
		for (const [i, size] of [40, 60, 120, 240].entries()) {
			expect(matchCircle(draw(SHAPES.circle(), { size, jitter: size / 40, seed: i + 1 }))).not.toBeNull();
			expect(matchCircle(draw(SHAPES.circleOvershoot(), { size, jitter: size / 40, seed: i + 9 }))).not.toBeNull();
		}
		expect(matchCircle(draw(SHAPES.circle(), { size: 80, sx: 1.6, sy: 1, jitter: 1.5 }))).not.toBeNull();
		expect(matchCircle(draw(SHAPES.circle(), { size: 80, rotate: 0.7 }))).not.toBeNull();
	});
	it("selects only when ink is inside; an empty loop does nothing", () => {
		const loop = draw(SHAPES.circle(), { size: 80 });
		expect(recognise(loop, opts({ world: world(ink) }))).toMatchObject({ type: "builtin", id: "select" });
		expect(recognise(loop, opts())).toEqual({ type: "none" });
	});
	it("does not match a half circle, a spiral, a figure eight, a line or a tiny loop", () => {
		expect(matchCircle(draw(SHAPES.circle().slice(0, 20), { size: 80 }))).toBeNull();
		expect(matchCircle(draw(WRITING["8"]!(), { size: 60 }))).toBeNull();
		expect(matchCircle(draw(SHAPES.line(), { size: 40 }))).toBeNull();
		expect(matchCircle(draw(SHAPES.circle(), { size: 8 }))).toBeNull();
		const spiral = Array.from({ length: 160 }, (_, i) => ({ x: Math.cos(i / 10) * (4 + i / 4), y: Math.sin(i / 10) * (4 + i / 4) }));
		expect(matchCircle(draw(spiral, { size: 3 }))).toBeNull();
	});
});

describe("caret", () => {
	it("a caret matches, drawn either way round", () => {
		for (const [i, size] of [30, 50, 90].entries()) expect(matchCaret(draw(SHAPES.caret(), { size, jitter: size / 50, seed: i + 3 }))?.apex.y).toBeLessThan(200 + size * 0.4);
		expect(matchCaret(draw(SHAPES.caret().reverse(), { size: 50, jitter: 1 }))).not.toBeNull();
	});
	it("inserts space only on a page", () => {
		const c = draw(SHAPES.caret(), { size: 50 });
		expect(recognise(c, opts())).toMatchObject({ type: "builtin", id: "space" });
		expect(recognise(c, opts({ world: world({ onPage: () => false }) }))).toEqual({ type: "none" });
	});
	it("does not match an arch, a V, an n, an A, a 7, a 1 or a flat tick", () => {
		const V = draw(SHAPES.caret(), { size: 50, sy: -1 });
		expect(matchCaret(V)).toBeNull();
		for (const k of ["n", "A", "7", "v", "1", "check", "M", "w"]) expect(matchCaret(draw(WRITING[k]!(), { size: 50, jitter: 0.8 })), k).toBeNull();
	});
});

describe("hash", () => {
	it("a one-stroke # matches", () => {
		for (const [i, size] of [30, 50, 80].entries()) expect(matchHash(draw(SHAPES.hash(), { size, jitter: size / 60, seed: i + 5 })), String(size)).not.toBeNull();
	});
	it("does not match H, N, +, E, a zig-zag, a plain line or a wave", () => {
		for (const k of ["H", "N", "plus", "E", "zigzagWriting", "underline", "wave", "m", "w", "4", "8", "x"]) expect(matchHash(draw(WRITING[k]!(), { size: 50, jitter: 0.8 })), k).toBeNull();
	});
	it("opens the tag editor only on a page", () => {
		expect(recognise(draw(SHAPES.hash(), { size: 50 }), opts())).toMatchObject({ type: "builtin", id: "tag" });
	});
});

describe("star", () => {
	it("a five-pointed star drawn in one stroke matches", () => {
		for (const [i, size] of [40, 70, 120].entries()) expect(matchStar(draw(SHAPES.star(), { size, jitter: size / 60, seed: i + 2 }))).not.toBeNull();
		expect(matchStar(draw(SHAPES.star(), { size: 80, rotate: 0.4 }))).not.toBeNull();
	});
	it("does not match a circle, a hash, a zig-zag, a triangle or a caret", () => {
		expect(matchStar(draw(SHAPES.circle(), { size: 80 }))).toBeNull();
		expect(matchStar(draw(SHAPES.hash(), { size: 60 }))).toBeNull();
		expect(matchStar(draw(WRITING.zigzagWriting!(), { size: 60 }))).toBeNull();
		expect(matchStar(draw(SHAPES.caret(), { size: 60 }))).toBeNull();
		expect(matchStar(draw([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 0.9 }, { x: 0, y: 0 }], { size: 80 }))).toBeNull();
	});
	it("bookmarks the page under the star", () => {
		expect(recognise(draw(SHAPES.star(), { size: 70 }), opts())).toMatchObject({ type: "builtin", id: "bookmark" });
	});
});

describe("question mark", () => {
	it("a question mark (either hook) matches at several sizes and tilts", () => {
		for (const [i, size] of [30, 45, 70].entries()) {
			expect(matchQuestion(draw(SHAPES.question(), { size, jitter: size / 60, seed: i + 1 })), `q ${size}`).not.toBeNull();
			expect(matchQuestion(draw(SHAPES.questionOpen(), { size, jitter: size / 60, seed: i + 4 })), `qo ${size}`).not.toBeNull();
		}
		expect(matchQuestion(draw(SHAPES.question(), { size: 50, rotate: 0.12 }))).not.toBeNull();
	});
	it("does not match the digits and letters that look like it", () => {
		for (const k of ["2", "3", "5", "7", "9", "S", "J", "6", "1", "4", "8", "0", "a", "e", "l", "o", "z", "t", "check", "bracket"]) {
			expect(matchQuestion(draw(WRITING[k]!(), { size: 40, jitter: 0.6 })), k).toBeNull();
		}
	});
});

describe("line and arrow", () => {
	it("moves the selection to a thumbnail: needs the selection at the tail and a thumbnail at the tip", () => {
		const stroke = draw(SHAPES.arrow(), { x: 300, y: 300, size: 60 });
		const w = world({ onSelection: () => true, thumbnailAt: () => 4, selectionPage: () => 1 });
		expect(recognise(stroke, opts({ world: w }))).toMatchObject({ type: "builtin", id: "move", target: 4 });
		expect(recognise(draw(SHAPES.line(), { x: 300, y: 300, size: 60 }), opts({ world: w }))).toMatchObject({ id: "move", target: 4 });
		// No selection under the tail, no thumbnail, or the thumbnail of the page the selection is on: nothing.
		expect(recognise(stroke, opts({ world: world({ thumbnailAt: () => 4, selectionPage: () => 1 }) }))).toEqual({ type: "none" });
		expect(recognise(stroke, opts({ world: world({ onSelection: () => true }) }))).toEqual({ type: "none" });
		expect(recognise(stroke, opts({ world: world({ onSelection: () => true, thumbnailAt: () => 1, selectionPage: () => 1 }) }))).toEqual({ type: "none" });
	});
	it("a curve or a corner is not a line", () => {
		expect(matchLine(draw(SHAPES.circle().slice(0, 18), { size: 80 }))).toBeNull();
		expect(matchLine(draw(SHAPES.caret(), { size: 80 }))).toBeNull();
		expect(matchLine(draw(SHAPES.line(), { size: 10 }))).toBeNull();
	});
});

describe("scribble", () => {
	it("deletes when the world says the scribble crosses ink; with nothing under it, nothing happens", () => {
		const s = inMs(draw(SHAPES.scribble(), { size: 60 }), 500);
		expect(recognise(s, opts({ world: world({ scribbleVictims: () => 2 }) }))).toMatchObject({ type: "builtin", id: "delete" });
		expect(recognise(s, opts())).toEqual({ type: "none" });
	});
});

describe("cancel: moving back along the stroke", () => {
	it("out along a line and back to the start cancels", () => {
		const out = SHAPES.line();
		const back = [...out].reverse();
		const trail = draw([...out, ...back.slice(1)], { size: 50, jitter: 1 });
		expect(isRetrace(trail)).toBe(true);
		expect(recognise(trail, opts({ world: world({ ...ink }) }))).toEqual({ type: "cancel" });
	});
	it("going only most of the way back (past 30% of the line) does not cancel", () => {
		const out = draw(SHAPES.line(), { size: 50 });
		const backHalf = out.slice(Math.floor(out.length / 2)).reverse();
		expect(isRetrace([...out, ...backHalf])).toBe(false);
	});
	it("a loop, a scribble, a caret and a star are not cancels", () => {
		for (const k of ["circle", "scribble", "caret", "star", "hash", "question"] as const) expect(isRetrace(draw(SHAPES[k](), { size: 60 })), k).toBe(false);
	});
});

describe("no false positives on handwriting", () => {
	const strongWorld = world({ enclosedInk: () => 5, scribbleVictims: () => 0, onSelection: () => false });
	it("no letter, digit or doodle is a gesture on an empty page, whatever its size", () => {
		for (const [name, make] of Object.entries(WRITING)) {
			for (const size of [30, 55, 90]) {
				const r = recognise(draw(make(), { size, jitter: size / 80, seed: size }), opts());
				// The only shapes that may be gestures on an empty page are the ones that need no context; none of these is one.
				expect(r, `${name} @${size}`).toEqual({ type: "none" });
			}
		}
	});
	it("with ink around, only the round letters can become a selection", () => {
		const round = new Set(["o", "0", "a", "e"]);
		for (const [name, make] of Object.entries(WRITING)) {
			const r = recognise(draw(make(), { size: 55, jitter: 0.7 }), opts({ world: strongWorld }));
			if (r.type === "builtin") expect(round.has(name) && r.id === "select", `${name} became ${r.id}`).toBe(true);
			else expect(r.type, name).toBe("none");
		}
	});
	it("an arrow or line drawn as content is nothing without a selection and a thumbnail", () => {
		expect(recognise(draw(SHAPES.arrow(), { size: 70 }), opts())).toEqual({ type: "none" });
		expect(recognise(draw(WRITING.underline!(), { size: 70 }), opts())).toEqual({ type: "none" });
	});
	it("disabled gestures never fire", () => {
		const off = new Set(["select", "space", "tag", "bookmark", "search", "move", "delete"]);
		const w = world({ ...ink, onSelection: () => true, thumbnailAt: () => 2, selectionPage: () => 0 });
		const wd = world({ scribbleVictims: () => 2 });
		expect(recognise(draw(SHAPES.scribble(), { size: 70 }), opts({ world: wd, disabled: off }))).toEqual({ type: "none" });
		for (const k of ["circle", "caret", "hash", "star", "question", "arrow"] as const) {
			expect(recognise(draw(SHAPES[k](), { size: 70, x: 300, y: 300 }), opts({ world: w, disabled: off })), k).toEqual({ type: "none" });
		}
		expect(recognise(draw(SHAPES.caret(), { size: 70 }), opts({ world: w, disabled: new Set(["tag"]) }))).toMatchObject({ id: "space" });
	});
});

describe("when a gesture may start", () => {
	it("never during normal writing", () => {
		for (const pointerType of ["pen", "mouse", "touch"]) {
			expect(gestureStarts({ pointerType, eraser: false, buttonGesture: false, modeOn: false })).toBe(false);
		}
	});
	it("gesture mode or the side button start it for the pen and mouse, never for a finger or the eraser", () => {
		expect(gestureStarts({ pointerType: "pen", eraser: false, buttonGesture: false, modeOn: true })).toBe(true);
		expect(gestureStarts({ pointerType: "pen", eraser: false, buttonGesture: true, modeOn: false })).toBe(true);
		expect(gestureStarts({ pointerType: "mouse", eraser: false, buttonGesture: false, modeOn: true })).toBe(true);
		expect(gestureStarts({ pointerType: "touch", eraser: false, buttonGesture: false, modeOn: true })).toBe(false);
		expect(gestureStarts({ pointerType: "pen", eraser: true, buttonGesture: true, modeOn: true })).toBe(false);
	});
	it("the long press is off by default and never applies to the eraser, a finger, the button or gesture mode", () => {
		expect(DEFAULT_SETTINGS.penGestureLongPress).toBe(false);
		const base = { enabled: true, pointerType: "pen", eraser: false, held: false, modeOn: false, inking: true };
		expect(dwellMayStart(base)).toBe(true);
		expect(dwellMayStart({ ...base, enabled: false })).toBe(false);
		expect(dwellMayStart({ ...base, pointerType: "touch" })).toBe(false);
		expect(dwellMayStart({ ...base, eraser: true })).toBe(false);
		expect(dwellMayStart({ ...base, held: true })).toBe(false);
		expect(dwellMayStart({ ...base, inking: false })).toBe(false);
	});
	it("the rest counts from the first contact: a pause in the middle of writing never converts", () => {
		const d = new DwellTracker();
		d.begin(100, 100, 0);
		expect(d.ready(DWELL_MS - 1)).toBe(false);
		expect(d.ready(DWELL_MS)).toBe(true);
		const writing = new DwellTracker();
		writing.begin(100, 100, 0);
		writing.move(120, 104);
		writing.move(100, 100);
		expect(writing.ready(5000)).toBe(false);
		d.end();
		expect(d.ready(5000)).toBe(false);
	});
	it("the defaults open no gesture trigger", () => {
		expect(DEFAULT_SETTINGS.penSideButton).toBe("radial-eraser");
		expect(DEFAULT_PEN_GESTURE_SETTINGS.penGesturesOff).toEqual([]);
	});
});

describe("trail and preview clock", () => {
	it("keeps points apart, follows the tip, and limits its size", () => {
		const t = new GestureTrail();
		t.add(0, 0, 0);
		t.add(0.5, 0, 5);
		t.add(10, 0, 10);
		expect(t.points).toHaveLength(2);
		expect(t.tip).toMatchObject({ x: 10 });
		expect(t.durationMs).toBe(10);
		for (let i = 0; i < 3000; i++) t.add(i * 3, 0, i);
		expect(t.points.length).toBeLessThanOrEqual(1500);
	});
	it("recomputes only when the trail changed and enough time passed", () => {
		const c = new PreviewClock();
		expect(c.due(0, 1)).toBe(true);
		expect(c.due(10, 2)).toBe(false);
		expect(c.due(100, 2)).toBe(true);
		expect(c.due(300, 2)).toBe(false);
		expect(c.due(300, 2, true)).toBe(true);
	});
});

describe("settings", () => {
	it("parse and validate", () => {
		const s = readSettings({ penGesturesOff: ["tag", "bogus", "tag"], penGestureLongPress: true, penGestureSpacePt: 80 });
		expect(s.penGesturesOff).toEqual(["tag"]);
		expect(s.penGestureLongPress).toBe(true);
		expect(s.penGestureSpacePt).toBe(80);
		expect(readPenGestureSettings({ penGestureSpacePt: 5000, penGestureLongPress: "yes" })).toMatchObject({ penGestureSpacePt: 48, penGestureLongPress: false });
		expect(readSettings({}).penGesturesCustom).toEqual([]);
	});
});

describe("geometry", () => {
	it("resample and dedupe", () => {
		const r = resample([{ x: 0, y: 0 }, { x: 100, y: 0 }], 11);
		expect(r).toHaveLength(11);
		expect(r[5]!.x).toBeCloseTo(50);
		expect(pathLength(r)).toBeCloseTo(100);
		const pts: TrailPoint[] = [{ x: 0, y: 0, t: 0 }, { x: 0.2, y: 0, t: 1 }, { x: 5, y: 0, t: 2 }];
		expect(dedupe(pts, 1)).toHaveLength(2);
	});
	it("looksBuiltIn flags the shapes of the built-ins, not handwriting", () => {
		expect(looksBuiltIn(draw(SHAPES.circle(), { size: 80 }))).toBe(true);
		expect(looksBuiltIn(draw(SHAPES.star(), { size: 80 }))).toBe(true);
		expect(looksBuiltIn(draw(WRITING.w!(), { size: 80 }))).toBe(false);
	});
});
