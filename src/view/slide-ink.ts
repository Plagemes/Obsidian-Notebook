/**
 * v12 automatic notes ↔ slide link (#226) in the notebook view: the ink being committed is linked to the slide in the
 * side-by-side pane (`linkToSlide`, called by the view in the same undo step), and a small badge next to each group of
 * linked ink shows the slide again when tapped (`attachSlideBadges`).
 *
 * The badges are DOM elements over the stage (like the textbook references, view/textbook-ref-ui.ts): nothing is drawn
 * on the canvases, the renderer is untouched. They follow the viewport through the view's overlay listeners; the groups
 * of a page are computed again only when its strokes or the slide table changed (identity check, strokes are immutable).
 */
import { setIcon } from "obsidian";
import { t } from "../i18n";
import { strokeBounds, type BBox } from "../ink/hit-test";
import { linkStrokes, slideInkGroups, slideTable, type SlideInkGroup } from "../model/slide-links";
import type { Command } from "../model/history";
import { visibleStrokes } from "../model/markers";
import type { NotebookDocument, Page, Stroke } from "../model/types";
import type { NotebookSettings } from "../settings";
import type { NotebookView } from "./notebook-view";
import { referenceSlideKey, showSlideRef } from "./pdf-sync";

/**
 * The strokes about to be committed, linked to the slide beside the notes when there is one (and the setting is on), with
 * the command that adds its entry to the table (to run in the same undo step); null when nothing is linked.
 */
export function linkToSlide(view: NotebookView, doc: NotebookDocument, strokes: readonly Stroke[], enabled: boolean): { strokes: Stroke[]; commands: Command[] } | null {
	if (!enabled || strokes.length === 0) return null;
	const key = referenceSlideKey(view);
	if (!key) return null;
	const linked = linkStrokes(doc, strokes, key);
	badges.get(view)?.refresh();
	return linked;
}

/** Badge size (CSS px): the visible pill is smaller, the tap target is this square (DESIGN.md §7: at least 40 px). */
const TARGET_PX = 40;
/** Gap between the ink and its badge, CSS px. */
const GAP_PX = 2;

const badges = new WeakMap<NotebookView, SlideBadges>();

/** Shows the badges of linked ink in `view` (once per view; removed with the view). */
export function attachSlideBadges(view: NotebookView, settings: () => NotebookSettings): void {
	if (badges.has(view)) return;
	const b = new SlideBadges(view, settings);
	badges.set(view, b);
	view.register(() => {
		b.detach();
		badges.delete(view);
	});
}

/** Draws the badges of `view` again on the next frame (the notebook or the settings changed). */
export function refreshSlideBadges(view: NotebookView): void {
	badges.get(view)?.refresh();
}

interface PageGroups {
	strokes: readonly Stroke[];
	table: string;
	revealed: boolean;
	groups: SlideInkGroup[];
}

class SlideBadges {
	private readonly root: HTMLElement;
	private readonly els = new Map<string, HTMLButtonElement>();
	private readonly cache = new WeakMap<Page, PageGroups>();
	private readonly bounds = new WeakMap<Stroke, BBox>();
	private readonly off: Array<() => void> = [];
	private frame: number | null = null;

	constructor(private readonly view: NotebookView, private readonly settings: () => NotebookSettings) {
		this.root = createDiv({ cls: "nb-ui nb-slide-badges", attr: { "aria-label": t("slides.badges") } });
		this.off.push(view.addOverlayListener(() => this.draw()));
		this.draw();
	}

	detach(): void {
		for (const off of this.off) off();
		this.off.length = 0;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.root.remove();
	}

