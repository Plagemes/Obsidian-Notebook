import type { App } from "obsidian";
import { t } from "../i18n";
import {
	cellIndexAt, colsOf, evenCells, gridAt, insertCol, insertRow, normaliseSpec, removeLastCol, removeLastRow, rowsOf, tableOfSelection,
	type DetectedTable, type GridEdit,
} from "../ink/table";
import type { RedactGuard } from "../ink/redact";
import { insertTableCommand, planTableEdit, type TableEditRefusal } from "../ink/table-edit";
import type { Command } from "../model/history";
import type { NotebookDocument, Page, PageElement, Stroke, TextElement } from "../model/types";
import { AddElement } from "../model/history";
import { createId } from "../model/document";
import { readTableCells } from "../ink/table-numbers";
import { planTableCompute, type ComputeRefusal } from "../ink/table-compute";
import { boxBeside } from "../ink/table-report";
import { showNotice } from "./notice";
import { openTableStats } from "./table-stats";

const STATS_BOX_WIDTH = 190;
const STATS_FONT = 15;
import { askTable } from "./table-dialog";
import type { SelectedPart } from "./group-tools";

/**
 * View side of hand-drawn tables (0.28, roadmap #41): the "Insert table" dialog and the edits of a selected table (add a row or a column,
 * remove the last one, even out the cells). The geometry is in ink/table.ts and the undoable commands in ink/table-edit.ts; every action here
 * is ONE undo step through the view's history, which refuses it on a locked page. Nothing is added to the document format.
 */
export interface TableHost {
	app: App;
	doc(): NotebookDocument | null;
	editable(): boolean;
	/** Runs a command as one undo step (false when it was refused: a locked page, a read-only notebook). */
	execute(cmd: Command): boolean;
	/** The selected items, page by page; null when nothing is selected. */
	selection(): SelectedPart[] | null;
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	/** The visible centre of the page in view, in page units. */
	insertTarget(): { pageIndex: number; x: number; y: number } | null;
	penColor(): string;
	/** The ink of a page that is in view (hidden ink and the ink a collapsed note keeps hidden are not in it). */
	inkOf(page: Page): readonly Stroke[];
	refresh(): void;
	/** The redaction boxes of a page, and whether the stored boxes could not be read (an insert never moves ink under a box). */
	redactGuard(pageId: string): RedactGuard;
}

/** The notice for each reason a table edit is refused (`gone` has none). */
const REFUSALS: Record<Exclude<TableEditRefusal, "gone">, Parameters<typeof t>[0]> = {
	states: "table.noStates",
	edge: "table.noRoom",
	redacted: "table.noRedacted",
	tapeLocked: "table.noTapeLocked",
};

/** 0.30 (#147): the notice for each reason "Compute table" changes nothing. */
const COMPUTE_REFUSALS: Record<ComputeRefusal, Parameters<typeof t>[0]> = {
	none: "tablecalc.none",
	same: "tablecalc.same",
	locked: "tablecalc.locked",
	states: "tablecalc.states",
	tape: "tablecalc.tape",
	redacted: "tablecalc.redacted",
};

export class TableTools {
	constructor(private readonly host: TableHost) {}

	/** "Table" in the insert sheet: asks for the size and look, then draws the table at the centre of the view as one group. */
	async insert(): Promise<void> {
		if (!this.host.editable()) return;
		const target = this.host.insertTarget();
		const page = target ? this.host.doc()?.pages[target.pageIndex] : undefined;
		if (!target || !page) return;
		const choice = await askTable(this.host.app, this.host.penColor());
		if (!choice) return;
		// The notebook can have changed while the dialog was open: look again.
		const now = this.host.doc()?.pages[target.pageIndex];
		if (!now || now.id !== page.id || !this.host.editable()) return;
		const spec = normaliseSpec(choice.spec, now.width);
		const grid = gridAt(spec, target.x, target.y, now);
		const made = insertTableCommand(now, grid, choice.style);
		if (!this.host.execute(made.cmd)) return;
		const after = this.host.doc()?.pages[target.pageIndex];
		if (after) this.host.select(target.pageIndex, after.strokes.filter((s) => s.group === made.group), []);
		this.host.refresh();
	}

	/** The table the selection is (one page, nothing but the lines of one group), with its page. */
	private current(): { part: SelectedPart; page: Page; table: DetectedTable } | null {
		const sel = this.host.selection();
		const part = sel && sel.length === 1 ? sel[0] : undefined;
		const page = part ? this.host.doc()?.pages[part.pageIndex] : undefined;
		if (!part || !page) return null;
		const table = tableOfSelection(part.strokes, part.elements.length);
		return table ? { part, page, table } : null;
	}

