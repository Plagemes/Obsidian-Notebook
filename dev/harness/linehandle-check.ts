/**
 * Smoke check of "Reorder lines" (0.28, roadmap #256) on the `doc=linehandle` notebook (the blank "New" notebook;
 * HARNESS_DOC=linehandle npm run harness:check): the real view, History and the handles. A page holds five lines of synthetic
 * handwriting; the fourth has a locked box in its band. The mode (the registry action) shows a handle at the left of each line and the
 * bar (up, down, done); tapping a handle chooses its line and Down moves it one place; dragging a handle past two lines moves the line
 * there in ONE undo step (undo puts back the very same stroke objects, the page times do not move); the line with a locked box refuses
 * (the handle says so, the page is untouched); a locked page refuses; Escape and Done leave the mode. `linehandleShot` leaves the page
 * for the screenshots (handles at rest, a drag in progress, the page after the drop).
 */
import { AddStroke, Batch, ReplaceStroke } from "../../src/model/history";
import { pageTimes } from "../../src/model/page-times";
import { freezeElement } from "../../src/model/serialize";
import { RENDER_INK, type BoxElement, type Page, type Point, type Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface LinehandleCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface LinehandleView extends HarnessView {
	setPageLocked(page: Page, value: boolean): boolean;
	lineHandleTools: { active: boolean; start(): void; stop(): void; toggle(): void } | null;
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
const make = (points: Point[], over: Partial<Stroke> = {}): Stroke => ({ id: `lh-${++seq}`, tool: "pen", color: "#1f2933", width: 2, render: RENDER_INK, points, ...over });

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

const SENTENCES = [["the", "quick", "brown"], ["fox", "jumps", "over"], ["the", "lazy", "dog"], ["pack", "my", "box"], ["with", "five", "dozen"]];

/** Five lines, 65 pt apart. */
function lines(): Stroke[][] {
	return SENTENCES.map((words, i) => {
		const out: Stroke[] = [];
		let x = 56;
		for (const w of words) {
			const made = word(w, x, 120 + i * 65);
			out.push(...made.strokes);
			x = made.end + 20;
		}
		return out;
	});
}

/** A locked box at the right edge in the band of the fourth line. */
const lockedBox = (): BoxElement => freezeElement({ id: "lh-lock", type: "box", kind: "definition", x: 470, y: 120 + 3 * 65 - 20, width: 70, height: 26, locked: true, lockAt: 1 });

/** The top of the points of the strokes `row`, as they are in `list` (found by id). */
const topOf = (row: readonly Stroke[], list: readonly Stroke[]): number => Math.min(...row.map((s) => list.find((x) => x.id === s.id)!.points.reduce((m, p) => Math.min(m, p[1]), Infinity)));

export async function checkLinehandle(api: LinehandleCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as LinehandleView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const handles = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-key^="line-handle:"]')].filter((e) => !e.closest(".notebook-hidden"));
	const bar = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-key="line-handle-bar"]');
	const barButton = (key: string): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(`[data-key="${key}"]`);
	const centre = (el: HTMLElement): { x: number; y: number } => {
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	};
	const fire = (el: HTMLElement, type: string, x: number, y: number): void => {
		el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 41, pointerType: "touch", clientX: x, clientY: y, button: 0, isPrimary: true }));
	};
	const tap = async (el: HTMLElement): Promise<void> => {
		const c = centre(el);
		fire(el, "pointerdown", c.x, c.y);
		fire(el, "pointerup", c.x, c.y);
		await frames(3);
	};
	/** Drags a handle `dy` px with a few moves; `release` false leaves the contact down (for the screenshot). */
	const drag = async (el: HTMLElement, dy: number, release = true): Promise<void> => {
		const c = centre(el);
		fire(el, "pointerdown", c.x, c.y);
		for (let i = 1; i <= 6; i++) {
			fire(el, "pointermove", c.x, c.y + (dy * i) / 6);
			await frames(1);
		}
		await frames(2);
		if (release) {
			fire(el, "pointerup", c.x, c.y + dy);
			await frames(3);
		}
	};

	const rows = lines();
	const all = rows.flat();
	v.applyCommand(new Batch("Draw", [...all.map((st, i) => new AddStroke(page().id, st, i))]));
	await frames(3);
	page().elements = [...(page().elements ?? []), lockedBox()];
	await frames(2);
	add("the page holds five lines of writing", page().strokes.length === all.length, `${page().strokes.length} strokes`);
	const times = JSON.stringify(pageTimes(page()));
	const original = [...page().strokes];

	// --- the mode ---
	add("no handle is shown before the mode is on", handles().length === 0 && (bar() === null || bar()!.classList.contains("notebook-hidden")));
	v.runAction("page-reorder-lines");
	await frames(3);
	add("the registry action turns the mode on", v.lineHandleTools?.active === true && (v.uiContext() as unknown as { toggles: { lineHandles?: boolean } }).toggles.lineHandles === true);
	add("a handle is shown at the left of each of the five lines", handles().length === 5, `${handles().length} handles`);
	add("the handles are in the left margin, in line order", handles().every((h, i) => i === 0 || centre(h).y > centre(handles()[i - 1]!).y) && handles().every((h) => centre(h).x < window.innerWidth / 2));
	add("the bar shows the hint, Up, Down and Done", !!bar() && !bar()!.classList.contains("notebook-hidden") && !!barButton("line-handle-up") && !!barButton("line-handle-down") && !!barButton("line-handle-done"));
	add("Up and Down wait for a chosen line", barButton("line-handle-up")?.disabled === true && barButton("line-handle-down")?.disabled === true);
	add("the locked line's handle says it cannot move", handles()[3]?.classList.contains("is-blocked") === true && /lock/i.test(handles()[3]?.getAttribute("aria-label") ?? ""), handles()[3]?.getAttribute("aria-label") ?? "");
	add("every handle has a name and a long-press explanation", handles().every((h) => !!h.getAttribute("aria-label") && h.dataset.help === "help.lineHandle"));

	// --- tap and step ---
	await tap(handles()[1]!);
	add("a tap chooses the line (and enables the step buttons)", handles()[1]!.classList.contains("is-chosen") && barButton("line-handle-down")?.disabled === false && barButton("line-handle-up")?.disabled === false);
	const notices0 = api.notices.length;
	barButton("line-handle-down")!.click();
	await frames(4);
	const T = rows.map((r) => topOf(r, original));
	const now = (i: number): number => topOf(rows[i]!, page().strokes);
	add("Down moves the chosen line below the next one", now(1) > now(2), `${now(1).toFixed(0)} vs ${now(2).toFixed(0)}`);
	add("the two lines swapped places, the spacing kept", Math.abs(now(2) - T[1]!) < 0.05 && Math.abs(now(1) - (T[1]! + T[3]! - T[2]!)) < 0.05, `${now(2).toFixed(1)} / ${T[1]!.toFixed(1)}`);
	add("the line stays chosen at its new place and a notice says so", handles()[2]!.classList.contains("is-chosen") && api.notices.slice(notices0).length > 0, api.notices.slice(notices0).join(" | "));
	add("the page times did not move (ink moved, not written)", JSON.stringify(pageTimes(page())) === times);
	v.undo();
	await frames(3);
	add("one undo puts every stroke back, as the very same objects", page().strokes.length === original.length && page().strokes.every((st, i) => st === original[i]));
	v.redo();
	await frames(3);
	v.undo();
	await frames(3);

	// --- drag ---
	const before = [...page().strokes];
	await drag(handles()[0]!, 65 * 2 * (v.viewport.scale || 1) + 8);
	const moved = page().strokes.filter((st, i) => st !== before[i]);
	add("dragging the first handle past two lines moves that line to the third place", now(0) > now(2) && now(2) > now(1), `${now(0).toFixed(0)}`);
	add("the lines in between shifted up, each by the pitch it had", Math.abs(now(1) - T[0]!) < 0.05 && Math.abs(now(2) - (T[0]! + T[2]! - T[1]!)) < 0.05 && Math.abs(now(0) - (T[0]! + T[3]! - T[1]!)) < 0.05);
	add("the lines below stayed where they were", page().strokes.filter((st) => rows[3]!.some((x) => x.id === st.id) || rows[4]!.some((x) => x.id === st.id)).every((st) => before.includes(st)));
	add("it moved rigidly: same points, pressure, width and colour", moved.every((st) => {
		const o = all.find((x) => x.id === st.id)!;
		const dy = st.points[0]![1] - o.points[0]![1];
		return st.points.length === o.points.length && st.points.every((p, k) => p[0] === o.points[k]![0] && Math.abs(p[1] - o.points[k]![1] - dy) < 0.02 && p[2] === o.points[k]![2]) && st.width === o.width && st.color === o.color && st.id === o.id;
	}));
	add("the drag left the mode on and the handle at its line", v.lineHandleTools?.active === true && handles().length === 5);
	v.undo();
	await frames(3);
	add("one undo restores the whole drop", page().strokes.every((st, i) => st === before[i]));

	// --- refusals ---
	await tap(handles()[3]!);
	add("choosing the locked line says why it cannot move", api.notices.some((m) => /lock/i.test(m)), api.notices.slice(-2).join(" | "));
	const still = [...page().strokes];
	await drag(handles()[2]!, 65 * (v.viewport.scale || 1) + 4);
	add("moving a line onto the locked one is refused and nothing moves", page().strokes.every((st, i) => st === still[i]));
	await tap(handles()[3]!);
	await tap(handles()[2]!);
	barButton("line-handle-down")!.click();
	await frames(3);
	add("the step buttons refuse it too", page().strokes.every((st, i) => st === still[i]));

	v.setPageLocked(page(), true);
	await frames(3);
	await drag(handles()[0]!, 65 * (v.viewport.scale || 1) + 4);
	add("a locked page refuses the move", page().strokes.every((st, i) => st === still[i]));
	v.setPageLocked(page(), false);
	await frames(3);

	// --- the page changes under a drag: the move is cancelled, no empty step ---
	const snapshot = [...page().strokes];
	const grabbed = handles()[0]!;
	const c0 = centre(grabbed);
	fire(grabbed, "pointerdown", c0.x, c0.y);
	for (let i = 1; i <= 4; i++) {
		fire(grabbed, "pointermove", c0.x, c0.y + 30 * i);
		await frames(1);
	}
	await frames(2);
	const noticesBefore = api.notices.length;
	v.applyCommand(new Batch("Draw", [new AddStroke(page().id, make(line([400, 700], [450, 702])), page().strokes.length)]));
	await frames(3);
	fire(grabbed, "pointerup", c0.x, c0.y + 200);
	await frames(3);
	add("a page that changes during a drag cancels the move: only the new stroke is there, and a notice says so", page().strokes.length === snapshot.length + 1 && snapshot.every((st) => page().strokes.includes(st)) && api.notices.slice(noticesBefore).some((m) => /cancel|annull/i.test(m)), api.notices.slice(noticesBefore).join(" | "));
	add("no handle is left dragging", handles().every((h) => !h.classList.contains("is-dragging")));
	v.undo();
	await frames(3);
	add("one undo takes back the new stroke (the cancelled drag left no step of its own)", page().strokes.length === snapshot.length && snapshot.every((st, i) => st === page().strokes[i]));

	// --- leaving ---
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	await frames(3);
	add("Escape leaves the mode: no handle, no bar", handles().length === 0 && (bar() === null || bar()!.classList.contains("notebook-hidden")) && v.lineHandleTools?.active === false);
	v.lineHandleTools?.start();
	await frames(3);
	barButton("line-handle-done")!.click();
	await frames(3);
	add("Done leaves the mode", v.lineHandleTools?.active === false && handles().length === 0);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length, scale: v.viewport.scale } };
}

