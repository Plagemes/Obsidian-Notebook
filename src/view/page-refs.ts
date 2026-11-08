import { setIcon } from "obsidian";
import { t } from "../i18n";
import { PageRefIndex, refsSummary, type PageRef } from "../model/page-refs";
import type { Page } from "../model/types";

/** Events that must not reach the page or the view's shortcuts (the chip and its list never take pen input). */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;
/** The view must be still this long before the references of the page in view are looked up. */
const SETTLE_MS = 220;
/** Slice of idle work spent warming the index of a big notebook. */
const WARM_MS = 8;

export interface PageRefsHost {
	/** The element the chip floats in (the notebook body). */
	parent(): HTMLElement;
	enabled(): boolean;
	pages(): readonly Page[];
	/** Vault path of the notebook, or null. */
	path(): string | null;
	/** 0-based page in view. */
	current(): number;
	/** Shows page `index`, recorded in the back history. */
	goTo(index: number): void;
}

/**
 * Roadmap #179: a quiet chip "Referenced on p. 3, p. 12" while the page in view is linked from other pages of the same notebook.
 * Tapping it opens a short list of those pages, each a jump. The data is the derived `PageRefIndex` (nothing is stored); the chip
 * is reconsidered once the view has been still for a moment, so scrolling costs one re-armed timer and the index is warmed in
 * small idle slices.
 */
export class PageRefs {
	readonly index = new PageRefIndex();
	private chip: HTMLElement | null = null;
	private list: HTMLElement | null = null;
	private refs: PageRef[] = [];
	private timer: number | null = null;
	private warmTimer: number | null = null;
	private closeOnOutside: (() => void) | null = null;

	constructor(private readonly host: PageRefsHost) {}

	/** The page in view or the document changed. Cheap: one timer. */
	sync(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.update();
		}, SETTLE_MS);
	}

	/** The refs of the page in view right now (for tests and the harness). */
	get shown(): readonly PageRef[] {
		return this.chip ? this.refs : [];
	}

	get listOpen(): boolean {
		return this.list !== null;
	}

	/** The chip (or null), for the harness. */
	get element(): HTMLElement | null {
		return this.chip;
	}

	/** Another document, or the setting changed. */
	reset(): void {
		this.closeList();
		this.hide();
		this.sync();
	}

	destroy(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		if (this.warmTimer !== null) window.clearTimeout(this.warmTimer);
		this.timer = this.warmTimer = null;
		this.closeList();
		this.hide();
	}

	/** Reads the pages' links in small slices while the app is idle, so the first answer is already cached. */
	private warm(): void {
		if (this.warmTimer !== null) return;
		this.warmTimer = window.setTimeout(() => {
			this.warmTimer = null;
			const pages = this.host.pages();
			if (this.index.warm(pages, WARM_MS) > 0) this.warm();
		}, 60);
	}

	private update(): void {
		const pages = this.host.pages();
		const path = this.host.path();
		const page = pages[this.host.current()];
		if (!this.host.enabled() || !page || path === null) {
			this.closeList();
			this.hide();
			return;
		}
		this.index.setOwner(path);
		const refs = this.index.referencedFrom(pages, page.id);
		this.warm();
		if (refs.length === 0) {
			this.closeList();
			this.hide();
			return;
		}
		const same = refs.length === this.refs.length && refs.every((r, i) => r.pageId === this.refs[i]!.pageId && r.index === this.refs[i]!.index && r.count === this.refs[i]!.count);
		this.refs = refs;
		if (this.chip && same) return;
		this.show();
		if (this.list) this.openList();
	}

	private label(): string {
		const { shown, more } = refsSummary(this.refs);
		const pages = shown.map((n) => t("pageRefs.page", { n: String(n) })).join(", ");
		return more > 0 ? t("pageRefs.chipMore", { pages, n: String(more) }) : t("pageRefs.chip", { pages });
	}

	private show(): void {
		if (!this.chip) {
			const chip = this.host.parent().createEl("button", { cls: "notebook-page-refs", attr: { type: "button", "aria-haspopup": "true", "aria-expanded": "false" } });
			for (const type of ISOLATED) chip.addEventListener(type, (e) => e.stopPropagation());
			chip.createSpan({ cls: "notebook-page-refs-icon", attr: { "aria-hidden": "true" } });
			chip.createSpan({ cls: "notebook-page-refs-label" });
			setIcon(chip.firstElementChild as HTMLElement, "link");
			chip.addEventListener("click", (e) => {
				e.preventDefault();
				if (this.list) this.closeList();
				else this.openList();
			});
			this.chip = chip;
		}
		const text = this.label();
		this.chip.lastElementChild?.setText(text);
		this.chip.setAttribute("aria-label", text);
	}

	private hide(): void {
		this.chip?.remove();
		this.chip = null;
		this.refs = [];
	}

	/** The list of referencing pages, above the chip. */
	openList(): void {
		if (!this.chip || this.refs.length === 0) return;
		this.list?.remove();
		const list = this.host.parent().createDiv({ cls: "notebook-page-refs-list", attr: { role: "menu", "aria-label": t("pageRefs.title") } });
		for (const type of ISOLATED) list.addEventListener(type, (e) => e.stopPropagation());
		list.createDiv({ cls: "notebook-page-refs-title", text: t("pageRefs.title") });
		for (const ref of this.refs) {
			const row = list.createEl("button", { cls: "notebook-page-refs-row", attr: { type: "button", role: "menuitem" } });
			row.createSpan({ cls: "notebook-page-refs-row-page", text: t("pageRefs.pageLong", { n: String(ref.index + 1) }) });
			if (ref.count > 1) row.createSpan({ cls: "notebook-page-refs-row-count", text: t("pageRefs.links", { n: String(ref.count) }) });
			row.addEventListener("click", (e) => {
				e.preventDefault();
				this.closeList();
				this.host.goTo(ref.index);
			});
		}
		this.list = list;
		this.chip.setAttribute("aria-expanded", "true");
		const outside = (e: Event) => {
			const target = e.target as Node | null;
			if (target && (list.contains(target) || this.chip?.contains(target))) return;
			this.closeList();
		};
		const esc = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.closeList();
		};
		activeDocument.addEventListener("pointerdown", outside, true);
		activeDocument.addEventListener("keydown", esc, true);
		this.closeOnOutside = (): void => {
			activeDocument.removeEventListener("pointerdown", outside, true);
			activeDocument.removeEventListener("keydown", esc, true);
		};
	}

	closeList(): void {
		this.closeOnOutside?.();
		this.closeOnOutside = null;
		this.list?.remove();
		this.list = null;
		this.chip?.setAttribute("aria-expanded", "false");
	}
}
