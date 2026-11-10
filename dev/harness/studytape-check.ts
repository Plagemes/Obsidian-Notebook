/**
 * Smoke check of the study tape (0.29, roadmap #10, format v27) on the `doc=studytape` notebook (the blank "New" notebook;
 * HARNESS_DOC=studytape npm run harness:check): the real view, pointer path, renderer and History with the synthetic pen and finger.
 * "Study tape" (All actions) turns the mode on; a pen drag over written answers lays one opaque tape (an element, no ink) as one undo step;
 * a tap reveals it (the page shows the answer again) and a tap hides it; with the mode off a pen tap still reveals or hides, a pen drag that
 * starts on a hidden tape writes nothing, and a finger that pans taps a tape too; "Reveal all" / "Hide all" act on every tape; the reveal
 * state is never written to the file. `studytapeShot` leaves the page for the screenshots: two tapes hidden, or one of them revealed.
 */
import { AddElement, AddStroke, Batch, EraseStrokes, RemoveElement } from "../../src/model/history";
import { parse, serialize } from "../../src/model/serialize";
import { tapesOf } from "../../src/model/tape";
import { RENDER_INK, type NotebookDocument, type Page, type Point, type Stroke, type TapeElement } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface StudytapeCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; pressure?: number; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface TapeView {
	document: NotebookDocument;
	currentPage(): number;
	applyCommand(command: unknown): void;
	runAction(id: string): void;
	uiContext(): { tapes?: { drawing: boolean; total: number; revealed: number } };
	tapeTools: { drawing: boolean; reveal: { isRevealed(id: string): boolean; hideAll(): boolean }; hideAll(): void } | null;
	viewport: { scale: number; offsetX: number; offsetY: number };
	layout: { boxes: Array<{ x: number; y: number }> };
	selection: { strokes: Stroke[]; elements: unknown[] } | null;
	undo(): void;
	redo(): void;
}

const pt = (x: number, y: number): Point => [Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0.55];
const ring = (cx: number, cy: number, r: number, n = 18): Point[] => Array.from({ length: n + 1 }, (_, i) => pt(cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)));
const bar = (x: number, y0: number, y1: number): Point[] => Array.from({ length: 5 }, (_, i) => pt(x, y0 + ((y1 - y0) * i) / 4));
let seq = 0;
const make = (points: Point[], color = "#1f2933"): Stroke => ({ id: `tp-${++seq}`, tool: "pen", color, width: 2, render: RENDER_INK, points });
/** A "word": `n` letters, each a small loop with a stem, about 20 pt tall. */
const word = (x: number, y: number, n = 4, color?: string): Stroke[] =>
	Array.from({ length: n }, (_, k) => [make(ring(x + 8 + k * 20, y + 12, 7), color), make(bar(x + 16 + k * 20, y + 2, y + 22), color)]).flat();

/** Two questions with their answers written to the right (the answers are what the tapes cover). */
function worksheet(): Stroke[] {
	return [...word(60, 180, 5), ...word(250, 180, 4, "#2563eb"), ...word(60, 250, 4), ...word(250, 250, 5, "#2563eb")];
}

async function reset(api: StudytapeCheckApi): Promise<{ v: TapeView; page: () => Page }> {
	const v = api.view as TapeView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const p = page();
	for (const t of [...tapesOf(p)].reverse()) v.applyCommand(new RemoveElement(p.id, t));
	if (p.strokes.length > 0) v.applyCommand(new EraseStrokes(p.id, [...p.strokes].reverse().map((stroke) => ({ stroke, index: p.strokes.indexOf(stroke) }))));
	const strokes = worksheet();
	v.applyCommand(new Batch("Write", strokes.map((s, i) => new AddStroke(p.id, s, p.strokes.length + i))));
	v.tapeTools?.hideAll();
	if (v.tapeTools?.drawing) v.runAction("study-tape");
	api.setTool("pen");
	await api.frames(3);
	return { v, page };
}

