import { setIcon } from "obsidian";
import { t } from "../i18n";
import { clampRatio, DEFAULT_RATIO, ratioFromPointer, splitOrientation, type SplitOrientation } from "../pdf/sync-layout";
import type { LinkState } from "../pdf/sync-links";
import type { ReferenceSource } from "./pdf-reference";

/** What the pane asks the controller to do (view/pdf-sync.ts). */
export interface PaneActions {
	/** The reader turned the reference page (buttons, page box). */
	turned(index: number): void;
	toggleLink(): void;
	addNotesPage(): void;
	showNotes(): void;
	toggleFollow(): void;
	close(): void;
}

/** What the strip under the page offers. */
export type Banner =
	| { kind: "none" }
	| { kind: "add" }
	| { kind: "show"; label: string };

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
	const b = parent.createEl("button", { cls: "notebook-pdfside-btn clickable-icon", attr: { "aria-label": label, title: label, type: "button" } });
	setIcon(b, icon);
	b.addEventListener("click", onClick);
	return b;
}

/**
 * The reference pane of the synchronised view (#106): a header (title, previous / next, page box, link, follow,
 * close), the page, and a strip that offers "Add notes page for this slide". It sits inside the notebook body next
 * to the stage, with a draggable divider. A split inside the view works on phones and tablets, where Obsidian has no
 * split panes in the main area.
 */
export class PdfSidePane {
	readonly el: HTMLElement;
	private readonly divider: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly pageBox: HTMLInputElement;
	private readonly totalEl: HTMLElement;
	private readonly prevBtn: HTMLButtonElement;
	private readonly nextBtn: HTMLButtonElement;
	private readonly linkBtn: HTMLButtonElement;
	private readonly followBtn: HTMLButtonElement;
	private readonly pageArea: HTMLElement;
	private readonly bannerEl: HTMLElement;
	private readonly resizeObserver: ResizeObserver;
	private source: ReferenceSource | null = null;
	private index = 0;
	private token = 0;
	private renderTimer: number | null = null;
	private orientation: SplitOrientation = "row";
	private ratio = DEFAULT_RATIO;
	private lastWidth = 0;

	constructor(private readonly body: HTMLElement, private readonly actions: PaneActions) {
		this.divider = body.createDiv({ cls: "notebook-pdfside-divider", attr: { role: "separator", "aria-label": t("pdfSide.divider") } });
		this.el = body.createDiv({ cls: "notebook-pdfside" });
		body.insertBefore(this.divider, body.firstChild);
		body.insertBefore(this.el, this.divider);
		body.addClass("has-pdfside");

		const header = this.el.createDiv({ cls: "notebook-pdfside-header" });
		this.titleEl = header.createDiv({ cls: "notebook-pdfside-title" });
		const nav = header.createDiv({ cls: "notebook-pdfside-nav" });
		this.prevBtn = iconButton(nav, "chevron-left", t("pdfSide.prev"), () => this.turn(this.index - 1));
		this.pageBox = nav.createEl("input", { cls: "notebook-pdfside-pagebox", attr: { type: "number", min: "1", "aria-label": t("pdfSide.pageBox") } });
		this.pageBox.addEventListener("change", () => this.turn(Number(this.pageBox.value) - 1));
		this.totalEl = nav.createSpan({ cls: "notebook-pdfside-total" });
		this.nextBtn = iconButton(nav, "chevron-right", t("pdfSide.next"), () => this.turn(this.index + 1));
		const tools = header.createDiv({ cls: "notebook-pdfside-tools" });
		this.linkBtn = tools.createEl("button", { cls: "notebook-pdfside-text-btn", attr: { type: "button" } });
		this.linkBtn.addEventListener("click", () => actions.toggleLink());
		this.followBtn = tools.createEl("button", { cls: "notebook-pdfside-text-btn", text: t("pdfSide.follow"), attr: { type: "button" } });
		this.followBtn.addEventListener("click", () => actions.toggleFollow());
		iconButton(tools, "x", t("pdfSide.close"), () => actions.close());

		this.pageArea = this.el.createDiv({ cls: "notebook-pdfside-page" });
		this.bannerEl = this.el.createDiv({ cls: "notebook-pdfside-banner" });
		this.bannerEl.hide();

		this.resizeObserver = new ResizeObserver(() => this.onResize());
		this.resizeObserver.observe(this.pageArea);
		this.resizeObserver.observe(body);
		this.layout();
		this.installDivider();
		this.setFollow(true);
		this.setLinkState("disabled");
	}

	setSource(source: ReferenceSource, index: number): void {
		this.source = source;
		this.titleEl.setText(source.title);
		this.titleEl.setAttr("title", source.file.path);
		this.totalEl.setText(`/ ${source.pageCount()}`);
		this.pageBox.max = String(source.pageCount());
		this.show(index);
	}

	/** Shows reference page `index` (clamped). Does not tell the controller: use for programmatic moves. */
	show(index: number): void {
		const source = this.source;
		if (!source) return;
		const last = source.pageCount() - 1;
		const next = Math.min(last, Math.max(0, Math.round(index)));
		const moved = next !== this.index;
		this.index = next;
		this.pageBox.value = String(next + 1);
		this.prevBtn.disabled = next <= 0;
		this.nextBtn.disabled = next >= last;
		void this.renderPage(moved);
	}

