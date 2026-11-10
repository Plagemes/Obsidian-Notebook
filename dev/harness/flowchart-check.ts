/**
 * Smoke check of "Tidy flowchart" (0.30, roadmap #245) on the `doc=flowchart` notebook (the blank "New" notebook; HARNESS_DOC=flowchart npm
 * run harness:check): the real view. A crooked hand-drawn flowchart (boxes of three kinds, writing inside them, arrows) is put on the page and
 * selected; the action is run through the view's own action runner: the boxes line up and keep their strokes, the writing moves with its box,
 * the arrows are drawn again from box to box, everything is ONE undo step, a second run says the chart is tidy, and a locked page refuses.
 * `flowchartShot` leaves the page before / after for the screenshots (dist/shots/design/flowchart-<state>-<theme>-<device>.png).
 */
import { readFlowchart } from "../../src/ink/flowchart";
import { AddStroke, Batch, RemoveElement, removeStrokes } from "../../src/model/history";
import { createStroke } from "../../src/model/document";
import { freezeStroke } from "../../src/model/serialize";
import { RENDER_INK, type Page, type PageElement, type Point, type Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface FlowchartCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface FlowchartView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	clearSelection(): void;
}

const pageOf = (v: FlowchartView): Page => v.document.pages[v.currentPage()]!;
const noise = (i: number, salt: number): number => {
	const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
	return (x - Math.floor(x)) * 2 - 1;
};
const pt = (x: number, y: number, p = 0.55): Point => [Math.round(x * 100) / 100, Math.round(y * 100) / 100, p];
let serial = 0;
const stroke = (points: Point[], color: string): Stroke => freezeStroke({ ...createStroke(color, 2, points, "pen", RENDER_INK), id: `fc${++serial}-${Math.random().toString(36).slice(2, 7)}` });

function outline(corners: Array<[number, number]>, salt: number): Point[] {
	const out: Point[] = [];
	let k = 0;
	corners.forEach((a, i) => {
		const b = corners[(i + 1) % corners.length]!;
		const n = Math.max(6, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
		for (let j = 0; j < n; j++, k++) out.push(pt(a[0] + ((b[0] - a[0]) * j) / n + 0.9 * noise(k, salt), a[1] + ((b[1] - a[1]) * j) / n + 0.9 * noise(k, salt + 1), 0.35 + 0.3 * noise(k, salt + 2) ** 2));
	});
	out.push(pt(corners[0]![0] + 1.5, corners[0]![1] + 1));
	return out;
}
const rect = (x: number, y: number, w: number, h: number, salt: number, color: string): Stroke => stroke(outline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], salt), color);
const diamond = (x: number, y: number, w: number, h: number, salt: number, color: string): Stroke => stroke(outline([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]], salt), color);
function ellipse(x: number, y: number, w: number, h: number, salt: number, color: string): Stroke {
	const pts: Point[] = [];
	for (let i = 0; i <= 72; i++) {
		const t = (2 * Math.PI * i) / 72 + 0.3;
		pts.push(pt(x + w / 2 + (w / 2) * Math.cos(t) + 0.7 * noise(i, salt), y + h / 2 + (h / 2) * Math.sin(t) + 0.7 * noise(i, salt + 1)));
	}
	return stroke(pts, color);
}
function arrow(a: [number, number], b: [number, number], salt: number, color: string): Stroke {
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const back = Math.atan2(a[1] - b[1], a[0] - b[0]);
	const w1: [number, number] = [b[0] + 12 * Math.cos(back + 0.5), b[1] + 12 * Math.sin(back + 0.5)];
	const w2: [number, number] = [b[0] + 12 * Math.cos(back - 0.5), b[1] + 12 * Math.sin(back - 0.5)];
	const pts: Point[] = [];
	const leg = (p: [number, number], q: [number, number], n: number, amp: number, from: number): void => {
		for (let i = from; i <= n; i++) pts.push(pt(p[0] + ((q[0] - p[0]) * i) / n + amp * noise(pts.length, salt), p[1] + ((q[1] - p[1]) * i) / n + amp * noise(pts.length, salt + 1)));
	};
	leg(a, b, Math.max(8, Math.round(len / 5)), 0.6, 0);
	leg(b, w1, 4, 0, 1);
	leg(w1, b, 4, 0, 1);
	leg(b, w2, 4, 0, 1);
	return stroke(pts, color);
}
/** A few short strokes standing for words. */
const words = (x: number, y: number, salt: number, color: string): Stroke[] => [0, 1, 2, 3].map((k) => stroke(Array.from({ length: 9 }, (_, i) => pt(x + k * 11 + 3 * Math.sin(i + k) + noise(i, salt + k), y + i * 1.6 + noise(i, salt + k + 9))), color));

/** A crooked flowchart: start (ellipse), a step, a decision (diamond), a step on each branch, with their words and the arrows. */
function chart(): Stroke[] {
	const ink = "#1f2430", accent = "#2f6fdb";
	const start = ellipse(188, 70, 150, 56, 3, ink);
	const step = rect(182, 190, 162, 58, 1, ink);
	const decide = diamond(176, 312, 176, 96, 2, accent);
	const yes = rect(70, 470, 140, 52, 5, ink);
	const no = rect(320, 478, 146, 54, 7, ink);
	return [
		start, step, decide, yes, no,
		...words(226, 90, 11, ink), ...words(222, 210, 12, ink), ...words(236, 352, 13, accent), ...words(98, 488, 14, ink), ...words(350, 496, 15, ink),
		arrow([264, 128], [262, 188], 21, ink), arrow([262, 250], [264, 310], 22, ink),
		arrow([216, 392], [150, 468], 23, ink), arrow([318, 392], [388, 476], 24, ink),
	];
}

