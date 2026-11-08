/**
 * Smoke check of "Tidy up" (0.26, roadmap #238) on the `doc=tidy` notebook (the blank "New" notebook; HARNESS_DOC=tidy npm run
 * harness:check): the real view, History and the sheet. A page holds synthetic handwriting: two paragraphs whose lines are written a
 * little crooked and start at slightly different margins, with a big hole between them, an underlined heading and a drawing. The
 * page's "Tidy up page" opens the sheet (steps, counts, summary), Cancel leaves the page as it was, "Tidy up" straightens the words,
 * lines up the starts and closes the hole in ONE undo step (the drawing and the heading stay the very same strokes), a second run
 * has nothing to do, the choices are remembered, and a locked page disables the button. With a selection the bar's button (or the
 * registry handler) opens the same sheet for the selection only. `tidyShot` leaves the page for the screenshots.
 */
import { AddStroke, Batch, ReplaceStroke } from "../../src/model/history";
import { pageTimes } from "../../src/model/page-times";
import { RENDER_INK, type Page, type Point, type Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface TidyCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface TidyView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
	clearSelection(): void;
	selection: { strokes: Stroke[] } | null;
	setPageLocked(page: Page, value: boolean): boolean;
	selectionTools?: { tidy(pageIndex?: number): void };
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
const make = (points: Point[], over: Partial<Stroke> = {}): Stroke => ({ id: `td-${++seq}`, tool: "pen", color: "#1f2933", width: 2, render: RENDER_INK, points, ...over });

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

const WORDS = ["the", "quick", "brown", "fox", "jumps"];

interface Row {
	strokes: Stroke[];
	base: number;
}

/** A line of words from x0 on, each word `wobble[i]` pt off the line's baseline. */
function row(base: number, x0: number, wobble: number[]): Row {
	const strokes: Stroke[] = [];
	let x = x0;
	WORDS.forEach((w, i) => {
		const made = word(w, x, base + wobble[i]!);
		strokes.push(...made.strokes);
		x = made.end + 20;
	});
	return { strokes, base };
}

interface Scene {
	strokes: Stroke[];
	rows: Row[];
	underline: Stroke;
	drawing: Stroke;
}

/** Two paragraphs (three lines, a big hole, two lines), crooked words, starts 0-9 pt apart, an underline and a drawing beside them. */
function scene(): Scene {
	const bases = [110, 165, 220, 520, 575];
	const starts = [50, 58, 46, 54, 50];
	const wobbles = [[0, 6, -5, 4, -3], [3, -4, 5, -3, 4], [0, 0, 0, 0, 0], [-4, 5, 0, 4, -3], [0, 0, 0, 0, 0]];
	const rows = bases.map((b, i) => row(b, starts[i]!, wobbles[i]!));
	// An underline under the last line: it keeps that line where it is (a line with something on it is not moved).
	const underline = make(line([50, 590], [320, 591], 30));
	const drawing = make(loop(520, 330, 55, 70, 40));
	return { strokes: [...rows.flatMap((r) => r.strokes), underline, drawing], rows, underline, drawing };
}

const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-tidy-panel");

export async function checkTidy(api: TidyCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as TidyView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const open = async (): Promise<HTMLElement | null> => {
		v.selectionTools?.tidy(v.currentPage());
		await frames(3);
		return modal();
	};
	const click = async (el: Element | null | undefined): Promise<void> => {
		(el as HTMLElement | null | undefined)?.click();
		await frames(3);
	};
	const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".notebook-tidy-panel .nb-modal-foot button")];
	const primary = (): HTMLButtonElement | undefined => buttons().find((b) => b.classList.contains("is-primary"));
	const secondary = (): HTMLButtonElement | undefined => buttons().find((b) => b.classList.contains("is-secondary"));
	const boxes = (): HTMLInputElement[] => [...document.querySelectorAll<HTMLInputElement>(".notebook-tidy-panel input[type=checkbox]")];

	// --- the page ---
	const s = scene();
	v.applyCommand(new Batch("Draw", s.strokes.map((st, i) => new AddStroke(page().id, st, i))));
	await frames(3);
	add("the page holds the handwriting, an underline and a drawing", page().strokes.length === s.strokes.length && page().strokes.every((st, i) => st === s.strokes[i]), `${page().strokes.length} strokes`);
	const times = JSON.stringify(pageTimes(page()));
	const original = [...page().strokes];

	// --- the sheet ---
	const sheet = await open();
	add("Tidy up page opens the sheet", !!sheet);
	add("the sheet has the three steps and Keep paragraph breaks, all on", boxes().length === 4 && boxes().every((b) => b.checked), `${boxes().length} boxes`);
	add("each step shows how many things it would change", [...document.querySelectorAll(".notebook-tidy-count")].filter((e) => /\d/.test(e.textContent ?? "")).length === 3, [...document.querySelectorAll(".notebook-tidy-count")].map((e) => e.textContent).join(" | "));
	add("the sheet summarises what will change and offers Tidy up", /\d/.test(q(".notebook-tidy-summary")?.textContent ?? "") && !!primary() && !primary()!.disabled, q(".notebook-tidy-summary")?.textContent ?? "");
	// Switching steps off changes the counts.
	await click(boxes()[0]);
	const baselineCount = q(".notebook-tidy-step-baseline .notebook-tidy-count")?.textContent ?? "x";
	add("switching a step off clears its count", baselineCount === "");
	await click(boxes()[0]);
	// Cancel leaves the page as it was.
	await click(secondary());
	add("Cancel closes the sheet and leaves every stroke the very same object", !modal() && page().strokes.every((st, i) => st === original[i]));

	// --- tidy up ---
	await open();
	const notices0 = api.notices.length;
	await click(primary());
	add("Tidy up closes the sheet", !modal());
	const after = [...page().strokes];
	add("the page keeps all its strokes, in order and with the same ids", after.length === s.strokes.length && after.every((st, i) => st.id === s.strokes[i]!.id));
	add("the underline's line and the drawing did not move", after.includes(s.underline) && after.includes(s.drawing));
	const moved = after.filter((st, i) => st !== original[i]);
	add("the handwriting moved", moved.length > 0, `${moved.length} strokes`);
	add("it moved rigidly: same points, pressure, width and colour", moved.every((st) => {
		const o = s.strokes.find((x) => x.id === st.id)!;
		const dx = st.points[0]![0] - o.points[0]![0];
		const dy = st.points[0]![1] - o.points[0]![1];
		return st.points.length === o.points.length && st.points.every((p, k) => Math.abs(p[0] - o.points[k]![0] - dx) < 0.02 && Math.abs(p[1] - o.points[k]![1] - dy) < 0.02 && p[2] === o.points[k]![2]) && st.width === o.width && st.color === o.color;
	}));
	const firstOf = (r: Row, list: readonly Stroke[]): Stroke => list.find((st) => st.id === r.strokes[0]!.id)!;
	const lefts = s.rows.slice(0, 4).map((r) => {
		const st = firstOf(r, after);
		return st.points[0]![0];
	});
	const tops = s.rows.map((r) => firstOf(r, after).points[0]![1] - firstOf(r, original).points[0]![1]);
	add("the first four lines now start at one margin", Math.max(...lefts) - Math.min(...lefts) <= 1.5, lefts.join(", "));
	add("the hole between the paragraphs shrank", tops[3]! < -100, tops.map((n) => Math.round(n)).join(", "));
	add("a notice tells what was tidied", api.notices.slice(notices0).some((m) => /\d/.test(m)), api.notices.slice(notices0).join(" | "));
	add("the page times did not move (ink moved, not written)", JSON.stringify(pageTimes(page())) === times);
	const tidied = [...page().strokes];

	// --- one undo step ---
	v.undo();
	await frames(3);
	add("one undo puts every stroke back, as the very same objects", page().strokes.every((st, i) => st === original[i]));
	v.redo();
	await frames(3);
	add("one redo tidies again", page().strokes.every((st, i) => st === tidied[i]));

	// --- a second run finds nothing ---
	await open();
	add("a second run has nothing to do: the summary says so and Tidy up is disabled", !!primary()?.disabled && /./.test(q(".notebook-tidy-summary")?.textContent ?? ""), q(".notebook-tidy-summary")?.textContent ?? "");
	// --- remembered choices ---
	await click(boxes()[1]);
	await click(secondary());
	await open();
	add("the choices are remembered", boxes()[1]?.checked === false, boxes().map((b) => b.checked).join(","));
	await click(boxes()[1]);
	await click(secondary());

	// --- a locked page ---
	v.undo();
	await frames(3);
	v.setPageLocked(page(), true);
	await frames(2);
	await open();
	add("on a locked page the sheet says so and Tidy up is disabled", !!primary()?.disabled && /lock/i.test(q(".notebook-tidy-summary")?.textContent ?? ""), q(".notebook-tidy-summary")?.textContent ?? "");
	await click(secondary());
	v.setPageLocked(page(), false);
	await frames(2);

	// --- a selection ---
	v.selectItems(0, [s.rows[2]!.strokes[0]!], []);
	await frames(2);
	add("with one stroke selected the bar does not offer Tidy up", !q('[data-action="selection-tidy"]'));
	v.selectItems(0, [...s.rows[3]!.strokes, ...s.rows[4]!.strokes, ...s.rows[2]!.strokes], []);
	await frames(3);
	const button = q<HTMLElement>('[data-action="selection-tidy"]');
	if (button) button.click();
	else v.selectionTools?.tidy();
	await frames(3);
	add("with a selection the sheet is for the selection", !!modal() && /\d/.test(q(".notebook-tidy-scope")?.textContent ?? ""), q(".notebook-tidy-scope")?.textContent ?? "");
	await click(primary());
	const rest = page().strokes.filter((st, i) => st !== original[i]);
	add("only the selected lines moved, and they stay selected", rest.length > 0 && rest.every((st) => [...s.rows[2]!.strokes, ...s.rows[3]!.strokes, ...s.rows[4]!.strokes].some((x) => x.id === st.id)) && (v.selection?.strokes.length ?? 0) > 0);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { fromBar: !!button, strokes: page().strokes.length } };
}

