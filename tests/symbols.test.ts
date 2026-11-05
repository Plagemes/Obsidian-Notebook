import { describe, expect, it } from "vitest";
import { captureClip } from "../src/ink/clipboard";
import { isSymbolSized, MAX_SYMBOL_SCALE, MIN_SYMBOL_SCALE, planGlyphPlacement, planSymbolPlacement, symbolLineHeight, symbolScale } from "../src/ink/symbols";
import { createDocument, createStroke } from "../src/model/document";
import { freezeStroke } from "../src/model/serialize";
import type { Point } from "../src/model/types";
import {
	clampSymbolCount, glyphId, normaliseSymbolUsage, personalId, rankSymbols, recordSymbolUse, SYMBOL_HALF_LIFE_MS, symbolScore, TYPO_SYMBOLS,
	type SymbolCandidate,
} from "../src/ui/symbol-rank";

const DAY = 24 * 3600 * 1000;
const glyphs: SymbolCandidate[] = TYPO_SYMBOLS.map((g) => ({ id: glyphId(g), kind: "glyph", label: g }));

describe("symbol ranking", () => {
	it("ids are valid usage ids and stable", () => {
		for (const c of glyphs) expect(c.id).toMatch(/^[a-z0-9-]{1,64}$/);
		expect(personalId("Sum")).toMatch(/^s-[0-9a-f]{8}$/);
		expect(personalId("Sum")).toBe(personalId(" sum".trim()));
		expect(personalId("a")).not.toBe(personalId("b"));
	});

	it("shows the designed order before anything is used", () => {
		expect(rankSymbols(glyphs, {}, 0, 4).map((c) => c.label)).toEqual(["∀", "∃", "∫", "→"]);
	});

	it("puts used symbols first, most used first", () => {
		let usage = {};
		const t0 = 1_000_000;
		for (let i = 0; i < 3; i++) usage = recordSymbolUse(usage, glyphId("≠"), t0);
		usage = recordSymbolUse(usage, glyphId("π"), t0);
		expect(rankSymbols(glyphs, usage, t0, 3).map((c) => c.label)).toEqual(["≠", "π", "∀"]);
	});

	it("a use counts half as much after the half-life, so a recent habit overtakes an old one", () => {
		const now = 100 * DAY;
		const old = { n: 4, last: now - 2 * SYMBOL_HALF_LIFE_MS };
		expect(symbolScore(old, now)).toBeCloseTo(1, 5);
		expect(symbolScore({ n: 4, last: now }, now)).toBe(4);
		const usage = { [glyphId("∫")]: old, [glyphId("→")]: { n: 2, last: now - DAY } };
		expect(rankSymbols(glyphs, usage, now, 2).map((c) => c.label)).toEqual(["→", "∫"]);
	});

	it("saved symbols come before the unused typographic ones, by name", () => {
		const mine: SymbolCandidate[] = [
			{ id: personalId("Zeta"), kind: "personal", label: "Zeta" },
			{ id: personalId("alpha"), kind: "personal", label: "alpha" },
		];
		expect(rankSymbols([...glyphs, ...mine], {}, 0, 3).map((c) => c.label)).toEqual(["alpha", "Zeta", "∀"]);
	});

	it("limits the list and stays bounded", () => {
		expect(rankSymbols(glyphs, {}, 0, 0)).toEqual([]);
		let usage = {};
		for (let i = 0; i < 200; i++) usage = recordSymbolUse(usage, `s-${i.toString(16).padStart(8, "0")}`, i);
		expect(Object.keys(usage).length).toBeLessThanOrEqual(80);
		expect(normaliseSymbolUsage("junk")).toEqual({});
		expect(normaliseSymbolUsage({ "bad id": { n: 3, last: 1 }, "g-41": { n: -2, last: 1 } })).toEqual({});
	});

	it("clamps the button count", () => {
		expect(clampSymbolCount(1)).toBe(3);
		expect(clampSymbolCount(99)).toBe(12);
		expect(clampSymbolCount("x")).toBe(6);
		expect(clampSymbolCount(7.4)).toBe(7);
	});
});

