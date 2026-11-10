import { describe, expect, it } from "vitest";
import { analyseLines, lineMoveCommand, mergeBands, pageSignature, planLineMove, type LineModel, type ReorderLine } from "../src/ink/line-reorder";
import { strokeBounds } from "../src/ink/hit-test";
import { createArea } from "../src/model/area";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { freezeElement, freezeStroke } from "../src/model/serialize";
import { createSticky } from "../src/model/sticky";
import { PAPER_SPACING, RENDER_INK, type BoxElement, type Page, type PageElement, type Point, type Stroke } from "../src/model/types";

/** The independent review of the line handle (L1-L12): synthetic handwriting as in line-reorder.test.ts. */
const XH = 10;
const ASC = 20;
const DESC = 8;
const ADVANCE = 9;
const WORD_GAP = 14;

let seq = 0;
function stroke(points: Point[], over: Partial<Stroke> = {}): Stroke {
	return freezeStroke({ ...createStroke("#111111", 1.5, points, "pen", RENDER_INK), id: `v${++seq}`, ...over });
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
const reason = (r: ReturnType<typeof planLineMove>): string => (r.ok ? "ok" : r.reason);

/** A model of lines without a page: rows are [top, bottom, reach below the box, extent below the box]. */
function fakeModel(rows: Array<[number, number, number?, number?]>, over: Partial<LineModel> = {}): LineModel {
	const lines: ReorderLine[] = rows.map(([top, bottom, below = 0, extentBelow = 0], i) => {
		const box = { minX: 50, minY: top, maxX: 300, maxY: bottom };
		return {
			index: i, box, reach: { ...box, maxY: bottom + below }, extent: { ...box, maxY: bottom + Math.max(below, extentBelow) }, band: { top, bottom },
			pitch: (rows[i + 1]?.[0] ?? bottom + 10) - top, strokes: [], elements: [], comments: [], blocked: null,
		};
	});
	return { pageId: "p", lines, locked: false, background: false, size: 12, limit: 0, obstacles: [], obstacleReach: [], ...over };
}

describe("line reorder review: reach and extent (L1, L2)", () => {
	it("L1: a collapsed note whose hidden ink would cross the page bottom refuses the move (edge)", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const hidden = word("red", 520, 262).strokes;
		const proto = createSticky(530, 100, { width: 600, height: 800 });
		const note = freezeElement({ ...proto, x: 520, y: 88, width: 30, height: 30, collapsed: true as const, ink: hidden.map((s) => s.id) });
		const page = pageOf([...rows.flat(), ...hidden], [note]);
		page.height = 280;
		const m = analyseLines(page);
		expect(m.lines).toHaveLength(3);
		expect(m.lines[0]!.elements).toContain(note);
		expect(m.lines[0]!.extent.maxY).toBeGreaterThan(m.lines[0]!.box.maxY + 100);
		// The handwriting alone would fit, the hidden ink would not.
		expect(m.lines[0]!.box.maxY + (m.lines[2]!.box.minY - m.lines[0]!.box.minY)).toBeLessThan(280);
		expect(reason(planLineMove(m, 0, 2))).toBe("edge");
	});

	it("L1: an element beside the line that would land on something that stays refuses the move (crowded)", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		const area = createArea([480, 94], [540, 108], page, "#ffd400")!;
		const mark = stroke(loop(510, 196, 10, 6), { tool: "shape" });
		page.strokes.push(mark);
		page.elements = [area];
		const m = analyseLines(page);
		expect(m.lines[0]!.elements).toContain(area);
		expect(m.lines[0]!.blocked).toBeNull();
		expect(m.lines[2]!.blocked).toBeNull();
		expect(reason(planLineMove(m, 0, 2))).toBe("crowded");
		expect(planLineMove(m, 0, 1).ok).toBe(true);
	});

	it("L1: the planner uses the extent for the page edge (model level)", () => {
		const bottom = fakeModel([[10, 40, 0, 200], [60, 90], [110, 140]], { limit: 300 });
		expect(reason(planLineMove(bottom, 0, 2))).toBe("edge");
		const fine = fakeModel([[10, 40], [60, 90], [110, 140]], { limit: 300 });
		expect(planLineMove(fine, 0, 2).ok).toBe(true);
		const top = fakeModel([[10, 40], [60, 90, 0, 0], [110, 140]], { limit: 0 });
		expect(planLineMove(top, 2, 0).ok).toBe(true);
	});

	it("L2: a mark drawn on an element that moves with the line refuses the line (it would be left behind)", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		const area = createArea([480, 144], [540, 158], page, "#ffd400")!;
		const mark = stroke(line([490, 150], [530, 152], 6), { tool: "highlighter", width: 6 });
		page.strokes.push(mark);
		page.elements = [area];
		const m = analyseLines(page);
		expect(m.lines[1]!.elements).toContain(area);
		expect(m.lines[1]!.blocked).toBe("busy");
		expect(planLineMove(m, 1, 2)).toEqual({ ok: false, reason: "busy" });
	});

	it("L2: a moved element may not land on one that stays", () => {
		const rows = [100, 150, 200, 250].map((b) => row(b));
		const page = pageOf(rows.flat());
		const moving = createArea([480, 94], [540, 108], page, "#ffd400")!;
		// An unlocked text-like box in line 3's band only; line 1 and 2 stay in the plan below (lines 0 and 1 swap).
		const staying: BoxElement = freezeElement({ id: "stay", type: "box", kind: "definition", x: 470, y: 150 - 14, width: 80, height: 14 });
		page.elements = [moving, staying];
		const m = analyseLines(page);
		expect(m.lines[0]!.elements).toContain(moving);
		expect(m.lines[1]!.elements).toContain(staying);
		// Both move (0 and 1 swap): the area lands where the box was and the box where the area was: no overlap with what stays.
		expect(planLineMove(m, 0, 1).ok).toBe(true);
		// A drawing that does not move sits where the area would land: refused.
		const shape = stroke(loop(510, 156, 12, 4), { tool: "shape" });
		const withShape = pageOf([...rows.flat(), shape], [moving, staying]);
		const m2 = analyseLines(withShape);
		expect(m2.lines[1]!.blocked === null || m2.lines[1]!.blocked === "busy").toBe(true);
		expect(planLineMove(m2, 0, 1).ok).toBe(false);
	});
});

