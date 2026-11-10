import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";
import { ACTION_HELP } from "../src/ui/help-text";
import { ACTIONS, baseContext } from "../src/ui/actions";
import { contextBoost, forThisPage } from "../src/ui/context-rank";
import { buildSheet } from "../src/ui/layout";
import { describe, expect, it } from "vitest";
import { analyseLines, dropIndex, lineMoveCommand, LINE_RULES, mergeBands, pageSignature, planLineMove, planLineStep, type LineModel, type ReorderLine } from "../src/ink/line-reorder";
import { strokeBounds } from "../src/ink/hit-test";
import { createArea } from "../src/model/area";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { AddStroke, History } from "../src/model/history";
import { describeCommand } from "../src/model/history-describe";
import { pageTimes } from "../src/model/page-times";
import { freezeElement, freezeStroke, parse, serialize } from "../src/model/serialize";
import { createSticky } from "../src/model/sticky";
import { PAPER_SPACING, RENDER_INK, type BoxElement, type Page, type PageElement, type Point, type Stroke } from "../src/model/types";

/** Synthetic handwriting: x-height 10 pt, ascenders 20 pt, descenders 8 pt below the baseline, letters 9 pt apart. */
const XH = 10;
const ASC = 20;
const DESC = 8;
const ADVANCE = 9;
const WORD_GAP = 14;

let seq = 0;
function stroke(points: Point[], over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#111111", 1.5, points, "pen", RENDER_INK), id: `r${++seq}`, ...over });
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
function row(base: number, x0 = 60, words: readonly string[] = WORDS): Stroke[] {
	const out: Stroke[] = [];
	let x = x0;
	for (const w of words) {
		const made = word(w, x, base);
		out.push(...made.strokes);
		x = made.end + WORD_GAP;
	}
	return out;
}
/** A line of writing with no ascenders or descenders: only x-height bodies (a shorter line). */
function lowRow(base: number, x0 = 60): Stroke[] {
	const out: Stroke[] = [];
	let x = x0;
	for (const w of ["on", "an", "ear", "van", "ours"]) {
		const made = word(w, x, base);
		out.push(...made.strokes);
		x = made.end + WORD_GAP;
	}
	return out;
}

function pageOf(strokes: readonly Stroke[], elements: PageElement[] = []): Page {
	const page = createPage(undefined, { kind: "blank", spacing: PAPER_SPACING.blank });
	page.strokes.push(...strokes);
	if (elements.length > 0) page.elements = elements;
	return page;
}
const boxOf = (strokes: readonly Stroke[]): { minX: number; maxX: number; minY: number; maxY: number } => {
	const b = strokes.map((s) => strokeBounds(s));
	return { minX: Math.min(...b.map((x) => x.minX)), maxX: Math.max(...b.map((x) => x.maxX)), minY: Math.min(...b.map((x) => x.minY)), maxY: Math.max(...b.map((x) => x.maxY)) };
};
const byId = (page: Page, strokes: readonly Stroke[]): Stroke[] => strokes.map((s) => page.strokes.find((x) => x.id === s.id)!);

function run(page: Page, from: number, to: number, label = "Move line"): { model: LineModel; ok: boolean; hist: History; doc: ReturnType<typeof createDocument> } {
	const doc = createDocument();
	doc.pages = [page];
	const model = analyseLines(page);
	const move = planLineMove(model, from, to);
	const hist = new History(() => doc, 500, null, null, null, null, () => 1_900_000_000_000);
	if (!move.ok) return { model, ok: false, hist, doc };
	const plan = lineMoveCommand(page, model, move)!;
	expect(plan.command.label).toBe(label);
	return { model, ok: hist.execute(plan.command), hist, doc };
}

describe("line reorder: finding the lines", () => {
	it("finds the lines of a page in reading order with their boxes", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const m = analyseLines(pageOf(rows.flat()));
		expect(m.lines).toHaveLength(3);
		m.lines.forEach((l, i) => {
			expect(l.strokes).toHaveLength(rows[i]!.length);
			expect(l.blocked).toBeNull();
			expect(l.box.minY).toBeCloseTo(boxOf(rows[i]!).minY, 1);
		});
		expect(m.lines[0]!.pitch).toBeCloseTo(m.lines[1]!.box.minY - m.lines[0]!.box.minY, 5);
	});

	it("finds nothing on a page without writing, and ignores shapes and the highlighter", () => {
		expect(analyseLines(pageOf([])).lines).toHaveLength(0);
		const shape = stroke(loop(150, 300, 60, 40), { tool: "shape" });
		expect(analyseLines(pageOf([shape])).lines).toHaveLength(0);
	});

	it("takes two columns on the same rows as one line", () => {
		const left = [100, 150].map((b) => row(b, 40, ["the", "quick"]));
		const right = [100, 150].map((b) => row(b, 420, ["brown", "fox"]));
		const m = analyseLines(pageOf([...left.flat(), ...right.flat()]));
		expect(m.lines).toHaveLength(2);
		expect(m.lines[0]!.strokes).toHaveLength(left[0]!.length + right[0]!.length);
	});
});

