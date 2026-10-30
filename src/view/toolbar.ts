import { setIcon } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { ERASE_FILTER_KINDS, type EraseFilterKind } from "../ink/erase-filter";
import { DEFAULT_ERASER_SIZE } from "./favourites";
import { SHAPE_KINDS, type ShapeKind } from "./view-helpers";

export type ToolName = "pen" | "highlighter" | "eraser" | "lasso" | "shape" | "text" | "space";
export type EraserMode = "stroke" | "segment" | "area";

export const PEN_COLORS = ["#1e1e1e", "#6b7280", "#1d4ed8", "#0891b2", "#15803d", "#ca8a04", "#ea580c", "#dc2626", "#9333ea"] as const;
export const HIGHLIGHTER_COLORS = ["#facc15", "#4ade80", "#f472b6", "#60a5fa", "#fb923c"] as const;
export const PEN_WIDTHS = [0.8, 1.2, 2, 3.2, 5] as const;
export const HIGHLIGHTER_WIDTHS = [8, 14, 20] as const;
/** Font sizes of new text boxes, pt. */
export const TEXT_SIZES = [10, 14, 20, 28] as const;

export interface ToolbarState {
	tool: ToolName;
	penColor: string;
	penWidth: number;
	highlighterColor: string;
	highlighterWidth: number;
	eraserMode: EraserMode;
	/** Selective eraser: which ink the eraser may touch (all ink, only highlighter, only pen, one colour). */
	eraserFilter: EraseFilterKind;
	/** The colour the eraser is limited to when `eraserFilter` is "color". */
	eraserColor: string;
	/** Eraser radius, CSS px (segment and whole-stroke eraser). */
	eraserSize: number;
	shapeKind: ShapeKind;
	/** Font size of new text boxes, pt. */
	textSize: number;
	/** The ruler is shown and pen strokes near its edge snap to it. */
	ruler: boolean;
}

export const DEFAULT_TOOLS: ToolbarState = {
	tool: "pen",
	penColor: PEN_COLORS[0],
	penWidth: PEN_WIDTHS[2],
	highlighterColor: HIGHLIGHTER_COLORS[0],
	highlighterWidth: HIGHLIGHTER_WIDTHS[1],
	eraserMode: "stroke",
	eraserFilter: "all",
	eraserColor: PEN_COLORS[0],
	eraserSize: DEFAULT_ERASER_SIZE,
	shapeKind: "line",
	textSize: TEXT_SIZES[1],
	ruler: false,
};

export interface ToolbarActions {
	change(state: ToolbarState): void;
	undo(): void;
	redo(): void;
	addPage(): void;
	exercisePage(): void;
	pageMenu(evt: MouseEvent): void;
	deleteSelection(): void;
	fit(): void;
	toggleNavigator(): void;
	insertImage(): void;
	boardShot(): void;
	stamps(): void;
}

const TOOL_DEFS: Array<[ToolName, string, MessageKey]> = [
	["pen", "pencil", "tool.pen"],
	["highlighter", "highlighter", "tool.highlighter"],
	["eraser", "eraser", "tool.eraser"],
	["lasso", "lasso", "tool.lasso"],
	["shape", "shapes", "tool.shape"],
	["text", "type", "tool.text"],
	["space", "move-vertical", "tool.space"],
];

const FILTER_LABELS: Record<EraseFilterKind, MessageKey> = {
	all: "tool.eraser.filter.all",
	highlighter: "tool.eraser.filter.highlighter",
	pen: "tool.eraser.filter.pen",
	color: "tool.eraser.filter.color",
};

/** Swatches offered when the eraser is limited to one colour: every ink colour of the toolbar. */
const ERASER_COLORS = [...PEN_COLORS, ...HIGHLIGHTER_COLORS] as const;

const SHAPE_DEFS: Record<ShapeKind, [string, MessageKey]> = {
	line: ["minus", "shape.line"],
	arrow: ["arrow-up-right", "shape.arrow"],
	rectangle: ["square", "shape.rectangle"],
	ellipse: ["circle", "shape.ellipse"],
};


/** Tools that have options (colour, width, eraser mode, …): tapping the active tool again opens them. */
const TOOLS_WITH_OPTIONS: ReadonlySet<ToolName> = new Set<ToolName>(["pen", "highlighter", "eraser", "shape", "text"]);

type PopoverKind = "options" | "more";

