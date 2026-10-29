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
	pageMenu(evt: MouseEvent): void;
	deleteSelection(): void;
	fit(): void;
	toggleNavigator(): void;
	insertImage(): void;
	boardShot(): void;
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

export class Toolbar {
	readonly el: HTMLElement;
	private readonly toolButtons = new Map<ToolName, HTMLButtonElement>();
	private readonly colorGroup: HTMLElement;
	private readonly widthGroup: HTMLElement;
	private readonly eraserGroup: HTMLElement;
	private readonly eraserButtons = new Map<EraserMode, HTMLButtonElement>();
	private readonly filterGroup: HTMLElement;
	private readonly filterButtons = new Map<EraseFilterKind, HTMLButtonElement>();
	private readonly shapeGroup: HTMLElement;
	private readonly shapeButtons = new Map<ShapeKind, HTMLButtonElement>();
	private readonly sizeGroup: HTMLElement;
	private readonly rulerButton: HTMLButtonElement;
	private readonly imageButton: HTMLButtonElement;
	private readonly boardShotButton: HTMLButtonElement;
	private readonly navigatorButton: HTMLButtonElement;
	private readonly undoButton: HTMLButtonElement;
	private readonly redoButton: HTMLButtonElement;
	private readonly addPageButton: HTMLButtonElement;
	private readonly pageMenuButton: HTMLButtonElement;
	private readonly deleteButton: HTMLButtonElement;
	private readonly pageEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private editable = false;
	/** Slots filled by pen-controls.ts: favourite pens, eraser size, pen-only toggle. */
	readonly favouritesEl: HTMLElement;
	readonly eraserSizeEl: HTMLElement;
	readonly penOnlyEl: HTMLElement;
	onEditableChange: ((editable: boolean) => void) | null = null;

	constructor(parent: HTMLElement, public state: ToolbarState, private readonly actions: ToolbarActions) {
		this.el = parent.createDiv({ cls: "notebook-toolbar" });

		this.navigatorButton = this.iconButton(this.group(), "panel-left", "tool.pages", () => this.actions.toggleNavigator());

		const tools = this.group();
		for (const [tool, icon, label] of TOOL_DEFS) {
			this.toolButtons.set(tool, this.iconButton(tools, icon, label, () => this.set({ tool })));
		}

		this.eraserGroup = this.group();
		this.eraserButtons.set("stroke", this.textButton(this.eraserGroup, "tool.eraser.stroke", () => this.set({ eraserMode: "stroke" })));
		this.eraserButtons.set("segment", this.textButton(this.eraserGroup, "tool.eraser.segment", () => this.set({ eraserMode: "segment" })));
		this.eraserButtons.set("area", this.textButton(this.eraserGroup, "tool.eraser.area", () => this.set({ eraserMode: "area" })));

		this.filterGroup = this.group();
		for (const kind of ERASE_FILTER_KINDS) {
			this.filterButtons.set(kind, this.textButton(this.filterGroup, FILTER_LABELS[kind], () =>
				// "Colour" starts from the pen colour in use; the swatches then change it.
				this.set(kind === "color" ? { eraserFilter: kind, eraserColor: this.state.penColor } : { eraserFilter: kind })));
		}

		this.eraserSizeEl = this.group();
		this.penOnlyEl = this.group();
		this.favouritesEl = this.group();

		this.shapeGroup = this.group();
		for (const kind of SHAPE_KINDS) {
			const [icon, label] = SHAPE_DEFS[kind];
			this.shapeButtons.set(kind, this.iconButton(this.shapeGroup, icon, label, () => this.set({ shapeKind: kind })));
		}

		this.colorGroup = this.group();
		this.widthGroup = this.group();
		this.sizeGroup = this.group();

		const insert = this.group();
		this.imageButton = this.iconButton(insert, "image-plus", "tool.image", () => this.actions.insertImage());
		this.boardShotButton = this.iconButton(insert, "camera", "tool.boardShot", () => this.actions.boardShot());
		this.rulerButton = this.iconButton(insert, "ruler", "tool.ruler", () => this.set({ ruler: !this.state.ruler }));

		this.deleteButton = this.iconButton(this.group(), "trash-2", "tool.deleteSelection", () => this.actions.deleteSelection());

		const history = this.group();
		this.undoButton = this.iconButton(history, "undo", "tool.undo", () => this.actions.undo());
		this.redoButton = this.iconButton(history, "redo", "tool.redo", () => this.actions.redo());

		const pages = this.group();
		this.addPageButton = this.iconButton(pages, "file-plus", "tool.addPage", () => this.actions.addPage());
		this.pageMenuButton = this.iconButton(pages, "more-vertical", "page.menu", () => undefined);
		this.pageMenuButton.addEventListener("click", (e) => this.actions.pageMenu(e));
		this.iconButton(pages, "move-horizontal", "tool.fit", () => this.actions.fit());
		this.pageEl = pages.createSpan({ cls: "notebook-page-indicator" });

		this.statusEl = this.el.createSpan({ cls: "notebook-status" });
		this.render();
	}

	setHistory(canUndo: boolean, canRedo: boolean): void {
		this.undoButton.disabled = !this.editable || !canUndo;
		this.redoButton.disabled = !this.editable || !canRedo;
	}

	setEditable(editable: boolean): void {
		this.editable = editable;
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
		this.pageEl.setText(total > 0 ? `${current} / ${total}` : "");
	}

	setStatus(text: string, kind: "ok" | "pending" | "error"): void {
		this.statusEl.setText(text);
		this.statusEl.dataset.kind = kind;
	}

	private set(patch: Partial<ToolbarState>): void {
		this.state = { ...this.state, ...patch };
		this.render();
		this.actions.change(this.state);
	}

	/** Rebuilds the colour and width rows for the current tool. */
	private render(): void {
		const s = this.state;
		for (const [tool, b] of this.toolButtons) {
			b.toggleClass("is-active", tool === s.tool);
			b.disabled = !this.editable;
		}
		this.addPageButton.disabled = !this.editable;
		this.pageMenuButton.disabled = !this.editable;
		this.imageButton.disabled = !this.editable;
		this.boardShotButton.disabled = !this.editable;
		this.navigatorButton.disabled = !this.editable;
		this.rulerButton.disabled = !this.editable;
		this.rulerButton.toggleClass("is-active", s.ruler);
		this.rulerButton.setAttribute("aria-pressed", String(s.ruler));
		this.eraserGroup.toggleClass("notebook-hidden", s.tool !== "eraser");
		this.eraserSizeEl.toggleClass("notebook-hidden", s.tool !== "eraser");
		for (const [mode, b] of this.eraserButtons) b.toggleClass("is-active", mode === s.eraserMode);
		this.filterGroup.toggleClass("notebook-hidden", s.tool !== "eraser");
		for (const [kind, b] of this.filterButtons) b.toggleClass("is-active", kind === s.eraserFilter);
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

	private group(): HTMLElement {
		return this.el.createDiv({ cls: "notebook-toolbar-group" });
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
