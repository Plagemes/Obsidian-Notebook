import { Menu, setIcon } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { MAX_ASPECT } from "../library/thumbnail";
import { bookmarkColor } from "../model/bookmarks";
import { rangeIds } from "../model/page-ops";
import { pageHasTag, pageTagCounts } from "../model/page-tags";
import type { Page } from "../model/types";
import { writing } from "../ink/writing-guard";
import { classifyPages, nextMode, pageRowTime, pageRowTitle, resolveLayout, ThumbCache, type NavLayout, type NavMode } from "../ui/nav-adapt";
import { attachLongPressHelp, resolveHelp } from "../ui/long-press-help";
import { markCounts, markedPages, MARK_KINDS, toggleKind, type MarkContext, type MarkKind, type PageMark } from "../ui/nav-marked";
import { renderOutline, type OutlineHost } from "./outline";
import { pageSignature } from "./view-helpers";
import { sectionDivider, type NavigatorSections } from "./sections-tools";

export interface NavigatorHost {
	pages(): readonly Page[];
	current(): number;
	/** 0.27 (#49): the other page of the two-page spread in view (highlighted with the current one), or -1. Absent: -1. */
	companion?(): number;
	bookmarks(): ReadonlySet<string>;
	/** PNG data URL of a page thumbnail `width` CSS px wide. */
	thumbnail(page: Page, width: number): string;
	goTo(index: number): void;
	move(from: number, to: number): void;
	toggleBookmark(pageId: string): void;
	pageMenu(index: number, evt: MouseEvent): void;
	/** v7: bookmark details, outline and page tags. */
	outline: OutlineHost;
	/** wave 0.8 (378): shows the actions for the selected pages (ids), at the event. */
	selectionMenu(pageIds: readonly string[], evt: MouseEvent): void;
	/** 0.14 (408): opens the notebook map (states per page). Absent: no button. */
	openMap?(): void;
	/** 0.16 (#124): locks or unlocks a page (the lock mark of a locked page unlocks it). Absent: the mark is not a button. */
	setLocked?(pageId: string, value: boolean): void;
	/** 0.24 (#414): the layout chosen for this notebook on this device (auto when none), and remembering a new choice. Absent: auto. */
	layoutMode?(): NavMode;
	setLayoutMode?(mode: NavMode): void;
	/** 0.25 (#419): marked pages only, per notebook on this device: null shows all pages, else the kinds that count (none: all kinds). Absent: no button. */
	markedKinds?(): readonly MarkKind[] | null;
	setMarkedKinds?(kinds: readonly MarkKind[] | null): void;
	/** 0.25 (#419): what makes a page marked besides its own content (global bookmarks, the colour legend). */
	markContext?(): Pick<MarkContext, "globalBookmarks" | "legend" | "tolerance">;
	/** 0.30 (#52): the coloured sections: the tab strip above the list and the dividers and colour edges of the rows. Absent: none. */
	sections?: NavigatorSections;
}

/** 0.25 (#419): the icon of each reason a page is marked. */
const MARK_ICON: Readonly<Record<MarkKind, string>> = { bookmark: "bookmark", global: "book-marked", marker: "flag", meaning: "palette", task: "list-checks", tag: "tag" };

const THUMB_WIDTH = 120;
/** 0.24 (#414): thumbnail widths (CSS px) of the large layout and of the compact list. */
const LARGE_WIDTH = 240;
const LIST_WIDTH = 60;
/** Rows built before the browser gets a turn; the rest follow in the next frames (a 500-page list opens at once). */
const CHUNK = 80;
/** Hold time before a touch drag starts reordering (a quick swipe scrolls the list). */
const LONG_PRESS_MS = 350;

/**
 * Side panel with page thumbnails: tap to jump, drag to reorder, star to bookmark; filters by bookmark and
 * by page tag. The outline mode lists the bookmarks instead (titles, colours, categories).
 * Wave 0.8 (378): select several pages (the select button, a long press, Ctrl+click) and act on them together; the
 * actions themselves live in view/page-ops-menu.ts.
 * Thumbnails are rendered lazily (only when visible) and cached per page content.
 */
