import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";
import { ACTION_HELP } from "../src/ui/help-text";
import { ACTIONS, baseContext } from "../src/ui/actions";
import { contextBoost, forThisPage } from "../src/ui/context-rank";
import { buildSheet, contextBar } from "../src/ui/layout";
import { describe, expect, it } from "vitest";
import { analyseTidy, DEFAULT_TIDY_OPTIONS, normaliseTidyOptions, planTidy, TIDY_RULES, type TidyOptions } from "../src/ink/tidy";
import { strokeBounds } from "../src/ink/hit-test";
import { RULED_MARGIN_X } from "../src/ink/paper";
import { createArea } from "../src/model/area";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { AddStroke, History } from "../src/model/history";
import { describeCommand } from "../src/model/history-describe";
import { pageTimes } from "../src/model/page-times";
import { freezeElement, freezeStroke, parse, serialize } from "../src/model/serialize";
import { createSticky } from "../src/model/sticky";
import { PAPER_SPACING, RENDER_INK, type BoxElement, type Page, type Point, type Stroke } from "../src/model/types";

/** Synthetic handwriting: x-height 10 pt, ascenders 20 pt, descenders 8 pt below the baseline, letters 9 pt apart. */
const XH = 10;
const ASC = 20;
const DESC = 8;
const ADVANCE = 9;
const WORD_GAP = 14;

