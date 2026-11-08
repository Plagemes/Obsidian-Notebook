/**
 * Smoke check of "Join broken strokes" (0.24, roadmap #313) on the `doc=strokejoin` notebook (the blank "New" notebook;
 * HARNESS_DOC=strokejoin npm run harness:check): the real view and History. A page holds a cursive line and a long stroke each cut in
 * two by a small pen dropout, a three-way split line, and things that must stay apart: two words, an L written as two strokes, a
 * dashed line, an i with its dot and a V. They are selected and "Join broken strokes" is run from the contextual bar: the broken lines
 * become one stroke each (keeping the first id), everything else stays the very same stroke, one undo gives the page back and a redo
 * does it again; a second run finds nothing; a locked page refuses it. It leaves the joined page selected, with the action in the
 * bar, for the screenshot.
 */
import { AddStroke, Batch } from "../../src/model/history";
import { RENDER_INK, type Page, type Point, type Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface StrokejoinCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface JoinView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
	selection: { strokes: Stroke[] } | null;
	setPageLocked(page: Page, value: boolean): boolean;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A line through the vertices with a point about every `step` pt. */
function poly(vertices: Array<[number, number]>, step = 1.2, p = 0.55): Point[] {
	const out: Point[] = [[vertices[0]![0], vertices[0]![1], p]];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!;
		const [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
		for (let k = 1; k <= n; k++) out.push([r2(ax + ((bx - ax) * k) / n), r2(ay + ((by - ay) * k) / n), p]);
	}
	return out;
}

/** A wave (cursive) from x0 to x1 around y, a point about every 1.4 pt. */
function wave(x0: number, x1: number, y: number): Point[] {
	const out: Point[] = [];
	for (let x = x0; x <= x1; x += 1.4) out.push([r2(x), r2(y + 9 * Math.sin((x - x0) / 11)), r2(0.45 + 0.15 * Math.sin(x / 17))]);
	return out;
}

export async function checkStrokejoin(api: StrokejoinCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as JoinView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	let n = 0;
	const make = (points: Point[]): Stroke => ({ id: `sj-${++n}`, tool: "pen", color: "#1f2933", width: 2, render: RENDER_INK, points });

	// --- the page ---
	const cursive = wave(50, 250, 70);
	const cursiveA = make(cursive.slice(0, 70));
	const cursiveB = make(cursive.slice(72));
	const longLine = poly([[50, 130], [250, 135]]);
	const lineA = make(longLine.slice(0, 80));
	const lineB = make(longLine.slice(82));
	const chain = poly([[50, 175], [250, 175]]);
	const chain1 = make(chain.slice(0, 45));
	const chain2 = make(chain.slice(47, 100));
	const chain3 = make(chain.slice(102));
	const wordA = make(poly([[50, 220], [120, 222]]));
	const wordB = make(poly([[136, 222], [210, 220]]));
	const ell1 = make(poly([[290, 60], [290, 120]]));
	const ell2 = make(poly([[291, 121], [340, 121]]));
	const dash1 = make(poly([[290, 160], [305, 160]]));
	const dash2 = make(poly([[309, 160], [324, 160]]));
	const iDot = make([[400, 62, 0.6]]);
	const iStem = make(poly([[400, 76], [400, 116]]));
	const vLeft = make(poly([[290, 190], [310, 235]]));
	const vRight = make(poly([[311, 234], [332, 190]]));
	const all = [cursiveA, cursiveB, lineA, lineB, chain1, chain2, chain3, wordA, wordB, ell1, ell2, dash1, dash2, iDot, iStem, vLeft, vRight];
	const apart = [wordA, wordB, ell1, ell2, dash1, dash2, iDot, iStem, vLeft, vRight];
	v.applyCommand(new Batch("Draw", all.map((s, i) => new AddStroke(page().id, s, i))));
	await frames(3);
	add("the page holds seventeen strokes", page().strokes.length === 17 && page().strokes.every((s, i) => s === all[i]));

	// --- one stroke is not enough to join ---
	v.selectItems(0, [cursiveA], []);
	await frames(2);
	add("with one stroke selected the bar does not offer Join", !q('[data-action="selection-join"]'));

	// --- the action ---
	v.selectItems(0, [...page().strokes], []);
	await frames(3);
	const button = q<HTMLElement>('[data-action="selection-join"]');
	add("the contextual bar offers Join broken strokes", !!button);
	const notices0 = api.notices.length;
	(button ?? undefined)?.click();
	await frames(4);
	const after = page().strokes;
	add("the four breaks are joined: seventeen strokes become thirteen", after.length === 13, `${after.length} strokes`);
	const joinedCursive = after.find((s) => s.id === cursiveA.id);
	add("the cursive line is one stroke with the id of the first half and all the points", !!joinedCursive && joinedCursive.points.length === cursiveA.points.length + cursiveB.points.length && !after.some((s) => s.id === cursiveB.id));
	const joinedLine = after.find((s) => s.id === lineA.id);
	add("the long line is one stroke too", !!joinedLine && joinedLine.points.length === lineA.points.length + lineB.points.length && !after.some((s) => s.id === lineB.id));
	const joinedChain = after.find((s) => s.id === chain1.id);
	add("the three-way split line became one stroke", !!joinedChain && joinedChain.points.length === chain1.points.length + chain2.points.length + chain3.points.length && !after.some((s) => s.id === chain2.id || s.id === chain3.id));
	add("two words, the L, the dashes, the i with its dot and the V are the very same strokes", apart.every((s) => after.includes(s)));
	add("the stroke order is kept", after.map((s) => s.id).join() === all.filter((s) => s !== cursiveB && s !== lineB && s !== chain2 && s !== chain3).map((s) => s.id).join());
	add("style and fields of the joined strokes are those of the first piece", [joinedCursive, joinedLine, joinedChain].every((s) => !!s && s.tool === "pen" && s.color === cursiveA.color && s.width === 2 && s.render === RENDER_INK));
	add("a notice tells how many breaks were joined", api.notices.slice(notices0).some((m) => /4/.test(m)), api.notices.slice(notices0).join(" | "));
	add("the selection stays on the joined strokes", (v.selection?.strokes.length ?? 0) === 13 && (v.selection?.strokes ?? []).every((s) => after.includes(s)));
	const joined = [...after];

	// --- one undo step ---
	v.undo();
	await frames(3);
	add("one undo puts every stroke back, in its place", page().strokes.length === 17 && page().strokes.every((s, i) => s === all[i]));
	v.redo();
	await frames(3);
	add("one redo joins them again", page().strokes.length === 13 && page().strokes.every((s, i) => s === joined[i]));

	// --- a second run finds nothing ---
	v.selectItems(0, [...page().strokes], []);
	await frames(2);
	const again = q<HTMLElement>('[data-action="selection-join"]');
	const notices1 = api.notices.length;
	again?.click();
	await frames(3);
	add("joining a joined page changes nothing and says so", page().strokes.every((s, i) => s === joined[i]) && api.notices.slice(notices1).length >= 1, api.notices.slice(notices1).join(" | "));

	// --- a locked page refuses it ---
	v.undo();
	await frames(2);
	v.selectItems(0, [...page().strokes], []);
	v.setPageLocked(page(), true);
	await frames(2);
	q<HTMLElement>('[data-action="selection-join"]')?.click();
	await frames(3);
	add("a locked page refuses the join and keeps its strokes", page().strokes.length === 17 && page().strokes.every((s, i) => s === all[i]));
	v.setPageLocked(page(), false);
	await frames(2);

	// --- the page that stays for the screenshot ---
	v.selectItems(0, [...page().strokes], []);
	await frames(2);
	q<HTMLElement>('[data-action="selection-join"]')?.click();
	await frames(4);
	add("the joined page stays selected, with the action in the bar", page().strokes.length === 13 && !!q('[data-action="selection-join"]'));
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length } };
}
