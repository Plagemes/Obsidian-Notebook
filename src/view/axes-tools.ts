import { t } from "../i18n";
import { axesFromCross, axesFromL, buildAxes, defaultAxes, tickSpacing, type AxesSpec } from "../ink/axes";
import { AddElement, AddStroke, Batch, removeStrokes, type Command } from "../model/history";
import type { NotebookDocument, PageElement, Stroke } from "../model/types";
import type { NotebookSettings } from "../settings";
import { chip } from "../ui/components/chip";
import { showNotice } from "./notice";

/**
 * View side of instant axes (0.22, roadmap #206). An "L" drawn with the pen, or a "+" drawn as two lines, is offered as Cartesian axes
 * (a chip near the corner, nine seconds) or turned into them at once (setting), and the insert sheet drops a set of four-quadrant axes
 * where the pen last wrote. The geometry is in ink/axes.ts (pure); the result is plain vector ink (shape strokes) plus small number
 * labels, all in one fresh group, added in ONE undo step that also takes away the gesture strokes. It adds nothing to the format.
 */
export interface AxesHost {
	stage(): HTMLElement;
	doc(): NotebookDocument | null;
	editable(): boolean;
	/** Runs a command as one undo step (false when it was refused: a locked page, a read-only notebook). */
	execute(cmd: Command): boolean;
	settings(): NotebookSettings;
	/** Page-local point to stage pixels; null when the page is not laid out. */
	toStage(pageIndex: number, x: number, y: number): [number, number] | null;
	insertTarget(): { pageIndex: number; x: number; y: number } | null;
	penColor(): string;
	penWidth(): number;
	select(pageIndex: number, strokes: Stroke[], elements: PageElement[]): void;
	refresh(): void;
}

/** How long the chip stays, ms. */
const OFFER_MS = 9000;
/** An automatic conversion waits this long, so the next stroke or a side-button retraction can come first, ms. */
const AUTO_DELAY_MS = 450;
/** The second line of a "+" must follow the first within this time, ms. */
const CROSS_MS = 6000;
/** After this many offers in a row that nobody took, none is made until axes are made or the notebook is opened again. */
const MAX_IGNORED = 3;
const ISOLATED = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown"] as const;

interface Offer {
	pageIndex: number;
	pageId: string;
	/** The strokes of the gesture (one for an "L", two for a "+"). */
	strokeIds: string[];
	spec: AxesSpec;
	color: string;
	width: number;
}

export class AxesTools {
	private offer: Offer | null = null;
	private chipEl: HTMLElement | null = null;
	private chipTimer: number | null = null;
	private autoTimer: number | null = null;
	private ignored = 0;
	private prev: { pageId: string; strokeId: string; at: number } | null = null;
	private lastPen: { pageId: string; x: number; y: number } | null = null;

	constructor(private readonly host: AxesHost) {}

	destroy(): void {
		this.hideOffer();
		if (this.autoTimer !== null) window.clearTimeout(this.autoTimer);
		this.autoTimer = null;
	}

	/** Another document was loaded. */
	reset(): void {
		this.destroy();
		this.ignored = 0;
		this.prev = null;
		this.lastPen = null;
	}

	/** The view moved or zoomed: the chip would point at the wrong place. */
	viewChanged(): void {
		if (this.chipEl) this.hideOffer();
	}

	/** A page was left. */
	cancelOffer(): void {
		this.hideOffer();
	}

	/** Strokes were added to page `pageIndex` by the pen: an "L" or the second line of a "+" is offered (or made) as axes. */
	strokesAdded(pageIndex: number, strokes: readonly Stroke[]): void {
		const page = this.host.doc()?.pages[pageIndex];
		const stroke = strokes[strokes.length - 1];
		if (!page || !stroke) return;
		const last = stroke.points[stroke.points.length - 1];
		if (last) this.lastPen = { pageId: page.id, x: last[0], y: last[1] };
		const prev = this.prev;
		this.prev = strokes.length === 1 && !stroke.hidden ? { pageId: page.id, strokeId: stroke.id, at: Date.now() } : null;
		const mode = this.host.settings().axesDraw;
		if (mode === "off" || strokes.length !== 1 || !this.host.editable()) return;
		// The highlighter and the marker are marking tools: an L or a cross drawn with them is not turned into thin axes.
		if (stroke.hidden || stroke.tool === "highlighter" || stroke.tool === "marker" || this.ignored >= MAX_IGNORED) return;
		const index = page.strokes.indexOf(stroke);
		if (index < 0) return;
		let spec = axesFromL(stroke.points);
		let ids = [stroke.id];
		if (!spec && prev && prev.pageId === page.id && Date.now() - prev.at <= CROSS_MS) {
			const before = page.strokes[index - 1];
			if (before && before.id === prev.strokeId && !before.hidden && before.tool !== "highlighter" && before.tool !== "marker") {
				spec = axesFromCross(before.points, stroke.points);
				ids = [before.id, stroke.id];
			}
		}
		if (!spec) return;
		const offer: Offer = { pageIndex, pageId: page.id, strokeIds: ids, spec, color: stroke.color, width: stroke.width };
		this.hideOffer();
		if (mode === "auto") {
			this.autoTimer = window.setTimeout(() => {
				this.autoTimer = null;
				this.convert(offer, false);
			}, AUTO_DELAY_MS);
			return;
		}
		this.offer = offer;
		this.showChip();
	}

