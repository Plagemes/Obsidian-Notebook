import { setIcon } from "obsidian";
import { listenDismiss, releaseSwallowed } from "../ui/dismiss";
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
	toggleNavigator(): void;
	/** Runs an action of the registry (quick slots). */
	runAction(id: string): void;
	/** Opens (or closes) the "All actions" sheet under `anchor`. */
	openSheet(anchor: HTMLElement): void;
	/** Opens (or closes) the page sheet of the page in view under `anchor`. */
	openPageSheet(anchor: HTMLElement): void;
}

/** A quick slot: an action of the registry chosen by the layout engine (ui/layout.ts). */
export interface QuickItem {
	id: string;
	icon: string;
	label: string;
	enabled: boolean;
	/** Toggle actions: on or off; undefined for plain actions. */
	checked?: boolean;
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

type PopoverKind = "options";

/** Diameter of the pen dot in the current-pen indicator, CSS px (same scale as the favourite pens). */
function chipDiameter(width: number): number {
	return Math.round(Math.min(18, 6 + Math.sqrt(width) * 3));
}

/**
 * The primary toolbar (ui redesign, docs/design-ui.md). Row 1: pages panel and the seven tools. Row 2: undo and redo,
 * the current pen (opens the tool options), the favourite pens, the quick slots chosen by the layout engine, the page
 * indicator (opens the page sheet), the save state and "All actions". Both rows share one line on a wide view.
 * Tool options (colours, widths, eraser mode, filter, size) live in a popover that opens when the active tool is tapped
 * again (or from the current-pen indicator).
 */
export class Toolbar {
	readonly el: HTMLElement;
	private readonly toolButtons = new Map<ToolName, HTMLButtonElement>();
	private readonly optionsEl: HTMLElement;
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
	private readonly readOnlyButton: HTMLButtonElement;
	private readonly chipDot: HTMLElement;
	private readonly moreButton: HTMLButtonElement;
	private readonly navigatorButton: HTMLButtonElement;
	private readonly undoButton: HTMLButtonElement;
	private readonly redoButton: HTMLButtonElement;
	private readonly quickEl: HTMLElement;
	private readonly pageButton: HTMLButtonElement;
	private readonly statusEl: HTMLElement;
	private readonly statusTextEl: HTMLElement;
	private editable = false;
	private popover: PopoverKind | null = null;
	private stopDismiss: (() => void) | null = null;
	private quick: QuickItem[] = [];
	/** Slots filled by pen-controls.ts: favourite pens and eraser size. */
	readonly favouritesEl: HTMLElement;
	readonly eraserSizeEl: HTMLElement;
	/** Slot filled by pdf-reading.ts: the highlighter's snap-to-text option. */
	readonly highlighterOptionsEl: HTMLElement;
	onEditableChange: ((editable: boolean) => void) | null = null;

