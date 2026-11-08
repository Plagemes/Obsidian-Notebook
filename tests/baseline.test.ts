import { describe, expect, it } from "vitest";
import { analyseBaseline, BASELINE_RULES, planBaseline, ruledLines, weightedMedian, wordBaseline } from "../src/ink/baseline";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { AddStroke, History } from "../src/model/history";
import { pageTimes } from "../src/model/page-times";
import { freezeElement, freezeStroke, parse, serialize } from "../src/model/serialize";
import { createSticky } from "../src/model/sticky";
import { PAPER_SPACING, RENDER_INK, type BoxElement, type Page, type Point, type Stroke } from "../src/model/types";

/** Synthetic handwriting: x-height 10 pt, ascenders 20 pt, descenders 8 pt below the baseline, letters 9 pt apart, pen 1.5 pt. */
const XH = 10;
const ASC = 20;
const DESC = 8;
const ADVANCE = 9;
const WORD_GAP = 14;
const PEN = 1.5;

let seq = 0;
function stroke(points: Point[], over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#111111", PEN, points, "pen", RENDER_INK), id: `b${++seq}`, ...over });
}
const pt = (x: number, y: number): Point => quantizePoint(x, y, 0.5);
function line(a: [number, number], b: [number, number], n = 12): Point[] {
	return Array.from({ length: n + 1 }, (_, i) => pt(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n));
}
/** A loop that starts and ends at its lowest point. */
function loop(cx: number, cy: number, rx: number, ry: number, n = 28): Point[] {
	return Array.from({ length: n + 1 }, (_, i) => {
		const a = Math.PI / 2 + (i / n) * 2 * Math.PI;
		return pt(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
	});
}

/** The strokes of one letter whose left edge is `x` and whose baseline is `base`. */
function letter(ch: string, x: number, base: number): Stroke[] {
	if ("gypqj".includes(ch)) {
		return [
			stroke(loop(x + 3.5, base - XH / 2, 3.5, XH / 2)),
			stroke([...line([x + 7, base - XH], [x + 7, base + DESC]), ...line([x + 7, base + DESC], [x + 3, base + DESC + 1], 4)]),
		];
	}
	if ("hbdk".includes(ch)) return [stroke(line([x + 1, base - ASC], [x + 1, base])), stroke(loop(x + 4.5, base - XH / 2, 3.5, XH / 2))];
	if ("lft".includes(ch)) return [stroke(line([x + 1, base - ASC], [x + 1, base])), ...(ch === "l" ? [] : [stroke(line([x - 2, base - XH], [x + 5, base - XH], 6))])];
	if (ch === "i") return [stroke(line([x + 1, base - XH], [x + 1, base], 8)), stroke([pt(x + 1, base - XH - 5), pt(x + 1.2, base - XH - 4.6), pt(x + 1, base - XH - 4.3)])];
	if (ch === "T") return [stroke(line([x + 4, base - ASC], [x + 4, base])), stroke(line([x, base - ASC], [x + 8, base - ASC], 6))];
	if (ch === ".") return [stroke([pt(x + 1, base - 1), pt(x + 1.4, base - 0.6), pt(x + 1, base - 0.2)])];
	if (ch === ",") return [stroke(line([x + 1, base - 1], [x, base + 3], 4))];
	return [stroke(loop(x + 3.5, base - XH / 2, 3.5, XH / 2))];
}

/** A word whose baseline is `base`, starting at `x`. Returns the strokes and the x where it ends. */
function word(text: string, x: number, base: number): { strokes: Stroke[]; end: number } {
	const strokes: Stroke[] = [];
	let at = x;
	for (const ch of text) {
		strokes.push(...letter(ch, at, base));
		at += "iltfjr.,".includes(ch) ? 5 : ADVANCE;
	}
	return { strokes, end: at };
}

/** A line of words with the baselines `bases` (one per word); the true baseline of each word is returned with its strokes. */
function sentence(words: string[], bases: number[] | ((x: number, i: number) => number), x0 = 60): Array<{ text: string; strokes: Stroke[]; base: number }> {
	let x = x0;
	return words.map((text, i) => {
		const base = typeof bases === "function" ? bases(x, i) : bases[i]!;
		const w = word(text, x, base);
		x = w.end + WORD_GAP;
		return { text, strokes: w.strokes, base };
	});
}

function pageWith(strokes: readonly Stroke[], paper = createPage().paper): Page {
	const page = createPage(undefined, paper);
	page.strokes.push(...strokes);
	return page;
}

/** The true baseline of a word after a plan: its original baseline plus the shift its strokes got. */
function shiftOf(before: Stroke[], after: ReadonlyMap<Stroke, Stroke>): number {
	const a = before[0]!;
	const b = after.get(a) ?? a;
	return b.points[0]![1] - a.points[0]![1];
}

describe("the baseline of a word", () => {
	const S = 14;
	it("is where the letters sit, whatever the ascenders and descenders do", () => {
		for (const text of ["hello", "the", "Tea", "ill", "zoo", "pig", "happy", "jumping", "gag", "type", "queue"]) {
			const w = word(text, 50, 200);
			const est = wordBaseline(w.strokes, S);
			expect(Math.abs(est - 200), `${text}: ${est}`).toBeLessThanOrEqual(2.2);
		}
	});

	it("is not moved by a horizontal bar (the bar of a T or an f) or by an i dot", () => {
		const t = word("Ti", 10, 100);
		expect(Math.abs(wordBaseline(t.strokes, S) - 100)).toBeLessThanOrEqual(2.2);
		const flatTop = [stroke(line([10, 80], [60, 80], 20)), stroke(line([35, 80], [35, 100]))];
		expect(Math.abs(wordBaseline(flatTop, S) - 100)).toBeLessThanOrEqual(2.2);
	});

	it("is the bottom of a stroke that is flat or a dot", () => {
		expect(wordBaseline([stroke(line([0, 50], [40, 50]))], S)).toBe(50);
		expect(wordBaseline([stroke([pt(5, 70)])], S)).toBe(70);
		expect(wordBaseline([], S)).toBe(0);
	});

	it("tells the baseline of a single p from the bottom of its tail", () => {
		const est = wordBaseline(letter("p", 10, 100), S);
		expect(est).toBeLessThan(100 + 3);
		expect(est).toBeGreaterThan(100 - 3);
	});

	it("is translation invariant, so a second run finds nothing to do", () => {
		const w = word("quick", 10, 100);
		const moved = w.strokes.map((s) => freezeStroke({ ...s, points: s.points.map(([x, y, p]) => [x, y + 37.3, p] as Point) }));
		expect(wordBaseline(moved, S) - wordBaseline(w.strokes, S)).toBeCloseTo(37.3, 0);
	});
});

describe("weighted median", () => {
	it("is the middle by weight, the mean of two equal halves, and plain when there are no weights", () => {
		expect(weightedMedian([1, 2, 10], [1, 1, 1])).toBe(2);
		expect(weightedMedian([1, 5], [1, 1])).toBe(3);
		expect(weightedMedian([1, 2, 10], [1, 1, 9])).toBe(10);
		expect(weightedMedian([4, 8, 6], [0, 0, 0])).toBe(6);
		expect(weightedMedian([], [])).toBe(0);
	});
});

describe("aligning one line of crooked words", () => {
	const WORDS = ["the", "quick", "brown", "fox", "jumps"];
	const WOBBLE = [0, 3, -3, 4, -2];

	it("puts every word on the same baseline (descenders included)", () => {
		const line1 = sentence(["happy", "gypsy", "pig", "jazz", "quay"], WOBBLE.map((d) => 200 + d));
		const page = pageWith(line1.flatMap((w) => w.strokes));
		const plan = planBaseline(page, page.strokes)!;
		expect(plan).not.toBeNull();
		const finals = line1.map((w) => w.base + shiftOf(w.strokes, plan.changes));
		const median = [...finals].sort((a, b) => a - b)[2]!;
		for (const f of finals) expect(Math.abs(f - median), finals.join(",")).toBeLessThanOrEqual(2.5);
		expect(plan.lines).toBe(1);
	});

	it("moves every word to the common baseline of the line, not to the first or the lowest", () => {
		const line1 = sentence(WORDS, WOBBLE.map((d) => 300 + d));
		const page = pageWith(line1.flatMap((w) => w.strokes));
		const a = analyseBaseline(page, page.strokes);
		expect(a.words).toBe(5);
		expect(a.lines).toBe(1);
		// The shift of each word undoes its wobble (the median wobble is 0): the target is the middle one.
		for (const m of a.moves) {
			const i = line1.findIndex((w) => w.strokes.includes(m.strokes[0]!));
			expect(Math.abs(m.dy + WOBBLE[i]!), `word ${i}`).toBeLessThanOrEqual(2.2);
		}
	});

	it("moves nothing in x, and only in y: the same points, pressure, width, id, style and order", () => {
		const line1 = sentence(WORDS, WOBBLE.map((d) => 300 + d));
		const marker = stroke(line([5, 5], [20, 5]), { color: "#ff0000" });
		const page = pageWith([marker, ...line1.flatMap((w) => w.strokes)]);
		const before = [...page.strokes];
		const plan = planBaseline(page, page.strokes)!;
		new History(() => ({ ...createDocument(), pages: [page] })).execute(plan.command);
		expect(page.strokes).toHaveLength(before.length);
		for (let i = 0; i < before.length; i++) {
			const b = before[i]!;
			const a = page.strokes[i]!;
			expect(a.id).toBe(b.id);
			expect(a.color).toBe(b.color);
			expect(a.width).toBe(b.width);
			expect(a.tool).toBe(b.tool);
			expect(a.points).toHaveLength(b.points.length);
			const dy = a.points[0]![1] - b.points[0]![1];
			a.points.forEach((p, k) => {
				expect(p[0]).toBe(b.points[k]![0]);
				expect(p[2]).toBe(b.points[k]![2]);
				expect(p[1] - b.points[k]![1]).toBeCloseTo(dy, 1);
			});
		}
		expect(page.strokes[0]).toBe(marker);
	});

	it("moves the dot of an i, a comma and a full stop with their word", () => {
		const words = sentence(["this", "is,", "it."], [300, 305, 296]);
		const page = pageWith(words.flatMap((w) => w.strokes));
		const plan = planBaseline(page, page.strokes)!;
		for (const w of words) {
			const shifts = w.strokes.map((s) => (plan.changes.get(s) ?? s).points[0]![1] - s.points[0]![1]);
			for (const sh of shifts) expect(sh).toBeCloseTo(shifts[0]!, 1);
		}
		// The i dot is a stroke of its own that moves exactly like the stem.
		const thisWord = words[0]!;
		expect(thisWord.strokes.length).toBe(7);
	});

	it("is idempotent: a second run on the aligned line finds nothing to move", () => {
		const line1 = sentence(WORDS, WOBBLE.map((d) => 300 + d));
		const page = pageWith(line1.flatMap((w) => w.strokes));
		const plan = planBaseline(page, page.strokes)!;
		new History(() => ({ ...createDocument(), pages: [page] })).execute(plan.command);
		expect(planBaseline(page, page.strokes)).toBeNull();
		expect(planBaseline(page, plan.strokes)).toBeNull();
	});

	it("does nothing to a line that is already straight, and to a single word", () => {
		const straight = sentence(WORDS, [300, 300, 300, 300, 300]);
		const page = pageWith(straight.flatMap((w) => w.strokes));
		expect(planBaseline(page, page.strokes)).toBeNull();
		const one = pageWith(word("hello", 40, 100).strokes);
		expect(planBaseline(one, one.strokes)).toBeNull();
	});

	it("leaves a word alone that is more than a couple of writing heights from the line", () => {
		const line1 = sentence(["abc", "def", "ghi"], [300, 301, 300]);
		const far = word("xyz", 200, 300 + 60);
		const page = pageWith([...line1.flatMap((w) => w.strokes), ...far.strokes]);
		const a = analyseBaseline(page, page.strokes);
		expect(a.moves.every((m) => !m.strokes.includes(far.strokes[0]!))).toBe(true);
	});

	it("only moves the words that are asked for", () => {
		const line1 = sentence(WORDS, WOBBLE.map((d) => 300 + d));
		const page = pageWith(line1.flatMap((w) => w.strokes));
		const asked = line1.slice(1).flatMap((w) => w.strokes);
		const a = analyseBaseline(page, asked);
		expect(a.words).toBe(4);
		for (const m of a.moves) for (const s of m.strokes) expect(line1[0]!.strokes).not.toContain(s);
	});
});

describe("aligning several lines", () => {
	it("keeps the lines apart: every word goes to its own line's baseline, never to the next line", () => {
		const pitch = 42;
		const rows = [0, 1, 2].map((r) => sentence(["pack", "my", "box", "with", "five", "dozen"], [0, 3, -3, 4, -2, 3].map((d) => 200 + r * pitch + d)));
		const page = pageWith(rows.flatMap((row) => row.flatMap((w) => w.strokes)));
		const plan = planBaseline(page, page.strokes)!;
		expect(plan.lines).toBe(3);
		rows.forEach((row, r) => {
			const finals = row.map((w) => w.base + shiftOf(w.strokes, plan.changes));
			const mid = [...finals].sort((a, b) => a - b)[2]!;
			expect(Math.abs(mid - (200 + r * pitch)), `row ${r}`).toBeLessThanOrEqual(6);
			for (const f of finals) expect(Math.abs(f - mid), `row ${r}: ${finals.join(",")}`).toBeLessThanOrEqual(2.5);
		});
	});

	it("works with the lines close together (a descender nearly touching the next line)", () => {
		const rows = [0, 1].map((r) => sentence(["gypsy", "jump", "quiz"], [0, 4, -3].map((d) => 200 + r * 32 + d)));
		const page = pageWith(rows.flatMap((row) => row.flatMap((w) => w.strokes)));
		const a = analyseBaseline(page, page.strokes);
		expect(a.lines).toBe(2);
		expect(a.words).toBe(6);
	});
});

describe("what is not handwriting", () => {
	it("leaves an underline, a drawing, a highlighter and a shape where they are", () => {
		const row = sentence(["one", "two", "three"], [300, 306, 297]);
		const under = stroke(line([40, 322], [200, 322], 30));
		const circle = stroke(loop(400, 400, 90, 90, 60));
		const hl = stroke(line([40, 290], [200, 290], 20), { tool: "highlighter" });
		const box = stroke(line([300, 300], [330, 300], 5), { tool: "shape" });
		const page = pageWith([...row.flatMap((w) => w.strokes), under, circle, hl, box]);
		const a = analyseBaseline(page, page.strokes);
		const moved = new Set(a.moves.flatMap((m) => m.strokes));
		for (const s of [under, circle, hl, box]) expect(moved.has(s)).toBe(false);
		expect(a.words).toBe(3);
		expect(a.skipped).toBeGreaterThanOrEqual(4);
	});

	it("leaves a lone dot and a lone dash alone", () => {
		const dot = stroke([pt(500, 500), pt(500.4, 500.2), pt(500, 500.5)]);
		const dash = stroke(line([100, 650], [108, 650], 4));
		const page = pageWith([dot, dash]);
		expect(planBaseline(page, page.strokes)).toBeNull();
	});

	it("takes the size of the writing from the writing: a big hand and a small hand both work", () => {
		for (const k of [0.6, 1, 2]) {
			const scale = (s: Stroke): Stroke => freezeStroke({ ...s, points: s.points.map(([x, y, p]) => [x * k, y * k, p] as Point), width: PEN * k });
			const row = sentence(["the", "quick", "brown", "fox"], [300, 305, 297, 304]);
			const strokes = row.flatMap((w) => w.strokes.map(scale));
			const page = pageWith(strokes);
			const a = analyseBaseline(page, strokes);
			expect(a.words, `scale ${k}`).toBe(4);
			expect(a.moves.length, `scale ${k}`).toBeGreaterThanOrEqual(3);
		}
	});
});

describe("groups, locks and pinned ink", () => {
	it("moves the strokes of one group together: a group that spans two words is one unit", () => {
		const row = sentence(["red", "fox", "ran", "far"], [300, 306, 296, 302]);
		for (const s of [...row[0]!.strokes, ...row[1]!.strokes]) {
			const i = row[0]!.strokes.indexOf(s);
			void i;
		}
		const grouped = row.flatMap((w, i) => (i < 2 ? w.strokes.map((s) => freezeStroke({ ...s, group: "g1" })) : w.strokes));
		const page = pageWith(grouped);
		const a = analyseBaseline(page, page.strokes);
		const gMove = a.moves.filter((m) => m.strokes.some((s) => s.group === "g1"));
		expect(gMove.length).toBeLessThanOrEqual(1);
		const gStrokes = grouped.filter((s) => s.group === "g1");
		for (const m of gMove) expect(new Set(m.strokes)).toEqual(new Set(gStrokes));
	});

	it("does not move a group that is not wholly asked for, or that holds a locked element", () => {
		const row = sentence(["red", "fox", "ran", "far"], [300, 306, 296, 302]);
		const grouped = row.map((w, i) => (i === 1 ? w.strokes.map((s) => freezeStroke({ ...s, group: "g2" })) : w.strokes));
		const page = pageWith(grouped.flat());
		// Only half of the group is asked for.
		const some = grouped[1]!.slice(0, 2);
		expect(analyseBaseline(page, [...grouped[0]!, ...some, ...grouped[2]!, ...grouped[3]!]).moves.some((m) => m.strokes.includes(some[0]!))).toBe(false);
		// Whole, but a locked element belongs to it.
		const locked: BoxElement = freezeElement({ id: "e1", type: "box", kind: "definition", x: 0, y: 700, width: 80, height: 40, group: "g2", locked: true, lockAt: 1 });
		page.elements = [locked];
		expect(analyseBaseline(page, page.strokes).moves.some((m) => m.strokes.includes(grouped[1]![0]!))).toBe(false);
		// The other words still align.
		expect(analyseBaseline(page, page.strokes).moves.length).toBeGreaterThan(0);
	});

	it("leaves the ink a collapsed sticky note keeps hidden alone, and ink bound to a graph", () => {
		const row = sentence(["red", "fox", "ran", "far"], [300, 306, 296, 302]);
		const page = pageWith(row.flatMap((w) => w.strokes));
		const hiddenWord = row[1]!;
		page.elements = [{ ...createSticky(500, 500, page), collapsed: true as const, ink: hiddenWord.strokes.map((s) => s.id) }];
		const a = analyseBaseline(page, page.strokes);
		const moved = new Set(a.moves.flatMap((m) => m.strokes));
		for (const s of hiddenWord.strokes) expect(moved.has(s)).toBe(false);
		const bound = word("axe", 300, 400).strokes.map((s) => freezeStroke({ ...s, id: `graph1~${s.id}` }));
		const p2 = pageWith([...row[0]!.strokes, ...row[2]!.strokes, ...row[3]!.strokes, ...bound]);
		const b = analyseBaseline(p2, p2.strokes);
		for (const m of b.moves) for (const s of m.strokes) expect(bound).not.toContain(s);
	});

	it("ignores invisible ink and strokes that are not on the page", () => {
		const row = sentence(["red", "fox", "ran"], [300, 306, 296]);
		const page = pageWith(row.flatMap((w) => w.strokes));
		const stray = word("abc", 500, 300).strokes;
		const a = analyseBaseline(page, [...page.strokes, ...stray]);
		for (const m of a.moves) for (const s of m.strokes) expect(stray).not.toContain(s);
		const ghost = word("xyz", 300, 330).strokes.map((s) => freezeStroke({ ...s, hidden: true as const }));
		const p2 = pageWith([...row.flatMap((w) => w.strokes), ...ghost]);
		const b = analyseBaseline(p2, p2.strokes);
		for (const m of b.moves) for (const s of m.strokes) expect(ghost).not.toContain(s);
	});
});

describe("ruled paper", () => {
	const spacing = PAPER_SPACING.ruled;
	const rule = (j: number) => j * spacing;

	it("lists the ruled lines like the paper draws them: from the third line on, inside the page", () => {
		const rules = ruledLines(createPage(undefined, { kind: "ruled", spacing }))!;
		expect(rules[0]).toBeCloseTo(3 * spacing, 6);
		expect(rules[rules.length - 1]!).toBeLessThan(createPage().height);
		expect(ruledLines(createPage(undefined, { kind: "grid", spacing }))).toBeNull();
		expect(ruledLines(createPage(undefined, { kind: "blank", spacing }))).toBeNull();
	});

	it("puts the words on the ruled line nearest to them, the ink sitting on it", () => {
		const target = rule(8);
		const row = sentence(["the", "quick", "brown", "fox", "jumps"], [4, -3, 2, -5, 3].map((d) => target + 2 + d));
		const page = pageWith(row.flatMap((w) => w.strokes), { kind: "ruled", spacing });
		const plan = planBaseline(page, page.strokes)!;
		expect(plan.ruled).toBe(true);
		for (const w of row) {
			const final = w.base + shiftOf(w.strokes, plan.changes);
			expect(Math.abs(final - (target - PEN / 2)), `${w.text}: ${final}`).toBeLessThanOrEqual(2.5);
		}
	});

	it("does not move a line to another ruled line when it is nearly on its own", () => {
		const target = rule(10);
		const row = sentence(["one", "two", "six"], [target + 4, target - 4, target + 3]);
		const page = pageWith(row.flatMap((w) => w.strokes), { kind: "ruled", spacing });
		const a = analyseBaseline(page, page.strokes);
		for (const m of a.moves) expect(Math.abs(m.dy)).toBeLessThan(spacing / 2 + 1);
	});

	it("a line that is straight but off the rule is brought onto the rule", () => {
		const target = rule(6);
		const row = sentence(["one", "two", "six"], [target + 6, target + 6, target + 6]);
		const page = pageWith(row.flatMap((w) => w.strokes), { kind: "ruled", spacing });
		const plan = planBaseline(page, page.strokes)!;
		expect(plan).not.toBeNull();
		for (const w of row) expect(Math.abs(w.base + shiftOf(w.strokes, plan.changes) - (target - PEN / 2))).toBeLessThanOrEqual(2.5);
		// On blank paper the same straight line stays.
		const blank = pageWith(row.flatMap((w) => w.strokes));
		expect(planBaseline(blank, blank.strokes)).toBeNull();
	});

	it("can be told not to snap to the rules", () => {
		const target = rule(8);
		const row = sentence(["the", "quick", "brown"], [target + 6, target + 10, target + 5]);
		const page = pageWith(row.flatMap((w) => w.strokes), { kind: "ruled", spacing });
		const free = planBaseline(page, page.strokes, { snapToRules: false })!;
		expect(free.ruled).toBe(false);
		const finals = row.map((w) => w.base + shiftOf(w.strokes, free.changes));
		expect(Math.max(...finals) - Math.min(...finals)).toBeLessThanOrEqual(2.5);
		expect(Math.abs(finals[0]! - (target - PEN / 2))).toBeGreaterThan(2.5);
	});
});

describe("a sloped line", () => {
	const slope = 0.06;
	const wobble = [0, 2, -2, 2, -1, 1];
	const sloped = (x: number, i: number): number => 300 + slope * (x - 60) + wobble[i]!;
	const words = ["the", "quick", "brown", "fox", "jumps", "over"];

	it("keeps its slope and loses only the wobble", () => {
		const row = sentence(words, sloped);
		const page = pageWith(row.flatMap((w) => w.strokes));
		const plan = planBaseline(page, page.strokes)!;
		expect(plan).not.toBeNull();
		const finals = row.map((w) => w.base + shiftOf(w.strokes, plan.changes));
		// The finals lie on one straight line: constant step between the words' x positions.
		const xs = row.map((w) => w.strokes[0]!.points[0]![0]);
		const fitSlope = (finals[finals.length - 1]! - finals[0]!) / (xs[xs.length - 1]! - xs[0]!);
		expect(fitSlope).toBeGreaterThan(0.04);
		finals.forEach((f, i) => expect(Math.abs(f - (finals[0]! + fitSlope * (xs[i]! - xs[0]!)))).toBeLessThanOrEqual(3));
	});

	it("can be levelled instead", () => {
		const row = sentence(words, sloped);
		const page = pageWith(row.flatMap((w) => w.strokes));
		const plan = planBaseline(page, page.strokes, { keepSlope: false })!;
		const finals = row.map((w) => w.base + shiftOf(w.strokes, plan.changes));
		expect(Math.max(...finals) - Math.min(...finals)).toBeLessThanOrEqual(2.5);
	});

	it("a wobbly level line is not mistaken for a slope", () => {
		const row = sentence(["the", "quick", "brown", "fox", "jumps"], [300, 305, 297, 304, 299]);
		const page = pageWith(row.flatMap((w) => w.strokes));
		const plan = planBaseline(page, page.strokes)!;
		const finals = row.map((w) => w.base + shiftOf(w.strokes, plan.changes));
		expect(Math.max(...finals) - Math.min(...finals)).toBeLessThanOrEqual(2.5);
		expect(BASELINE_RULES.slopeMinWords).toBeGreaterThanOrEqual(4);
	});
});

describe("one undo step, no stamps, saves cleanly", () => {
	function scene() {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const row = sentence(["the", "quick", "brown", "fox"], [300, 305, 297, 303]);
		page.strokes.push(...row.flatMap((w) => w.strokes));
		return { doc, page, row };
	}

	it("runs as one command and undoes as one, giving back the very same strokes", () => {
		const { doc, page } = scene();
		const before = [...page.strokes];
		const hist = new History(() => doc);
		const plan = planBaseline(page, page.strokes)!;
		expect(hist.execute(plan.command)).toBe(true);
		expect(page.strokes).toHaveLength(before.length);
		expect(page.strokes.some((s, i) => s !== before[i])).toBe(true);
		expect(plan.strokes).toEqual(page.strokes);
		hist.undo();
		expect(page.strokes.every((s, i) => s === before[i])).toBe(true);
		expect(hist.canUndo()).toBe(false);
		hist.redo();
		expect(page.strokes.some((s, i) => s !== before[i])).toBe(true);
	});

	it("does not move the page times: the ink is moved, not written now", () => {
		const { doc, page } = scene();
		const strokes = [...page.strokes];
		page.strokes.length = 0;
		const hist = new History(() => doc, 500, null, null, null, null, () => 1_800_000_000_000);
		strokes.forEach((s, i) => hist.execute(new AddStroke(page.id, s, i)));
		const times = JSON.stringify(pageTimes(page));
		const later = new History(() => doc, 500, null, null, null, null, () => 1_900_000_000_000);
		expect(later.execute(planBaseline(page, page.strokes)!.command)).toBe(true);
		expect(JSON.stringify(pageTimes(page))).toBe(times);
		later.undo();
		expect(JSON.stringify(pageTimes(page))).toBe(times);
	});

	it("the aligned page saves and reads back with the same ids and order", () => {
		const { doc, page } = scene();
		const ids = page.strokes.map((s) => s.id);
		new History(() => doc).execute(planBaseline(page, page.strokes)!.command);
		const parsed = parse(serialize(doc));
		if (!parsed.ok) throw new Error("did not read back");
		expect(parsed.doc.pages[0]!.strokes.map((s) => s.id)).toEqual(ids);
	});

	it("reports what it did: words moved, lines, and the strokes after", () => {
		const { page } = scene();
		const plan = planBaseline(page, page.strokes)!;
		expect(plan.words).toBeGreaterThanOrEqual(2);
		expect(plan.lines).toBe(1);
		expect(plan.strokes).toHaveLength(page.strokes.length);
		expect(plan.changes.size).toBeGreaterThan(0);
		expect(planBaseline(page, [])).toBeNull();
	});
});

describe("a whole page", () => {
	it("aligns a page of twenty crooked lines in reasonable time, each line to its own baseline", () => {
		const texts = ["pack", "my", "box", "with", "five", "dozen", "liquor", "jugs", "the", "quick", "fox"];
		let seed = 7;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
		const rows = Array.from({ length: 20 }, (_, r) => sentence(texts, texts.map(() => 90 + r * 36 + Math.round(rnd() * 3.5))));
		const page = pageWith(rows.flatMap((row) => row.flatMap((w) => w.strokes)));
		expect(page.strokes.length).toBeGreaterThan(400);
		const t0 = performance.now();
		const plan = planBaseline(page, page.strokes)!;
		expect(performance.now() - t0).toBeLessThan(1500);
		expect(plan.lines).toBeGreaterThanOrEqual(19);
		rows.forEach((row, r) => {
			const finals = row.map((w) => w.base + shiftOf(w.strokes, plan.changes));
			expect(Math.max(...finals) - Math.min(...finals), `row ${r}`).toBeLessThanOrEqual(3);
			expect(Math.abs(finals[5]! - (90 + r * 36)), `row ${r}`).toBeLessThanOrEqual(6);
		});
	});

	it("is not thrown by small jitter in the points", () => {
		let seed = 3;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
		const row = sentence(["hello", "there", "world", "again"], [300, 305, 297, 303]);
		const jittered = row.flatMap((w) => w.strokes.map((s) => freezeStroke({ ...s, points: s.points.map(([x, y, p]) => quantizePoint(x + rnd() * 0.4, y + rnd() * 0.4, p)) })));
		const page = pageWith(jittered);
		const plan = planBaseline(page, page.strokes)!;
		expect(plan).not.toBeNull();
		const finals = row.map((w, i) => {
			const first = jittered[row.slice(0, i).reduce((n, v) => n + v.strokes.length, 0)]!;
			return w.base + ((plan.changes.get(first) ?? first).points[0]![1] - first.points[0]![1]);
		});
		expect(Math.max(...finals) - Math.min(...finals)).toBeLessThanOrEqual(3);
	});
});
