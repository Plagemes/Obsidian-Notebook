// 0.20 visual version diff (#121): the read-only dialog that shows what changed, page by page, between two versions of a
// notebook (a version-history snapshot or backup against the open notebook, or two versions against each other). A list of the
// pages with what happened to each (added, removed, modified, counts), a preview of the chosen page in three views (before,
// overlay, after) with added ink in green, removed ink ghosted in red and moved or changed items outlined in amber, and one
// action that writes: "Restore this page", which goes through the page-restore planner (History, lock respected, confirmed).
// Nothing else here writes. Pages are drawn lazily, one at a time, at the dialog's size, and kept in a small cache.
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { DIFF_MODES, renderDiffCanvas, type DiffMode } from "../ink/diff-render";
import { planDiffRestore } from "../model/diff-restore";
import type { Command } from "../model/history";
import type { NotebookDocument, Page } from "../model/types";
import {
	changedPageCount, diffDocuments, isChangedPage, totalChanges, type DocDiff, type PageDiff, type PageProp,
} from "../model/version-diff";
import { formatSnapshotDate } from "../storage/history";
import { filterChips } from "../ui/components/chip";
import { modalShell, shellButton, shellNote, setShellButtonLabel } from "../ui/components/modal-shell";
import { showNotice } from "./notice";
import { confirmAction } from "./sync-safety";

export interface DiffSide {
	doc: NotebookDocument;
	/** What the side is called: "Current notebook" or the date of the version. */
	label: string;
	/** The date shown in the restore button; null for the current notebook. */
	date: Date | null;
}

/** What the dialog needs from the open notebook to restore a page (NotebookView implements it). */
export interface DiffRestoreTarget {
	editableDocument(): NotebookDocument | null;
	applyCommand(cmd: Command, scrollTo?: number): boolean;
}

export interface VersionDiffOptions {
	before: DiffSide;
	after: DiffSide;
	/** The later side is the open notebook itself (the restore always takes the earlier side). */
	afterIsCurrent: boolean;
	/** The open notebook: absent, no restore is offered. */
	restore?: DiffRestoreTarget;
	/** The page to show first (a page id). */
	startPageId?: string | null;
	/** Index of the page in view, where a removed page that has no neighbour goes back. */
	fallbackIndex?: number;
}

/** Rows drawn in the list of all pages at once (the "Changed" list is rarely near this). */
export const LIST_CAP = 400;
/** Canvases kept (one per page, view and width). */
const CACHE_MAX = 10;
const MAX_CANVAS_PX = 1400;
const MIN_CSS_WIDTH = 240;
const MAX_CSS_WIDTH = 720;

type ListFilter = "changed" | "all";

export class VersionDiffModal extends Modal {
	private readonly diff: DocDiff;
	private mode: DiffMode;
	private listFilter: ListFilter;
	private current = 0;
	private readonly cache = new Map<string, HTMLCanvasElement>();
	private listEl: HTMLElement | null = null;
	private toolsEl: HTMLElement | null = null;
	private stageEl: HTMLElement | null = null;
	private restoreBtn: HTMLButtonElement | null = null;
	private opened = false;

	constructor(app: App, private readonly o: VersionDiffOptions) {
		super(app);
		this.diff = diffDocuments(o.before.doc, o.after.doc);
		this.mode = "overlay";
		this.listFilter = changedPageCount(this.diff) > 0 ? "changed" : "all";
		const start = o.startPageId ? this.diff.pages.findIndex((p) => p.id === o.startPageId) : -1;
		const firstChanged = this.diff.pages.findIndex(isChangedPage);
		// The page in view first when it differs, else the first page that does, else the first page.
		this.current = start >= 0 && (isChangedPage(this.diff.pages[start]!) || firstChanged < 0) ? start : Math.max(0, firstChanged);
	}

