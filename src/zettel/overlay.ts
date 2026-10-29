import type { NotebookView } from "../view/notebook-view";
import type { CardRecord } from "./card-content";

/** What the overlay needs from the service. */
export interface OverlaySource {
	/** Cards of a notebook (by document id) that belong to this file, orphaned ones excluded. */
	visibleCards(view: NotebookView, docId: string): CardRecord[];
	show(): boolean;
	/** The view has a document: lets the service note which shape strokes were already there (Z3). */
	seen(view: NotebookView): void;
}

interface Mark {
	el: HTMLElement;
	badge: HTMLElement;
}

/**
 * Card regions on the pages of one notebook view (Z1): a thin outline and a small id badge, as DOM
 * elements over the canvas that let every pointer event through (`pointer-events: none`), so writing
 * is never affected. Repositioned after every viewport change (the view's `overlayChanged` hook).
 */
export class CardOverlay {
	private readonly root: HTMLElement;
	private readonly marks = new Map<string, Mark>();
	private frame: number | null = null;
	/** Cards of the shown document, looked up once per index change (draw runs on every pan and zoom frame). */
	private cached: { docId: string; cards: CardRecord[] } | null = null;

	constructor(private readonly view: NotebookView, private readonly source: OverlaySource) {
		this.root = createDiv({ cls: "notebook-zettel-overlay" });
		view.overlayChanged = () => this.draw();
		this.draw();
	}

	detach(): void {
		if (this.view.overlayChanged) this.view.overlayChanged = null;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.root.remove();
	}

	/** Redraw on the next frame (after card notes change). */
	refresh(): void {
		this.cached = null;
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.draw();
		});
	}

	draw(): void {
		const geometry = this.view.overlayGeometry();
		const doc = this.view.document;
		if (doc) this.source.seen(this.view);
		if (!geometry || !doc || !this.source.show()) {
			this.root.toggleClass("notebook-hidden", true);
			return;
		}
		if (this.root.parentElement !== geometry.stage) geometry.stage.appendChild(this.root);
		this.root.toggleClass("notebook-hidden", false);
		const { scale, offsetX, offsetY } = geometry.viewport;
		const stageW = geometry.stage.clientWidth;
		const stageH = geometry.stage.clientHeight;
		const index = new Map(doc.pages.map((p, i) => [p.id, i]));
		const keep = new Set<string>();
		if (this.cached?.docId !== doc.id) this.cached = { docId: doc.id, cards: this.source.visibleCards(this.view, doc.id) };
		for (const card of this.cached.cards) {
			const i = index.get(card.pageId);
			const box = i === undefined ? undefined : geometry.boxes[i];
			if (!box) continue;
			const r = card.region ?? { x: 0, y: 0, width: box.width, height: box.height };
			const left = offsetX + (box.x + r.x) * scale;
			const top = offsetY + (box.y + r.y) * scale;
			const width = r.width * scale;
			const height = r.height * scale;
			if (left > stageW || top > stageH || left + width < 0 || top + height < 0) continue;
			keep.add(card.path);
			let mark = this.marks.get(card.path);
			if (!mark) {
				const el = this.root.createDiv({ cls: "notebook-zettel-region" });
				mark = { el, badge: el.createSpan({ cls: "notebook-zettel-badge" }) };
				this.marks.set(card.path, mark);
			}
			mark.el.toggleClass("is-page", !card.region);
			mark.badge.setText(card.id);
			mark.el.setAttribute("aria-label", card.title ? `${card.id} ${card.title}` : card.id);
			mark.el.setCssProps({
				"--notebook-zettel-x": `${left}px`,
				"--notebook-zettel-y": `${top}px`,
				"--notebook-zettel-w": `${width}px`,
				"--notebook-zettel-h": `${height}px`,
			});
		}
		for (const [path, mark] of this.marks) {
			if (keep.has(path)) continue;
			mark.el.remove();
			this.marks.delete(path);
		}
	}
}
