import { setIcon } from "obsidian";
import { t, type MessageKey } from "../i18n";

export type ToolName = "pen" | "eraser";

export const COLORS = ["#1e1e1e", "#1d4ed8", "#dc2626", "#15803d"] as const;
export const WIDTHS: ReadonlyArray<{ width: number; label: MessageKey }> = [
	{ width: 1.2, label: "tool.width.fine" },
	{ width: 2, label: "tool.width.medium" },
	{ width: 3.2, label: "tool.width.thick" },
];

export interface ToolbarState {
	tool: ToolName;
	color: string;
	width: number;
}

export interface ToolbarActions {
	change(state: ToolbarState): void;
	undo(): void;
	redo(): void;
	fit(): void;
}

export class Toolbar {
	readonly el: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly toolButtons = new Map<ToolName, HTMLButtonElement>();
	private readonly colorButtons = new Map<string, HTMLButtonElement>();
	private readonly widthButtons = new Map<number, HTMLButtonElement>();
	private readonly undoButton: HTMLButtonElement;
	private readonly redoButton: HTMLButtonElement;
	private readonly editButtons: HTMLButtonElement[] = [];

	constructor(parent: HTMLElement, public state: ToolbarState, private readonly actions: ToolbarActions) {
		this.el = parent.createDiv({ cls: "notebook-toolbar" });

		const tools = this.group();
		this.toolButtons.set("pen", this.iconButton(tools, "pencil", "tool.pen", () => this.set({ tool: "pen" })));
		this.toolButtons.set("eraser", this.iconButton(tools, "eraser", "tool.eraser", () => this.set({ tool: "eraser" })));

		const colors = this.group();
		for (const color of COLORS) {
			const b = this.button(colors, `${t("tool.color")} ${color}`, () => this.set({ color, tool: "pen" }));
			b.addClass("notebook-swatch");
			b.createSpan({ cls: "notebook-swatch-dot" }).setCssProps({ "--notebook-swatch-color": color });
			this.colorButtons.set(color, b);
		}

		const widths = this.group();
		WIDTHS.forEach(({ width, label }, i) => {
			const b = this.button(widths, t(label), () => this.set({ width, tool: "pen" }));
			b.addClass("notebook-width");
			b.createSpan({ cls: `notebook-width-dot notebook-width-${i}` });
			this.widthButtons.set(width, b);
		});

		const history = this.group();
		this.undoButton = this.iconButton(history, "undo", "tool.undo", () => this.actions.undo());
		this.redoButton = this.iconButton(history, "redo", "tool.redo", () => this.actions.redo());

		const view = this.group();
		this.iconButton(view, "move-horizontal", "tool.fit", () => this.actions.fit());

		this.statusEl = this.el.createSpan({ cls: "notebook-status" });
		this.editButtons.push(...this.toolButtons.values(), ...this.colorButtons.values(), ...this.widthButtons.values());
		this.render();
	}

	setHistory(canUndo: boolean, canRedo: boolean): void {
		this.undoButton.disabled = !canUndo;
		this.redoButton.disabled = !canRedo;
	}

	setEditable(editable: boolean): void {
		for (const b of this.editButtons) b.disabled = !editable;
		if (!editable) this.setHistory(false, false);
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

	private render(): void {
		for (const [tool, b] of this.toolButtons) b.toggleClass("is-active", tool === this.state.tool);
		for (const [color, b] of this.colorButtons) b.toggleClass("is-active", color === this.state.color);
		for (const [width, b] of this.widthButtons) b.toggleClass("is-active", width === this.state.width);
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
}
