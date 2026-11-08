/**
 * Smoke check of "Align to baseline" (0.25, roadmap #93) on the `doc=baseline` notebook (the blank "New" notebook;
 * HARNESS_DOC=baseline npm run harness:check): the real view and History. A page holds two lines of synthetic handwriting (words with
 * ascenders, descenders and i dots) whose words are written crooked, an underline and a drawing. They are selected and "Align to
 * baseline" is run (the button of the contextual bar where the bar has room for it, else the registry handler the sheet and the
 * command use): the words of each line end on one baseline, the underline and the drawing stay the very same strokes, the ink only
 * moves in y, one undo gives the page back and a redo does it again, a second run finds nothing, the page times do not move and a
 * locked page refuses it. On ruled paper the words go onto the ruled line. `baselineShot` leaves the page for the screenshots.
 */
import { analyseBaseline, ruledLines, wordBaseline } from "../../src/ink/baseline";
import { AddStroke, Batch, ReplaceStroke } from "../../src/model/history";
import { pageTimes } from "../../src/model/page-times";
import { paperCommand } from "../../src/model/page-ops";
import { RENDER_INK, type Page, type Point, type Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface BaselineCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface BaselineView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
	selection: { strokes: Stroke[] } | null;
	setPageLocked(page: Page, value: boolean): boolean;
	selectionTools?: { alignBaseline(): void };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const pt = (x: number, y: number): Point => [r2(x), r2(y), 0.55];
const line = (a: [number, number], b: [number, number], n = 10): Point[] => Array.from({ length: n + 1 }, (_, i) => pt(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n));
const loop = (cx: number, cy: number, rx: number, ry: number, n = 24): Point[] => Array.from({ length: n + 1 }, (_, i) => {
	const a = Math.PI / 2 + (i / n) * 2 * Math.PI;
	return pt(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
});

/** Writing about twice the size of the unit tests' (x-height 14, ascender 28, descender 11): a readable harness picture. */
const XH = 14;
const ASC = 28;
const DESC = 11;

let seq = 0;
const make = (points: Point[]): Stroke => ({ id: `bl-${++seq}`, tool: "pen", color: "#1f2933", width: 2, render: RENDER_INK, points });

function letter(ch: string, x: number, base: number): Stroke[] {
	if ("gypqj".includes(ch)) return [make(loop(x + 5, base - XH / 2, 5, XH / 2)), make([...line([x + 10, base - XH], [x + 10, base + DESC]), ...line([x + 10, base + DESC], [x + 4, base + DESC + 1], 4)])];
	if ("hbdk".includes(ch)) return [make(line([x + 1, base - ASC], [x + 1, base])), make(loop(x + 6.5, base - XH / 2, 5, XH / 2))];
	if ("lft".includes(ch)) return [make(line([x + 1, base - ASC], [x + 1, base])), ...(ch === "l" ? [] : [make(line([x - 3, base - XH], [x + 7, base - XH], 6))])];
	if (ch === "i") return [make(line([x + 1, base - XH], [x + 1, base], 8)), make([pt(x + 1, base - XH - 7), pt(x + 1.3, base - XH - 6.4), pt(x + 1, base - XH - 6)])];
	return [make(loop(x + 5, base - XH / 2, 5, XH / 2))];
}

function word(text: string, x: number, base: number): { strokes: Stroke[]; end: number } {
	const strokes: Stroke[] = [];
	let at = x;
	for (const ch of text) {
		strokes.push(...letter(ch, at, base));
		at += "iltfjr".includes(ch) ? 6 : 13;
	}
	return { strokes, end: at };
}

const LINES: Array<{ words: string[]; base: number; wobble: number[] }> = [
	{ words: ["the", "quick", "brown", "fox"], base: 150, wobble: [0, 6, -5, 4] },
	{ words: ["jumps", "over", "lazy", "dogs"], base: 230, wobble: [3, -4, 5, -3] },
];

interface Scene {
	strokes: Stroke[];
	handwriting: Stroke[];
	underline: Stroke;
	drawing: Stroke;
	words: Array<{ strokes: Stroke[]; base: number }>;
}

function scene(shift = 0): Scene {
	const words: Scene["words"] = [];
	for (const l of LINES) {
		let x = 50;
		l.words.forEach((text, i) => {
			const base = l.base + shift + l.wobble[i]!;
			const w = word(text, x, base);
			words.push({ strokes: w.strokes, base });
			x = w.end + 20;
		});
	}
	const handwriting = words.flatMap((w) => w.strokes);
	const underline = make(line([50, 262 + shift], [250, 263 + shift], 30));
	const drawing = make(loop(430, 190 + shift, 50, 60, 40));
	return { strokes: [...handwriting, underline, drawing], handwriting, underline, drawing, words };
}

export async function checkBaseline(api: BaselineCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as BaselineView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const run = async (): Promise<boolean> => {
		const button = q<HTMLElement>('[data-action="selection-baseline"]');
		if (button) button.click();
		else v.selectionTools?.alignBaseline();
		await frames(4);
		return !!button;
	};
	/** Spread of the estimated baselines of the words of each line (pt). */
	const spread = (s: Scene): number[] => LINES.map((l, k) => {
		const mine = s.words.slice(k * l.words.length, (k + 1) * l.words.length);
		const bases = mine.map((w) => wordBaseline(w.strokes.map((st) => page().strokes.find((p) => p.id === st.id) ?? st), 14));
		return Math.max(...bases) - Math.min(...bases);
	});

	// --- the page ---
	const s = scene();
	v.applyCommand(new Batch("Draw", s.strokes.map((st, i) => new AddStroke(page().id, st, i))));
	await frames(3);
	add("the page holds the handwriting, an underline and a drawing", page().strokes.length === s.strokes.length && page().strokes.every((st, i) => st === s.strokes[i]), `${page().strokes.length} strokes`);
	const before = spread(s);
	add("the words are written crooked (the baselines of a line differ by several pt)", before.every((d) => d > 6), before.join(", "));
	const analysis = analyseBaseline(page(), page().strokes);
	add("the analysis finds 8 words on 2 lines and leaves the underline and the drawing alone", analysis.words === 8 && analysis.lines === 2 && analysis.skipped >= 2 && analysis.moves.every((m) => !m.strokes.includes(s.underline) && !m.strokes.includes(s.drawing)), `${analysis.words} words, ${analysis.lines} lines, ${analysis.skipped} skipped`);

	// --- one stroke is not enough ---
	v.selectItems(0, [s.handwriting[0]!], []);
	await frames(2);
	add("with one stroke selected the bar does not offer Align to baseline", !q('[data-action="selection-baseline"]'));

	// --- the action ---
	const times = JSON.stringify(pageTimes(page()));
	v.selectItems(0, [...page().strokes], []);
	await frames(3);
	const notices0 = api.notices.length;
	const fromBar = await run();
	const after = [...page().strokes];
	add("the page keeps all its strokes, in order and with the same ids", after.length === s.strokes.length && after.every((st, i) => st.id === s.strokes[i]!.id));
	add("the underline and the drawing are the very same strokes", after.includes(s.underline) && after.includes(s.drawing));
	const moved = after.filter((st, i) => st !== s.strokes[i]);
	add("the handwriting moved", moved.length > 0 && moved.every((st) => s.handwriting.some((h) => h.id === st.id)), `${moved.length} strokes`);
	add("the ink only moved in y: same x, pressure, width, colour and number of points", moved.every((st) => {
		const o = s.strokes.find((x) => x.id === st.id)!;
		return st.points.length === o.points.length && st.points.every((p, k) => p[0] === o.points[k]![0] && p[2] === o.points[k]![2]) && st.width === o.width && st.color === o.color;
	}));
	const sp = spread(s);
	add("the words of each line now sit on one baseline", sp.every((d) => d <= 2.5), sp.join(", "));
	add("a notice tells how many words were aligned", api.notices.slice(notices0).some((m) => /\d/.test(m)), api.notices.slice(notices0).join(" | "));
	add("the selection stays on the moved strokes", (v.selection?.strokes.length ?? 0) === s.strokes.length && (v.selection?.strokes ?? []).every((st) => page().strokes.includes(st)));
	add("the page times did not move (ink moved, not written)", JSON.stringify(pageTimes(page())) === times);
	const aligned = [...page().strokes];

	// --- one undo step ---
	v.undo();
	await frames(3);
	add("one undo puts every stroke back, as the very same objects", page().strokes.every((st, i) => st === s.strokes[i]));
	v.redo();
	await frames(3);
	add("one redo aligns them again", page().strokes.every((st, i) => st === aligned[i]));

	// --- a second run finds nothing ---
	v.selectItems(0, [...page().strokes], []);
	await frames(2);
	const notices1 = api.notices.length;
	await run();
	add("a second run changes nothing and says so", page().strokes.every((st, i) => st === aligned[i]) && api.notices.slice(notices1).length >= 1, api.notices.slice(notices1).join(" | "));

	// --- a locked page refuses it ---
	v.undo();
	await frames(2);
	v.selectItems(0, [...page().strokes], []);
	v.setPageLocked(page(), true);
	await frames(2);
	await run();
	add("a locked page refuses the step and keeps its strokes", page().strokes.every((st, i) => st === s.strokes[i]));
	v.setPageLocked(page(), false);
	await frames(2);

	// --- ruled paper ---
	const paper = paperCommand(v.document, [page().id], "ruled");
	if (paper) v.applyCommand(paper);
	await frames(3);
	const rules = ruledLines(page());
	add("the page is on ruled paper", !!rules && page().paper.kind === "ruled");
	v.selectItems(0, [...page().strokes], []);
	await frames(2);
	await run();
	const ruled = rules ?? [];
	const onRule = s.words.every((w) => {
		const b = wordBaseline(w.strokes.map((st) => page().strokes.find((p) => p.id === st.id) ?? st), 14);
		return ruled.some((r) => Math.abs(b + 1 - r) <= 3);
	});
	add("on ruled paper every word sits on a ruled line", onRule);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { fromBar, strokes: page().strokes.length } };
}

/** Rebuilds the page for a screenshot: crooked words selected (`before`), aligned (`after`), or aligned on ruled paper (`ruled`). */
export async function baselineShot(api: BaselineCheckApi, state: "before" | "after" | "ruled"): Promise<void> {
	await api.open("baseline");
	const v = api.view as BaselineView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	// The check left its own strokes and the ruled paper on the page (the notebook stays open): start from a clean blank page.
	const old = [...page().strokes];
	if (old.length > 0) v.applyCommand(new Batch("Clear", old.map((st, i) => new ReplaceStroke(page().id, st, [], i)).reverse()));
	const wanted = paperCommand(v.document, [page().id], state === "ruled" ? "ruled" : "blank");
	if (wanted) v.applyCommand(wanted);
	await api.frames(3);
	const rules = ruledLines(page());
	// On ruled paper the first crooked line starts a little off a ruled line, the way a hand drifts.
	const first = rules ? rules.find((r) => r > 140) ?? 150 : 150;
	const s = scene(rules ? first - 150 + 3 : 0);
	v.applyCommand(new Batch("Draw", s.strokes.map((st, i) => new AddStroke(page().id, st, i))));
	await api.frames(3);
	v.selectItems(0, [...page().strokes], []);
	await api.frames(3);
	if (state !== "before") {
		const button = document.querySelector<HTMLElement>('[data-action="selection-baseline"]');
		if (button) button.click();
		else v.selectionTools?.alignBaseline();
		await api.frames(4);
	}
}
