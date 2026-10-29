import { setIcon } from "obsidian";
import { t, type MessageKey } from "../i18n";

export type ToolName = "pen" | "highlighter" | "eraser" | "lasso";
export type EraserMode = "stroke" | "segment";

export const PEN_COLORS = ["#1e1e1e", "#6b7280", "#1d4ed8", "#0891b2", "#15803d", "#ca8a04", "#ea580c", "#dc2626", "#9333ea"] as const;
export const HIGHLIGHTER_COLORS = ["#facc15", "#4ade80", "#f472b6", "#60a5fa", "#fb923c"] as const;
export const PEN_WIDTHS = [0.8, 1.2, 2, 3.2, 5] as const;
export const HIGHLIGHTER_WIDTHS = [8, 14, 20] as const;

export interface ToolbarState {
	tool: ToolName;
	penColor: string;
	penWidth: number;
	highlighterColor: string;
	highlighterWidth: number;
	eraserMode: EraserMode;
}

export const DEFAULT_TOOLS: ToolbarState = {
	tool: "pen",
	penColor: PEN_COLORS[0],
	penWidth: PEN_WIDTHS[2],
	highlighterColor: HIGHLIGHTER_COLORS[0],
	highlighterWidth: HIGHLIGHTER_WIDTHS[1],
	eraserMode: "stroke",
};

export interface ToolbarActions {
	change(state: ToolbarState): void;
	undo(): void;
	redo(): void;
	addPage(): void;
	pageMenu(evt: MouseEvent): void;
	deleteSelection(): void;
	fit(): void;
}

export class Toolbar {
	readonly el: HTMLElement;
	private readonly toolButtons = new Map<ToolName, HTMLButtonElement>();
	private readonly colorGroup: HTMLElement;
	private readonly widthGroup: HTMLElement;
	private readonly eraserGroup: HTMLElement;
	private readonly eraserButtons = new Map<EraserMode, HTMLButtonElement>();
	private readonly undoButton: HTMLButtonElement;
	private readonly redoButton: HTMLButtonElement;
	private readonly addPageButton: HTMLButtonElement;
	private readonly pageMenuButton: HTMLButtonElement;
	private readonly deleteButton: HTMLButtonElement;
	private readonly pageEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private editable = false;

	constructor(parent: HTMLElement, public state: ToolbarState, private readonly actions: ToolbarActions) {
		this.el = parent.createDiv({ cls: "notebook-toolbar" });

		const tools = this.group();
		const toolDefs: Array<[ToolName, string, MessageKey]> = [
			["pen", "pencil", "tool.pen"],
			["highlighter", "highlighter", "tool.highlighter"],
			["eraser", "eraser", "tool.eraser"],
			["lasso", "lasso", "tool.lasso"],
		];
		for (const [tool, icon, label] of toolDefs) {
			this.toolButtons.set(tool, this.iconButton(tools, icon, label, () => this.set({ tool })));
		}

		this.eraserGroup = this.group();
		this.eraserButtons.set("stroke", this.textButton(this.eraserGroup, "tool.eraser.stroke", () => this.set({ eraserMode: "stroke" })));
		this.eraserButtons.set("segment", this.textButton(this.eraserGroup, "tool.eraser.segment", () => this.set({ eraserMode: "segment" })));

		this.colorGroup = this.group();
		this.widthGroup = this.group();

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
		if (!editable) this.setHistory(false, false);
	}

	setSelection(active: boolean): void {
		this.deleteButton.toggleClass("notebook-hidden", !active);
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
		this.eraserGroup.toggleClass("notebook-hidden", s.tool !== "eraser");
		for (const [mode, b] of this.eraserButtons) b.toggleClass("is-active", mode === s.eraserMode);

		const inking = s.tool === "pen" || s.tool === "highlighter";
		this.colorGroup.toggleClass("notebook-hidden", !inking);
		this.widthGroup.toggleClass("notebook-hidden", !inking);
		this.colorGroup.empty();
		this.widthGroup.empty();
		if (!inking) return;

		const highlighter = s.tool === "highlighter";
		const colors = highlighter ? HIGHLIGHTER_COLORS : PEN_COLORS;
		const current = highlighter ? s.highlighterColor : s.penColor;
		for (const color of colors) {
			const b = this.button(this.colorGroup, `${t("tool.color")} ${color}`, () =>
				this.set(highlighter ? { highlighterColor: color } : { penColor: color }));
			b.addClass("notebook-swatch");
			b.toggleClass("is-active", color === current);
			b.disabled = !this.editable;
			b.createSpan({ cls: "notebook-swatch-dot" }).setCssProps({ "--notebook-swatch-color": color });
		}

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