describe("line reorder: the planner", () => {
	it("moves the first of three lines to the end: the others shift up by its pitch and the spacing stays", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		const before = rows.map((r) => boxOf(r));
		const { ok } = run(page, 0, 2);
		expect(ok).toBe(true);
		const after = rows.map((r) => boxOf(byId(page, r)));
		// New order: old line 1, old line 2, old line 0.
		expect(after[1]!.minY).toBeCloseTo(before[0]!.minY, 1);
		expect(after[2]!.minY).toBeCloseTo(before[1]!.minY, 1);
		expect(after[0]!.minY).toBeCloseTo(before[2]!.minY, 1);
		for (const r of rows) {
			for (const s of r) {
				const n = page.strokes.find((x) => x.id === s.id)!;
				const dx = n.points[0]![0] - s.points[0]![0];
				expect(dx).toBe(0);
				expect(n.points).toHaveLength(s.points.length);
				expect(n.points.every((p, k) => p[2] === s.points[k]![2] && Math.abs(p[1] - s.points[k]![1] - (n.points[0]![1] - s.points[0]![1])) < 0.02)).toBe(true);
				expect(n.width).toBe(s.width);
				expect(n.color).toBe(s.color);
			}
		}
	});

	it("moves the last line to the top and a middle line down, and gives the same result as stepping", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		const before = rows.map((r) => boxOf(r));
		expect(run(page, 2, 0).ok).toBe(true);
		const after = rows.map((r) => boxOf(byId(page, r)));
		expect(after[2]!.minY).toBeCloseTo(before[0]!.minY, 1);
		expect(after[0]!.minY).toBeCloseTo(before[1]!.minY, 1);
		expect(after[1]!.minY).toBeCloseTo(before[2]!.minY, 1);
		const model = analyseLines(pageOf(rows.map((r) => r).flat()));
		const step = planLineStep(model, 1, 1);
		const direct = planLineMove(model, 1, 2);
		expect(step).toEqual(direct);
		expect(step.ok).toBe(true);
	});

	it("keeps the gap after each line when the lines are of uneven height", () => {
		// line 0: tall (ascenders and descenders), line 1: low, line 2: tall again; unequal gaps.
		const tall0 = row(100), low1 = lowRow(170), tall2 = row(300);
		const page = pageOf([...tall0, ...low1, ...tall2]);
		const rowsList = [tall0, low1, tall2];
		const before = rowsList.map((r) => boxOf(r));
		const gapAfter = before.slice(0, 2).map((b, i) => before[i + 1]!.minY - b.maxY);
		expect(run(page, 0, 2).ok).toBe(true);
		const after = rowsList.map((r) => boxOf(byId(page, r)));
		// New order: low1, tall2, tall0. Each line keeps the distance from its top to the next line's top that it had (its pitch).
		const order = [1, 2, 0];
		const tops = order.map((i) => after[i]!.minY);
		expect(tops[0]).toBeCloseTo(before[0]!.minY, 1);
		expect(tops[1]! - tops[0]!).toBeCloseTo(before[2]!.minY - before[1]!.minY, 1);
		expect(tops[2]! - tops[1]!).toBeCloseTo(analyseLines(pageOf([...tall0, ...low1, ...tall2])).lines[2]!.pitch, 1);
		// Lines never overlap.
		expect(after[1]!.maxY).toBeLessThan(after[2]!.minY);
		expect(after[2]!.maxY).toBeLessThan(after[0]!.minY);
		expect(gapAfter.every((g) => g > 0)).toBe(true);
	});

	it("leaves the lines outside the two places exactly where they are", () => {
		const rows = [100, 150, 200, 250, 300].map((b) => row(b));
		const page = pageOf(rows.flat());
		const before = [...page.strokes];
		expect(run(page, 1, 2).ok).toBe(true);
		for (const s of [...rows[0]!, ...rows[3]!, ...rows[4]!]) expect(page.strokes[before.indexOf(s)]).toBe(s);
	});

	it("is one undo step, restores the very same strokes, does not touch the page times and reads back", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const strokes = rows.flat();
		const page = pageOf([]);
		const doc = createDocument();
		doc.pages = [page];
		const first = new History(() => doc, 500, null, null, null, null, () => 1_800_000_000_000);
		strokes.forEach((s, i) => first.execute(new AddStroke(page.id, s, i)));
		const times = JSON.stringify(pageTimes(page));
		const original = [...page.strokes];
		const model = analyseLines(page);
		const move = planLineMove(model, 0, 1);
		if (!move.ok) throw new Error(move.reason);
		const later = new History(() => doc, 500, null, null, null, null, () => 1_900_000_000_000);
		expect(later.execute(lineMoveCommand(page, model, move)!.command)).toBe(true);
		expect(page.strokes.some((s, i) => s !== original[i])).toBe(true);
		expect(JSON.stringify(pageTimes(page))).toBe(times);
		const moved = [...page.strokes];
		later.undo();
		expect(page.strokes.every((s, i) => s === original[i])).toBe(true);
		later.redo();
		expect(page.strokes.every((s, i) => s === moved[i])).toBe(true);
		expect(JSON.stringify(pageTimes(page))).toBe(times);
		const parsed = parse(serialize(doc));
		if (!parsed.ok) throw new Error("did not read back");
		expect(parsed.doc.pages[0]!.strokes.map((s) => s.id)).toEqual(strokes.map((s) => s.id));
	});

	it("has a title in the history panel", () => {
		const page = pageOf([100, 150].map((b) => row(b)).flat());
		const model = analyseLines(page);
		const move = planLineMove(model, 0, 1);
		if (!move.ok) throw new Error(move.reason);
		expect(describeCommand(lineMoveCommand(page, model, move)!.command).key).toBe("histpanel.t.moveLine");
	});

	it("refuses nothing-to-do, out of range and a locked page", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		const m = analyseLines(page);
		expect(planLineMove(m, 1, 1)).toEqual({ ok: false, reason: "same" });
		expect(planLineMove(m, 0, 3)).toEqual({ ok: false, reason: "range" });
		expect(planLineMove(m, -1, 0)).toEqual({ ok: false, reason: "range" });
		expect(planLineStep(m, 0, -1).ok).toBe(false);
		page.locked = true;
		expect(planLineMove(analyseLines(page), 0, 2)).toEqual({ ok: false, reason: "page-locked" });
	});

	it("moving the last line to the top keeps it on a finite page and refuses to leave the page", () => {
		const tall = row(30);
		const rows = [tall, row(90), row(150)];
		const page = pageOf(rows.flat());
		page.height = 200;
		const m = analyseLines(page);
		expect(planLineMove(m, 2, 0).ok).toBe(true);
		// A page that ends just above where the tall line would end up.
		const r = planLineMove({ ...m, limit: m.lines[2]!.box.maxY - 20 }, 0, 2);
		expect(r.ok === false ? r.reason : "ok").toBe("edge");
	});
});