let seq = 0;
function stroke(points: Point[], over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#111111", 1.5, points, "pen", RENDER_INK), id: `t${++seq}`, ...over });
}
const pt = (x: number, y: number): Point => quantizePoint(x, y, 0.5);
function line(a: [number, number], b: [number, number], n = 12): Point[] {
	return Array.from({ length: n + 1 }, (_, i) => pt(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n));
}
function loop(cx: number, cy: number, rx: number, ry: number, n = 28): Point[] {
	return Array.from({ length: n + 1 }, (_, i) => {
		const a = Math.PI / 2 + (i / n) * 2 * Math.PI;
		return pt(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
	});
}
function letter(ch: string, x: number, base: number): Stroke[] {
	if ("gypqj".includes(ch)) return [stroke(loop(x + 3.5, base - XH / 2, 3.5, XH / 2)), stroke([...line([x + 7, base - XH], [x + 7, base + DESC]), ...line([x + 7, base + DESC], [x + 3, base + DESC + 1], 4)])];
	if ("hbdk".includes(ch)) return [stroke(line([x + 1, base - ASC], [x + 1, base])), stroke(loop(x + 4.5, base - XH / 2, 3.5, XH / 2))];
	if ("lft".includes(ch)) return [stroke(line([x + 1, base - ASC], [x + 1, base])), ...(ch === "l" ? [] : [stroke(line([x - 2, base - XH], [x + 5, base - XH], 6))])];
	if (ch === "i") return [stroke(line([x + 1, base - XH], [x + 1, base], 8)), stroke([pt(x + 1, base - XH - 5), pt(x + 1.2, base - XH - 4.6), pt(x + 1, base - XH - 4.3)])];
	return [stroke(loop(x + 3.5, base - XH / 2, 3.5, XH / 2))];
}
function word(text: string, x: number, base: number): { strokes: Stroke[]; end: number } {
	const strokes: Stroke[] = [];
	let at = x;
	for (const ch of text) {
		strokes.push(...letter(ch, at, base));
		at += "iltfjr".includes(ch) ? 5 : ADVANCE;
	}
	return { strokes, end: at };
}

const WORDS = ["the", "quick", "brown", "fox", "jumps"];
/** Ruled paper with the rules far enough apart for this (big) handwriting: the lines are 30 pt tall. */
const RULE_PT = 45;

/** One line of writing starting at x0; `wobble` shifts each word's baseline (crooked words). */
function row(base: number, x0 = 60, wobble: number[] = [0, 0, 0, 0, 0]): Stroke[] {
	const out: Stroke[] = [];
	let x = x0;
	WORDS.forEach((w, i) => {
		const made = word(w, x, base + wobble[i]!);
		out.push(...made.strokes);
		x = made.end + WORD_GAP;
	});
	return out;
}

function pageOf(strokes: readonly Stroke[], paper?: Page["paper"]): Page {
	const page = createPage(undefined, paper ?? { kind: "blank", spacing: PAPER_SPACING.blank });
	page.strokes.push(...strokes);
	return page;
}

/** The strokes of a row as they are after a plan. */
const after = (plan: { changes: ReadonlyMap<Stroke, Stroke> } | null, strokes: readonly Stroke[]): Stroke[] => strokes.map((s) => plan?.changes.get(s) ?? s);
function box(strokes: readonly Stroke[]): { minX: number; maxX: number; minY: number; maxY: number } {
	const b = strokes.map((s) => strokeBounds(s));
	return { minX: Math.min(...b.map((x) => x.minX)), maxX: Math.max(...b.map((x) => x.maxX)), minY: Math.min(...b.map((x) => x.minY)), maxY: Math.max(...b.map((x) => x.maxY)) };
}
const only = (key: keyof TidyOptions): TidyOptions => ({ baseline: false, margin: false, gaps: false, keepParagraphs: true, [key]: true });

/** Two paragraphs: three lines, a blank line, two lines. Lines start a little off one margin; the second paragraph is indented once. */
function twoParagraphs(): { page: Page; rows: Stroke[][] } {
	const bases = [100, 140, 180, 260, 300];
	const starts = [60, 66, 57, 62, 150];
	const rows = bases.map((b, i) => row(b, starts[i], i === 0 ? [0, 5, -4, 3, -3] : [0, 0, 0, 0, 0]));
	return { page: pageOf(rows.flat()), rows };
}

describe("tidy up: the pure analysis", () => {
	it("finds nothing on an empty page, on one stroke and on strokes that are not on the page", () => {
		const page = pageOf([]);
		expect(planTidy(page, { strokes: [], elements: [] })).toBeNull();
		const lone = stroke(line([10, 10], [60, 12]));
		expect(planTidy(pageOf([lone]), { strokes: [lone], elements: [] })).toBeNull();
		const stray = row(100);
		expect(analyseTidy(pageOf(row(300)), { strokes: stray, elements: [] }).moves.size).toBe(0);
	});

	it("straightens crooked words onto one baseline and does nothing more when only that is asked", () => {
		const { page, rows } = twoParagraphs();
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, only("baseline"))!;
		expect(plan.analysis.words).toBeGreaterThan(0);
		expect(plan.analysis.aligned).toBe(0);
		expect(plan.analysis.tightened).toBe(0);
		// Only the first (crooked) row moved, and only in y.
		for (const s of rows.slice(1).flat()) expect(plan.changes.has(s)).toBe(false);
		for (const [s, n] of plan.changes) expect(n.points.every((p, k) => p[0] === s.points[k]![0])).toBe(true);
	});

	it("brings the starts of the lines onto one margin and leaves an indent an indent", () => {
		const { page, rows } = twoParagraphs();
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, only("margin"))!;
		const lefts = rows.map((r) => box(after(plan, r)).minX);
		for (const x of lefts.slice(0, 4)) expect(Math.abs(x - lefts[0]!)).toBeLessThanOrEqual(0.6);
		// The indented line (it starts about 90 pt to the right) is where it was.
		expect(lefts[4]).toBeCloseTo(box(rows[4]!).minX, 1);
		expect(plan.analysis.aligned).toBeGreaterThanOrEqual(2);
		for (const [s, n] of plan.changes) expect(n.points.every((p, k) => p[1] === s.points[k]![1])).toBe(true);
	});

	it("closes an oversized gap to one blank line, keeps a paragraph break and never lets lines touch", () => {
		const bases = [100, 140, 180, 260, 300, 700, 740];
		const rows = bases.map((b) => row(b));
		const page = pageOf(rows.flat());
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, only("gaps"))!;
		const boxes = rows.map((r) => box(after(plan, r)));
		const before = rows.map((r) => box(r));
		// The paragraph break after the third line (one blank line) is untouched, the big hole before the sixth shrinks.
		expect(boxes[3]!.minY - boxes[2]!.maxY).toBeCloseTo(before[3]!.minY - before[2]!.maxY, 1);
		const hole = boxes[5]!.minY - boxes[4]!.maxY;
		expect(hole).toBeLessThan(before[5]!.minY - before[4]!.maxY - 200);
		// ... to about one blank line: the gap of an ordinary break.
		expect(Math.abs(hole - (before[3]!.minY - before[2]!.maxY))).toBeLessThan(25);
		for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.minY).toBeGreaterThan(boxes[i - 1]!.maxY);
		// The line that followed the hole keeps up with it.
		expect(boxes[6]!.minY - boxes[5]!.maxY).toBeCloseTo(before[6]!.minY - before[5]!.maxY, 1);
		expect(plan.analysis.tightened).toBe(1);
		expect(plan.analysis.saved).toBeGreaterThan(200);
		for (const [s, n] of plan.changes) expect(n.points.every((p, k) => p[0] === s.points[k]![0])).toBe(true);
	});

	it("with Keep paragraph breaks off, every gap closes to the ordinary line spacing", () => {
		const bases = [100, 140, 180, 260, 300];
		const rows = bases.map((b) => row(b));
		const page = pageOf(rows.flat());
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, { ...only("gaps"), keepParagraphs: false })!;
		const boxes = rows.map((r) => box(after(plan, r)));
		const g0 = boxes[1]!.minY - boxes[0]!.maxY;
		expect(Math.abs(boxes[3]!.minY - boxes[2]!.maxY - g0)).toBeLessThan(3);
		expect(planTidy(page, { strokes: page.strokes, elements: [] }, only("gaps"))).toBeNull();
	});

	it("does nothing the second time", () => {
		const { page } = twoParagraphs();
		page.strokes.push(...row(900), ...row(940, 70));
		const request = (): { strokes: Stroke[]; elements: never[] } => ({ strokes: page.strokes, elements: [] });
		const first = planTidy(page, request())!;
		expect(first.analysis.moves.size).toBeGreaterThan(0);
		page.strokes.splice(0, page.strokes.length, ...page.strokes.map((s) => first.changes.get(s) ?? s));
		const second = analyseTidy(page, request());
		expect(second.words).toBe(0);
		expect(second.aligned).toBe(0);
		expect(second.tightened).toBe(0);
		expect(second.moves.size).toBe(0);
	});

	it("on ruled paper puts the words on the rule, moves lines by whole rules and keeps one blank rule", () => {
		const sp = RULE_PT;
		const top = sp * 4;
		const rule = (n: number): number => top + n * sp;
		// Baselines a little off their rules; one blank rule after the first two; then five blank rules.
		const rows = [rule(0) + 3, rule(1) - 2, rule(2) + 4, rule(4) - 3, rule(5) + 2, rule(11) + 1].map((b, i) => row(b, 70 + (i % 2) * 5, i === 0 ? [0, 4, -3, 2, 0] : [0, 0, 0, 0, 0]));
		const page = pageOf(rows.flat(), { kind: "ruled", spacing: sp });
		const plan = planTidy(page, { strokes: page.strokes, elements: [] })!;
		expect(plan).not.toBeNull();
		const moved = rows.map((r) => box(after(plan, r)));
		// Every row but the first and the hole is shifted by a whole number of rules relative to the baseline step.
		const dys = rows.map((r, i) => after(plan, r)[0]!.points[0]![1] - r[0]!.points[0]![1] - 0 * i);
		expect(dys.some((d) => Math.abs(d) > 0.5)).toBe(true);
		// The rows after the hole sit a whole number of rules above where they were (their baselines were on rules).
		const lastShift = after(plan, rows[5]!)[0]!.points[0]![1] - rows[5]![0]!.points[0]![1];
		const fromRule = lastShift / sp;
		expect(Math.abs(fromRule - Math.round(fromRule)), `${lastShift}`).toBeLessThan(0.15);
		expect(lastShift).toBeLessThan(-2.5 * sp);
		// One blank rule is left between the last two paragraphs, and the margin is the one of the paper (or the common one).
		const lefts = moved.map((m) => m.minX);
		expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(0.6);
		expect(lefts[0]).toBeGreaterThan(RULED_MARGIN_X - 5);
		for (let i = 1; i < moved.length; i++) expect(moved[i]!.minY).toBeGreaterThan(moved[i - 1]!.maxY);
	});

	it("moves the starts onto the margin line of ruled paper when the writing is next to it", () => {
		const sp = RULE_PT;
		const x0 = RULED_MARGIN_X + 8;
		const rows = [0, 1, 2, 3].map((i) => row(sp * 4 + i * sp + 2, x0 + (i % 2) * 3));
		const page = pageOf(rows.flat(), { kind: "ruled", spacing: sp });
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, only("margin"))!;
		const lefts = rows.map((r) => box(after(plan, r)).minX);
		for (const x of lefts) expect(Math.abs(x - lefts[0]!)).toBeLessThanOrEqual(0.6);
		expect(lefts[0]).toBeGreaterThan(RULED_MARGIN_X);
		expect(lefts[0]).toBeLessThan(RULED_MARGIN_X + 20);
	});
});