/** Diameter of the pen dot in the current-pen indicator, CSS px (same scale as the favourite pens). */
function chipDiameter(width: number): number {
	return Math.round(Math.min(18, 6 + Math.sqrt(width) * 3));
}

/**
 * The toolbar: two rows (tools; history, current pen, favourite pens, page, status, more) that share one line on a wide
 * view and stack on a phone. Tool options (colours, widths, eraser mode, filter, size) live in a popover that opens
 * when the active tool is tapped again (or from the current-pen indicator); the less used actions are in a "more" menu.
 */
export class Toolbar {
	readonly el: HTMLElement;
	private readonly toolButtons = new Map<ToolName, HTMLButtonElement>();
	private readonly optionsEl: HTMLElement;
	private readonly moreEl: HTMLElement;
	private readonly colorGroup: HTMLElement;
	private readonly widthGroup: HTMLElement;
	private readonly eraserGroup: HTMLElement;
	private readonly eraserButtons = new Map<EraserMode, HTMLButtonElement>();
	private readonly filterGroup: HTMLElement;
	private readonly filterButtons = new Map<EraseFilterKind, HTMLButtonElement>();
	private readonly shapeGroup: HTMLElement;
	private readonly shapeButtons = new Map<ShapeKind, HTMLButtonElement>();
	private readonly sizeGroup: HTMLElement;
	private readonly chipButton: HTMLButtonElement;
	private readonly chipDot: HTMLElement;
	private readonly moreButton: HTMLButtonElement;
	private readonly rulerButton: HTMLButtonElement;
	private readonly moreItems: HTMLButtonElement[] = [];
	private readonly navigatorButton: HTMLButtonElement;
	private readonly undoButton: HTMLButtonElement;
	private readonly redoButton: HTMLButtonElement;
	private readonly deleteButton: HTMLButtonElement;
	private readonly pageEl: HTMLElement;
	private readonly pageLabelEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly statusTextEl: HTMLElement;
	private editable = false;
	private popover: PopoverKind | null = null;
	private popoverOff: Array<() => void> = [];
	private readonly swallowOff = new Map<number, () => void>();
	/** Slots filled by pen-controls.ts: favourite pens, eraser size, pen-only toggle. */
	readonly favouritesEl: HTMLElement;
	readonly eraserSizeEl: HTMLElement;
	readonly penOnlyEl: HTMLElement;
	/** Slots filled by pdf-reading.ts: the PDF reading entries of the "more" menu, and the highlighter's snap-to-text option. */
	readonly readingEl: HTMLElement;
	readonly highlighterOptionsEl: HTMLElement;
	onEditableChange: ((editable: boolean) => void) | null = null;

