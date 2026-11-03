/**
 * Slide strip (#417): one dialog that lists every slide of the notebook with what belongs to it — the slide's own page,
 * the notes pages linked to it side by side, the exercise page after it, the ink written beside it (#226) or in its
 * margin, and the questions on it. Each chip goes there; the slide number shows the slide (in the side-by-side pane, or
 * the slide's page of this notebook). Built by model/slide-strip.ts; opened from the side-by-side pane, the contextual
 * bar and the command palette (action `slide-strip`).
 */
import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import type { SlideKey } from "../model/slide-links";
import { buildSlideStrip, rowHasNotes, type StripLink, type StripRow, type StripSection } from "../model/slide-strip";
import type { NotebookDocument, Page, Stroke } from "../model/types";
import { chip, filterChips } from "../ui/components/chip";
import { emptyState } from "../ui/components/empty-state";
import { modalShell } from "../ui/components/modal-shell";

/** What the strip needs from the notebook view. */
export interface SlideStripHost {
	doc: NotebookDocument;
	/** Notebook name, for the subtitle. */
	name: string;
	links: readonly StripLink[];
	/** The slide in the side-by-side pane, or null. */
	current: SlideKey | null;
	visible(page: Page): readonly Stroke[];
	goToPage(index: number): void;
	showSlide(key: SlideKey): void;
	/** Opens side by side (the empty state's next step), or null where it is not available. */
	openSideBySide: (() => void) | null;
}

type Filter = "notes" | "all";

export class SlideStripModal extends Modal {
	private filter: Filter = "notes";
	private sections: StripSection[] = [];

	constructor(app: App, private readonly host: SlideStripHost) {
		super(app);
	}

	onOpen(): void {
		const h = this.host;
		this.sections = buildSlideStrip({ doc: h.doc, links: h.links, visible: (p) => h.visible(p) });
		// The PDF beside the notes first.
		const cur = h.current;
		if (cur) this.sections.sort((a, b) => Number(b.source === cur.source) - Number(a.source === cur.source));
		const rows = this.sections.flatMap((s) => s.rows);
		const withNotes = rows.filter(rowHasNotes).length;
		if (withNotes === 0) this.filter = "all";
		const shell = modalShell(this, {
			title: t("slides.strip.title"),
			subtitle: rows.length > 0 ? t("slides.strip.subtitle", { slides: String(rows.length), notes: String(withNotes) }) : h.name,
			icon: "layout-list",
			size: "wide",
			footer: false,
			cls: "notebook-slide-strip",
			seed: h.doc.id,
		});
		const body = shell.body;
		if (rows.length === 0) {
			const open = h.openSideBySide;
			emptyState(body, {
				icon: "layout-list",
				title: t("slides.strip.empty.title"),
				body: t("slides.strip.empty.body"),
				primary: open ? { icon: "columns-2", label: t("command.pdfSideOpen"), onClick: () => { this.close(); open(); } } : undefined,
			});
			return;
		}
		const list = createDiv({ cls: "nb-slide-strip-list" });
		if (withNotes > 0 && withNotes < rows.length) {
			filterChips<Filter>(body, [
				{ id: "notes", label: t("slides.strip.filter.notes"), icon: "notebook-pen" },
				{ id: "all", label: t("slides.strip.filter.all"), icon: "layout-list" },
			], this.filter, (id) => {
				this.filter = id;
				body.querySelectorAll(".nb-chips .nb-chip").forEach((c) => {
					const on = (c as HTMLElement).dataset.key === `chip:${id}`;
					c.toggleClass("is-active", on);
					c.setAttribute("aria-pressed", String(on));
				});
				this.renderList(list);
			}, t("slides.strip.filter"));
		}
		body.appendChild(list);
		this.renderList(list);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderList(list: HTMLElement): void {
		list.empty();
		const many = this.sections.length > 1;
		for (const section of this.sections) {
			const rows = this.filter === "notes" ? section.rows.filter(rowHasNotes) : section.rows;
			if (rows.length === 0) continue;
			if (many || section.name) {
				const head = list.createDiv({ cls: "nb-slide-strip-section" });
				setIcon(head.createSpan({ cls: "nb-slide-strip-section-icon", attr: { "aria-hidden": "true" } }), "file-text");
				head.createSpan({ cls: "nb-slide-strip-section-name", text: section.name ?? t("slides.strip.pdf") });
				head.createSpan({ cls: "nb-slide-strip-section-count", text: String(rows.length) });
			}
			for (const r of rows) this.renderRow(list, r);
		}
	}

	private renderRow(list: HTMLElement, r: StripRow): void {
		const h = this.host;
		const current = !!h.current && h.current.source === r.source && h.current.page === r.page;
		const row = list.createDiv({ cls: "nb-slide-strip-row" });
		row.toggleClass("is-current", current);
		row.toggleClass("is-bare", !rowHasNotes(r));
		const key: SlideKey = r.path ? { source: r.source, page: r.page, path: r.path } : { source: r.source, page: r.page };
		const tile = row.createEl("button", {
			cls: "nb-slide-strip-tile",
			attr: { type: "button", "aria-label": t("slides.badge.show", { page: String(r.page) }), title: t("slides.badge.show", { page: String(r.page) }) },
		});
		setIcon(tile.createSpan({ cls: "nb-slide-strip-tile-icon", attr: { "aria-hidden": "true" } }), "presentation");
		tile.createSpan({ cls: "nb-slide-strip-tile-num", text: String(r.page) });
		tile.addEventListener("click", () => {
			this.close();
			h.showSlide(key);
		});
		const items = row.createDiv({ cls: "nb-slide-strip-items" });
		const go = (index: number) => () => {
			this.close();
			h.goToPage(index);
		};
		const page = (i: number) => String(i + 1);
		if (r.slidePage !== null) chip(items, { label: t("slides.strip.slidePage", { page: page(r.slidePage) }), icon: "presentation", key: "slide", onClick: go(r.slidePage) });
		for (const n of r.notes) chip(items, { label: t("slides.strip.notes", { page: page(n) }), icon: "notebook-pen", key: "notes", onClick: go(n) });
		if (r.exercise !== null) chip(items, { label: t("slides.strip.exercise", { page: page(r.exercise) }), icon: "pencil-ruler", key: "exercise", onClick: go(r.exercise) });
		for (const ink of r.ink) {
			const label = ink.kind === "margin" ? t("slides.strip.margin", { page: page(ink.page) }) : t("slides.strip.ink", { page: page(ink.page) });
			chip(items, { label, icon: ink.kind === "margin" ? "panel-right" : "pen-line", count: ink.strokes, key: `ink-${ink.kind}`, onClick: go(ink.page) });
		}
		for (const q of r.questions) {
			const b = chip(items, {
				label: q.text ? q.text : t("slides.strip.question", { page: page(q.page) }),
				icon: q.done ? "circle-check" : "circle-help",
				key: "question",
				title: t("slides.strip.question", { page: page(q.page) }),
				onClick: go(q.page),
			});
			b.addClass("nb-slide-strip-question");
			b.toggleClass("is-done", q.done);
		}
		if (!rowHasNotes(r)) items.createSpan({ cls: "nb-slide-strip-none", text: t("slides.strip.none") });
	}
}
