import { t } from "../i18n";
import { planTimelineInsert, planTimelineUpdate, nearestSize, readTimeline, timelineOfSelection, type DetectedTimeline, type TimelineRefusal } from "../ink/timeline";
import type { TimelineLabels } from "../math/timeline-layout";
import type { Page } from "../model/types";
import { showNotice } from "./notice";
import type { SelectedPart } from "./group-tools";
import type { TableHost } from "./table-tools";
import { askTimeline } from "./timeline-dialog";

/**
 * View side of the timeline element (0.30, roadmap #148): "Timeline" in the insert sheet (asks for the events, a title, the colour and the
 * size, then draws the timeline at the centre of the view) and "Edit timeline" on a selected timeline (asks again with what the timeline says
 * now, then redraws it in the same place). The geometry is in math/timeline-layout.ts and the undoable plans in ink/timeline.ts; every action
 * is ONE undo step through the view's history, which refuses it on a locked page. A timeline is ordinary shapes and text boxes: nothing is
 * added to the document format. The host is the one of the table tools (the same selection, history, ink in view and redaction guard).
 */
export type TimelineHost = TableHost;

/** The notice for each reason an insert or an edit is refused. */
const REFUSALS: Record<Exclude<TimelineRefusal, "same">, Parameters<typeof t>[0]> = {
	noEvents: "timeline.noEvents",
	edge: "timeline.noRoom",
	redacted: "timeline.noRedacted",
	gone: "timeline.gone",
	unreadable: "timeline.unreadable",
	locked: "timeline.locked",
	states: "timeline.noStates",
};

/** The words the layout needs in the language of the plugin. */
export const timelineLabels = (): TimelineLabels => ({ bc: t("timeline.bc"), gap: (n) => t("timeline.gap", { n: String(n) }) });

export class TimelineTools {
	constructor(private readonly host: TimelineHost) {}

	/** The one page the selection is on (null when it spans several or nothing is selected). */
	private part(): { part: SelectedPart; page: Page } | null {
		const sel = this.host.selection();
		const part = sel && sel.length === 1 ? sel[0] : undefined;
		const page = part ? this.host.doc()?.pages[part.pageIndex] : undefined;
		return part && page ? { part, page } : null;
	}

	private timeline(): { part: SelectedPart; page: Page; timeline: DetectedTimeline } | null {
		const cur = this.part();
		const timeline = cur ? timelineOfSelection(cur.part.strokes, cur.part.elements) : null;
		return cur && timeline ? { ...cur, timeline } : null;
	}

	/** Whether the selection is exactly one timeline (the "Edit timeline" action shows then). */
	isTimelineSelected(): boolean {
		return this.timeline() !== null;
	}

	private selectGroup(pageIndex: number, group: string): void {
		const after = this.host.doc()?.pages[pageIndex];
		if (after) this.host.select(pageIndex, after.strokes.filter((s) => s.group === group), (after.elements ?? []).filter((e) => e.group === group));
	}

	/** "Timeline": asks, then draws the timeline at the centre of the view as one group. */
	async insert(): Promise<void> {
		if (!this.host.editable()) return;
		const target = this.host.insertTarget();
		const page = target ? this.host.doc()?.pages[target.pageIndex] : undefined;
		if (!target || !page) return;
		const choice = await askTimeline(this.host.app, { mode: "insert", page, title: "", text: "", labels: timelineLabels() });
		if (!choice) return;
		// The notebook can have changed while the dialog was open: look again.
		const now = this.host.doc()?.pages[target.pageIndex];
		if (!now || now.id !== page.id || !this.host.editable()) return;
		const plan = planTimelineInsert(now, choice, { x: target.x, y: target.y }, timelineLabels(), this.host.redactGuard(now.id));
		if (!plan.ok) {
			showNotice(t(REFUSALS[plan.reason === "same" ? "noEvents" : plan.reason]), 4500);
			return;
		}
		if (!this.host.execute(plan.cmd)) return;
		this.selectGroup(target.pageIndex, plan.group);
		this.host.refresh();
		showNotice(t("timeline.inserted"), 4000);
	}

	/** "Edit timeline": asks again with the events the selected timeline shows, then redraws it in place. */
	async edit(): Promise<void> {
		if (!this.host.editable()) return;
		const cur = this.timeline();
		if (!cur) return;
		const draft = readTimeline(cur.timeline);
		if (typeof draft === "string") {
			showNotice(t(REFUSALS[draft]), 4500);
			return;
		}
		const choice = await askTimeline(this.host.app, {
			mode: "edit", page: cur.page, title: draft.title, text: draft.text, colour: draft.colour, keepWidth: draft.width,
			size: nearestSize(draft.width, cur.page.width), labels: timelineLabels(),
		});
		if (!choice) return;
		// The notebook can have changed while the dialog was open: look again, at the timeline as it is now.
		const doc = this.host.doc();
		const page = doc?.pages[cur.part.pageIndex];
		if (!page || page.id !== cur.page.id || !this.host.editable()) return;
		const group = cur.timeline.group;
		const members = { strokes: page.strokes.filter((s) => s.group === group), elements: (page.elements ?? []).filter((e) => e.group === group) };
		const now = timelineOfSelection(members.strokes, members.elements);
		if (!now) {
			showNotice(t("timeline.gone"), 3500);
			return;
		}
		const plan = planTimelineUpdate(page, now, choice, this.host.inkOf(page), timelineLabels(), this.host.redactGuard(page.id));
		if (!plan.ok) {
			// Nothing was changed: say why.
			showNotice(t(plan.reason === "same" ? "timeline.same" : REFUSALS[plan.reason]), 4000);
			return;
		}
		if (!this.host.execute(plan.cmd)) return;
		this.selectGroup(cur.part.pageIndex, plan.group);
		this.host.refresh();
		showNotice(t("timeline.updated"), 2200);
	}
}
