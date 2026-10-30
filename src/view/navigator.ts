import { Menu, setIcon } from "obsidian";
import { t } from "../i18n";
import { MAX_ASPECT } from "../library/thumbnail";
import { bookmarkColor } from "../model/bookmarks";
import { rangeIds } from "../model/page-ops";
import { pageHasTag, pageTagCounts } from "../model/page-tags";
import type { Page } from "../model/types";
import { writing } from "../ink/writing-guard";
import { renderOutline, type OutlineHost } from "./outline";
import { pageSignature } from "./view-helpers";

export interface NavigatorHost {
	pages(): readonly Page[];
	current(): number;
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
}

const THUMB_WIDTH = 120;
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
	private readonly thumbs = new Map<string, { key: string; url: string }>();
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
	private readonly selectBar: HTMLElement;
	private readonly selectCount: HTMLElement;
	private readonly rangeButton: HTMLButtonElement;

	constructor(parent: HTMLElement, private readonly host: NavigatorHost) {
		this.el = parent.createDiv({ cls: "notebook-navigator notebook-hidden" });
		const header = this.el.createDiv({ cls: "notebook-navigator-header" });
		this.titleEl = header.createSpan({ text: t("nav.title"), cls: "notebook-navigator-title" });
		this.selectButton = header.createEl("button", {
			cls: "notebook-tool clickable-icon", attr: { "aria-label": t("pageOps.select"), "aria-pressed": "false", type: "button" },
		});
		setIcon(this.selectButton, "check-square");
		this.selectButton.addEventListener("click", () => (this.selecting ? this.stopSelecting() : this.startSelecting(null)));
		this.outlineButton = header.createEl("button", {
			cls: "notebook-tool clickable-icon", attr: { "aria-label": t("nav.outline"), "aria-pressed": "false", type: "button" },
		});
		setIcon(this.outlineButton, "list-tree");
		this.outlineButton.addEventListener("click", () => {
			this.outlineMode = !this.outlineMode;
			this.updateHeader();
			this.refresh();
		});
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

	setOpen(open: boolean): void {
		this.el.toggleClass("notebook-hidden", !open);
		if (open) {
			this.refresh();
			this.scrollToCurrent();
		}
	}

	/** Forgets cached thumbnails (all, or those of `pageIds`) and redraws the list. */
	invalidate(pageIds?: Iterable<string>): void {
		if (pageIds) for (const id of pageIds) this.thumbs.delete(id);
		else this.thumbs.clear();
		this.refresh();
	}

	/** Rebuilds the list (cheap: thumbnails are cached and loaded lazily). */
	refresh(): void {
		if (!this.open) return;
		this.observer.disconnect();
		const scrollTop = this.listEl.scrollTop;
		this.listEl.empty();
		const pages = this.host.pages();
		const marks = this.host.bookmarks();
		const current = this.host.current();
		this.updateTagBar();
		if (this.outlineMode) {
			renderOutline(this.listEl, this.host.outline, { category: this.outlineCategory, current }, (category) => {
				this.outlineCategory = category;
				this.refresh();
			});
			this.listEl.scrollTop = scrollTop;
			return;
		}
		const info = this.host.outline.meta()?.bookmarkInfo;
		let shown = 0;
		this.shownIds = [];
		// A page that is gone (deleted, moved out, undo) leaves the selection.
		for (const id of [...this.selected]) if (!pages.some((p) => p.id === id)) this.selected.delete(id);
		this.listEl.toggleClass("is-selecting", this.selecting);
		pages.forEach((page, index) => {
			if (this.onlyBookmarks && !marks.has(page.id)) return;
			if (this.tagFilter !== null && !pageHasTag(page, this.tagFilter)) return;
			shown++;
			this.shownIds.push(page.id);
			const item = this.listEl.createDiv({ cls: "notebook-navigator-item", attr: { tabindex: "0", "data-index": String(index), "data-id": page.id } });
			item.toggleClass("is-current", index === current);
			item.toggleClass("is-selected", this.selected.has(page.id));
			setIcon(item.createDiv({ cls: "notebook-navigator-check" }), "check");
			const img = item.createEl("img", { cls: "notebook-navigator-thumb", attr: { alt: t("nav.page", { n: String(index + 1) }), draggable: "false" } });
			img.setCssProps({ "--notebook-thumb-ratio": String(Math.min(page.height / page.width, MAX_ASPECT)) });
			const cached = this.thumbs.get(page.id);
			if (cached && cached.key === this.thumbKey(page)) img.src = cached.url;
			// v7: the bookmark title and the page tags under the thumbnail.
			const details = marks.has(page.id) ? info?.[page.id] : undefined;
			if (details?.title || (page.tags?.length ?? 0) > 0) {
				const caption = item.createDiv({ cls: "notebook-navigator-caption" });
				if (details?.title) caption.createDiv({ cls: "notebook-navigator-caption-title", text: details.title });
				if (page.tags?.length) caption.createDiv({ cls: "notebook-navigator-caption-tags", text: page.tags.map((x) => `#${x}`).join(" ") });
			}
			const footer = item.createDiv({ cls: "notebook-navigator-footer" });
			footer.createSpan({ text: String(index + 1), cls: "notebook-navigator-number" });
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
		});
		if (shown === 0) this.listEl.createDiv({ cls: "notebook-navigator-empty", text: t("nav.empty") });
		this.listEl.scrollTop = scrollTop;
		this.syncSelection();
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
	markCurrent(index: number): void {
		if (!this.open) return;
		this.listEl.querySelectorAll(".notebook-navigator-item, .notebook-outline-row").forEach((el) => {
			const item = el as HTMLElement;
			const current = Number(item.dataset.index) === index;
			if (current !== item.hasClass("is-current")) {
				item.toggleClass("is-current", current);
				if (current && !this.drag) item.scrollIntoView({ block: "nearest" });
			}
		});
	}

	private scrollToCurrent(): void {
		this.listEl.querySelector(".is-current")?.scrollIntoView({ block: "center" });
	}

	destroy(): void {
		this.observer.disconnect();
		this.drag?.ghost.remove();
		this.drag = null;
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
		const key = this.thumbKey(page);
		let cached = this.thumbs.get(page.id);
		if (!cached || cached.key !== key) {
			cached = { key, url: this.host.thumbnail(page, THUMB_WIDTH) };
			this.thumbs.set(page.id, cached);
		}
		if (img.src !== cached.url) img.src = cached.url;
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