/** Rebuilds the page for a screenshot: the handles at rest (`rest`), a drag in progress (`drag`) or the page after the drop (`after`). */
export async function linehandleShot(api: LinehandleCheckApi, state: "rest" | "drag" | "after"): Promise<void> {
	await api.open("linehandle");
	const v = api.view as LinehandleView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	v.lineHandleTools?.stop();
	if (page().locked) v.setPageLocked(page(), false);
	const old = [...page().strokes];
	if (old.length > 0) v.applyCommand(new Batch("Clear", old.map((st, i) => new ReplaceStroke(page().id, st, [], i)).reverse()));
	page().elements = [];
	v.clearSelection();
	await api.frames(2);
	const rows = lines();
	v.applyCommand(new Batch("Draw", rows.flat().map((st, i) => new AddStroke(page().id, st, i))));
	page().elements = [lockedBox()];
	await api.frames(3);
	v.lineHandleTools?.start();
	await api.frames(3);
	if (state === "rest") return;
	const handles = [...document.querySelectorAll<HTMLElement>('[data-key^="line-handle:"]')];
	const first = handles[0];
	if (!first) return;
	const r = first.getBoundingClientRect();
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	const dy = 65 * 2 * (v.viewport.scale || 1) + 8;
	const fire = (type: string, py: number): void => {
		first.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 42, pointerType: "touch", clientX: x, clientY: py, button: 0, isPrimary: true }));
	};
	fire("pointerdown", y);
	for (let i = 1; i <= 6; i++) {
		fire("pointermove", y + (dy * i) / 6);
		await api.frames(1);
	}
	await api.frames(3);
	if (state === "drag") return;
	fire("pointerup", y + dy);
	await api.frames(4);
}
