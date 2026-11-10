import { t } from "../i18n";
import { chartOfSelection, findSourceTable, planChartInsert, planChartUpdate, tableInSelection, type ChartRefusal, type DetectedChart } from "../ink/chart";
import type { DetectedTable } from "../ink/table";
import { chartDataFromCells } from "../math/chart-layout";
import type { Page } from "../model/types";
import { askChart } from "./chart-dialog";
import { showNotice } from "./notice";
import type { SelectedPart } from "./group-tools";
import type { TableHost } from "./table-tools";

/**
 * View side of charts from table data (0.29, roadmap #244): "Chart from table" on a selected table (asks for the type, title, colour and
 * size, then draws the chart beside the table) and "Update chart" on a selected chart (reads its table again and redraws the chart in the
 * same place). The geometry is in math/chart-layout.ts and the undoable plans in ink/chart.ts; every action is ONE undo step through the
 * view's history, which refuses it on a locked page. A chart is ordinary shapes and text boxes: nothing is added to the document format.
 * The host is the one of the table tools (the same selection, history and ink in view).
 */
export type ChartHost = TableHost;

/** The notice for each reason an update is refused. */
const REFUSALS: Record<Exclude<ChartRefusal, "same">, Parameters<typeof t>[0]> = {
	gone: "chart.gone",
	noLink: "chart.noLink",
	noSource: "chart.noSource",
	noData: "chart.noData",
	locked: "chart.locked",
	states: "chart.noStates",
};

export class ChartTools {
	constructor(private readonly host: ChartHost) {}

	/** The one page the selection is on (null when it spans several or nothing is selected). */
	private part(): { part: SelectedPart; page: Page } | null {
		const sel = this.host.selection();
		const part = sel && sel.length === 1 ? sel[0] : undefined;
		const page = part ? this.host.doc()?.pages[part.pageIndex] : undefined;
		return part && page ? { part, page } : null;
	}

	/** The table the selection holds, with its page (other selected ink is allowed; two tables are not). */
	private table(): { part: SelectedPart; page: Page; table: DetectedTable } | null {
		const cur = this.part();
		const table = cur ? tableInSelection(cur.part.strokes) : null;
		return cur && table ? { ...cur, table } : null;
	}

	private chart(): { part: SelectedPart; page: Page; chart: DetectedChart } | null {
		const cur = this.part();
		const chart = cur ? chartOfSelection(cur.part.strokes, cur.part.elements) : null;
		return cur && chart ? { ...cur, chart } : null;
	}

	/** Whether the selection holds a table a chart can be made from (the "Chart from table" action shows then). */
	isTableChartable(): boolean {
		return this.table() !== null;
	}

	/** Whether the selection is exactly one chart (the "Update chart" action shows then). */
	isChartSelected(): boolean {
		return this.chart() !== null;
	}

	/** "Chart from table": asks, then draws the chart beside the table as one group. */
	async create(): Promise<void> {
		if (!this.host.editable()) return;
		const cur = this.table();
		if (!cur) return;
		const group = cur.table.strokes[0]?.group;
		const source = group === undefined ? null : findSourceTable([cur.page], group);
		if (!source) return;
		const choice = await askChart(this.host.app, chartDataFromCells(source.cells));
		if (!choice) return;
		// The notebook can have changed while the dialog was open: look again, and read the numbers as they are now.
		const now = this.host.doc()?.pages[cur.part.pageIndex];
		if (!now || now.id !== cur.page.id || !this.host.editable() || group === undefined) return;
		const again = findSourceTable([now], group);
		if (!again) return;
		const target = this.host.insertTarget();
		const centre = target && target.pageIndex === cur.part.pageIndex ? { x: target.x, y: target.y } : { x: now.width / 2, y: now.height / 2 };
		const plan = planChartInsert(now, again.table, chartDataFromCells(again.cells), choice, centre, t("chart.other"));
		if (!plan.ok) {
			showNotice(t("chart.noData"), 3500);
			return;
		}
		if (!this.host.execute(plan.cmd)) return;
		this.selectGroup(cur.part.pageIndex, plan.group);
		this.host.refresh();
		showNotice(t("chart.inserted"), 4000);
	}

	/** Selects the chart of group `group` as it is on the page now. */
	private selectGroup(pageIndex: number, group: string): void {
		const after = this.host.doc()?.pages[pageIndex];
		if (after) this.host.select(pageIndex, after.strokes.filter((s) => s.group === group), (after.elements ?? []).filter((e) => e.group === group));
	}

	/** "Update chart": reads the table of the selected chart again and redraws the chart in place. */
	update(): void {
		if (!this.host.editable()) return;
		const cur = this.chart();
		const doc = this.host.doc();
		if (!cur || !doc) return;
		const plan = planChartUpdate(doc.pages, cur.page, cur.chart, this.host.inkOf(cur.page), t("chart.other"));
		if (!plan.ok) {
			// Nothing was changed: say why.
			showNotice(t(plan.reason === "same" ? "chart.same" : REFUSALS[plan.reason]), 3500);
			return;
		}
		if (!this.host.execute(plan.cmd)) return;
		this.selectGroup(cur.part.pageIndex, cur.chart.group);
		this.host.refresh();
		showNotice(t("chart.updated"), 2200);
	}
}
