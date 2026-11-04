import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { CommentFilter, ThreadRef } from "../model/comments";

/** What the panel asks the controller to do. */
export interface PanelActions {
	/** Jump to the comment: its page, its region highlighted, its card open. */
	open(pageId: string, id: string): void;
	/** Arms the rectangle for a new comment on a region of the page in view. */
	add(): void;
	close(): void;
}

export interface PanelView {
	threads: readonly ThreadRef[];
	counts: { open: number; resolved: number; total: number };
	filter: CommentFilter;
	selected: { pageId: string; id: string } | null;
	/** New comments can be written (the notebook is editable). */
	canAdd: boolean;
}

/** Events kept from the page below the panel and from the view's shortcuts. */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "mousedown", "contextmenu", "click", "keydown", "keyup", "wheel"] as const;

const FILTERS: ReadonlyArray<{ id: CommentFilter; label: "comments.filter.open" | "comments.filter.resolved" | "comments.filter.all" }> = [
	{ id: "open", label: "comments.filter.open" },
	{ id: "resolved", label: "comments.filter.resolved" },
	{ id: "all", label: "comments.filter.all" },
];

/**
 * The comments side panel (0.18, #86): every comment of the notebook with its page, its text and how many replies it has,
 * filtered by open / resolved / all; a tap jumps to the region and opens its card. Also a button to add a comment on a region
 * of the page. Floats at the right edge of the page area (a bottom sheet on a phone), outside the stage.
 */
export class CommentsPanel {
	readonly el: HTMLElement;
	private readonly chips = new Map<CommentFilter, HTMLButtonElement>();
	private readonly list: HTMLElement;
	private readonly addBtn: HTMLButtonElement;
	private readonly title: HTMLElement;
	private key = "";

	constructor(parent: HTMLElement, private readonly actions: PanelActions, private readonly setFilter: (f: CommentFilter) => void) {
		this.el = parent.createDiv({ cls: "nb-ui nb-cm-panel notebook-hidden", attr: { role: "complementary", "aria-label": t("comments.panel.title"), "data-key": "comments-panel" } });
		for (const type of ISOLATED) this.el.addEventListener(type, (e) => e.stopPropagation());
		const head = this.el.createDiv({ cls: "nb-cm-panel-head" });
		setIcon(head.createSpan({ cls: "nb-cm-panel-icon", attr: { "aria-hidden": "true" } }), "message-square");
		this.title = head.createDiv({ cls: "nb-cm-panel-title", text: t("comments.panel.title") });
		this.addBtn = head.createEl("button", { cls: "nb-cm-icon-btn", attr: { type: "button", "aria-label": t("comments.panel.add"), title: t("comments.panel.add"), "data-key": "comments-panel-add" } });
		setIcon(this.addBtn, "square-plus");
		this.addBtn.addEventListener("click", () => this.actions.add());
		const close = head.createEl("button", { cls: "nb-cm-icon-btn", attr: { type: "button", "aria-label": t("comments.close"), title: t("comments.close"), "data-key": "comments-panel-close" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.actions.close());
		const chips = this.el.createDiv({ cls: "nb-cm-chips", attr: { role: "radiogroup", "aria-label": t("comments.filter.aria") } });
		for (const f of FILTERS) {
			const b = chips.createEl("button", { cls: "nb-cm-chip", attr: { type: "button", role: "radio", "data-key": `comments-filter:${f.id}` } });
			b.addEventListener("click", () => this.setFilter(f.id));
			this.chips.set(f.id, b);
		}
		this.list = this.el.createDiv({ cls: "nb-cm-list", attr: { role: "list" } });
	}

	get open(): boolean {
		return !this.el.hasClass("notebook-hidden");
	}

	setOpen(open: boolean): void {
		this.el.toggleClass("notebook-hidden", !open);
		if (!open) this.key = "";
	}

	/** Redraws the list when what it shows changed. */
	update(view: PanelView): void {
		if (!this.open) return;
		const key = JSON.stringify([view.filter, view.counts, view.canAdd, view.selected, view.threads.map((r) => [r.page.id, r.note, r.replies.length, r.number, r.pageIndex])]);
		if (key === this.key) return;
		this.key = key;
		this.addBtn.disabled = !view.canAdd;
		this.title.setText(t("comments.panel.count", { n: String(view.counts.total) }));
		for (const f of FILTERS) {
			const b = this.chips.get(f.id)!;
			const n = f.id === "open" ? view.counts.open : f.id === "resolved" ? view.counts.resolved : view.counts.total;
			b.setText(t(f.label, { n: String(n) }));
			b.setAttribute("aria-checked", String(view.filter === f.id));
			b.toggleClass("is-on", view.filter === f.id);
		}
		this.list.empty();
		if (view.threads.length === 0) {
			const empty = this.list.createDiv({ cls: "nb-cm-empty" });
			empty.createDiv({ cls: "nb-cm-empty-title", text: t(view.counts.total === 0 ? "comments.empty.none" : "comments.empty.filter") });
			if (view.counts.total === 0) empty.createDiv({ cls: "nb-cm-empty-hint", text: t("comments.empty.hint") });
			return;
		}
		for (const r of view.threads) {
			const on = view.selected?.id === r.note.id && view.selected.pageId === r.page.id;
			const row = this.list.createEl("button", { cls: "nb-cm-row", attr: { type: "button", role: "listitem", "data-key": `comment-row:${r.note.id}` } });
			row.toggleClass("is-active", on);
			row.toggleClass("is-resolved", r.note.resolved === true);
			row.createSpan({ cls: "nb-cm-row-badge", text: String(r.number) });
			const body = row.createDiv({ cls: "nb-cm-row-body" });
			body.createDiv({ cls: "nb-cm-row-text", text: r.note.text !== "" ? r.note.text : t("comments.sketch") });
			const meta = body.createDiv({ cls: "nb-cm-row-meta" });
			meta.createSpan({ text: t("comments.row.page", { page: String(r.pageIndex + 1) }) });
			meta.createSpan({ text: r.note.author });
			if (r.replies.length > 0) meta.createSpan({ text: t("comments.row.replies", { n: String(r.replies.length) }) });
			if (r.note.resolved) setIcon(row.createSpan({ cls: "nb-cm-row-check", attr: { "aria-label": t("comments.resolved"), title: t("comments.resolved") } }), "check");
			row.addEventListener("click", () => this.actions.open(r.page.id, r.note.id));
		}
	}

	destroy(): void {
		this.el.remove();
	}
}
