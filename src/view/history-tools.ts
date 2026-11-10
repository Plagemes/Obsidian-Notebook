// The action history panel, the view side (0.25, #84): opens the dialog and goes to a point of the history. The jump runs through the
// view (`jump`), which does what an Undo does around the history (closes a text being typed, clears the selection, saves, redraws);
// the steps themselves are ordinary History.undo / History.redo, so every guard applies to each one. The dialog is history-panel.ts.
import type { App } from "obsidian";
import { t } from "../i18n";
import type { History } from "../model/history";
import type { JumpResult, JumpTarget } from "../model/history-jump";
import type { NotebookDocument } from "../model/types";
import { HistoryPanelModal, type HistoryPanelApi } from "./history-panel";
import { historyRows, jumpNotice, type HistoryRow, type PageView } from "./history-panel-logic";
import { showNotice } from "./notice";

/** What the tools need from the notebook view. */
export interface HistoryHost {
	app: App;
	/** The document the panel names the pages of, or null. */
	doc(): NotebookDocument | null;
	/** The steps of the history (`History.entries`). */
	entries(): ReturnType<History["entries"]>;
	/** The notebook can be changed (not read-only mode, not loading). */
	editable(): boolean;
	/** How many steps the history keeps at most. */
	limit: number;
	/** 0.28 (#98): the page Undo acts on when per-page undo is on; null when it is off (the panel then shows no per-page marks). */
	pageView?(): PageView | null;
	/** Goes to the point (through the history, step by step); null when the view cannot now (a stroke is being drawn). */
	jump(target: JumpTarget, progress: (done: number, wanted: number) => void): JumpResult | Promise<JumpResult> | null;
}

export class HistoryTools implements HistoryPanelApi {
	/** A long jump that is going on (steps taken, steps wanted), or null. */
	private working: { done: number; wanted: number } | null = null;

	constructor(private readonly host: HistoryHost) {}

	open(): void {
		if (!this.host.doc()) return;
		new HistoryPanelModal(this.host.app, this).open();
	}

	rows(): HistoryRow[] {
		return historyRows(this.host.entries(), this.host.doc(), Date.now(), this.host.pageView?.() ?? undefined);
	}

	perPage(): boolean {
		return (this.host.pageView?.() ?? null) !== null;
	}

	counts(): { undo: number; redo: number; max: number } {
		const e = this.host.entries();
		return { undo: e.undo.length, redo: e.redo.length, max: this.host.limit };
	}

	canJump(): boolean {
		return this.host.editable();
	}

	progress(): { done: number; wanted: number } | null {
		return this.working;
	}

	jump(target: JumpTarget, onProgress: () => void): Promise<void> | void {
		const outcome = this.host.jump(target, (done, wanted) => {
			this.working = { done, wanted };
			onProgress();
		});
		if (!outcome) {
			showNotice(t("histpanel.notice.busy"), 3000);
			return;
		}
		if (outcome instanceof Promise) {
			// A long jump goes on slice by slice: the panel shows progress and takes no tap until it ends, then says the outcome.
			return outcome.then(
				(result) => {
					this.working = null;
					this.say(result);
				},
				(e: unknown) => {
					this.working = null;
					throw e;
				},
			);
		}
		this.say(outcome);
	}

	private say(result: JumpResult): void {
		const message = jumpNotice(result);
		if (message) showNotice(message, result.done < result.wanted ? 6000 : 2500);
	}
}