const pts = (...p: Array<[number, number]>): Point[] => p.map(([x, y]) => [x, y, 0.5]);

describe("symbol placement", () => {
	const doc = createDocument(new Date("2026-01-01T00:00:00Z"));
	const page = doc.pages[0]!;
	const a = freezeStroke(createStroke("#000000", 2, pts([0, 0], [40, 0], [40, 40]), "pen"));
	const b = freezeStroke(createStroke("#000000", 2, pts([0, 40], [40, 40]), "pen"));
	const clip = captureClip([a, b], [], undefined)!;
	const style = { color: "#ff0000", width: 3, textSize: 16 };

	it("scales to the line height within the limits", () => {
		expect(symbolScale({ minX: 0, minY: 0, maxX: 40, maxY: 40 }, 20)).toBe(0.5);
		expect(symbolScale({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 100)).toBe(MAX_SYMBOL_SCALE);
		expect(symbolScale({ minX: 0, minY: 0, maxX: 1000, maxY: 1 }, 10)).toBe(MIN_SYMBOL_SCALE);
		expect(symbolScale({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 10)).toBe(1);
		expect(symbolLineHeight(16)).toBe(20);
	});

	it("decides what is small enough to be a symbol", () => {
		expect(isSymbolSized(clip)).toBe(true);
		expect(isSymbolSized({ bounds: { minX: 0, minY: 0, maxX: 500, maxY: 10 } })).toBe(false);
		expect(isSymbolSized({ bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } })).toBe(false);
	});

	it("places a pen-sized copy with fresh ids, the pen's colour and width and one new group, as one undo step", () => {
		const plan = planSymbolPlacement(clip, doc, page, [100, 100], style)!;
		expect(plan.strokes).toHaveLength(2);
		const ids = new Set([a.id, b.id]);
		for (const s of plan.strokes) {
			expect(ids.has(s.id)).toBe(false);
			expect(s.color).toBe("#ff0000");
			expect(s.width).toBeCloseTo(3, 1);
		}
		const groups = new Set(plan.strokes.map((s) => s.group));
		expect(groups.size).toBe(1);
		expect([...groups][0]).toBeTruthy();
		const xs = plan.strokes.flatMap((s) => s.points.map((p) => p[0]));
		const ys = plan.strokes.flatMap((s) => s.points.map((p) => p[1]));
		const height = Math.max(...ys) - Math.min(...ys);
		expect(height).toBeGreaterThan(18);
		expect(height).toBeLessThanOrEqual(20);
		expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(100, 0);
		// two placements never share ids or a group
		const again = planSymbolPlacement(clip, doc, page, [100, 100], style)!;
		expect(again.strokes[0]!.id).not.toBe(plan.strokes[0]!.id);
		expect(again.strokes[0]!.group).not.toBe(plan.strokes[0]!.group);
		// undo / redo: one step
		const n = page.strokes.length;
		plan.command.apply(doc);
		expect(page.strokes.length).toBe(n + 2);
		plan.command.revert(doc);
		expect(page.strokes.length).toBe(n);
	});

	it("a single-stroke symbol gets no group", () => {
		const one = captureClip([a], [], undefined)!;
		const plan = planSymbolPlacement(one, doc, page, [60, 60], style)!;
		expect(plan.strokes[0]!.group).toBeUndefined();
	});

	it("places a typographic symbol as a text box near the spot", () => {
		const plan = planGlyphPlacement("∀", page, [200, 300], { color: "#112233", textSize: 18 })!;
		expect(plan.element.text).toBe("∀");
		expect(plan.element.color).toBe("#112233");
		expect(plan.element.fontSize).toBe(18);
		expect(Math.abs(plan.element.x + plan.element.width / 2 - 200)).toBeLessThan(2);
		expect(planGlyphPlacement("", page, [0, 0], { color: "#000", textSize: 18 })).toBeNull();
	});
});