	onOpen(): void {
		this.opened = true;
		const shell = modalShell(this, {
			title: t("vdiff.title"), subtitle: t("vdiff.subtitle", { before: this.o.before.label, after: this.o.after.label }),
			icon: "git-compare", size: "wide", cls: "nb-vdiff-modal", seed: "version-diff",
		});
		this.renderSummary(shell.body);
		this.toolsEl = shell.body.createDiv({ cls: "nb-vdiff-tools" });
		const main = shell.body.createDiv({ cls: "nb-vdiff-main" });
		this.listEl = main.createDiv({ cls: "nb-vdiff-list", attr: { role: "list", "aria-label": t("vdiff.filter.label") } });
		this.stageEl = main.createDiv({ cls: "nb-vdiff-stage" });
		shell.body.createDiv({ cls: "nb-vdiff-preview-note", text: t("vdiff.note.preview") });
		shellButton(shell.foot, "secondary", t("vdiff.close"), () => this.close());
		if (this.o.restore) {
			this.restoreBtn = shellButton(shell.foot, "primary", "", () => void this.restorePage(), { icon: "history" });
			this.restoreBtn.addClass("nb-vdiff-restore");
		}
		this.renderTools();
		this.renderList();
		this.renderStage();
	}

	onClose(): void {
		this.opened = false;
		for (const c of this.cache.values()) {
			c.width = 0;
			c.height = 0;
		}
		this.cache.clear();
		this.contentEl.empty();
	}

	// ----------------------------------------------------------------- summary

	private renderSummary(body: HTMLElement): void {
		const s = this.diff.summary;
		const box = body.createDiv({ cls: "nb-vdiff-summary" });
		const items = totalChanges(s.counts);
		if (s.pagesAdded + s.pagesRemoved + s.pagesModified + s.pagesReordered + s.pagesUnchecked === 0 && items === 0) {
			box.createDiv({ cls: "nb-vdiff-summary-line is-same", text: t("vdiff.summary.same") });
			return;
		}
		box.createDiv({
			cls: "nb-vdiff-summary-line",
			text: t("vdiff.summary.pages", { added: String(s.pagesAdded), removed: String(s.pagesRemoved), modified: String(s.pagesModified), unchanged: String(s.pagesUnchanged) }),
		});
		box.createDiv({
			cls: "nb-vdiff-summary-line",
			text: t("vdiff.summary.items", { added: String(s.counts.added), removed: String(s.counts.removed), changed: String(s.counts.changed), moved: String(s.counts.moved) }),
		});
		if (s.pagesReordered > 0) box.createDiv({ cls: "nb-vdiff-summary-line", text: t("vdiff.summary.reordered", { count: String(s.pagesReordered) }) });
		if (this.diff.truncated) shellNote(box, t("vdiff.truncated", { count: String(s.pagesUnchecked) }));
	}

	// ----------------------------------------------------------------- tools: list filter and view

	private renderTools(): void {
		const bar = this.toolsEl;
		if (!bar) return;
		bar.empty();
		const changed = changedPageCount(this.diff);
		filterChips<ListFilter>(bar, [
			{ id: "changed", label: `${t("vdiff.filter.changed")} · ${changed}` },
			{ id: "all", label: `${t("vdiff.filter.all")} · ${this.diff.pages.length}` },
		], this.listFilter, (id) => {
			this.listFilter = id;
			this.renderTools();
			this.renderList();
		}, t("vdiff.filter.label"));
		const modes = bar.createDiv({ cls: "nb-vdiff-modes" });
		filterChips<DiffMode>(modes, DIFF_MODES.map((m) => ({ id: m, label: t(`vdiff.mode.${m}`) })), this.mode, (id) => {
			this.mode = id;
			this.renderTools();
			this.renderStage();
		}, t("vdiff.mode.label"));
		const hints: Record<DiffMode, string> = {
			before: t("vdiff.mode.beforeHint", { label: this.o.before.label }),
			after: t("vdiff.mode.afterHint", { label: this.o.after.label }),
			overlay: t("vdiff.mode.overlayHint"),
		};
		for (const chipEl of Array.from(modes.querySelectorAll<HTMLElement>(".nb-chip"))) {
			const key = chipEl.dataset.key?.replace("chip:", "") as DiffMode | undefined;
			if (key) chipEl.title = hints[key];
		}
	}

	// ----------------------------------------------------------------- page list

	private visiblePages(): number[] {
		const out: number[] = [];
		this.diff.pages.forEach((pd, i) => {
			if (this.listFilter === "all" || isChangedPage(pd) || i === this.current) out.push(i);
		});
		return out;
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		const rows = this.visiblePages();
		if (rows.length === 0) {
			shellNote(list, t("vdiff.list.empty"));
			return;
		}
		let shown = 0;
		for (const i of rows) {
			if (shown >= LIST_CAP && i !== this.current) continue;
			shown++;
			this.renderRow(list, i);
		}
		if (rows.length > LIST_CAP) shellNote(list, t("vdiff.list.capped", { count: String(LIST_CAP) }));
	}

