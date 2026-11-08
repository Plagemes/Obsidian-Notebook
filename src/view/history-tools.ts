// The action history panel, the view side (0.25, #84): opens the dialog and goes to a point of the history. The jump runs through the
// view (`jump`), which does what an Undo does around the history (closes a text being typed, clears the selection, saves, redraws);
// the steps themselves are ordinary History.undo / History.redo, so every guard applies to each one. The dialog is history-panel.ts.
import type { App } from "obsidian";
import { t } from "../i18n";
import type { History } from "../model/history";
import type { JumpResult, JumpTarget } from "../model/history-jump";
import type { NotebookDocument } from "../model/types";
import { HistoryPanelModal, type HistoryPanelApi } from "./history-panel";
import { historyRows, jumpNotice, type HistoryRow } from "./history-panel-logic";
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
	/** Goes to the point (through the history, step by step); null when the view cannot now (a stroke is being drawn). */
	jump(target: JumpTarget): JumpResult | null;
}

export class HistoryTools implements HistoryPanelApi {
	constructor(private readonly host: HistoryHost) {}

	open(): void {
		if (!this.host.doc()) return;
		new HistoryPanelModal(this.host.app, this).open();
	}

	rows(): HistoryRow[] {
		return historyRows(this.host.entries(), this.host.doc(), Date.now());
	}

	counts(): { undo: number; redo: number; max: number } {
		const e = this.host.entries();
		return { undo: e.undo.length, redo: e.redo.length, max: this.host.limit };
	}

	canJump(): boolean {
		return this.host.editable();
	}

	jump(target: JumpTarget): void {
		const result = this.host.jump(target);
		if (!result) {
			showNotice(t("histpanel.notice.busy"), 3000);
			return;
		}
		const message = jumpNotice(result);
		if (message) showNotice(message, result.done < result.wanted ? 6000 : 2500);
	}
}
