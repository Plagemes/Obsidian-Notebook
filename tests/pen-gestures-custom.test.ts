import { describe, expect, it } from "vitest";
import { buildCustomGesture, matchCustom, parseCustomGestures, CUSTOM_MIN_SCORE, type CustomGesture } from "../src/ink/gestures/custom";
import { normalise, rankTemplates, similarity } from "../src/ink/gestures/dollar";
import { arc, poly } from "../src/ink/gestures/glyphs";
import { looksBuiltIn, recognise } from "../src/ink/gestures/resolve";
import { draw, world } from "./gesture-fixtures";

// Two user-made gestures that are not built in: a "Z" and a wide "S"-like wave... and a lightning bolt.
const Z = () => poly([[0, 0], [1.4, 0], [0, 1.4], [1.4, 1.4]], 14);
const BOLT = () => poly([[0.6, 0], [0, 1], [0.7, 1], [0.1, 2.2]], 12);
const WAVE = () => arc(0, 0, 0.5, 180, 540, 30).map((p, i) => ({ x: i * 0.06, y: p.y }));

const samples = (make: () => ReturnType<typeof Z>, seeds = [1, 2, 3], size = 60) =>
	seeds.map((seed, i) => draw(make(), { size: size + i * 6, jitter: 1.2, seed, x: 100 + i * 30, y: 150 }));

function record(id: string, make: () => ReturnType<typeof Z>, command = "app:go-back"): CustomGesture {
	const r = buildCustomGesture(id, id, command, samples(make), looksBuiltIn);
	if (!("gesture" in r)) throw new Error(`could not record ${id}: ${r.error}`);
	return r.gesture;
}

describe("recording a custom gesture", () => {
	it("takes exactly three consistent samples and keeps normalised templates", () => {
		const r = buildCustomGesture("g1", "Z", "app:go-back", samples(Z), looksBuiltIn);
		expect("gesture" in r && r.gesture.samples).toHaveLength(3);
		expect("gesture" in r && r.gesture.samples[0]).toHaveLength(48);
		expect(buildCustomGesture("g1", "Z", "x", samples(Z).slice(0, 2))).toEqual({ error: "samples" });
		expect(buildCustomGesture("g1", "Z", "x", [...samples(Z), samples(Z)[0]!])).toEqual({ error: "samples" });
	});
	it("refuses samples that are too small or do not look alike", () => {
		const tiny = [1, 2, 3].map((s) => draw(Z(), { size: 6, seed: s }));
		expect(buildCustomGesture("g", "t", "x", tiny)).toEqual({ error: "short" });
		const mixed = [draw(Z(), { size: 60 }), draw(BOLT(), { size: 60 }), draw(WAVE(), { size: 60 })];
		expect(buildCustomGesture("g", "t", "x", mixed)).toEqual({ error: "inconsistent" });
	});
	it("refuses a gesture that is a built-in one", () => {
		const circle = [1, 2, 3].map((s) => draw(arc(0, 0, 1, -100, 270, 48), { size: 70, seed: s, jitter: 1 }));
		expect(buildCustomGesture("g", "c", "x", circle, looksBuiltIn)).toEqual({ error: "builtin" });
	});
});

describe("matching custom gestures", () => {
	const z = record("z", Z);
	const bolt = record("bolt", BOLT, "editor:toggle-bold");
	it("recognises each gesture drawn again, at another size and place, and ignores the rest", () => {
		for (const seed of [11, 12, 13]) {
			expect(matchCustom(draw(Z(), { size: 80, x: 300, y: 260, jitter: 1.5, seed }), [z, bolt])?.gesture.id).toBe("z");
			expect(matchCustom(draw(BOLT(), { size: 45, x: 50, y: 400, jitter: 1, seed }), [z, bolt])?.gesture.id).toBe("bolt");
		}
		expect(matchCustom(draw(WAVE(), { size: 60 }), [z, bolt])).toBeNull();
	});
	it("a disabled gesture never matches; so does a stroke that is too small", () => {
		expect(matchCustom(draw(Z(), { size: 60 }), [{ ...z, enabled: false }])).toBeNull();
		expect(matchCustom(draw(Z(), { size: 4 }), [z])).toBeNull();
	});
	it("is rotation-tolerant only by a few degrees: an N does not become a Z", () => {
		const N = () => poly([[0, 1.4], [0, 0], [1.4, 1.4], [1.4, 0]], 14);
		expect(matchCustom(draw(N(), { size: 60, jitter: 1 }), [z])).toBeNull();
		expect(matchCustom(draw(Z(), { size: 60, rotate: 0.12, jitter: 1 }), [z])?.gesture.id).toBe("z");
		expect(matchCustom(draw(Z(), { size: 60, rotate: 1.2 }), [z])).toBeNull();
	});
	it("two gestures that are too alike are never guessed between", () => {
		const a = record("a", Z);
		const b = { ...record("b", Z), id: "b" };
		expect(matchCustom(draw(Z(), { size: 60, seed: 9 }), [a, b])).toBeNull();
	});
	it("built-in gestures win, and a custom one runs when no built-in applies", () => {
		const stroke = draw(Z(), { size: 60 });
		expect(recognise(stroke, { world: world(), disabled: new Set(), custom: [z] })).toMatchObject({ type: "custom", gesture: { id: "z" } });
		expect(recognise(draw(WAVE(), { size: 60 }), { world: world(), disabled: new Set(), custom: [z] })).toEqual({ type: "none" });
	});
});

describe("template matcher", () => {
	it("scores a path against itself as 1 and a different shape much lower", () => {
		const a = normalise(draw(Z(), { size: 60 }))!;
		expect(similarity(a, a)).toBeCloseTo(1, 2);
		expect(similarity(a, normalise(draw(WAVE(), { size: 60 }))!)).toBeLessThan(0.75);
		expect(rankTemplates(draw(Z(), { size: 50 }), [{ name: "z", points: a }])[0]!.score).toBeGreaterThan(CUSTOM_MIN_SCORE);
	});
	it("a straight line is not stretched into a square", () => {
		const h = normalise(draw(poly([[0, 0], [2, 0]], 10), { size: 60 }))!;
		const v = normalise(draw(poly([[0, 0], [0, 2]], 10), { size: 60 }))!;
		expect(similarity(h, v)).toBeLessThan(0.6);
	});
});

describe("saved custom gestures", () => {
	it("round-trip and malformed ones are dropped", () => {
		const z = record("z", Z);
		const parsed = parseCustomGestures(JSON.parse(JSON.stringify([z, { id: "bad", name: "x", command: "c", samples: [[[0, 0]]] }, 5, null, { ...z, id: "z" }])));
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.id).toBe("z");
		expect(parseCustomGestures("nope")).toEqual([]);
		expect(parseCustomGestures([{ ...z, command: "" }])).toEqual([]);
		expect(parseCustomGestures([{ ...z, samples: [z.samples[0]!.map(([x]) => [x, 99])] }])).toEqual([]);
	});
});
