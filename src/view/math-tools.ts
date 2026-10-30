import { t } from "../i18n";
import { inkOnGraph, moveStroke, graphEditCommand, graphViewMatrix, panView, zoomView } from "../ink/graph-ink";
import { equationOutline, setTypesetRequest, storeTypeset, typesetKey, type Typeset } from "../ink/math-render";
import type { Renderer } from "../ink/renderer";
import { segmentText } from "../ink/words";
import { equationSizeNear } from "../math/layout";
import { formatOutline } from "../math/outline";
import { outlineToInk } from "../math/skeleton";
import { createStroke, quantizePoint } from "../model/document";
import { AddElement, AddStroke, Batch, RemoveElement, ReplaceElement, type Command } from "../model/history";
import { createEquation, createGraph } from "../model/math-elements";
import { checkElement, freezeElement, freezeStroke } from "../model/serialize";
import type { EquationElement, GraphElement, NotebookDocument, Page, PageElement, Point, Stroke } from "../model/types";
import { EquationEditor, type EquationDraft } from "./equation-editor";
import { GraphPanel } from "./graph-panel";
import { TypesetError, typesetEquation } from "./math-typeset";
import { showNotice } from "./notice";

/**
 * View side of equations (#110) and function graphs (#113): inserting them, the equation editor and the graph panel,
 * typesetting with Obsidian's MathJax (cached outlines in the element, a session cache for the rest), "Convert to ink",
 * and panning or zooming inside a graph while its panel is open (the ink on it follows its coordinates). The view
 * passes itself as a MathHost; everything here goes through its history, one undo step per edit.
 */

export interface MathHost {
	/** The element panels and gestures live in (the canvas stage). */
	stage: HTMLElement;
	doc(): NotebookDocument | null;
	/** The document can be edited now. */
	editable(): boolean;
	renderer(): Renderer | null;
	/** Runs a command as one undo step (false when the document cannot be edited). */
	execute(cmd: Command): boolean;
	/** Page in view and the page point at the centre of the view. */
	insertTarget(): { pageIndex: number; x: number; y: number } | null;
	/** Stage px of a page point. */
	toStage(pageIndex: number, x: number, y: number): [number, number] | null;
	/** Page point under a pointer event (client coordinates). */
	toPage(pageIndex: number, clientX: number, clientY: number): [number, number] | null;
	/** Viewport scale (stage px per pt). */
	scale(): number;
	/** Selected elements and their page. */
	selection(): { pageIndex: number; elements: readonly PageElement[] } | null;
	/** Selects these elements (lasso tool). */
	select(pageIndex: number, elements: PageElement[]): void;
	/** Clears the selection (an element being edited is drawn by its editor, not by a floating selection). */
	deselect(): void;
	/** Current pen colour and text size (defaults of new equations). */
	pen(): { color: string; textSize: number };
	/** Setting "Ink follows objects". */
	inkFollows(): boolean;
	refresh(): void;
}

interface EquationSession {
	pageId: string;
	element: EquationElement | null;
	x: number;
	y: number;
	editor: EquationEditor;
}

interface GraphSession {
	pageId: string;
	pageIndex: number;
	before: GraphElement;
	ink: Stroke[];
	draft: GraphElement;
	panel: GraphPanel;
}

export class MathTools {
	private eq: EquationSession | null = null;
	private graph: GraphSession | null = null;
	/** Equations waiting to be typeset (by key) and keys that failed (not retried this session). */
	private readonly queue = new Map<string, EquationElement>();
	private readonly failed = new Set<string>();
	private typesetting = false;
	private destroyed = false;
	/** Pointers down inside the graph being edited (pan with one, pinch zoom with two). */
	private readonly pointers = new Map<number, [number, number]>();
	private readonly onDown = (e: PointerEvent) => this.pointerDown(e);
	private readonly onMove = (e: PointerEvent) => this.pointerMove(e);
	private readonly onUp = (e: PointerEvent) => this.pointerUp(e);
	private readonly onWheel = (e: WheelEvent) => this.wheel(e);

	constructor(private readonly host: MathHost) {
		setTypesetRequest((el) => this.requestTypeset(el));
		host.stage.addEventListener("pointerdown", this.onDown, true);
		host.stage.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
		window.addEventListener("pointermove", this.onMove, true);
		window.addEventListener("pointerup", this.onUp, true);
		window.addEventListener("pointercancel", this.onUp, true);
	}