	/** Draws the current page again (a page of another notebook finished loading, or the file was saved). */
	refresh(): void {
		if (this.renderTimer !== null) return;
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			void this.renderPage(false);
		}, 150);
	}

	setFollow(on: boolean): void {
		this.followBtn.toggleClass("is-active", on);
		this.followBtn.setAttr("aria-pressed", String(on));
		this.followBtn.setAttr("title", t(on ? "pdfSide.follow.on" : "pdfSide.follow.off"));
	}

	setLinkState(state: LinkState | "disabled"): void {
		const text = state === "here" ? t("pdfSide.unlink") : t("pdfSide.link");
		this.linkBtn.setText(text);
		this.linkBtn.setAttr("title", t(state === "here" ? "pdfSide.unlink.title" : "pdfSide.link.title"));
		this.linkBtn.disabled = state === "disabled";
	}

	setBanner(banner: Banner): void {
		this.bannerEl.empty();
		if (banner.kind === "none") {
			this.bannerEl.hide();
			return;
		}
		if (banner.kind === "add") {
			this.bannerEl.createSpan({ text: t("pdfSide.noNotes") });
			this.bannerEl.createEl("button", { text: t("pdfSide.addNotes"), cls: "mod-cta", attr: { type: "button" } })
				.addEventListener("click", () => this.actions.addNotesPage());
		} else {
			this.bannerEl.createSpan({ text: banner.label });
			this.bannerEl.createEl("button", { text: t("pdfSide.showNotes"), attr: { type: "button" } })
				.addEventListener("click", () => this.actions.showNotes());
		}
		this.bannerEl.show();
	}

	destroy(): void {
		this.resizeObserver.disconnect();
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.token++;
		this.source = null;
		this.el.remove();
		this.divider.remove();
		this.body.removeClass("has-pdfside", "is-pdfside-row", "is-pdfside-column");
		this.body.setCssProps({ "--notebook-pdfside-size": "" });
	}

	// ---------------------------------------------------------------------------------------

	private turn(index: number): void {
		const source = this.source;
		if (!source || !Number.isFinite(index)) return;
		const next = Math.min(source.pageCount() - 1, Math.max(0, Math.round(index)));
		if (next === this.index) {
			this.pageBox.value = String(next + 1);
			return;
		}
		this.show(next);
		this.actions.turned(next);
	}

	private async renderPage(resetScroll: boolean): Promise<void> {
		const source = this.source;
		const width = Math.floor(this.pageArea.clientWidth);
		if (!source || width < 40) return;
		const token = ++this.token;
		this.pageArea.addClass("is-loading");
		try {
			const el = await source.render(this.index, width, Math.min(2, window.devicePixelRatio || 1));
			if (token !== this.token) return;
			el.addClass("notebook-pdfside-image");
			this.pageArea.replaceChildren(el);
			if (resetScroll) this.pageArea.scrollTop = 0;
			this.pageArea.removeClass("is-loading");
		} catch (e) {
			if (token !== this.token) return;
			if (e instanceof Error && e.name === "AbortError") return; // superseded by a newer render
			console.error("[notebook] PDF side pane", e);
			this.pageArea.replaceChildren(createDiv({ cls: "notebook-pdfside-error", text: t("pdfSide.renderFailed") }));
			this.pageArea.removeClass("is-loading");
		}
	}

	private onResize(): void {
		this.layout();
		const width = Math.floor(this.pageArea.clientWidth);
		if (width !== this.lastWidth) {
			this.lastWidth = width;
			this.refresh();
		}
	}

	/** Side by side on a wide view, stacked on a narrow one; the divider keeps the chosen share. */
	private layout(): void {
		const rect = this.body.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		this.orientation = splitOrientation(rect.width, rect.height);
		this.body.toggleClass("is-pdfside-row", this.orientation === "row");
		this.body.toggleClass("is-pdfside-column", this.orientation === "column");
		this.body.setCssProps({ "--notebook-pdfside-size": `${Math.round(this.ratio * 1000) / 10}%` });
	}

	private installDivider(): void {
		const d = this.divider;
		const move = (e: PointerEvent): void => {
			const rect = this.body.getBoundingClientRect();
			this.ratio = this.orientation === "row"
				? ratioFromPointer(e.clientX, rect.left, rect.width)
				: ratioFromPointer(e.clientY, rect.top, rect.height);
			this.layout();
		};
		d.addEventListener("pointerdown", (e) => {
			d.setPointerCapture(e.pointerId);
			d.addClass("is-dragging");
			e.preventDefault();
		});
		d.addEventListener("pointermove", (e) => {
			if (d.hasPointerCapture(e.pointerId)) move(e);
		});
		const end = (e: PointerEvent): void => {
			if (d.hasPointerCapture(e.pointerId)) d.releasePointerCapture(e.pointerId);
			d.removeClass("is-dragging");
			this.ratio = clampRatio(this.ratio);
		};
		d.addEventListener("pointerup", end);
		d.addEventListener("pointercancel", end);
	}
}