describe("tidy up: what it leaves alone", () => {
	function build(): { page: Page; rows: Stroke[][] } {
		const rows = [100, 140, 180, 420, 460].map((b, i) => row(b, 60 + (i % 2) * 5));
		return { page: pageOf(rows.flat()), rows };
	}

	it("does not move a line that has a locked box in its way, and the lines below it keep their distance", () => {
		const { page, rows } = build();
		const locked: BoxElement = freezeElement({ id: "lock1", type: "box", kind: "definition", x: 40, y: 300, width: 300, height: 60, locked: true, lockAt: 1 });
		page.elements = [locked];
		const plan = planTidy(page, { strokes: page.strokes, elements: page.elements }, only("gaps"));
		const boxes = rows.map((r) => box(after(plan, r)));
		// The box stays; the line below it cannot sweep through it, so it stays too; nothing overlaps.
		expect(page.elements[0]).toBe(locked);
		expect(boxes[3]!.minY).toBeGreaterThan(300 + 60 - 1);
		for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.minY).toBeGreaterThan(boxes[i - 1]!.maxY);
		if (plan) for (const s of plan.changes.keys()) expect(rows.flat()).toContain(s);
	});

	it("closes the gap when nothing is in the way", () => {
		const { page, rows } = build();
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, only("gaps"))!;
		expect(box(after(plan, rows[3]!)).minY).toBeLessThan(box(rows[3]!).minY - 100);
	});

	it("does not move a line whose group holds a locked element, or a group that is not wholly asked for", () => {
		const { page, rows } = build();
		const grouped = rows[2]!.map((s) => freezeStroke({ ...s, group: "g1" }));
		page.strokes.splice(page.strokes.indexOf(rows[2]![0]!), rows[2]!.length, ...grouped);
		const locked: BoxElement = freezeElement({ id: "lock2", type: "box", kind: "definition", x: 600, y: 700, width: 60, height: 40, group: "g1", locked: true, lockAt: 1 });
		page.elements = [locked];
		const a = analyseTidy(page, { strokes: page.strokes, elements: page.elements }, only("margin"));
		for (const s of grouped) expect(a.moves.has(s)).toBe(false);
		// A group that reaches beyond its line (here: a shape drawn elsewhere belongs to it) is not torn apart either.
		const g2 = rows[1]!.map((s) => freezeStroke({ ...s, group: "g2" }));
		page.strokes.splice(page.strokes.indexOf(rows[1]![0]!), rows[1]!.length, ...g2);
		const shape = stroke(loop(500, 300, 20, 20), { tool: "shape", group: "g2" });
		page.strokes.push(shape);
		page.elements = [];
		const b = analyseTidy(page, { strokes: page.strokes, elements: [] }, only("margin"));
		for (const s of g2) expect(b.moves.has(s)).toBe(false);
	});

	it("leaves a line alone when an underline, a drawing or a shape lies on it", () => {
		const rows = [100, 140, 180, 420].map((b) => row(b, 60));
		const underline = stroke(line([55, 428], [300, 429], 30));
		const page = pageOf([...rows.flat(), underline]);
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, only("gaps"));
		const moved = new Set(plan?.changes.keys() ?? []);
		for (const s of rows[3]!) expect(moved.has(s)).toBe(false);
		expect(moved.has(underline)).toBe(false);
		// A shape stroke is not handwriting: never moved, and in the way like a drawing.
		const shape = stroke(loop(150, 300, 60, 40), { tool: "shape" });
		const p2 = pageOf([...[100, 140, 180, 420].map((b) => row(b, 60)).flat(), shape]);
		const plan2 = planTidy(p2, { strokes: p2.strokes, elements: [] }, only("gaps"));
		expect(plan2?.changes.has(shape) ?? false).toBe(false);
	});

	it("skips an area, ink a collapsed note keeps hidden, ink bound to a graph and the highlighter", () => {
		const rows = [100, 140, 180, 420].map((b) => row(b, 60));
		const hiddenWord = word("red", 300, 600);
		const bound = word("axe", 300, 650).strokes.map((s) => freezeStroke({ ...s, id: `graph1~${s.id}` }));
		const marker = stroke(line([60, 900], [400, 900], 20), { tool: "highlighter", width: 12 });
		const page = pageOf([...rows.flat(), ...hiddenWord.strokes, ...bound, marker]);
		const area = createArea([20, 20], [20 + 100, 20 + 30], page, "#ffd400")!;
		page.elements = [area, { ...createSticky(500, 800, page), collapsed: true as const, ink: hiddenWord.strokes.map((s) => s.id) }];
		const a = analyseTidy(page, { strokes: page.strokes, elements: page.elements });
		for (const s of [...hiddenWord.strokes, ...bound, marker]) expect(a.moves.has(s)).toBe(false);
		const plan = planTidy(page, { strokes: page.strokes, elements: page.elements })!;
		expect(page.elements[0]).toBe(area);
		expect(plan.command.label).toBe("Tidy up page");
	});

	it("never lets a line move up into another moving line it overlaps only a little horizontally (whatever the overlap)", () => {
		const stack = [100, 140, 180].map((b) => row(b, 60));
		const wide = box(stack[0]!);
		const below = row(420, 60);
		// A short line at the right end of the stack: it overlaps the lines above it by under 15 %, so it is not "below" them, and it sits where the
		// line below would end up. It is a line that moves (or stays) too: the two must not end on top of each other.
		const short = word("the", wide.maxX - 0.5, 260).strokes;
		const sb = box(short);
		expect((Math.min(sb.maxX, wide.maxX) - Math.max(sb.minX, wide.minX)) / (sb.maxX - sb.minX)).toBeLessThan(TIDY_RULES.overlapShare);
		const page = pageOf([...stack.flat(), ...short, ...below]);
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, only("gaps"));
		const lines = [...stack, short, below].map((r) => box(after(plan, r)));
		const overlap = (a: (typeof lines)[number], b: (typeof lines)[number]): number =>
			Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
		const before = [...stack, short, below].map((r) => box(r));
		for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) expect(overlap(lines[i]!, lines[j]!)).toBeLessThanOrEqual(overlap(before[i]!, before[j]!) + 0.01);
	});

	it("treats invisible ink and the ink of a collapsed note as in the way: a line never moves onto it", () => {
		const { page, rows } = build();
		// Where the line below would end up (a paragraph break under the last line).
		const secret = word("red", 60, 255).strokes.map((s) => freezeStroke({ ...s, hidden: true }));
		page.strokes.push(...secret);
		const plan = planTidy(page, { strokes: page.strokes, elements: [] }, only("gaps"));
		const moved = new Set(plan?.changes.keys() ?? []);
		for (const s of rows[3]!) expect(moved.has(s)).toBe(false);
		for (const s of secret) expect(moved.has(s)).toBe(false);
		// The same for the ink a collapsed note keeps hidden (it is not marked hidden itself).
		const { page: p2, rows: r2 } = build();
		const kept = word("red", 60, 255).strokes;
		p2.strokes.push(...kept);
		p2.elements = [{ ...createSticky(500, 800, p2), collapsed: true as const, ink: kept.map((s) => s.id) }];
		const plan2 = planTidy(p2, { strokes: p2.strokes, elements: [] }, only("gaps"));
		const moved2 = new Set(plan2?.changes.keys() ?? []);
		for (const s of r2[3]!) expect(moved2.has(s)).toBe(false);
		// Without the hidden ink the line does close up (a positive control).
		const free = build();
		const control = planTidy(free.page, { strokes: free.page.strokes, elements: [] }, only("gaps"))!;
		expect(box(after(control, free.rows[3]!)).minY).toBeLessThan(box(free.rows[3]!).minY - 100);
	});

	it("moves only what the selection asks for", () => {
		const { page, rows } = build();
		const chosen = [...rows[3]!, ...rows[4]!, ...rows[2]!];
		const plan = planTidy(page, { strokes: chosen, elements: [] }, only("gaps"))!;
		for (const s of plan.changes.keys()) expect(chosen).toContain(s);
		for (const s of [...rows[0]!, ...rows[1]!]) expect(plan.changes.has(s)).toBe(false);
	});

	it("reports a locked page and offers no step", () => {
		const { page } = twoParagraphs();
		page.locked = true;
		const a = analyseTidy(page, { strokes: page.strokes, elements: [] });
		expect(a.locked).toBe(true);
		expect(planTidy(page, { strokes: page.strokes, elements: [] })).toBeNull();
	});

	it("does nothing with every step switched off", () => {
		const { page } = twoParagraphs();
		expect(planTidy(page, { strokes: page.strokes, elements: [] }, { baseline: false, margin: false, gaps: false, keepParagraphs: true })).toBeNull();
	});
});

