/**
 * Smoke check of the opacity of ink, pictures and areas (0.26, roadmap #358, format v24) on the `doc=opacity` notebook (the slides notebook: PDF
 * pages; HARNESS_DOC=opacity npm run harness:check): the real view, toolbar, selection bar and History with the synthetic pen. The pen options
 * and the highlighter options have an opacity slider (separate values); a stroke written with 40 % is stored with `opacity: 0.4` and really is
 * lighter on the composited canvas (a pixel on the stroke against one beside it); the highlighter's stays translucent and multiplied; an area
 * takes the highlighter's value; the selection bar sets the opacity of the selected ink and areas as ONE undo step and its reset button puts
 * them back to full strength (the key is gone); the "Opacity" action opens the slider; the writer and the reader keep everything. A specimen
 * of every pen at four strengths is left on the page, with one stroke selected, for the screenshot.
 */
import { AddElement, AddStroke, Batch } from "../../src/model/history";
import { parse, serialize } from "../../src/model/serialize";
import { createStroke } from "../../src/model/document";
import { areasOf } from "../../src/model/area";
import { rectPoints } from "../../src/ink/shapes";
import type { AreaElement, NotebookDocument, Page, PageElement, Stroke, Tool } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface OpacityCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; pressure?: number; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	openOptions: (tool: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface OpacityView {
	document: NotebookDocument;
	currentPage(): number;
	toolbar: { state: Record<string, unknown>; update(patch: Record<string, unknown>): void; closePopover(): void };
	selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	selection: { strokes: Stroke[]; elements: PageElement[] } | null;
	clearSelection(): void;
	applyCommand(command: unknown): void;
	revealOpacity(): void;
	viewport: { scale: number; offsetX: number; offsetY: number };
	layout: { boxes: Array<{ x: number; y: number }> };
	undo(): void;
	redo(): void;
}

const visible = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;

export async function checkOpacity(api: OpacityCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as OpacityView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const areas = (): AreaElement[] => areasOf(page());
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const OPTIONS = ".notebook-options .notebook-opacity-row";
	const BAR = ".notebook-selection-styles .notebook-opacity-row";
	const slider = (root: string): HTMLInputElement | null => q<HTMLInputElement>(`${root} .notebook-opacity-slider`);
	const valueOf = (root: string): string => q(`${root} .notebook-opacity-value`)?.textContent ?? "";
	/** What a finger lifting on `percent` does: the slider's own change event. */
	const slide = async (root: string, percent: number): Promise<void> => {
		const s = slider(root)!;
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
	/** Red channel of the composited static canvas at a page point. */
	const redAt = (x: number, y: number): number => {
		const canvas = q<HTMLCanvasElement>("canvas.notebook-canvas-static")!;
		const r = canvas.getBoundingClientRect();
		const stage = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		const cx = ((v.viewport.offsetX + (box.x + x) * v.viewport.scale) + stage.left - r.left) * (canvas.width / r.width);
		const cy = ((v.viewport.offsetY + (box.y + y) * v.viewport.scale) + stage.top - r.top) * (canvas.height / r.height);
		return canvas.getContext("2d")!.getImageData(Math.round(cx), Math.round(cy), 1, 1).data[0]!;
	};
	/** How much of the pen's colour a horizontal stroke at row y shows: 1 = full, 0 = none (a pixel on the stroke against one beside it). */
	const coverage = (x: number, y: number, ink: number): number => {
		const base = redAt(x, y - 26);
		return base === ink ? 1 : (base - redAt(x, y)) / (base - ink);
	};

	add("the page is a PDF page (a scan stands in for it)", page().background?.kind === "pdf");

	// --- the pen's options ---
	api.setTool("pen");
	v.toolbar.update({ penKind: "pen", penColor: "#1e1e1e", penWidth: 5 });
	await api.openOptions("pen");
	add("the pen options have an opacity slider at 100 %", visible(q(OPTIONS)) && slider(OPTIONS)?.value === "100" && valueOf(OPTIONS) === "100%");
	add("its reset button explains itself on a long press", q<HTMLElement>(`${OPTIONS} .notebook-opacity-reset`)?.dataset.help === "help.opacity");
	await slide(OPTIONS, 40);
	add("moving it to 40 % sets the pen's opacity", v.toolbar.state.penOpacity === 0.4 && valueOf(OPTIONS) === "40%" && v.toolbar.state.highlighterOpacity === 1, String(v.toolbar.state.penOpacity));

	// --- a stroke written with it ---
	v.toolbar.closePopover();
	await api.frames(2);
	const before = page().strokes.length;
	await drag([[60, 240], [300, 240]], 14);
	await sleep(200);
	const faint = page().strokes[page().strokes.length - 1]!;
	add("the stroke is stored with the opacity", page().strokes.length === before + 1 && faint.tool === "pen" && faint.opacity === 0.4, JSON.stringify({ tool: faint.tool, opacity: faint.opacity }));
	const shown = coverage(180, 240, 0x1e);
	add("and really is lighter on the page", shown > 0.28 && shown < 0.52, shown.toFixed(2));

	// --- a full-strength stroke is stored as before ---
	await api.openOptions("pen");
	q<HTMLButtonElement>(`${OPTIONS} .notebook-opacity-reset`)?.click();
	await api.frames(3);
	add("the reset button puts the pen back to 100 %", v.toolbar.state.penOpacity === 1 && slider(OPTIONS)?.value === "100");
	v.toolbar.closePopover();
	await api.frames(2);
	await drag([[60, 310], [300, 310]], 14);
	await sleep(200);
	const solid = page().strokes[page().strokes.length - 1]!;
	add("a stroke at 100 % has no opacity key at all", solid !== faint && !("opacity" in solid));
	const full = coverage(180, 310, 0x1e);
	add("and is as dark as before", full > 0.9, full.toFixed(2));

	// --- the highlighter has a value of its own ---
	api.setTool("highlighter");
	await api.openOptions("highlighter");
	add("the highlighter options have their own slider, at 100 %", visible(q(OPTIONS)) && slider(OPTIONS)?.value === "100");
	await slide(OPTIONS, 50);
	add("it sets the highlighter's opacity, not the pen's", v.toolbar.state.highlighterOpacity === 0.5 && v.toolbar.state.penOpacity === 1);
	v.toolbar.closePopover();
	await api.frames(2);
	await drag([[60, 370], [300, 370]], 14);
	await sleep(200);
	const hl = page().strokes[page().strokes.length - 1]!;
	add("a highlighter stroke keeps it", hl.tool === "highlighter" && hl.opacity === 0.5, JSON.stringify({ tool: hl.tool, opacity: hl.opacity }));

	// --- an area takes the highlighter's value ---
	v.toolbar.update({ highlighterArea: true });
	await api.frames(2);
	await drag([[60, 410], [300, 450]], 12);
	await sleep(200);
	const area = areas()[areas().length - 1];
	add("an area highlighter takes the same opacity", !!area && area.opacity === 0.5, JSON.stringify(area));
	v.toolbar.update({ highlighterArea: false });
	api.setTool("lasso");
	await api.frames(2);

	// --- the selection bar ---
	const strokesBefore = page().strokes.length;
	v.selectItems(v.currentPage(), [faint, hl], []);
	await api.frames(4);
	add("the selection bar has the slider", visible(q(BAR)));
	add("two different values show no number", valueOf(BAR) === "–", valueOf(BAR));
	await slide(BAR, 25);
	const p1 = page().strokes.find((s) => s.id === faint.id)!;
	const p2 = page().strokes.find((s) => s.id === hl.id)!;
	add("moving it sets every selected stroke, in place", p1.opacity === 0.25 && p2.opacity === 0.25 && page().strokes.length === strokesBefore && page().strokes.findIndex((s) => s.id === faint.id) === page().strokes.indexOf(p1));
	add("the selection follows the changed strokes and shows the shared value", v.selection?.strokes.includes(p1) === true && valueOf(BAR) === "25%", valueOf(BAR));
	v.undo();
	await api.frames(3);
	add("ONE undo puts both back", page().strokes.find((s) => s.id === faint.id) === faint && page().strokes.find((s) => s.id === hl.id) === hl);
	v.redo();
	await api.frames(3);
	add("one redo sets both again", page().strokes.find((s) => s.id === faint.id)?.opacity === 0.25);
	// Undo and redo drop the selection: it is made again on the strokes as they are now.
	v.selectItems(v.currentPage(), page().strokes.filter((s) => s.id === faint.id || s.id === hl.id), []);
	await api.frames(4);
	q<HTMLButtonElement>(`${BAR} .notebook-opacity-reset`)?.click();
	await api.frames(3);
	add("the reset button takes the key away",page().strokes.filter((s) => s.id === faint.id || s.id === hl.id).every((s) => !("opacity" in s)));
	v.undo();
	await api.frames(3);

	// --- an area from the selection bar ---
	v.selectItems(v.currentPage(), [], area ? [area] : []);
	await api.frames(4);
	add("an area has the slider too, at its value", visible(q(BAR)) && valueOf(BAR) === "50%", valueOf(BAR));
	await slide(BAR, 80);
	add("it changes the area as one step", areas().some((a) => a.id === area?.id && a.opacity === 0.8));
	v.undo();
	await api.frames(3);
	add("undo brings the area's value back", areas().some((a) => a.id === area?.id && a.opacity === 0.5));
	v.clearSelection();

	// --- the action ---
	api.setTool("pen");
	await api.frames(2);
	v.revealOpacity();
	await api.frames(3);
	add("the Opacity action opens the pen options and puts the focus on the slider", visible(q(OPTIONS)) && document.activeElement === slider(OPTIONS));
	v.toolbar.closePopover();

	// --- writer and reader ---
	const text = serialize(v.document);
	const back = parse(text);
	const backPage = back.ok ? back.doc.pages[v.currentPage()]! : null;
	add("the writer and the reader keep the opacity of ink and areas", back.ok && back.dropped === undefined && back.doc.version >= 24 && backPage?.strokes.find((s) => s.id === faint.id)?.opacity === 0.25 && areasOf(backPage).some((a) => a.opacity === 0.5));
	add("a notebook that never used it writes no opacity key before the strokes that have none", !text.split("\n").filter((l) => l.includes(`"id":"${solid.id}"`)).some((l) => l.includes("opacity")));

	// --- the specimen for the screenshot ---
	const w = page().width;
	const put: Stroke[] = [];
	const rows: Array<{ tool: Tool; color: string; width: number; y: number; render: 1 | 2 }> = [
		{ tool: "pen", color: "#1e293b", width: 5, y: 500, render: 1 },
		{ tool: "highlighter", color: "#facc15", width: 18, y: 540, render: 1 },
		{ tool: "marker", color: "#dc2626", width: 12, y: 580, render: 2 },
		{ tool: "fountain", color: "#1d4ed8", width: 6, y: 620, render: 2 },
	];
	const levels = [1, 0.7, 0.4, 0.15];
	rows.forEach((r, i) => levels.forEach((o, j) => {
		const x = w * 0.08 + j * w * 0.22;
		const pts: Stroke["points"] = [[x, r.y, 0.5], [x + 20, r.y - 8, 0.6], [x + 50, r.y + 6, 0.6], [x + 80, r.y - 4, 0.5], [x + 100, r.y + 2, 0.5]];
		put.push({ ...createStroke(r.color, r.width, pts, r.tool, r.render), id: `op-${i}-${j}`, ...(o < 1 ? { opacity: o } : {}) });
	}));
	levels.forEach((o, j) => put.push({ ...createStroke("#16a34a", 3, rectPoints([w * 0.08 + j * w * 0.22, 660], [w * 0.08 + j * w * 0.22 + 90, 710]), "shape", 1), id: `op-shape-${j}`, fill: "#16a34a", fillTint: true, ...(o < 1 ? { opacity: o } : {}) }));
	const washes: AreaElement[] = levels.map((o, j) => ({ id: `op-area-${j}`, type: "area", x: w * 0.08 + j * w * 0.22, y: 725, width: 100, height: 28, color: "#4ade80", ...(o < 1 ? { opacity: o } : {}) }));
	v.applyCommand(new Batch("Specimen", [
		...washes.map((a, i) => new AddElement(page().id, a, (page().elements?.length ?? 0) + i)),
		...put.map((s, i) => new AddStroke(page().id, s, page().strokes.length + i)),
	]));
	await api.frames(3);
	v.selectItems(v.currentPage(), [page().strokes.find((s) => s.id === "op-1-2")!], []);
	await api.frames(4);
	add("the page holds the specimen and the bar shows the value of the selected stroke", put.length === 20 && valueOf(BAR) === "40%", valueOf(BAR));
	add("nothing failed", api.errors.length === 0, api.errors.join(" | "));

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length, areas: areas().length } };
}
