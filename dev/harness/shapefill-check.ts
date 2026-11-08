/**
 * Smoke check of filled shapes and dashed or dotted lines (0.24, roadmap #37, format v22) on the `doc=shapefill` notebook (the blank "New"
 * notebook; HARNESS_DOC=shapefill npm run harness:check): the real view, toolbar and History with the synthetic pen. The shape tool's options
 * offer a fill (none / solid / tint, then its colours) for the rectangle and the ellipse and a line style (solid / dashed / dotted) for every
 * shape; a rectangle drawn with a tint and a dashed line is stored with them, a line takes the line style and never a fill; the selection bar
 * restyles the fill and the line of the selected shapes as one undo step (and leaves freehand ink alone); the writer and the reader keep
 * everything. A specimen of every combination is left on the page, with one shape selected, for the screenshot.
 */
import { AddStroke, Batch } from "../../src/model/history";
import { parse, serialize } from "../../src/model/serialize";
import { createStroke } from "../../src/model/document";
import { ellipsePoints, rectPoints } from "../../src/ink/shapes";
import type { NotebookDocument, Page, Stroke } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface ShapefillCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; pressure?: number; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	openOptions: (tool: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface ShapeView {
	document: NotebookDocument;
	currentPage(): number;
	toolbar: { state: Record<string, unknown>; update(patch: Record<string, unknown>): void; closePopover(): void };
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
	selection: { strokes: Stroke[] } | null;
	clearSelection(): void;
	applyCommand(command: unknown): void;
	undo(): void;
	redo(): void;
	viewport: { scale: number; offsetX: number; offsetY: number };
	layout: { boxes: Array<{ x: number; y: number }> };
}

const visible = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;

export async function checkShapefill(api: ShapefillCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as ShapeView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const last = (): Stroke => page().strokes[page().strokes.length - 1]!;
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	/** The text buttons of one control (fill or line) inside `root`, by their label. */
	const button = (root: string, label: string): HTMLButtonElement | null =>
		Array.from(document.querySelectorAll<HTMLButtonElement>(`${root} .notebook-shape-seg button`)).find((b) => b.textContent === label) ?? null;
	const swatches = (root: string): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>(`${root} .notebook-shape-colours .notebook-swatch`));
	const OPTIONS = ".notebook-options .notebook-shape-style";
	const BAR = ".notebook-selection-styles .notebook-shape-style";

	// --- the options of the shape tool ---
	api.setTool("shape");
	v.toolbar.update({ shapeKind: "rectangle" });
	await api.openOptions("shape");
	add("the shape options show a fill and a line style", visible(q(OPTIONS)) && !!button(OPTIONS, "Tint") && !!button(OPTIONS, "Dashed"));
	add("nothing is filled or dashed to begin with", v.toolbar.state.shapeFill === "none" && v.toolbar.state.shapeLine === "solid" && swatches(OPTIONS).length === 0);

	button(OPTIONS, "Tint")?.click();
	await api.frames(2);
	add("choosing Tint selects it and offers the fill colours", v.toolbar.state.shapeFill === "tint" && button(OPTIONS, "Tint")?.classList.contains("is-active") === true && swatches(OPTIONS).length >= 8);
	const second = swatches(OPTIONS)[2];
	second?.click();
	await api.frames(2);
	add("choosing a colour sets the fill colour", typeof v.toolbar.state.shapeFillColor === "string" && swatches(OPTIONS)[2]?.classList.contains("is-active") === true, String(v.toolbar.state.shapeFillColor));
	button(OPTIONS, "Dashed")?.click();
	await api.frames(2);
	add("choosing Dashed selects it", v.toolbar.state.shapeLine === "dashed" && button(OPTIONS, "Dashed")?.classList.contains("is-active") === true);

	// --- a rectangle drawn with them ---
	const tint = String(v.toolbar.state.shapeFillColor);
	v.toolbar.closePopover();
	await api.frames(2);
	const before = page().strokes.length;
	await api.penStroke([[0.12, 0.1], [0.5, 0.2]], { steps: 12 });
	await sleep(150);
	const rect = last();
	add("a rectangle is stored with the tint fill and the dashed line", page().strokes.length === before + 1 && rect.tool === "shape" && rect.fill === tint.toLowerCase() && rect.fillTint === true && rect.dash === "dashed",
		JSON.stringify({ tool: rect.tool, fill: rect.fill, fillTint: rect.fillTint, dash: rect.dash }));

	// --- a line takes the line style and never a fill ---
	v.toolbar.update({ shapeKind: "line" });
	await api.openOptions("shape");
	add("a line has no fill controls but keeps the line style", !button(OPTIONS, "Tint") && !!button(OPTIONS, "Dotted"));
	button(OPTIONS, "Dotted")?.click();
	await api.frames(2);
	v.toolbar.closePopover();
	await api.penStroke([[0.12, 0.3], [0.5, 0.3]], { steps: 10 });
	await sleep(150);
	const line = last();
	add("a line is stored dotted and without a fill", line.tool === "shape" && line.dash === "dotted" && line.fill === undefined, JSON.stringify({ fill: line.fill, dash: line.dash }));

	// --- the selection restyles as one undo step ---
	const pen = { ...createStroke("#1e293b", 2, [[60, 330, 0.5], [90, 345, 0.5], [130, 330, 0.5]], "pen"), id: "sf-pen" };
	v.applyCommand(new AddStroke(page().id, pen, page().strokes.length));
	await api.frames(2);
	v.selectItems(v.currentPage(), [rect, line, pen], []);
	await api.frames(3);
	add("the selection bar shows the fill and the line style", visible(q(BAR)) && !!button(BAR, "Solid") && !!button(BAR, "Dotted"));
	add("it shows what the shapes have", button(BAR, "Dashed")?.classList.contains("is-active") !== true && button(BAR, "Tint")?.classList.contains("is-active") === true);
	const countBefore = page().strokes.length;
	const solid = Array.from(document.querySelectorAll<HTMLButtonElement>(`${BAR} .notebook-shape-seg`))[0]?.querySelectorAll<HTMLButtonElement>("button")[1];
	solid?.click();
	await api.frames(3);
	const rect2 = page().strokes.find((s) => s.id === rect.id)!;
	add("Solid fills the rectangle solid", rect2.fill === rect.fill && rect2.fillTint === undefined && rect2.dash === "dashed" && page().strokes.length === countBefore);
	add("the line and the freehand ink are left as they were", page().strokes.find((s) => s.id === line.id) === line && page().strokes.find((s) => s.id === "sf-pen") === pen);
	add("the selection follows the restyled shape", v.selection?.strokes.includes(rect2) === true);
	v.undo();
	await api.frames(3);
	add("one undo puts the tint back", page().strokes.find((s) => s.id === rect.id) === rect);
	v.redo();
	await api.frames(3);
	add("one redo does it again", page().strokes.find((s) => s.id === rect.id)?.fillTint === undefined);
	v.selectItems(v.currentPage(), [page().strokes.find((s) => s.id === rect.id)!, line], []);
	await api.frames(3);
	const solidLine = Array.from(document.querySelectorAll<HTMLButtonElement>(`${BAR} .notebook-shape-group`)).find((g) => g.querySelector(".notebook-shape-label")?.textContent === "Line");
	Array.from(solidLine?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => b.textContent === "Solid")?.click();
	await api.frames(3);
	add("Solid line removes the dashes of both shapes", page().strokes.filter((s) => s.id === rect.id || s.id === line.id).every((s) => s.dash === undefined));

	// --- writer and reader ---
	const text = serialize(v.document);
	const back = parse(text);
	add("the writer and the reader keep the style", back.ok && back.doc.pages[v.currentPage()]!.strokes.find((s) => s.id === rect.id)?.fill === rect.fill && back.dropped === undefined);

	// --- the specimen for the screenshot ---
	const specimen: Stroke[] = [];
	const put = (id: string, points: Stroke["points"], extra: Partial<Stroke>, color = "#1e293b") => specimen.push({ ...createStroke(color, 2, points, "shape"), id, ...extra });
	const cols = ["#2563eb", "#16a34a", "#dc2626", "#f59e0b"];
	cols.forEach((c, i) => {
		put(`sf-r${i}`, rectPoints([40 + i * 130, 440], [140 + i * 130, 510]), i === 0 ? {} : i === 1 ? { fill: c } : { fill: c, fillTint: true }, c);
		put(`sf-e${i}`, ellipsePoints([90 + i * 130, 590], 50, 32), { fill: c, fillTint: true, dash: i % 2 ? "dotted" : "dashed" }, c);
		put(`sf-d${i}`, rectPoints([40 + i * 130, 650], [140 + i * 130, 720]), { dash: i % 2 ? "dotted" : "dashed", ...(i > 1 ? { fill: c, fillTint: true } : {}) }, c);
	});
	v.applyCommand(new Batch("Specimen", specimen.map((s, i) => new AddStroke(page().id, s, page().strokes.length + i))));
	await api.frames(3);
	const pick = page().strokes.find((s) => s.id === "sf-e1")!;
	v.selectItems(v.currentPage(), [pick], []);
	await api.frames(4);
	add("the page holds the specimen and the bar shows its style", page().strokes.length >= before + 12 && visible(q(BAR)) && button(BAR, "Tint")?.classList.contains("is-active") === true);
	add("nothing failed", api.errors.length === 0, api.errors.join(" | "));

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length } };
}
