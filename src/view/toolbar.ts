import { setIcon } from "obsidian";
import { attachPinGesture, type PinGesture } from "../ui/pin-gesture";
import { attachLongPressHelp } from "../ui/long-press-help";
import { TOOL_HELP } from "../ui/help-text";
import { listenDismiss, releaseSwallowed } from "../ui/dismiss";
import { t, type MessageKey } from "../i18n";
import { ERASE_FILTER_KINDS, type EraseFilterKind } from "../ink/erase-filter";
import { DEFAULT_ERASER_SIZE } from "./favourites";
import { SHAPE_KINDS, type ShapeKind } from "./view-helpers";
import { attachQuickTabGesture } from "./quick-tabs";
import { kindHasNib, NIB_STEP, normaliseNib, PEN_KINDS, type PenKind } from "../ink/pen-kinds";
import type { FillMode, LineStyle } from "../ink/shape-restyle";
import { renderShapeStyle } from "./shape-style-row";

export type ToolName = "pen" | "highlighter" | "eraser" | "lasso" | "shape" | "text" | "space";
export type EraserMode = "stroke" | "segment" | "area";
/** wave 0.10 (63): how the lasso tool selects: a freehand outline, or a rectangle dragged from corner to corner. */
export type SelectMode = "lasso" | "rectangle";

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
	/** The shape of a selection made with the lasso tool. */
	selectMode: SelectMode;
	/** 0.22 (#35): which pen the pen tool writes with (ballpoint, fountain pen, brush, marker). */
	penKind: PenKind;
	/** 0.22 (#35): nib angle in degrees of new fountain pen and marker strokes (45 is the default). */
	nibAngle: number;
	/** 0.24 (#37): the fill of new closed shapes (none, solid or a translucent tint), its colour (null: the colour of the line) and the line style (solid, dashed or dotted). */
	shapeFill: FillMode;
	shapeFillColor: string | null;
	shapeLine: LineStyle;
	/** 0.25 (#99): the highlighter marks a rectangle (an area highlighter) instead of a stroke. */
	highlighterArea: boolean;
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
	selectMode: "lasso",
	penKind: "pen",
	nibAngle: 45,
	shapeFill: "none",
	shapeFillColor: null,
	shapeLine: "solid",
	highlighterArea: false,
};

export interface ToolbarActions {
	change(state: ToolbarState): void;
	undo(): void;
	redo(): void;
	toggleNavigator(): void;
	/** Runs an action of the registry (quick slots). */
	runAction(id: string): void;
	/** 0.14 (393): pins the quick action to the toolbar, or unpins it (long press on a quick slot). Absent: slots cannot be pinned. */
	togglePin?(id: string): void;
	/** Opens (or closes) the "All actions" sheet under `anchor`. */
	openSheet(anchor: HTMLElement): void;
	/** Opens (or closes) the page sheet of the page in view under `anchor`. */
	openPageSheet(anchor: HTMLElement): void;
	/** 0.18 (#227): long press on the page number: pins the page in view as a quick tab, or unpins it. Absent: no long press. */
	quickTab?: { pinned(): boolean; toggle(): void };
}

