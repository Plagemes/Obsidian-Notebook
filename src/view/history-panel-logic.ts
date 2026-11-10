// The rows of the action history panel (0.25, #84): pure, no DOM. The model of the list lives here so the panel (history-panel.ts) only
// draws it and a test can check the order, the highlighted point and the texts without a window.
import { t } from "../i18n";
import type { Command, HistoryEntry } from "../model/history";
import { describeCommand } from "../model/history-describe";
import type { JumpResult } from "../model/history-jump";
import { pageScope, touchesPage } from "../model/page-undo";
import type { NotebookDocument } from "../model/types";

/** 0.28 (#98): per-page undo is on; `pageId` is the page Undo acts on now (null: unknown). */
export interface PageView {
	pageId: string | null;
}

export interface HistoryRow {
	/** "step": a recorded step; "start": before the oldest step the history still holds. */
	kind: "step" | "start";
	/** The step is in the Undo stack (done) or in the Redo stack (undone). The start row is "undo". */
	side: "undo" | "redo";
	/** The command behind a step row (the panel hands it back to jump to the point just after it). */
	cmd?: Command;
	title: string;
	detail: string;
	icon: string;
	/** The document is at the point just after this row. Exactly one row has it. */
	current: boolean;
	/**
	 * 0.28 (#98), only with per-page undo on: "global" = the step touches several pages, the page list or the whole notebook (it is never undone
	 * from one page); "here" = a step of the page Undo acts on now; "other" = a step of another page.
	 */
	scope?: "global" | "here" | "other";
}

/** "p. 3", "p. 3, 4", or "7 pages"; an empty string when the pages are gone from the notebook. */
export function pagesText(doc: NotebookDocument | null, pageIds: readonly string[]): string {
	if (!doc) return "";
	const numbers = pageIds.map((id) => doc.pages.findIndex((p) => p.id === id) + 1).filter((n) => n > 0).sort((a, b) => a - b);
	if (numbers.length === 0) return "";
	if (numbers.length > 3) return t("histpanel.pages", { n: String(numbers.length) });
	return t("histpanel.page", { n: numbers.join(", ") });
}

/** "just now", "12 min ago", or the time of day (with the date when it was not today). Empty when the time is unknown. */
export function timeText(at: number | null, now: number): string {
	if (at === null) return "";
	const ago = now - at;
	if (ago < 45_000) return t("histpanel.time.just");
	if (ago < 3_600_000) return t("histpanel.time.min", { n: String(Math.max(1, Math.round(ago / 60_000))) });
	const when = new Date(at);
	const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return when.toDateString() === new Date(now).toDateString() ? time : `${when.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

/** The notice for the outcome of a jump (null: nothing to say). */
export function jumpNotice(result: JumpResult): string | null {
	if (result.gone) return t("histpanel.notice.gone");
	if (result.direction === null) return null;
	if (result.stopped) return t("histpanel.notice.interrupted", { done: String(result.done), total: String(result.wanted) });
	if (result.done < result.wanted) return t("histpanel.notice.stopped", { done: String(result.done), total: String(result.wanted) });
	return t(result.direction === "undo" ? "histpanel.notice.back" : "histpanel.notice.forward", { n: String(result.done) });
}

/** The title of a step. */
export function titleText(cmd: Command): string {
	const d = describeCommand(cmd);
	return t(d.key, d.thing ? { thing: t(d.thing) } : undefined);
}

/** 0.28 (#98): whether a step is global, on this page or on another one, for a panel that shows the per-page undo state. */
export function scopeOfStep(cmd: Command, view: PageView): "global" | "here" | "other" {
	const scope = pageScope(cmd);
	if (!scope.local) return "global";
	return view.pageId !== null && touchesPage(scope, view.pageId) ? "here" : "other";
}

function stepRow(entry: HistoryEntry, side: "undo" | "redo", current: boolean, doc: NotebookDocument | null, now: number, view?: PageView): HistoryRow {
	const d = describeCommand(entry.cmd);
	const scope = view ? scopeOfStep(entry.cmd, view) : undefined;
	const detail = [
		d.count > 1 ? t("histpanel.items.other", { n: String(d.count) }) : "",
		pagesText(doc, d.pageIds),
		scope === "global" ? t("histpanel.scope.global") : scope === "here" ? t("histpanel.scope.here") : "",
		timeText(entry.at, now),
	].filter((x) => x !== "").join(" · ");
	return { kind: "step", side, cmd: entry.cmd, title: titleText(entry.cmd), detail, icon: d.icon, current, ...(scope ? { scope } : {}) };
}

/**
 * The list, newest first: the undone steps (the one furthest ahead at the top), then the steps made (the one the document is at now
 * first, marked), then "Start of the history". `entries` is `History.entries()`: the undo steps oldest first, the redo steps with the
 * next one first.
 */
export function historyRows(entries: { undo: readonly HistoryEntry[]; redo: readonly HistoryEntry[] }, doc: NotebookDocument | null, now: number, view?: PageView): HistoryRow[] {
	const rows: HistoryRow[] = [];
	for (let i = entries.redo.length - 1; i >= 0; i--) rows.push(stepRow(entries.redo[i]!, "redo", false, doc, now, view));
	for (let i = entries.undo.length - 1; i >= 0; i--) rows.push(stepRow(entries.undo[i]!, "undo", i === entries.undo.length - 1, doc, now, view));
	if (entries.undo.length > 0 || entries.redo.length > 0) {
		rows.push({ kind: "start", side: "undo", title: t("histpanel.start"), detail: t("histpanel.start.detail"), icon: "history", current: entries.undo.length === 0 });
	}
	return rows;
}
