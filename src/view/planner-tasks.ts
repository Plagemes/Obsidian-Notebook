import { setIcon, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { extractTasks, hasTaskItems, plannerPageDates, TaskIndex, type DueTasks, type TaskEntry } from "../integration/planner-tasks";
import type { Page } from "../model/types";

/** Events that must not reach the page or the view's shortcuts (the chip and its panel never take pen input). */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;
/** The view must be still this long before the page in view is looked up. */
const SETTLE_MS = 220;
/** A note that changed is read again no sooner than this after its last change (typing fires a change per pause). */
const CHANGE_MS = 600;
/** Notes read per slice, and the pause between slices (ms): the first pass over a big vault never blocks a frame. */
const SLICE_FILES = 6;
const SLICE_PAUSE = 40;

export interface PlannerTasksHost {
	app: App;
	/** The element the chip floats in (the notebook body). */
	parent(): HTMLElement;
	enabled(): boolean;
	/** The page in view, or null. */
	page(): Page | null;
}

/**
 * Roadmap #266: on a daily or weekly planner page a quiet chip "Tasks due: 3" lists the Markdown tasks of the vault that are due on
 * the page's days. The data is derived and per device: nothing is stored in the notebook, and the overlay is not part of any export.
 * The index is built lazily, the first time a planner page is in view: the notes the metadata cache says hold tasks are read in small
 * slices (cached reads), then kept up to date from the cache's own change events, one note at a time. Looking a page up is a map
 * lookup after a settle timer, never per frame. Read only: tapping a row opens the note at the task's line (the task lines of
 * ordinary notes carry no block id the safe checklist writer could find them by, so no tick is written from here).
 */
export class PlannerTasks {
	readonly index = new TaskIndex();
	private chip: HTMLElement | null = null;
	private panel: HTMLElement | null = null;
	private days: string[] = [];
	private shownKey = "";
	private timer: number | null = null;
	private pumpTimer: number | null = null;
	private started = false;
	private queue = new Set<string>();
	private closeOnOutside: (() => void) | null = null;
	private destroyed = false;

	constructor(private readonly host: PlannerTasksHost) {}

	/** The page in view or the document changed. Cheap: one timer. */
	sync(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.update();
		}, SETTLE_MS);
	}

	/** The days of the page in view that have a chip, for the harness. */
	get shownDays(): readonly string[] {
		return this.chip ? this.days : [];
	}

	get panelOpen(): boolean {
		return this.panel !== null;
	}

	/** The chip (or null), for the harness. */
	get element(): HTMLElement | null {
		return this.chip;
	}

	/** True while the first pass over the vault still has notes to read, for the harness. */
	get busy(): boolean {
		return this.queue.size > 0;
	}

	/** Another document, or the setting changed. */
	reset(): void {
		this.closePanel();
		this.hide();
		this.sync();
	}

	/** A stroke was written: the panel steps out of the way. */
	wrote(): void {
		this.closePanel();
	}

	destroy(): void {
		this.destroyed = true;
		if (this.timer !== null) window.clearTimeout(this.timer);
		if (this.pumpTimer !== null) window.clearTimeout(this.pumpTimer);
		this.timer = this.pumpTimer = null;
		this.queue.clear();
		this.closePanel();
		this.hide();
	}

	// ------------------------------------------------------------------------------------------------ vault events

	/** The metadata cache has (re)read a note. Ignored until a planner page has been in view. */
	fileChanged(file: TFile): void {
		if (!this.started || file.extension !== "md") return;
		const items = this.app.metadataCache.getFileCache(file)?.listItems;
		if (!hasTaskItems(items)) {
			if (this.index.remove(file.path)) this.sync();
			return;
		}
		if (this.index.stampOf(file.path) === file.stat.mtime) return;
		this.queue.add(file.path);
		this.pump(CHANGE_MS);
	}

	fileGone(path: string): void {
		if (!this.started) return;
		this.queue.delete(path);
		if (this.index.remove(path)) this.sync();
	}

	/** A note was renamed: the old name goes, the new one is read (a daily note's day comes from its name). */
	fileRenamed(file: TFile, oldPath: string): void {
		if (!this.started) return;
		this.fileGone(oldPath);
		this.fileChanged(file);
	}

	private get app(): App {
		return this.host.app;
	}

	// ------------------------------------------------------------------------------------------------ the index

	private start(): void {
		if (this.started) return;
		this.started = true;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (hasTaskItems(this.app.metadataCache.getFileCache(f)?.listItems)) this.queue.add(f.path);
		}
		this.pump(0);
	}

	private pump(delay: number): void {
		if (this.pumpTimer !== null || this.destroyed) return;
		this.pumpTimer = window.setTimeout(() => {
			this.pumpTimer = null;
			void this.slice();
		}, delay);
	}

	private async slice(): Promise<void> {
		let n = 0;
		for (const path of this.queue) {
			if (n >= SLICE_FILES || this.destroyed) break;
			this.queue.delete(path);
			const file = this.app.vault.getFileByPath(path);
			if (!file) {
				this.index.remove(path);
				continue;
			}
			n++;
			try {
				const text = await this.app.vault.cachedRead(file);
				this.index.set(path, file.stat.mtime, extractTasks(path, text));
			} catch (e) {
				console.error("[notebook] planner tasks read", e);
			}
		}
		if (this.destroyed) return;
		this.sync();
		if (this.queue.size > 0) this.pump(SLICE_PAUSE);
	}

	// ------------------------------------------------------------------------------------------------ the chip

	private update(): void {
		const page = this.host.page();
		const days = this.host.enabled() ? plannerPageDates(page) : [];
		if (days.length === 0) {
			this.closePanel();
			this.hide();
			this.days = [];
			return;
		}
		this.start();
		const due = this.index.dueOn(days);
		if (due.total === 0) {
			this.closePanel();
			this.hide();
			this.days = days;
			return;
		}
		const key = `${days.join(",")}|${due.items.map((e) => `${e.path}:${e.line}:${e.done ? 1 : 0}:${e.text}`).join("|")}|${due.total}`;
		const moved = days.join(",") !== this.days.join(",");
		this.days = days;
		if (moved) this.closePanel();
		if (this.chip && key === this.shownKey) return;
		this.shownKey = key;
		this.show(due);
		if (this.panel) this.openPanel(due);
	}

	private show(due: DueTasks): void {
		if (!this.chip) {
			const chip = this.host.parent().createEl("button", { cls: "notebook-plantasks", attr: { type: "button", "aria-haspopup": "true", "aria-expanded": "false" } });
			for (const type of ISOLATED) chip.addEventListener(type, (e) => e.stopPropagation());
			setIcon(chip.createSpan({ cls: "notebook-plantasks-icon", attr: { "aria-hidden": "true" } }), "list-checks");
			chip.createSpan({ cls: "notebook-plantasks-label" });
			chip.addEventListener("click", (e) => {
				e.preventDefault();
				if (this.panel) this.closePanel();
				else this.openPanel(this.index.dueOn(this.days));
			});
			this.chip = chip;
		}
		const label = due.open > 0 ? t("planTasks.chip", { n: String(due.open) }) : t("planTasks.chipDone");
		this.chip.lastElementChild?.setText(label);
		this.chip.setAttribute("aria-label", label);
		this.chip.toggleClass("is-done", due.open === 0);
	}

	private hide(): void {
		this.chip?.remove();
		this.chip = null;
		this.shownKey = "";
	}

	// ------------------------------------------------------------------------------------------------ the panel

	openPanel(due: DueTasks): void {
		if (!this.chip) return;
		this.panel?.remove();
		const panel = this.host.parent().createDiv({ cls: "notebook-plantasks-panel", attr: { role: "region", "aria-label": t("planTasks.region") } });
		for (const type of ISOLATED) panel.addEventListener(type, (e) => e.stopPropagation());
		panel.createDiv({ cls: "notebook-plantasks-title", text: t("planTasks.title") });
		const list = panel.createDiv({ cls: "notebook-plantasks-list" });
		const weekly = this.days.length > 1;
		for (const e of due.items) this.row(list, e, weekly);
		if (due.total > due.items.length) panel.createDiv({ cls: "notebook-plantasks-more", text: t("planTasks.more", { n: String(due.total - due.items.length) }) });
		panel.createDiv({ cls: "notebook-plantasks-hint", text: t("planTasks.hint") });
		this.panel = panel;
		this.chip.setAttribute("aria-expanded", "true");
		const outside = (ev: Event) => {
			const target = ev.target as Node | null;
			if (target && (panel.contains(target) || this.chip?.contains(target))) return;
			this.closePanel();
		};
		const esc = (ev: KeyboardEvent) => {
			if (ev.key === "Escape") this.closePanel();
		};
		activeDocument.addEventListener("pointerdown", outside, true);
		activeDocument.addEventListener("keydown", esc, true);
		this.closeOnOutside = (): void => {
			activeDocument.removeEventListener("pointerdown", outside, true);
			activeDocument.removeEventListener("keydown", esc, true);
		};
	}

	closePanel(): void {
		this.closeOnOutside?.();
		this.closeOnOutside = null;
		this.panel?.remove();
		this.panel = null;
		this.chip?.setAttribute("aria-expanded", "false");
	}

	private row(list: HTMLElement, e: TaskEntry, weekly: boolean): void {
		const name = e.path.slice(e.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
		const row = list.createEl("button", {
			cls: `notebook-plantasks-row${e.done ? " is-done" : ""}`,
			attr: { type: "button", "aria-label": t("planTasks.row", { task: e.text, note: name }) },
		});
		// The mark is only a status (never a control): the whole row opens the note.
		const mark = row.createSpan({ cls: "notebook-plantasks-mark", attr: { role: "img", "aria-label": e.done ? t("planTasks.status.done") : t("planTasks.status.open") } });
		if (e.done) setIcon(mark, "check");
		const body = row.createSpan({ cls: "notebook-plantasks-text" });
		body.createSpan({ cls: "notebook-plantasks-task", text: e.text });
		const note = body.createSpan({ cls: "notebook-plantasks-note" });
		if (weekly) note.createSpan({ cls: "notebook-plantasks-day", text: dayLabel(e.due) });
		note.createSpan({ text: name });
		row.addEventListener("click", (ev) => {
			ev.preventDefault();
			void this.openAt(e);
		});
	}

	/** Opens the note at the task's line (in a new tab: the notebook stays where it is). */
	private async openAt(e: TaskEntry): Promise<void> {
		const file = this.app.vault.getFileByPath(e.path);
		this.closePanel();
		if (!file) return;
		try {
			await this.app.workspace.getLeaf("tab").openFile(file, { eState: { line: e.line } });
		} catch (err) {
			console.error("[notebook] planner tasks open", err);
		}
	}
}

/** Short weekday and day of a `YYYY-MM-DD` ("Thu 12"), in the device language. */
function dayLabel(iso: string): string {
	const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
	try {
		return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }).format(new Date(y, m - 1, d));
	} catch {
		return iso;
	}
}