/** A quick slot: an action of the registry chosen by the layout engine (ui/layout.ts). */
export interface QuickItem {
	id: string;
	icon: string;
	label: string;
	enabled: boolean;
	/** Toggle actions: on or off; undefined for plain actions. */
	checked?: boolean;
	/** 0.14 (393): pinned by the person: it always stays in this place of the bar. */
	pinned?: boolean;
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

/** 0.22 (#35): the kinds of the pen tool, with their icon and name. */
const KIND_ICON: Record<PenKind, string> = { pen: "pencil", fountain: "pen-tool", brush: "paintbrush", marker: "pen-line" };
const KIND_LABEL: Record<PenKind, MessageKey> = { pen: "tool.pen", fountain: "tool.fountain", brush: "tool.brush", marker: "tool.marker" };

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
const TOOLS_WITH_OPTIONS: ReadonlySet<ToolName> = new Set<ToolName>(["pen", "highlighter", "eraser", "lasso", "shape", "text"]);

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
	private zoomHintEl: HTMLElement | null = null;
	private zoomHint: { screen: number; page: number } | null = null;
	private readonly eraserGroup: HTMLElement;
	private readonly eraserButtons = new Map<EraserMode, HTMLButtonElement>();
	private readonly filterGroup: HTMLElement;
	private readonly filterButtons = new Map<EraseFilterKind, HTMLButtonElement>();
	private readonly shapeGroup: HTMLElement;
	/** 0.24 (#37): fill and line style of the shape tool. */
	private readonly shapeStyleEl: HTMLElement;
	private readonly selectGroup: HTMLElement;
	/** 0.25 (#99): the highlighter marks strokes or rectangles. */
	private readonly highlighterModeGroup: HTMLElement;
	private readonly highlighterModeButtons = new Map<boolean, HTMLButtonElement>();
	private readonly selectButtons = new Map<SelectMode, HTMLButtonElement>();
	private readonly shapeButtons = new Map<ShapeKind, HTMLButtonElement>();
	private readonly sizeGroup: HTMLElement;
	/** 0.22 (#35): the pen kinds of the pen tool, and the nib angle of the fountain pen and the marker. */
	private readonly penKindGroup: HTMLElement;
	private readonly penKindButtons = new Map<PenKind, HTMLButtonElement>();
	private readonly nibGroup: HTMLElement;
	private readonly nibSlider: HTMLInputElement;
	private readonly nibValue: HTMLElement;
	private readonly nibPreview: HTMLElement;
	private readonly chipButton: HTMLButtonElement;
	private readonly readOnlyButton: HTMLButtonElement;
	private readonly chipDot: HTMLElement;
	/** 0.11.2: "next stroke erases" is armed (a small badge on the current-pen indicator). */
	private eraserNext = false;
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
	/** 0.15 pen sets: slot filled by pen-set-controls.ts (the pen set switcher; shown for the pen and the highlighter). */
	readonly penSetsEl: HTMLElement;
	/** Slot filled by pdf-reading.ts: the highlighter's snap-to-text option. */
	readonly highlighterOptionsEl: HTMLElement;
	onEditableChange: ((editable: boolean) => void) | null = null;

