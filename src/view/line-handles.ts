import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import type { MeasureText } from "../ink/elements";
import type { PageBox } from "../ink/layout";
import { analyseLines, dropIndex, lineMoveCommand, pageSignature, planLineMove, type LineModel, type LineMoveResult, type LineRefusal } from "../ink/line-reorder";
import type { Viewport } from "../ink/viewport";
import type { Command } from "../model/history";
import type { NotebookDocument, Page } from "../model/types";
import { attachLongPressHelp } from "../ui/long-press-help";

/**
 * 0.28 (#256): "Reorder lines". A small handle at the left of every handwritten line of the page in view; dragging a handle moves the
 * whole line between the others (the lines in between shift to make room, the planner is ink/line-reorder.ts), and the up and down
 * buttons of the bar do the same one place at a time. The handles are DOM elements over the canvas (like the margin comment
 * markers): they let every pointer event through except their own, which they keep from the pen input below. While a handle is
 * dragged only outlines move (the ink is untouched until the drop); the drop is ONE undo step through the view's history, which also
 * refuses it on a locked page. Nothing is written to the notebook by turning the mode on or off.
 *
 * A drag belongs to the page and to the state of the page it began on: if the page changed meanwhile (undo, a sync, a reload, a
 * comment, a lock) the drag is cancelled with a notice, and a drop is made from the model the drag began with, on that page, before
 * anything is redrawn. The plan of a drag is made once per animation frame, and only the handles in view are touched.
 */
export interface LineHandleHost {
	/** The page area: the bar floats over it. */
	body: HTMLElement;
	doc(): NotebookDocument | null;
	/** The document can be edited now (not read-only, not loading). */
	editable(): boolean;
	/** Runs a command as one undo step (false when it was refused; the view says why itself). */
	execute(cmd: Command): boolean;
	geometry(): { stage: HTMLElement; viewport: Viewport; boxes: readonly PageBox[] } | null;
	/** Registers a function called after every viewport, layout or history change; returns the function that removes it. */
	addOverlayListener(fn: () => void): () => void;
	/** The page the handles are for: the one in view (in a two-page spread, the one the page actions use). */
	currentPage(): number;
	measure: MeasureText;
	notify(message: string): void;
	/** The contextual bar and the sheets are redrawn (the mode is a toggle of the All actions sheet). */
	refreshUi(): void;
}

/** The message that says why a move is refused. */
export function refusalText(reason: LineRefusal): string {
	switch (reason) {
		case "page-locked": return t("linehandle.refused.pageLocked");
		case "background": return t("linehandle.refused.background");
		case "locked": return t("linehandle.refused.locked");
		case "busy": return t("linehandle.refused.busy");
		case "group": return t("linehandle.refused.group");
		case "conflict": return t("linehandle.refused.conflict");
		case "crowded": return t("linehandle.refused.crowded");
		case "edge": return t("linehandle.refused.edge");
		default: return "";
	}
}

/** Events a handle or the bar keeps from the pen input below it. */
const ISOLATED = ["pointerdown", "pointerup", "touchstart", "mousedown", "contextmenu"] as const;
/** A contact that moved less than this many px is a tap (it chooses the line, it does not drag it). */
const TAP_SLOP = 5;
const HANDLE_W = 32;
const HANDLE_MIN_H = 32;
const HANDLE_MAX_H = 48;
/** Lines this many px beyond the stage are not touched (they are hidden once). */
const CULL_MARGIN = 160;

interface Mark {
	band: HTMLElement;
	handle: HTMLButtonElement;
	/** What was last written to it (nothing is written again when it is the same). */
	key: string;
	hidden: boolean;
}

interface Drag {
	id: number;
	from: number;
	/** The page the drag began on, and what the page was like then: a drop is made only on the same page in the same state. */
	pageId: string;
	signature: string;
	model: LineModel;
	startY: number;
	moved: boolean;
	/** The move the pointer is at now. */
	result: LineMoveResult | null;
}

const px = (n: number): string => `${Math.round(n * 10) / 10}px`;

export class LineHandleTools {
	private readonly root: HTMLElement;
	private readonly slot: HTMLElement;
	private readonly bar: HTMLElement;
	private readonly up: HTMLButtonElement;
	private readonly down: HTMLButtonElement;
	private readonly marks: Mark[] = [];
	private readonly stamps = new WeakMap<object, number>();
	private nextStamp = 1;
	private readonly off: () => void;
	private readonly stopHelp: Array<() => void> = [];
	private on = false;
	private model: LineModel | null = null;
	private signature = "";
	private pageId = "";
	private pageIndex = -1;
	private chosen = -1;
	private drag: Drag | null = null;
	private lastClientY: number | null = null;
	private frame = 0;
	private keyOff: (() => void) | null = null;

