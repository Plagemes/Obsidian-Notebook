import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import type { MeasureText } from "../ink/elements";
import type { PageBox } from "../ink/layout";
import { analyseLines, dropIndex, lineMoveCommand, planLineMove, type LineModel, type LineMoveResult, type LineRefusal } from "../ink/line-reorder";
import type { Viewport } from "../ink/viewport";
import type { Command } from "../model/history";
import type { NotebookDocument } from "../model/types";
import { attachLongPressHelp } from "../ui/long-press-help";

/**
 * 0.28 (#256): "Reorder lines". A small handle at the left of every handwritten line of the page in view; dragging a handle moves the
 * whole line between the others (the lines in between shift to make room, the planner is ink/line-reorder.ts), and the up and down
 * buttons of the bar do the same one place at a time. The handles are DOM elements over the canvas (like the margin comment
 * markers): they let every pointer event through except their own, which they keep from the pen input below. While a handle is
 * dragged only outlines move (the ink is untouched until the drop); the drop is ONE undo step through the view's history, which also
 * refuses it on a locked page. Nothing is written to the notebook by turning the mode on or off.
 */
export interface LineHandleHost {
	/** The page area: the bar floats over it. */
	body: HTMLElement;
	doc(): NotebookDocument | null;
	/** The document can be edited now (not read-only, not loading). */
	editable(): boolean;
	/** Runs a command as one undo step (false when it was refused). */
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

interface Mark {
	band: HTMLElement;
	handle: HTMLButtonElement;
}

interface Drag {
	id: number;
	from: number;
	startY: number;
	moved: boolean;
	/** The move the pointer is at now. */
	result: LineMoveResult | null;
}

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
	private pageIndex = -1;
	private chosen = -1;
	private drag: Drag | null = null;

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
		const page = this.currentModel();
		if (!page || page.lines.length === 0) this.host.notify(t("linehandle.none"));
	}

	stop(): void {
		if (!this.on) return;
		this.on = false;
		this.drag = null;
		this.chosen = -1;
		this.stopKeys();
		this.draw();
		this.host.refreshUi();
	}

	// --- the model ----------------------------------------------------------------------------------------------------

	private stamp(o: object): number {
		let n = this.stamps.get(o);
		if (n === undefined) {
			n = this.nextStamp++;
			this.stamps.set(o, n);
		}
		return n;
	}

	/** The lines of the page in view; analysed again only when the page changed (strokes and elements are replaced, never edited in place). */
	private currentModel(): LineModel | null {
		const doc = this.host.doc();
		const index = this.drag ? this.pageIndex : this.host.currentPage();
		const page = doc?.pages[index];
		if (!doc || !page) {
			this.model = null;
			return null;
		}
		let sig = `${page.id}|${page.locked === true ? 1 : 0}|${page.strokes.length}|${page.elements?.length ?? 0}`;
		let acc = 0;
		for (const s of page.strokes) acc = (acc * 31 + this.stamp(s)) | 0;
		for (const e of page.elements ?? []) acc = (acc * 31 + this.stamp(e)) | 0;
		sig += `|${acc}`;
		if (sig !== this.signature || index !== this.pageIndex || !this.model) {
			if (index !== this.pageIndex) this.chosen = -1;
			this.pageIndex = index;
			this.signature = sig;
			this.model = analyseLines(page, this.host.measure);
		}
		return this.model;
	}

	// --- drawing the handles ------------------------------------------------------------------------------------------

	/** Places every handle and outline. Cheap: elements are reused, only style variables change. */
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
		const result = this.drag?.result ?? null;
		const shifts = result && result.ok ? result.shifts : null;
		while (this.marks.length > model.lines.length) {
			const m = this.marks.pop()!;
			m.band.remove();
			m.handle.remove();
		}
		model.lines.forEach((line, i) => {
			const m = this.marks[i] ?? this.makeMark(i);
			const blocked = model.locked || line.blocked !== null;
			const y = top + line.box.minY * scale;
			const h = (line.box.maxY - line.box.minY) * scale;
			const x = left + line.box.minX * scale;
			const w = (line.box.maxX - line.box.minX) * scale;
			const visible = y + h >= 0 && y <= stageH;
			const dragging = this.drag?.from === i && this.drag.moved;
			let dy = 0;
			if (this.drag?.moved) dy = dragging ? this.dragDy() : (shifts?.[i] ?? 0) * scale;
			const hh = Math.min(HANDLE_MAX_H, Math.max(HANDLE_MIN_H, h));
			// The handle sits in the left margin of the page (the page's left edge when the line starts far in), never outside the stage.
			const hx = Math.max(2, Math.min(left + 4, x - HANDLE_W - 6));
			m.band.setCssProps({ "--nb-lh-x": `${x - 4}px`, "--nb-lh-y": `${y - 3}px`, "--nb-lh-w": `${w + 8}px`, "--nb-lh-h": `${h + 6}px`, "--nb-lh-dy": `${dy}px` });
			m.handle.setCssProps({ "--nb-lh-x": `${hx}px`, "--nb-lh-y": `${y + h / 2 - hh / 2}px`, "--nb-lh-hh": `${hh}px`, "--nb-lh-dy": `${dy}px` });
			for (const el of [m.band, m.handle]) {
				el.toggleClass("notebook-hidden", !visible);
				el.toggleClass("is-chosen", this.chosen === i);
				el.toggleClass("is-blocked", blocked);
				el.toggleClass("is-dragging", dragging);
				el.toggleClass("is-refused", dragging && result !== null && !result.ok && result.reason !== "same");
				el.toggleClass("is-shifting", !dragging && dy !== 0);
			}
			m.handle.setAttribute("aria-pressed", String(this.chosen === i));
			const label = t("linehandle.handle", { n: String(i + 1), total: String(model.lines.length) });
			const reason = blocked ? refusalText(model.locked ? "page-locked" : line.blocked!) : "";
			const full = reason ? `${label}. ${reason}` : label;
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
			"--nb-lh-x": `${offsetX + (box.x + line.box.minX) * scale - 4}px`, "--nb-lh-y": `${offsetY + (box.y + line.box.minY + dy) * scale - 3}px`,
			"--nb-lh-w": `${(line.box.maxX - line.box.minX) * scale + 8}px`, "--nb-lh-h": `${(line.box.maxY - line.box.minY) * scale + 6}px`,
		});
		this.slot.toggleClass("notebook-hidden", false);
	}

	/** How far (px) the dragged handle is from where the contact began. */
	private dragDy(): number {
		const drag = this.drag;
		return !drag || this.lastClientY === null ? 0 : this.lastClientY - drag.startY;
	}

	private lastClientY: number | null = null;

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
		const m = { band, handle };
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
		const model = this.model;
		if (!model) return;
		this.chosen = this.chosen === i ? -1 : i;
		if (this.chosen >= 0) {
			const line = model.lines[i];
			const reason = model.locked ? "page-locked" : line?.blocked;
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

	/** Runs the move of line `from` to place `to`; says why when it is refused. */
	private apply(model: LineModel, from: number, to: number): boolean {
		const doc = this.host.doc();
		const page = doc?.pages[this.pageIndex];
		if (!page) return false;
		if (!this.host.editable()) {
			this.host.notify(t("linehandle.refused.readOnly"));
			return false;
		}
		const result = planLineMove(model, from, to);
		if (!result.ok) {
			if (result.reason !== "same" && result.reason !== "range") this.host.notify(refusalText(result.reason));
			return false;
		}
		const plan = lineMoveCommand(page, model, result, this.host.measure);
		if (!plan) return false;
		const done = this.host.execute(plan.command);
		if (!done) {
			// The history refused it (a locked page, a change the writer would reject): the document is as it was.
			this.host.notify(refusalText("page-locked") || t("linehandle.refused.pageLocked"));
			return false;
		}
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
		this.drag = { id: e.pointerId, from: i, startY: e.clientY, moved: false, result: null };
		this.lastClientY = e.clientY;
		try {
			handle.setPointerCapture(e.pointerId);
		} catch {
			// a pointer that is no longer active (a synthetic event): the drag goes on without capture
		}
	}

	private move(e: PointerEvent): void {
		const drag = this.drag;
		const model = this.model;
		const geometry = this.host.geometry();
		if (!drag || e.pointerId !== drag.id || !model || !geometry) return;
		e.preventDefault();
		e.stopPropagation();
		this.lastClientY = e.clientY;
		if (!drag.moved && Math.abs(e.clientY - drag.startY) < TAP_SLOP) return;
		drag.moved = true;
		const scale = geometry.viewport.scale;
		const line = model.lines[drag.from]!;
		const mid = (line.box.minY + line.box.maxY) / 2 + (e.clientY - drag.startY) / scale;
		const to = dropIndex(model, drag.from, mid);
		drag.result = planLineMove(model, drag.from, to);
		this.draw();
	}

	private end(e: PointerEvent, cancelled: boolean): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.id) return;
		e.preventDefault();
		e.stopPropagation();
		const model = this.model;
		this.drag = null;
		this.lastClientY = null;
		if (cancelled || !model) {
			this.draw();
			return;
		}
		if (!drag.moved) {
			this.choose(drag.from);
			return;
		}
		const result = drag.result;
		this.draw();
		if (result?.ok) this.apply(model, result.from, result.to);
		else if (result && result.reason !== "same") this.host.notify(refusalText(result.reason));
	}

	// --- the keyboard -------------------------------------------------------------------------------------------------

	private keyOff: (() => void) | null = null;

	private startKeys(): void {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape" || !this.on) return;
			e.preventDefault();
			e.stopPropagation();
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
