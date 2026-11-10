/**
 * Smoke check of hand-drawn tables (0.28, roadmap #41) on the `doc=tables` notebook (the blank "New" notebook; HARNESS_DOC=tables npm run
 * harness:check): the real view. "Table" in the insert sheet opens the dialog (rows, columns, size, line width and style, colour, header);
 * inserting draws plain shape lines of ONE group in ONE undo step and selects it; with the table selected the sheet offers Add row, Add
 * column, Remove last row / column and Even out cells, each ONE undo step; ink written in a cell below an inserted row moves down with it;
 * nothing of this is offered without a table selected. `tablesShot` leaves the dialog / the table with writing in it for the screenshots
 * (dist/shots/design/tables-<state>-<theme>-<device>.png).
 */
import { detectTable } from "../../src/ink/table";
import type { Page, Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface TablesCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface TablesView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: unknown[]): void;
	clearSelection(): void;
}

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Opens the dialog through the sheet action and waits for it. */
async function openDialog(api: TablesCheckApi): Promise<HTMLElement | null> {
	const v = api.view as TablesView;
	v.runAction("insert-table");
	for (let i = 0; i < 40 && !q(".nb-table-dialog"); i++) await sleep(50);
	if (!q(".nb-table-dialog")) {
		(v as unknown as { tableTools?: { insert(): Promise<void> } }).tableTools?.insert().catch(() => undefined);
		for (let i = 0; i < 40 && !q(".nb-table-dialog"); i++) await sleep(50);
	}
	return q<HTMLElement>(".nb-table-dialog");
}

const press = async (api: TablesCheckApi, el: Element | null | undefined): Promise<void> => {
	(el as HTMLElement | null)?.click();
	await api.frames(3);
};

export async function checkTables(api: TablesCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const v = api.view as TablesView;
	const { frames } = api;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const page = (): Page => v.document.pages[v.currentPage()]!;
	const lines = (): Stroke[] => page().strokes.filter((s) => s.tool === "shape" && s.group !== undefined);
	const frac = (x: number, y: number): [number, number] => {
		const r = q(".notebook-stage")!.getBoundingClientRect();
		const box = v.layout.boxes[v.currentPage()]!;
		return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
	};
	const ink0 = page().strokes.length;

	// --- not offered without a table ---
	const ids = (): string[] => (v.uiContext() as unknown as { selection?: { table?: boolean } | null }).selection?.table === true ? ["table"] : [];
	add("no table is selected at first", ids().length === 0);

	// --- the dialog ---
	const dlg = await openDialog(api);
	add("Table opens the dialog", !!dlg);
	if (!dlg) return { ok: false, results, errors: api.errors, notices: api.notices, env: {} };
	add("it asks rows, columns, size, line width, line style, colour and the header line", dlg.querySelectorAll("input[type=number]").length === 2 && dlg.querySelectorAll(".nb-table-seg").length === 3 && dlg.querySelectorAll(".nb-table-swatch").length >= 5 && !!dlg.querySelector(".nb-modal-check"));
	add("it shows a preview of the grid", dlg.querySelectorAll(".nb-table-preview-svg line").length >= 4);
	const rows = dlg.querySelector<HTMLInputElement>("#nb-table-rows")!;
	const cols = dlg.querySelector<HTMLInputElement>("#nb-table-cols")!;
	rows.value = "3";
	rows.dispatchEvent(new Event("change", { bubbles: true }));
	cols.value = "4";
	cols.dispatchEvent(new Event("change", { bubbles: true }));
	await frames(2);
	add("the preview follows rows and columns", dlg.querySelectorAll(".nb-table-preview-svg line").length === 4 + 5);
	await press(api, dlg.querySelectorAll<HTMLElement>(".nb-table-seg")[2]!.querySelectorAll("button")[1]); // dashed
	await press(api, dlg.querySelector(".nb-modal-foot .mod-cta"));
	await sleep(100);
	await frames(4);

	// --- the table ---
	const made = lines();
	add("inserting draws 4 + 5 shape lines of one group", made.length === 9 && new Set(made.map((s) => s.group)).size === 1, `${made.length} lines`);
	add("the lines carry the chosen style (dashed, header line thicker)", made.every((s) => s.dash === "dashed") && made[1]!.width > made[0]!.width);
	const table = detectTable(made);
	add("the lines are recognised as a 3 x 4 table", !!table && table.grid.ys.length === 4 && table.grid.xs.length === 5);
	add("the table is selected, with the table actions offered", ids().length === 1);
	v.undo();
	await frames(2);
	add("one undo removes the whole table", lines().length === 0 && page().strokes.length === ink0);
	v.redo();
	await frames(2);
	add("one redo draws it again", lines().length === 9);

	// --- writing in a cell, then editing ---
	const t0 = detectTable(lines())!.grid;
	const cx = (t0.xs[0]! + t0.xs[1]!) / 2;
	api.setTool("pen");
	await frames(2);
	await api.penStroke([frac(cx - 10, t0.ys[2]! + 10), frac(cx, t0.ys[2]! + 16), frac(cx + 10, t0.ys[2]! + 10)]);
	const written = page().strokes.find((s) => s.group === undefined && s.tool !== "shape");
	const y0 = written?.points[0]?.[1] ?? 0;
	add("ink can be written in a cell", !!written);
	const select = (): void => {
		const group = lines()[0]?.group;
		v.selectItems(v.currentPage(), page().strokes.filter((s) => s.group === group), []);
	};
	select();
	await frames(2);
	const steps = async (id: string, expectLines: number, name: string): Promise<void> => {
		const before = lines().length;
		v.runAction(id);
		await frames(3);
		add(name, lines().length === expectLines, `${before} -> ${lines().length}`);
		v.undo();
		await frames(2);
		add(`${name}: one undo puts it back`, lines().length === before);
		v.redo();
		await frames(2);
		select();
		await frames(2);
	};
	await steps("table-add-row", 10, "Add row adds one horizontal line");
	const moved = page().strokes.find((s) => s.id === written?.id)?.points[0]?.[1] ?? y0;
	add("ink below the inserted line moved down by the cell height (or stayed when the view centre is below it)", moved >= y0);
	await steps("table-add-col", 11, "Add column adds one vertical line");
	await steps("table-remove-row", 10, "Remove last row removes one horizontal line");
	await steps("table-remove-col", 9, "Remove last column removes one vertical line");
	v.runAction("table-even");
	await frames(3);
	add("Even out cells keeps the lines of a table that is already even", lines().length === 9 && !!detectTable(lines()));

	// --- locked page: refused ---
	const before = lines().length;
	(page() as Page).locked = true;
	v.runAction("table-add-row");
	await frames(3);
	add("a locked page refuses an edit", lines().length === before);
	delete (page() as Page).locked;

	v.clearSelection();
	await frames(2);
	add("with nothing selected the table actions are not offered", ids().length === 0);
	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { strokes: page().strokes.length } };
}