describe("line reorder: what moves with a line, and what refuses it", () => {
	const lock = (over: Partial<BoxElement>): BoxElement => freezeElement({ id: "lk1", type: "box", kind: "definition", x: 40, y: 140, width: 300, height: 30, locked: true, lockAt: 1, ...over });

	it("refuses a line with a locked element in its band, and every move that involves it", () => {
		const rows = [100, 150, 200, 250].map((b) => row(b));
		const page = pageOf(rows.flat(), [lock({ y: 140, height: 14, x: 500, width: 20 })]);
		const m = analyseLines(page);
		expect(m.lines[1]!.blocked).toBe("locked");
		expect(planLineMove(m, 1, 2)).toEqual({ ok: false, reason: "locked" });
		expect(planLineMove(m, 0, 2)).toEqual({ ok: false, reason: "locked" });
		expect(planLineMove(m, 2, 3).ok).toBe(true);
		expect(planLineMove(m, 3, 0).ok).toBe(false);
	});

	it("lets a locked backdrop that holds a whole line stay behind while the line moves", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat(), [lock({ x: 0, y: 0, width: 600, height: 700 })]);
		expect(planLineMove(analyseLines(page), 0, 2).ok).toBe(true);
	});

	it("moves a group that lies inside one line whole, and refuses a group spanning two lines", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const grouped = rows[0]!.map((s) => freezeStroke({ ...s, group: "g1" }));
		const pageA = pageOf([...grouped, ...rows[1]!, ...rows[2]!]);
		const a = analyseLines(pageA);
		expect(a.lines[0]!.blocked).toBeNull();
		expect(a.lines[0]!.strokes.every((s) => s.group === "g1")).toBe(true);
		const spanning = [...rows[0]!.slice(0, 3), ...rows[1]!.slice(0, 3)].map((s) => freezeStroke({ ...s, group: "g2" }));
		const pageB = pageOf(rows.flat().map((s) => spanning.find((g) => g.id === s.id) ?? s));
		const b = analyseLines(pageB);
		expect(b.lines[0]!.blocked).toBe("group");
		expect(b.lines[1]!.blocked).toBe("group");
		expect(planLineMove(b, 0, 2)).toEqual({ ok: false, reason: "group" });
		expect(planLineMove(b, 2, 0)).toEqual({ ok: false, reason: "group" });
	});

	it("refuses a line whose group has a member that is not in the line (an element elsewhere)", () => {
		const rows = [100, 150].map((b) => row(b));
		const g = rows[0]!.map((s) => freezeStroke({ ...s, group: "g3" }));
		const elsewhere = freezeElement({ id: "bx", type: "box", kind: "definition", x: 40, y: 600, width: 80, height: 30, group: "g3" }) as BoxElement;
		const m = analyseLines(pageOf([...g, ...rows[1]!], [elsewhere]));
		expect(m.lines[0]!.blocked).toBe("group");
	});

	it("moves invisible line-pen ink inside the band with its line, and never lets it shape the lines", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const secret = stroke(line([70, 146], [200, 147], 10), { hidden: true });
		const page = pageOf([...rows.flat(), secret]);
		const m = analyseLines(page);
		expect(m.lines).toHaveLength(3);
		expect(m.lines[1]!.strokes).toContain(secret);
		expect(m.lines[1]!.blocked).toBeNull();
		const before = secret.points[0]![1];
		expect(run(page, 1, 2).ok).toBe(true);
		const moved = page.strokes.find((s) => s.id === secret.id)!;
		expect(moved.hidden).toBe(true);
		expect(moved.points[0]![1]).not.toBe(before);
		const line1 = boxOf(byId(page, rows[1]!));
		expect(moved.points[0]![1]).toBeGreaterThan(line1.minY);
		expect(moved.points[0]![1]).toBeLessThan(line1.maxY);
	});

	it("is blocked by invisible ink that is not handwriting inside a band (it would be left behind)", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const stray = stroke(line([70, 146], [200, 147], 10), { hidden: true, tool: "highlighter", width: 8 });
		const m = analyseLines(pageOf([...rows.flat(), stray]));
		expect(m.lines[1]!.blocked).toBe("busy");
	});

	it("moves an area highlighter that is fully inside the band with its line, and refuses a line whose area reaches into the next band", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		const b1 = boxOf(rows[1]!);
		const area = createArea([b1.minX - 4, b1.minY - 2], [b1.maxX + 4, b1.maxY + 2], page, "#ffd400")!;
		page.elements = [area];
		const m = analyseLines(page);
		expect(m.lines[1]!.elements).toContain(area);
		const beforeY = area.y;
		expect(run(page, 1, 2).ok).toBe(true);
		const moved = page.elements.find((e) => e.id === area.id)!;
		expect(moved).not.toBe(area);
		expect(moved.type === "area" && moved.y).toBeGreaterThan(beforeY);
		expect(moved.type === "area" && moved.height).toBe(area.height);
		// An area over two lines belongs to neither: both are busy.
		const wide = createArea([b1.minX, b1.minY], [b1.maxX, boxOf(rows[2]!).maxY], pageOf([]), "#ffd400")!;
		const m2 = analyseLines(pageOf(rows.flat(), [wide]));
		expect(m2.lines[1]!.blocked).toBe("busy");
		expect(m2.lines[2]!.blocked).toBe("busy");
		expect(m2.lines[0]!.blocked).toBeNull();
	});

	it("takes a collapsed sticky note in the band with the ink it keeps hidden", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const hidden = word("red", 520, 148).strokes;
		const proto = createSticky(530, 140, { width: 600, height: 800 });
		const note = freezeElement({ ...proto, x: 520, y: 128, width: 30, height: 30, collapsed: true as const, ink: hidden.map((s) => s.id) }) as PageElement;
		const page = pageOf([...rows.flat(), ...hidden], [note]);
		const m = analyseLines(page);
		expect(m.lines).toHaveLength(3);
		expect(m.lines[1]!.elements).toContain(note);
		for (const s of hidden) expect(m.lines[1]!.strokes).toContain(s);
		expect(m.lines[1]!.blocked).toBeNull();
		expect(run(page, 1, 0).ok).toBe(true);
		const moved = page.strokes.find((s) => s.id === hidden[0]!.id)!;
		expect(moved).not.toBe(hidden[0]);
	});

	it("is blocked by a shape drawn across lines and by a drawing in the way", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const shape = stroke(loop(300, 150, 200, 30), { tool: "shape" });
		const m = analyseLines(pageOf([...rows.flat(), shape]));
		expect(m.lines.some((l) => l.blocked === "busy")).toBe(true);
		// A drawing beside the lines, below them: a move that would land a long line on it is refused.
		const rows2 = [row(100), row(150, 60, ["the"]), row(200)];
		const doodle = stroke(loop(250, 166, 12, 12), { tool: "shape" });
		const page = pageOf([...rows2.flat(), doodle]);
		const m2 = analyseLines(page);
		expect(m2.lines[1]!.blocked).toBeNull();
		const r = planLineMove(m2, 0, 1);
		expect(r.ok).toBe(false);
	});

	it("does not need Node or Obsidian to run and keeps the rules documented", () => {
		expect(LINE_RULES.mergeOverlap).toBeGreaterThan(0);
	});
});

