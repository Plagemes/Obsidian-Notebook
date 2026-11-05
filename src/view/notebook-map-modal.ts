import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { MAX_ASPECT } from "../library/thumbnail";
import { writing } from "../ink/writing-guard";
import { filterByState, MAP_STATES, openItems, type MapPage, type MapState, type NotebookMap } from "../model/notebook-map";
import type { OutlineItem } from "../model/outline-builder";
import type { Page } from "../model/types";
import { chip } from "../ui/components/chip";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";

export interface NotebookMapHost {
	/** The map of the open notebook (cached per page revision by the caller). */
	map(): NotebookMap;
	pages(): readonly Page[];
	current(): number;
	/** Data URL of a page thumbnail (the navigator's cache). */
	thumbnail(page: Page): string;
	goTo(index: number): void;
	/** 0.20 (#102): the headings found in the handwriting (outline entries of kind heading); absent: no title strips and no Titles filter. */
	headings?: () => OutlineItem[];
	/** Picture (data URL) of the ink of a heading; null when it cannot be drawn. */
	headingImage?(item: OutlineItem): string | null;
	/** To a line of a page. */
	goToAt?(index: number, y: number): void;
	/** 0.16 (#87): starts the presentation from the page in view (the button is not offered when absent). */
	present?: () => void;

	/** 0.16 (#124): locks or unlocks a page; true when it was done. Absent: no lock buttons. */
	setLocked?(pageId: string, value: boolean): boolean;
	/** The notebook can be edited now (the lock buttons are enabled). */
	canLock?(): boolean;

	/**
	 * 0.17 (#77): the pages ticked in the map's selection mode go to a new notebook (the dialog opens); and a split before one
	 * page. Absent: no selection mode. Both close the map first.
	 */
	extract?: (pageIds: string[]) => void;
	split?: (pageId: string) => void;
	/** 0.18 (#186): the ticked pages are copied to another notebook, each with a link chip back (the dialog opens). Absent: no such button. */
	copyTo?: (pageIds: string[]) => void;
}

/** Most heading pictures on one card of the map. */
const MAP_TITLES_PER_CARD = 2;

export const MAP_STATE_ICON: Readonly<Record<MapState, string>> = {
	question: "help-circle", gap: "ellipsis", homework: "book-open-check", practice: "dumbbell", empty: "file", key: "star", checklist: "square-check",
};

const STATE_LABEL: Readonly<Record<MapState, MessageKey>> = {
	question: "map.state.question", gap: "map.state.gap", homework: "map.state.homework",
	practice: "map.state.practice", empty: "map.state.empty", key: "map.state.key", checklist: "map.state.checklist",
};

/** The count shown on a badge: the number of open items for markers, nothing for page states. */
function badgeCount(p: MapPage, s: MapState): number | null {
	if (s === "question" || s === "gap" || s === "homework") return p.open[s];
	if (s === "key") return p.open.key;
	if (s === "checklist") return p.open.checklist;
	return null;
}

/**
 * The notebook map (roadmap #408): a grid of page thumbnails with a badge per state (open question, gap, homework, key
 * point, unfinished practice, nearly empty page), filter chips with counts, and tap to go to the page.
 */
export class NotebookMapModal extends Modal {
	private filter: MapState | null = null;
	/** 0.20 (#102): only the pages that have a heading in their handwriting. */
	private titlesOnly = false;
	private readonly headingItems = new Map<string, OutlineItem>();
	private grid: HTMLElement | null = null;
	private chips: HTMLElement | null = null;
	private observer: IntersectionObserver | null = null;
	/** 0.17 (#77): selection mode, to extract pages or split the notebook from the map. */
	private selecting = false;
	private readonly picked = new Set<string>();
	private bar: HTMLElement | null = null;

	constructor(app: App, private readonly mapHost: NotebookMapHost) {
		super(app);
	}

