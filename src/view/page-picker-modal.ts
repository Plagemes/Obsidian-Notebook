import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { MAX_ASPECT } from "../library/thumbnail";
import { writing } from "../ink/writing-guard";
import type { MoveMode } from "../model/selection-move";
import type { Page } from "../model/types";
import { chip } from "../ui/components/chip";
import { modalShell } from "../ui/components/modal-shell";

/** What the picker needs from the notebook view. */
export interface PagePickerHost {
	pages(): readonly Page[];
	/** The page the selection is on: not offered as a target. */
	from: number;
	mode: MoveMode;
	/** Data URL of a page thumbnail (the navigator's cache). */
	thumbnail(page: Page): string;
	/** The page to go to / the new page: `index` is a page of the notebook, `"new"` a blank page after the source page. */
	choose(target: number | "new", exact: boolean): void;
}

/**
 * "Move to page…" / "Copy to page…" (roadmap #78): the pages of the notebook as thumbnails (the same cards as the notebook
 * map), a first card "New page after this", and a switch for the exact position. Tap a page to choose it.
 */
export class PagePickerModal extends Modal {
	private exact = false;
	private observer: IntersectionObserver | null = null;

	constructor(app: App, private readonly pickHost: PagePickerHost) {
		super(app);
	}

	onOpen(): void {
		const h = this.pickHost;
		const move = h.mode === "move";
		const shell = modalShell(this, {
			title: t(move ? "movePage.titleMove" : "movePage.titleCopy"), icon: move ? "arrow-right-to-line" : "copy", size: "wide", cls: "nb-map-modal nb-move-modal",
			subtitle: t("movePage.subtitle", { page: String(h.from + 1) }), footer: false, seed: "move-to-page",
		});
		const options = shell.body.createDiv({ cls: "nb-map-filters" });
		const toggle = chip(options, {
			label: t("movePage.exact"), icon: "crosshair", active: this.exact, key: "exact", title: t("movePage.exactHint"),
			onClick: () => {
				this.exact = !this.exact;
				toggle.toggleClass("is-active", this.exact);
				toggle.setAttribute("aria-pressed", String(this.exact));
			},
		});
		const grid = shell.body.createDiv({ cls: "nb-map-grid" });
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

		const fresh = grid.createEl("button", { cls: "nb-map-card nb-move-new", attr: { type: "button", "data-index": "new", "aria-label": t("movePage.newAfter", { page: String(h.from + 1) }) } });
		const plus = fresh.createDiv({ cls: "nb-map-thumb nb-move-new-thumb" });
		setIcon(plus.createSpan({ cls: "nb-move-new-icon", attr: { "aria-hidden": "true" } }), "plus");
		fresh.createDiv({ cls: "nb-map-foot" }).createSpan({ cls: "nb-map-num", text: t("movePage.newAfter", { page: String(h.from + 1) }) });
		fresh.addEventListener("click", () => this.pick("new"));

		const pages = h.pages();
		pages.forEach((page, index) => {
			if (index === h.from) return;
			const card = grid.createEl("button", { cls: "nb-map-card", attr: { type: "button", "data-index": String(index), "aria-label": t("nav.page", { n: String(index + 1) }) } });
			const frame = card.createDiv({ cls: "nb-map-thumb" });
			const img = frame.createEl("img", { attr: { alt: "", draggable: "false" } });
			img.setCssProps({ "--nb-map-ratio": String(Math.min(page.height / page.width, MAX_ASPECT)) });
			card.createDiv({ cls: "nb-map-foot" }).createSpan({ cls: "nb-map-num", text: String(index + 1) });
			card.addEventListener("click", () => this.pick(index));
			this.observer?.observe(card);
		});
	}

	onClose(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.contentEl.empty();
	}

	private pick(target: number | "new"): void {
		this.close();
		this.pickHost.choose(target, this.exact);
	}

	private loadThumb(card: HTMLElement): void {
		const page = this.pickHost.pages()[Number(card.dataset.index)];
		const img = card.querySelector("img");
		if (page && img) img.src = this.pickHost.thumbnail(page);
	}
}