describe("tidy up: the history step", () => {
	function scene(): { doc: ReturnType<typeof createDocument>; page: Page; rows: Stroke[][] } {
		const doc = createDocument();
		const page = doc.pages[0]!;
		const rows = [100, 140, 180, 460, 500].map((b, i) => row(b, 60 + (i % 3) * 4, i === 0 ? [0, 5, -4, 3, -3] : [0, 0, 0, 0, 0]));
		page.strokes.push(...rows.flat());
		return { doc, page, rows };
	}

	it("is ONE undo step that gives back the very same strokes, and a redo does it again", () => {
		const { doc, page } = scene();
		const before = [...page.strokes];
		const hist = new History(() => doc);
		const plan = planTidy(page, { strokes: page.strokes, elements: [] })!;
		expect(hist.execute(plan.command)).toBe(true);
		expect(page.strokes).toHaveLength(before.length);
		expect(page.strokes.map((s) => s.id)).toEqual(before.map((s) => s.id));
		expect(page.strokes.some((s, i) => s !== before[i])).toBe(true);
		hist.undo();
		expect(page.strokes.every((s, i) => s === before[i])).toBe(true);
		expect(hist.canUndo()).toBe(false);
		hist.redo();
		expect(page.strokes.some((s, i) => s !== before[i])).toBe(true);
	});

	it("moves rigidly: same points count, pressure, width, colour and tool", () => {
		const { page } = scene();
		const plan = planTidy(page, { strokes: page.strokes, elements: [] })!;
		for (const [s, n] of plan.changes) {
			expect(n.points).toHaveLength(s.points.length);
			expect(n.points.every((p, k) => p[2] === s.points[k]![2])).toBe(true);
			expect(n.width).toBe(s.width);
			expect(n.color).toBe(s.color);
			expect(n.tool).toBe(s.tool);
			expect(n.id).toBe(s.id);
		}
	});

	it("does not move the page times and reads back with the same ids", () => {
		const { doc, page } = scene();
		const strokes = [...page.strokes];
		page.strokes.length = 0;
		const hist = new History(() => doc, 500, null, null, null, null, () => 1_800_000_000_000);
		strokes.forEach((s, i) => hist.execute(new AddStroke(page.id, s, i)));
		const times = JSON.stringify(pageTimes(page));
		const later = new History(() => doc, 500, null, null, null, null, () => 1_900_000_000_000);
		expect(later.execute(planTidy(page, { strokes: page.strokes, elements: [] })!.command)).toBe(true);
		expect(JSON.stringify(pageTimes(page))).toBe(times);
		later.undo();
		expect(JSON.stringify(pageTimes(page))).toBe(times);
		later.redo();
		const parsed = parse(serialize(doc));
		if (!parsed.ok) throw new Error("did not read back");
		expect(parsed.doc.pages[0]!.strokes.map((s) => s.id)).toEqual(strokes.map((s) => s.id));
	});

	it("is refused on a locked page", () => {
		const { doc, page } = scene();
		const plan = planTidy(page, { strokes: page.strokes, elements: [] })!;
		page.locked = true;
		const before = [...page.strokes];
		const refused: string[][] = [];
		const hist = new History(() => doc, 500, null, null, null, (ids) => refused.push([...ids]));
		expect(hist.execute(plan.command)).toBe(false);
		expect(page.strokes.every((s, i) => s === before[i])).toBe(true);
		expect(refused).toHaveLength(1);
	});

	it("has a title in the history panel", () => {
		const { page } = scene();
		const plan = planTidy(page, { strokes: page.strokes, elements: [] })!;
		expect(describeCommand(plan.command).key).toBe("histpanel.t.tidy");
	});
});