export class PageNavigator {
	readonly el: HTMLElement;
	private readonly listEl: HTMLElement;
	private readonly filterButton: HTMLButtonElement;
	private readonly titleEl: HTMLElement;
	private readonly outlineButton: HTMLButtonElement;
	private readonly tagButton: HTMLButtonElement;
	private readonly tagBar: HTMLElement;
	private onlyBookmarks = false;
	private outlineMode = false;
	private tagFilter: string | null = null;
	private outlineCategory: string | null = null;
	/** Cached thumbnails: bounded, one width per page, released when the panel closes. */
	private readonly thumbs = new ThumbCache();
	private layoutButton: HTMLButtonElement | null = null;
	private markButton: HTMLButtonElement | null = null;
	private readonly markBar: HTMLElement;
	/** 0.30 (#52): the tab strip of the coloured sections. */
	private readonly sectionBar: HTMLElement;
	private layout: NavLayout = "normal";
	/** Bumped on every rebuild: a chunked build that finds another number stops. */
	private buildToken = 0;
	private buildFrame: number | null = null;
	private readonly observer: IntersectionObserver;
	private drag: { from: number; pointerId: number; ghost: HTMLElement; target: number } | null = null;
	/** wave 0.8 (378): multi-selection by page id, the page a range starts from, and the ids shown (after the filters). */
	private selecting = false;
	private readonly selected = new Set<string>();
	private anchorId: string | null = null;
	private rangeMode = false;
	private shownIds: string[] = [];
	private suppressClick = false;
	private readonly selectButton: HTMLButtonElement;
	private mapButton: HTMLButtonElement | null = null;
	private readonly selectBar: HTMLElement;
	private readonly selectCount: HTMLElement;
	private readonly rangeButton: HTMLButtonElement;
	/** Stops the long-press explanation of the header buttons that have one. */
	private stopHelp: (() => void) | null = null;

