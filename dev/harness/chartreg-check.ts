/**
 * Smoke check of the trend line on line charts (0.30, roadmap #295; HARNESS_DOC=chartreg npm run harness:check, the blank "New" notebook).
 * A table with numbers is charted as a line with "Line of best fit": the choice only shows for the line type, the preview draws the dashes
 * and the equation, the inserted chart's group id carries the trend, and "Update chart" after a number changes redraws it with the new
 * equation. `chartregShot` leaves the dialog / the chart for the screenshots (dist/shots/design/chartreg-<state>-<theme>-<device>.png).
 */
import { parseChartGroup } from "../../src/ink/chart";
import { Batch, RemoveElement, removeStrokes, ReplaceElement } from "../../src/model/history";
import type { Stroke, TextElement } from "../../src/model/types";
import { closeDialogs, pageOf, press, selectChart, tableWithNumbers, waitFor, type ChartsView } from "./charts-check";
import type { CheckResult } from "./reading-check";

export interface ChartregCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const isTrendText = (t: string): boolean => t.startsWith("y = ");

async function openLineDialog(api: ChartregCheckApi): Promise<HTMLElement> {
	const v = api.view as ChartsView;
	v.runAction("chart-from-table");
	const dlg = await waitFor(".nb-chart-dialog");
	if (!dlg) throw new Error("the chart dialog did not open");
	const kinds = dlg.querySelectorAll<HTMLElement>(".nb-chart-seg")[0]!.querySelectorAll("button");
	await press(api, kinds[1]); // line
	return dlg;
}

export async function checkChartreg(api: ChartregCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as ChartsView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const chartStrokes = (): Stroke[] => pageOf(v).strokes.filter((s) => parseChartGroup(s.group) !== null);
	const chartTexts = (): TextElement[] => (pageOf(v).elements ?? []).filter((e): e is TextElement => e.type === "text" && parseChartGroup(e.group) !== null);
	const trendLabel = (): string => chartTexts().find((e) => isTrendText(e.text))?.text ?? "";

	await tableWithNumbers(api);
	const dlg = await openLineDialog(api);
	const row = dlg.querySelector<HTMLElement>(".nb-chart-trend");
	add("the dialog has a Trend line choice for the line type", !!row && !row.hidden && row.querySelectorAll("button").length === 2);
	const svgTexts = (): string[] => Array.from(dlg.querySelectorAll(".nb-chart-preview-svg text")).map((t) => t.textContent ?? "");
	add("it is off at first: no equation in the picture", !svgTexts().some(isTrendText));
	await press(api, row?.querySelectorAll("button")[1]);
	add("turning it on draws the equation and R² in the picture", svgTexts().some((t) => isTrendText(t) && t.includes("R²")), svgTexts().join("|"));
	const kinds = dlg.querySelectorAll<HTMLElement>(".nb-chart-seg")[0]!.querySelectorAll("button");
	await press(api, kinds[0]); // bars
	add("the choice is hidden for bars", row?.hidden === true && !svgTexts().some(isTrendText));
	await press(api, kinds[1]);
	add("and back for a line", row?.hidden === false && svgTexts().some(isTrendText));
	await press(api, dlg.querySelector(".nb-modal-foot .mod-cta"));
	await sleep(100);
	await api.frames(4);

	const group = chartStrokes()[0]?.group;
	add("inserting makes a line chart whose group id carries the trend", parseChartGroup(group)?.kind === "line" && parseChartGroup(group)?.trend === true, group ?? "");
	const first = trendLabel();
	add("the chart holds the equation and R² as a small text box", /^y = .*R² = /.test(first), first);

	selectChart(v);
	await api.frames(2);
	const page = pageOf(v);
	const cell = (page.elements ?? []).find((e): e is TextElement => e.type === "text" && e.id.endsWith("-3-1"))!;
	v.history.execute(new ReplaceElement(page.id, cell, { ...cell, text: "40" }));
	v.renderer.invalidate();
	selectChart(v);
	await api.frames(2);
	v.runAction("chart-update");
	await api.frames(3);
	const second = trendLabel();
	add("Update chart keeps the trend and refits it to the new numbers", second !== "" && second !== first && parseChartGroup(chartStrokes()[0]?.group)?.trend === true, `${first} -> ${second}`);
	v.undo();
	await api.frames(2);
	add("one undo brings the old equation back", trendLabel() === first);
	v.clearSelection();
	await api.frames(2);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: pageOf(v).strokes.length } };
}

/** Leaves the dialog (`dialog`, line + trend on) or the inserted chart (`chart`) for the screenshot. */
export async function chartregShot(api: ChartregCheckApi, state: "dialog" | "chart"): Promise<void> {
	await closeDialogs(api);
	await api.open("chartreg");
	const v = api.view as ChartsView;
	const page = pageOf(v);
	const clear = removeStrokes(page.id, page.strokes, page.strokes, "Clear");
	const commands = [...(clear ? [clear] : []), ...(page.elements ?? []).map((e) => new RemoveElement(page.id, e))];
	if (commands.length > 0) v.history.execute(new Batch("Clear", commands));
	v.renderer.invalidate();
	await tableWithNumbers(api);
	const dlg = await openLineDialog(api);
	await press(api, dlg.querySelector<HTMLElement>(".nb-chart-trend")?.querySelectorAll("button")[1]);
	if (state === "dialog") {
		if (!dlg.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(dlg);
		await api.frames(3);
		if (!dlg.isConnected || dlg.getBoundingClientRect().height < 50) throw new Error("the chart dialog is not on screen");
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
	if (pageOf(v).strokes.filter((s) => parseChartGroup(s.group) !== null).length === 0) throw new Error("no chart was drawn");
}