	get isEditing(): boolean {
		return this.eq !== null || this.graph !== null;
	}

	// --- typesetting -------------------------------------------------------------------------------------------

	/** An equation is drawn without an outline: typeset it in the background (once per source and size). */
	private requestTypeset(el: EquationElement): void {
		const key = typesetKey(el);
		if (this.failed.has(key) || this.queue.has(key) || this.destroyed) return;
		this.queue.set(key, el);
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.typesetting) return;
		this.typesetting = true;
		try {
			while (this.queue.size > 0 && !this.destroyed) {
				const [key, el] = this.queue.entries().next().value as [string, EquationElement];
				try {
					storeTypeset(key, await typesetEquation(el.latex, el.fontSize, !!el.inline));
					this.host.renderer()?.invalidate();
				} catch (e) {
					this.failed.add(key);
					if (!(e instanceof TypesetError)) console.warn("[notebook] typesetting an equation failed", e);
				}
				this.queue.delete(key);
			}
		} finally {
			this.typesetting = false;
		}
	}

	/**
	 * Outlines for exports: typesets every equation of `pages` that has no cached outline yet (the session cache keeps
	 * them), so the PDF and SVG writers can draw them as vectors.
	 */
	async prepareExport(pages: readonly Page[]): Promise<void> {
		for (const page of pages) {
			for (const el of page.elements ?? []) {
				if (el.type !== "equation" || equationOutline(el)) continue;
				const key = typesetKey(el);
				if (this.failed.has(key)) continue;
				try {
					storeTypeset(key, await typesetEquation(el.latex, el.fontSize, !!el.inline));
				} catch {
					this.failed.add(key);
				}
			}
		}
	}

	// --- equations ---------------------------------------------------------------------------------------------

	/** "Insert equation": a new equation at the centre of the view, sized like the handwriting around it. */
	insertEquation(): void {
		if (!this.host.editable()) return;
		const target = this.host.insertTarget();
		const page = target ? this.host.doc()?.pages[target.pageIndex] : undefined;
		if (!target || !page) return;
		this.commitOpen();
		const lines = segmentText(page.strokes).lines;
		const size = equationSizeNear(lines, target.x, target.y) ?? Math.max(12, this.host.pen().textSize);
		this.openEquation(page, target.pageIndex, null, { latex: "", inline: false, numbered: false, fontSize: size, color: this.host.pen().color }, target.x, target.y);
	}

	private openEquation(page: Page, pageIndex: number, element: EquationElement | null, draft: EquationDraft, x: number, y: number): void {
		this.host.deselect();
		const editor = new EquationEditor(this.host.stage, draft, {
			done: (d) => void this.finishEquation(d),
			cancel: () => this.endEquation(),
			remove: element ? () => this.removeEquation() : undefined,
		});
		this.eq = { pageId: page.id, element, x, y, editor };
		this.place();
		editor.focus();
		this.host.refresh();
	}

	private editEquation(pageIndex: number, el: EquationElement): void {
		const page = this.host.doc()?.pages[pageIndex];
		if (!page) return;
		this.openEquation(page, pageIndex, el, { latex: el.latex, inline: !!el.inline, numbered: !!el.numbered, fontSize: el.fontSize, color: el.color }, el.x, el.y);
	}

	/** Keeps the open editor or panel next to what it edits after a scroll or zoom. */
	place(): void {
		const s = this.eq;
		if (!s) return;
		const doc = this.host.doc();
		const pageIndex = doc?.pages.findIndex((p) => p.id === s.pageId) ?? -1;
		const h = s.element?.height ?? 24;
		const at = pageIndex >= 0 ? this.host.toStage(pageIndex, s.x, s.y + h) : null;
		if (at) s.editor.place(at[0], at[1] + 8);
	}

	private endEquation(): void {
		const s = this.eq;
		this.eq = null;
		if (s && !s.editor.isClosed) s.editor.destroy();
		this.host.refresh();
	}

	private removeEquation(): void {
		const s = this.eq;
		this.endEquation();
		const page = s ? this.host.doc()?.pages.find((p) => p.id === s.pageId) : undefined;
		if (s?.element && page?.elements?.includes(s.element)) this.host.execute(new RemoveElement(page.id, s.element));
	}

	/** Done: typesets the source, then adds or replaces the equation (one undo step); an empty source removes it. */
	private async finishEquation(d: EquationDraft): Promise<void> {
		const s = this.eq;
		this.endEquation();
		if (!s) return;
		const latex = d.latex.replace(/\s+$/, "");
		let result: Typeset | null = null;
		if (latex.trim() !== "") {
			try {
				result = await typesetEquation(latex, d.fontSize, d.inline);
			} catch (e) {
				showNotice(e instanceof TypesetError ? t("math.eq.error", { message: e.message }) : t("math.eq.noEngine"), 8000);
				if (!(e instanceof TypesetError)) console.warn("[notebook] typesetting an equation failed", e);
			}
		}
		this.applyEquation(s, { ...d, latex }, result);
	}

	/** Builds and runs the command of an editor session; `result` null keeps the equation without a cached outline. */
	private applyEquation(s: Omit<EquationSession, "editor">, d: EquationDraft, result: Typeset | null): void {
		const doc = this.host.doc();
		const page = doc?.pages.find((p) => p.id === s.pageId);
		if (!doc || !page || !this.host.editable()) return;
		const before = s.element;
		if (before && !page.elements?.includes(before)) return;
		if (d.latex.trim() === "") {
			if (before) this.host.execute(new RemoveElement(page.id, before));
			return;
		}
		if (result) storeTypeset(typesetKey({ latex: d.latex, inline: d.inline ? true : undefined, fontSize: d.fontSize }), result);
		// Same source, style and size: the cached outline still fits (only the colour or the numbering changed).
		const sameShape = !!before && before.latex === d.latex && !!before.inline === d.inline && before.fontSize === d.fontSize;
		if (!result && sameShape && before?.outline) result = { width: before.width, height: before.height, outline: before.outline };
		const width = result?.width ?? before?.width ?? Math.max(20, d.fontSize * Math.min(40, d.latex.length) * 0.45);
		const height = result?.height ?? before?.height ?? d.fontSize * 1.4;
		const x = before ? before.x : s.x - width / 2;
		const y = before ? before.y : s.y - height / 2;
		const el = createEquation(x, y, d.latex, d.fontSize, d.color, {
			width, height, inline: d.inline, numbered: d.numbered && !d.inline, outline: result?.outline,
		});
		if (before) {
			el.id = before.id;
			const same = before.latex === el.latex && before.inline === el.inline && before.numbered === el.numbered && before.fontSize === el.fontSize
				&& before.color === el.color && before.outline === el.outline;
			if (same) return;
			this.host.execute(new ReplaceElement(page.id, before, el));
		} else this.host.execute(new AddElement(page.id, el, page.elements?.length ?? 0));
		const index = doc.pages.indexOf(page);
		const placed = page.elements?.find((e) => e.id === el.id);
		if (placed && index >= 0) this.host.select(index, [placed]);
	}

	// --- graphs ------------------------------------------------------------------------------------------------

	/** "Insert graph": a new graph centred in the view, selected, with its panel open. */
	insertGraph(): void {
		if (!this.host.editable()) return;
		const target = this.host.insertTarget();
		const doc = this.host.doc();
		const page = target ? doc?.pages[target.pageIndex] : undefined;
		if (!target || !page) return;
		this.commitOpen();
		const width = Math.min(260, page.width * 0.7);
		const height = Math.round(width * 0.66);
		const x = Math.max(0, Math.min(page.width - width, target.x - width / 2));
		const y = Math.max(0, Math.min(page.height - height, target.y - height / 2));
		const g = createGraph(x, y, width, height);
		if (!this.host.execute(new AddElement(page.id, g, page.elements?.length ?? 0))) return;
		const placed = page.elements?.find((e) => e.id === g.id);
		if (placed?.type === "graph") this.openGraph(target.pageIndex, placed);
	}

	private openGraph(pageIndex: number, g: GraphElement): void {
		const page = this.host.doc()?.pages[pageIndex];
		if (!page) return;
		this.host.deselect();
		const ink = this.host.inkFollows() ? inkOnGraph(page, g) : [];
		const panel = new GraphPanel(this.host.stage, g, {
			change: (draft) => this.previewGraph(draft),
			done: () => this.finishGraph(true),
			cancel: () => this.finishGraph(false),
		});
		this.graph = { pageId: page.id, pageIndex, before: g, ink, draft: g, panel };
		this.previewGraph(g);
		this.host.refresh();
	}

	private previewGraph(draft: GraphElement): void {
		const s = this.graph;
		if (!s) return;
		s.draft = freezeElement(draft);
		const m = graphViewMatrix(s.before, s.draft);
		this.host.renderer()?.setElementDraft({
			pageIndex: s.pageIndex, before: s.before, after: s.draft, hideStrokes: s.ink, showStrokes: s.ink.map((st) => moveStroke(st, m, s.before.id)),
		});
	}

	private finishGraph(keep: boolean): void {
		if (keep) this.graph?.panel.flush();
		const s = this.graph;
		this.graph = null;
		this.pointers.clear();
		if (!s) return;
		if (!s.panel.isClosed) s.panel.destroy();
		this.host.renderer()?.setElementDraft(null);
		const page = this.host.doc()?.pages.find((p) => p.id === s.pageId);
		if (keep && page?.elements?.includes(s.before) && JSON.stringify(s.draft) !== JSON.stringify(s.before)) {
			// The same strict check as the writer: a graph it would refuse is never committed (saves would stop).
			const problem = checkElement(s.draft, this.host.doc()?.assets ?? {});
			if (problem) {
				showNotice(t("history.refused", { message: problem }), 10000);
				this.host.refresh();
				return;
			}
			const cmd = graphEditCommand(page, s.before, s.draft, s.ink.filter((st) => page.strokes.includes(st)));
			if (cmd) this.host.execute(cmd);
		}
		this.host.refresh();
	}

	/** Pointer events inside the graph being edited belong to it (pan and zoom), not to the pen or the lasso. */
	ownsPointer(e: PointerEvent | WheelEvent): boolean {
		const s = this.graph;
		if (!s) return false;
		const p = this.host.toPage(s.pageIndex, e.clientX, e.clientY);
		const g = s.draft;
		return !!p && p[0] >= g.x && p[0] <= g.x + g.width && p[1] >= g.y && p[1] <= g.y + g.height;
	}

	private pointerDown(e: PointerEvent): void {
		if (!this.ownsPointer(e)) return;
		e.preventDefault();
		e.stopPropagation();
		this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
	}

	private pointerMove(e: PointerEvent): void {
		const s = this.graph;
		const last = this.pointers.get(e.pointerId);
		if (!s || !last) return;
		e.preventDefault();
		e.stopPropagation();
		const scale = this.host.scale();
		if (this.pointers.size === 1) {
			const view = panView(s.draft, (e.clientX - last[0]) / scale, (e.clientY - last[1]) / scale);
			this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
			s.panel.setView(view);
			return;
		}
		// Pinch: zoom by the change of the distance between the two pointers, about their midpoint.
		const others = [...this.pointers.entries()].filter(([id]) => id !== e.pointerId);
		const other = others[0]?.[1];
		if (!other) return;
		const before = Math.hypot(last[0] - other[0], last[1] - other[1]);
		const after = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
		this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
		if (before < 4 || after < 4) return;
		const mid = this.host.toPage(s.pageIndex, (e.clientX + other[0]) / 2, (e.clientY + other[1]) / 2);
		if (mid) s.panel.setView(zoomView(s.draft, after / before, mid[0], mid[1]));
	}

	private pointerUp(e: PointerEvent): void {
		if (!this.pointers.delete(e.pointerId)) return;
		e.stopPropagation();
	}

	private wheel(e: WheelEvent): void {
		const s = this.graph;
		if (!s || !this.ownsPointer(e)) return;
		e.preventDefault();
		e.stopPropagation();
		const p = this.host.toPage(s.pageIndex, e.clientX, e.clientY);
		if (p) s.panel.setView(zoomView(s.draft, Math.exp(-e.deltaY * 0.0015), p[0], p[1], e.shiftKey ? "x" : e.altKey ? "y" : "both"));
	}

	// --- selection actions ---------------------------------------------------------------------------------------

	/** The one equation or graph of the selection, if that is all it holds of them. */
	private selected(): { pageIndex: number; el: EquationElement | GraphElement } | null {
		const sel = this.host.selection();
		if (!sel) return null;
		const items = sel.elements.filter((e): e is EquationElement | GraphElement => e.type === "equation" || e.type === "graph");
		return items.length === 1 ? { pageIndex: sel.pageIndex, el: items[0]! } : null;
	}

	/** "Edit": the editor of the selected equation, or the panel of the selected graph. */
	editSelected(): void {
		const s = this.selected();
		if (!s || !this.host.editable()) return;
		this.commitOpen();
		if (s.el.type === "equation") this.editEquation(s.pageIndex, s.el);
		else this.openGraph(s.pageIndex, s.el);
	}

	/** Edits an element (a double tap on it). */
	edit(pageIndex: number, el: PageElement): boolean {
		if (!this.host.editable() || (el.type !== "equation" && el.type !== "graph")) return false;
		this.commitOpen();
		if (el.type === "equation") this.editEquation(pageIndex, el);
		else this.openGraph(pageIndex, el);
		return true;
	}

	/**
	 * "Convert to ink": every selected equation becomes strokes along its glyphs, in its colour (one undo step). An
	 * equation that has not been typeset is typeset first.
	 */
	async convertSelectedToInk(): Promise<void> {
		const sel = this.host.selection();
		const doc = this.host.doc();
		const page = sel ? doc?.pages[sel.pageIndex] : undefined;
		if (!sel || !page || !this.host.editable()) return;
		const eqs = sel.elements.filter((e): e is EquationElement => e.type === "equation" && !!page.elements?.includes(e));
		if (eqs.length === 0) return;
		// Typesetting may wait: the strokes are computed first, the command is built afterwards from the page as it is then.
		const converted: Array<{ eq: EquationElement; strokes: Stroke[] }> = [];
		let missing = 0;
		for (const eq of eqs) {
			let o = equationOutline(eq);
			if (!o) {
				try {
					storeTypeset(typesetKey(eq), await typesetEquation(eq.latex, eq.fontSize, !!eq.inline));
				} catch {
					// Counted below.
				}
				o = equationOutline(eq);
			}
			if (!o) {
				missing++;
				continue;
			}
			const scaled = formatOutline(o.polys.map((p) => p.map(([x, y]): [number, number] => [x * o.sx, y * o.sy])));
			const paths = outlineToInk(scaled, eq.width, eq.height, Math.min(8, Math.max(3, 60 / eq.fontSize)));
			if (paths.length === 0) {
				missing++;
				continue;
			}
			const strokes = paths.map((path) => {
				const points: Point[] = path.points.map(([x, y]) => quantizePoint(eq.x + x, eq.y + y, 0.5));
				return freezeStroke(createStroke(eq.color, path.width, points, "shape"));
			});
			converted.push({ eq, strokes });
		}
		// The document, the page and each equation must still be there (undo, sync or another edit may have run meanwhile).
		if (!this.host.editable() || !this.host.doc()?.pages.includes(page)) return;
		const commands: Command[] = [];
		let count = 0;
		const base = page.strokes.length;
		for (const { eq, strokes } of converted) {
			if (!page.elements?.includes(eq)) {
				missing++;
				continue;
			}
			commands.push(new RemoveElement(page.id, eq));
			for (const stroke of strokes) commands.push(new AddStroke(page.id, stroke, base + count++));
		}
		if (commands.length > 0) this.host.execute(new Batch("Convert equation to ink", commands));
		if (missing > 0) showNotice(t("math.convert.failed"), 6000);
		else if (count > 0) showNotice(t("math.convert.done", { count: String(count) }), 3000);
	}

	// --- life cycle --------------------------------------------------------------------------------------------

	/**
	 * Commits what is open (saving, closing the view, another tool or command): the graph draft as one undo step, the
	 * equation with the source as it is (typeset later if needed). Synchronous, so a flush right after writes it.
	 */
	commitOpen(): void {
		if (this.graph) this.finishGraph(true);
		const s = this.eq;
		if (s) {
			const d = s.editor.current();
			this.endEquation();
			this.applyEquation(s, { ...d, latex: d.latex.replace(/\s+$/, "") }, null);
		}
	}

	destroy(): void {
		this.commitOpen();
		this.destroyed = true;
		setTypesetRequest(null);
		this.host.stage.removeEventListener("pointerdown", this.onDown, true);
		this.host.stage.removeEventListener("wheel", this.onWheel, true);
		window.removeEventListener("pointermove", this.onMove, true);
		window.removeEventListener("pointerup", this.onUp, true);
		window.removeEventListener("pointercancel", this.onUp, true);
	}
}