/** Clears the page, draws the chart, selects all of it. */
async function setUp(api: FlowchartCheckApi): Promise<{ v: FlowchartView; strokes: Stroke[] }> {
	const v = api.view as FlowchartView;
	const page = pageOf(v);
	const clear = removeStrokes(page.id, page.strokes, page.strokes, "Clear");
	const commands = [...(clear ? [clear] : []), ...(page.elements ?? []).map((e) => new RemoveElement(page.id, e))];
	if (commands.length > 0) v.history.execute(new Batch("Clear", commands));
	const strokes = chart();
	strokes.forEach((s, i) => v.history.execute(new AddStroke(page.id, s, i)));
	v.renderer.invalidate();
	v.selectItems(v.currentPage(), strokes, []);
	await api.frames(3);
	return { v, strokes };
}

export async function checkFlowchart(api: FlowchartCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const { v, strokes } = await setUp(api);
	const page = pageOf(v);
	const before = [...page.strokes];
	const read = (list: readonly Stroke[]) => {
		const m = readFlowchart(list, []);
		return m === "few" || m === "nested" ? null : m;
	};
	const m0 = read(strokes);
	add("the crooked chart is read as 5 boxes (ellipse, rectangles, diamond) and 4 arrows", m0?.nodes.length === 5 && m0.edges.length === 4, `${m0?.nodes.length} boxes, ${m0?.edges.length} arrows`);
	const picked = (v.uiContext() as unknown as { selection?: { strokes?: number } | null }).selection;
	add("the selection holds the whole chart (the sheet offers Tidy flowchart for it)", (picked?.strokes ?? 0) > 10, String(picked?.strokes));

	api.notices.length = 0;
	v.runAction("selection-flowchart");
	await api.frames(4);
	add("the notice says how many boxes and arrows", api.notices.some((n) => /Tidied 5 boxes/.test(n)), api.notices.join(" | "));
	add("the number of strokes is the same", page.strokes.length === before.length);
	const after = [...page.strokes];
	const m1 = read(after);
	const centres = m1 ? m1.nodes.map((n) => (n.box.minX + n.box.maxX) / 2) : [];
	add("the first three boxes (start, step, decision) share one centre line", centres.length === 5 && Math.max(centres[0]!, centres[1]!, centres[2]!) - Math.min(centres[0]!, centres[1]!, centres[2]!) < 0.2, centres.join(", "));
	const rows = m1 ? m1.nodes.map((n) => (n.box.minY + n.box.maxY) / 2) : [];
	add("the two branch boxes share one row", rows.length === 5 && Math.abs(rows[3]! - rows[4]!) < 0.2, rows.join(", "));
	if (m1) {
		const gap = (a: number, b: number) => m1.nodes[b]!.box.minY - m1.nodes[a]!.box.maxY;
		add("the gaps between the rows are equal", Math.abs(gap(0, 1) - gap(1, 2)) < 0.2 && Math.abs(gap(1, 2) - gap(2, 3)) < 0.2, `${gap(0, 1)}, ${gap(1, 2)}, ${gap(2, 3)}`);
	}
	const arrows = after.filter((s) => s.tool === "shape");
	add("the four arrows are clean shape strokes, the rest still pen ink", arrows.length === 4 && after.filter((s) => s.tool === "pen").length === before.length - 4);
	add("the box strokes keep their points, pressure and colour", before.slice(0, 5).every((s, i) => after[i]!.points.length === s.points.length && after[i]!.color === s.color && after[i]!.points.every((p, k) => p[2] === s.points[k]![2])));
	add("the words moved with their boxes (every writing stroke is inside a box)", !!m1 && m1.nodes.reduce((n, b) => n + b.strokes.length, 0) === 20);

	v.undo();
	await api.frames(3);
	add("ONE undo puts every stroke back, the very same objects", page.strokes.length === before.length && page.strokes.every((s, i) => s === before[i]));
	v.redo();
	await api.frames(3);
	add("redo does it again", page.strokes.filter((s) => s.tool === "shape").length === 4);

	api.notices.length = 0;
	v.selectItems(v.currentPage(), [...page.strokes], []);
	await api.frames(2);
	v.runAction("selection-flowchart");
	await api.frames(3);
	add("tidying the tidy chart says so and changes nothing", api.notices.some((n) => /already tidy/.test(n)) && page.strokes.every((s, i) => s === after[i]), api.notices.join(" | "));

	v.undo();
	await api.frames(3);
	v.selectItems(v.currentPage(), [...page.strokes], []);
	page.locked = true;
	v.runAction("selection-flowchart");
	await api.frames(3);
	add("a locked page refuses the action and nothing changes", page.strokes.every((s, i) => s === before[i]));
	delete page.locked;
	v.clearSelection();
	await api.frames(2);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: page.strokes.length } };
}

/** Leaves the harness notebook with the crooked chart selected (`before`) or tidied (`after`) for the screenshot. */
export async function flowchartShot(api: FlowchartCheckApi, state: "before" | "after"): Promise<void> {
	await api.open("flowchart");
	const { v } = await setUp(api);
	if (state === "after") {
		v.runAction("selection-flowchart");
		await api.frames(4);
	}
	v.clearSelection();
	await api.frames(3);
}
