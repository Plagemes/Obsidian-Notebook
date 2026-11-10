/**
 * Smoke check of charts from table data (0.29, roadmap #244) on the `doc=charts` notebook (the blank "New" notebook; HARNESS_DOC=charts npm
 * run harness:check): the real view. A table is inserted and numbers are put in its cells as text boxes; with the table selected the sheet
 * offers "Chart from table", which opens the dialog (type, title, first colour, size, a picture of the chart and what was read); inserting
 * draws shape strokes and text boxes of ONE group in ONE undo step and selects it; after a number changes, "Update chart" on the selected chart
 * redraws it in place in ONE undo step, says so when nothing changed, and is refused on a locked page. `chartsShot` leaves the dialog / the
 * chart for the screenshots (dist/shots/design/charts-<state>-<theme>-<device>.png).
 */
import { parseChartGroup } from "../../src/ink/chart";
import { detectTable } from "../../src/ink/table";
import { AddElement, Batch, RemoveElement, removeStrokes, ReplaceElement } from "../../src/model/history";
import type { Page, PageElement, Stroke, TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface ChartsCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface ChartsView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	clearSelection(): void;
}

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Ids of the text boxes written in the cells are unique per table made in this page load. */
let serial = 0;
const cellPrefix = (): string => `cell${serial}`;

const SALES =[["Month", "Sales", "Cost"], ["Jan", "12", "5"], ["Feb", "18", "7"], ["Mar", "9", "6"]];

async function waitFor(sel: string): Promise<HTMLElement | null> {
	for (let i = 0; i < 40 && !q(sel); i++) await sleep(50);
	const all = document.querySelectorAll<HTMLElement>(sel);
	return all[all.length - 1] ?? null;
}

/** Closes every dialog that is open (one left by an earlier screenshot belongs to a view that is gone). */
async function closeDialogs(api: ChartsCheckApi): Promise<void> {
	for (const b of Array.from(document.querySelectorAll<HTMLElement>(".nb-modal-close"))) b.click();
	await api.frames(2);
}

const press = async (api: ChartsCheckApi, el: Element | null | undefined): Promise<void> => {
	(el as HTMLElement | null)?.click();
	await api.frames(3);
};

/** Inserts a 4 x 3 table through the real dialog and writes SALES into its cells as text boxes; selects the table. */
async function tableWithNumbers(api: ChartsCheckApi): Promise<void> {
	const v = api.view as ChartsView;
	await closeDialogs(api);
	v.clearSelection();
	await api.frames(2);
	v.runAction("insert-table");
	const dlg = await waitFor(".nb-table-dialog");
	if (!dlg) throw new Error("the table dialog did not open");
	const rows = dlg.querySelector<HTMLInputElement>("#nb-table-rows")!;
	rows.value = "4";
	rows.dispatchEvent(new Event("change", { bubbles: true }));
	const cols = dlg.querySelector<HTMLInputElement>("#nb-table-cols")!;
	cols.value = "3";
	cols.dispatchEvent(new Event("change", { bubbles: true }));
	await press(api, dlg.querySelector(".nb-modal-foot .mod-cta"));
	await sleep(100);
	await api.frames(3);
	const page = v.document.pages[v.currentPage()]!;
	const group = lastTableGroup(page);
	const table = detectTable(page.strokes.filter((s) => s.group === group));
	if (!table) throw new Error("no table was drawn");
	serial++;
	SALES.forEach((row, r) => row.forEach((text, c) => {
		const x = (table.grid.xs[c]! + table.grid.xs[c + 1]!) / 2;
		const y = (table.grid.ys[r]! + table.grid.ys[r + 1]!) / 2;
		const el: TextElement = { id: `${cellPrefix()}-${r}-${c}`, type: "text", x: x - 14, y: y - 7, width: 40, text, fontSize: 11, color: "#1f2430" };
		v.history.execute(new AddElement(page.id, el, (page.elements ?? []).length));
	}));
	v.renderer.invalidate();
	selectTable(v);
	await api.frames(3);
}

const pageOf = (v: ChartsView): Page => v.document.pages[v.currentPage()]!;

/** The group of the newest table on the page (a notebook that was opened again may already hold one from an earlier run). */
function lastTableGroup(page: Page): string | undefined {
	for (let i = page.strokes.length - 1; i >= 0; i--) {
		const s = page.strokes[i]!;
		if (s.tool === "shape" && s.group !== undefined && parseChartGroup(s.group) === null) return s.group;
	}
	return undefined;
}