describe("remembered choices", () => {
	it("read back leniently", () => {
		expect(normaliseTidyOptions(null)).toEqual(DEFAULT_TIDY_OPTIONS);
		expect(normaliseTidyOptions({ baseline: false, margin: "yes", gaps: false })).toEqual({ baseline: false, margin: true, gaps: false, keepParagraphs: true });
		expect(normaliseTidyOptions("x")).toEqual(DEFAULT_TIDY_OPTIONS);
		expect(TIDY_RULES.minLineStrokes).toBeGreaterThan(0);
	});
});

describe("tidy up in the action registry", () => {
	const NOW = 1_800_000_000_000;
	const sel = (strokes: number) => baseContext({ tool: "lasso", selection: { strokes, elements: 0, images: 0 } });
	const page = (kind: "ruled" | "plain" | "pdf") => baseContext({ page: { index: 0, count: 1, background: kind === "pdf" ? "pdf" : "none", infinite: false, bookmarked: false, kind } });
	const find = (id: string) => ACTIONS.find((a) => a.id === id)!;
	const ids = (c: ReturnType<typeof baseContext>, kind: "all" | "page" = "all", query?: string): string[] =>
		buildSheet(c, { kind, usage: {}, now: NOW, label: (a) => a.id, ...(query ? { query } : {}) }).flatMap((s) => s.actions.map((a) => a.id));

	it("offers Tidy up from three strokes on, in the contextual bar of a wide screen and in the sheet", () => {
		expect(contextBar(sel(2), 800, {}, 0)!.second).not.toContain("selection-tidy");
		for (const width of [800, 1280]) expect(contextBar(sel(3), width, {}, 0)!.second, String(width)).toContain("selection-tidy");
		// A phone bar has five places, all kept by the older actions: the sheet has it.
		expect(contextBar(sel(5), 360, {}, 0)!.second).not.toContain("selection-tidy");
		expect(ids(sel(3))).toContain("selection-tidy");
		expect(ids(sel(2))).not.toContain("selection-tidy");
		expect(ids(baseContext())).not.toContain("selection-tidy");
	});

	it("offers Tidy up page in the page menu and the sheet, and in the palette with a command", () => {
		expect(ids(page("plain"), "page")).toContain("page-tidy");
		expect(ids(page("plain"))).toContain("page-tidy");
		const def = find("page-tidy");
		expect(def.command).toBe("command.tidyPage");
		expect(def.surfaces).toEqual(["page", "sheet"]);
		expect(find("selection-tidy").surfaces).toEqual(["context", "sheet"]);
	});

	it("has a help text, and every text in English and Italian", () => {
		expect(ACTION_HELP["selection-tidy"]).toBe("help.tidy");
		expect(ACTION_HELP["page-tidy"]).toBe("help.tidy");
		const keys = [
			"tidy.action", "tidy.pageAction", "command.tidyPage", "tidy.title", "tidy.scopeSelection", "tidy.scopePage", "tidy.step.baseline", "tidy.step.margin",
			"tidy.step.gaps", "tidy.step.keep", "tidy.keepHint", "tidy.count.words", "tidy.count.lines", "tidy.count.gaps", "tidy.count.none", "tidy.saves", "tidy.none",
			"tidy.locked", "tidy.preview", "tidy.apply", "tidy.done", "tidy.undoHint", "histpanel.t.tidy", "help.tidy",
		];
		for (const key of keys) {
			expect(enSrc, key).toContain(`"${key}"`);
			expect(itSrc, key).toContain(`"${key}"`);
		}
	});

	it("is ranked: a selection of many strokes, and a page of writing with nothing selected", () => {
		const a = find("selection-tidy");
		expect(contextBoost(a, sel(14))).toBeGreaterThan(contextBoost(a, sel(3)));
		expect(forThisPage(ACTIONS, sel(4), {}, NOW, new Set(), 100).map((x) => x.id)).toContain("selection-tidy");
		const p = find("page-tidy");
		expect(contextBoost(p, page("ruled"))).toBeGreaterThanOrEqual(20);
		// Plain paper leans forward in the page group but stays out of "For this page" (an ordinary page shows no such section).
		expect(contextBoost(p, page("plain"))).toBeGreaterThan(contextBoost(p, page("pdf")));
		expect(contextBoost(p, page("plain"))).toBeLessThan(20);
		expect(contextBoost(p, page("pdf"))).toBeLessThan(20);
		expect(contextBoost(p, baseContext({ open: false, editable: false }))).toBe(0);
		expect(forThisPage(ACTIONS, page("ruled"), {}, NOW, new Set(), 100).map((x) => x.id)).toContain("page-tidy");
		// With something selected the selection's tidy-up leads, not the page's.
		expect(contextBoost(p, { ...page("ruled"), selection: { strokes: 4, elements: 0, images: 0 } })).toBeLessThan(20);
	});

	it("is found by what a person would type, in both languages", () => {
		for (const query of ["tidy", "straighten", "riordina", "margine"]) expect(ids(page("plain"), "all", query), query).toContain("page-tidy");
		for (const query of ["tidy", "margin", "allinea"]) expect(ids(sel(4), "all", query), query).toContain("selection-tidy");
	});
});