describe("line reorder review: the step (L3, L4, L10)", () => {
	it("L3: a plan for another page, or whose items are no longer on the page, makes no step", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		const model = analyseLines(page);
		const move = planLineMove(model, 0, 1);
		if (!move.ok) throw new Error(move.reason);
		expect(lineMoveCommand(pageOf(rows.flat()), model, move)).toBeNull();
		const emptied: Page = { ...page, strokes: [] };
		expect(lineMoveCommand(emptied, model, move)).toBeNull();
		expect(lineMoveCommand(page, model, move)).not.toBeNull();
	});

	it("L3/L10: the page signature changes with the strokes, the size, the paper edge, the background and the lock", () => {
		const page = pageOf([100, 150].flatMap((b) => row(b)));
		let n = 0;
		const ids = new WeakMap<object, number>();
		const stamp = (o: object): number => {
			let v = ids.get(o);
			if (v === undefined) ids.set(o, (v = ++n));
			return v;
		};
		const base = pageSignature(page, stamp);
		expect(pageSignature(page, stamp)).toBe(base);
		expect(pageSignature({ ...page, height: page.height + 10 }, stamp)).not.toBe(base);
		expect(pageSignature({ ...page, infinite: true }, stamp)).not.toBe(base);
		expect(pageSignature({ ...page, margins: { left: 0, right: 0, bottom: 20 } }, stamp)).not.toBe(base);
		expect(pageSignature({ ...page, locked: true }, stamp)).not.toBe(base);
		expect(pageSignature({ ...page, background: { kind: "image", asset: "a" } }, stamp)).not.toBe(base);
		expect(pageSignature({ ...page, strokes: page.strokes.map((s, i) => (i === 0 ? { ...s } : s)) }, stamp)).not.toBe(base);
	});

	it("L4: a margin comment inside the line's band moves with it, in the same undo step", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		const b1 = boxOf(rows[1]!);
		page.comments = [
			{ id: "c1", region: { x: b1.minX, y: b1.minY, width: 100, height: b1.maxY - b1.minY }, text: "check this date", author: "me", created: 1 },
			{ id: "r1", parent: "c1", text: "ok", author: "me", created: 2 },
		];
		const before = page.comments;
		const originalY = b1.minY;
		const model = analyseLines(page);
		expect(model.lines[1]!.comments).toEqual(["c1"]);
		expect(model.lines[1]!.blocked).toBeNull();
		const doc = createDocument();
		doc.pages = [page];
		const hist = new History(() => doc, 500, null, null, null, null, () => 1_900_000_000_000);
		const move = planLineMove(model, 1, 2);
		if (!move.ok) throw new Error(move.reason);
		const plan = lineMoveCommand(page, model, move)!;
		expect(plan.comments).toBe(1);
		expect(hist.execute(plan.command)).toBe(true);
		const moved = page.comments![0]! as { region: { y: number } };
		expect(moved.region.y).toBeCloseTo(originalY + move.shifts[1]!, 1);
		expect(page.comments![1]).toBe(before[1]);
		hist.undo();
		expect(page.comments).toBe(before);
		hist.redo();
		expect((page.comments![0]! as { region: { y: number } }).region.y).toBeGreaterThan(originalY);
	});

	it("L4: a comment region that touches a line's writing without being inside its band refuses the line", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const b1 = boxOf(rows[1]!);
		const b2 = boxOf(rows[2]!);
		const page = pageOf(rows.flat());
		page.comments = [{ id: "big", region: { x: b1.minX, y: b1.minY + 5, width: 120, height: b2.maxY - b1.minY }, text: "both", author: "me", created: 1 }];
		const m = analyseLines(page);
		expect(m.lines[1]!.blocked).toBe("busy");
		expect(m.lines[2]!.blocked).toBe("busy");
		expect(m.lines[0]!.blocked).toBeNull();
	});
});