	constructor(parent: HTMLElement, public state: ToolbarState, private readonly actions: ToolbarActions) {
		this.el = parent.createDiv({ cls: "notebook-toolbar", attr: { role: "toolbar" } });

		const toolsRow = this.el.createDiv({ cls: "notebook-toolbar-row notebook-toolbar-tools" });
		this.navigatorButton = this.iconButton(toolsRow, "panel-left", "tool.pages", () => this.actions.toggleNavigator());
		for (const [tool, icon, label] of TOOL_DEFS) {
			const b = this.iconButton(toolsRow, icon, label, () => this.onToolTap(tool));
			if (TOOLS_WITH_OPTIONS.has(tool)) {
				b.addClass("has-options");
				b.setAttribute("aria-haspopup", "true");
			}
			this.toolButtons.set(tool, b);
		}

		const actionsRow = this.el.createDiv({ cls: "notebook-toolbar-row notebook-toolbar-actions" });
		this.undoButton = this.iconButton(actionsRow, "undo", "tool.undo", () => this.actions.undo());
		this.redoButton = this.iconButton(actionsRow, "redo", "tool.redo", () => this.actions.redo());
		this.deleteButton = this.iconButton(actionsRow, "trash-2", "tool.deleteSelection", () => this.actions.deleteSelection());

		this.chipButton = this.button(actionsRow, t("toolbar.options"), () => this.togglePopover("options"));
		this.chipButton.addClass("notebook-chip");
		this.chipButton.setAttribute("aria-haspopup", "true");
		this.chipDot = this.chipButton.createSpan({ cls: "notebook-chip-dot" });

		this.favouritesEl = actionsRow.createDiv({ cls: "notebook-favs", attr: { role: "group", "aria-label": t("toolbar.favourites") } });

		const end = actionsRow.createDiv({ cls: "notebook-toolbar-end" });
		this.pageEl = end.createSpan({ cls: "notebook-page-indicator" });
		this.statusEl = end.createSpan({ cls: "notebook-status", attr: { role: "status" } });
		this.statusEl.createSpan({ cls: "notebook-status-dot" });
		this.statusTextEl = this.statusEl.createSpan({ cls: "notebook-status-text" });
		this.moreButton = this.iconButton(end, "more-horizontal", "toolbar.more", () => this.togglePopover("more"));
		this.moreButton.setAttribute("aria-haspopup", "true");

		// Tool options: persistent sections, each shown for the tools that use it.
		this.optionsEl = this.el.createDiv({ cls: "notebook-popover notebook-options notebook-hidden", attr: { role: "group", "aria-label": t("toolbar.options") } });
		this.shapeGroup = this.row(this.optionsEl);
		for (const kind of SHAPE_KINDS) {
			const [icon, label] = SHAPE_DEFS[kind];
			this.shapeButtons.set(kind, this.iconButton(this.shapeGroup, icon, label, () => this.set({ shapeKind: kind })));
		}
		this.eraserGroup = this.row(this.optionsEl);
		this.eraserButtons.set("stroke", this.textButton(this.eraserGroup, "tool.eraser.stroke", () => this.set({ eraserMode: "stroke" })));
		this.eraserButtons.set("segment", this.textButton(this.eraserGroup, "tool.eraser.segment", () => this.set({ eraserMode: "segment" })));
		this.eraserButtons.set("area", this.textButton(this.eraserGroup, "tool.eraser.area", () => this.set({ eraserMode: "area" })));
		this.eraserSizeEl = this.row(this.optionsEl);
		this.filterGroup = this.row(this.optionsEl);
		for (const kind of ERASE_FILTER_KINDS) {
			this.filterButtons.set(kind, this.textButton(this.filterGroup, FILTER_LABELS[kind], () =>
				// "Colour" starts from the pen colour in use; the swatches then change it.
				this.set(kind === "color" ? { eraserFilter: kind, eraserColor: this.state.penColor } : { eraserFilter: kind })));
		}
		this.colorGroup = this.row(this.optionsEl);
		this.widthGroup = this.row(this.optionsEl);
		this.sizeGroup = this.row(this.optionsEl);
		this.highlighterOptionsEl = this.row(this.optionsEl);

		// The less used actions.
		this.moreEl = this.el.createDiv({ cls: "notebook-popover notebook-more notebook-hidden", attr: { role: "menu", "aria-label": t("toolbar.more") } });
		this.pageLabelEl = this.moreEl.createDiv({ cls: "notebook-more-title notebook-hidden" });
		this.moreItem("image-plus", "tool.image", () => this.actions.insertImage());
		this.moreItem("stamp", "stamps.menu", () => this.actions.stamps());
		this.moreItem("camera", "tool.boardShot", () => this.actions.boardShot());
		this.rulerButton = this.moreItem("ruler", "tool.ruler", () => this.set({ ruler: !this.state.ruler }));
		this.penOnlyEl = this.moreEl.createDiv({ cls: "notebook-more-slot" });
		this.readingEl = this.moreEl.createDiv({ cls: "notebook-more-slot" });
		this.moreItem("file-plus", "tool.addPage", () => this.actions.addPage());
		this.moreItem("pencil-ruler", "page.exercise", () => this.actions.exercisePage());
		const pageMenu = this.moreItem("more-vertical", "page.menu", () => undefined);
		pageMenu.addEventListener("click", (e) => this.actions.pageMenu(e));
		this.moreItem("move-horizontal", "tool.fit", () => this.actions.fit());
		// Any choice in the menu closes it (the click bubbles up here after the item has acted).
		this.moreEl.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("button")) this.closePopover();
		});

		this.render();
	}

	/** Removes the listeners of an open popover. Call when the view closes. */
	destroy(): void {
		this.closePopover();
		for (const off of [...this.swallowOff.values()]) off();
	}

	setHistory(canUndo: boolean, canRedo: boolean): void {
		this.undoButton.disabled = !this.editable || !canUndo;
		this.redoButton.disabled = !this.editable || !canRedo;
	}

	setEditable(editable: boolean): void {
		this.editable = editable;
		if (!editable) this.closePopover();
		this.render();
		this.onEditableChange?.(editable);
		if (!editable) this.setHistory(false, false);
	}

	setSelection(active: boolean): void {
		this.deleteButton.toggleClass("notebook-hidden", !active);
	}

	/** Reflects the state of the page panel on its button. */
	setNavigatorOpen(open: boolean): void {
		this.navigatorButton.toggleClass("is-active", open);
		this.navigatorButton.setAttribute("aria-pressed", String(open));
	}

	/** Selects a tool from code (e.g. the lasso after inserting an image) and notifies the view. */
	setTool(tool: ToolName): void {
		if (this.state.tool !== tool) this.set({ tool });
	}

	/** Same as `update` (used by the radial menu). */
	apply(patch: Partial<ToolbarState>): void {
		this.update(patch);
	}

	/** Applies a state change from code (favourite pens, hotkeys) and notifies the view. */
	update(patch: Partial<ToolbarState>): void {
		this.set(patch);
	}

	setPage(current: number, total: number): void {
		const text = total > 0 ? `${current} / ${total}` : "";
		this.pageEl.setText(text);
		// On a narrow view the indicator is hidden in the bar; the overflow menu shows it.
		this.pageLabelEl.setText(total > 0 ? t("toolbar.page", { n: text }) : "");
		this.pageLabelEl.toggleClass("notebook-hidden", total <= 0);
	}

	setStatus(text: string, kind: "ok" | "pending" | "error"): void {
		this.statusTextEl.setText(text);
		this.statusEl.setAttribute("title", text);
		this.statusEl.dataset.kind = kind;
	}

	/** Which popover is open (null: none). */
	get openPopover(): PopoverKind | null {
		return this.popover;
	}

	closePopover(): void {
		for (const off of this.popoverOff) off();
		this.popoverOff = [];
		if (this.popover === null) return;
		this.popover = null;
		this.syncPopover();
	}

	private onToolTap(tool: ToolName): void {
		if (this.state.tool === tool) {
			// The active tool again: its options.
			if (TOOLS_WITH_OPTIONS.has(tool)) this.togglePopover("options");
			return;
		}
		this.closePopover();
		this.set({ tool });
	}

	private togglePopover(kind: PopoverKind): void {
		if (this.popover === kind) {
			this.closePopover();
			return;
		}
		if (!this.editable || (kind === "options" && !TOOLS_WITH_OPTIONS.has(this.state.tool))) return;
		this.closePopover();
		this.popover = kind;
		this.syncPopover();
		this.listenOutside();
	}

	private syncPopover(): void {
		const kind = this.popover;
		this.optionsEl.toggleClass("notebook-hidden", kind !== "options");
		this.moreEl.toggleClass("notebook-hidden", kind !== "more");
		this.moreButton.toggleClass("is-active", kind === "more");
		this.moreButton.setAttribute("aria-expanded", String(kind === "more"));
		// A popover never grows past the bottom of the view (a phone held sideways has little room): it scrolls instead.
		const shown = kind === "options" ? this.optionsEl : kind === "more" ? this.moreEl : null;
		const host = this.el.parentElement;
		if (shown && host) {
			const room = host.getBoundingClientRect().bottom - shown.getBoundingClientRect().top - 8;
			shown.setCssProps({ "--notebook-popover-max": `${Math.max(120, Math.floor(room))}px` });
		}
		const open = kind === "options";
		this.chipButton.toggleClass("is-active", open);
		this.chipButton.setAttribute("aria-expanded", String(open));
		for (const [tool, b] of this.toolButtons) {
			if (TOOLS_WITH_OPTIONS.has(tool)) b.setAttribute("aria-expanded", String(open && tool === this.state.tool));
		}
	}

	/**
	 * While a popover is open, Escape closes it and so does a tap outside it. A tap on the page only closes the popover
	 * (as in Samsung Notes and Goodnotes): the rest of that pointer's sequence is kept from the page, so it leaves no ink.
	 */
	private listenOutside(): void {
		const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
			window.addEventListener(type, fn, true);
			this.popoverOff.push(() => window.removeEventListener(type, fn, true));
		};
		on("pointerdown", (e) => {
			const target = e.target as Element | null;
			if (!target || typeof target.closest !== "function") return;
			if (this.optionsEl.contains(target) || this.moreEl.contains(target)) return;
			// The bar's own buttons act as usual (and may switch to the other popover).
			if (this.el.contains(target) && target.closest(".notebook-toolbar-row")) return;
			const onPage = !!target.closest(".notebook-stage");
			this.closePopover();
			if (onPage) this.swallow(e);
		});
		on("keydown", (e) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			this.closePopover();
		});
	}

	/** Keeps a pointer sequence (down … up) from reaching the page. */
	private swallow(down: PointerEvent): void {
		const id = down.pointerId;
		const types = ["pointerdown", "pointermove", "pointerrawupdate", "pointerup", "pointercancel"] as const;
		const stop = (e: Event): void => {
			const pe = e as PointerEvent;
			if (pe.pointerId !== id) return;
			e.stopPropagation();
			e.preventDefault();
			if (e.type === "pointerup" || e.type === "pointercancel") off();
		};
		const off = (): void => {
			for (const type of types) window.removeEventListener(type, stop, true);
			this.swallowOff.delete(id);
		};
		this.swallowOff.get(id)?.();
		for (const type of types) window.addEventListener(type, stop, true);
		this.swallowOff.set(id, off);
		stop(down);
	}

	private set(patch: Partial<ToolbarState>): void {
		this.state = { ...this.state, ...patch };
		this.render();
		this.actions.change(this.state);
	}

	/** Refreshes the bar and rebuilds the colour and width rows of the options for the current tool. */
	private render(): void {
		const s = this.state;
		for (const [tool, b] of this.toolButtons) {
			b.toggleClass("is-active", tool === s.tool);
			b.disabled = !this.editable;
		}
		this.moreButton.disabled = !this.editable;
		for (const b of this.moreItems) b.disabled = !this.editable;
		this.navigatorButton.disabled = !this.editable;
		this.rulerButton.toggleClass("is-active", s.ruler);
		this.rulerButton.setAttribute("aria-pressed", String(s.ruler));
		if (this.popover === "options" && !TOOLS_WITH_OPTIONS.has(s.tool)) this.closePopover();
		else this.syncPopover();
		this.renderChip();
		this.eraserGroup.toggleClass("notebook-hidden", s.tool !== "eraser");
		this.eraserSizeEl.toggleClass("notebook-hidden", s.tool !== "eraser");
		for (const [mode, b] of this.eraserButtons) {
			b.toggleClass("is-active", mode === s.eraserMode);
			b.disabled = !this.editable;
		}
		this.filterGroup.toggleClass("notebook-hidden", s.tool !== "eraser");
		for (const [kind, b] of this.filterButtons) {
			b.toggleClass("is-active", kind === s.eraserFilter);
			b.disabled = !this.editable;
		}
		this.shapeGroup.toggleClass("notebook-hidden", s.tool !== "shape");
		for (const [kind, b] of this.shapeButtons) {
			b.toggleClass("is-active", kind === s.shapeKind);
			b.disabled = !this.editable;
		}

		const inking = s.tool === "pen" || s.tool === "highlighter" || s.tool === "shape";
		const erasingColor = s.tool === "eraser" && s.eraserFilter === "color";
		const colouring = inking || s.tool === "text" || erasingColor;
		this.colorGroup.toggleClass("notebook-hidden", !colouring);
		this.widthGroup.toggleClass("notebook-hidden", !inking);
		this.sizeGroup.toggleClass("notebook-hidden", s.tool !== "text");
		this.highlighterOptionsEl.toggleClass("notebook-hidden", s.tool !== "highlighter");
		this.colorGroup.empty();
		this.widthGroup.empty();
		this.sizeGroup.empty();

		// Shapes and text use the pen colour; only the highlighter has its own palette.
		const highlighter = s.tool === "highlighter";
		if (colouring) {
			const colors: readonly string[] = erasingColor ? ERASER_COLORS : highlighter ? HIGHLIGHTER_COLORS : PEN_COLORS;
			const current = erasingColor ? s.eraserColor : highlighter ? s.highlighterColor : s.penColor;
			for (const color of colors) {
				const b = this.button(this.colorGroup, `${t("tool.color")} ${color}`, () =>
					this.set(erasingColor ? { eraserColor: color } : highlighter ? { highlighterColor: color } : { penColor: color }));
				b.addClass("notebook-swatch");
				b.toggleClass("is-active", color === current);
				b.disabled = !this.editable;
				b.createSpan({ cls: "notebook-swatch-dot" }).setCssProps({ "--notebook-swatch-color": color });
			}
		}

		if (inking) {
			const widths = highlighter ? HIGHLIGHTER_WIDTHS : PEN_WIDTHS;
			const currentWidth = highlighter ? s.highlighterWidth : s.penWidth;
			widths.forEach((width, i) => {
				const b = this.button(this.widthGroup, `${t("tool.width")} ${i + 1}`, () =>
					this.set(highlighter ? { highlighterWidth: width } : { penWidth: width }));
				b.addClass("notebook-width");
				b.toggleClass("is-active", width === currentWidth);
				b.disabled = !this.editable;
				b.createSpan({ cls: `notebook-width-dot notebook-width-${highlighter ? "h" : "p"}${i}` });
			});
		}

		if (s.tool === "text") {
			TEXT_SIZES.forEach((size, i) => {
				const b = this.button(this.sizeGroup, `${t("tool.textSize")} ${size}`, () => this.set({ textSize: size }));
				b.addClass("notebook-text-size");
				b.toggleClass("is-active", size === s.textSize);
				b.disabled = !this.editable;
				b.createSpan({ cls: `notebook-text-size-glyph notebook-text-size-${i}`, text: "A" });
			});
		}
	}

	/** The current-pen indicator: colour and thickness of the tool in use; a ring the size of the eraser for the eraser. */
	private renderChip(): void {
		const s = this.state;
		const has = TOOLS_WITH_OPTIONS.has(s.tool);
		this.chipButton.toggleClass("notebook-hidden", !has);
		this.chipButton.disabled = !this.editable;
		const dot = this.chipDot;
		dot.toggleClass("is-eraser", s.tool === "eraser");
		dot.toggleClass("is-highlighter", s.tool === "highlighter");
		if (!has) return;
		const toolLabel = t(TOOL_DEFS.find((d) => d[0] === s.tool)![2]);
		this.chipButton.setAttribute("aria-label", `${t("toolbar.options")}: ${toolLabel}`);
		if (s.tool === "eraser") {
			const d = Math.max(8, Math.min(24, Math.round(s.eraserSize * 0.6)));
			dot.setCssProps({ "--notebook-chip-w": `${d}px`, "--notebook-chip-h": `${d}px`, "--notebook-chip-color": "transparent" });
		} else if (s.tool === "highlighter") {
			dot.setCssProps({ "--notebook-chip-w": "20px", "--notebook-chip-h": `${Math.round(6 + s.highlighterWidth * 0.4)}px`, "--notebook-chip-color": s.highlighterColor });
		} else {
			const d = chipDiameter(s.penWidth);
			dot.setCssProps({ "--notebook-chip-w": `${d}px`, "--notebook-chip-h": `${d}px`, "--notebook-chip-color": s.penColor });
		}
	}

	private row(parent: HTMLElement): HTMLElement {
		return parent.createDiv({ cls: "notebook-popover-row" });
	}

	private button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "notebook-tool clickable-icon", attr: { "aria-label": label, type: "button" } });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}

	private iconButton(parent: HTMLElement, icon: string, label: MessageKey, onClick: () => void): HTMLButtonElement {
		const b = this.button(parent, t(label), onClick);
		setIcon(b, icon);
		return b;
	}

	private textButton(parent: HTMLElement, label: MessageKey, onClick: () => void): HTMLButtonElement {
		const b = this.button(parent, t(label), onClick);
		b.addClass("notebook-text-tool");
		b.setText(t(label));
		return b;
	}

	/** Adds a toggle row to the "more" menu (one page at a time). Returns the setter of its pressed state. */
	addMoreToggle(icon: string, label: MessageKey, onClick: () => void): (on: boolean) => void {
		const b = this.moreItem(icon, label, onClick);
		return (on) => {
			b.toggleClass("is-active", on);
			b.setAttribute("aria-pressed", String(on));
		};
	}

	/** A row of the "more" menu: icon and label. */
	private moreItem(icon: string, label: MessageKey, onClick: () => void): HTMLButtonElement {
		const b = this.moreEl.createEl("button", { cls: "notebook-menu-item", attr: { type: "button", role: "menuitem" } });
		setIcon(b.createSpan({ cls: "notebook-menu-icon" }), icon);
		b.createSpan({ cls: "notebook-menu-label", text: t(label) });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		this.moreItems.push(b);
		return b;
	}
}
