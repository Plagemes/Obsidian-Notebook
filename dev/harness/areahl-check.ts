/**
 * Smoke check of the area highlighter (0.25, roadmap #99, format v23) on the `doc=areahl` notebook (the slides notebook: PDF pages;
 * HARNESS_DOC=areahl npm run harness:check): the real view, toolbar and History with the synthetic pen. The highlighter's options offer
 * *Stroke | Area*; in Area a drag puts a translucent rectangle (an element, not a stroke) on the PDF page; ink written over it stays
 * above it; the selection bar recolours it with the highlighter colours as one undo step; the eraser removes it whole and Undo brings it
 * back; the writer and the reader keep it. A specimen of three colours with handwriting over it is left on the page, one area selected,
 * for the screenshot.
 */
import { AddElement, AddStroke, Batch } from "../../src/model/history";
import { parse, serialize } from "../../src/model/serialize";
import { createStroke } from "../../src/model/document";
import { areasOf } from "../../src/model/area";
import type { AreaElement, NotebookDocument, Page, PageElement, Stroke } from "../../src/model/types";
import type { CheckResult } from "./reading-check";

export interface AreahlCheckApi {
	view: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; pressure?: number; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	openOptions: (tool: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface AreaView {
	document: NotebookDocument;
	currentPage(): number;
	toolbar: { state: Record<string, unknown>; update(patch: Record<string, unknown>): void; closePopover(): void };
	selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	selection: { strokes: Stroke[]; elements: PageElement[] } | null;
	applyCommand(command: unknown): void;
	runAction?(id: string): void;
	viewport: { scale: number; offsetX: number; offsetY: number };
	layout: { boxes: Array<{ x: number; y: number }> };
	undo(): void;
	redo(): void;
}

const visible = (el: Element | null): boolean => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0;

export async function checkAreahl(api: AreahlCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const v = api.view as AreaView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const areas = (): AreaElement[] => areasOf(page());
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
	const modeButton = (label: string): HTMLButtonElement | null =>
		Array.from(document.querySelectorAll<HTMLButtonElement>(".notebook-options .notebook-hl-mode button")).find((b) => b.textContent === label) ?? null;
	/** A point of the page in view as fractions of the stage (what the synthetic pen takes); asked again each time, the layout moves when a popover opens. */
	const frac = (x: number, y: number): [number, number] => {
		const r = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	const drag = (pts: Array<[number, number]>, steps: number) => api.penStroke(pts.map(([x, y]) => frac(x, y)), { steps });
	const swatches = (root: string): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>(`${root} .notebook-swatch`));

	add("the page is a PDF page (a scan stands in for it)", page().background?.kind === "pdf");

	// --- the options of the highlighter ---
	api.setTool("highlighter");
	await api.openOptions("highlighter");
	add("the highlighter options offer Stroke and Area", visible(q(".notebook-options .notebook-hl-mode")) && !!modeButton("Stroke") && !!modeButton("Area"));
	add("Stroke is chosen to begin with, and the width row is there", v.toolbar.state.highlighterArea === false && modeButton("Stroke")?.classList.contains("is-active") === true && visible(q(".notebook-options .notebook-width")));
	modeButton("Area")?.click();
	await api.frames(2);
	add("choosing Area selects it and takes the width row away", v.toolbar.state.highlighterArea === true && modeButton("Area")?.classList.contains("is-active") === true && !visible(q(".notebook-options .notebook-width")));

	// --- a drag draws a rectangle ---
	v.toolbar.closePopover();
	await api.frames(2);
	const strokesBefore = page().strokes.length;
	await drag([[60, 160], [480, 215]], 12);
	await sleep(150);
	add("a drag adds one area and no stroke", areas().length === 1 && page().strokes.length === strokesBefore, `${areas().length} areas, ${page().strokes.length - strokesBefore} strokes`);
	const leftover = () => JSON.stringify((v as unknown as { shapeDrag: unknown }).shapeDrag);
	add("no drag is left over after the first area", leftover() === "null", leftover());
	const first = areas()[0];
	add("it has the highlighter colour and a rectangle with a sensible size", !!first && first.color === String(v.toolbar.state.highlighterColor) && first.width > 100 && first.height > 10, JSON.stringify(first));

	// --- a tap adds nothing ---
	await drag([[300, 400], [300, 400]], 2);
	await sleep(100);
	add("a tap without a drag adds nothing", areas().length === 1);
	add("no drag is left over after the tap", leftover() === "null", leftover());

	// --- a second colour ---
	await api.openOptions("highlighter");
	const swatchRow = swatches(".notebook-options");
	swatchRow[1]?.click();
	v.toolbar.closePopover();
	await api.frames(3);
	v.toolbar.closePopover();
	await drag([[60, 240], [300, 290]], 12);
	await sleep(150);
	add("the next area takes the colour chosen", areas().length === 2 && areas()[1]!.color === String(v.toolbar.state.highlighterColor) && areas()[1]!.color !== areas()[0]!.color);
	add("no drag is left over after the second area", leftover() === "null", leftover());

	// --- ink written over it stays above it and is not an area ---
	api.setTool("pen");
	await api.frames(2);
	const strokesWithArea = page().strokes.length;
	await drag([[80, 190], [250, 192], [420, 188]], 18);
	await sleep(150);
	add("handwriting over an area is ordinary ink and leaves the area alone", page().strokes.length === strokesWithArea + 1 && areas().length === 2 && areas()[0] === first, `tool ${String(v.toolbar.state.tool)}/${(v as unknown as { tools: { tool: string } }).tools.tool}, strokes ${page().strokes.length} (was ${strokesWithArea}), areas ${areas().length} ${JSON.stringify(areas().map((a) => [a.x, a.y, a.width, a.height]))} page ${v.currentPage()}`);

	// --- recolour from the selection bar ---
	v.selectItems(v.currentPage(), [], [first!]);
	await api.frames(3);
	const BAR = ".notebook-selection-styles";
	const barSwatches = swatches(BAR);
	add("the selection bar offers the highlighter colours for an area", visible(q(BAR)) && barSwatches.length === 5, String(barSwatches.length));
	const count = areas().length;
	barSwatches[3]?.click();
	await api.frames(3);
	const recoloured = areas().find((a) => a.id === first!.id)!;
	add("a colour recolours it as one step, in place", recoloured.color !== first!.color && recoloured.x === first!.x && areas().length === count && areas()[0]!.id === first!.id, recoloured.color);
	v.undo();
	await api.frames(3);
	add("one undo puts the colour back", areas().find((a) => a.id === first!.id) === first);
	v.redo();
	await api.frames(3);
	add("one redo recolours it again", areas().find((a) => a.id === first!.id)?.color === recoloured.color);

	// --- the eraser removes it whole ---
	v.selectItems(v.currentPage(), [], []);
	const second = areas()[1]!;
	api.setTool("eraser");
	v.toolbar.update({ eraserMode: "stroke", eraserFilter: "all" });
	await api.frames(2);
	await drag([[150, 255], [180, 275]], 8);
	await sleep(200);
	add("the eraser removes the whole area it touches", areas().length === 1 && !areas().some((a) => a.id === second.id) && page().strokes.length === strokesWithArea + 1, `${areas().length} areas, tool ${String(v.toolbar.state.tool)}, ${JSON.stringify(areas().map((a) => [a.x, a.y, a.width, a.height]))}`);
	v.undo();
	await api.frames(3);
	add("undo brings the area back, where it was", areas().length === 2 && areas()[1] === second);

	// --- the pen filter spares it ---
	v.toolbar.update({ eraserFilter: "pen" });
	await api.frames(2);
	await drag([[150, 255], [180, 275]], 8);
	await sleep(200);
	add("the Pen eraser filter spares areas", areas().length === 2);
	v.toolbar.update({ eraserFilter: "all" });

	// --- writer and reader ---
	const text = serialize(v.document);
	const back = parse(text);
	add("the writer and the reader keep the areas", back.ok && areasOf(back.doc.pages[v.currentPage()]!).length === 2 && back.dropped === undefined && back.doc.version === 23);

	// --- the specimen for the screenshot ---
	const cols = ["#facc15", "#4ade80", "#f472b6", "#60a5fa", "#fb923c"];
	const w = page().width;
	const specimen = cols.map((color, i): AreaElement => ({ id: `ah-s${i}`, type: "area", x: w * 0.1, y: 360 + i * 46, width: w * (0.8 - i * 0.08), height: 26, color }));
	v.applyCommand(new Batch("Specimen", specimen.map((a, i) => new AddElement(page().id, a, (page().elements?.length ?? 0) + i))));
	const ink: Stroke[] = specimen.map((a, i) => ({ ...createStroke("#1e293b", 2, [[a.x + 10, a.y + 14, 0.5], [a.x + 60, a.y + 8 + (i % 2) * 6, 0.5], [a.x + 120, a.y + 16, 0.5], [a.x + 190, a.y + 10, 0.5]], "pen"), id: `ah-i${i}` }));
	v.applyCommand(new Batch("Ink", ink.map((s, i) => new AddStroke(page().id, s, page().strokes.length + i))));
	api.setTool("lasso");
	await api.frames(3);
	v.selectItems(v.currentPage(), [], [page().elements!.find((e) => e.id === "ah-s2")!]);
	await api.frames(4);
	add("the page holds the specimen and the bar shows the highlighter colours", areas().length >= 7 && swatches(BAR).length === 5);
	add("nothing failed", api.errors.length === 0, api.errors.join(" | "));

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { areas: areas().length, strokes: page().strokes.length } };
}