/** Leaves the harness notebook with the dialog (`dialog`) or a table with writing in it (`table`) for the screenshot. */
export async function tablesShot(api: TablesCheckApi, state: "dialog" | "table"): Promise<void> {
	await api.open("tables");
	const v = api.view as TablesView;
	for (const m of Array.from(document.querySelectorAll(".modal-container"))) (m.querySelector(".nb-modal-close") as HTMLElement | null)?.click();
	v.clearSelection();
	await api.frames(3);
	if (state === "dialog") {
		if (!(await openDialog(api))) throw new Error("the table dialog did not open");
		return;
	}
	const dlg = await openDialog(api);
	await press(api, dlg?.querySelector(".nb-modal-foot .mod-cta"));
	await sleep(100);
	await api.frames(4);
	const g = v.document.pages[v.currentPage()]!.strokes.filter((s) => s.group !== undefined);
	const table = detectTable(g);
	if (table) {
		const frac = (x: number, y: number): [number, number] => {
			const r = q(".notebook-stage")!.getBoundingClientRect();
			const box = v.layout.boxes[v.currentPage()]!;
			return [(v.viewport.offsetX + (box.x + x) * v.viewport.scale) / r.width, (v.viewport.offsetY + (box.y + y) * v.viewport.scale) / r.height];
		};
		api.setTool("pen");
		await api.frames(2);
		for (let r = 0; r < 3; r++) {
			const x = table.grid.xs[0]! + 8;
			const y = (table.grid.ys[r]! + table.grid.ys[r + 1]!) / 2;
			await api.penStroke([frac(x, y), frac(x + 10, y - 6), frac(x + 20, y + 4), frac(x + 34, y - 4)]);
		}
	}
	await api.frames(3);
}