function selectTable(v: ChartsView): void {
	const page = pageOf(v);
	const group = lastTableGroup(page);
	v.selectItems(v.currentPage(), page.strokes.filter((s) => s.group === group), []);
}

function selectChart(v: ChartsView): void {
	const page = pageOf(v);
	const group = [...page.strokes].reverse().find((s) => parseChartGroup(s.group) !== null)?.group;
	v.selectItems(v.currentPage(), page.strokes.filter((s) => s.group === group), (page.elements ?? []).filter((e) => e.group === group));
}

export async function checkCharts(api: ChartsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as ChartsView;
	const { frames } = api;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sel = (): { chartable?: boolean; chart?: boolean } => (v.uiContext() as unknown as { selection?: { chartable?: boolean; chart?: boolean } | null }).selection ?? {};
	const chartStrokes = (): Stroke[] => pageOf(v).strokes.filter((s) => parseChartGroup(s.group) !== null);
	const chartTexts = (): TextElement[] => (pageOf(v).elements ?? []).filter((e): e is TextElement => e.type === "text" && parseChartGroup(e.group) !== null);

	await tableWithNumbers(api);
	add("a selected table with numbers in its cells offers Chart from table", sel().chartable === true && sel().chart !== true);
	const base = pageOf(v).strokes.length;
	add("there is no chart yet", chartStrokes().length === 0);

	// --- the dialog ---
	v.runAction("chart-from-table");
	const dlg = await waitFor(".nb-chart-dialog");
	add("Chart from table opens the dialog", !!dlg);
	if (!dlg) return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	add("it asks the type, a title, the first colour and the size", dlg.querySelectorAll(".nb-chart-seg").length === 2 && dlg.querySelectorAll(".nb-chart-seg")[0]!.querySelectorAll("button").length === 3 && dlg.querySelectorAll(".nb-chart-swatch").length === 8 && !!dlg.querySelector("#nb-chart-title"));
	add("it shows a picture of the chart and what was read", dlg.querySelectorAll(".nb-chart-preview-svg polygon").length >= 5 && /: 6 /.test(dlg.querySelector(".nb-chart-notes")?.textContent ?? ""), dlg.querySelector(".nb-chart-notes")?.textContent ?? "");
	const kinds = dlg.querySelectorAll<HTMLElement>(".nb-chart-seg")[0]!.querySelectorAll("button");
	const bars = dlg.querySelectorAll(".nb-chart-preview-svg polygon").length;
	await press(api, kinds[2]); // pie
	const pie = dlg.querySelectorAll(".nb-chart-preview-svg polygon").length;
	add("the picture follows the type (a pie has wedges)", pie > 0 && pie !== bars);
	await press(api, kinds[1]); // line
	add("a line chart draws dots", dlg.querySelectorAll(".nb-chart-preview-svg circle").length >= 3);
	await press(api, kinds[0]); // bars
	const title = dlg.querySelector<HTMLInputElement>("#nb-chart-title")!;
	title.value = "Sales";
	title.dispatchEvent(new Event("input", { bubbles: true }));
	await frames(2);
	add("the title shows in the picture", Array.from(dlg.querySelectorAll(".nb-chart-preview-svg text")).some((t) => t.textContent === "Sales"));
	await press(api, dlg.querySelector(".nb-modal-foot .mod-cta"));
	await sleep(100);
	await frames(4);

	// --- the chart ---
	const made = chartStrokes();
	const group = made[0]?.group;
	add("inserting draws shape strokes and text boxes of one chart group", made.length > 8 && new Set(made.map((s) => s.group)).size === 1 && chartTexts().length > 5 && chartTexts().every((e) => e.group === group), `${made.length} strokes, ${chartTexts().length} texts`);
	add("the group id links the chart to its table", parseChartGroup(group)?.kind === "bar" && parseChartGroup(group)?.titled === true && !!parseChartGroup(group)?.source);
	add("the chart is selected, with Update chart offered", sel().chart === true && sel().chartable !== true);
	v.undo();
	await frames(2);
	add("one undo removes the whole chart", chartStrokes().length === 0 && chartTexts().length === 0 && pageOf(v).strokes.length === base);
	v.redo();
	await frames(2);
	add("one redo draws it again", chartStrokes().length === made.length);

	// --- updating ---
	selectChart(v);
	await frames(2);
	const before = JSON.stringify(chartStrokes().map((s) => s.points));
	api.notices.length = 0;
	v.runAction("chart-update");
	await frames(3);
	add("Update chart with the numbers unchanged says so and changes nothing", JSON.stringify(chartStrokes().map((s) => s.points)) === before && pageOf(v).strokes.length === base + made.length);
	const page = pageOf(v);
	const cell = (page.elements ?? []).find((e): e is TextElement => e.type === "text" && e.id === `${cellPrefix()}-1-1`)!;
	v.history.execute(new ReplaceElement(page.id, cell, { ...cell, text: "30" }));
	v.renderer.invalidate();
	selectChart(v);
	await frames(2);
	v.runAction("chart-update");
	await frames(3);
	add("after a number changes, Update chart redraws the chart", JSON.stringify(chartStrokes().map((s) => s.points)) !== before && chartStrokes().length > 8);
	add("the chart keeps its group and stays selected", chartStrokes().every((s) => s.group === group) && sel().chart === true);
	v.undo();
	await frames(2);
	add("one undo puts the old chart back", JSON.stringify(chartStrokes().map((s) => s.points)) === before);
	v.redo();
	await frames(2);

	// --- locked page: refused ---
	selectChart(v);
	await frames(2);
	const edited = JSON.stringify(chartStrokes().map((s) => s.points));
	const cell2 = (pageOf(v).elements ?? []).find((e): e is TextElement => e.type === "text" && e.id === `${cellPrefix()}-2-1`)!;
	v.history.execute(new ReplaceElement(pageOf(v).id, cell2, { ...cell2, text: "2" }));
	pageOf(v).locked = true;
	v.runAction("chart-update");
	await frames(3);
	add("a locked page refuses an update", JSON.stringify(chartStrokes().map((s) => s.points)) === edited);
	delete pageOf(v).locked;

	v.clearSelection();
	await frames(2);
	add("with nothing selected neither action is offered", sel().chart !== true && sel().chartable !== true);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: pageOf(v).strokes.length } };
}