	private pageTitle(pd: PageDiff): string {
		return pd.status === "removed" ? t("vdiff.page.removed", { n: String(pd.beforeIndex + 1) }) : t("pageRestore.pageLabel", { n: String(pd.afterIndex + 1) });
	}

	private statusText(pd: PageDiff): string {
		if (pd.status === "unchanged" && pd.reordered) return t("vdiff.status.moved");
		return t(`vdiff.status.${pd.status}`);
	}

	private renderRow(list: HTMLElement, i: number): void {
		const pd = this.diff.pages[i]!;
		const row = list.createEl("button", {
			cls: `nb-vdiff-row is-${pd.status}${pd.reordered ? " is-reordered" : ""}${i === this.current ? " is-selected" : ""}`,
			attr: { type: "button", role: "listitem", "aria-current": i === this.current ? "true" : "false" },
		});
		row.dataset.page = pd.id;
		row.createSpan({ cls: "nb-vdiff-dot", attr: { "aria-hidden": "true" } });
		const text = row.createSpan({ cls: "nb-vdiff-row-text" });
		text.createSpan({ cls: "nb-vdiff-row-title", text: this.pageTitle(pd) });
		text.createSpan({ cls: "nb-vdiff-row-status", text: this.statusText(pd) });
		const c = pd.counts;
		if (c.added + c.removed + c.changed + c.moved > 0) {
			row.createSpan({ cls: "nb-vdiff-row-counts", text: t("vdiff.row.counts", { added: String(c.added), removed: String(c.removed), changed: String(c.changed + c.moved) }) });
		}
		row.addEventListener("click", () => this.select(i));
	}

	private select(i: number): void {
		if (i === this.current) return;
		this.current = i;
		this.renderList();
		this.renderStage();
	}

	/** The nearest page that differs in a direction (wraps no further than the ends). */
	private step(dir: 1 | -1): number {
		for (let i = this.current + dir; i >= 0 && i < this.diff.pages.length; i += dir) {
			if (isChangedPage(this.diff.pages[i]!)) return i;
		}
		return -1;
	}

	// ----------------------------------------------------------------- the preview

	private pageOf(side: DiffSide, index: number): Page | null {
		return index >= 0 ? side.doc.pages[index] ?? null : null;
	}

	private cssWidth(): number {
		const w = this.stageEl?.clientWidth ?? 0;
		return Math.min(MAX_CSS_WIDTH, Math.max(MIN_CSS_WIDTH, w > 0 ? w - 16 : 420));
	}

