/**
 * Smoke check of "Smooth strokes" and "Straighten strokes" (0.26, roadmap #66) on the `doc=smooth` notebook (the blank "New" notebook;
 * HARNESS_DOC=smooth npm run harness:check): the real view and History. A page holds shaky handwriting (a wavy line, an L, a loop), a
 * wobbly underline and a highlighter stroke. They are selected and Smooth is run through the handler the sheet and the command use
 * (`selectionTools.reshape`): the pen strokes change, the highlighter is the very same object, the end points, the number of points and
 * the pressure stay, one undo gives the page back; a second run changes less; Straighten makes the underline a clean line and leaves the
 * curves alone; the page times do not move and a locked page refuses it. `smoothShot` leaves the page for the screenshots.
 */
import { smoothedPoints } from "../../src/ink/smooth";
import { AddStroke, Batch, ReplaceStroke } from "../../src/model/history";
import { pageTimes } from "../../src/model/page-times";
import { RENDER_INK, type Page, type Point, type Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface SmoothCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface SmoothView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
	selection: { strokes: Stroke[] } | null;
	setPageLocked(page: Page, value: boolean): boolean;
	selectionTools?: { reshape(mode: "smooth" | "straighten"): void };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
/** Deterministic noise in [-1, 1]. */
const noise = (i: number, salt: number): number => {
	const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
	return (x - Math.floor(x)) * 2 - 1;
};
const shaky = (f: (t: number) => [number, number], n: number, amp: number, salt: number): Point[] => Array.from({ length: n + 1 }, (_, i) => {
	const [x, y] = f(i / n);
	const edge = i === 0 || i === n;
	return [r2(x + (edge ? 0 : amp * noise(i, salt))), r2(y + (edge ? 0 : amp * noise(i, salt + 1))), r2(0.3 + 0.4 * Math.sin((i / n) * Math.PI))] as Point;
});

let seq = 0;
const make = (points: Point[], tool: Stroke["tool"] = "pen", over: Partial<Stroke> = {}): Stroke => ({
	id: `sm-${++seq}`, tool, color: tool === "highlighter" ? "#f5d90a" : "#1f2933", width: tool === "highlighter" ? 14 : 2.5, render: RENDER_INK, points, ...over,
});

interface Scene { strokes: Stroke[]; pens: Stroke[]; wave: Stroke; ell: Stroke; loop: Stroke; underline: Stroke; marker: Stroke }

function scene(): Scene {
	const wave = make(shaky((t) => [60 + 240 * t, 130 + 26 * Math.sin(t * 4 * Math.PI)], 120, 1.1, 1));
	const ell = make([...shaky((t) => [90, 200 + 90 * t], 40, 0.9, 3).slice(0, -1), ...shaky((t) => [90 + 70 * t, 290], 40, 0.9, 5)]);
	const loop = make(shaky((t) => [330 + 45 * Math.cos(t * 2 * Math.PI), 270 + 45 * Math.sin(t * 2 * Math.PI)], 90, 1.0, 7));
	const underline = make(shaky((t) => [60 + 250 * t, 340 + 5 * t], 60, 1.4, 9));
	const marker = make(shaky((t) => [60 + 250 * t, 90], 20, 0, 11), "highlighter");
	const pens = [wave, ell, loop, underline];
	return { strokes: [marker, ...pens], pens, wave, ell, loop, underline, marker };
}

const rough = (pts: readonly Point[]): number => {
	let sum = 0;
	for (let i = 1; i < pts.length - 1; i++) sum += Math.hypot((pts[i - 1]![0] + pts[i + 1]![0]) / 2 - pts[i]![0], (pts[i - 1]![1] + pts[i + 1]![1]) / 2 - pts[i]![1]);
	return sum / (pts.length - 2);
};

export async function checkSmooth(api: SmoothCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as SmoothView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const run = async (mode: "smooth" | "straighten"): Promise<void> => {
		v.selectionTools?.reshape(mode);
		await frames(4);
	};
	const byId = (id: string): Stroke => page().strokes.find((st) => st.id === id)!;

	const s = scene();
	v.applyCommand(new Batch("Draw", s.strokes.map((st, i) => new AddStroke(page().id, st, i))));
	await frames(3);
	add("the page holds the shaky handwriting and the highlighter", page().strokes.length === s.strokes.length && page().strokes.every((st, i) => st === s.strokes[i]));
	const times = JSON.stringify(pageTimes(page()));

	// --- Smooth ---
	v.selectItems(0, [...page().strokes], []);
	await frames(3);
	const n0 = api.notices.length;
	await run("smooth");
	const after = [...page().strokes];
	add("the page keeps all its strokes, in order and with the same ids", after.length === s.strokes.length && after.every((st, i) => st.id === s.strokes[i]!.id));
	add("the highlighter is the very same stroke", after[0] === s.marker);
	add("the pen strokes were replaced", s.pens.every((p) => byId(p.id) !== p));
	add("every pen stroke is less rough, with the same ends, number of points and pressure", s.pens.every((p) => {
		const q = byId(p.id);
		return rough(q.points) < rough(p.points) && q.points.length === p.points.length
			&& q.points[0]!.every((c, k) => c === p.points[0]![k]) && q.points[q.points.length - 1]!.every((c, k) => c === p.points[p.points.length - 1]![k])
			&& q.points.every((pt, k) => pt[2] === p.points[k]![2]);
	}));
	add("the L keeps its corner", (() => {
		const c = byId(s.ell.id).points[40]!;
		return Math.abs(c[0] - 90) < 1.5 && Math.abs(c[1] - 290) < 1.5;
	})());
	add("a notice tells how many strokes were smoothed", api.notices.slice(n0).some((m) => /\d/.test(m)), api.notices.slice(n0).join(" | "));
	add("the selection stays on the smoothed strokes", (v.selection?.strokes.length ?? 0) === s.strokes.length && (v.selection?.strokes ?? []).every((st) => page().strokes.includes(st)));
	add("the page times did not move", JSON.stringify(pageTimes(page())) === times);

	// --- one undo step ---
	v.undo();
	await frames(3);
	add("one undo puts every stroke back, as the very same objects", page().strokes.every((st, i) => st === s.strokes[i]));
	v.redo();
	await frames(3);
	add("one redo smooths them again", page().strokes.every((st, i) => st === after[i]));

	// --- run again: bounded ---
	v.selectItems(0, [...page().strokes], []);
	await frames(2);
	await run("smooth");
	add("a second run moves no point by more than 2 pt", s.pens.every((p) => {
		const a = byId(p.id).points;
		const b = after.find((x) => x.id === p.id)!.points;
		return a.every((pt, k) => Math.hypot(pt[0] - b[k]![0], pt[1] - b[k]![1]) <= 2);
	}));

	// --- Straighten ---
	v.undo();
	await frames(2);
	v.undo();
	await frames(2);
	v.selectItems(0, [...page().strokes], []);
	await frames(2);
	await run("straighten");
	const u = byId(s.underline.id);
	const a = u.points[0]!;
	const b = u.points[u.points.length - 1]!;
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	add("Straighten makes the underline a clean line between its ends", u !== s.underline && u.points.every((p) => Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / len < 0.01));
	add("Straighten leaves the wave, the L, the loop and the highlighter alone", byId(s.wave.id) === s.wave && byId(s.ell.id) === s.ell && byId(s.loop.id) === s.loop && byId(s.marker.id) === s.marker);
	const straight = [...page().strokes];
	v.selectItems(0, [...page().strokes], []);
	await frames(2);
	const n1 = api.notices.length;
	await run("straighten");
	add("a second Straighten changes nothing and says so", page().strokes.every((st, i) => st === straight[i]) && api.notices.slice(n1).length >= 1, api.notices.slice(n1).join(" | "));
	add("smoothing is available again on the straightened page", smoothedPoints(byId(s.wave.id)) !== null);

	// --- a locked page refuses it ---
	v.undo();
	await frames(2);
	v.selectItems(0, [...page().strokes], []);
	v.setPageLocked(page(), true);
	await frames(2);
	await run("smooth");
	add("a locked page refuses the step and keeps its strokes", page().strokes.every((st, i) => st === s.strokes[i]));
	v.setPageLocked(page(), false);
	await frames(2);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length } };
}

/** Rebuilds the page for a screenshot: shaky handwriting selected (`before`), smoothed (`smooth`) or straightened (`straighten`). */
export async function smoothShot(api: SmoothCheckApi, state: "before" | "smooth" | "straighten"): Promise<void> {
	await api.open("smooth");
	const v = api.view as SmoothView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const old = [...page().strokes];
	if (old.length > 0) v.applyCommand(new Batch("Clear", old.map((st, i) => new ReplaceStroke(page().id, st, [], i)).reverse()));
	await api.frames(3);
	const s = scene();
	v.applyCommand(new Batch("Draw", s.strokes.map((st, i) => new AddStroke(page().id, st, i))));
	await api.frames(3);
	v.selectItems(0, [...page().strokes], []);
	await api.frames(3);
	if (state !== "before") {
		v.selectionTools?.reshape(state);
		await api.frames(4);
	}
}