describe("line reorder review: cost (L5)", () => {
	it("merging rows is a sweep: thousands of rows of two columns finish at once", () => {
		const rows = [];
		for (let i = 0; i < 3000; i++) {
			const top = i * 40;
			rows.push({ strokes: [], box: { minX: 40, minY: top, maxX: 300, maxY: top + 30 } }, { strokes: [], box: { minX: 400, minY: top + 2, maxX: 560, maxY: top + 32 } });
		}
		const t0 = performance.now();
		const merged = mergeBands(rows);
		const ms = performance.now() - t0;
		expect(merged).toHaveLength(3000);
		expect(ms).toBeLessThan(1500);
		expect(mergeBands([])).toEqual([]);
	});

	it("a long page with many lines is analysed and planned in reasonable time", () => {
		const count = 90;
		const strokes: Stroke[] = [];
		for (let i = 0; i < count; i++) strokes.push(...row(40 + i * 45, 60, ["the", "quick"]));
		const page = pageOf(strokes);
		page.height = 40 + count * 45 + 100;
		const t0 = performance.now();
		const m = analyseLines(page);
		const t1 = performance.now();
		expect(m.lines).toHaveLength(count);
		for (let k = 0; k < 200; k++) planLineMove(m, 3, count - 4);
		const t2 = performance.now();
		expect(t1 - t0).toBeLessThan(8000);
		expect(t2 - t1).toBeLessThan(3000);
	});
});

describe("line reorder review: more refusals (L6, L7, L11, L12)", () => {
	it("L6: two moved lines may not end up over each other", () => {
		// Line 1 reaches 25 pt below its box (it is 45 pt tall in all) but its pitch is 35: next to line 0 in the new order they overlap.
		const m = fakeModel([[0, 30], [40, 60, 25], [75, 100], [110, 140]]);
		expect(reason(planLineMove(m, 0, 1))).toBe("crowded");
		// With no other line at all it is the pair of moved lines that is refused.
		const pair = fakeModel([[0, 30], [40, 60, 25]]);
		expect(reason(planLineMove(pair, 0, 1))).toBe("crowded");
		const calm = fakeModel([[0, 30], [50, 80], [100, 130], [150, 180]]);
		expect(planLineMove(calm, 1, 3).ok).toBe(true);
		const tall = fakeModel([[0, 30], [50, 80, 70], [130, 160], [200, 230]]);
		expect(reason(planLineMove(tall, 1, 2))).toBe("crowded");
	});

	it("L7: a line that holds an item of a part of a drawing with states is refused", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		page.states = { parts: [{ id: "p1", pivot: [100, 160], items: [rows[1]![0]!.id, rows[1]![1]!.id] }], list: [] };
		const m = analyseLines(page);
		expect(m.lines[1]!.blocked).toBe("busy");
		expect(planLineMove(m, 0, 1)).toEqual({ ok: false, reason: "busy" });
		expect(planLineMove(m, 0, 2).ok).toBe(false);
	});

	it("L11: ink a collapsed note keeps hidden never refuses a line it does not belong to", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const hidden = word("red", 70, 152).strokes;
		const proto = createSticky(530, 700, { width: 600, height: 800 });
		const note = freezeElement({ ...proto, x: 520, y: 700, width: 30, height: 30, collapsed: true as const, ink: hidden.map((s) => s.id) });
		const page = pageOf([...rows.flat(), ...hidden], [note]);
		const m = analyseLines(page);
		expect(m.lines).toHaveLength(3);
		expect(m.lines.every((l) => l.blocked === null)).toBe(true);
		expect(planLineMove(m, 0, 2).ok).toBe(true);
	});

	it("L12: a page with a PDF or picture background refuses every move, with its own reason", () => {
		const rows = [100, 150, 200].map((b) => row(b));
		const page = pageOf(rows.flat());
		page.background = { kind: "pdf", asset: "a.pdf", page: 1 };
		const m = analyseLines(page);
		expect(m.background).toBe(true);
		expect(m.lines).toHaveLength(3);
		expect(planLineMove(m, 0, 1)).toEqual({ ok: false, reason: "background" });
		page.background = { kind: "image", asset: "a.png" };
		expect(planLineMove(analyseLines(page), 0, 1)).toEqual({ ok: false, reason: "background" });
		delete page.background;
		expect(planLineMove(analyseLines(page), 0, 1).ok).toBe(true);
	});
});