	private canvasFor(pd: PageDiff, mode: DiffMode, cssWidth: number): HTMLCanvasElement | null {
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const px = Math.min(MAX_CANVAS_PX, Math.round(cssWidth * dpr));
		const key = `${pd.id}|${mode}|${px}`;
		const have = this.cache.get(key);
		if (have) {
			// Most recently used last.
			this.cache.delete(key);
			this.cache.set(key, have);
			return have;
		}
		const canvas = renderDiffCanvas(this.pageOf(this.o.before, pd.beforeIndex), this.pageOf(this.o.after, pd.afterIndex), pd, mode, { width: px, missingLabel: t("vdiff.stage.missing") });
		if (!canvas) return null;
		this.cache.set(key, canvas);
		while (this.cache.size > CACHE_MAX) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			const gone = this.cache.get(oldest);
			if (gone) {
				gone.width = 0;
				gone.height = 0;
			}
			this.cache.delete(oldest);
		}
		return canvas;
	}

	private renderStage(): void {
		const stage = this.stageEl;
		if (!stage || !this.opened) return;
		stage.empty();
		const pd = this.diff.pages[this.current];
		if (!pd) {
			shellNote(stage, t("vdiff.list.empty"));
			this.updateRestore();
			return;
		}
		const head = stage.createDiv({ cls: "nb-vdiff-stage-head" });
		const prev = this.step(-1);
		const next = this.step(1);
		const nav = (dir: "prev" | "next", icon: string, to: number) => {
			const b = head.createEl("button", { cls: "nb-vdiff-nav", attr: { type: "button", "aria-label": t(`vdiff.${dir}`), title: t(`vdiff.${dir}`) } });
			b.disabled = to < 0;
			b.createSpan({ cls: `nb-vdiff-nav-icon is-${icon}`, attr: { "aria-hidden": "true" } });
			b.addEventListener("click", () => this.select(to));
			return b;
		};
		nav("prev", "left", prev);
		const title = head.createDiv({ cls: "nb-vdiff-stage-title" });
		title.createSpan({ cls: "nb-vdiff-stage-page", text: this.pageTitle(pd) });
		title.createSpan({ cls: `nb-vdiff-stage-status is-${pd.status}`, text: this.statusText(pd) });
		nav("next", "right", next);
		const legend = stage.createDiv({ cls: "nb-vdiff-legend", attr: { "aria-hidden": "true" } });
		for (const k of ["added", "removed", "changed"] as const) {
			const item = legend.createSpan({ cls: "nb-vdiff-legend-item" });
			item.createSpan({ cls: `nb-vdiff-swatch is-${k}` });
			item.createSpan({ text: t(`vdiff.legend.${k}`) });
		}
		const wrap = stage.createDiv({ cls: "nb-vdiff-canvas-wrap" });
		if (pd.status === "unchecked") {
			shellNote(wrap, t("vdiff.stage.unchecked"));
		} else {
			const canvas = this.canvasFor(pd, this.mode, this.cssWidth());
			if (canvas) {
				canvas.addClass("nb-vdiff-canvas");
				canvas.setAttribute("role", "img");
				canvas.setAttribute("aria-label", t("vdiff.stage.label", { page: this.pageTitle(pd), mode: t(`vdiff.mode.${this.mode}`) }));
				wrap.appendChild(canvas);
			}
			if (pd.status === "unchanged" && !pd.reordered) shellNote(stage, t("vdiff.stage.same"));
		}
		if (pd.props.length > 0) {
			stage.createDiv({ cls: "nb-vdiff-props", text: t("vdiff.props", { props: pd.props.map((p: PageProp) => t(`vdiff.prop.${p}`)).join(", ") }) });
		}
		this.updateRestore();
	}

	// ----------------------------------------------------------------- restore

	/** The version a restore takes the page from: the earlier one; with two old versions, the one on show (overlay: the earlier). */
	private restoreSide(): DiffSide {
		return !this.o.afterIsCurrent && this.mode === "after" ? this.o.after : this.o.before;
	}

	private updateRestore(): void {
		const btn = this.restoreBtn;
		if (!btn) return;
		const pd = this.diff.pages[this.current];
		const side = this.restoreSide();
		const there = !!pd && side.doc.pages.some((p) => p.id === pd.id);
		setShellButtonLabel(btn, t("vdiff.restore", { date: side.date ? formatSnapshotDate(side.date) : side.label }));
		btn.disabled = !there;
		btn.title = there ? "" : t("vdiff.restore.notThere");
	}

	private async restorePage(): Promise<void> {
		const target = this.o.restore;
		const pd = this.diff.pages[this.current];
		if (!target || !pd) return;
		const side = this.restoreSide();
		const plan = (): ReturnType<typeof planDiffRestore> | null => {
			const doc = target.editableDocument();
			return doc ? planDiffRestore(doc, side.doc, pd.id, this.diff.pages, this.o.fallbackIndex ?? 0) : null;
		};
		const first = plan();
		if (!first) {
			showNotice(t("merge.notEditable"));
			return;
		}
		if (first.kind === "locked") {
			showNotice(t("lock.needsUnlock", { n: String(first.n) }));
			return;
		}
		if (first.kind !== "ok") {
			showNotice(first.kind === "not-in-version" ? t("vdiff.restore.notThere") : t("merge.notEditable"));
			return;
		}
		const date = side.date ? formatSnapshotDate(side.date) : side.label;
		const body = first.mode === "replace"
			? t("vdiff.restore.confirmReplace", { n: String(first.target + 1), date })
			: t("vdiff.restore.confirmInsert", { n: String(first.target + 1), date });
		if (!(await confirmAction(this.app, t("vdiff.restore.confirmTitle"), body, t("vdiff.restore.confirm")))) return;
		// The notebook may have changed while the question was open: plan again from what is there now.
		const now = plan();
		if (!now || now.kind !== "ok") {
			showNotice(now?.kind === "locked" ? t("lock.needsUnlock", { n: String(now.n) }) : t("merge.notEditable"));
			return;
		}
		if (!target.applyCommand(now.plan.command, now.plan.pageIndex)) {
			showNotice(t("merge.notEditable"));
			return;
		}
		showNotice(t("pageRestore.done"));
		this.close();
	}
}