	constructor(parent: HTMLElement, public state: ToolbarState, private readonly actions: ToolbarActions) {
		this.el = parent.createDiv({ cls: "notebook-toolbar", attr: { role: "toolbar" } });

		const toolsRow = this.el.createDiv({ cls: "notebook-toolbar-row notebook-toolbar-tools" });
		this.navigatorButton = this.iconButton(toolsRow, "panel-left", "tool.pages", () => this.actions.toggleNavigator());
		this.navigatorButton.setAttribute("aria-pressed", "false");
		toolsRow.createDiv({ cls: "notebook-toolbar-divider", attr: { "aria-hidden": "true" } });
		const toolGroup = toolsRow.createDiv({ cls: "notebook-toolbar-group notebook-tool-group", attr: { role: "group", "aria-label": t("ui.group.tool") } });
		for (const [tool, icon, label] of TOOL_DEFS) {
			const b = this.iconButton(toolGroup, icon, label, () => this.onToolTap(tool));
			b.addClass("notebook-tool-button");
			if (TOOLS_WITH_OPTIONS.has(tool)) {
				b.addClass("has-options");
				b.setAttribute("aria-haspopup", "true");
			}
			this.toolButtons.set(tool, b);
		}

		const actionsRow = this.el.createDiv({ cls: "notebook-toolbar-row notebook-toolbar-actions" });
		const history = actionsRow.createDiv({ cls: "notebook-toolbar-group", attr: { role: "group", "aria-label": t("ui.group.history") } });
		this.undoButton = this.iconButton(history, "undo", "tool.undo", () => this.actions.undo());
		this.redoButton = this.iconButton(history, "redo", "tool.redo", () => this.actions.redo());
		actionsRow.createDiv({ cls: "notebook-toolbar-divider", attr: { "aria-hidden": "true" } });

		// wave 0.10 (51): while read-only mode is on this button takes the place of the pen indicator and the favourite pens;
		// tapping it switches the mode off.
		this.readOnlyButton = this.button(actionsRow, t("readonly.chip.hint"), () => this.actions.runAction("toggle-read-only"));
		this.readOnlyButton.addClasses(["notebook-readonly-chip", "notebook-hidden", "is-active"]);
		this.readOnlyButton.setAttribute("aria-pressed", "true");
		setIcon(this.readOnlyButton.createSpan({ cls: "notebook-readonly-icon" }), "lock");
		this.readOnlyButton.createSpan({ cls: "notebook-readonly-label", text: t("readonly.chip") });

		this.chipButton = this.button(actionsRow, t("toolbar.options"), () => this.togglePopover("options"));
		this.chipButton.addClass("notebook-chip");
		this.chipButton.setAttribute("aria-haspopup", "true");
		this.chipDot = this.chipButton.createSpan({ cls: "notebook-chip-dot" });

		this.favouritesEl = actionsRow.createDiv({ cls: "notebook-favs", attr: { role: "group", "aria-label": t("toolbar.favourites") } });
		this.quickEl = actionsRow.createDiv({ cls: "notebook-quick notebook-toolbar-group notebook-hidden", attr: { role: "group", "aria-label": t("ui.quick") } });

		const end = actionsRow.createDiv({ cls: "notebook-toolbar-end" });
		this.pageButton = end.createEl("button", { cls: "notebook-page-indicator", attr: { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" } });
		this.pageButton.addEventListener("click", (e) => {
			e.preventDefault();
			this.closePopover();
			this.actions.openPageSheet(this.pageButton);
		});
		this.statusEl = end.createSpan({ cls: "notebook-status", attr: { role: "status" } });
		this.statusEl.createSpan({ cls: "notebook-status-dot" });
		this.statusTextEl = this.statusEl.createSpan({ cls: "notebook-status-text" });
		this.moreButton = this.iconButton(end, "layout-grid", "ui.sheet.title", () => {
			this.closePopover();
			this.actions.openSheet(this.moreButton);
		});
		this.moreButton.addClass("notebook-more-button");
		this.moreButton.setAttribute("aria-haspopup", "dialog");
		this.moreButton.setAttribute("aria-expanded", "false");

		// Tool options: persistent sections, each shown for the tools that use it.
		this.optionsEl = this.el.createDiv({ cls: "notebook-popover notebook-options notebook-hidden", attr: { role: "group", "aria-label": t("toolbar.options") } });
		this.shapeGroup = this.row(this.optionsEl);
		for (const kind of SHAPE_KINDS) {
			const [icon, label] = SHAPE_DEFS[kind];
			this.shapeButtons.set(kind, this.iconButton(this.shapeGroup, icon, label, () => this.set({ shapeKind: kind })));
		}
		this.eraserGroup = this.row(this.optionsEl);
		this.eraserGroup.addClass("notebook-segmented");
		this.eraserButtons.set("stroke", this.textButton(this.eraserGroup, "tool.eraser.stroke", () => this.set({ eraserMode: "stroke" })));
		this.eraserButtons.set("segment", this.textButton(this.eraserGroup, "tool.eraser.segment", () => this.set({ eraserMode: "segment" })));
		this.eraserButtons.set("area", this.textButton(this.eraserGroup, "tool.eraser.area", () => this.set({ eraserMode: "area" })));
		this.eraserSizeEl = this.row(this.optionsEl);
		this.filterGroup = this.row(this.optionsEl);
		this.filterGroup.addClass("notebook-segmented");
		for (const kind of ERASE_FILTER_KINDS) {
			this.filterButtons.set(kind, this.textButton(this.filterGroup, FILTER_LABELS[kind], () =>
				// "Colour" starts from the pen colour in use; the swatches then change it.
				this.set(kind === "color" ? { eraserFilter: kind, eraserColor: this.state.penColor } : { eraserFilter: kind })));
		}
		this.colorGroup = this.row(this.optionsEl);
		this.widthGroup = this.row(this.optionsEl);
		this.sizeGroup = this.row(this.optionsEl);
		this.highlighterOptionsEl = this.row(this.optionsEl);

		this.render();
	}

	/** Removes the listeners of an open popover. Call when the view closes. */
	destroy(): void {
		this.closePopover();
		releaseSwallowed();
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

	/** wave 0.10 (51): shows or hides the read-only indicator (it is also the button that switches the mode off). */
	setReadOnly(on: boolean): void {
		this.el.toggleClass("is-read-only", on);
		this.readOnlyButton.toggleClass("notebook-hidden", !on);
		if (on) this.closePopover();
	}

	/** Reflects the state of the page panel on its button. */
	setNavigatorOpen(open: boolean): void {
		this.navigatorButton.toggleClass("is-active", open);
		this.navigatorButton.setAttribute("aria-pressed", String(open));
	}

	/** One row (wide view) or two (tablet in portrait, phone), as planned by the layout engine. */
	setSingleRow(single: boolean): void {
		this.el.toggleClass("is-single-row", single);
	}

	/** The quick slots chosen by the layout engine. Rebuilt only when they change. */
	setQuick(items: QuickItem[]): void {
		const same = items.length === this.quick.length && items.every((q, i) => {
			const p = this.quick[i]!;
			return p.id === q.id && p.enabled === q.enabled && p.checked === q.checked && p.label === q.label;
		});
		if (same) return;
		this.quick = items;
		this.quickEl.empty();
		this.quickEl.toggleClass("notebook-hidden", items.length === 0);
		for (const q of items) {
			const b = this.button(this.quickEl, q.label, () => this.actions.runAction(q.id));
			setIcon(b, q.icon);
			b.dataset.action = q.id;
			b.disabled = !q.enabled;
			if (q.checked !== undefined) {
				b.toggleClass("is-active", q.checked);
				b.setAttribute("aria-pressed", String(q.checked));
			}
		}
	}

	/** Ids of the quick slots shown now. */
	get quickIds(): string[] {
		return this.quick.map((q) => q.id);
	}

	/** Marks the button of the open sheet. */
	setSheetOpen(kind: "all" | "page" | null): void {
		this.moreButton.toggleClass("is-active", kind === "all");
		this.moreButton.setAttribute("aria-expanded", String(kind === "all"));
		this.pageButton.toggleClass("is-active", kind === "page");
		this.pageButton.setAttribute("aria-expanded", String(kind === "page"));
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
		this.pageButton.setText(total > 0 ? `${current} / ${total}` : "–");
		this.pageButton.setAttribute("aria-label", total > 0 ? t("ui.pageSheet.open", { n: String(current), total: String(total) }) : t("page.menu"));
		this.pageButton.disabled = total <= 0;
	}

	setStatus(text: string, kind: "ok" | "pending" | "error"): void {
		this.statusTextEl.setText(text);
		this.statusEl.setAttribute("aria-label", text);
		this.statusEl.dataset.kind = kind;
	}

	/** Which popover is open (null: none). */
	get openPopover(): PopoverKind | null {
		return this.popover;
	}

	closePopover(): void {
		this.stopDismiss?.();
		this.stopDismiss = null;
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
		if (!this.editable || !TOOLS_WITH_OPTIONS.has(this.state.tool)) return;
		this.closePopover();
		this.popover = kind;
		this.syncPopover();
		// A tap on the page only closes the popover (as in Samsung Notes and Goodnotes) and leaves no ink; the bar's
		// own buttons act as usual.
		this.stopDismiss = listenDismiss({
			inside: () => [this.optionsEl, ...Array.from(this.el.querySelectorAll(".notebook-toolbar-row"))],
			close: () => this.closePopover(),
			page: ".notebook-stage",
		});
	}

	private syncPopover(): void {
		const open = this.popover === "options";
		this.optionsEl.toggleClass("notebook-hidden", !open);
		// A popover never grows past the bottom of the view (a phone held sideways has little room): it scrolls instead.
		const host = this.el.parentElement;
		if (open && host) {
			const room = host.getBoundingClientRect().bottom - this.optionsEl.getBoundingClientRect().top - 8;
			this.optionsEl.setCssProps({ "--notebook-popover-max": `${Math.max(120, Math.floor(room))}px` });
		}
		this.chipButton.toggleClass("is-active", open);
		this.chipButton.setAttribute("aria-expanded", String(open));
		for (const [tool, b] of this.toolButtons) {
			if (TOOLS_WITH_OPTIONS.has(tool)) b.setAttribute("aria-expanded", String(open && tool === this.state.tool));
		}
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
		for (const [tool, b] of this.toolButtons) b.setAttribute("aria-pressed", String(tool === s.tool));
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
			// wave 0.10 (7, 68): the free picker, the page eyedropper and (for ink) the style eyedropper.
			const free = this.button(this.colorGroup, t("command.colourPicker"), () => this.runColourAction("colour-picker"));
			free.addClass("notebook-swatch", "is-free");
			free.disabled = !this.editable;
			free.createSpan({ cls: "notebook-swatch-dot" });
			const dropper = this.button(this.colorGroup, t("command.colourEyedropper"), () => this.runColourAction("colour-eyedropper"));
			setIcon(dropper, "pipette");
			dropper.disabled = !this.editable;
			if (inking) {
				const style = this.button(this.colorGroup, t("command.styleEyedropper"), () => this.runColourAction("style-eyedropper"));
				setIcon(style, "droplets");
				style.disabled = !this.editable;
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

	/** The picker and the eyedroppers float over the page: close the options first so they do not cover it. */
	private runColourAction(id: string): void {
		this.closePopover();
		this.actions.runAction(id);
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
}