	private showChip(): void {
		const o = this.offer;
		if (!o) return;
		const at = this.host.toStage(o.pageIndex, o.spec.ox, o.spec.oy);
		if (!at) return;
		if (!this.chipEl) {
			const holder = this.host.stage().createDiv({ cls: "nb-ui nb-axes-offer", attr: { role: "group", "aria-label": t("axes.offer.aria") } });
			for (const type of ISOLATED) holder.addEventListener(type, (e) => e.stopPropagation());
			chip(holder, { label: t("axes.offer"), icon: "axis-3d", key: "axes-offer", title: t("axes.offer.aria"), onClick: () => this.accept() });
			this.chipEl = holder;
		}
		this.chipEl.setCssProps({ "--nb-axes-x": `${Math.round(at[0])}px`, "--nb-axes-y": `${Math.round(at[1]) + 12}px` });
		if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
		this.chipTimer = window.setTimeout(() => {
			this.chipTimer = null;
			if (this.offer) this.ignored++;
			this.hideOffer();
		}, OFFER_MS);
	}

	private hideOffer(): void {
		if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
		this.chipTimer = null;
		this.chipEl?.remove();
		this.chipEl = null;
		this.offer = null;
	}

	private accept(): void {
		const o = this.offer;
		this.hideOffer();
		if (o) this.convert(o, true);
	}

	/** The strokes, text labels and group of axes for a page, with the settings of the day. */
	private drawing(pageIndex: number, spec: AxesSpec, color: string, width: number) {
		const page = this.host.doc()?.pages[pageIndex];
		const s = this.host.settings();
		return buildAxes(spec, { spacing: tickSpacing(page?.paper.spacing), ticks: s.axesTicks, labels: s.axesTicks && s.axesLabels, color, width });
	}

	/** Replaces the gesture with axes in one undo step. Nothing happens when a stroke is gone or the page changed. */
	private convert(o: Offer, said: boolean): void {
		const doc = this.host.doc();
		const page = doc?.pages[o.pageIndex];
		if (!doc || !page || page.id !== o.pageId || !this.host.editable()) return;
		const gesture = o.strokeIds.map((id) => page.strokes.find((s) => s.id === id));
		if (gesture.some((s) => !s)) return;
		const removed = removeStrokes(page.id, page.strokes, gesture as Stroke[], "Remove gesture");
		if (!removed) return;
		const art = this.drawing(o.pageIndex, o.spec, o.color, o.width);
		const base = page.strokes.length - gesture.length;
		const commands: Command[] = [removed, ...art.strokes.map((s, i) => new AddStroke(page.id, s, base + i))];
		const added = art.texts.map((el, i) => new AddElement(page.id, el, (page.elements?.length ?? 0) + i));
		if (!this.host.execute(new Batch("Make axes", [...commands, ...added]))) return;
		this.ignored = 0;
		this.host.refresh();
		if (said) showNotice(t("axes.made"), 2500);
	}

	/** "Axes" in the insert sheet: four-quadrant axes where the pen last wrote on the page in view (else the centre of the view). */
	insert(): void {
		if (!this.host.editable()) return;
		const target = this.host.insertTarget();
		const doc = this.host.doc();
		const page = target ? doc?.pages[target.pageIndex] : undefined;
		if (!target || !page) return;
		const pen = this.lastPen && this.lastPen.pageId === page.id ? this.lastPen : null;
		const color = /^#[0-9a-fA-F]{6}$/.test(this.host.penColor()) ? this.host.penColor() : "#1f2430";
		const spec = defaultAxes(pen?.x ?? target.x, pen?.y ?? target.y, tickSpacing(page.paper.spacing), page);
		const art = this.drawing(target.pageIndex, spec, color, Math.min(2.2, Math.max(1, this.host.penWidth())));
		const adds: Command[] = [
			...art.strokes.map((s, i) => new AddStroke(page.id, s, page.strokes.length + i)),
			...art.texts.map((el, i) => new AddElement(page.id, el, (page.elements?.length ?? 0) + i)),
		];
		if (!this.host.execute(new Batch("Make axes", adds))) return;
		this.ignored = 0;
		const after = this.host.doc()?.pages[target.pageIndex];
		if (after) this.host.select(target.pageIndex, after.strokes.filter((s) => s.group === art.group), (after.elements ?? []).filter((e) => e.group === art.group));
		this.host.refresh();
	}
}
