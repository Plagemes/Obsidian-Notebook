import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { PageBox } from "../ink/layout";
import { screenToPage, type Viewport } from "../ink/viewport";
import { isDrawnRegion, orderedNotes, regionFromDrag } from "../model/comments";
import type { CommentRegion, NotebookDocument, PageCommentNote } from "../model/types";

/** What the layer needs from the view. Nothing here writes the document. */
export interface LayerHost {
	doc(): NotebookDocument | null;
	/** The stage element, the viewport and the page boxes (document space), or null before a document is laid out. */
	geometry(): { stage: HTMLElement; viewport: Viewport; boxes: readonly PageBox[] } | null;
	/** The setting "Show comment markers". */
	markersOn(): boolean;
	/** The comment whose card is open, if any. */
	selected(): { pageId: string; id: string } | null;
	/** A marker was tapped. */
	pick(pageId: string, id: string): void;
}

/** Side of a margin marker (CSS px) and the least distance between two markers of a page. */
const MARKER = 24;
const MARKER_GAP = 28;
/** Events a marker or the drawing surface keeps from the pen input below them. */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "mousedown", "contextmenu"] as const;

interface Mark {
	/** The faint outline of the region (or the strong one when selected). */
	box: HTMLElement;
	/** The line from the region to its marker. */
	line: HTMLElement;
	marker: HTMLButtonElement;
	label: HTMLElement;
}

/**
 * The comments of the pages in view (0.18, #86): for each, a small numbered marker in the right margin of its page, joined by
 * a thin line to the outline of the region it is about. The comment whose card is open is highlighted. DOM elements over the
 * canvas (like the zettel regions): the outlines and lines let every pointer event through, only a marker takes taps, and a
 * marker keeps its contacts from the pen input below. Repositioned after every viewport, layout or history change (the view's
 * overlay hook), by changing a few style variables of elements kept per comment. Also the one-shot "draw a rectangle" surface.
 */
export class CommentLayer {
	private readonly root: HTMLElement;
	private readonly marks = new Map<string, Mark>();
	private drawing: { el: HTMLElement; stop: () => void } | null = null;
	/** The margin marker element of a comment, for placing the card beside it. */
	markerOf(id: string): HTMLElement | null {
		return this.marks.get(id)?.marker ?? null;
	}

	constructor(private readonly host: LayerHost) {
		this.root = createDiv({ cls: "nb-ui nb-cm-layer" });
	}

	destroy(): void {
		this.disarmDraw();
		this.root.remove();
		this.marks.clear();
	}

	/** Positions every marker, outline and line. Cheap: elements are reused, only variables change. */
	draw(): void {
		const geometry = this.host.geometry();
		const doc = this.host.doc();
		const show = this.host.markersOn();
		if (!geometry || !doc) {
			this.root.toggleClass("notebook-hidden", true);
			return;
		}
		if (this.root.parentElement !== geometry.stage) geometry.stage.appendChild(this.root);
		const keep = new Set<string>();
		const selected = this.host.selected();
		const { scale, offsetX, offsetY } = geometry.viewport;
		const stageW = geometry.stage.clientWidth;
		const stageH = geometry.stage.clientHeight;
		const any = show || selected !== null;
		this.root.toggleClass("notebook-hidden", !any);
		if (any) {
			doc.pages.forEach((page, pageIndex) => {
				if (!page.comments) return;
				const box = geometry.boxes[pageIndex];
				if (!box) return;
				const top = offsetY + box.y * scale;
				if (top > stageH || top + box.height * scale < 0) return;
				const notes = orderedNotes(page);
				const right = offsetX + (box.x + box.width) * scale;
				if (right < 0 || offsetX + box.x * scale > stageW) return;
				let lastY = -Infinity;
				notes.forEach((note, k) => {
					const isSel = selected?.id === note.id && selected.pageId === page.id;
					if (!show && !isSel) return;
					const r = note.region;
					const rx = offsetX + (box.x + r.x) * scale;
					const ry = top + r.y * scale;
					const rw = r.width * scale;
					const rh = r.height * scale;
					// The marker: in the right margin of the page (inside its edge), level with the middle of the region, never on top of the previous one.
					const mx = right - MARKER - 4;
					let my = ry + Math.min(rh / 2, 40) - MARKER / 2;
					my = Math.max(my, lastY + MARKER_GAP);
					lastY = my;
					if (my > stageH || my + MARKER < 0) {
						if (!isSel) return;
					}
					keep.add(note.id);
					const m = this.mark(note, page.id);
					this.paint(m, note, k + 1, isSel);
					const fromX = Math.min(rx + rw, mx);
					const fromY = ry + rh / 2;
					const toX = mx + MARKER / 2;
					const toY = my + MARKER / 2;
					const dx = toX - fromX;
					const dy = toY - fromY;
					m.box.setCssProps({ "--nb-cm-x": `${rx}px`, "--nb-cm-y": `${ry}px`, "--nb-cm-w": `${rw}px`, "--nb-cm-h": `${rh}px` });
					m.line.setCssProps({ "--nb-cm-x": `${fromX}px`, "--nb-cm-y": `${fromY}px`, "--nb-cm-len": `${Math.hypot(dx, dy)}px`, "--nb-cm-angle": `${Math.atan2(dy, dx)}rad` });
					m.marker.setCssProps({ "--nb-cm-x": `${mx}px`, "--nb-cm-y": `${my}px` });
				});
			});
		}
		for (const [id, m] of this.marks) {
			if (keep.has(id)) continue;
			m.box.remove();
			m.line.remove();
			m.marker.remove();
			this.marks.delete(id);
		}
	}

