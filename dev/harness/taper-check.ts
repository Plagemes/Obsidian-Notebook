/**
 * Smoke check of the stroke taper (0.27, roadmap #351, format v25) on the `doc=taper` notebook (the blank "New" notebook; HARNESS_DOC=taper
 * npm run harness:check): the real view, toolbar and renderer with the synthetic pen. The pen options of the pen, the fountain pen and the brush
 * have a taper row with a start and an end slider and a picture of the stroke (the marker, the highlighter and shapes have none); a stroke written
 * with them is stored with `taperStart` / `taperEnd` and really is thinner at its ends on the composited canvas (a column of pixels at the start,
 * in the middle and at the end); the reset button puts both ends back to none and the next stroke has no taper keys at all; the writer and the
 * reader keep it. A specimen of the pens at several tapers is left on the page, with the pen options open, for the screenshot.
 */
import { AddStroke, Batch } from "../../src/model/history";
import { parse, serialize } from "../../src/model/serialize";
import { createStroke } from "../../src/model/document";
import { captureFavourite, type PenState } from "../../src/view/favourites";
import { styleOfStroke } from "../../src/ink/colour";
import type { NotebookDocument, Page, Stroke, Tool } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface TaperCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; pressure?: number; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	openOptions: (tool: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface TaperView {
	document: NotebookDocument;
	currentPage(): number;
	toolbar: { state: Record<string, unknown>; update(patch: Record<string, unknown>): void; closePopover(): void };
	applyCommand(command: unknown): void;
	viewport: { scale: number; offsetX: number; offsetY: number };
	layout: { boxes: Array<{ x: number; y: number }> };
}

const visible = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;

export async function checkTaper(api: TaperCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as TaperView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const ROW = ".notebook-options .notebook-taper-row";
	const sliderOf = (end: "start" | "end"): HTMLInputElement | null => q<HTMLInputElement>(`${ROW} .notebook-taper-end.is-${end} .notebook-taper-slider`);
	const valueOf = (end: "start" | "end"): string => q(`${ROW} .notebook-taper-end.is-${end} .notebook-taper-value`)?.textContent ?? "";
	/** What a finger lifting on `percent` does: the slider's own change event. */
	const slide = async (end: "start" | "end", percent: number): Promise<void> => {
		const s = sliderOf(end)!;
		s.value = String(percent);
		s.dispatchEvent(new Event("input", { bubbles: true }));
		s.dispatchEvent(new Event("change", { bubbles: true }));
		await api.frames(3);
	};
	const frac = (x: number, y: number): [number, number] => {
		const r = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	const drag = (pts: Array<[number, number]>, steps: number) => api.penStroke(pts.map(([x, y]) => frac(x, y)), { steps });
	/** How many dark pixels the composited static canvas has in the column at page x, within 30 pt above and below row y: the thickness of a horizontal line there. */
	const thickness = (x: number, y: number): number => {
		const canvas = q<HTMLCanvasElement>("canvas.notebook-canvas-static")!;
		const r = canvas.getBoundingClientRect();
		const stage = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		const sx = canvas.width / r.width, sy = canvas.height / r.height;
		const cx = ((v.viewport.offsetX + (box.x + x) * v.viewport.scale) + stage.left - r.left) * sx;
		const cy0 = ((v.viewport.offsetY + (box.y + y - 30) * v.viewport.scale) + stage.top - r.top) * sy;
		const h = Math.max(1, Math.round(60 * v.viewport.scale * sy));
		const data = canvas.getContext("2d")!.getImageData(Math.round(cx), Math.max(0, Math.round(cy0)), 1, h).data;
		let dark = 0;
		for (let i = 0; i < data.length; i += 4) if (data[i]! < 0x80 && data[i + 3]! > 128) dark++;
		return dark;
	};

	// --- the pen's options ---
	api.setTool("pen");
	v.toolbar.update({ penKind: "pen", penColor: "#1e1e1e", penWidth: 5, penTaperStart: 0, penTaperEnd: 0 });
	await api.openOptions("pen");
	add("the pen options have a taper row, with a start and an end slider, both off", visible(q(ROW)) && sliderOf("start")?.value === "0" && sliderOf("end")?.value === "0" && valueOf("start") !== "" && !valueOf("start").includes("%"));
	add("the row has a picture of the stroke that the engine draws", !!q(`${ROW} .notebook-taper-preview svg path`)?.getAttribute("d"));
	add("its reset button explains itself on a long press", q<HTMLElement>(`${ROW} .notebook-taper-reset`)?.dataset.help === "help.taper");
	const flat = q(`${ROW} .notebook-taper-preview svg path`)?.getAttribute("d") ?? "";
	await slide("start", 50);
	await slide("end", 100);
	add("the sliders set the pen's taper", v.toolbar.state.penTaperStart === 0.5 && v.toolbar.state.penTaperEnd === 1 && valueOf("start") === "50%" && valueOf("end") === "100%", JSON.stringify([v.toolbar.state.penTaperStart, v.toolbar.state.penTaperEnd]));
	add("and the picture follows them", (q(`${ROW} .notebook-taper-preview svg path`)?.getAttribute("d") ?? "") !== flat);

	// --- the other pens ---
	for (const kind of ["fountain", "brush"]) {
		v.toolbar.update({ penKind: kind });
		await api.frames(2);
		add(`the ${kind} has the row too`, visible(q(ROW)));
	}
	v.toolbar.update({ penKind: "marker" });
	await api.frames(2);
	add("the marker has none", !visible(q(ROW)));
	api.setTool("highlighter");
	await api.openOptions("highlighter");
	add("the highlighter has none", !visible(q(ROW)));
	api.setTool("shape");
	await api.openOptions("shape");
	add("shapes have none", !visible(q(ROW)));
	api.setTool("pen");
	v.toolbar.update({ penKind: "pen" });
	await api.frames(2);

	// --- a stroke written with it ---
	v.toolbar.closePopover();
	await api.frames(2);
	const before = page().strokes.length;
	await drag([[60, 240], [300, 240]], 24);
	await sleep(250);
	const tapered = page().strokes[page().strokes.length - 1]!;
	add("the stroke is stored with the taper of both ends", page().strokes.length === before + 1 && tapered.tool === "pen" && tapered.taperStart === 0.5 && tapered.taperEnd === 1, JSON.stringify({ tool: tapered.tool, start: tapered.taperStart, end: tapered.taperEnd }));
	const nearStart = thickness(64, 240), middle = thickness(180, 240), nearEnd = thickness(296, 240);
	add("and really is thinner at its start", middle > 0 && nearStart < middle * 0.6, `${nearStart} against ${middle}`);
	add("and thinner still at its end", nearEnd < middle * 0.45, `${nearEnd} against ${middle}`);

	// --- the pen in hand keeps writing with it, a reset puts it back ---
	await api.openOptions("pen");
	q<HTMLButtonElement>(`${ROW} .notebook-taper-reset`)?.click();
	await api.frames(3);
	add("the reset button puts both ends back to none", v.toolbar.state.penTaperStart === 0 && v.toolbar.state.penTaperEnd === 0 && sliderOf("start")?.value === "0" && sliderOf("end")?.value === "0");
	v.toolbar.closePopover();
	await api.frames(2);
	await drag([[60, 310], [300, 310]], 24);
	await sleep(250);
	const plain = page().strokes[page().strokes.length - 1]!;
	add("a stroke without a taper has no taper key at all", plain !== tapered && !("taperStart" in plain) && !("taperEnd" in plain));
	add("and is as thick at its ends as in the middle", thickness(64, 310) > thickness(180, 310) * 0.7, `${thickness(64, 310)} against ${thickness(180, 310)}`);

	// --- the brush, with the end only ---
	v.toolbar.update({ penKind: "brush", penWidth: 5, penTaperStart: 0, penTaperEnd: 0.6 });
	await api.frames(2);
	await drag([[60, 380], [300, 380]], 24);
	await sleep(250);
	const brush = page().strokes[page().strokes.length - 1]!;
	add("a brush stroke keeps only the end that was set", brush.tool === "brush" && !("taperStart" in brush) && brush.taperEnd === 0.6, JSON.stringify({ tool: brush.tool, start: brush.taperStart, end: brush.taperEnd }));

	// --- the pens that keep it ---
	const fav = captureFavourite({ ...(v.toolbar.state as unknown as PenState), tool: "pen", penKind: "pen", penTaperStart: 0.4, penTaperEnd: 0.2 });
	add("a favourite pen and a pen set keep the taper", fav.taperStart === 0.4 && fav.taperEnd === 0.2);
	add("the style eyedropper takes it from a stroke", JSON.stringify(styleOfStroke(tapered)).includes('"penTaperStart":0.5') && JSON.stringify(styleOfStroke(tapered)).includes('"penTaperEnd":1'));

	// --- writer and reader ---
	const text = serialize(v.document);
	const back = parse(text);
	const backPage = back.ok ? back.doc.pages[v.currentPage()]! : null;
	const backTapered = backPage?.strokes.find((s) => s.id === tapered.id);
	add("the writer and the reader keep the taper", back.ok && back.dropped === undefined && back.doc.version >= 25 && backTapered?.taperStart === 0.5 && backTapered?.taperEnd === 1);
	add("a notebook that never used it writes no taper key on the strokes that have none", !text.split("\n").filter((l) => l.includes(`"id":"${plain.id}"`)).some((l) => l.includes("taper")));

	// --- the specimen for the screenshot ---
	const w = page().width;
	const rows: Array<{ tool: Tool; color: string; width: number; y: number; start: number; end: number }> = [
		{ tool: "pen", color: "#1e293b", width: 3, y: 470, start: 0, end: 0 },
		{ tool: "pen", color: "#1e293b", width: 3, y: 510, start: 0.3, end: 0.3 },
		{ tool: "pen", color: "#1e293b", width: 3, y: 550, start: 0, end: 1 },
		{ tool: "fountain", color: "#1d4ed8", width: 5, y: 590, start: 0.5, end: 0.5 },
		{ tool: "brush", color: "#dc2626", width: 6, y: 640, start: 1, end: 1 },
		{ tool: "pen", color: "#15803d", width: 2, y: 690, start: 0.15, end: 0.6 },
	];
	const put: Stroke[] = rows.map((r, i) => {
		const pts: Stroke["points"] = [];
		const n = 30;
		for (let k = 0; k <= n; k++) {
			const x = w * 0.1 + (k / n) * w * 0.8;
			pts.push([Math.round(x * 100) / 100, Math.round((r.y + Math.sin((k / n) * Math.PI * 3) * 9) * 100) / 100, 0.55]);
		}
		return { ...createStroke(r.color, r.width, pts, r.tool, 2), id: `tp-${i}`, ...(r.start > 0 ? { taperStart: r.start } : {}), ...(r.end > 0 ? { taperEnd: r.end } : {}) };
	});
	v.applyCommand(new Batch("Specimen", put.map((s, i) => new AddStroke(page().id, s, page().strokes.length + i))));
	await api.frames(3);
	add("the page holds the specimen", put.length === 6 && put.every((s) => page().strokes.some((p) => p.id === s.id)));
	add("nothing failed", api.errors.length === 0, api.errors.join(" | "));

	// The pen options stay open for the screenshot (the pen in hand writes with a taper again).
	v.toolbar.update({ tool: "pen", penKind: "pen", penTaperStart: 0.4, penTaperEnd: 0.7 });
	await api.openOptions("pen");
	await api.frames(3);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length } };
}
