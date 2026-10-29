import { setIcon } from "obsidian";
import { t } from "../i18n";
import { clampCenter, pushRecentColor, recentColors, sectorAt, sectorPath, sectorPoint, type RadialShape } from "../ink/radial";
import { HIGHLIGHTER_COLORS, PEN_COLORS, type ToolbarState, type ToolName } from "./toolbar";

export interface RadialItem {
	id: string;
	label: string;
	/** Lucide icon name. */
	icon?: string;
	/** Colour swatch instead of an icon. */
	color?: string;
	active?: boolean;
	disabled?: boolean;
}

/** Ring size in CSS px: big enough for a fingertip and a pen tip. */
export const RADIAL_INNER = 36;
export const RADIAL_OUTER = 108;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A ring of items around a point (the pen tip). Choosing: lift the pen (or tap) on a sector; lifting
 * or tapping anywhere else closes it, as does Escape. While it is open it takes every pointer event
 * (window capture phase), so nothing reaches the page underneath and no stroke can start.
 */
export class RadialMenu {
	private root: HTMLElement | null = null;
	private items: RadialItem[] = [];
	private shape: RadialShape = { inner: RADIAL_INNER, outer: RADIAL_OUTER, count: 0 };
	private cx = 0;
	private cy = 0;
	private hover = -1;
	private sectors: SVGPathElement[] = [];
	private cells: HTMLElement[] = [];
	private labelEl: HTMLElement | null = null;
	private readonly down = new Set<number>();
	/** The side button was down when the menu opened and has not been seen released yet. */
	private buttonHeld = false;
	private readonly listeners: Array<() => void> = [];

	constructor(private readonly host: HTMLElement, private readonly choose: (id: string) => void) {}

	get isOpen(): boolean {
		return this.root !== null;
	}

	/** Opens the menu centred near (x, y) (CSS px relative to the host). `buttonHeld`: the pen's side button is still down. */
	open(x: number, y: number, items: RadialItem[], buttonHeld = true): void {
		this.close();
		if (items.length === 0) return;
		const rect = this.host.getBoundingClientRect();
		[this.cx, this.cy] = clampCenter(x, y, rect.width, rect.height, RADIAL_OUTER);
		this.items = items;
		this.shape = { inner: RADIAL_INNER, outer: RADIAL_OUTER, count: items.length };
		this.hover = -1;
		this.down.clear();
		this.buttonHeld = buttonHeld;
		this.build();
		this.listen("pointerdown", (e) => this.onDown(e as PointerEvent));
		this.listen("pointermove", (e) => this.onMove(e as PointerEvent));
		this.listen("pointerup", (e) => this.onUp(e as PointerEvent));
		this.listen("pointercancel", (e) => this.swallow(e));
		this.listen("contextmenu", (e) => e.preventDefault());
		this.listen("keydown", (e) => {
			if ((e as KeyboardEvent).key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.close();
			}
		});
	}

	close(): void {
		for (const off of this.listeners) off();
		this.listeners.length = 0;
		this.root?.remove();
		this.root = null;
		this.sectors = [];
		this.cells = [];
		this.labelEl = null;
		this.items = [];
		this.down.clear();
	}

	destroy(): void {
		this.close();
	}

	private listen(type: string, fn: (e: Event) => void): void {
		window.addEventListener(type, fn, true);
		this.listeners.push(() => window.removeEventListener(type, fn, true));
	}