	refresh(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.draw();
		});
	}

	private hide(): void {
		this.root.addClass("notebook-hidden");
	}

	private draw(): void {
		const geometry = this.view.overlayGeometry();
		const doc = this.view.document;
		if (!geometry || !doc || !this.settings().slideInkBadges || !doc.slides?.length || this.view.activeTool() === "text") return this.hide();
		if (this.root.parentElement !== geometry.stage) geometry.stage.appendChild(this.root);
		this.root.removeClass("notebook-hidden");
		const current = referenceSlideKey(this.view);
		const { scale, offsetX, offsetY } = geometry.viewport;
		const stageW = geometry.stage.clientWidth;
		const stageH = geometry.stage.clientHeight;
		const keep = new Set<string>();
		doc.pages.forEach((page, i) => {
			const box = geometry.boxes[i];
			if (!box) return;
			const top = offsetY + box.y * scale;
			const left = offsetX + box.x * scale;
			if (top > stageH || top + box.height * scale < 0 || left > stageW || left + box.width * scale < 0) return;
			const groups = this.groupsOf(doc, page);
			groups.forEach((g, k) => {
				const pageRight = left + box.width * scale;
				let x = left + g.bounds.maxX * scale + GAP_PX;
				if (x + TARGET_PX > pageRight) x = pageRight - TARGET_PX;
				const y = top + g.bounds.minY * scale - (TARGET_PX - 24) / 2;
				if (x > stageW || y > stageH || x + TARGET_PX < 0 || y + TARGET_PX < 0) return;
				const id = `${page.id}:${g.ref.id}:${k}`;
				keep.add(id);
				let el = this.els.get(id);
				if (!el) {
					el = this.make();
					this.els.set(id, el);
				}
				this.fill(el, g, !!current && current.source === g.ref.source && current.page === g.ref.page);
				el.setCssProps({ "--nb-slide-badge-x": `${Math.round(x)}px`, "--nb-slide-badge-y": `${Math.round(y)}px` });
			});
		});
		for (const [id, el] of this.els) {
			if (keep.has(id)) continue;
			el.remove();
			this.els.delete(id);
		}
	}

	/** The groups of a page, from the cache while its strokes and the table are the same objects as last time. */
	private groupsOf(doc: NotebookDocument, page: Page): SlideInkGroup[] {
		const revealed = this.view.markerTools?.isRevealed(page) ?? false;
		const table = (doc.slides ?? []).map((r) => r.id).join(",");
		const hit = this.cache.get(page);
		const strokes = page.strokes;
		if (hit && hit.revealed === revealed && hit.table === table && hit.strokes.length === strokes.length && hit.strokes.every((s, i) => s === strokes[i])) return hit.groups;
		const groups = strokes.some((s) => s.slide !== undefined)
			? slideInkGroups(slideTable(doc), visibleStrokes(strokes, revealed), undefined, (s) => this.boundsOf(s))
			: [];
		this.cache.set(page, { strokes: [...strokes], table, revealed, groups });
		return groups;
	}

	private boundsOf(s: Stroke): BBox {
		let b = this.bounds.get(s);
		if (!b) {
			b = strokeBounds(s);
			this.bounds.set(s, b);
		}
		return b;
	}

	private make(): HTMLButtonElement {
		const el = this.root.createEl("button", { cls: "nb-slide-badge", attr: { type: "button" } });
		const pill = el.createSpan({ cls: "nb-slide-badge-pill" });
		setIcon(pill.createSpan({ cls: "nb-slide-badge-icon", attr: { "aria-hidden": "true" } }), "presentation");
		pill.createSpan({ cls: "nb-slide-badge-num" });
		el.addEventListener("pointerdown", (e) => e.stopPropagation());
		el.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const source = el.dataset.source;
			const page = Number(el.dataset.page);
			if (!source || !Number.isInteger(page)) return;
			const path = el.dataset.path;
			void showSlideRef(this.view, path ? { source, page, path } : { source, page }).then(() => this.refresh());
		});
		return el;
	}

	private fill(el: HTMLButtonElement, g: SlideInkGroup, current: boolean): void {
		const n = String(g.ref.page);
		if (el.dataset.page !== n || el.dataset.source !== g.ref.source) {
			el.dataset.source = g.ref.source;
			el.dataset.page = n;
			if (g.ref.path) el.dataset.path = g.ref.path;
			else delete el.dataset.path;
			const label = t("slides.badge.show", { page: n });
			el.setAttribute("aria-label", label);
			el.setAttribute("title", label);
			const num = el.querySelector(".nb-slide-badge-num");
			if (num) num.textContent = n;
		}
		el.toggleClass("is-current", current);
	}
}