	constructor(private readonly host: LineHandleHost) {
		this.root = createDiv({ cls: "nb-ui nb-lh-layer notebook-hidden" });
		this.slot = this.root.createDiv({ cls: "nb-lh-slot notebook-hidden", attr: { "aria-hidden": "true" } });
		this.bar = createDiv({ cls: "nb-ui nb-lh-bar notebook-hidden", attr: { role: "toolbar", "aria-label": t("linehandle.action"), "data-key": "line-handle-bar" } });
		setIcon(this.bar.createSpan({ cls: "nb-lh-bar-icon", attr: { "aria-hidden": "true" } }), "grip-vertical");
		this.bar.createSpan({ cls: "nb-lh-bar-hint", text: t("linehandle.hint") });
		this.up = this.button("chevron-up", "linehandle.up", "help.lineUp", "line-handle-up");
		this.down = this.button("chevron-down", "linehandle.down", "help.lineDown", "line-handle-down");
		const done = this.bar.createEl("button", { cls: "nb-lh-done", text: t("linehandle.done"), attr: { type: "button", "data-key": "line-handle-done", "data-help": "help.lineDone" } });
		this.up.addEventListener("click", (e) => this.step(e, -1));
		this.down.addEventListener("click", (e) => this.step(e, 1));
		done.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.stop();
		});
		for (const type of ISOLATED) this.bar.addEventListener(type, (e) => e.stopPropagation());
		this.stopHelp.push(attachLongPressHelp(this.bar), attachLongPressHelp(this.root));
		this.off = host.addOverlayListener(() => this.draw());
	}

	destroy(): void {
		this.off();
		this.cancelFrame();
		for (const stop of this.stopHelp) stop();
		this.stopKeys();
		this.root.remove();
		this.bar.remove();
		this.marks.length = 0;
	}

	/** The mode is on (the registry reads it for the toggle's state). */
	get active(): boolean {
		return this.on;
	}

	toggle(): void {
		if (this.on) this.stop();
		else this.start();
	}

	start(): void {
		if (this.on) return;
		if (!this.host.editable()) {
			this.host.notify(t("linehandle.refused.readOnly"));
			return;
		}
		this.on = true;
		this.chosen = -1;
		this.startKeys();
		this.draw();
		this.host.refreshUi();
		const model = this.currentModel();
		if (!model || model.lines.length === 0) this.host.notify(t("linehandle.none"));
	}

	stop(): void {
		if (!this.on) return;
		this.on = false;
		this.drag = null;
		this.lastClientY = null;
		this.cancelFrame();
		this.chosen = -1;
		this.model = null;
		this.signature = "";
		this.pageId = "";
		this.stopKeys();
		this.draw();
		this.host.refreshUi();
	}

	// --- the model ----------------------------------------------------------------------------------------------------

	private stamp = (o: object): number => {
		let n = this.stamps.get(o);
		if (n === undefined) {
			n = this.nextStamp++;
			this.stamps.set(o, n);
		}
		return n;
	};

	/** The page `id` of the open document, with its index. */
	private pageById(id: string): { page: Page; index: number } | null {
		const pages = this.host.doc()?.pages;
		const index = pages ? pages.findIndex((p) => p.id === id) : -1;
		return pages && index >= 0 ? { page: pages[index]!, index } : null;
	}

	/** The page the lines are for: the one a drag began on while there is a drag, else the one in view. */
	private target(): { page: Page; index: number } | null {
		if (this.drag) return this.pageById(this.drag.pageId);
		const index = this.host.currentPage();
		const page = this.host.doc()?.pages[index];
		return page ? { page, index } : null;
	}

	/** The lines of the page; analysed again only when the page changed. A drag whose page changed is cancelled. */
	private currentModel(): LineModel | null {
		const found = this.target();
		if (!found) {
			if (this.drag) this.lose();
			this.model = null;
			return null;
		}
		const { page, index } = found;
		const sig = pageSignature(page, this.stamp);
		if (sig !== this.signature || page.id !== this.pageId || !this.model) {
			if (page.id !== this.pageId) this.chosen = -1;
			this.pageId = page.id;
			this.signature = sig;
			this.model = analyseLines(page, this.host.measure);
		}
		this.pageIndex = index;
		if (this.drag && sig !== this.drag.signature) this.lose();
		return this.model;
	}

	/** The drag is over without a drop (the page changed under it): nothing was written. */
	private lose(): void {
		this.drag = null;
		this.lastClientY = null;
		this.cancelFrame();
		this.host.notify(t("linehandle.cancelled"));
	}

	private cancelFrame(): void {
		if (this.frame) window.cancelAnimationFrame(this.frame);
		this.frame = 0;
	}

	// --- drawing the handles ------------------------------------------------------------------------------------------

	/** Places the handles and outlines in view. Cheap: elements are reused, only what changed is written, lines out of view are hidden once. */
	draw(): void {
		const geometry = this.host.geometry();
		if (!this.on || !geometry) {
			this.root.toggleClass("notebook-hidden", true);
			this.bar.toggleClass("notebook-hidden", true);
			return;
		}
		if (this.root.parentElement !== geometry.stage) geometry.stage.appendChild(this.root);
		if (this.bar.parentElement !== this.host.body) this.host.body.appendChild(this.bar);
		const model = this.currentModel();
		const box = geometry.boxes[this.pageIndex];
		this.bar.toggleClass("notebook-hidden", false);
		if (!model || !box) {
			this.root.toggleClass("notebook-hidden", true);
			this.updateButtons(null);
			return;
		}
		this.root.toggleClass("notebook-hidden", false);
		const { scale, offsetX, offsetY } = geometry.viewport;
		const stageH = geometry.stage.clientHeight;
		const left = offsetX + box.x * scale;
		const top = offsetY + box.y * scale;
		const drag = this.drag;
		const result = drag?.result ?? null;
		const shifts = result && result.ok ? result.shifts : null;
		const refusedAll = model.locked ? "page-locked" : model.background ? "background" : null;
		while (this.marks.length > model.lines.length) {
			const m = this.marks.pop()!;
			m.band.remove();
			m.handle.remove();
		}
		model.lines.forEach((line, i) => {
			const y = top + line.box.minY * scale;
			const h = (line.box.maxY - line.box.minY) * scale;
			const visible = y + h >= -CULL_MARGIN && y <= stageH + CULL_MARGIN;
			const existing = this.marks[i];
			if (!visible) {
				if (existing && !existing.hidden) {
					existing.hidden = true;
					existing.key = "";
					existing.band.toggleClass("notebook-hidden", true);
					existing.handle.toggleClass("notebook-hidden", true);
				}
				return;
			}
			const m = existing ?? this.makeMark(i);
			const reason = refusedAll ?? line.blocked;
			const dragging = drag?.from === i && drag.moved;
			let dy = 0;
			if (drag?.moved) dy = dragging ? this.dragDy() : (shifts?.[i] ?? 0) * scale;
			const refused = dragging && result !== null && !result.ok && result.reason !== "same";
			const x = left + line.box.minX * scale;
			const w = (line.box.maxX - line.box.minX) * scale;
			const hh = Math.min(HANDLE_MAX_H, Math.max(HANDLE_MIN_H, h));
			// The handle sits in the left margin of the page (the page's left edge when the line starts far in), never outside the stage.
			const hx = Math.max(2, Math.min(left + 4, x - HANDLE_W - 6));
			const flags = `${this.chosen === i ? "c" : ""}${reason ? "b" : ""}${dragging ? "d" : ""}${refused ? "r" : ""}${!dragging && dy !== 0 ? "s" : ""}`;
			const label = t("linehandle.handle", { n: String(i + 1), total: String(model.lines.length) });
			const full = reason ? `${label}. ${refusalText(reason)}` : label;
			const key = [px(x), px(y), px(w), px(h), px(hx), px(hh), px(dy), flags, full].join("|");
			if (key === m.key && !m.hidden) return;
			m.key = key;
			if (m.hidden) {
				m.hidden = false;
				m.band.toggleClass("notebook-hidden", false);
				m.handle.toggleClass("notebook-hidden", false);
			}
			m.band.setCssProps({ "--nb-lh-x": px(x - 4), "--nb-lh-y": px(y - 3), "--nb-lh-w": px(w + 8), "--nb-lh-h": px(h + 6), "--nb-lh-dy": px(dy) });
			m.handle.setCssProps({ "--nb-lh-x": px(hx), "--nb-lh-y": px(y + h / 2 - hh / 2), "--nb-lh-hh": px(hh), "--nb-lh-dy": px(dy) });
			for (const el of [m.band, m.handle]) {
				el.toggleClass("is-chosen", this.chosen === i);
				el.toggleClass("is-blocked", !!reason);
				el.toggleClass("is-dragging", dragging);
				el.toggleClass("is-refused", refused);
				el.toggleClass("is-shifting", !dragging && dy !== 0);
			}
			m.handle.setAttribute("aria-pressed", String(this.chosen === i));
			if (m.handle.getAttribute("aria-label") !== full) {
				m.handle.setAttribute("aria-label", full);
				m.handle.setAttribute("title", full);
			}
		});
		this.drawSlot(model, geometry.viewport, box, result);
		this.updateButtons(model);
	}

	/** The outline where the dragged line would land. */
	private drawSlot(model: LineModel, viewport: Viewport, box: PageBox, result: LineMoveResult | null): void {
		const drag = this.drag;
		if (!drag?.moved || !result || !result.ok) {
			this.slot.toggleClass("notebook-hidden", true);
			return;
		}
		const line = model.lines[drag.from]!;
		const { scale, offsetX, offsetY } = viewport;
		const dy = result.shifts[drag.from] ?? 0;
		this.slot.setCssProps({
			"--nb-lh-x": px(offsetX + (box.x + line.box.minX) * scale - 4), "--nb-lh-y": px(offsetY + (box.y + line.box.minY + dy) * scale - 3),
			"--nb-lh-w": px((line.box.maxX - line.box.minX) * scale + 8), "--nb-lh-h": px((line.box.maxY - line.box.minY) * scale + 6),
		});
		this.slot.toggleClass("notebook-hidden", false);
	}

	/** How far (px) the dragged handle is from where the contact began. */
	private dragDy(): number {
		const drag = this.drag;
		return !drag || this.lastClientY === null ? 0 : this.lastClientY - drag.startY;
	}

	private makeMark(i: number): Mark {
		const band = this.root.createDiv({ cls: "nb-lh-band" });
		const handle = this.root.createEl("button", { cls: "nb-lh-handle", attr: { type: "button", "data-key": `line-handle:${i}`, "data-help": "help.lineHandle" } });
		setIcon(handle.createSpan({ cls: "nb-lh-grip", attr: { "aria-hidden": "true" } }), "grip-vertical");
		for (const type of ISOLATED) handle.addEventListener(type, (e) => e.stopPropagation());
		handle.addEventListener("pointerdown", (e) => this.begin(e, i, handle));
		handle.addEventListener("pointermove", (e) => this.move(e));
		handle.addEventListener("pointerup", (e) => this.end(e, false));
		handle.addEventListener("pointercancel", (e) => this.end(e, true));
		// Keyboard: Enter or Space chooses the line, Arrow up and down move the chosen one.
		handle.addEventListener("keydown", (e) => {
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault();
				e.stopPropagation();
				this.chosen = i;
				this.moveBy(e.key === "ArrowUp" ? -1 : 1);
			} else if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				e.stopPropagation();
				this.choose(i);
			}
		});
		const m: Mark = { band, handle, key: "", hidden: false };
		this.marks[i] = m;
		return m;
	}

	private updateButtons(model: LineModel | null): void {
		const n = model?.lines.length ?? 0;
		this.up.disabled = this.chosen <= 0 || this.chosen >= n;
		this.down.disabled = this.chosen < 0 || this.chosen >= n - 1;
	}

	private button(icon: string, label: MessageKey, help: MessageKey, key: string): HTMLButtonElement {
		const b = this.bar.createEl("button", { cls: "nb-lh-step", attr: { type: "button", "aria-label": t(label), title: t(label), "data-key": key, "data-help": help } });
		setIcon(b, icon);
		return b;
	}

	// --- choosing and moving ------------------------------------------------------------------------------------------

	private choose(i: number): void {
		const model = this.currentModel();
		if (!model) return;
		this.chosen = this.chosen === i ? -1 : i;
		if (this.chosen >= 0) {
			const reason = model.locked ? "page-locked" : model.background ? "background" : model.lines[i]?.blocked;
			if (reason) this.host.notify(refusalText(reason));
		}
		this.draw();
	}

	private step(e: Event, by: -1 | 1): void {
		e.preventDefault();
		e.stopPropagation();
		this.moveBy(by);
	}

	/** The chosen line one place up or down. */
	private moveBy(by: -1 | 1): void {
		const model = this.currentModel();
		if (!model || this.chosen < 0) return;
		this.apply(model, this.chosen, this.chosen + by);
	}

	/** Runs the move of line `from` to place `to` of `model` on the page the model is of; says why when it is refused. */
	private apply(model: LineModel, from: number, to: number): boolean {
		const found = this.pageById(model.pageId);
		if (!found) return false;
		if (!this.host.editable()) {
			this.host.notify(t("linehandle.refused.readOnly"));
			return false;
		}
		const result = planLineMove(model, from, to);
		if (!result.ok) {
			if (result.reason !== "same" && result.reason !== "range") this.host.notify(refusalText(result.reason));
			return false;
		}
		const plan = lineMoveCommand(found.page, model, result, this.host.measure);
		if (!plan) return false;
		// Refused by the history (a locked page, a change the writer would reject): the view says why itself, the document is as it was.
		if (!this.host.execute(plan.command)) return false;
		this.chosen = to;
		this.signature = "";
		this.draw();
		this.host.notify(t("linehandle.moved", { n: String(to + 1) }));
		return true;
	}

	// --- dragging a handle --------------------------------------------------------------------------------------------

	private begin(e: PointerEvent, i: number, handle: HTMLElement): void {
		if (this.drag || (e.pointerType === "mouse" && e.button !== 0)) return;
		const model = this.currentModel();
		if (!model) return;
		e.preventDefault();
		this.drag = { id: e.pointerId, from: i, pageId: model.pageId, signature: this.signature, model, startY: e.clientY, moved: false, result: null };
		this.lastClientY = e.clientY;
		try {
			handle.setPointerCapture(e.pointerId);
		} catch {
			// a pointer that is no longer active (a synthetic event): the drag goes on without capture
		}
	}

	/** The move a contact at `clientY` stands for. */
	private resultAt(drag: Drag, clientY: number): LineMoveResult | null {
		const geometry = this.host.geometry();
		const line = drag.model.lines[drag.from];
		if (!geometry || !line) return null;
		const mid = (line.box.minY + line.box.maxY) / 2 + (clientY - drag.startY) / geometry.viewport.scale;
		return planLineMove(drag.model, drag.from, dropIndex(drag.model, drag.from, mid));
	}

	private move(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.id) return;
		e.preventDefault();
		e.stopPropagation();
		this.lastClientY = e.clientY;
		if (!drag.moved && Math.abs(e.clientY - drag.startY) < TAP_SLOP) return;
		drag.moved = true;
		// Pens report far more often than the screen is drawn: the plan and the outlines are made once per frame, from the latest point.
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = 0;
			const d = this.drag;
			if (!d || this.lastClientY === null) return;
			d.result = this.resultAt(d, this.lastClientY);
			this.draw();
		});
	}

	private end(e: PointerEvent, cancelled: boolean): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.id) return;
		e.preventDefault();
		e.stopPropagation();
		this.cancelFrame();
		// The drop is made from the model the drag began with, on its page, before anything is redrawn.
		const found = this.pageById(drag.pageId);
		const same = !!found && pageSignature(found.page, this.stamp) === drag.signature;
		this.drag = null;
		this.lastClientY = null;
		if (cancelled) {
			this.draw();
			return;
		}
		if (!same) {
			this.host.notify(t("linehandle.cancelled"));
			this.draw();
			return;
		}
		if (!drag.moved) {
			this.choose(drag.from);
			return;
		}
		const result = this.resultAt(drag, e.clientY);
		if (result?.ok) {
			if (!this.apply(drag.model, result.from, result.to)) this.draw();
			return;
		}
		this.draw();
		if (result && result.reason !== "same") this.host.notify(refusalText(result.reason));
	}

	// --- the keyboard -------------------------------------------------------------------------------------------------

	private startKeys(): void {
		const onKey = (ev: KeyboardEvent): void => {
			if (ev.key !== "Escape" || !this.on) return;
			ev.preventDefault();
			ev.stopPropagation();
			this.stop();
		};
		activeDocument.addEventListener("keydown", onKey, true);
		this.keyOff = () => activeDocument.removeEventListener("keydown", onKey, true);
	}

	private stopKeys(): void {
		this.keyOff?.();
		this.keyOff = null;
	}
}