	private build(): void {
		const root = this.host.createDiv({ cls: "notebook-radial", attr: { role: "menu", "aria-label": t("radial.label") } });
		this.root = root;
		const size = RADIAL_OUTER * 2;
		root.setCssProps({ "--notebook-radial-x": `${this.cx}px`, "--notebook-radial-y": `${this.cy}px`, "--notebook-radial-size": `${size}px` });
		const ring = root.createDiv({ cls: "notebook-radial-ring" });
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "notebook-radial-svg");
		svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
		svg.setAttribute("aria-hidden", "true");
		ring.appendChild(svg);
		this.sectors = [];
		this.cells = [];
		const mid = (RADIAL_INNER + RADIAL_OUTER) / 2;
		this.items.forEach((item, i) => {
			const path = document.createElementNS(SVG_NS, "path");
			path.setAttribute("d", sectorPath(this.shape, RADIAL_OUTER, RADIAL_OUTER, i));
			path.setAttribute("class", `notebook-radial-sector${item.active ? " is-active" : ""}${item.disabled ? " is-disabled" : ""}`);
			svg.appendChild(path);
			this.sectors.push(path);
			const [px, py] = sectorPoint(RADIAL_OUTER, RADIAL_OUTER, mid, i, this.items.length);
			const cell = ring.createDiv({
				cls: `notebook-radial-item${item.disabled ? " is-disabled" : ""}`,
				attr: { role: "menuitem", "aria-label": item.label, ...(item.disabled ? { "aria-disabled": "true" } : {}) },
			});
			this.cells.push(cell);
			cell.setCssProps({ "--notebook-radial-item-x": `${px}px`, "--notebook-radial-item-y": `${py}px` });
			if (item.color) {
				cell.createSpan({ cls: "notebook-swatch-dot" }).setCssProps({ "--notebook-swatch-color": item.color });
			} else if (item.icon) {
				setIcon(cell, item.icon);
			}
		});
		// A solid hub so the label in the middle is readable over the page.
		const hub = document.createElementNS(SVG_NS, "circle");
		hub.setAttribute("cx", String(RADIAL_OUTER));
		hub.setAttribute("cy", String(RADIAL_OUTER));
		hub.setAttribute("r", String(RADIAL_INNER - 2));
		hub.setAttribute("class", "notebook-radial-hub");
		svg.appendChild(hub);
		this.labelEl = ring.createDiv({ cls: "notebook-radial-label" });
	}

	/** Pointer position in the ring's own coordinates. */
	private local(e: PointerEvent): [number, number] {
		const rect = this.host.getBoundingClientRect();
		return [e.clientX - rect.left - this.cx + RADIAL_OUTER, e.clientY - rect.top - this.cy + RADIAL_OUTER];
	}

	private indexAt(e: PointerEvent): number {
		const [x, y] = this.local(e);
		return sectorAt(this.shape, RADIAL_OUTER, RADIAL_OUTER, x, y);
	}

	private swallow(e: Event): void {
		e.stopPropagation();
	}

	private setHover(i: number): void {
		if (i === this.hover) return;
		this.hover = i;
		this.sectors.forEach((s, k) => s.classList.toggle("is-hover", k === i && !this.items[k]?.disabled));
		this.cells.forEach((c, k) => c.classList.toggle("is-hover", k === i && !this.items[k]?.disabled));
		this.labelEl?.setText(i >= 0 ? this.items[i]?.label ?? "" : "");
	}

	private onDown(e: PointerEvent): void {
		this.swallow(e);
		e.preventDefault();
		this.down.add(e.pointerId);
		this.setHover(this.indexAt(e));
	}

	private onMove(e: PointerEvent): void {
		this.swallow(e);
		const i = this.indexAt(e);
		this.setHover(i);
		if (e.pointerType !== "pen") return;
		// Opened by pressing the side button: releasing it over a sector chooses that sector.
		const held = (e.buttons & 2) !== 0;
		if (this.buttonHeld && !held) {
			this.buttonHeld = false;
			if (i >= 0) this.pick(i);
		} else if (held) {
			this.buttonHeld = true;
		}
	}

	private onUp(e: PointerEvent): void {
		this.swallow(e);
		e.preventDefault();
		const i = this.indexAt(e);
		const tapped = this.down.delete(e.pointerId);
		if (i >= 0) {
			this.pick(i);
		} else if (tapped) {
			// A tap outside the ring or in its middle closes it. An up without a down is the lift that
			// opened the menu: it stays open.
			this.close();
		}
	}

	private pick(i: number): void {
		const item = this.items[i];
		if (!item || item.disabled) return;
		this.close();
		this.choose(item.id);
	}
}

/** What the view lets the radial menu do. */
export interface RadialContext {
	editable(): boolean;
	tools(): ToolbarState;
	/** Changes the toolbar state (tool, colour) as if its buttons were pressed. */
	apply(patch: Partial<ToolbarState>): void;
	canUndo(): boolean;
	undo(): void;
}

const TOOL_ITEMS: Array<[ToolName, string, "tool.pen" | "tool.highlighter" | "tool.eraser" | "tool.lasso"]> = [
	["pen", "pencil", "tool.pen"],
	["highlighter", "highlighter", "tool.highlighter"],
	["eraser", "eraser", "tool.eraser"],
	["lasso", "lasso", "tool.lasso"],
];

/** Number of recent-colour sectors. */
const COLOR_SLOTS = 3;

/** The pen's quick menu: tools, undo and the last pen colours. */
export class PenRadial {
	private readonly menu: RadialMenu;
	private recent: string[] = [];

	constructor(host: HTMLElement, private readonly ctx: RadialContext) {
		this.menu = new RadialMenu(host, (id) => this.run(id));
		this.recent = [ctx.tools().penColor];
	}

	get isOpen(): boolean {
		return this.menu.isOpen;
	}

	/** Remembers pen colours as they are used (toolbar or this menu). */
	noteTools(state: ToolbarState): void {
		if (this.recent[0]?.toLowerCase() !== state.penColor.toLowerCase()) this.recent = pushRecentColor(this.recent, state.penColor);
	}

	open(x: number, y: number): void {
		if (!this.ctx.editable() || this.menu.isOpen) return;
		const tools = this.ctx.tools();
		const items: RadialItem[] = TOOL_ITEMS.map(([tool, icon, label]) => ({ id: `tool:${tool}`, label: t(label), icon, active: tools.tool === tool }));
		items.push({ id: "undo", label: t("tool.undo"), icon: "undo", disabled: !this.ctx.canUndo() });
		// Counter-clockwise from the pen, so the most recent colour is next to it.
		const colors = recentColors(this.recent, [...PEN_COLORS, ...HIGHLIGHTER_COLORS], COLOR_SLOTS);
		for (const color of colors.reverse()) {
			items.push({ id: `color:${color}`, label: `${t("tool.color")} ${color}`, color, active: tools.tool === "pen" && tools.penColor.toLowerCase() === color.toLowerCase() });
		}
		this.menu.open(x, y, items);
	}

	close(): void {
		this.menu.close();
	}

	destroy(): void {
		this.menu.destroy();
	}

	private run(id: string): void {
		if (!this.ctx.editable()) return;
		if (id === "undo") {
			this.ctx.undo();
		} else if (id.startsWith("tool:")) {
			this.ctx.apply({ tool: id.slice(5) as ToolName });
		} else if (id.startsWith("color:")) {
			this.ctx.apply({ tool: "pen", penColor: id.slice(6) });
		}
	}
}
