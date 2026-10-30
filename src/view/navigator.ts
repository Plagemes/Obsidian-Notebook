import { Menu, setIcon } from "obsidian";
import { t } from "../i18n";
import { MAX_ASPECT } from "../library/thumbnail";
import { bookmarkColor } from "../model/bookmarks";
import { pageHasTag, pageTagCounts } from "../model/page-tags";
import type { Page } from "../model/types";
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
}

const THUMB_WIDTH = 120;
/** Hold time before a touch drag starts reordering (a quick swipe scrolls the list). */
const LONG_PRESS_MS = 350;

/**
 * Side panel with page thumbnails: tap to jump, drag to reorder, star to bookmark; filters by bookmark and
 * by page tag. The outline mode lists the bookmarks instead (titles, colours, categories).
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

	constructor(parent: HTMLElement, private readonly host: NavigatorHost) {
		this.el = parent.createDiv({ cls: "notebook-navigator notebook-hidden" });
		const header = this.el.createDiv({ cls: "notebook-navigator-header" });
		this.titleEl = header.createSpan({ text: t("nav.title"), cls: "notebook-navigator-title" });
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
		this.tagBar = this.el.createDiv({ cls: "notebook-navigator-tagbar notebook-hidden" });
		this.listEl = this.el.createDiv({ cls: "notebook-navigator-list" });
		this.observer = new IntersectionObserver((entries) => {
			for (const e of entries) if (e.isIntersecting) this.loadThumb(e.target as HTMLElement);
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
		pages.forEach((page, index) => {
			if (this.onlyBookmarks && !marks.has(page.id)) return;
			if (this.tagFilter !== null && !pageHasTag(page, this.tagFilter)) return;
			shown++;
			const item = this.listEl.createDiv({ cls: "notebook-navigator-item", attr: { tabindex: "0", "data-index": String(index) } });
			item.toggleClass("is-current", index === current);
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
			item.addEventListener("click", () => this.host.goTo(index));
			item.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.host.goTo(index);
			});
			item.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				this.host.pageMenu(index, e);
			});
			this.enableDrag(item, index);
			this.observer.observe(item);
		});
		if (shown === 0) this.listEl.createDiv({ cls: "notebook-navigator-empty", text: t("nav.empty") });
		this.listEl.scrollTop = scrollTop;
	}

	private updateHeader(): void {
		this.titleEl.setText(t(this.outlineMode ? "nav.outline" : "nav.title"));
		this.outlineButton.toggleClass("is-active", this.outlineMode);
		this.outlineButton.setAttribute("aria-pressed", String(this.outlineMode));
		// The page filters apply to the thumbnails, not to the outline.
		this.filterButton.toggleClass("notebook-hidden", this.outlineMode);
		this.tagButton.toggleClass("notebook-hidden", this.outlineMode);
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
	private enableDrag(item: HTMLElement, index: number): void {
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
				pressTimer = window.setTimeout(() => begin(e), LONG_PRESS_MS);
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