	onOpen(): void {
		const map = this.mapHost.map();
		const shell = modalShell(this, {
			title: t("map.title"), icon: "layout-grid", size: "wide", cls: "nb-map-modal",
			subtitle: t("map.subtitle", { open: String(openItems(map.pages)), pages: String(map.counts.total) }),
			footer: false, seed: "notebook-map",
		});
		this.chips = shell.body.createDiv({ cls: "nb-map-filters" });
		this.grid = shell.body.createDiv({ cls: "nb-map-grid" });
		if (this.canSelect()) this.bar = shell.body.createDiv({ cls: "nb-map-selbar", attr: { role: "toolbar", "aria-label": t("map.select") } });
		this.observer = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				const card = e.target as HTMLElement;
				this.observer?.unobserve(card);
				writing.whenQuiet(() => {
					if (card.isConnected) this.loadThumb(card);
				});
			}
		}, { root: shell.body, rootMargin: "240px" });
		this.render();
	}

	onClose(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.contentEl.empty();
	}

	private render(): void {
		const { chips, grid } = this;
		if (!chips || !grid) return;
		const map = this.mapHost.map();
		this.observer?.disconnect();
		chips.empty();
		grid.empty();
		chip(chips, { label: t("map.filter.all"), count: map.counts.total, active: this.filter === null, key: "all", onClick: () => this.setFilter(null) });
		// 0.20 (#102): the headings of the handwriting, per page. The Titles filter is offered when there are some (or while it is on).
		const byPage = new Map<string, OutlineItem[]>();
		this.headingItems.clear();
		for (const h of this.mapHost.headings?.() ?? []) {
			const list = byPage.get(h.pageId);
			if (list) list.push(h);
			else byPage.set(h.pageId, [h]);
			this.headingItems.set(h.key, h);
		}
		if (byPage.size > 0 || this.titlesOnly) {
			chip(chips, { label: t("map.filter.titles"), icon: "heading", count: byPage.size, active: this.titlesOnly, key: "titles", onClick: () => this.toggleTitles() });
		}
		for (const s of MAP_STATES) {
			const n = map.counts.pages[s];
			// A filter with nothing in it is not offered, except the one that is on.
			if (n === 0 && this.filter !== s) continue;
			chip(chips, { label: t(STATE_LABEL[s]), icon: MAP_STATE_ICON[s], count: n, active: this.filter === s, key: s, onClick: () => this.setFilter(s) });
		}
		if (this.canSelect()) {
			const pick = chips.createEl("button", { cls: "nb-map-select", attr: { type: "button", "aria-pressed": String(this.selecting) } });
			pick.toggleClass("is-on", this.selecting);
			setIcon(pick.createSpan({ cls: "nb-map-present-icon" }), this.selecting ? "check-square" : "square-check");
			pick.createSpan({ text: t(this.selecting ? "map.select.done" : "map.select") });
			pick.addEventListener("click", () => {
				this.selecting = !this.selecting;
				this.picked.clear();
				this.render();
			});
		}
		const present = this.mapHost.present;
		if (present && !this.selecting) {
			const b = chips.createEl("button", { cls: "nb-map-present", attr: { type: "button", "aria-label": t("present.title") } });
			setIcon(b.createSpan({ cls: "nb-map-present-icon" }), "presentation");
			b.createSpan({ text: t("present.title") });
			b.addEventListener("click", () => {
				this.close();
				present();
			});
		}
		const shown = filterByState(map.pages, this.filter).filter((mp) => !this.titlesOnly || byPage.has(mp.pageId));
		if (shown.length === 0) {
			shellNote(grid, t(map.counts.total > 0 && map.counts.clear === map.counts.total ? "map.allClear" : "map.none"));
			return;
		}
		const pages = this.mapHost.pages();
		const current = this.mapHost.current();
		for (const mp of shown) {
			const page = pages[mp.index];
			if (!page) continue;
			const card = grid.createEl("button", { cls: "nb-map-card", attr: { type: "button", "data-index": String(mp.index), "data-states": mp.states.join(" ") } });
			card.toggleClass("is-current", mp.index === current);
			card.toggleClass("is-lecture", mp.lectureStart);
			const label = [t("nav.page", { n: String(mp.index + 1) }), ...mp.states.map((s) => t(STATE_LABEL[s])), mp.hint ?? ""].filter(Boolean).join(", ");
			card.setAttribute("aria-label", label);
			if (mp.hint) card.title = mp.hint;
			const frame = card.createDiv({ cls: "nb-map-thumb" });
			const img = frame.createEl("img", { attr: { alt: "", draggable: "false" } });
			img.setCssProps({ "--nb-map-ratio": String(Math.min(page.height / page.width, MAX_ASPECT)) });
			const badges = frame.createDiv({ cls: "nb-map-badges" });
			for (const s of mp.states) {
				const b = badges.createSpan({ cls: `nb-map-badge is-${s}`, attr: { "aria-hidden": "true" } });
				setIcon(b.createSpan({ cls: "nb-map-badge-icon" }), MAP_STATE_ICON[s]);
				const n = badgeCount(mp, s);
				if (n !== null && n > 1) b.createSpan({ cls: "nb-map-badge-n", text: String(n) });
			}
			// 0.20 (#102): the first headings of the page as pictures of the ink (drawn when the card comes into view); a tap goes to the line.
			const heads = byPage.get(mp.pageId);
			if (heads && this.mapHost.headingImage) {
				const strip = card.createSpan({ cls: "nb-map-titles" });
				for (const h of heads.slice(0, MAP_TITLES_PER_CARD)) {
					const one = strip.createSpan({
						cls: "nb-map-title", attr: { role: "button", tabindex: "0", "data-heading": h.key, "aria-label": t("map.titles.go", { n: String(mp.index + 1) }) },
					});
					one.createEl("img", { attr: { alt: "", draggable: "false" } });
					const go = (e: Event) => {
						e.preventDefault();
						e.stopPropagation();
						if (this.selecting) return;
						this.close();
						if (this.mapHost.goToAt) this.mapHost.goToAt(h.index, h.y);
						else this.mapHost.goTo(h.index);
					};
					one.addEventListener("click", go);
					one.addEventListener("keydown", (e) => {
						if (e.key === "Enter" || e.key === " ") go(e);
					});
				}
			}
			const foot = card.createDiv({ cls: "nb-map-foot" });
			foot.createSpan({ cls: "nb-map-num", text: String(mp.index + 1) });
			// 0.16 (#124): a lock on the thumbnail of a locked page, and a lock button (a span: the card itself is a button) to
			// lock or unlock any page without leaving the map.
			if (mp.locked) {
				const mark = badges.createSpan({ cls: "nb-map-badge is-locked", attr: { "aria-hidden": "true" } });
				setIcon(mark.createSpan({ cls: "nb-map-badge-icon" }), "lock");
			}
			if (this.mapHost.setLocked) {
				const enabled = this.mapHost.canLock?.() ?? true;
				const lock = foot.createSpan({
					cls: "nb-map-lock", attr: { role: "button", tabindex: enabled ? "0" : "-1", "aria-disabled": String(!enabled), "aria-pressed": String(!!mp.locked),
						"aria-label": t(mp.locked ? "lock.map.unlock" : "lock.map.lock", { n: String(mp.index + 1) }) },
				});
				lock.toggleClass("is-on", !!mp.locked);
				setIcon(lock, mp.locked ? "lock" : "lock-open");
				const toggle = (e: Event) => {
					e.preventDefault();
					e.stopPropagation();
					if (!enabled) return;
					if (this.mapHost.setLocked?.(mp.pageId, !mp.locked)) this.render();
				};
				lock.addEventListener("click", toggle);
				lock.addEventListener("keydown", (e) => {
					if (e.key === "Enter" || e.key === " ") toggle(e);
				});
			}
			if (mp.due) foot.createSpan({ cls: "nb-map-due", text: mp.due });
			if (this.selecting) {
				card.setAttribute("aria-pressed", String(this.picked.has(mp.pageId)));
				card.toggleClass("is-picked", this.picked.has(mp.pageId));
				card.setAttribute("aria-label", `${t("map.select.card", { n: String(mp.index + 1) })}, ${label}`);
			}
			card.addEventListener("click", () => {
				if (this.selecting) {
					if (!this.picked.delete(mp.pageId)) this.picked.add(mp.pageId);
					card.toggleClass("is-picked", this.picked.has(mp.pageId));
					card.setAttribute("aria-pressed", String(this.picked.has(mp.pageId)));
					this.updateBar();
					return;
				}
				this.close();
				this.mapHost.goTo(mp.index);
			});
			this.observer?.observe(card);
		}
		grid.querySelector<HTMLElement>(".is-current")?.scrollIntoView({ block: "nearest" });
		grid.toggleClass("is-selecting", this.selecting);
		this.updateBar();
	}

	private canSelect(): boolean {
		return !!(this.mapHost.extract || this.mapHost.split || this.mapHost.copyTo);
	}

	/** The action bar of the selection mode: how many are ticked, Extract and Split. Hidden outside the mode. */
	private updateBar(): void {
		const bar = this.bar;
		if (!bar) return;
		bar.empty();
		bar.toggleClass("is-on", this.selecting);
		if (!this.selecting) return;
		const ids = this.mapHost.pages().filter((p) => this.picked.has(p.id)).map((p) => p.id);
		bar.createSpan({ cls: "nb-map-selcount", text: t("map.select.count", { n: String(ids.length) }) });
		const extract = this.mapHost.extract;
		if (extract) {
			const b = shellButton(bar, "primary", t("map.select.extract"), () => {
				this.close();
				extract(ids);
			}, { icon: "file-output", disabled: ids.length === 0 });
			b.addClass("nb-map-extract");
		}
		const copyTo = this.mapHost.copyTo;
		if (copyTo) {
			const b = shellButton(bar, "secondary", t("map.select.copyTo"), () => {
				this.close();
				copyTo(ids);
			}, { icon: "copy-plus", disabled: ids.length === 0 });
			b.addClass("nb-map-copyto");
		}
		const split = this.mapHost.split;
		if (split) {
			// A split needs a page that is not the first one (both halves keep a page).
			const first = ids.length === 1 ? this.mapHost.pages().findIndex((p) => p.id === ids[0]) : -1;
			const b = shellButton(bar, "secondary", t("map.select.split"), () => {
				this.close();
				split(ids[0]!);
			}, { icon: "scissors", disabled: ids.length !== 1 || first < 1 });
			b.addClass("nb-map-split");
		}
	}

	private toggleTitles(): void {
		this.titlesOnly = !this.titlesOnly;
		this.render();
	}

	private setFilter(s: MapState | null): void {
		this.filter = this.filter === s ? null : s;
		this.render();
	}

	private loadThumb(card: HTMLElement): void {
		const page = this.mapHost.pages()[Number(card.dataset.index)];
		const img = card.querySelector("img");
		if (page && img) img.src = this.mapHost.thumbnail(page);
		if (!this.mapHost.headingImage) return;
		for (const one of Array.from(card.querySelectorAll<HTMLElement>("[data-heading]"))) {
			const item = this.headingItems.get(one.dataset.heading ?? "");
			const pic = one.querySelector("img");
			const url = item ? (this.mapHost.headingImage?.(item) ?? null) : null;
			if (pic && url) pic.src = url;
			else one.addClass("is-empty");
		}
	}
}