/** Leaves the harness notebook with the dialog (`dialog`) or a chart beside its table (`chart`) for the screenshot. */
export async function chartsShot(api: ChartsCheckApi, state: "dialog" | "chart"): Promise<void> {
	await closeDialogs(api);
	await api.open("charts");
	const v = api.view as ChartsView;
	// The notebook may hold what an earlier run left: start from an empty page.
	const page = pageOf(v);
	const clear = removeStrokes(page.id, page.strokes, page.strokes, "Clear");
	const commands = [...(clear ? [clear] : []), ...(page.elements ?? []).map((e) => new RemoveElement(page.id, e))];
	if (commands.length > 0) v.history.execute(new Batch("Clear", commands));
	v.renderer.invalidate();
	await tableWithNumbers(api);
	v.runAction("chart-from-table");
	const dlg = await waitFor(".nb-chart-dialog");
	if (!dlg) throw new Error("the chart dialog did not open");
	if (state === "dialog") {
		// The stand-in appends the modal at the end of the body; the harness frames it as a centred overlay.
		if (!dlg.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(dlg);
		await api.frames(3);
		if (!dlg.isConnected || dlg.getBoundingClientRect().height < 50) throw new Error(`the chart dialog is not on screen (${dlg.getBoundingClientRect().height}px)`);
		return;
	}
	const title = dlg.querySelector<HTMLInputElement>("#nb-chart-title");
	if (title) {
		title.value = "Sales";
		title.dispatchEvent(new Event("input", { bubbles: true }));
	}
	await press(api, dlg.querySelector(".nb-modal-foot .mod-cta"));
	await sleep(100);
	await api.frames(4);
	v.clearSelection();
	await api.frames(3);
	const n = pageOf(v).strokes.filter((s) => parseChartGroup(s.group) !== null).length;
	if (n === 0) throw new Error(`no chart was drawn (${pageOf(v).strokes.length} strokes, dialog open: ${!!q(".nb-chart-dialog")}, notes: ${q(".nb-chart-notes")?.textContent ?? ""}, button disabled: ${String(q<HTMLButtonElement>(".nb-chart-dialog .mod-cta")?.disabled)}, texts: ${(pageOf(v).elements ?? []).length})`);
}