/** Rebuilds the page for a screenshot: crooked page (`before`), the sheet open over it (`sheet`), or the page tidied (`after`). */
export async function tidyShot(api: TidyCheckApi, state: "before" | "sheet" | "after"): Promise<void> {
	await api.open("tidy");
	const v = api.view as TidyView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	document.querySelector<HTMLElement>(".notebook-tidy-panel .nb-modal-close")?.click();
	document.querySelectorAll(".harness-modal-container").forEach((e) => { if (e.childElementCount === 0) e.remove(); });
	if (page().locked) v.setPageLocked(page(), false);
	// The check left its own strokes on the page (the notebook stays open): start from a clean blank page.
	const old = [...page().strokes];
	if (old.length > 0) v.applyCommand(new Batch("Clear", old.map((st, i) => new ReplaceStroke(page().id, st, [], i)).reverse()));
	v.clearSelection();
	await api.frames(2);
	const s = scene();
	v.applyCommand(new Batch("Draw", s.strokes.map((st, i) => new AddStroke(page().id, st, i))));
	await api.frames(3);
	if (state === "before") return;
	v.selectionTools?.tidy(v.currentPage());
	await api.frames(3);
	// The stub modal sits loose in the body: put it in the harness container so it is drawn like Obsidian's.
	const box = modal();
	if (box && !box.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(box);
	await api.frames(2);
	if (state === "sheet") return;
	document.querySelector<HTMLElement>(".notebook-tidy-panel .nb-modal-foot .is-primary")?.click();
	await api.frames(4);
}
