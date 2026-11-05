/**
 * 0.20 reference window (#107): a small floating window over the canvas that shows a reference while you write: a page of this
 * or another notebook, a PDF page, a picture or a Markdown note. Read only: the reference is never written and never gets ink.
 * It is dragged by its header, resized from its corner, made see-through, minimised to a chip, and closed. Its place is kept
 * on this device (local storage, a few numbers, see ui/ref-window-geometry.ts). It occupies only its own rectangle: it is a
 * small element over the notebook's body, not a layer over the canvas, so the pen outside it is never intercepted; a pen
 * inside it does nothing (fingers and the mouse pan and zoom the reference). Cheap on a tablet: the picture is drawn at the
 * window's size, the fingers move one CSS transform, and the picture is drawn again only after a resize or a zoom has ended.
 */
import { setIcon, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { colorFor } from "../ui/palette";
import { iconSquare } from "../ui/components/icon-square";
import {
	chipRect, clampOpacity, clampRect, fromPlacement, initialRect, moveRect, normaliseMemory, placementFor, remember, resizeRect, restoredRect,
	snapRect, type Rect, type Size, type WindowMemory,
} from "../ui/ref-window-geometry";
import { FIT, panView, pinchFactor, rasterWidth, refit, shouldRedraw, zoomView, type ContentView } from "../ui/ref-window-pan";
import { showNotice } from "./notice";
import { movesContent, pageLabel, stepIndex, type ReferenceKind, type ReferenceRequest } from "./ref-window-logic";
import { openSource, type RefSource, type SourceDeps } from "./ref-window-sources";

/** Local storage key of the remembered place (per device, never synced). */
export const REF_WINDOW_KEY = "notebook-ref-window";
/** Wait after the last resize or zoom before the picture is drawn again (ms). */
const REDRAW_DELAY_MS = 180;
/** A press that moves less than this (CSS px) is a tap. */
const TAP_SLOP = 6;

const KIND_ICON: Record<ReferenceKind, string> = { notebook: "pencil-line", pdf: "file-text", image: "image", markdown: "file-text" };

export interface RefWindowHost {
	app: App;
	/** The element the window floats over (the notebook view's body). */
	container(): HTMLElement;
	deps: Omit<SourceDeps, "changed">;
	/** Snap to the edges when dropped near them (a setting). */
	snap(): boolean;
}

/** Captures a pointer; one that is not active (a synthetic event) cannot be captured, and its events still reach the element. */
function capture(el: HTMLElement, pointerId: number): void {
	try {
		el.setPointerCapture(pointerId);
	} catch {
		// nothing to capture
	}
}

interface Pt {
	x: number;
	y: number;
}

export class RefWindow {
	private root: HTMLElement | null = null;
	private chip: HTMLElement | null = null;
	private frame: HTMLElement | null = null;
	private layer: HTMLElement | null = null;
	private title: HTMLElement | null = null;
	private chipTitle: HTMLElement | null = null;
	private stepper: HTMLElement | null = null;
	private stepLabel: HTMLElement | null = null;
	private fitButton: HTMLButtonElement | null = null;
	private prevButton: HTMLButtonElement | null = null;
	private nextButton: HTMLButtonElement | null = null;
	private headIcon: HTMLElement | null = null;

	private source: RefSource | null = null;
	private index = 0;
	private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
	private minimised = false;
	private memory: WindowMemory;
	private content: ContentView = FIT;
	private aspect = 1.4;
	private drawnPx = 0;
	private drawnFrameW = 0;
	private drawSeq = 0;
	private openSeq = 0;
	private redrawTimer: number | null = null;
	private reloadTimer: number | null = null;
	private observer: ResizeObserver | null = null;
	private readonly pointers = new Map<number, Pt>();
	private pinchDistance = 0;

	constructor(private readonly host: RefWindowHost) {
		this.memory = this.loadMemory();
	}

	get isOpen(): boolean {
		return this.root !== null;
	}

	/** The file shown, or null. */
	get file(): TFile | null {
		return this.source?.file ?? null;
	}

	// ------------------------------------------------------------------------------------------------------- memory

	private loadMemory(): WindowMemory {
		try {
			return normaliseMemory(this.host.app.loadLocalStorage(REF_WINDOW_KEY));
		} catch {
			return normaliseMemory(null);
		}
	}

	private saveMemory(): void {
		this.memory = remember(this.memory, this.rect, this.viewSize(), this.minimised);
		try {
			this.host.app.saveLocalStorage(REF_WINDOW_KEY, this.memory);
		} catch (e) {
			console.error("[notebook] could not store the reference window place", e);
		}
	}

	private viewSize(): Size {
		const r = this.host.container().getBoundingClientRect();
		return { width: Math.round(r.width), height: Math.round(r.height) };
	}

	// ----------------------------------------------------------------------------------------------------------- open

	/** Shows `file` in the window (opening the window if needed); a window that is minimised comes back. */
	async open(file: TFile, request: Pick<ReferenceRequest, "page" | "pageId"> = { page: null, pageId: null }): Promise<void> {
		const seq = ++this.openSeq;
		const fresh = !this.root;
		if (fresh) this.build();
		this.setBusy(true);
		let source: RefSource;
		try {
			source = await openSource({ ...this.host.deps, changed: () => this.scheduleRedraw(true) }, file);
		} catch (e) {
			console.error("[notebook] reference could not be opened", file.path, e);
			showNotice(t("refwin.failed", { name: file.basename }));
			if (fresh && !this.source) this.close();
			else this.setBusy(false);
			return;
		}
		if (seq !== this.openSeq || !this.root) {
			source.destroy();
			return;
		}
		this.source?.destroy();
		this.source = source;
		this.index = source.indexFor(request);
		this.content = FIT;
		this.setTitle(file.basename, source.kind);
		this.minimised = false;
		this.fit();
		await this.draw();
	}

	close(): void {
		this.openSeq++;
		this.drawSeq++;
		this.clearTimers();
		this.observer?.disconnect();
		this.observer = null;
		this.source?.destroy();
		this.source = null;
		this.root?.remove();
		this.chip?.remove();
		this.root = this.chip = this.frame = this.layer = this.title = this.chipTitle = this.stepper = this.stepLabel = null;
		this.fitButton = this.prevButton = this.nextButton = this.headIcon = null;
		this.pointers.clear();
	}

	destroy(): void {
		this.close();
	}

	/** The vault file changed: a reference that shows it is read again (a note being edited, a notebook that was saved). */
	fileChanged(path: string): void {
		if (!this.source || this.source.file.path !== path || this.source.kind === "image") return;
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			void this.source?.reload().then((changed) => {
				if (changed) this.scheduleRedraw(true);
			});
		}, 600);
	}

	/** The shown file was deleted or renamed away: the window closes (a rename is followed by opening the new name). */
	fileGone(path: string): void {
		if (this.source?.file.path === path) this.close();
	}

	private clearTimers(): void {
		for (const timer of [this.redrawTimer, this.reloadTimer]) if (timer !== null) window.clearTimeout(timer);
		this.redrawTimer = this.reloadTimer = null;
	}

	// ------------------------------------------------------------------------------------------------------------ DOM

	private build(): void {
		const container = this.host.container();
		const root = container.createDiv({ cls: "nb-ui nb-refwin", attr: { role: "dialog", "aria-label": t("refwin.label") } });
		root.addEventListener("pointerdown", (e) => e.stopPropagation());
		root.addEventListener("contextmenu", (e) => e.stopPropagation());

		const head = root.createDiv({ cls: "nb-refwin-head", attr: { title: t("refwin.move") } });
		this.headIcon = iconSquare(head, "image", colorFor("reference"), "nb-refwin-icon");
		this.title = head.createDiv({ cls: "nb-refwin-title" });
		this.iconButton(head, "minus", t("refwin.minimise"), () => this.setMinimised(true));
		this.iconButton(head, "x", t("refwin.close"), () => this.close());
		this.dragOn(head, (e) => !(e.target as HTMLElement).closest("button"), {
			move: (start, dx, dy, view) => moveRect(start, dx, dy, view),
			end: () => this.dropped(),
		});

		const frame = (this.frame = root.createDiv({ cls: "nb-refwin-frame" }));
		this.layer = frame.createDiv({ cls: "nb-refwin-layer" });
		this.bindFrame(frame);

		const foot = root.createDiv({ cls: "nb-refwin-foot" });
		this.stepper = foot.createDiv({ cls: "nb-refwin-stepper" });
		this.prevButton = this.iconButton(this.stepper, "chevron-left", t("refwin.prev"), () => this.step(-1));
		this.stepLabel = this.stepper.createSpan({ cls: "nb-refwin-steplabel" });
		this.nextButton = this.iconButton(this.stepper, "chevron-right", t("refwin.next"), () => this.step(1));
		this.fitButton = this.iconButton(foot, "scan", t("refwin.fit"), () => this.resetZoom());
		const opacity = foot.createDiv({ cls: "nb-refwin-opacity", attr: { title: t("refwin.opacity") } });
		setIcon(opacity.createSpan({ cls: "nb-refwin-opacity-icon", attr: { "aria-hidden": "true" } }), "droplet");
		const slider = opacity.createEl("input", { cls: "nb-refwin-slider", attr: { type: "range", min: "35", max: "100", step: "5", "aria-label": t("refwin.opacity") } });
		slider.value = String(Math.round(this.memory.opacity * 100));
		slider.addEventListener("input", () => {
			this.memory = { ...this.memory, opacity: clampOpacity(Number(slider.value) / 100) };
			this.applyOpacity();
		});
		slider.addEventListener("change", () => this.saveMemory());
		const grip = foot.createDiv({ cls: "nb-refwin-grip", attr: { title: t("refwin.resize"), role: "separator", "aria-label": t("refwin.resize") } });
		setIcon(grip, "move-diagonal-2");
		this.dragOn(grip, () => true, {
			move: (start, dx, dy, view) => resizeRect(start, dx, dy, view),
			end: () => {
				this.saveMemory();
				this.scheduleRedraw(false);
			},
		});

		const chip = (this.chip = container.createDiv({ cls: "nb-ui nb-refwin-chip", attr: { role: "button", tabindex: "0", "aria-label": t("refwin.restore") } }));
		chip.hide();
		setIcon(chip.createSpan({ cls: "nb-refwin-chip-icon", attr: { "aria-hidden": "true" } }), "picture-in-picture-2");
		this.chipTitle = chip.createSpan({ cls: "nb-refwin-chip-title" });
		this.dragOn(chip, () => true, {
			move: (start, dx, dy, view) => moveRect(chipRect(start, view), dx, dy, view),
			end: (moved) => {
				if (!moved) {
					this.setMinimised(false);
					return;
				}
				this.dropped();
			},
			chip: true,
		});
		chip.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.setMinimised(false);
			}
		});

		this.root = root;
		this.applyOpacity();
		const observer = new ResizeObserver(() => this.fit());
		observer.observe(container);
		this.observer = observer;
		this.rect = initialRect(this.memory, this.viewSize());
		this.minimised = false;
		this.applyRect();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "nb-card-btn nb-refwin-btn", attr: { type: "button", "aria-label": label, title: label } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
		return b;
	}

	private setTitle(name: string, kind: ReferenceKind): void {
		this.title?.setText(name);
		this.chipTitle?.setText(name);
		this.root?.setAttribute("aria-label", t("refwin.dialog", { name }));
		if (this.headIcon) {
			this.headIcon.empty();
			setIcon(this.headIcon, KIND_ICON[kind]);
		}
		this.root?.toggleClass("is-flow", this.source?.layout === "flow");
		this.fitButton?.toggleClass("is-hidden", this.source?.layout === "flow");
		this.updateStepper();
	}

	private setBusy(busy: boolean): void {
		this.root?.toggleClass("is-busy", busy);
	}

	private updateStepper(): void {
		const count = this.source?.pageCount() ?? 1;
		this.stepper?.toggleClass("is-hidden", count <= 1);
		this.stepLabel?.setText(pageLabel(this.index, count));
		if (this.prevButton) this.prevButton.disabled = this.index <= 0;
		if (this.nextButton) this.nextButton.disabled = this.index >= count - 1;
	}

	private applyOpacity(): void {
		this.root?.setCssProps({ "--nb-rw-opacity": String(this.memory.opacity) });
	}

	// ------------------------------------------------------------------------------------------------------ geometry

	/** The view changed size (a rotation, a resized pane): the window is put back in the remembered place of this orientation, inside the view. */
	private fit(): void {
		const view = this.viewSize();
		if (view.width <= 0 || view.height <= 0) return;
		const place = placementFor(this.memory, view);
		this.rect = place ? fromPlacement(place, view) : clampRect(this.rect, view);
		this.applyRect();
		this.scheduleRedraw(false);
	}

	private applyRect(): void {
		const { root, chip } = this;
		if (!root || !chip) return;
		const r = this.rect;
		root.setCssProps({ "--nb-rw-x": `${r.x}px`, "--nb-rw-y": `${r.y}px`, "--nb-rw-w": `${r.width}px`, "--nb-rw-h": `${r.height}px` });
		const c = chipRect(r, this.viewSize());
		chip.setCssProps({ "--nb-rw-x": `${c.x}px`, "--nb-rw-y": `${c.y}px`, "--nb-rw-w": `${c.width}px`, "--nb-rw-h": `${c.height}px` });
		root.toggleClass("is-min", this.minimised);
		if (this.minimised) {
			root.hide();
			chip.show();
		} else {
			chip.hide();
			root.show();
			this.layout();
		}
	}

	/** Sizes the layer to the frame and puts the content where the zoom and offset say. */
	private layout(): void {
		const { frame, layer } = this;
		if (!frame || !layer) return;
		const w = frame.clientWidth;
		const h = frame.clientHeight;
		if (w <= 0 || h <= 0) return;
		if (this.source?.layout === "flow") return;
		const content = { width: w, height: w * this.aspect };
		this.content = refit(this.content, content, { width: w, height: h });
		layer.setCssProps({
			"--nb-rw-lw": `${content.width}px`, "--nb-rw-lh": `${content.height}px`,
			"--nb-rw-tx": `${this.content.x}px`, "--nb-rw-ty": `${this.content.y}px`, "--nb-rw-ts": String(this.content.scale),
		});
	}

	private setMinimised(value: boolean): void {
		if (!this.root || !this.chip) return;
		if (value === this.minimised) return;
		if (value) {
			this.minimised = true;
		} else {
			this.rect = restoredRect(this.rect, chipRect(this.rect, this.viewSize()), this.viewSize());
			this.minimised = false;
		}
		this.applyRect();
		this.saveMemory();
		if (!value) this.scheduleRedraw(false);
	}

	private dropped(): void {
		const view = this.viewSize();
		if (this.host.snap()) this.rect = snapRect(this.rect, view);
		this.applyRect();
		this.saveMemory();
	}

	/**
	 * Drags the window by `el` with that pointer captured (so nothing else is covered while it moves). A press that barely
	 * moved is a tap (`end(false)`). `chip` drags the minimised chip, which moves the window's corner.
	 */
	private dragOn(
		el: HTMLElement, accepts: (e: PointerEvent) => boolean,
		o: { move: (start: Rect, dx: number, dy: number, view: Size) => Rect; end: (moved: boolean) => void; chip?: boolean },
	): void {
		el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || !accepts(e)) return;
			e.preventDefault();
			e.stopPropagation();
			const view = this.viewSize();
			const start = o.chip ? chipRect(this.rect, view) : this.rect;
			const from = { x: e.clientX, y: e.clientY };
			let moved = false;
			capture(el, e.pointerId);
			const onMove = (m: PointerEvent): void => {
				if (m.pointerId !== e.pointerId) return;
				const dx = m.clientX - from.x, dy = m.clientY - from.y;
				if (!moved && Math.hypot(dx, dy) < TAP_SLOP) return;
				moved = true;
				const next = o.move(start, dx, dy, view);
				this.rect = o.chip ? { ...this.rect, x: next.x, y: next.y } : next;
				this.applyRect();
			};
			const onEnd = (u: PointerEvent): void => {
				if (u.pointerId !== e.pointerId) return;
				el.removeEventListener("pointermove", onMove);
				el.removeEventListener("pointerup", onEnd);
				el.removeEventListener("pointercancel", onEnd);
				if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
				o.end(moved);
			};
			el.addEventListener("pointermove", onMove);
			el.addEventListener("pointerup", onEnd);
			el.addEventListener("pointercancel", onEnd);
		});
	}

	// -------------------------------------------------------------------------------------------- fingers on the content

	private bindFrame(frame: HTMLElement): void {
		const frameSize = (): Size => ({ width: frame.clientWidth, height: frame.clientHeight });
		const contentSize = (): Size => ({ width: frame.clientWidth, height: frame.clientWidth * this.aspect });
		const local = (e: { clientX: number; clientY: number }): Pt => {
			const r = frame.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		const distance = (): number => {
			const [a, b] = [...this.pointers.values()];
			return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
		};
		const middle = (): Pt => {
			const [a, b] = [...this.pointers.values()];
			return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : (a ?? { x: 0, y: 0 });
		};

		frame.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			// A pen does nothing in the window: no ink, no panning.
			if (!movesContent(e.pointerType)) {
				e.preventDefault();
				return;
			}
			if (this.source?.layout === "flow") return;
			capture(frame, e.pointerId);
			this.pointers.set(e.pointerId, local(e));
			this.pinchDistance = distance();
		});
		frame.addEventListener("pointermove", (e) => {
			const before = this.pointers.get(e.pointerId);
			if (!before || this.source?.layout === "flow") return;
			const now = local(e);
			const oldMiddle = middle();
			const oldDistance = this.pinchDistance;
			this.pointers.set(e.pointerId, now);
			if (this.pointers.size >= 2) {
				const d = distance();
				const mid = middle();
				let v = zoomView(this.content, pinchFactor(oldDistance, d), mid.x, mid.y, contentSize(), frameSize());
				v = panView(v, mid.x - oldMiddle.x, mid.y - oldMiddle.y, contentSize(), frameSize());
				this.pinchDistance = d;
				this.content = v;
			} else {
				this.content = panView(this.content, now.x - before.x, now.y - before.y, contentSize(), frameSize());
			}
			this.layout();
		});
		const lift = (e: PointerEvent): void => {
			if (!this.pointers.delete(e.pointerId)) return;
			this.pinchDistance = distance();
			if (this.pointers.size === 0) this.scheduleRedraw(false);
		};
		frame.addEventListener("pointerup", lift);
		frame.addEventListener("pointercancel", lift);
		frame.addEventListener("wheel", (e) => {
			e.stopPropagation();
			if (this.source?.layout === "flow") return;
			e.preventDefault();
			const at = local(e);
			this.content = zoomView(this.content, Math.exp(-e.deltaY * 0.0015), at.x, at.y, contentSize(), frameSize());
			this.layout();
			this.scheduleRedraw(false);
		}, { passive: false });
		frame.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			if (this.source?.layout === "flow") return;
			if (this.content.scale > 1.05) this.resetZoom();
			else {
				const at = local(e);
				this.content = zoomView(this.content, 2.5, at.x, at.y, contentSize(), frameSize());
				this.layout();
				this.scheduleRedraw(false);
			}
		});
	}

	private resetZoom(): void {
		this.content = FIT;
		this.layout();
		this.scheduleRedraw(false);
	}

	private step(delta: number): void {
		const src = this.source;
		if (!src) return;
		const next = stepIndex(this.index, delta, src.pageCount());
		if (next === this.index) return;
		this.index = next;
		this.content = FIT;
		this.updateStepper();
		void this.draw();
	}

	// ----------------------------------------------------------------------------------------------------------- draw

	/** Draws the picture again after the fingers or the corner let go; `force` for a changed file. */
	private scheduleRedraw(force: boolean): void {
		if (!this.root) return;
		if (this.redrawTimer !== null) window.clearTimeout(this.redrawTimer);
		this.redrawTimer = window.setTimeout(() => {
			this.redrawTimer = null;
			const frame = this.frame;
			if (!frame || !this.source || this.minimised) return;
			const fw = frame.clientWidth;
			if (fw <= 0) return;
			if (force) {
				void this.draw();
				return;
			}
			if (this.source.layout === "flow") return; // a document flows to the new width by itself
			const wanted = rasterWidth(fw, this.content.scale, window.devicePixelRatio || 1, this.aspect);
			const resized = Math.abs(fw / Math.max(1, this.drawnFrameW) - 1) > 0.05;
			if (resized || shouldRedraw(this.drawnPx, wanted)) void this.draw();
		}, REDRAW_DELAY_MS);
	}

	private async draw(): Promise<void> {
		const { source, frame, layer } = this;
		if (!source || !frame || !layer || this.minimised) return;
		const fw = frame.clientWidth;
		if (fw <= 0) return;
		const seq = ++this.drawSeq;
		this.setBusy(true);
		const count = source.pageCount();
		this.index = Math.min(Math.max(0, this.index), Math.max(0, count - 1));
		const px = rasterWidth(fw, this.content.scale, window.devicePixelRatio || 1, this.aspect);
		const holder = createDiv();
		try {
			const drawn = await source.render(this.index, px, holder);
			if (seq !== this.drawSeq || !this.layer) return;
			this.layer.empty();
			this.layer.appendChild(drawn.el);
			this.layer.removeClass("is-failed");
			this.aspect = drawn.aspect > 0 ? drawn.aspect : this.aspect;
			this.drawnPx = px;
			this.drawnFrameW = fw;
			this.updateStepper();
			this.layout();
		} catch (e) {
			if (seq !== this.drawSeq || !this.layer) return;
			console.error("[notebook] reference could not be drawn", source.file.path, e);
			this.layer.empty();
			this.layer.addClass("is-failed");
			this.layer.createDiv({ cls: "nb-refwin-empty", text: t("refwin.unavailable") });
		} finally {
			if (seq === this.drawSeq) this.setBusy(false);
		}
	}
}
