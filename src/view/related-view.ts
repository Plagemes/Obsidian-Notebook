/**
 * 0.26 (#422): the "Related handwritten pages" side panel. For the Markdown note in front it lists the handwritten pages that
 * relate to it, best first, each with a thumbnail, the notebook and page, and a short reason (src/library/related-pages.ts does
 * the ranking). Tap a row to open the page; drag it into the note to place its embed, or use "Copy link". Read-only: it only
 * reads the library index and the note's metadata, and never writes to the vault.
 */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { LibraryEntry } from "../library/index";
import { relatedPages, type RelatedNote, type RelatedReason, type RelatedRow } from "../library/related-pages";
import type { ClassEntry } from "../timetable/schedule";
import { attachLongPressHelp, resolveHelp } from "../ui/long-press-help";
import { iconButton, setIconSafe } from "../ui/components/dom";
import { emptyState } from "../ui/components/empty-state";

export const RELATED_VIEW_TYPE = "notebook-related";

/** Wait this long after the last change of note or metadata before ranking again. */
export const RELATED_DEBOUNCE_MS = 250;

/** What the panel needs from the plugin; everything it reads is read-only. */
export interface RelatedSource {
	/** The Markdown note in front (the last one with focus), or null when none is open. */
	note(): RelatedNote | null;
	/** The library index as it is now. */
	entries(): readonly LibraryEntry[];
	/** Brings the library index up to date (reads the notebooks that changed); resolves when done. */
	refresh(): Promise<void>;
	classes(): readonly ClassEntry[];
	includeCourse(): boolean;
	/** Draws the thumbnail of a page into `img` (cached, one at a time). */
	thumb(row: RelatedRow, img: HTMLImageElement): void;
	open(row: RelatedRow): void;
	copyLink(row: RelatedRow): void;
	/** Text a drag of the row puts in the note: the page's embed. */
	dragText(row: RelatedRow): string;
	/** Calls `cb` when the note in front or its metadata changed; returns the disposer. */
	onChange(cb: () => void): () => void;
}

const REASON_LABEL: Readonly<Record<RelatedReason, MessageKey>> = {
	links: "related.reason.links",
	title: "related.reason.title",
	alias: "related.reason.alias",
	tag: "related.reason.tag",
	heading: "related.reason.heading",
	course: "related.reason.course",
};

const REASON_ICON: Readonly<Record<RelatedReason, string>> = {
	links: "link",
	title: "type",
	alias: "forward",
	tag: "tag",
	heading: "heading",
	course: "graduation-cap",
};

export class RelatedView extends ItemView {
	private listEl!: HTMLElement;
	private subtitleEl!: HTMLElement;
	private offChange: (() => void) | null = null;
	private timer = 0;
	/** Bumped on every ranking: an older one that finishes late draws nothing. */
	private token = 0;
	private stopHelp: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly source: RelatedSource) {
		super(leaf);
	}

	getViewType(): string {
		return RELATED_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t("related.title");
	}

	getIcon(): string {
		return "files";
	}

	onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("notebook-related", "nb-ui");
		this.stopHelp = attachLongPressHelp(root, (b) => (b.dataset.help ? resolveHelp(b) : null));
		const header = root.createDiv({ cls: "nb-rel-header" });
		const titles = header.createDiv({ cls: "nb-rel-titles" });
		titles.createEl("h2", { cls: "nb-rel-title", text: t("related.title") });
		this.subtitleEl = titles.createDiv({ cls: "nb-rel-subtitle", attr: { "aria-live": "polite" } });
		iconButton(header, "refresh-cw", t("related.refresh"), () => void this.update(true), "nb-rel-refresh", "help.relatedRefresh");
		this.listEl = root.createDiv({ cls: "nb-rel-list" });
		this.offChange = this.source.onChange(() => this.schedule());
		void this.update(false);
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.offChange?.();
		this.offChange = null;
		this.stopHelp?.();
		this.stopHelp = null;
		window.clearTimeout(this.timer);
		this.token++;
		return Promise.resolve();
	}

	/** A change of note or metadata: rank again once things have settled. */
	private schedule(): void {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.update(false), RELATED_DEBOUNCE_MS);
	}

	/** Ranks from the index as it is, then (when `refresh`, or the index may be stale) once more after the index was brought up to date. */
	private async update(refresh: boolean): Promise<void> {
		const token = ++this.token;
		this.draw();
		if (this.source.note() === null) return;
		try {
			if (refresh || this.source.entries().length === 0) {
				this.subtitleEl.setText(t("related.indexing"));
				await this.source.refresh();
			}
		} catch (e) {
			console.error("[notebook] related pages: the library index could not be refreshed", e);
		}
		if (token === this.token) this.draw();
	}

	private draw(): void {
		this.listEl.empty();
		const note = this.source.note();
		if (!note) {
			this.subtitleEl.setText("");
			emptyState(this.listEl, { icon: "file-text", title: t("related.noNote.title"), body: t("related.noNote.body") });
			return;
		}
		const rows = relatedPages(this.source.entries(), note, { course: this.source.includeCourse(), classes: this.source.classes() });
		this.subtitleEl.setText(rows.length > 0 ? t("related.subtitle", { note: note.title, n: String(rows.length) }) : note.title);
		if (rows.length === 0) {
			emptyState(this.listEl, { icon: "pen-line", title: t("related.empty.title"), body: t("related.empty.body") });
			return;
		}
		for (const row of rows) this.drawRow(row);
	}

	private drawRow(row: RelatedRow): void {
		const el = this.listEl.createDiv({ cls: "nb-rel-row", attr: { draggable: "true" } });
		el.dataset.path = row.path;
		el.dataset.page = String(row.page);
		el.addEventListener("dragstart", (e) => {
			if (!e.dataTransfer) return;
			e.dataTransfer.setData("text/plain", this.source.dragText(row));
			e.dataTransfer.effectAllowed = "copy";
		});
		const main = el.createEl("button", { cls: "nb-rel-main", attr: { type: "button", "aria-label": t("related.open", { name: row.name, page: String(row.page + 1) }) } });
		main.addEventListener("click", () => this.source.open(row));
		const thumb = main.createDiv({ cls: "nb-rel-thumb", attr: { "aria-hidden": "true" } });
		this.source.thumb(row, thumb.createEl("img", { attr: { alt: "", draggable: "false", decoding: "async" } }));
		const body = main.createDiv({ cls: "nb-rel-body" });
		body.createDiv({ cls: "nb-rel-name", text: row.name });
		body.createDiv({ cls: "nb-rel-page", text: t("related.page", { n: String(row.page + 1) }) });
		const why = body.createDiv({ cls: "nb-rel-why" });
		const reason = why.createSpan({ cls: `nb-rel-reason is-${row.reason}` });
		setIconSafe(reason.createSpan({ cls: "nb-rel-reason-icon", attr: { "aria-hidden": "true" } }), REASON_ICON[row.reason]);
		reason.createSpan({ text: t(REASON_LABEL[row.reason]) });
		if (row.detail) why.createSpan({ cls: "nb-rel-detail", text: row.detail });
		if (row.also.length > 0) why.createSpan({ cls: "nb-rel-also", text: `+${row.also.length}`, attr: { title: row.also.map((r) => t(REASON_LABEL[r])).join(", ") } });
		iconButton(el, "link", t("related.copyLink"), () => this.source.copyLink(row), "nb-rel-copy", "help.relatedCopy");
	}
}