	constructor(parent: HTMLElement, private readonly host: NavigatorHost) {
		this.el = parent.createDiv({ cls: "notebook-navigator notebook-hidden" });
		this.stopHelp = attachLongPressHelp(this.el, (b) => (b.dataset.help ? resolveHelp(b) : null));
		const header = this.el.createDiv({ cls: "notebook-navigator-header" });
		this.titleEl = header.createSpan({ text: t("nav.title"), cls: "notebook-navigator-title" });
		this.selectButton = header.createEl("button", {
			cls: "notebook-tool clickable-icon", attr: { "aria-label": t("pageOps.select"), "aria-pressed": "false", type: "button" },
		});
		setIcon(this.selectButton, "check-square");
		this.selectButton.addEventListener("click", () => (this.selecting ? this.stopSelecting() : this.startSelecting(null)));
		if (host.openMap) {
			this.mapButton = header.createEl("button", {
				cls: "notebook-tool clickable-icon", attr: { "aria-label": t("map.open"), type: "button" },
			});
			setIcon(this.mapButton, "layout-grid");
			this.mapButton.addEventListener("click", () => host.openMap?.());
		}
		this.outlineButton = header.createEl("button", {
			cls: "notebook-tool clickable-icon", attr: { "aria-label": t("nav.outline"), "aria-pressed": "false", type: "button" },
		});
		setIcon(this.outlineButton, "list-tree");
		this.outlineButton.addEventListener("click", () => {
			this.outlineMode = !this.outlineMode;
			this.updateHeader();
			this.refresh();
		});
		if (host.setLayoutMode) {
			this.layoutButton = header.createEl("button", { cls: "notebook-tool clickable-icon notebook-navigator-layout", attr: { type: "button" } });
			this.layoutButton.dataset.help = "help.navLayout"; // 0.24 iconhelp (#429): the long-press explanation
			this.layoutButton.addEventListener("click", () => {
				host.setLayoutMode?.(nextMode(host.layoutMode?.() ?? "auto"));
				this.updateLayoutButton();
				this.refresh();
			});
			this.updateLayoutButton();
		}
		if (host.setMarkedKinds) {
			this.markButton = header.createEl("button", { cls: "notebook-tool clickable-icon notebook-navigator-marked", attr: { "aria-label": t("navMarked.button"), type: "button" } });
			setIcon(this.markButton, "flag");
			this.markButton.dataset.help = "help.navMarked"; // long-press explanation
			this.markButton.addEventListener("click", (e) => this.openMarkedMenu(e));
		}
		this.tagButton = header.createEl("button", {
			cls: "notebook-tool clickable-icon", attr: { "aria-label": t("nav.filterTag"), type: "button" },
		});
		setIcon(this.tagButton, "tag");
		this.tagButton.addEventListener("click", (e) => this.openTagMenu(e));
		this.filterButton = header.createEl("button", {
			cls: "notebook-tool clickable-icon", attr: { "aria-label": t("nav.onlyBookmarks"), type: "button" },
		});
		setIcon(this.filterButton, "bookmark");
		this.filterButton.addEventListener("click", () => {
			this.onlyBookmarks = !this.onlyBookmarks;
			this.filterButton.toggleClass("is-active", this.onlyBookmarks);
			this.refresh();
		});
		this.selectBar = this.el.createDiv({ cls: "notebook-navigator-selectbar notebook-hidden" });
		this.selectCount = this.selectBar.createSpan({ cls: "notebook-navigator-selectcount" });
		const allButton = this.selectBar.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": t("pageOps.selectAll"), type: "button" } });
		setIcon(allButton, "list-checks");
		allButton.addEventListener("click", () => this.selectAll());
		this.rangeButton = this.selectBar.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": t("pageOps.range"), "aria-pressed": "false", type: "button" } });
		setIcon(this.rangeButton, "chevrons-up-down");
		this.rangeButton.addEventListener("click", () => {
			this.rangeMode = !this.rangeMode;
			this.syncSelection();
		});
		const actions = this.selectBar.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": t("pageOps.actions"), type: "button" } });
		setIcon(actions, "more-horizontal");
		actions.addEventListener("click", (e) => {
			if (this.selected.size > 0) this.host.selectionMenu(this.selectedIds(), e);
		});
		const done = this.selectBar.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": t("pageOps.done"), type: "button" } });
		setIcon(done, "x");
		done.addEventListener("click", () => this.stopSelecting());
		this.el.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && this.selecting) {
				e.preventDefault();
				e.stopPropagation();
				this.stopSelecting();
			}
		});
		this.tagBar = this.el.createDiv({ cls: "notebook-navigator-tagbar notebook-hidden" });
		this.markBar = this.el.createDiv({ cls: "notebook-navigator-tagbar notebook-navigator-markbar notebook-hidden" });
		this.sectionBar = this.el.createDiv({ cls: "nb-ui nb-sections-strip notebook-hidden" }); // 0.30 (#52)
		this.listEl = this.el.createDiv({ cls: "notebook-navigator-list" });
		this.observer = new IntersectionObserver((entries) => {
			// Wave 0.8 (374): thumbnails are drawn at the first pause in writing, not under the pen.
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				const item = e.target as HTMLElement;
				writing.whenQuiet(() => {
					if (item.isConnected) this.loadThumb(item);
				});
			}
		}, { root: this.listEl, rootMargin: "200px" });
	}

	get open(): boolean {
		return !this.el.hasClass("notebook-hidden");
	}

	/** 0.27 (#375): the panel shows the outline instead of the page thumbnails. */
	get showsOutline(): boolean {
		return this.outlineMode;
	}

	/** 0.27 (#375): switches between the outline and the thumbnails (a workspace preset); the open or closed state is unchanged. */
	setOutline(on: boolean): void {
		if (this.outlineMode === on) return;
		this.outlineMode = on;
		this.updateHeader();
		this.refresh();
	}

	setOpen(open: boolean): void {
		this.el.toggleClass("notebook-hidden", !open);
		if (open) {
			this.centerCurrent = true;
			this.refresh();
		}
	}

	/** Forgets cached thumbnails (all, or those of `pageIds`) and redraws the list. */
	invalidate(pageIds?: Iterable<string>): void {
		if (pageIds) for (const id of pageIds) this.thumbs.drop(id);
		else this.thumbs.clear();
		this.refresh();
	}

	/** The icon and label of the layout button follow the chosen mode (Auto, Thumbnails, List). */
	private updateLayoutButton(): void {
		const button = this.layoutButton;
		if (!button) return;
		const mode = this.host.layoutMode?.() ?? "auto";
		setIcon(button, mode === "auto" ? "sparkles" : mode === "thumbs" ? "image" : "list");
		button.setAttribute("aria-label", t("navAdapt.toggle", { mode: t(mode === "auto" ? "navAdapt.auto" : mode === "thumbs" ? "navAdapt.thumbs" : "navAdapt.list") }));
		button.toggleClass("is-active", mode !== "auto");
	}

	private widthOf(layout: NavLayout): number {
		return layout === "large" ? LARGE_WIDTH : layout === "list" ? LIST_WIDTH : THUMB_WIDTH;
	}

	/** Rebuilds the list (cheap: thumbnails are cached and loaded lazily). */
	refresh(): void {
		if (!this.open) return;
		this.observer.disconnect();
		const token = ++this.buildToken;
		if (this.buildFrame !== null) window.cancelAnimationFrame(this.buildFrame);
		this.buildFrame = null;
		const scrollTop = this.listEl.scrollTop;
		this.listEl.empty();
		const pages = this.host.pages();
		const marks = this.host.bookmarks();
		const current = this.host.current();
		this.mate = this.host.companion?.() ?? -1;
		this.updateTagBar();
		this.host.sections?.strip(this.sectionBar);
		this.host.sections?.reset();
		if (this.outlineMode) {
			renderOutline(this.listEl, this.host.outline, { category: this.outlineCategory, current }, (category) => {
				this.outlineCategory = category;
				this.refresh();
			});
			this.listEl.scrollTop = scrollTop;
			return;
		}
		const info = this.host.outline.meta()?.bookmarkInfo;
		this.shownIds = [];
		// A page that is gone (deleted, moved out, undo) leaves the selection.
		for (const id of [...this.selected]) if (!pages.some((p) => p.id === id)) this.selected.delete(id);
		this.listEl.toggleClass("is-selecting", this.selecting);
		// 0.24 (#414): large thumbnails for a PDF notebook, the compact list for a written one (or what the reader chose).
		this.layout = resolveLayout(this.host.layoutMode?.() ?? "auto", classifyPages(pages));
		this.el.toggleClass("is-large", this.layout === "large");
		this.el.toggleClass("is-list", this.layout === "list");
		const entries: Array<{ page: Page; index: number; why?: PageMark[] }> = [];
		// 0.25 (#419): marked pages only: each page with the reasons it is marked, its real number kept.
		const markedKinds = this.host.setMarkedKinds ? this.host.markedKinds?.() ?? null : null;
		this.updateMarkBar(markedKinds);
		const reasons = new Map<string, PageMark[]>();
		if (markedKinds !== null) for (const m of markedPages(pages, this.markContext(marks), markedKinds)) reasons.set(m.page.id, m.marks);
		pages.forEach((page, index) => {
			if (markedKinds !== null && !reasons.has(page.id)) return;
			if (this.onlyBookmarks && !marks.has(page.id)) return;
			if (this.tagFilter !== null && !pageHasTag(page, this.tagFilter)) return;
			entries.push({ page, index, ...(markedKinds !== null ? { why: reasons.get(page.id)! } : {}) });
			this.shownIds.push(page.id);
		});
		if (entries.length === 0) this.listEl.createDiv({ cls: "notebook-navigator-empty", text: t(markedKinds !== null ? "navMarked.empty" : "nav.empty") });
		// The rows come in chunks, so 500 pages never hold the screen: the first chunk now, the rest in the next frames.
		// The scroll position (or the current page, when the panel was just opened) is restored as soon as the rows reach it.
		let from = 0;
		const wantCenter = this.centerCurrent;
		this.centerCurrent = false;
		const step = () => {
			if (token !== this.buildToken) return;
			const to = Math.min(entries.length, from + CHUNK);
			for (let i = from; i < to; i++) this.buildItem(entries[i]!.page, entries[i]!.index, current, marks, info, entries[i]!.why);
			from = to;
			if (wantCenter) {
				const cur = this.listEl.querySelector(".is-current");
				if (cur) {
					cur.scrollIntoView({ block: "center" });
					return finish();
				}
			} else if (this.listEl.scrollHeight - this.listEl.clientHeight >= scrollTop || from >= entries.length) {
				this.listEl.scrollTop = scrollTop;
				return finish();
			}
			finish();
		};
		const finish = () => {
			this.syncSelection();
			if (from < entries.length) this.buildFrame = window.requestAnimationFrame(step);
			else this.buildFrame = null;
		};
		step();
	}

	/** Set when the panel was just opened: the first build brings the current page into the middle. */
	private centerCurrent = false;
	/** 0.27 (#49): the other page of the spread in view, highlighted with the current one (-1: none). */
	private mate = -1;

	/** One page of the list: a thumbnail card (large or usual layout) or a compact row. */
	private buildItem(page: Page, index: number, current: number, marks: ReadonlySet<string>, info: NonNullable<ReturnType<OutlineHost["meta"]>>["bookmarkInfo"], why?: readonly PageMark[]): void {
		{
			const list = this.layout === "list";
			// 0.30 (#52): a divider with the title above the first listed page of a section, and the section's colour on its rows.
			const section = this.host.sections?.mark(index) ?? null;
			if (section?.divider) sectionDivider(this.listEl, section);
			const item = this.listEl.createDiv({ cls: "notebook-navigator-item", attr: { tabindex: "0", "data-index": String(index), "data-id": page.id } });
			if (section) {
				item.addClass("has-section");
				item.setCssProps({ "--nb-section-color": section.color });
			}
			item.toggleClass("is-current", index === current || index === this.mate);
			item.toggleClass("is-selected", this.selected.has(page.id));
			setIcon(item.createDiv({ cls: "notebook-navigator-check" }), "check");
			const img = item.createEl("img", { cls: "notebook-navigator-thumb", attr: { alt: t("nav.page", { n: String(index + 1) }), draggable: "false" } });
			img.setCssProps({ "--notebook-thumb-ratio": String(Math.min(page.height / page.width, MAX_ASPECT)) });
			const cached = this.thumbs.get(page.id, this.widthOf(this.layout), this.thumbKey(page));
			if (cached) img.src = cached;
			// v7: the bookmark title and the page tags under the thumbnail.
			const details = marks.has(page.id) ? info?.[page.id] : undefined;
			if (list) {
				// 0.24 (#414): number, title (bookmark or first typed line) and the time the page was written, tags after it.
				const text = item.createDiv({ cls: "notebook-navigator-rowtext" });
				text.createSpan({ text: String(index + 1), cls: "notebook-navigator-number" });
				const body = text.createDiv({ cls: "notebook-navigator-rowbody" });
				const title = pageRowTitle(page, details?.title);
				body.createDiv({ cls: title ? "notebook-navigator-rowtitle" : "notebook-navigator-rowtitle is-untitled", text: title || t("nav.page", { n: String(index + 1) }) });
				const meta: string[] = [];
				const at = pageRowTime(page);
				if (at !== null) meta.push(new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
				if (page.tags?.length) meta.push(page.tags.map((x) => `#${x}`).join(" "));
				if (meta.length > 0) body.createDiv({ cls: "notebook-navigator-rowmeta", text: meta.join(" · ") });
			} else if (details?.title || (page.tags?.length ?? 0) > 0) {
				const caption = item.createDiv({ cls: "notebook-navigator-caption" });
				if (details?.title) caption.createDiv({ cls: "notebook-navigator-caption-title", text: details.title });
				if (page.tags?.length) caption.createDiv({ cls: "notebook-navigator-caption-tags", text: page.tags.map((x) => `#${x}`).join(" ") });
			}
			if (why && why.length > 0) this.buildBadges(item, why, list);
			const footer = item.createDiv({ cls: "notebook-navigator-footer" });
			if (!list) footer.createSpan({ text: String(index + 1), cls: "notebook-navigator-number" });
			// 0.16 (#124): a locked page shows a lock in the footer; a tap unlocks it.
			if (page.locked) {
				const lock = footer.createEl("button", { cls: "nb-ui notebook-tool clickable-icon notebook-navigator-lock", attr: { "aria-label": t("lock.mark.aria"), type: "button" } });
				setIcon(lock, "lock");
				lock.addEventListener("click", (e) => {
					e.stopPropagation();
					this.host.setLocked?.(page.id, false);
				});
			}
			const menu = footer.createEl("button", {
				cls: "notebook-tool clickable-icon notebook-navigator-star", attr: { "aria-label": t("page.menu"), type: "button" },
			});
			setIcon(menu, "more-vertical");
			menu.addEventListener("click", (e) => {
				e.stopPropagation();
				this.host.pageMenu(index, e);
			});
			const star = footer.createEl("button", {
				cls: "notebook-tool clickable-icon notebook-navigator-star", attr: { "aria-label": t("nav.bookmark"), type: "button" },
			});
			setIcon(star, "bookmark");
			star.toggleClass("is-active", marks.has(page.id));
			star.setAttribute("aria-pressed", String(marks.has(page.id)));
			const color = marks.has(page.id) ? bookmarkColor(details) : null;
			if (color) star.setCssProps({ "--notebook-bookmark-color": color });
			star.addEventListener("click", (e) => {
				e.stopPropagation();
				this.host.toggleBookmark(page.id);
			});
			item.addEventListener("click", (e) => {
				if (this.suppressClick) return;
				if (this.selecting || e.ctrlKey || e.metaKey || e.shiftKey) this.pick(page.id, e.shiftKey || this.rangeMode);
				else this.host.goTo(index);
			});
			item.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || (e.key === " " && this.selecting)) {
					e.preventDefault();
					if (this.selecting) this.pick(page.id, e.shiftKey || this.rangeMode);
					else this.host.goTo(index);
				}
			});
			item.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				this.host.pageMenu(index, e);
			});
			this.enableDrag(item, index, page.id);
			this.observer.observe(item);
		}
	}

	// ------------------------------------------------------------- marked pages only (0.25, #419)

	private markContext(bookmarks: ReadonlySet<string>): MarkContext {
		const extra = this.host.markContext?.();
		return { bookmarks, globalBookmarks: extra?.globalBookmarks ?? new Set(), legend: extra?.legend ?? [], ...(extra?.tolerance !== undefined ? { tolerance: extra.tolerance } : {}) };
	}

	/** The words for a reason: the kind, plus the marker kinds, the open count, the legend labels or the tags where there are some. */
	private markText(m: PageMark): string {
		switch (m.kind) {
			case "task": return t("navMarked.why.task", { n: m.detail ?? "0" });
			case "marker": return (m.detail ?? "").split(",").filter(Boolean).map((k) => t(`markers.kind.${k}` as MessageKey)).join(", ") || t("navMarked.why.marker");
			case "meaning": return m.detail || t("navMarked.why.meaning");
			case "tag": return m.detail || t("navMarked.why.tag");
			default: return t(`navMarked.why.${m.kind}` as MessageKey);
		}
	}

	/** The badges under a page: why it is marked (an icon and, in the compact list, the words; the words are always the label). */
	private buildBadges(item: HTMLElement, why: readonly PageMark[], list: boolean): void {
		const row = (list ? item.querySelector<HTMLElement>(".notebook-navigator-rowbody") : null) ?? item;
		const badges = row.createDiv({ cls: "notebook-navigator-marks" });
		for (const m of why) {
			const text = this.markText(m);
			const badge = badges.createSpan({ cls: `notebook-navigator-mark is-${m.kind}`, attr: { title: text, "aria-label": `${t(`navMarked.kind.${m.kind}` as MessageKey)}: ${text}` } });
			setIcon(badge.createSpan({ cls: "notebook-navigator-mark-icon" }), MARK_ICON[m.kind]);
			if (list) badge.createSpan({ cls: "notebook-navigator-mark-text", text });
		}
	}

	/** The line under the header while marked-only is on: which kinds count, and a button back to all pages. */
	private updateMarkBar(kinds: readonly MarkKind[] | null): void {
		this.markButton?.toggleClass("is-active", kinds !== null);
		this.markBar.empty();
		const show = kinds !== null && !this.outlineMode;
		this.markBar.toggleClass("notebook-hidden", !show);
		if (!show) return;
		const names = kinds.map((k) => t(`navMarked.kind.${k}` as MessageKey)).join(", ");
		this.markBar.createSpan({ cls: "notebook-navigator-tagbar-text", text: kinds.length > 0 ? t("navMarked.bar", { kinds: names }) : t("navMarked.barAll") });
		const clear = this.markBar.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": t("navMarked.clear"), type: "button" } });
		setIcon(clear, "x");
		clear.addEventListener("click", () => this.setMarked(null));
	}

	private setMarked(kinds: readonly MarkKind[] | null): void {
		this.host.setMarkedKinds?.(kinds);
		this.refresh();
	}

	/** All pages / marked pages only, and which kinds count (with the number of pages each marks). */
	private openMarkedMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const kinds = this.host.markedKinds?.() ?? null;
		menu.addItem((i) => i.setTitle(t("navMarked.menuAll")).setIcon("files").setChecked(kinds === null).onClick(() => this.setMarked(null)));
		menu.addItem((i) => i.setTitle(t("navMarked.menuOnly")).setIcon("flag").setChecked(kinds !== null).onClick(() => this.setMarked(kinds ?? [])));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t("navMarked.kindsHeading")).setDisabled(true));
		const counts = markCounts(this.host.pages(), this.markContext(this.host.bookmarks()));
		for (const kind of MARK_KINDS) {
			const on = kinds !== null && (kinds.length === 0 || kinds.includes(kind));
			menu.addItem((i) => i.setTitle(`${t(`navMarked.kind.${kind}` as MessageKey)} (${counts[kind]})`).setIcon(MARK_ICON[kind]).setChecked(on)
				.onClick(() => this.setMarked(toggleKind(kinds === null ? [] : kinds.length === 0 ? [...MARK_KINDS] : kinds, kind))));
		}
		menu.showAtMouseEvent(evt);
	}

	// ------------------------------------------------------------- multi-selection (wave 0.8, 378)

	/** Ids of the selected pages, in page order. */
	private selectedIds(): string[] {
		return this.host.pages().filter((p) => this.selected.has(p.id)).map((p) => p.id);
	}

	/** Switches the panel to selection mode (nothing selected yet). */
	beginSelection(): void {
		if (!this.selecting) this.startSelecting(null);
	}

	/** Starts selecting (optionally with `id` already selected). */
	private startSelecting(id: string | null): void {
		this.selecting = true;
		if (id) {
			this.selected.add(id);
			this.anchorId = id;
		}
		this.listEl.toggleClass("is-selecting", true);
		this.syncSelection();
	}

	private stopSelecting(): void {
		this.selecting = false;
		this.selected.clear();
		this.anchorId = null;
		this.rangeMode = false;
		this.listEl.toggleClass("is-selecting", false);
		this.syncSelection();
	}

	/** A tap in selection mode: toggles the page, or (range) adds everything between the last tapped page and this one. */
	private pick(id: string, range: boolean): void {
		if (!this.selecting) this.startSelecting(null);
		if (range && this.anchorId && this.anchorId !== id) {
			for (const x of rangeIds(this.shownIds, this.anchorId, id)) this.selected.add(x);
		} else {
			if (this.selected.has(id)) this.selected.delete(id);
			else this.selected.add(id);
			this.anchorId = id;
		}
		this.syncSelection();
	}

	/** Selects every page shown (the filters apply). */
	private selectAll(): void {
		for (const id of this.shownIds) this.selected.add(id);
		this.syncSelection();
	}

	/** Brings the item classes, the count and the bar in line with the selection, without rebuilding the list. */
	private syncSelection(): void {
		this.listEl.querySelectorAll<HTMLElement>(".notebook-navigator-item").forEach((el) => {
			el.toggleClass("is-selected", this.selected.has(el.dataset.id ?? ""));
		});
		this.selectButton.toggleClass("is-active", this.selecting);
		this.selectButton.setAttribute("aria-pressed", String(this.selecting));
		this.rangeButton.toggleClass("is-active", this.rangeMode);
		this.rangeButton.setAttribute("aria-pressed", String(this.rangeMode));
		this.selectBar.toggleClass("notebook-hidden", !this.selecting || this.outlineMode);
		this.selectCount.setText(this.selected.size > 0 ? t("pageOps.selected", { n: String(this.selected.size) }) : t("pageOps.pickPages"));
	}

	private updateHeader(): void {
		this.titleEl.setText(t(this.outlineMode ? "nav.outline" : "nav.title"));
		this.outlineButton.toggleClass("is-active", this.outlineMode);
		this.outlineButton.setAttribute("aria-pressed", String(this.outlineMode));
		// The page filters apply to the thumbnails, not to the outline.
		this.filterButton.toggleClass("notebook-hidden", this.outlineMode);
		this.tagButton.toggleClass("notebook-hidden", this.outlineMode);
		this.selectButton.toggleClass("notebook-hidden", this.outlineMode);
		this.mapButton?.toggleClass("notebook-hidden", this.outlineMode);
		this.layoutButton?.toggleClass("notebook-hidden", this.outlineMode);
		this.markButton?.toggleClass("notebook-hidden", this.outlineMode);
		this.syncSelection();
	}

	/** Shows the active page-tag filter (with a button to clear it); hides it in the outline. */
	private updateTagBar(): void {
		const pages = this.host.pages();
		// A filter on a tag no page has any more (tag removed, undo) is dropped.
		if (this.tagFilter !== null && !pages.some((p) => pageHasTag(p, this.tagFilter!))) this.tagFilter = null;
		this.tagButton.toggleClass("is-active", this.tagFilter !== null);
		this.tagBar.empty();
		const show = this.tagFilter !== null && !this.outlineMode;
		this.tagBar.toggleClass("notebook-hidden", !show);
		if (!show) return;
		this.tagBar.createSpan({ cls: "notebook-navigator-tagbar-text", text: t("nav.tagFilter", { tag: this.tagFilter! }) });
		const clear = this.tagBar.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": t("nav.clearTagFilter"), type: "button" } });
		setIcon(clear, "x");
		clear.addEventListener("click", () => this.setTagFilter(null));
	}

	private setTagFilter(tag: string | null): void {
		this.tagFilter = tag;
		this.refresh();
	}

	/** Menu of the page tags in use (with the number of pages), plus "All pages". */
	private openTagMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const counts = pageTagCounts(this.host.pages());
		menu.addItem((i) => i.setTitle(t("nav.allTags")).setChecked(this.tagFilter === null).onClick(() => this.setTagFilter(null)));
		if (counts.length === 0) menu.addItem((i) => i.setTitle(t("nav.noPageTags")).setDisabled(true));
		for (const { tag, count } of counts) {
			const on = this.tagFilter !== null && this.tagFilter.toLowerCase() === tag.toLowerCase();
			menu.addItem((i) => i.setTitle(`#${tag} (${count})`).setChecked(on).onClick(() => this.setTagFilter(tag)));
		}
		menu.showAtMouseEvent(evt);
	}

	/** Highlights the current page without rebuilding the list, and brings it into view. */
	markCurrent(index: number, mate = -1): void {
		this.mate = mate;
		if (!this.open) return;
		this.host.sections?.strip(this.sectionBar); // 0.30 (#52): the tab of the section in view (rebuilt only when it changes)
		this.listEl.querySelectorAll(".notebook-navigator-item").forEach((el) => {
			const item = el as HTMLElement;
			const current = Number(item.dataset.index) === index || Number(item.dataset.index) === mate;
			if (current !== item.hasClass("is-current")) {
				item.toggleClass("is-current", current);
				if (current && !this.drag) item.scrollIntoView({ block: "nearest" });
			}
		});
		// 0.13: in the outline "here" is the last entry at or before the current page (one row, not every row of the page).
		const rows = Array.from(this.listEl.querySelectorAll<HTMLElement>(".nb-outline-row"));
		if (rows.length > 0) {
			let here = -1;
			rows.forEach((row, i) => {
				if (Number(row.dataset.index) <= index) here = i;
			});
			rows.forEach((row, i) => {
				if ((i === here) !== row.hasClass("is-current")) {
					row.toggleClass("is-current", i === here);
					if (i === here && !this.drag) row.scrollIntoView({ block: "nearest" });
				}
			});
		}
	}

	destroy(): void {
		this.buildToken++;
		if (this.buildFrame !== null) window.cancelAnimationFrame(this.buildFrame);
		this.buildFrame = null;
		this.observer.disconnect();
		this.drag?.ghost.remove();
		this.drag = null;
		this.stopHelp?.();
		this.stopHelp = null;
		this.thumbs.clear(); // the data URLs go with the panel
		this.el.remove();
	}

	/** Changes whenever what the thumbnail shows changes. */
	private thumbKey(page: Page): string {
		return pageSignature(page);
	}

	private loadThumb(item: HTMLElement): void {
		const index = Number(item.dataset.index);
		const page = this.host.pages()[index];
		const img = item.querySelector("img");
		if (!page || !img) return;
		const url = this.thumbnailOf(page, this.widthOf(this.layout));
		if (img.src !== url) img.src = url;
	}

	/** The thumbnail of `page` if it is already drawn and still current (roadmap 50: the fast scrollbar's preview reuses this cache). */
	cachedThumbnail(page: Page): string | null {
		return this.thumbs.peek(page.id, this.thumbKey(page));
	}

	/** The thumbnail of `page`: the cached one, or drawn now and cached (the same cache as the panel's list). */
	thumbnailOf(page: Page, width: number = THUMB_WIDTH): string {
		const key = this.thumbKey(page);
		const cached = this.thumbs.get(page.id, width, key);
		if (cached !== null) return cached;
		const url = this.host.thumbnail(page, width);
		this.thumbs.set(page.id, width, key, url);
		return url;
	}

	/** Mouse/pen: drag immediately. Touch: long-press, then drag; a quick swipe scrolls the list. */
	private enableDrag(item: HTMLElement, index: number, pageId: string): void {
		let pressTimer: number | null = null;
		let start: { x: number; y: number } | null = null;
		const begin = (e: PointerEvent) => {
			const ghost = item.cloneNode(true) as HTMLElement;
			ghost.addClass("notebook-navigator-ghost");
			activeDocument.body.appendChild(ghost);
			this.drag = { from: index, pointerId: e.pointerId, ghost, target: index };
			item.setPointerCapture(e.pointerId);
			this.moveGhost(e);
		};
		item.addEventListener("pointerdown", (e) => {
			if ((e.target as HTMLElement).closest(".notebook-navigator-star")) return;
			start = { x: e.clientX, y: e.clientY };
			if (e.pointerType === "touch") {
				pressTimer = window.setTimeout(() => {
					pressTimer = null;
					this.suppressClick = true;
					window.navigator.vibrate?.(12);
					// Selecting already: a long press adds the range up to this page. Otherwise it starts a selection with this page
					// and, as before, picks the page up for reordering (letting go without moving only selects it).
					if (this.selecting) this.pick(pageId, true);
					else {
						this.startSelecting(pageId);
						begin(e);
					}
				}, LONG_PRESS_MS);
			}
		});
		item.addEventListener("pointermove", (e) => {
			if (this.drag && this.drag.pointerId === e.pointerId) {
				e.preventDefault();
				this.moveGhost(e);
				return;
			}
			if (!start) return;
			const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
			if (e.pointerType === "touch") {
				if (moved > 8 && pressTimer !== null) {
					window.clearTimeout(pressTimer);
					pressTimer = null;
				}
			} else if (moved > 6 && (e.buttons & 1)) {
				begin(e);
			}
		});
		const end = (e: PointerEvent) => {
			if (pressTimer !== null) window.clearTimeout(pressTimer);
			pressTimer = null;
			start = null;
			// The click that follows a long press is part of it.
			if (this.suppressClick) window.setTimeout(() => (this.suppressClick = false), 80);
			const drag = this.drag;
			if (!drag || drag.pointerId !== e.pointerId) return;
			this.drag = null;
			drag.ghost.remove();
			this.listEl.querySelectorAll(".is-drop-target").forEach((el) => el.removeClass("is-drop-target"));
			if (e.type === "pointerup" && drag.target !== drag.from) this.host.move(drag.from, drag.target);
		};
		item.addEventListener("pointerup", end);
		item.addEventListener("pointercancel", end);
	}

	private moveGhost(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag) return;
		drag.ghost.setCssProps({ "--notebook-ghost-x": `${e.clientX}px`, "--notebook-ghost-y": `${e.clientY}px` });
		let target = drag.from;
		this.listEl.querySelectorAll(".notebook-navigator-item").forEach((el) => {
			const r = el.getBoundingClientRect();
			const i = Number((el as HTMLElement).dataset.index);
			const over = e.clientY >= r.top && e.clientY <= r.bottom;
			(el as HTMLElement).toggleClass("is-drop-target", over && i !== drag.from);
			if (over) target = i;
		});
		drag.target = target;
		// Scroll the list when dragging near its edges.
		const lr = this.listEl.getBoundingClientRect();
		if (e.clientY < lr.top + 30) this.listEl.scrollTop -= 12;
		else if (e.clientY > lr.bottom - 30) this.listEl.scrollTop += 12;
	}
}
