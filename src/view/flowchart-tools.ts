import { t } from "../i18n";
import { flowGrid, planFlowchart, type FlowRefusal } from "../ink/flowchart";
import { measureText } from "../ink/renderer";
import { selectableItems } from "../model/groups";
import { gridOf } from "../model/snap";
import { showNotice } from "./notice";
import type { TableHost } from "./table-tools";

/**
 * View side of "Tidy flowchart" (0.30, roadmap #245): on a selection that holds hand-drawn boxes and arrows, line the boxes up, even out the
 * gaps and draw the arrows again from box to box, as ONE undo step through the view's history (which refuses it on a locked page). The
 * recognition, the layout and the undoable plan are in ink/flowchart.ts; this only finds the selection, runs the plan and says what happened.
 * The host is the one of the table tools (the same selection, history, ink in view and redaction guard).
 */
export type FlowchartHost = TableHost;

/** The notice for each reason the tidy-up is refused. */
const REFUSALS: Record<FlowRefusal, Parameters<typeof t>[0]> = {
	few: "flowchart.few",
	nested: "flowchart.nested",
	ambiguous: "flowchart.ambiguous",
	none: "flowchart.none",
	redacted: "flowchart.redacted",
	tape: "flowchart.tape",
	edge: "flowchart.edge",
	gone: "flowchart.few",
};

export class FlowchartTools {
	constructor(private readonly host: FlowchartHost) {}

	/** "Tidy flowchart" on the selection. */
	tidy(): void {
		if (!this.host.editable()) return;
		const doc = this.host.doc();
		const parts = this.host.selection();
		if (!doc || !parts || parts.length === 0) return;
		// A selection across pages would need one layout per page and one shared step: it is not offered.
		if (parts.length > 1) {
			showNotice(t("arrange.crossPage"), 3500);
			return;
		}
		const part = parts[0]!;
		const page = doc.pages[part.pageIndex];
		if (!page) return;
		// What the person may edit: the ink in view (hidden ink and collapsed notes' ink are not), unlocked items, groups completed.
		const ink = this.host.inkOf(page);
		const seen = new Set(ink);
		const picked = selectableItems(page, { strokes: part.strokes.filter((s) => seen.has(s)), elements: part.elements }, ink);
		const step = gridOf(page);
		const plan = planFlowchart(page, picked, {
			grid: flowGrid(step ? step.stepX || step.stepY : undefined), measure: measureText, guard: this.host.redactGuard(page.id),
		});
		if (!plan.ok) {
			showNotice(t(REFUSALS[plan.reason]), 3500);
			return;
		}
		if (!this.host.execute(plan.cmd)) return;
		this.host.select(part.pageIndex, plan.strokes, plan.elements);
		this.host.refresh();
		showNotice(t("flowchart.done", { boxes: String(plan.boxes), arrows: String(plan.arrows) }), 3000);
	}
}