export async function checkStudytape(api: StudytapeCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const { v, page } = await reset(api);
	const tapes = (): TapeElement[] => tapesOf(page());
	const tools = () => v.tapeTools;
	/** A point of the page in view as fractions of the stage (what the synthetic pen takes). */
	const frac = (x: number, y: number): [number, number] => {
		const r = document.querySelector(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	const drag = (pts: Array<[number, number]>, pointerType = "pen") => api.penStroke(pts.map(([x, y]) => frac(x, y)), { steps: 10, pointerType });
	const tap = (x: number, y: number, pointerType = "pen") => api.penStroke([frac(x, y)], { pointerType });
	const revealed = (t: TapeElement | undefined) => !!t && tools()?.reveal.isRevealed(t.id) === true;

	add("the view has the study tape tools", !!tools());
	add("the notebook starts with no tape, and Reveal all / Hide all are not offered", tapes().length === 0 && (v.uiContext().tapes?.total ?? -1) === 0);

	// --- the mode ---
	const strokes = page().strokes.length;
	v.runAction("study-tape");
	await api.frames(2);
	add("Study tape turns the mode on, with a notice", tools()?.drawing === true && api.notices.some((n) => /study tape/i.test(n)), api.notices[api.notices.length - 1] ?? "");
	await drag([[244, 172], [370, 210]]);
	await sleep(150);
	add("a pen drag over an answer lays one tape and writes no ink", tapes().length === 1 && page().strokes.length === strokes, `${tapes().length} tapes, ${page().strokes.length - strokes} strokes`);
	const first = tapes()[0];
	add("the tape covers the dragged rectangle, in the colour of the setting", !!first && first.width > 100 && first.height > 30 && /^#[0-9a-f]{6}$/i.test(first.color), JSON.stringify(first));
	await drag([[244, 242], [380, 282]]);
	await sleep(150);
	const second = tapes()[1];
	add("a second drag lays a second tape", tapes().length === 2);
	await tap(300, 190);
	await sleep(100);
	add("in the mode a tap on a tape reveals it, and lays nothing", revealed(first) && tapes().length === 2);
	await tap(300, 190);
	await sleep(100);
	add("a second tap hides it again", !revealed(first));
	v.runAction("study-tape");
	await api.frames(2);
	add("running Study tape again turns the mode off", tools()?.drawing === false);

	// --- the pen, the mode off ---
	await tap(300, 262);
	await sleep(100);
	add("with the pen, a tap on a hidden tape reveals it", revealed(second));
	const inkBefore = page().strokes.length;
	await tap(300, 262);
	await sleep(100);
	add("a tap on a revealed tape hides it and leaves no dot", !revealed(second) && page().strokes.length === inkBefore, `${page().strokes.length - inkBefore} strokes`);
	await drag([[260, 255], [360, 270]]);
	await sleep(150);
	add("a pen drag that starts on a hidden tape writes nothing (no ink where nobody can see it)", page().strokes.length === inkBefore, `${page().strokes.length - inkBefore} strokes`);
	await drag([[60, 330], [200, 335]]);
	await sleep(150);
	add("ink away from the tapes is written as usual", page().strokes.length === inkBefore + 1);

	// --- a finger that pans (after the palm-rejection time: a touch right after the pen is a palm and reveals nothing) ---
	await tap(300, 190, "touch");
	await sleep(120);
	add("a finger tap right after the pen is taken for the palm and reveals nothing", !revealed(first));
	await sleep(700);
	await tap(300, 190, "touch");
	await sleep(120);
	add("a finger tap reveals a tape", revealed(first));
	await tap(300, 190, "touch");
	await sleep(120);
	add("a second finger tap hides it", !revealed(first));

	// --- reveal all / hide all ---
	add("Reveal all is offered while a tape is hidden", (v.uiContext().tapes?.total ?? 0) === 2 && (v.uiContext().tapes?.revealed ?? -1) === 0);
	v.runAction("tapes-reveal-all");
	await api.frames(2);
	add("Reveal all reveals every tape", revealed(first) && revealed(second));
	v.runAction("tapes-hide-all");
	await api.frames(2);
	add("Hide all covers them again", !revealed(first) && !revealed(second));

	// --- the history and the file ---
	v.undo();
	await api.frames(2);
	v.undo();
	await api.frames(2);
	add("undo takes the ink, then the last tape away", tapes().length === 1, String(tapes().length));
	v.redo();
	await api.frames(2);
	add("redo brings the very same tape back", tapes()[1] === second);
	v.redo();
	await api.frames(2);
	v.runAction("tapes-reveal-all");
	const text = serialize(v.document);
	const back = parse(text);
	add("the writer and the reader keep the tapes, and never the reveal state", back.ok && tapesOf(back.doc.pages[v.currentPage()]!).length === 2 && !text.includes("revealed") && /"type":"tape"/.test(text));
	v.runAction("tapes-hide-all");
	await api.frames(2);

	// --- review fixes T1 / T2: the eraser keeps covered ink, the lasso takes it ---
	const inBox = (s: Stroke) => s.points.every(([x, y]) => x >= 244 && x <= 390 && y >= 242 && y <= 280);
	const covered = page().strokes.filter(inBox).length;
	const before = page().strokes.length;
	api.setTool("eraser");
	await api.frames(2);
	await drag([[225, 262], [410, 263]]);
	await sleep(150);
	add("the eraser rubbed across a hidden tape erases nothing under it, and says why", page().strokes.length === before && api.notices.some((n) => /reveal/i.test(n)), `${before - page().strokes.length} erased`);
	api.setTool("lasso");
	await api.frames(2);
	await drag([[232, 232], [402, 232], [402, 292], [232, 292], [232, 232]]);
	await sleep(150);
	const sel = v.selection;
	const picked = sel?.strokes.filter(inBox).length ?? 0;
	add("a lasso around a hidden tape selects the tape and the covered answer with it", covered > 0 && picked === covered && (sel?.elements.includes(second) ?? false), `${picked}/${covered} covered strokes`);
	api.setTool("pen");
	await api.frames(2);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { tapes: tapes().map((t) => [t.x, t.y, t.width, t.height, t.color]) } };
}

/** Rebuilds the page for a screenshot: both tapes hidden, or the first one revealed (its answer readable, a dashed outline left). */
export async function studytapeShot(api: StudytapeCheckApi, state: "hidden" | "revealed"): Promise<void> {
	const { v, page } = await reset(api);
	const p = page();
	const mk = (id: string, x: number, y: number, w: number, h: number, color: string): TapeElement => ({ id, type: "tape", x, y, width: w, height: h, color });
	v.applyCommand(new AddElement(p.id, mk(`shot-tape-${++seq}`, 244, 172, 126, 38, "#8fd3bf"), (p.elements ?? []).length));
	v.applyCommand(new AddElement(p.id, mk(`shot-tape-${++seq}`, 244, 242, 146, 38, "#f2aebf"), (p.elements ?? []).length));
	await api.frames(2);
	if (state === "revealed") {
		// A pen tap on the first tape: the real pointer path reveals it.
		const r = document.querySelector(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		await api.penStroke([[(v.viewport.offsetX + (box.x + 300) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + 190) * v.viewport.scale) / r.height]], { pointerType: "pen" });
	}
	await api.frames(4);
}
