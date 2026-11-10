/**
 * Smoke check of the table statistics card (0.29, roadmap #295) on the `doc=stats` notebook (HARNESS_DOC=stats npm run harness:check): a
 * 4 x 3 table with text boxes in its cells (a header row, a decimal comma and a word among the numbers) is selected; "Table statistics"
 * opens the card; the numbers are right; a second column adds the fitted line; "Insert as text" adds ONE text box beside the table (one
 * undo step); nothing is offered without a table selected. `statsShot` leaves the card open for the screenshots
 * (dist/shots/design/stats-<state>-<theme>-<device>.png).
 */
import { buildTable } from "../../src/ink/table";
import { AddElement, AddStroke, Batch } from "../../src/model/history";
import type { Page, Stroke, TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface StatsCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface StatsView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: unknown[]): void;
}

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

const GRID = { xs: [60, 160, 260, 360], ys: [60, 100, 140, 180, 220] };
const CELLS = [["x", "y", "note"], ["1", "3", "a"], ["2,5", "6", "b"], ["n/a", "9", "c"]];

/** Draws the table and its text boxes on the current page (idempotent per notebook open). */
async function setup(api: StatsCheckApi): Promise<void> {
	const v = api.view as StatsView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	if (page().strokes.some((s) => s.group === "stats-table")) return;
	const lines = buildTable(GRID, { color: "#1f2430", width: 1.6, headerWidth: 3.2 }, "stats-table");
	const boxes: TextElement[] = [];
	CELLS.forEach((row, r) => row.forEach((s, c) => boxes.push({ id: `st-${r}-${c}`, type: "text", x: GRID.xs[c]! + 8, y: GRID.ys[r]! + 8, width: 80, text: s, fontSize: 14, color: "#1f2430" })));
	const base = page().strokes.length;
	const baseEl = page().elements?.length ?? 0;
	v.applyCommand(new Batch("Stats table", [...lines.map((s, i) => new AddStroke(page().id, s, base + i)), ...boxes.map((e, i) => new AddElement(page().id, e, baseEl + i))]));
	await api.frames(3);
}

const selectTable = async (api: StatsCheckApi): Promise<void> => {
	const v = api.view as StatsView;
	const p = v.document.pages[v.currentPage()]!;
	v.selectItems(v.currentPage(), p.strokes.filter((s) => s.group === "stats-table"), []);
	await api.frames(3);
};

async function openCard(api: StatsCheckApi): Promise<HTMLElement | null> {
	(api.view as StatsView).runAction("table-stats");
	for (let i = 0; i < 40 && !q(".nb-table-stats"); i++) await sleep(50);
	return q<HTMLElement>(".nb-table-stats");
}

const pick = async (api: StatsCheckApi, id: string, value: string): Promise<void> => {
	const sel = q<HTMLSelectElement>(id);
	if (!sel) return;
	sel.value = value;
	sel.dispatchEvent(new Event("change", { bubbles: true }));
	await api.frames(2);
};

export async function checkStats(api: StatsCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as StatsView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const isTable = (): boolean => (v.uiContext() as unknown as { selection?: { table?: boolean } | null }).selection?.table === true;
	await setup(api);

	v.clearSelection();
	await api.frames(2);
	add("no table selected: the statistics action is not offered", !isTable());
	await selectTable(api);
	add("the table is selected", isTable());

	const card = await openCard(api);
	add("Table statistics opens the card", !!card);
	if (!card) return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	const text = (): string => q<HTMLElement>(".nb-stats-results")?.textContent ?? "";
	add("the header row names the columns", Array.from(card.querySelectorAll("#nb-stats-column option")).map((o) => o.textContent).join() === "x,y");
	add("column x: 2 values, 1 skipped, mean 1.75, max 2.5", /2 values \(1 skipped/.test(text()) && text().includes("1.75") && text().includes("2.5"), text());
	await pick(api, "#nb-stats-against", "1");
	add("a second column adds the fitted line, slope and R squared", card.querySelector(".nb-stats-line")?.textContent?.startsWith("y = ") === true && /R squared/.test(text()), text());
	add("it has Copy and Insert as text", card.querySelectorAll(".nb-modal-foot button").length === 3);

	const els = page().elements?.length ?? 0;
	const insert = card.querySelector<HTMLElement>(".nb-modal-foot .mod-cta");
	insert?.click();
	await api.frames(4);
	const added = page().elements?.[els] as TextElement | undefined;
	add("Insert as text adds one text box", (page().elements?.length ?? 0) === els + 1 && added?.type === "text" && added.text.includes("Mean"), added?.text ?? "");
	add("it sits to the right of the table", !!added && added.x > GRID.xs[3]! - 1 || (!!added && added.y > GRID.ys[4]!));
	add("the card closed", !q(".nb-table-stats"));
	v.undo();
	await api.frames(2);
	add("one undo removes it", (page().elements?.length ?? 0) === els);
	v.redo();
	await api.frames(2);
	add("one redo brings it back", (page().elements?.length ?? 0) === els + 1);

	page().locked = true;
	await selectTable(api);
	const c2 = await openCard(api);
	c2?.querySelector<HTMLElement>(".nb-modal-foot .mod-cta")?.click();
	await api.frames(3);
	add("a locked page refuses the text box", (page().elements?.length ?? 0) === els + 1);
	for (const m of Array.from(document.querySelectorAll(".modal-container"))) m.querySelector<HTMLElement>(".nb-modal-close")?.click();
	delete page().locked;
	add("nothing failed", api.errors.length === 0, api.errors.join(" | "));
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { elements: page().elements?.length ?? 0 } };
}

/** Leaves the harness notebook with the card open, with a line fitted (`line`) or only the summary (`summary`). */
export async function statsShot(api: StatsCheckApi, state: "summary" | "line"): Promise<void> {
	await api.open("stats");
	for (const m of Array.from(document.querySelectorAll(".modal-container"))) m.querySelector<HTMLElement>(".nb-modal-close")?.click();
	await setup(api);
	await selectTable(api);
	if (!(await openCard(api))) throw new Error("the statistics card did not open");
	if (state === "line") await pick(api, "#nb-stats-against", "1");
	await api.frames(3);
}
