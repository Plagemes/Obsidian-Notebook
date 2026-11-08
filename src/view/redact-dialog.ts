// 0.26 redact (#285): the dialog where boxes are drawn over the parts of a page that must not leave the notebook. One page at a time as a
// picture; a drag (pen or mouse, and a finger when the switch is on) draws a box. The picture is what the export will contain: it is
// drawn from the REDACTED copy of the page (ink/redact.ts) by the same renderer as the PNG export, so anything a box removes disappears
// from it, and a PDF or picture behind the page shows the box burned in. Nothing here touches the notebook: the boxes are handed to
// `host.commit` after every change, and the caller keeps them on this device.
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { headerAfterRedaction, redactPage } from "../ink/redact";
import { REDACT_MAX_PER_PAGE, addBox, boxFromDrag, boxesOf, clearPage, countBoxes, countPages, pointToPage, removeBox, removeLast, type RedactBox, type Redactions } from "../model/redact";
import type { Page } from "../model/types";
import { iconButton } from "../ui/components/dom";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { attachLongPressHelp, resolveHelp } from "../ui/long-press-help";
import type { MessageKey } from "../i18n/en";
import type { ExportOptions } from "./export";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer } from "./page-images";

export interface RedactHost {
	app: App;
	/** The pages as an export draws them (the states in view, not the stored ones). */
	pages(): readonly Page[];
	media: NotebookMedia | null;
	/** What the export options say about drawing a page (hidden ink, box labels, equation numbers, header); the boxes are not read from here. */
	options: ExportOptions;
	/** The boxes when the dialog opens. */
	initial: Redactions;
	/** 0-based page to open on. */
	pageIndex: number;
	/** Called after every change with the whole set (the caller keeps it on this device). */
	commit(boxes: Redactions): void;
	/** Called when the dialog has closed. */
	closed?(): void;
}

/** Resolution of the preview, dpi: sharp enough to place a box, light enough for a phone. */
export const PREVIEW_DPI = 110;

export class RedactModal extends Modal {
	private boxes: Redactions;
	private index: number;
	private readonly all: readonly Page[];
	private renderer: PageImageRenderer | null = null;
	private stage: HTMLElement | null = null;
	private picture: HTMLImageElement | null = null;
	private layer: HTMLElement | null = null;
	private band: HTMLElement | null = null;
	private pageLabel: HTMLElement | null = null;
	private countLabel: HTMLElement | null = null;
	private failedNote: HTMLElement | null = null;
	private undoButton: HTMLButtonElement | null = null;
	private clearPageButton: HTMLButtonElement | null = null;
	private clearAllButton: HTMLButtonElement | null = null;
	private prevButton: HTMLButtonElement | null = null;
	private nextButton: HTMLButtonElement | null = null;
	private fingerButton: HTMLButtonElement | null = null;
	private fingerDraws = true;
	private url = "";
	private drag: { id: number; from: [number, number]; to: [number, number] } | null = null;
	private drawing = false;
	private dirty = false;
	private done = false;
	private stopHelp: (() => void) | null = null;

