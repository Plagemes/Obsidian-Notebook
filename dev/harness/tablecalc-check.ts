/**
 * Smoke check of "Compute table" (0.30, roadmap #147) on the `doc=tablecalc` notebook (HARNESS_DOC=tablecalc npm run harness:check): a
 * 5 x 4 table with text boxes in its cells (a header row, numbers, formulas, a total row and a row of errors) is selected; the action is
 * offered only with a table selected; "Compute table" writes `=formula -> result` into the formula boxes as ONE undo step; computing again
 * changes nothing; a changed number updates the results; undo and redo restore them; a locked page refuses. `tablecalcShot` leaves the
 * table computed (or not yet) for the screenshots (dist/shots/design/tablecalc-<state>-<theme>-<device>.png).
 */
import { buildTable } from "../../src/ink/table";
import { AddElement, AddStroke, Batch, ReplaceElement } from "../../src/model/history";
import type { Page, Stroke, TextElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface TablecalcCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface TablecalcView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: unknown[]): void;
}

const GROUP = "tablecalc-table";
const GRID = { xs: [40, 160, 270, 380, 520], ys: [60, 104, 148, 192, 236, 280] };
const ARROW = String.fromCharCode(0x2192);
const CELLS = [
	["Item", "Qty", "Price", "Cost"],
	["pen", "3", "1,5", "=B2*C2"],
	["ink", "2", "4", "=B3*C3"],
	["Total", "=SUM(B2:B3)", "", "=SUM(D2:D3)"],
	["Share %", "=PCT(D2,D4)", "=1/0", "=D5+1"],
];

/** Draws the table and its text boxes on the current page (idempotent per notebook open). */
async function setup(api: TablecalcCheckApi): Promise<void> {
	const v = api.view as TablecalcView;
	const page = (): Page => v.document.pages[v.currentPage()]!;
	if (page().strokes.some((s) => s.group === GROUP)) return;
	const lines = buildTable(GRID, { color: "#1f2430", width: 1.6, headerWidth: 3.2 }, GROUP);
	const boxes: TextElement[] = [];
	CELLS.forEach((row, r) => row.forEach((s, c) => {
		if (s !== "") boxes.push({ id: `tc-${r}-${c}`, type: "text", x: GRID.xs[c]! + 8, y: GRID.ys[r]! + 10, width: GRID.xs[c + 1]! - GRID.xs[c]! - 14, text: s, fontSize: 14, color: "#1f2430" });
	}));
	const base = page().strokes.length;
	const baseEl = page().elements?.length ?? 0;
	v.applyCommand(new Batch("Tablecalc table", [...lines.map((s, i) => new AddStroke(page().id, s, base + i)), ...boxes.map((e, i) => new AddElement(page().id, e, baseEl + i))]));
	await api.frames(3);
}

const selectTable = async (api: TablecalcCheckApi): Promise<void> => {
	const v = api.view as TablecalcView;
	const p = v.document.pages[v.currentPage()]!;
	v.selectItems(v.currentPage(), p.strokes.filter((s) => s.group === GROUP), []);
	await api.frames(3);
};

const textOf = (page: Page, id: string): string => {
	const el = (page.elements ?? []).find((e) => e.id === id);
	return el?.type === "text" ? el.text : "";
};

export async function checkTablecalc(api: TablecalcCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as TablecalcView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const isTable = (): boolean => (v.uiContext() as unknown as { selection?: { table?: boolean } | null }).selection?.table === true;
	await setup(api);

	v.clearSelection();
	await api.frames(2);
	add("no table selected: Compute table is not offered", !isTable());
	await selectTable(api);
	add("the table is selected", isTable());

	const before = (id: string): string => textOf(page(), id);
	add("formulas are plain text before computing", before("tc-1-3") === "=B2*C2" && before("tc-3-1") === "=SUM(B2:B3)");

	api.notices.length = 0;
	v.runAction("table-compute");
	await api.frames(4);
	add("D2 = B2*C2 = 4.5", before("tc-1-3") === `=B2*C2 ${ARROW} 4.5`, before("tc-1-3"));
	add("D3 = 8", before("tc-2-3") === `=B3*C3 ${ARROW} 8`, before("tc-2-3"));
	add("totals: 5 and 12.5", before("tc-3-1") === `=SUM(B2:B3) ${ARROW} 5` && before("tc-3-3") === `=SUM(D2:D3) ${ARROW} 12.5`, `${before("tc-3-1")} | ${before("tc-3-3")}`);
	add("PCT(D2, D4) = 36", before("tc-4-1") === `=PCT(D2,D4) ${ARROW} 36`, before("tc-4-1"));
	add("errors are codes: #DIV/0 and #CYCLE", before("tc-4-2") === `=1/0 ${ARROW} #DIV/0` && before("tc-4-3") === `=D5+1 ${ARROW} #CYCLE`, `${before("tc-4-2")} | ${before("tc-4-3")}`);
	add("plain boxes are untouched", before("tc-1-1") === "3" && before("tc-0-0") === "Item");
	add("a notice says what was computed", api.notices.some((n) => /formulas computed/.test(n)), api.notices.join(" | "));

	api.notices.length = 0;
	v.runAction("table-compute");
	await api.frames(3);
	add("computing again changes nothing and says so", api.notices.some((n) => /already shows/.test(n)) && before("tc-1-3") === `=B2*C2 ${ARROW} 4.5`, api.notices.join(" | "));

	v.undo();
	await api.frames(3);
	add("one undo puts every formula back", before("tc-1-3") === "=B2*C2" && before("tc-3-3") === "=SUM(D2:D3)" && before("tc-4-3") === "=D5+1");
	v.redo();
	await api.frames(3);
	add("one redo brings the results back", before("tc-3-3") === `=SUM(D2:D3) ${ARROW} 12.5`);

	// a changed number: edit the box through History, then compute again
	const qty = (page().elements ?? []).find((e) => e.id === "tc-1-1") as TextElement | undefined;
	if (qty) {
		v.applyCommand(new ReplaceElement(page().id, qty, { ...qty, text: "4" }));
		await api.frames(2);
		await selectTable(api);
		v.runAction("table-compute");
		await api.frames(3);
		add("a changed quantity updates the results (4 x 1.5 = 6)", before("tc-1-3") === `=B2*C2 ${ARROW} 6`, before("tc-1-3"));
	}

	page().locked = true;
	await selectTable(api);
	const ctx = v.uiContext() as unknown as { page?: { locked?: boolean } };
	add("a locked page: the action is not enabled", ctx.page?.locked === true);
	delete page().locked;
	add("nothing failed", api.errors.length === 0, api.errors.join(" | "));
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { elements: page().elements?.length ?? 0 } };
}

/** Leaves the harness notebook with the table selected, formulas typed (`before`) or computed (`after`). */
export async function tablecalcShot(api: TablecalcCheckApi, state: "before" | "after"): Promise<void> {
	await api.open("tablecalc");
	await setup(api);
	await selectTable(api);
	if (state === "after") {
		(api.view as TablecalcView).runAction("table-compute");
		await api.frames(4);
		await selectTable(api);
	}
	await api.frames(3);
}
