import { t } from "../i18n";
import {
	markerSets, markerTarget, needsRenumber, parseMarkerGroup, planAddMarker, planRenumber, selectionMarkerKind, type Box, type MarkerRefusal, type MarkerTarget,
} from "../ink/figure-markers";
import { measureText } from "../ink/renderer";
import type { Page } from "../model/types";
import type { SelectedPart } from "./group-tools";
import { showNotice } from "./notice";
import type { TableHost } from "./table-tools";

/**
 * View side of numbered markers on a figure (0.30, roadmap #247): "Add numbered marker" on a selected picture, drawing or marker puts the
 * next numbered circle on it (and its line in the legend under the figure), "Renumber markers" closes the gaps a deletion left and updates the
 * legend. The numbering and the plans are in ink/figure-markers.ts (pure); every action is ONE undo step through the view's history, which
 * refuses it on a locked page. Markers and legends are ordinary shapes and text boxes: nothing is added to the document format. The host is the
 * one of the table tools (the same selection, history and redaction guard) with the size of the text in hand.
 */
export interface MarkerHost extends TableHost {
	/** Font size of the legend text. */
	textSize(): number;
}

/** The notice for each reason an action is refused. */
const REFUSALS: Record<Exclude<MarkerRefusal, "same" | "none">, Parameters<typeof t>[0]> = {
	full: "fm.full",
	redacted: "fm.redacted",
	locked: "fm.locked",
	states: "fm.states",
	nowhere: "fm.nowhere",
};

export class FigureMarkerTools {
	/** The box of the last figure a marker was added to (a drawing's box is lost when only its markers are selected afterwards). View-only. */
	private memo: { pageId: string; set: string; box: Box } | null = null;

	constructor(private readonly host: MarkerHost) {}

	/** The one page the selection is on (null when it spans several or nothing is selected). */
	private part(): { part: SelectedPart; page: Page } | null {
		const sel = this.host.selection();
		const part = sel && sel.length === 1 ? sel[0] : undefined;
		const page = part ? this.host.doc()?.pages[part.pageIndex] : undefined;
		return part && page ? { part, page } : null;
	}

	/** What the selection means for markers (the UI context of the actions): cheap, and only a selection that holds markers looks at the page. */
	state(part: SelectedPart): { kind: "figure" | "region" | "set"; stale: boolean } | null {
		const kind = selectionMarkerKind(part);
		if (kind === null) return null;
		if (kind !== "set") return { kind, stale: false };
		const page = this.host.doc()?.pages[part.pageIndex];
		const target = page ? markerTarget(page, part, measureText) : null;
		const set = page && target ? markerSets(page).get(target.set) : undefined;
		return { kind, stale: !!page && !!set && needsRenumber(page, set) };
	}

	private resolve(): { part: SelectedPart; page: Page; target: MarkerTarget } | null {
		const cur = this.part();
		if (!cur) {
			showNotice(t("fm.noTarget"), 3500);
			return null;
		}
		const target = markerTarget(cur.page, cur.part, measureText);
		if (!target) {
			const mixed = cur.part.strokes.some((s) => parseMarkerGroup(s.group)) || cur.part.elements.some((e) => parseMarkerGroup(e.group));
			showNotice(t(mixed ? "fm.mixed" : "fm.noTarget"), 3500);
			return null;
		}
		return { ...cur, target };
	}

	/** Selects the items of `groups` as they are on the page now. */
	private selectGroups(pageIndex: number, groups: ReadonlySet<string>): void {
		const after = this.host.doc()?.pages[pageIndex];
		if (after) this.host.select(pageIndex, after.strokes.filter((s) => s.group !== undefined && groups.has(s.group)), (after.elements ?? []).filter((e) => e.group !== undefined && groups.has(e.group)));
	}

	/** "Add numbered marker": the next circle on the figure, its legend line, then the new marker selected so it can be dragged to its place. */
	add(): void {
		if (!this.host.editable()) return;
		const cur = this.resolve();
		if (!cur) return;
		let { target } = cur;
		if (target.box === null && this.memo && this.memo.pageId === cur.page.id && this.memo.set === target.set) target = { ...target, box: this.memo.box };
		const plan = planAddMarker(cur.page, target, { color: this.host.penColor(), fontSize: this.host.textSize(), measure: measureText }, this.host.redactGuard(cur.page.id));
		if (!plan.ok) {
			showNotice(t(REFUSALS[plan.reason as keyof typeof REFUSALS] ?? "fm.gone"), 4500);
			return;
		}
		if (!this.host.execute(plan.cmd)) return;
		if (target.box) this.memo = { pageId: cur.page.id, set: target.set, box: target.box };
		this.selectGroups(cur.part.pageIndex, new Set([plan.group]));
		this.host.refresh();
		showNotice(t(plan.legendCreated ? "fm.addedLegend" : "fm.added", { n: String(plan.number) }), plan.legendCreated ? 6000 : 3500);
	}

	/** "Renumber markers": 1, 2, 3 again in the order they have, the legend following, in one step; the selection stays on what it was. */
	renumber(): void {
		if (!this.host.editable()) return;
		const cur = this.resolve();
		if (!cur) return;
		const set = markerSets(cur.page).get(cur.target.set);
		if (!set) {
			showNotice(t("fm.none"), 4000);
			return;
		}
		const plan = planRenumber(cur.page, set, { measure: measureText });
		if (!plan.ok) {
			showNotice(t(plan.reason === "same" ? "fm.same" : plan.reason === "none" ? "fm.none" : REFUSALS[plan.reason]), 4500);
			return;
		}
		const groups = new Set<string>();
		for (const s of cur.part.strokes) if (s.group !== undefined) groups.add(s.group);
		for (const e of cur.part.elements) if (e.group !== undefined) groups.add(e.group);
		if (!this.host.execute(plan.cmd)) return;
		this.selectGroups(cur.part.pageIndex, groups);
		this.host.refresh();
		showNotice(plan.dropped > 0 ? t("fm.renumberedDropped", { n: String(plan.dropped) }) : t("fm.renumbered"), 3500);
	}
}
