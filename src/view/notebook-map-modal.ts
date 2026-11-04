import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { MAX_ASPECT } from "../library/thumbnail";
import { writing } from "../ink/writing-guard";
import { filterByState, MAP_STATES, openItems, type MapPage, type MapState, type NotebookMap } from "../model/notebook-map";
import type { Page } from "../model/types";
import { chip } from "../ui/components/chip";
import { modalShell, shellNote } from "../ui/components/modal-shell";

export interface NotebookMapHost {
	/** The map of the open notebook (cached per page revision by the caller). */
	map(): NotebookMap;
	pages(): readonly Page[];
	current(): number;
	/** Data URL of a page thumbnail (the navigator's cache). */
	thumbnail(page: Page): string;
	goTo(index: number): void;
	/** 0.16 (#124): locks or unlocks a page; true when it was done. Absent: no lock buttons. */
	setLocked?(pageId: string, value: boolean): boolean;
	/** The notebook can be edited now (the lock buttons are enabled). */
	canLock?(): boolean;
}

export const MAP_STATE_ICON: Readonly<Record<MapState, string>> = {
	question: "help-circle", gap: "ellipsis", homework: "book-open-check", practice: "dumbbell", empty: "file", key: "star",
};

const STATE_LABEL: Readonly<Record<MapState, MessageKey>> = {
	question: "map.state.question", gap: "map.state.gap", homework: "map.state.homework",
	practice: "map.state.practice", empty: "map.state.empty", key: "map.state.key",
};

/** The count shown on a badge: the number of open items for markers, nothing for page states. */
function badgeCount(p: MapPage, s: MapState): number | null {
	if (s === "question" || s === "gap" || s === "homework") return p.open[s];
	if (s === "key") return p.open.key;
	return null;
}

/**
 * The notebook map (roadmap #408): a grid of page thumbnails with a badge per state (open question, gap, homework, key
 * point, unfinished practice, nearly empty page), filter chips with counts, and tap to go to the page.
 */
export class NotebookMapModal extends Modal {
	private filter: MapState | null = null;
	private grid: HTMLElement | null = null;
	private chips: HTMLElement | null = null;
	private observer: IntersectionObserver | null = null;

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
		for (const s of MAP_STATES) {
			const n = map.counts.pages[s];
			// A filter with nothing in it is not offered, except the one that is on.
			if (n === 0 && this.filter !== s) continue;
			chip(chips, { label: t(STATE_LABEL[s]), icon: MAP_STATE_ICON[s], count: n, active: this.filter === s, key: s, onClick: () => this.setFilter(s) });
		}
		const shown = filterByState(map.pages, this.filter);
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
			const foot = card.createDiv({ cls: "nb-map-foot" });
			foot.createSpan({ cls: "nb-map-num", text: String(mp.index + 1) });
			// 0.16 (#124): a lock on the thumbnail of a locked page, and a lock button (a span: the card itself is a button) to
			// lock or unlock any page without leaving the map.
			if (mp.locked) {
				const mark = badges.createSpan({ cls: "nb-map-badge is-locked", attr: { "aria-hidden": "true" } });
				setIcon(mark.createSpan({ cls: "nb-map-badge-icon" }), "lock");
			}
			const setLocked = this.mapHost.setLocked;
			if (setLocked) {
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
					if (setLocked(mp.pageId, !mp.locked)) this.render();
				};
				lock.addEventListener("click", toggle);
				lock.addEventListener("keydown", (e) => {
					if (e.key === "Enter" || e.key === " ") toggle(e);
				});
			}
			if (mp.due) foot.createSpan({ cls: "nb-map-due", text: mp.due });
			card.addEventListener("click", () => {
				this.close();
				this.mapHost.goTo(mp.index);
			});
			this.observer?.observe(card);
		}
		grid.querySelector<HTMLElement>(".is-current")?.scrollIntoView({ block: "nearest" });
	}

	private setFilter(s: MapState | null): void {
		this.filter = this.filter === s ? null : s;
		this.render();
	}

	private loadThumb(card: HTMLElement): void {
		const page = this.mapHost.pages()[Number(card.dataset.index)];
		const img = card.querySelector("img");
		if (page && img) img.src = this.mapHost.thumbnail(page);
	}
}