	private mark(note: PageCommentNote, pageId: string): Mark {
		const existing = this.marks.get(note.id);
		if (existing) return existing;
		const box = this.root.createDiv({ cls: "nb-cm-region" });
		const line = this.root.createDiv({ cls: "nb-cm-line" });
		const marker = this.root.createEl("button", { cls: "nb-cm-marker", attr: { type: "button", "data-key": `comment-marker:${note.id}` } });
		const label = marker.createSpan({ cls: "nb-cm-marker-n" });
		for (const type of ISOLATED) marker.addEventListener(type, (e) => e.stopPropagation());
		marker.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.host.pick(pageId, note.id);
		});
		const m = { box, line, marker, label };
		this.marks.set(note.id, m);
		return m;
	}

	/** Text, label and state classes of a marker and its outline. */
	private paint(m: Mark, note: PageCommentNote, number: number, selected: boolean): void {
		const resolved = note.resolved === true;
		const text = String(number);
		if (m.label.textContent !== text) m.label.textContent = text;
		const firstLine = note.text.split("\n", 1)[0] ?? "";
		const aria = t(resolved ? "comments.marker.aria.resolved" : "comments.marker.aria", { n: text, text: firstLine.slice(0, 60) || t("comments.sketch") });
		if (m.marker.getAttribute("aria-label") !== aria) {
			m.marker.setAttribute("aria-label", aria);
			m.marker.setAttribute("title", aria);
		}
		for (const el of [m.box, m.line, m.marker]) {
			el.toggleClass("is-resolved", resolved);
			el.toggleClass("is-active", selected);
		}
		m.marker.setAttribute("aria-pressed", String(selected));
		if (resolved && !m.marker.querySelector(".nb-cm-marker-check")) setIcon(m.marker.createSpan({ cls: "nb-cm-marker-check", attr: { "aria-hidden": "true" } }), "check");
		else if (!resolved) m.marker.querySelector(".nb-cm-marker-check")?.remove();
	}

	// --- drawing a rectangle -----------------------------------------------------------------------------------------

	get armed(): boolean {
		return this.drawing !== null;
	}

	/**
	 * Arms a one-shot rectangle: a drag on a page (pen, finger or mouse) gives its region. A surface over the page area takes
	 * every contact meanwhile, so the ink tools below are not reached. `done` gets the page index and the region; `cancel` is
	 * called when it ends without one (Escape, the Cancel button, another one-shot mode).
	 */
	armDraw(done: (pageIndex: number, region: CommentRegion) => void, cancel: () => void): void {
		this.disarmDraw();
		const geometry = this.host.geometry();
		if (!geometry) {
			cancel();
			return;
		}
		const stage = geometry.stage;
		const el = stage.createDiv({ cls: "nb-ui nb-cm-draw", attr: { "data-key": "comment-draw" } });
		const hint = el.createDiv({ cls: "nb-cm-draw-hint", attr: { role: "status" } });
		hint.createSpan({ text: t("comments.draw.hint") });
		const cancelBtn = hint.createEl("button", { cls: "nb-cm-draw-cancel", text: t("comments.cancel"), attr: { type: "button", "data-key": "comment-draw-cancel" } });
		const rect = el.createDiv({ cls: "nb-cm-draw-rect notebook-hidden" });
		let start: { id: number; index: number; box: PageBox; local: [number, number]; sx: number; sy: number } | null = null;

		const local = (e: PointerEvent) => {
			const g = this.host.geometry() ?? geometry;
			const r = stage.getBoundingClientRect();
			const sx = e.clientX - r.left;
			const sy = e.clientY - r.top;
			const [dx, dy] = screenToPage(g.viewport, sx, sy);
			return { sx, sy, dx, dy, g };
		};
		const finish = (ok: boolean, index = -1, region?: CommentRegion) => {
			this.disarmDraw();
			if (ok && region) done(index, region);
			else cancel();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			finish(false);
		};
		activeDocument.addEventListener("keydown", onKey, true);
		cancelBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			finish(false);
		});
		for (const type of ["pointerdown", "pointerup", "pointermove", "touchstart", "mousedown", "contextmenu"] as const) {
			// The hint bar keeps its own taps; everything else belongs to the drawing surface.
			hint.addEventListener(type, (e) => e.stopPropagation());
		}
		el.addEventListener("pointerdown", (e) => {
			if (start || (e.pointerType === "mouse" && e.button !== 0)) return;
			e.preventDefault();
			e.stopPropagation();
			const p = local(e);
			const index = p.g.boxes.findIndex((b) => p.dx >= b.x && p.dx <= b.x + b.width && p.dy >= b.y && p.dy <= b.y + b.height);
			if (index < 0) return;
			const box = p.g.boxes[index]!;
			start = { id: e.pointerId, index, box, local: [p.dx - box.x, p.dy - box.y], sx: p.sx, sy: p.sy };
			try {
				el.setPointerCapture(e.pointerId);
			} catch {
				// a pointer that is no longer active (a synthetic event): the drag goes on without capture
			}
			rect.removeClass("notebook-hidden");
			place(p.sx, p.sy);
		});
		const place = (x: number, y: number) => {
			if (!start) return;
			rect.setCssProps({ "--nb-cm-x": `${Math.min(start.sx, x)}px`, "--nb-cm-y": `${Math.min(start.sy, y)}px`, "--nb-cm-w": `${Math.abs(x - start.sx)}px`, "--nb-cm-h": `${Math.abs(y - start.sy)}px` });
		};
		el.addEventListener("pointermove", (e) => {
			if (!start || e.pointerId !== start.id) return;
			e.preventDefault();
			e.stopPropagation();
			place(local(e).sx, local(e).sy);
		});
		const up = (e: PointerEvent, cancelled: boolean) => {
			if (!start || e.pointerId !== start.id) return;
			e.preventDefault();
			e.stopPropagation();
			const p = local(e);
			const s = start;
			start = null;
			rect.addClass("notebook-hidden");
			if (cancelled) return;
			const end: [number, number] = [p.dx - s.box.x, p.dy - s.box.y];
			if (!isDrawnRegion(s.local, end)) {
				// A tap, not a rectangle: stay armed so the next drag counts.
				hint.addClass("is-nudge");
				window.setTimeout(() => hint.removeClass("is-nudge"), 600);
				return;
			}
			const doc = this.host.doc();
			const page = doc?.pages[s.index];
			if (!page) return finish(false);
			finish(true, s.index, regionFromDrag(s.local, end, page));
		};
		el.addEventListener("pointerup", (e) => up(e, false));
		el.addEventListener("pointercancel", (e) => up(e, true));
		this.drawing = {
			el,
			stop: () => {
				activeDocument.removeEventListener("keydown", onKey, true);
				el.remove();
			},
		};
	}

	disarmDraw(): void {
		const d = this.drawing;
		this.drawing = null;
		d?.stop();
	}
}
