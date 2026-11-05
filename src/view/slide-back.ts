import { setIcon } from "obsidian";
import { t } from "../i18n";
import { anchorFor, IDLE_MS, isBackInView, returnY, shouldShowBack, type BackAnchor, type YRange } from "../model/slide-back";
import type { NotebookDocument, Page } from "../model/types";

/** Events that must not reach the page or the view's shortcuts (the pill never takes pen input). */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;

export interface SlideBackHost {
	/** The element the pill floats in (the notebook body). */
	parent(): HTMLElement;
	/** The setting is on and the notebook can be navigated. */
	enabled(): boolean;
	lectureOn(): boolean;
	doc(): NotebookDocument | null;
	/** Index of the page with that id, or -1. */
	indexOf(pageId: string): number;
	/** Top and height of page `index` in document coordinates, or null. */
	box(index: number): { y: number; height: number } | null;
	/** The part of the document in view, in document coordinates, or null while there is no layout. */
	view(): YRange | null;
	/** Shows page `index` with page y `y` at the top (the same move as the notebook map's), recorded in the back history. */
	goTo(index: number, y: number): void;
}

/**
 * Roadmap #225: a small pill "Back to slide N" / "Back to current page" while the user has scrolled away from the place they
 * last wrote during a lecture (or beside a linked slide). It is reconsidered only when the view has been still for a moment
 * (no per-frame work: `viewChanged` only re-arms one timer), it sits at the top, away from the writing, never takes pen input,
 * can be closed and goes away by itself when the view is back. The anchor lives in memory only; nothing is written.
 */
export class SlideBack {
	private anchor: BackAnchor | null = null;
	private pill: HTMLElement | null = null;
	private label: HTMLElement | null = null;
	private icon: HTMLElement | null = null;
	private dismissed = false;
	private timer: number | null = null;
	private lastMove = 0;

	constructor(private readonly host: SlideBackHost) {}

	/** A stroke was committed (ids of the new ink): the page it is on becomes the place to come back to. */
	wrote(page: Page | null, ids: ReadonlySet<string>): void {
		const doc = this.host.doc();
		if (!doc || !page || !this.host.enabled()) return;
		const next = anchorFor(doc, page, ids, this.host.lectureOn());
		if (!next) return;
		this.anchor = next;
		this.dismissed = false;
		this.check();
	}

	/** Anything moved the view. Cheap: one timer for the whole scroll. */
	viewChanged(): void {
		if (!this.anchor && !this.pill) return;
		this.lastMove = performance.now();
		if (this.timer === null) this.timer = window.setTimeout(() => this.settle(), IDLE_MS);
	}

	/** The anchor is the page of this id (or the pill is shown): the document changed, so look again. */
	documentChanged(): void {
		if (this.anchor && this.host.indexOf(this.anchor.pageId) < 0) this.anchor = null;
		this.check();
	}

	/** A different document: nothing to come back to. */
	reset(): void {
		this.anchor = null;
		this.dismissed = false;
		this.hide();
	}

	/** The setting or the mode changed. */
	settingsChanged(): void {
		if (!this.host.enabled()) this.reset();
		else this.check();
	}

	/** The command: goes back when there is somewhere to go. */
	goBack(): boolean {
		const a = this.anchor;
		if (!a || !this.host.enabled()) return false;
		const index = this.host.indexOf(a.pageId);
		const box = index >= 0 ? this.host.box(index) : null;
		if (!box) return false;
		const view = this.host.view();
		this.host.goTo(index, returnY(a, box.height, view ? view.bottom - view.top : 0));
		this.dismissed = false;
		this.hide();
		return true;
	}

	/** There is a place to go back to (the command is offered). */
	get available(): boolean {
		return this.anchor !== null && this.host.enabled() && this.host.indexOf(this.anchor.pageId) >= 0;
	}

	get visible(): boolean {
		return this.pill !== null;
	}

	destroy(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.anchor = null;
		this.hide();
	}

	private settle(): void {
		this.timer = null;
		const wait = IDLE_MS - (performance.now() - this.lastMove);
		if (wait > 16) {
			this.timer = window.setTimeout(() => this.settle(), wait);
			return;
		}
		this.check();
	}

	/** The anchor spot in document coordinates, or null. */
	private spot(): YRange | null {
		const a = this.anchor;
		if (!a) return null;
		const box = this.host.box(this.host.indexOf(a.pageId));
		return box ? { top: box.y + a.top, bottom: box.y + a.bottom } : null;
	}

	private check(): void {
		const view = this.host.view();
		const spot = this.spot();
		if (!view || !spot) {
			this.hide();
			return;
		}
		if (isBackInView(spot, view)) this.dismissed = false;
		const show = shouldShowBack({ enabled: this.host.enabled(), spot, view, shown: this.pill !== null, dismissed: this.dismissed });
		if (!show) {
			this.hide();
			return;
		}
		this.show(spot.bottom < view.top);
	}

	private show(above: boolean): void {
		const a = this.anchor;
		if (!a) return;
		if (!this.pill) {
			const pill = this.host.parent().createDiv({ cls: "notebook-slide-back", attr: { role: "group" } });
			for (const type of ISOLATED) pill.addEventListener(type, (e) => e.stopPropagation());
			const go = pill.createEl("button", { cls: "notebook-slide-back-go", attr: { type: "button" } });
			this.icon = go.createSpan({ cls: "notebook-slide-back-icon", attr: { "aria-hidden": "true" } });
			this.label = go.createSpan({ cls: "notebook-slide-back-label" });
			go.addEventListener("click", (e) => {
				e.preventDefault();
				this.goBack();
			});
			const close = pill.createEl("button", { cls: "notebook-slide-back-close clickable-icon", attr: { type: "button", "aria-label": t("slideBack.dismiss") } });
			setIcon(close, "x");
			close.addEventListener("click", (e) => {
				e.preventDefault();
				this.dismissed = true;
				this.hide();
			});
			this.pill = pill;
		}
		const text = a.slide !== null ? t("slideBack.slide", { n: String(a.slide) }) : t("slideBack.page");
		this.label?.setText(text);
		this.pill.setAttribute("aria-label", text);
		if (this.icon) setIcon(this.icon, above ? "arrow-up" : "arrow-down");
	}

	private hide(): void {
		this.pill?.remove();
		this.pill = null;
		this.label = null;
		this.icon = null;
	}
}

/** The page of a document by index, for the view's glue. */
export function pageAt(doc: NotebookDocument | null, index: number): Page | null {
	return doc?.pages[index] ?? null;
}
