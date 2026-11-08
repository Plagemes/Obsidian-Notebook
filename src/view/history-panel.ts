// The action history panel (0.25, #84): a dialog on the shared modal shell that lists the steps of the open notebook, newest first, with
// the point the document is at marked, and goes back or forward to any of them with a tap. The jump itself is done by the view through
// the history (history-tools.ts); this file only draws the list and hands the tap back. The rows come from history-panel-logic.ts.
import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import type { JumpTarget } from "../model/history-jump";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import type { HistoryRow } from "./history-panel-logic";

/** What the dialog needs from the view (HistoryTools). */
export interface HistoryPanelApi {
	/** The list as it is now (asked again after every jump). */
	rows(): HistoryRow[];
	/** How many steps the Undo and the Redo stack hold, and how many the history keeps at most. */
	counts(): { undo: number; redo: number; max: number };
	/** The notebook can go to a step (false: read-only mode, a document still loading). The list can always be read. */
	canJump(): boolean;
	/** Goes to the point the row stands for; the view says the outcome (a refused step, a step that is gone). */
	jump(target: JumpTarget): void;
}

/** Row to target: a step row goes just after its command, the start row before the oldest step. */
function targetOf(row: HistoryRow): JumpTarget | null {
	if (row.kind === "start") return { kind: "start" };
	return row.cmd ? { kind: "step", cmd: row.cmd } : null;
}

export class HistoryPanelModal extends Modal {
	/** The first draw scrolls the current row to the middle; the later ones keep the place. */
	private firstDraw = true;

	constructor(app: App, private readonly api: HistoryPanelApi) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const kept = this.firstDraw ? 0 : (this.contentEl.querySelector<HTMLElement>(".nb-modal-body")?.scrollTop ?? 0);
		const rows = this.api.rows();
		const can = this.api.canJump();
		const counts = this.api.counts();
		const shell = modalShell(this, { title: t("histpanel.title"), subtitle: t("histpanel.subtitle"), icon: "history", size: "narrow", cls: "nb-hist-modal" });
		if (!can) shellNote(shell.body, t("histpanel.readOnly"));
		if (rows.length === 0) {
			shellNote(shell.body, t("histpanel.empty"));
		} else {
			const list = shell.body.createDiv({ cls: "nb-hist-list", attr: { role: "list", "aria-label": t("histpanel.title") } });
			let head: "redo" | "undo" | null = null;
			for (const row of rows) {
				const section = row.kind === "start" ? null : row.side;
				if (section !== null && section !== head) {
					head = section;
					list.createDiv({ cls: "nb-hist-head", text: section === "redo" ? t("histpanel.undoneHead") : t("histpanel.madeHead"), attr: { role: "presentation" } });
				}
				this.renderRow(list, row, can);
			}
			shellNote(shell.body, `${t("histpanel.count", { undo: String(counts.undo), redo: String(counts.redo) })} · ${t("histpanel.limit", { max: String(counts.max) })}`);
		}
		shellButton(shell.foot, "secondary", t("histpanel.close"), () => this.close());
		const current = shell.body.querySelector<HTMLElement>(".nb-hist-row.is-current");
		if (this.firstDraw) {
			this.firstDraw = false;
			current?.scrollIntoView({ block: "center" });
		} else {
			shell.body.scrollTop = kept;
		}
	}

	private renderRow(list: HTMLElement, row: HistoryRow, can: boolean): void {
		const cls = ["nb-hist-row", row.side === "redo" ? "is-undone" : "", row.current ? "is-current" : "", row.kind === "start" ? "is-start" : ""].filter((c) => c !== "");
		const el = list.createDiv({ cls: cls.join(" "), attr: { role: "listitem" } });
		const target = targetOf(row);
		const button = el.createEl("button", {
			cls: "nb-hist-row-btn",
			attr: { type: "button", "aria-label": t("histpanel.row.aria", { title: row.title }), ...(row.current ? { "aria-current": "step" } : {}) },
		});
		setIcon(button.createSpan({ cls: "nb-hist-row-icon", attr: { "aria-hidden": "true" } }), row.side === "redo" && row.kind === "step" ? "redo" : row.icon);
		const text = button.createSpan({ cls: "nb-hist-row-text" });
		text.createSpan({ cls: "nb-hist-row-title", text: row.title });
		if (row.detail !== "") text.createSpan({ cls: "nb-hist-row-detail", text: row.detail });
		if (row.current) button.createSpan({ cls: "nb-hist-now", text: t("histpanel.now") });
		// The current point has nowhere to go; without the right to edit nothing can be undone or redone.
		button.disabled = row.current || !can || target === null;
		button.addEventListener("click", () => {
			if (target === null || button.disabled) return;
			this.api.jump(target);
			this.render();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