	/** Whether the selection is a table (the actions show only then). */
	isTableSelected(): boolean {
		return this.current() !== null;
	}

	/** The row and column a new line goes after: those under the centre of the view when it is over the table, else the last ones. */
	private anchor(pageIndex: number, table: DetectedTable): { row: number; col: number } {
		const target = this.host.insertTarget();
		const over = target && target.pageIndex === pageIndex ? target : null;
		return { row: cellIndexAt(table.grid.ys, over?.y ?? Infinity), col: cellIndexAt(table.grid.xs, over?.x ?? Infinity) };
	}

	addRow(): void {
		this.edit((table, pageIndex) => insertRow(table.grid, this.anchor(pageIndex, table).row), "table.row.added", "table.row.max");
	}

	addColumn(): void {
		this.edit((table, pageIndex) => insertCol(table.grid, this.anchor(pageIndex, table).col), "table.col.added", "table.col.max");
	}

	removeRow(): void {
		this.edit((table) => removeLastRow(table.grid), "table.row.removed", "table.row.last");
	}

	removeColumn(): void {
		this.edit((table) => removeLastCol(table.grid), "table.col.removed", "table.col.last");
	}

	/** 0.29 (#295): the statistics card of the selected table; "Insert as text" adds a text box beside it (one undo step). */
	showStats(): void {
		const cur = this.current();
		if (!cur) return;
		const { page, table } = cur;
		const pageId = page.id;
		const cells = readTableCells(table.grid, page.elements ?? []);
		openTableStats(this.host.app, {
			cells,
			cols: colsOf(table.grid),
			insert: (text) => {
				if (!this.host.editable()) return false;
				const now = this.host.doc()?.pages[cur.part.pageIndex];
				if (!now || now.id !== pageId) return false;
				const spot = boxBeside(table.grid, now, STATS_BOX_WIDTH);
				const el: TextElement = { id: createId(), type: "text", x: spot.x, y: spot.y, width: spot.width, text, fontSize: STATS_FONT, color: this.host.penColor() };
				if (!this.host.execute(new AddElement(now.id, el, now.elements?.length ?? 0))) return false;
				this.host.refresh();
				showNotice(t("tableStats.inserted"), 2200);
				return true;
			},
		});
	}

	/** 0.30 (#147): works out the formulas typed in the cells of the selected table; ONE undo step (see ink/table-compute.ts). */
	compute(): void {
		if (!this.host.editable()) return;
		const cur = this.current();
		if (!cur) return;
		const plan = planTableCompute(cur.page, cur.table.grid, this.host.redactGuard(cur.page.id));
		if (!plan.ok) {
			showNotice(t(COMPUTE_REFUSALS[plan.reason]), 3500);
			return;
		}
		if (!this.host.execute(plan.cmd)) return;
		this.host.refresh();
		const { formulas, errors } = plan.summary;
		showNotice(errors > 0 ? t("tablecalc.doneErrors", { formulas: String(formulas), errors: String(errors) }) : t("tablecalc.done", { formulas: String(formulas) }), 3000);
	}

	evenOut(): void {
		this.edit((table) => evenCells(table.grid), "table.even.done", "table.even.already");
	}

	private edit(make: (table: DetectedTable, pageIndex: number) => GridEdit | null, done: Parameters<typeof t>[0], refused: Parameters<typeof t>[0]): void {
		if (!this.host.editable()) return;
		const cur = this.current();
		if (!cur) return;
		const edit = make(cur.table, cur.part.pageIndex);
		if (!edit) {
			showNotice(t(refused), 2500);
			return;
		}
		const made = planTableEdit(cur.page, cur.table, edit, this.host.inkOf(cur.page), undefined, this.host.redactGuard(cur.page.id));
		if (!made.ok) {
			// Nothing was changed: say why (a lost selection needs no words, the person selects the table again).
			if (made.reason !== "gone") showNotice(t(REFUSALS[made.reason]), 3500);
			return;
		}
		if (!this.host.execute(made.cmd)) return;
		const group = cur.table.strokes[0]?.group;
		const after = this.host.doc()?.pages[cur.part.pageIndex];
		if (after && group !== undefined) this.host.select(cur.part.pageIndex, after.strokes.filter((s) => s.group === group), []);
		this.host.refresh();
		showNotice(t(done, { rows: String(rowsOf(edit.grid)), cols: String(colsOf(edit.grid)) }), 2200);
	}
}