	constructor(private readonly host: RedactHost) {
		super(host.app);
		this.all = host.pages();
		this.boxes = host.initial;
		this.index = Math.min(Math.max(0, host.pageIndex), Math.max(0, this.all.length - 1));
		this.fingerDraws = this.all[this.index]?.infinite !== true;
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("redact.title"), subtitle: t("redact.subtitle"), icon: "eye-off", size: "wide", cls: "notebook-redact-modal" });
		const body = shell.body;
		if (this.all.length === 0) {
			shellNote(body, t("redact.nopages"));
			shellButton(shell.foot, "primary", t("redact.done"), () => this.close());
			return;
		}
		shellNote(body, t("redact.hint")).addClass("nb-redact-hint");

		const bar = body.createDiv({ cls: "nb-redact-bar" });
		this.prevButton = iconButton(bar, "chevron-left", t("redact.prev"), () => this.go(-1), "nb-redact-nav", "help.redact.prev");
		const middle = bar.createDiv({ cls: "nb-redact-where" });
		this.pageLabel = middle.createDiv({ cls: "nb-redact-page" });
		this.countLabel = middle.createDiv({ cls: "nb-redact-count" });
		this.nextButton = iconButton(bar, "chevron-right", t("redact.next"), () => this.go(1), "nb-redact-nav", "help.redact.next");

		const tools = body.createDiv({ cls: "nb-redact-tools" });
		this.undoButton = this.tool(tools, "undo-2", t("redact.undo"), "help.redact.undo", () => this.change(removeLast(this.boxes, this.pageId())));
		this.clearPageButton = this.tool(tools, "eraser", t("redact.clearPage"), "help.redact.clearPage", () => this.change(clearPage(this.boxes, this.pageId())));
		this.clearAllButton = this.tool(tools, "trash-2", t("redact.clearAll"), "help.redact.clearAll", () => this.change({}));
		this.fingerButton = this.tool(tools, "pencil", t("redact.finger"), "help.redact.finger", () => {
			this.fingerDraws = !this.fingerDraws;
			this.syncFinger();
		});
		this.syncFinger();

		const scroll = body.createDiv({ cls: "nb-redact-scroll" });
		this.stage = scroll.createDiv({ cls: "nb-redact-stage" });
		this.picture = this.stage.createEl("img", { cls: "nb-redact-img", attr: { alt: "", draggable: "false" } });
		this.layer = this.stage.createDiv({ cls: "nb-redact-layer", attr: { role: "application", "aria-label": t("redact.stage") } });
		this.band = this.layer.createDiv({ cls: "nb-redact-band" });
		this.band.hide();
		this.failedNote = shellNote(body, t("redact.failed"), "error");
		this.failedNote.hide();
		this.wirePointer(this.layer);

		shellButton(shell.foot, "primary", t("redact.done"), () => this.close());
		this.stopHelp = attachLongPressHelp(this.modalEl, (b) => (b.dataset.help ? resolveHelp(b) : null));
		this.show();
	}

	onClose(): void {
		this.done = true;
		this.stopHelp?.();
		this.stopHelp = null;
		this.renderer?.close();
		this.renderer = null;
		if (this.url) URL.revokeObjectURL(this.url);
		this.url = "";
		this.contentEl.empty();
		// Review fix (P4): Done hands over the set as it is, even unchanged: boxes that could not be read are then set again (to what is
		// shown here, possibly none), and exports can go on.
		this.host.commit(this.boxes);
		this.host.closed?.();
	}

	// --- state ---

	private page(): Page | undefined {
		return this.all[this.index];
	}

	private pageId(): string {
		return this.page()?.id ?? "";
	}

	private change(next: Redactions): void {
		if (next === this.boxes) return;
		this.boxes = next;
		this.host.commit(next);
		this.sync();
		this.schedule();
	}

	private go(step: number): void {
		const to = this.index + step;
		if (to < 0 || to >= this.all.length) return;
		this.index = to;
		this.show();
	}

	private show(): void {
		const page = this.page();
		if (page && this.stage) this.stage.setCssProps({ "--nb-redact-ar": String(Math.max(0.05, Math.min(4, page.width / Math.max(1, page.height)))) });
		this.sync();
		this.schedule();
	}

	/** Labels, buttons and the box outlines follow the page and the set. */
	private sync(): void {
		const page = this.page();
		const here = boxesOf(this.boxes, this.pageId());
		this.pageLabel?.setText(t("redact.page", { n: String(this.index + 1), total: String(this.all.length) }));
		this.countLabel?.setText(t("redact.count", { n: String(here.length), total: String(countBoxes(this.boxes)) }));
		if (this.prevButton) this.prevButton.disabled = this.index <= 0;
		if (this.nextButton) this.nextButton.disabled = this.index >= this.all.length - 1;
		if (this.undoButton) this.undoButton.disabled = here.length === 0;
		if (this.clearPageButton) this.clearPageButton.disabled = here.length === 0;
		if (this.clearAllButton) this.clearAllButton.disabled = countPages(this.boxes) === 0;
		this.drawOutlines(page, here);
	}

	private syncFinger(): void {
		this.fingerButton?.setAttribute("aria-pressed", String(this.fingerDraws));
		this.fingerButton?.toggleClass("is-active", this.fingerDraws);
		this.layer?.toggleClass("is-finger", this.fingerDraws);
	}

	private tool(parent: HTMLElement, icon: string, label: string, help: MessageKey, onClick: () => void): HTMLButtonElement {
		const b = shellButton(parent, "secondary", label, () => onClick(), { icon });
		b.addClass("nb-redact-tool");
		b.setAttribute("aria-label", label);
		b.dataset.help = help; // long-press explanation
		return b;
	}

	// --- the boxes on the picture ---

	private drawOutlines(page: Page | undefined, here: readonly RedactBox[]): void {
		const layer = this.layer;
		if (!layer || !page) return;
		for (const el of Array.from(layer.querySelectorAll(".nb-redact-box"))) el.remove();
		here.forEach((box, i) => {
			const el = layer.createDiv({ cls: "nb-redact-box", attr: { "aria-label": t("redact.box", { n: String(i + 1) }) } });
			this.place(el, box, page);
			const x = iconButton(el, "x", t("redact.remove"), () => this.change(removeBox(this.boxes, page.id, i)), "nb-redact-x", "help.redact.remove");
			// A press on the remove button is not the start of a new box.
			x.addEventListener("pointerdown", (e) => e.stopPropagation());
		});
	}

	private place(el: HTMLElement, box: RedactBox, page: Page): void {
		const pct = (v: number): string => `${Math.round(v * 10000) / 100}%`;
		el.setCssProps({
			"--nb-redact-l": pct(box.x / page.width), "--nb-redact-t": pct(box.y / page.height),
			"--nb-redact-w": pct(box.width / page.width), "--nb-redact-h": pct(box.height / page.height),
		});
	}

	// --- drawing a box ---

	private wirePointer(layer: HTMLElement): void {
		layer.addEventListener("pointerdown", (e) => this.onDown(e));
		layer.addEventListener("pointermove", (e) => this.onMove(e));
		layer.addEventListener("pointerup", (e) => this.onUp(e));
		layer.addEventListener("pointercancel", () => this.endDrag());
	}

	private toPage(e: PointerEvent, page: Page): [number, number] {
		const r = (this.picture ?? this.layer)!.getBoundingClientRect();
		return pointToPage(e.clientX, e.clientY, r, page);
	}

	private onDown(e: PointerEvent): void {
		const page = this.page();
		if (!page || this.drag) return;
		// A finger draws only when the switch is on; otherwise it scrolls the page. The pen and the mouse (its main button) always draw.
		if (e.pointerType === "touch" && !this.fingerDraws) return;
		if (e.pointerType === "mouse" && e.button !== 0) return;
		const p = this.toPage(e, page);
		this.drag = { id: e.pointerId, from: p, to: p };
		try {
			this.layer?.setPointerCapture(e.pointerId);
		} catch {
			// A pointer that is already gone: the drag ends with the next event.
		}
		e.preventDefault();
		this.drawBand(page);
	}

	private onMove(e: PointerEvent): void {
		const page = this.page();
		if (!page || !this.drag || this.drag.id !== e.pointerId) return;
		this.drag.to = this.toPage(e, page);
		e.preventDefault();
		this.drawBand(page);
	}

	private onUp(e: PointerEvent): void {
		const page = this.page();
		const drag = this.drag;
		if (!page || !drag || drag.id !== e.pointerId) return;
		drag.to = this.toPage(e, page);
		this.endDrag();
		const box = boxFromDrag(drag.from, drag.to, page);
		if (!box) return;
		if (boxesOf(this.boxes, page.id).length >= REDACT_MAX_PER_PAGE) {
			showNotice(t("redact.limit", { max: String(REDACT_MAX_PER_PAGE) }), 5000);
			return;
		}
		this.change(addBox(this.boxes, page.id, box));
	}

	private endDrag(): void {
		const id = this.drag?.id;
		this.drag = null;
		this.band?.hide();
		if (id !== undefined) {
			try {
				this.layer?.releasePointerCapture(id);
			} catch {
				// Already released.
			}
		}
	}

	private drawBand(page: Page): void {
		const d = this.drag;
		const band = this.band;
		if (!d || !band) return;
		const box = boxFromDrag(d.from, d.to, page);
		if (!box) {
			// Shown loosely while it is still small, so the first moments of a drag give feedback.
			const x = Math.min(d.from[0], d.to[0]);
			const y = Math.min(d.from[1], d.to[1]);
			this.place(band, { x, y, width: Math.abs(d.to[0] - d.from[0]), height: Math.abs(d.to[1] - d.from[1]) }, page);
		} else this.place(band, box, page);
		band.show();
	}

	// --- the picture ---

	/** Draws the preview again, after the one in progress (a run of changes draws once more, not once each). */
	private schedule(): void {
		this.dirty = true;
		this.stage?.addClass("is-loading");
		if (!this.drawing) void this.pump();
	}

	private async pump(): Promise<void> {
		this.drawing = true;
		try {
			while (this.dirty && !this.done) {
				this.dirty = false;
				await this.drawOnce();
			}
		} finally {
			this.drawing = false;
			if (!this.done) this.stage?.removeClass("is-loading");
		}
	}

	private async drawOnce(): Promise<void> {
		const page = this.page();
		const img = this.picture;
		if (!page || !img) return;
		const o = this.host.options;
		try {
			await o.prepare?.([page]);
			const shown = redactPage(page, boxesOf(this.boxes, page.id), this.boxes);
			const header = o.header;
			this.renderer ??= new PageImageRenderer(this.host.media, {
				...(o.hiddenInk ? { hiddenInk: o.hiddenInk } : {}), ...(o.boxLabel ? { boxLabel: o.boxLabel } : {}),
				...(o.equationNumbers ? { equationNumbers: o.equationNumbers } : {}),
				...(header ? { header: (p: Page) => headerAfterRedaction(header(p), p) } : {}),
			});
			const image = await this.renderer.render(shown, PREVIEW_DPI);
			if (this.done) return;
			const url = URL.createObjectURL(image.blob);
			if (this.url) URL.revokeObjectURL(this.url);
			this.url = url;
			img.src = url;
			this.failedNote?.hide();
		} catch (e) {
			console.error("[notebook] redaction preview", e);
			this.failedNote?.show();
		}
	}
}
