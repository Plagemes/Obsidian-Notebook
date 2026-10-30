import { setIcon } from "obsidian";
import { t } from "../i18n";
import { OfferGate } from "../ink/auto-page";

/** How long the chip stays when nobody answers, ms. */
const CHIP_MS = 9000;
/** Events that must not reach the page or the view's shortcuts. */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;

export interface PageOfferHost {
	/** The element the chip floats in (the notebook body, over the page area). */
	parent(): HTMLElement;
	/** Inserts a page right after the page with this id (same size and paper), one undo step; false when it could not. */
	insertAfter(pageId: string): boolean;
}

/**
 * Roadmap 389 (extends 95): when writing reaches the bottom of a page that is not the last one, a small chip offers to
 * insert a page right after it. It never acts on its own: it is a button at the bottom of the view, away from the
 * writing, it disappears when the pen goes down again or after a few seconds, and it is not offered again for the same
 * page once it was taken, closed or left to time out.
 */
export class PageOffer {
	private readonly gate = new OfferGate();
	private chip: HTMLElement | null = null;
	private timer: number | null = null;
	private pageId: string | null = null;

	constructor(private readonly host: PageOfferHost) {}

	/** Ink reached the bottom of page `pageId` (not the last one, setting on): shows the chip unless it was already settled. */
	offer(pageId: string): void {
		if (!this.gate.allows(pageId)) return;
		this.pageId = pageId;
		this.show();
	}

	/** The pen went down again: the chip steps aside (it is not settled, the next stroke at the bottom brings it back). */
	penDown(): void {
		this.hide(false);
	}

	/** The view moved to another page, the document was replaced or something was undone: no offer for what is no longer in view. */
	cancel(): void {
		this.hide(false);
	}

	/** A new document: pages that were settled belong to the old one. */
	reset(): void {
		this.hide(false);
		this.gate.reset();
	}

	destroy(): void {
		this.hide(false);
	}

	/** The offer is currently on screen (tests, state checks). */
	get visible(): boolean {
		return this.chip !== null;
	}

	private show(): void {
		if (!this.chip) {
			const chip = this.host.parent().createDiv({ cls: "notebook-page-offer", attr: { role: "group", "aria-label": t("autopage.offer") } });
			for (const type of ISOLATED) chip.addEventListener(type, (e) => e.stopPropagation());
			const add = chip.createEl("button", { cls: "notebook-page-offer-add", attr: { type: "button" } });
			setIcon(add.createSpan({ cls: "notebook-page-offer-icon" }), "file-plus");
			add.createSpan({ text: t("autopage.offer") });
			add.addEventListener("click", (e) => {
				e.preventDefault();
				this.accept();
			});
			const close = chip.createEl("button", { cls: "notebook-page-offer-close clickable-icon", attr: { type: "button", "aria-label": t("autopage.dismiss") } });
			setIcon(close, "x");
			close.addEventListener("click", (e) => {
				e.preventDefault();
				this.hide(true);
			});
			this.chip = chip;
		}
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.hide(true), CHIP_MS);
	}

	private accept(): void {
		const id = this.pageId;
		this.hide(true);
		if (id) this.host.insertAfter(id);
	}

	/** `settle`: the offer for this page is over for good (taken, closed or timed out), not just hidden for a moment. */
	private hide(settle: boolean): void {
		if (settle && this.pageId) this.gate.settle(this.pageId);
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.chip?.remove();
		this.chip = null;
		if (settle) this.pageId = null;
	}
}