	constructor(parent: HTMLElement, public state: ToolbarState, private readonly actions: ToolbarActions) {
		this.el = parent.createDiv({ cls: "notebook-toolbar", attr: { role: "toolbar" } });

		const toolsRow = this.el.createDiv({ cls: "notebook-toolbar-row notebook-toolbar-tools" });
		this.navigatorButton = this.iconButton(toolsRow, "panel-left", "tool.pages", () => this.actions.toggleNavigator());
		this.navigatorButton.setAttribute("aria-pressed", "false");
		this.navigatorButton.dataset.action = "toggle-pages-panel";
		toolsRow.createDiv({ cls: "notebook-toolbar-divider", attr: { "aria-hidden": "true" } });
		const toolGroup = toolsRow.createDiv({ cls: "notebook-toolbar-group notebook-tool-group", attr: { role: "group", "aria-label": t("ui.group.tool") } });
		for (const [tool, icon, label] of TOOL_DEFS) {
			const b = this.iconButton(toolGroup, icon, label, () => this.onToolTap(tool));
			b.addClass("notebook-tool-button");
			b.dataset.help = TOOL_HELP[tool]!; // 0.24 iconhelp (#429): the long-press explanation
			if (TOOLS_WITH_OPTIONS.has(tool)) {
				b.addClass("has-options");
				b.setAttribute("aria-haspopup", "true");
				b.dataset.helpHint = "help.hint.options";
			}
			this.toolButtons.set(tool, b);
		}

		const actionsRow = this.el.createDiv({ cls: "notebook-toolbar-row notebook-toolbar-actions" });
		const history = actionsRow.createDiv({ cls: "notebook-toolbar-group", attr: { role: "group", "aria-label": t("ui.group.history") } });
		this.undoButton = this.iconButton(history, "undo", "tool.undo", () => this.actions.undo());
		this.redoButton = this.iconButton(history, "redo", "tool.redo", () => this.actions.redo());
		this.undoButton.dataset.action = "undo";
		this.redoButton.dataset.action = "redo";
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
		this.chipButton.dataset.help = "help.chip";
		this.chipButton.setAttribute("aria-haspopup", "true");
		this.chipDot = this.chipButton.createSpan({ cls: "notebook-chip-dot" });
		this.chipButton.createSpan({ cls: "notebook-chip-armed", attr: { "aria-hidden": "true" } });

		this.favouritesEl = actionsRow.createDiv({ cls: "notebook-favs", attr: { role: "group", "aria-label": t("toolbar.favourites") } });
		this.quickEl = actionsRow.createDiv({ cls: "notebook-quick notebook-toolbar-group notebook-hidden", attr: { role: "group", "aria-label": t("ui.quick") } });

		const end = actionsRow.createDiv({ cls: "notebook-toolbar-end" });
		this.pageButton = end.createEl("button", { cls: "notebook-page-indicator", attr: { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" } });
		const quick = this.actions.quickTab ? attachQuickTabGesture(this.pageButton, this.actions.quickTab) : null;
		if (quick) this.pageButton.dataset.noHelp = ""; // 0.24 iconhelp: it has its own long-press (the quick tab menu)
		this.pageButton.addEventListener("click", (e) => {
			e.preventDefault();
			if (quick?.justOpened()) return;
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
		this.shapeStyleEl = this.optionsEl.createDiv({ cls: "notebook-shape-style" });
		this.eraserGroup = this.row(this.optionsEl);
		this.eraserGroup.addClass("notebook-segmented");
		this.eraserButtons.set("stroke", this.textButton(this.eraserGroup, "tool.eraser.stroke", () => this.set({ eraserMode: "stroke" })));
		this.eraserButtons.set("segment", this.textButton(this.eraserGroup, "tool.eraser.segment", () => this.set({ eraserMode: "segment" })));
		this.eraserButtons.set("area", this.textButton(this.eraserGroup, "tool.eraser.area", () => this.set({ eraserMode: "area" })));
		this.selectGroup = this.row(this.optionsEl);
		this.selectGroup.addClass("notebook-segmented");
		this.selectGroup.setAttribute("aria-label", t("select.mode"));
		this.selectButtons.set("lasso", this.textButton(this.selectGroup, "select.mode.lasso", () => this.set({ selectMode: "lasso" })));
		this.selectButtons.set("rectangle", this.textButton(this.selectGroup, "select.mode.rectangle", () => this.set({ selectMode: "rectangle" })));
		this.eraserSizeEl = this.row(this.optionsEl);
		this.filterGroup = this.row(this.optionsEl);
		this.filterGroup.addClass("notebook-segmented");
		for (const kind of ERASE_FILTER_KINDS) {
			this.filterButtons.set(kind, this.textButton(this.filterGroup, FILTER_LABELS[kind], () =>
				// "Colour" starts from the pen colour in use; the swatches then change it.
				this.set(kind === "color" ? { eraserFilter: kind, eraserColor: this.state.penColor } : { eraserFilter: kind })));
		}
		this.penSetsEl = this.row(this.optionsEl);
		// 0.25 (#99): what the highlighter marks: a stroke along the writing, or a rectangle dragged from corner to corner (area highlighter, under the ink).
		this.highlighterModeGroup = this.row(this.optionsEl);
		this.highlighterModeGroup.addClass("notebook-segmented", "notebook-hl-mode");
		this.highlighterModeGroup.setAttribute("aria-label", t("highlighter.mode"));
		for (const area of [false, true]) {
			const b = this.textButton(this.highlighterModeGroup, area ? "highlighter.mode.area" : "highlighter.mode.stroke", () => this.set({ highlighterArea: area }));
			b.dataset.help = area ? "help.highlighter.modeArea" : "help.highlighter.modeStroke";
			this.highlighterModeButtons.set(area, b);
		}
		// 0.22 (#35): the kind of pen (ballpoint, fountain pen, brush, marker) and, for the fountain pen and the marker, the nib angle.
		this.penKindGroup = this.row(this.optionsEl);
		this.penKindGroup.addClass("notebook-segmented", "notebook-pen-kinds");
		this.penKindGroup.setAttribute("aria-label", t("tool.penKind"));
		for (const kind of PEN_KINDS) {
			const label = KIND_LABEL[kind];
			const b = this.button(this.penKindGroup, t(label), () => this.set({ penKind: kind }));
			b.addClass("notebook-text-tool", "notebook-kind-button", `is-kind-${kind}`);
			setIcon(b.createSpan({ cls: "notebook-kind-icon" }), KIND_ICON[kind]);
			b.createSpan({ cls: "notebook-kind-label", text: t(label) });
			this.penKindButtons.set(kind, b);
		}
		this.nibGroup = this.row(this.optionsEl);
		this.nibGroup.addClass("notebook-nib-row");
		this.nibGroup.createSpan({ cls: "notebook-nib-label", text: t("tool.nib") });
		this.nibPreview = this.nibGroup.createSpan({ cls: "notebook-nib-preview", attr: { "aria-hidden": "true" } });
		this.nibPreview.createSpan({ cls: "notebook-nib-bar" });
		this.nibSlider = this.nibGroup.createEl("input", { cls: "notebook-nib-slider", attr: { type: "range", min: "0", max: "175", step: String(NIB_STEP) } });
		this.nibValue = this.nibGroup.createSpan({ cls: "notebook-nib-value" });
		// Dragging only previews the angle; the stroke style changes when the finger lifts (the row is rebuilt by `set`).
		this.nibSlider.addEventListener("input", () => this.showNib(normaliseNib(Number(this.nibSlider.value))));
		this.nibSlider.addEventListener("change", () => this.set({ nibAngle: normaliseNib(Number(this.nibSlider.value)) }));
		this.colorGroup = this.row(this.optionsEl);
		this.widthGroup = this.row(this.optionsEl);
		this.sizeGroup = this.row(this.optionsEl);
		this.highlighterOptionsEl = this.row(this.optionsEl);

		this.render();
		this.stopHelp = attachLongPressHelp(this.el); // 0.24 iconhelp (#429)
	}

	private stopHelp: () => void = () => undefined;

	/** Removes the listeners of an open popover. Call when the view closes. */
	destroy(): void {
		this.stopHelp();
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
			return p.id === q.id && p.enabled === q.enabled && p.checked === q.checked && p.label === q.label && p.pinned === q.pinned;
		});
		if (same) return;
		this.quick = items;
		this.quickEl.empty();
		this.quickEl.toggleClass("notebook-hidden", items.length === 0);
		for (const q of items) {
			let press: PinGesture | null = null;
			const b = this.button(this.quickEl, q.label, () => {
				if (press?.justOpened()) return; // the long press already opened the pin menu
				this.actions.runAction(q.id);
			});
			setIcon(b, q.icon);
			b.dataset.action = q.id;
			b.disabled = !q.enabled;
			b.toggleClass("is-pinned", !!q.pinned);
			if (this.actions.togglePin) {
				press = attachPinGesture(b, { pinned: () => !!q.pinned, toggle: () => this.actions.togglePin?.(q.id) });
				b.dataset.noHelp = ""; // 0.24 iconhelp: the long press already opens the pin menu
			}
			if (q.checked !== undefined) {
				b.toggleClass("is-active", q.checked);
				b.setAttribute("aria-pressed", String(q.checked));
			}
		}
	}

	/** 0.14 (392): the tools the page in view invites get a small mark; their order and place never change. */
	setSuggested(tools: readonly ToolName[]): void {
		for (const [tool, b] of this.toolButtons) {
			const on = tools.includes(tool);
			b.toggleClass("is-suggested", on);
			if (on) b.dataset.suggested = "true";
			else delete b.dataset.suggested;
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

	/** 0.11.2: shows (or hides) that the next pen stroke erases, armed by the pen button or the pen key. */
	setEraserNext(armed: boolean): void {
		if (this.eraserNext === armed) return;
		this.eraserNext = armed;
		this.renderChip();
	}

	/** `locked` (0.16, #124): the page in view is locked; a small lock shows beside the number. */
	setPage(current: number, total: number, locked = false): void {
		this.pageButton.setText(total > 0 ? `${current} / ${total}` : "–");
		this.pageButton.toggleClass("is-locked", locked && total > 0);
		if (locked && total > 0) setIcon(this.pageButton.createSpan({ cls: "nb-ui nb-lock-mark", attr: { "aria-hidden": "true" } }), "lock");
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
		// A popover never grows past the bottom of the view (a phone held sideways has little room): it scrolls instead. It also
		// leaves a strip of page below it, so that a tap on the page still closes it (the new pens made the pen options taller).
		const host = this.el.parentElement;
		if (open && host) {
			const room = host.getBoundingClientRect().bottom - this.optionsEl.getBoundingClientRect().top - 8 - 56;
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
		this.selectGroup.toggleClass("notebook-hidden", s.tool !== "lasso");
		for (const [mode, b] of this.selectButtons) {
			b.toggleClass("is-active", mode === s.selectMode);
			b.setAttribute("aria-pressed", String(mode === s.selectMode));
			b.disabled = !this.editable;
		}
		this.shapeGroup.toggleClass("notebook-hidden", s.tool !== "shape");
		for (const [kind, b] of this.shapeButtons) {
			b.toggleClass("is-active", kind === s.shapeKind);
			b.disabled = !this.editable;
		}
		// 0.24 (#37): fill (closed shapes only: the rectangle and the ellipse) and line style of the shape tool.
		this.shapeStyleEl.toggleClass("notebook-hidden", s.tool !== "shape");
		this.shapeStyleEl.empty();
		if (s.tool === "shape") {
			renderShapeStyle(this.shapeStyleEl, {
				showFill: s.shapeKind === "rectangle" || s.shapeKind === "ellipse",
				showLine: true,
				fill: s.shapeFill,
				fillColor: s.shapeFillColor === null ? "line" : s.shapeFillColor.toLowerCase(),
				line: s.shapeLine,
				colours: PEN_COLORS,
				editable: this.editable,
			}, {
				setFill: (shapeFill) => this.set({ shapeFill }),
				setFillColor: (c) => this.set({ shapeFillColor: c === "line" ? null : c }),
				setLine: (shapeLine) => this.set({ shapeLine }),
			});
		}

		const inking = s.tool === "pen" || s.tool === "highlighter" || s.tool === "shape";
		const erasingColor = s.tool === "eraser" && s.eraserFilter === "color";
		const colouring = inking || s.tool === "text" || erasingColor;
		this.penSetsEl.toggleClass("notebook-hidden", s.tool !== "pen" && s.tool !== "highlighter");
		// 0.22 (#35): the pen kinds are the pen tool's options; the nib angle belongs to the fountain pen and the marker.
		const penTool = s.tool === "pen";
		this.penKindGroup.toggleClass("notebook-hidden", !penTool);
		for (const [kind, b] of this.penKindButtons) {
			b.toggleClass("is-active", kind === s.penKind);
			b.setAttribute("aria-pressed", String(kind === s.penKind));
			b.disabled = !this.editable;
		}
		this.nibGroup.toggleClass("notebook-hidden", !(penTool && kindHasNib(s.penKind)));
		this.nibSlider.disabled = !this.editable;
		this.nibSlider.value = String(s.nibAngle);
		this.showNib(s.nibAngle);
		this.colorGroup.toggleClass("notebook-hidden", !colouring);
		// 0.25 (#99): an area highlighter has no stroke width and does not snap to text lines: those rows go while the highlighter is in Area mode.
		const areaMode = s.tool === "highlighter" && s.highlighterArea;
		this.widthGroup.toggleClass("notebook-hidden", !inking || areaMode);
		this.sizeGroup.toggleClass("notebook-hidden", s.tool !== "text");
		this.highlighterModeGroup.toggleClass("notebook-hidden", s.tool !== "highlighter");
		for (const [area, b] of this.highlighterModeButtons) {
			b.toggleClass("is-active", area === s.highlighterArea);
			b.setAttribute("aria-pressed", String(area === s.highlighterArea));
			b.disabled = !this.editable;
		}
		this.highlighterOptionsEl.toggleClass("notebook-hidden", s.tool !== "highlighter" || areaMode);
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
			// 0.26 zoomwidth (#350): with "Pen width follows zoom" on, the on-screen width and a "× zoom" hint.
			this.zoomHintEl = this.widthGroup.createSpan({ cls: "notebook-zoom-hint notebook-hidden" });
			this.paintZoomHint();
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

	/** 0.26 zoomwidth (#350): `null` hides the hint (option off); otherwise the effective on-screen width and the stored page width. */
	setZoomHint(hint: { screen: number; page: number } | null): void {
		const same = hint === this.zoomHint || (hint && this.zoomHint && hint.screen === this.zoomHint.screen && hint.page === this.zoomHint.page);
		this.zoomHint = hint;
		if (!same) this.paintZoomHint();
	}

	private paintZoomHint(): void {
		const el = this.zoomHintEl;
		const h = this.zoomHint;
		if (!el) return;
		el.toggleClass("notebook-hidden", !h);
		if (!h) return;
		const n = (v: number) => String(Math.round(v * 10) / 10);
		el.setText(t("tool.widthZoom.hint", { px: n(h.screen), page: n(h.page) }));
		el.setAttribute("aria-label", t("tool.widthZoom.aria", { px: n(h.screen), page: n(h.page) }));
	}

	/** The angle in the nib row: the number and the little bar that leans like the nib. */
	private showNib(angle: number): void {
		this.nibValue.setText(`${angle}°`);
		this.nibSlider.setAttribute("aria-label", t("tool.nib.value", { angle: String(angle) }));
		this.nibPreview.setCssProps({ "--notebook-nib-angle": `${-angle}deg` });
	}

	/** The current-pen indicator: colour and thickness of the tool in use; a ring the size of the eraser for the eraser. */
	private renderChip(): void {
		const s = this.state;
		// The lasso has options (its shape) but no pen to show: the indicator stays for the tools that draw or erase.
		const has = TOOLS_WITH_OPTIONS.has(s.tool) && s.tool !== "lasso";
		this.chipButton.toggleClass("notebook-hidden", !has);
		this.chipButton.disabled = !this.editable;
		const dot = this.chipDot;
		dot.toggleClass("is-eraser", s.tool === "eraser");
		dot.toggleClass("is-highlighter", s.tool === "highlighter");
		for (const kind of PEN_KINDS) if (kind !== "pen") dot.toggleClass(`is-kind-${kind}`, s.tool === "pen" && s.penKind === kind);
		this.chipButton.toggleClass("is-eraser-next", this.eraserNext);
		if (!has) return;
		const toolLabel = t(s.tool === "pen" ? KIND_LABEL[s.penKind] : TOOL_DEFS.find((d) => d[0] === s.tool)![2]);
		const armed = this.eraserNext ? ` (${t("penButton.eraserNextArmed")})` : "";
		this.chipButton.setAttribute("aria-label", `${t("toolbar.options")}: ${toolLabel}${armed}`);
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