describe("line reorder: dropping", () => {
	it("finds the place from the middle of the dragged line", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const m = analyseLines(pageOf(rows.flat()));
		const mid = (i: number): number => (m.lines[i]!.box.minY + m.lines[i]!.box.maxY) / 2;
		expect(dropIndex(m, 0, mid(0))).toBe(0);
		expect(dropIndex(m, 0, mid(1) + 1)).toBe(1);
		expect(dropIndex(m, 0, mid(2) + 40)).toBe(2);
		expect(dropIndex(m, 2, mid(1) - 1)).toBe(1);
		expect(dropIndex(m, 2, -50)).toBe(0);
	});
});

describe("reorder lines in the action registry", () => {
	const NOW = 1_800_000_000_000;
	const page = (kind: "ruled" | "plain" | "pdf", extra: Record<string, unknown> = {}, toggles: Record<string, unknown> = {}) =>
		baseContext({ page: { index: 0, count: 1, background: kind === "pdf" ? "pdf" : "none", infinite: false, bookmarked: false, kind, ...extra }, toggles: { ...baseContext().toggles, ...toggles } });
	const find = (id: string) => ACTIONS.find((a) => a.id === id)!;
	const ids = (c: ReturnType<typeof baseContext>, kind: "all" | "page" = "all", query?: string): string[] =>
		buildSheet(c, { kind, usage: {}, now: NOW, label: (a) => a.id, ...(query ? { query } : {}) }).flatMap((s) => s.actions.map((a) => a.id));

	it("is a toggle in the page menu and the All actions sheet, with a command", () => {
		const def = find("page-reorder-lines");
		expect(def.command).toBe("command.reorderLines");
		expect(def.surfaces).toEqual(["page", "sheet"]);
		expect(ids(page("plain"), "page")).toContain("page-reorder-lines");
		expect(ids(page("plain"))).toContain("page-reorder-lines");
		expect(def.checked?.(page("plain"))).toBe(false);
		expect(def.checked?.(page("plain", {}, { lineHandles: true }))).toBe(true);
	});

	it("is not offered on a locked page unless the mode is already on (so it can be left)", () => {
		const def = find("page-reorder-lines");
		expect(def.enabled?.(page("plain", { locked: true }))).toBe(false);
		expect(def.enabled?.(page("plain", { locked: true }, { lineHandles: true }))).toBe(true);
		expect(def.enabled?.(baseContext({ editable: false }))).toBe(false);
	});

	it("has a help text for the action and the controls, and every text in English and Italian", () => {
		expect(ACTION_HELP["page-reorder-lines"]).toBe("help.reorderLines");
		const keys = [
			"linehandle.action", "command.reorderLines", "linehandle.hint", "linehandle.done", "linehandle.up", "linehandle.down", "linehandle.handle", "linehandle.none",
			"linehandle.moved", "linehandle.refused.locked", "linehandle.refused.busy", "linehandle.refused.group", "linehandle.refused.conflict", "linehandle.refused.crowded",
			"linehandle.refused.edge", "linehandle.refused.pageLocked", "linehandle.refused.readOnly", "linehandle.refused.background", "linehandle.cancelled", "histpanel.t.moveLine", "help.reorderLines", "help.lineHandle",
			"help.lineUp", "help.lineDown", "help.lineDone",
		];
		for (const key of keys) {
			expect(enSrc, key).toContain(`"${key}"`);
			expect(itSrc, key).toContain(`"${key}"`);
		}
	});

	it("is ranked: first while the mode is on, a lean forward on writing paper, never in 'For this page' otherwise", () => {
		const a = find("page-reorder-lines");
		expect(contextBoost(a, page("plain", {}, { lineHandles: true }))).toBeGreaterThan(contextBoost(a, page("plain")));
		expect(contextBoost(a, page("ruled"))).toBeGreaterThan(contextBoost(a, page("pdf")));
		expect(forThisPage(ACTIONS, page("ruled"), {}, NOW, new Set(), 100).map((x) => x.id)).not.toContain("page-reorder-lines");
		// A switched-on toggle is never offered again under "For this page" (it is in its own group, where it is ranked first).
		expect(forThisPage(ACTIONS, page("plain", {}, { lineHandles: true }), {}, NOW, new Set(), 100).map((x) => x.id)).not.toContain("page-reorder-lines");
	});

	it("is found by what a person would type, in both languages", () => {
		for (const query of ["reorder", "handle", "riordina", "maniglia"]) expect(ids(page("plain"), "all", query), query).toContain("page-reorder-lines");
	});
});
