import { dialScale, type ToolbarSize } from "../ui/toolbar-size";
import { setIcon } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { clampCenter, fingerMenuCenter, pushRecentColor } from "../ink/radial";
import type { MenuSource } from "../ink/pointer-controller";
import type { ToolId } from "../ui/actions";
import {
	angleOf, arcAngles, bubbleDot, colourSlot, DIAL_RADIUS, DIAL_SIZE, formatWidth, MARKER_RING, nearestStep, paletteFor, PEN_CASE, polar, RING_RADIUS, ringAngles,
	SLIDER_END, SLIDER_START, stepAtAngle, stepDotRadius, widthScale, type DialState,
} from "../ui/radial-model";
import type { FavouritePen } from "./favourites";
import type { ShapeKind } from "./view-helpers";
import type { ToolbarState, ToolName } from "./toolbar";

const SVG_NS = "http://www.w3.org/2000/svg";

/** What the view lets the radial menu do. The members after `undo` are optional (the dial hides what is missing). */
export interface RadialContext {
	editable(): boolean;
	/** wave 0.9 (370): the toolbar size setting scales the dial. */
	toolbarSize?(): ToolbarSize;
	tools(): ToolbarState;
	/** Changes the toolbar state (tool, colour, width) as if its buttons were pressed. */
	apply(patch: Partial<ToolbarState>): void;
	canUndo(): boolean;
	undo(): void;
	canRedo?(): boolean;
	redo?(): void;
	favourites?(): readonly FavouritePen[];
	applyFavourite?(index: number): void;
	saveFavourite?(index: number): void;
	toggleRuler?(): void;
	/** wave 0.8: arms a marker or a structured box (view/markers.ts); the next contact on a page places it. */
	placeMarker?(kind: (typeof MARKER_RING)[number][0]): void;
	/** Shows a short message (eyedropper hint). */
	notify?(text: string): void;
}

const TOOL_LABEL: Record<ToolId, MessageKey> = {
	pen: "tool.pen", highlighter: "tool.highlighter", eraser: "tool.eraser", lasso: "tool.lasso", shape: "tool.shape", text: "tool.text", space: "tool.space",
};
const TOOL_ICON: Record<ToolId, string> = {
	pen: "pencil", highlighter: "highlighter", eraser: "eraser", lasso: "lasso", shape: "shapes", text: "type", space: "move-vertical",
};
const SHAPES: Array<[ShapeKind, string, MessageKey]> = [
	["line", "minus", "shape.line"], ["arrow", "arrow-up-right", "shape.arrow"], ["rectangle", "square", "shape.rectangle"], ["ellipse", "circle", "shape.ellipse"],
];

function svg(parent: Element, tag: string, attrs: Record<string, string | number>): SVGElement {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	parent.appendChild(el);
	return el;
}

/** Short tool name for the caption ("Insert or remove space: …" → "Insert or remove space"). */
function shortLabel(tool: ToolId): string {
	return t(TOOL_LABEL[tool]).split(":")[0]!;
}

let gradientId = 0;

/**
 * The drawing of a tool as a physical pen (pen: body, cone, nib and a band in its colour; highlighter: a chisel marker;
 * eraser: a block), pointing down, in a 40 × 80 box. Other tools are drawn as their icon by the caller.
 */
function drawPen(parent: Element, tool: ToolId, color: string): void {
	const g = svg(parent, "g", {});
	const id = `notebook-pen-gradient-${++gradientId}`;
	const defs = svg(g, "defs", {});
	const grad = svg(defs, "linearGradient", { id, x1: 0, x2: 1, y1: 0, y2: 0 });
	svg(grad, "stop", { offset: "0", "stop-color": "#f5f5f7" });
	svg(grad, "stop", { offset: "0.55", "stop-color": "#d6d7dd" });
	svg(grad, "stop", { offset: "1", "stop-color": "#9c9daa" });
	if (tool === "highlighter") {
		svg(g, "rect", { x: 10, y: 2, width: 20, height: 50, rx: 5, fill: `url(#${id})` });
		svg(g, "rect", { x: 10, y: 38, width: 20, height: 10, fill: color });
		svg(g, "path", { d: "M10 52h20v8l-14 12h-6z", fill: `url(#${id})` });
		svg(g, "path", { d: "M12 66l14-12v6l-14 12z", fill: color });
	} else if (tool === "eraser") {
		svg(g, "rect", { x: 9, y: 8, width: 22, height: 62, rx: 6, fill: `url(#${id})` });
		svg(g, "rect", { x: 9, y: 50, width: 22, height: 20, rx: 6, fill: "#f0a3b5" });
		svg(g, "rect", { x: 9, y: 46, width: 22, height: 6, fill: "#8b8c98" });
	} else {
		svg(g, "rect", { x: 13, y: 2, width: 14, height: 52, rx: 4, fill: `url(#${id})` });
		svg(g, "rect", { x: 13, y: 40, width: 14, height: 7, fill: color });
		svg(g, "path", { d: "M13 54h14l-5 16h-4z", fill: "#e9d8bf" });
		svg(g, "path", { d: "M18 70h4l-2 8z", fill: color });
	}
}

/**
 * The pen's radial dial (ui redesign, docs/design-ui.md §6): a dark dial at the pen tip with undo/redo, a width bubble,
 * a colour bubble, the active tool drawn as a pen, and favourites · pen case · shapes. Each bubble turns the ring into
 * its own control (colour ring, width arc slider, pen case, favourites, shapes). While it is open it takes every pointer
 * event (window capture phase), so nothing reaches the page underneath and no stroke can start; Escape or a tap outside
 * closes it. The public API used by the input code is unchanged: open(x, y), close(), noteTools(state), isOpen, destroy().
 */
export class PenRadial {
	private root: HTMLElement | null = null;
	private dial: HTMLElement | null = null;
	private layer: HTMLElement | null = null;
	private live: HTMLElement | null = null;
	private colorInput: HTMLInputElement | null = null;
	private recent: string[] = [];
	private cx = 0;
	private cy = 0;
	/** The dial is scaled down when the page area is smaller than it (a phone held sideways). */
	private scale = 1;
	private dialState: DialState = "main";
	private saveMode = false;
	private readonly listeners: Array<() => void> = [];
	/** Pointer down: the action under it ("" inside the dial, null outside); a tap acts when the up lands on the same action. */
	private readonly downs = new Map<number, string | null>();
	private sliding: number | null = null;
	private buttonHeld = false;
	private hover: HTMLElement | null = null;
	private eyedropperOff: (() => void) | null = null;

	constructor(private readonly host: HTMLElement, private readonly ctx: RadialContext) {
		this.recent = [ctx.tools().penColor];
	}

	get isOpen(): boolean {
		return this.root !== null;
	}

	/** The state shown (main, color, width, tools, favourites, shapes), null when closed; for tests and the harness. */
	get state(): DialState | null {
		return this.root ? this.dialState : null;
	}

	/** Most recently used pen colours, newest first. */
	get recentColors(): readonly string[] {
		return this.recent;
	}

	/** Remembers pen colours as they are used (toolbar or this menu) and keeps an open dial up to date. */
	noteTools(state: ToolbarState): void {
		if (this.recent[0]?.toLowerCase() !== state.penColor.toLowerCase()) this.recent = pushRecentColor(this.recent, state.penColor);
		if (this.root && this.sliding === null) this.render(false);
	}

	/**
	 * Opens the dial near (x, y) (CSS px relative to the host). `source`: how it was asked for. Only the side button is
	 * still down when the dial opens (releasing it over an action chooses it); after a pen hold or a finger long-press
	 * the contact is already on the page and its lift never chooses. For a finger the dial opens beside it, not under it.
	 */
	open(x: number, y: number, source: MenuSource = "button"): void {
		if (!this.ctx.editable() || this.root) return;
		this.cancelEyedropper();
		const buttonHeld = source === "button";
		const rect = this.host.getBoundingClientRect();
		this.scale = dialScale((Math.min(rect.width, rect.height) - 16) / DIAL_SIZE, this.ctx.toolbarSize?.() ?? "normal");
		const outer = DIAL_RADIUS * this.scale;
		[this.cx, this.cy] = source === "finger"
			? fingerMenuCenter(x, y, rect.width, rect.height, outer)
			: clampCenter(x, y, rect.width, rect.height, outer);
		this.dialState = "main";
		this.saveMode = false;
		this.downs.clear();
		this.sliding = null;
		this.buttonHeld = buttonHeld;
		const root = this.host.createDiv({ cls: "notebook-radial", attr: { role: "dialog", "aria-label": t("radial.label") } });
		this.root = root;
		root.setCssProps({ "--notebook-radial-x": `${this.cx}px`, "--notebook-radial-y": `${this.cy}px`, "--notebook-dial-size": `${DIAL_SIZE}px`, "--notebook-dial-scale": String(this.scale) });
		const dial = root.createDiv({ cls: "notebook-dial" });
		this.dial = dial;
		const deco = svg(dial, "svg", { class: "notebook-dial-deco", viewBox: `0 0 ${DIAL_SIZE} ${DIAL_SIZE}`, "aria-hidden": "true" });
		svg(deco, "circle", { cx: DIAL_RADIUS, cy: DIAL_RADIUS, r: DIAL_RADIUS - 10, class: "notebook-dial-ring" });
		svg(deco, "circle", { cx: DIAL_RADIUS, cy: DIAL_RADIUS, r: 58, class: "notebook-dial-ring is-inner" });
		this.live = dial.createDiv({ cls: "notebook-dial-live", attr: { "aria-live": "polite" } });
		const input = root.createEl("input", { cls: "notebook-dial-color-input", attr: { type: "color", tabindex: "-1", "aria-hidden": "true" } });
		this.colorInput = input;
		input.addEventListener("input", () => this.applyColor(input.value, false));
		input.addEventListener("change", () => this.applyColor(input.value, true));
		this.render(false);
		this.listen("pointerdown", (e) => this.onDown(e as PointerEvent));
		this.listen("pointermove", (e) => this.onMove(e as PointerEvent));
		this.listen("pointerrawupdate", (e) => e.stopPropagation());
		this.listen("pointerup", (e) => this.onUp(e as PointerEvent));
		this.listen("pointercancel", (e) => this.onCancel(e as PointerEvent));
		this.listen("click", (e) => {
			if (e.target === this.colorInput) return;
			e.stopPropagation();
			e.preventDefault();
		});
		this.listen("contextmenu", (e) => e.preventDefault());
		this.listen("keydown", (e) => {
			if ((e as KeyboardEvent).key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			this.close();
		});
	}

	close(): void {
		for (const off of this.listeners) off();
		this.listeners.length = 0;
		this.root?.remove();
		this.root = this.dial = this.layer = this.live = this.colorInput = this.hover = null;
		this.downs.clear();
		this.sliding = null;
	}

	destroy(): void {
		this.close();
		this.cancelEyedropper();
	}

	// --- rendering ---

	private render(animate: boolean): void {
		const dial = this.dial;
		if (!dial) return;
		this.layer?.remove();
		const layer = dial.createDiv({ cls: `notebook-dial-layer is-${this.dialState}${animate ? " is-entering" : ""}` });
		this.layer = layer;
		this.hover = null;
		const s = this.ctx.tools();
		const tool: ToolId = s.tool;
		switch (this.dialState) {
			case "main": this.renderMain(layer, s, tool); break;
			case "color": this.renderColor(layer, s, tool); break;
			case "width": this.renderWidth(layer, s, tool); break;
			case "tools": this.renderTools(layer, s, tool); break;
			case "favourites": this.renderFavourites(layer); break;
			case "shapes": this.renderShapes(layer, s); break;
			case "markers": this.renderMarkers(layer); break;
		}
		if (animate) window.requestAnimationFrame(() => window.requestAnimationFrame(() => layer.removeClass("is-entering")));
	}

	/** An action of the dial centred at (x, y) (dial coordinates), `size` px. */
	private item(parent: HTMLElement, action: string, label: string, x: number, y: number, size: number, cls = ""): HTMLElement {
		const b = parent.createDiv({ cls: `notebook-dial-item ${cls}`.trim(), attr: { role: "button", "aria-label": label, "data-dial": action } });
		b.setCssProps({ "--x": `${Math.round(x)}px`, "--y": `${Math.round(y)}px`, "--s": `${size}px` });
		return b;
	}

	private at(deg: number, r: number): [number, number] {
		return polar(DIAL_RADIUS, DIAL_RADIUS, r, deg);
	}

	private colorOf(s: ToolbarState, tool: ToolId): string {
		return colourSlot(tool) === "highlighter" ? s.highlighterColor : s.penColor;
	}

	private toolArt(parent: HTMLElement, tool: ToolId, color: string, size: number): void {
		if (tool === "pen" || tool === "highlighter" || tool === "eraser") {
			const art = svg(parent, "svg", { class: "notebook-dial-art", viewBox: "0 0 40 80", width: size / 2, height: size, "aria-hidden": "true" });
			drawPen(art, tool, color);
		} else {
			setIcon(parent.createSpan({ cls: "notebook-dial-icon" }), TOOL_ICON[tool]);
		}
	}

	private renderMain(layer: HTMLElement, s: ToolbarState, tool: ToolId): void {
		const color = this.colorOf(s, tool);
		const centre = this.item(layer, "tools", t("radial.tools"), DIAL_RADIUS, DIAL_RADIUS, 92, "notebook-dial-centre is-art");
		this.toolArt(centre.createDiv({ cls: "notebook-dial-tilt" }), tool, color, 80);

		const undo = this.item(layer, "undo", t("tool.undo"), ...this.at(-45, 94), 44, "is-round");
		setIcon(undo, "undo");
		undo.toggleClass("is-disabled", !this.ctx.canUndo());
		if (this.ctx.redo) {
			const redo = this.item(layer, "redo", t("tool.redo"), ...this.at(45, 94), 44, "is-round");
			setIcon(redo, "redo");
			redo.toggleClass("is-disabled", !(this.ctx.canRedo?.() ?? true));
		}

		const scale = widthScale(tool);
		if (scale) {
			const value = s[scale.field];
			const w = this.item(layer, "width", `${t("radial.width")}: ${formatWidth(value)}`, ...this.at(-90, 94), 52, "is-bubble");
			// The dot shows the size only (the colour has its own bubble), light so it reads on the dark dial.
			w.createSpan({ cls: `notebook-dial-dot${tool === "eraser" ? " is-ring" : ""}` })
				.setCssProps({ "--d": `${bubbleDot(tool, value)}px`, "--c": tool === "eraser" ? "transparent" : "var(--nb-dial-fg)" });
		}
		if (colourSlot(tool)) {
			const c = this.item(layer, "color", `${t("radial.color")}: ${color}`, ...this.at(90, 94), 52, "is-bubble is-color");
			c.setCssProps({ "--c": color });
		}

		const detail = scale ? `${formatWidth(s[scale.field])} ${scale.unit}` : "";
		layer.createDiv({ cls: "notebook-dial-caption", text: detail ? `${shortLabel(tool)} · ${detail}` : shortLabel(tool) })
			.setCssProps({ "--y": `${DIAL_RADIUS - 92}px` });

		// The pill: favourites · current tool (raised) · shapes and ruler.
		layer.createDiv({ cls: "notebook-dial-pill" }).setCssProps({ "--y": `${DIAL_RADIUS + 90}px` });
		if (this.ctx.favourites) setIcon(this.item(layer, "favourites", t("radial.favourites"), DIAL_RADIUS - 50, DIAL_RADIUS + 90, 40, "is-round is-flat"), "star");
		setIcon(this.item(layer, "tools", `${t("radial.tools")}: ${shortLabel(tool)}`, DIAL_RADIUS, DIAL_RADIUS + 86, 46, "is-round is-raised"), TOOL_ICON[tool]);
		setIcon(this.item(layer, "shapes", t("radial.shapes"), DIAL_RADIUS + 50, DIAL_RADIUS + 90, 40, "is-round is-flat"), "shapes");
		this.say(`${t(TOOL_LABEL[tool])}${detail ? `, ${detail}` : ""}`);
	}

	private back(layer: HTMLElement, label = t("radial.back")): HTMLElement {
		const b = this.item(layer, "back", label, DIAL_RADIUS, DIAL_RADIUS, 66, "notebook-dial-centre is-back");
		setIcon(b.createSpan({ cls: "notebook-dial-back-icon" }), "chevron-left");
		return b;
	}

	private renderColor(layer: HTMLElement, s: ToolbarState, tool: ToolId): void {
		const current = this.colorOf(s, tool).toLowerCase();
		const palette = paletteFor(tool);
		palette.forEach((color, i) => {
			const sw = this.item(layer, `swatch:${color}`, `${t("tool.color")} ${color}`, ...this.at((360 * i) / palette.length, RING_RADIUS), 34, "is-swatch");
			sw.setCssProps({ "--c": color });
			sw.toggleClass("is-active", color.toLowerCase() === current);
		});
		const centre = this.back(layer);
		centre.addClass("is-color-preview");
		centre.setCssProps({ "--c": current });
		const custom = this.item(layer, "custom", t("radial.custom"), ...this.at(-135, 50), 32, "is-round is-rainbow");
		custom.createSpan({ cls: "notebook-dial-rainbow-dot" }).setCssProps({ "--c": current });
		setIcon(this.item(layer, "eyedropper", t("radial.eyedropper"), ...this.at(135, 50), 32, "is-round"), "pipette");
		this.say(t("radial.color"));
	}

	private renderWidth(layer: HTMLElement, s: ToolbarState, tool: ToolId): void {
		const scale = widthScale(tool);
		if (!scale) return;
		const steps = scale.steps;
		const value = s[scale.field];
		const index = nearestStep(steps, value);
		const art = svg(layer, "svg", { class: "notebook-dial-slider", viewBox: `0 0 ${DIAL_SIZE} ${DIAL_SIZE}`, "aria-hidden": "true" });
		const [x0, y0] = this.at(SLIDER_START, RING_RADIUS);
		const [x1, y1] = this.at(SLIDER_END, RING_RADIUS);
		svg(art, "path", { d: `M ${x0} ${y0} A ${RING_RADIUS} ${RING_RADIUS} 0 1 1 ${x1} ${y1}`, class: "notebook-dial-track" });
		const angles = arcAngles(steps.length, SLIDER_START, SLIDER_END);
		const [ax, ay] = this.at(angles[index]!, RING_RADIUS);
		if (index > 0) {
			svg(art, "path", { d: `M ${x0} ${y0} A ${RING_RADIUS} ${RING_RADIUS} 0 ${angles[index]! - SLIDER_START > 180 ? 1 : 0} 1 ${ax} ${ay}`, class: "notebook-dial-track is-filled" });
		}
		angles.forEach((deg, i) => {
			const [x, y] = this.at(deg, RING_RADIUS);
			svg(art, "circle", { cx: x, cy: y, r: stepDotRadius(i, steps.length, 2.5, 8), class: `notebook-dial-step${i <= index ? " is-on" : ""}` });
		});
		svg(art, "circle", { cx: ax, cy: ay, r: 14, class: "notebook-dial-knob" });
		const hit = layer.createDiv({
			cls: "notebook-dial-slider-hit",
			attr: {
				role: "slider", "aria-label": t("radial.width"), "aria-valuemin": String(steps[0]), "aria-valuemax": String(steps[steps.length - 1]),
				"aria-valuenow": String(value), "data-dial": "slider",
			},
		});
		hit.setCssProps({ "--x": `${Math.round(ax)}px`, "--y": `${Math.round(ay)}px` });
		const centre = this.back(layer, `${t("radial.back")}: ${formatWidth(value)} ${scale.unit}`);
		centre.addClass("is-value");
		centre.createSpan({ cls: "notebook-dial-number", text: formatWidth(value) });
		centre.createSpan({ cls: "notebook-dial-unit", text: scale.unit });
		this.say(`${t("radial.width")} ${formatWidth(value)} ${scale.unit}`);
	}

	private renderTools(layer: HTMLElement, s: ToolbarState, tool: ToolId): void {
		const angles = arcAngles(PEN_CASE.length, -120, 120);
		PEN_CASE.forEach((id, i) => {
			const color = id === "highlighter" ? s.highlighterColor : s.penColor;
			const b = this.item(layer, `tool:${id}`, t(TOOL_LABEL[id]), ...this.at(angles[i]!, 96), 46, "is-case");
			b.toggleClass("is-active", id === tool);
			this.toolArt(b, id, color, 34);
			if (id === "pen" || id === "highlighter") {
				// The stroke preview on a strip of paper, so every ink colour reads on the dark dial.
				const prev = svg(b, "svg", { class: "notebook-dial-preview", viewBox: "0 0 32 10", width: 30, height: 9, "aria-hidden": "true" });
				svg(prev, "rect", { x: 0, y: 0, width: 32, height: 10, rx: 3, fill: "#f7f7f4" });
				svg(prev, "path", {
					d: "M3 6c4-4 7-4 9 0s6 4 9 0 6-3 8-1", fill: "none", stroke: color, "stroke-linecap": "round",
					"stroke-width": id === "highlighter" ? 4 : Math.max(1.2, Math.min(3, s.penWidth)), opacity: id === "highlighter" ? 0.6 : 1,
				});
			}
		});
		if (this.ctx.saveFavourite) setIcon(this.item(layer, "save-favourite", t("radial.saveFavourite"), ...this.at(180, 96), 40, "is-round is-plus"), "plus");
		this.back(layer);
		this.say(t("radial.tools"));
	}

	private renderFavourites(layer: HTMLElement): void {
		const favs = this.ctx.favourites?.() ?? [];
		const s = this.ctx.tools();
		const angles = arcAngles(favs.length, -120, 120);
		favs.forEach((fav, i) => {
			const label = `${t("pens.slot", { n: String(i + 1) })}: ${t(fav.tool === "pen" ? "tool.pen" : "tool.highlighter")} ${fav.color}, ${fav.width}`;
			const b = this.item(layer, `fav:${i}`, label, ...this.at(angles[i]!, 96), 44, "is-round is-fav");
			const active = s.tool === fav.tool && (fav.tool === "pen"
				? s.penColor.toLowerCase() === fav.color && s.penWidth === fav.width
				: s.highlighterColor.toLowerCase() === fav.color && s.highlighterWidth === fav.width);
			b.toggleClass("is-active", active && !this.saveMode);
			b.toggleClass("is-target", this.saveMode);
			const d = fav.tool === "highlighter" ? 14 : Math.round(Math.min(20, 6 + Math.sqrt(fav.width) * 3.5));
			b.createSpan({ cls: `notebook-dial-dot${fav.tool === "highlighter" ? " is-chisel" : ""}` }).setCssProps({ "--d": `${d}px`, "--c": fav.color });
		});
		if (this.ctx.saveFavourite) {
			const plus = this.item(layer, "save-favourite", t("radial.saveFavourite"), ...this.at(180, 96), 40, "is-round is-plus");
			plus.toggleClass("is-active", this.saveMode);
			plus.setAttribute("aria-pressed", String(this.saveMode));
			setIcon(plus, "plus");
		}
		this.back(layer);
		if (this.saveMode) layer.createDiv({ cls: "notebook-dial-hint", text: t("radial.saveHint") });
		this.say(this.saveMode ? t("radial.saveHint") : t("radial.favourites"));
	}

	private renderShapes(layer: HTMLElement, s: ToolbarState): void {
		const angles = arcAngles(SHAPES.length + (this.ctx.toggleRuler ? 1 : 0) + (this.ctx.placeMarker ? 1 : 0), -100, 100);
		SHAPES.forEach(([kind, icon, label], i) => {
			const b = this.item(layer, `shape:${kind}`, t(label), ...this.at(angles[i]!, 96), 46, "is-round");
			b.toggleClass("is-active", s.tool === "shape" && s.shapeKind === kind);
			setIcon(b, icon);
		});
		if (this.ctx.toggleRuler) {
			const r = this.item(layer, "ruler", t("tool.ruler"), ...this.at(angles[SHAPES.length]!, 96), 46, "is-round");
			r.toggleClass("is-active", s.ruler);
			r.setAttribute("aria-pressed", String(s.ruler));
			setIcon(r, "ruler");
		}
		if (this.ctx.placeMarker) {
			const m = this.item(layer, "markers", t("markers.radial"), ...this.at(angles[angles.length - 1]!, 96), 46, "is-round");
			setIcon(m, "flag");
		}
		this.back(layer);
		this.say(t("radial.shapes"));
	}

	/** wave 0.8: the marker kinds and the structured box, as their badges; a tap arms one and closes the dial. */
	private renderMarkers(layer: HTMLElement): void {
		const angles = ringAngles(MARKER_RING.length);
		MARKER_RING.forEach(([kind, glyph], i) => {
			const label = kind === "box" ? t("markers.menu.box") : t(`markers.place.${kind}`);
			this.item(layer, `marker:${kind}`, label, ...this.at(angles[i]!, 96), 44, `is-round notebook-dial-marker is-${kind}`).setText(glyph);
		});
		this.back(layer);
		this.say(t("markers.radial"));
	}

	private say(text: string): void {
		this.live?.setText(text);
	}

	// --- input ---

	private listen(type: string, fn: (e: Event) => void): void {
		window.addEventListener(type, fn, true);
		this.listeners.push(() => window.removeEventListener(type, fn, true));
	}

	/** The action element under a pointer, or null. */
	private actionAt(e: PointerEvent): HTMLElement | null {
		const el = document.elementFromPoint(e.clientX, e.clientY);
		const hit = el?.closest<HTMLElement>("[data-dial]");
		return hit && this.root?.contains(hit) ? hit : null;
	}

	/** Pointer position relative to the dial centre, in dial px (unscaled). */
	private local(e: PointerEvent): [number, number] {
		const rect = this.host.getBoundingClientRect();
		return [(e.clientX - rect.left - this.cx) / this.scale, (e.clientY - rect.top - this.cy) / this.scale];
	}

	private insideDial(e: PointerEvent): boolean {
		const [dx, dy] = this.local(e);
		return Math.hypot(dx, dy) <= DIAL_RADIUS;
	}

	private setHover(el: HTMLElement | null): void {
		if (el === this.hover) return;
		this.hover?.removeClass("is-hover");
		this.hover = el;
		el?.addClass("is-hover");
	}

	private onDown(e: PointerEvent): void {
		if (e.target === this.colorInput) return;
		e.stopPropagation();
		e.preventDefault();
		const hit = this.actionAt(e);
		if (this.dialState === "width" && (hit?.dataset.dial === "slider" || (hit?.dataset.dial !== "back" && this.onSliderBand(e)))) {
			this.sliding = e.pointerId;
			this.slideTo(e);
			return;
		}
		this.downs.set(e.pointerId, hit?.dataset.dial ?? (this.insideDial(e) ? "" : null));
		this.setHover(hit);
	}

	private onMove(e: PointerEvent): void {
		e.stopPropagation();
		if (this.sliding === e.pointerId) {
			this.slideTo(e);
			return;
		}
		const hit = this.actionAt(e);
		this.setHover(hit);
		if (e.pointerType !== "pen") return;
		// Opened by pressing the side button: releasing it over an action chooses it (a flick).
		const held = (e.buttons & 2) !== 0;
		if (this.buttonHeld && !held) {
			this.buttonHeld = false;
			const action = hit?.dataset.dial;
			if (action && action !== "slider") this.act(action);
		} else if (held) {
			this.buttonHeld = true;
		}
	}

	private onUp(e: PointerEvent): void {
		if (e.target === this.colorInput) return;
		e.stopPropagation();
		e.preventDefault();
		if (this.sliding === e.pointerId) {
			this.sliding = null;
			this.render(false);
			return;
		}
		// An up without a down is the lift of the press that opened the menu: it stays open.
		if (!this.downs.has(e.pointerId)) return;
		const down = this.downs.get(e.pointerId);
		this.downs.delete(e.pointerId);
		if (down === null) {
			if (!this.insideDial(e)) this.close(); // a tap outside
			return;
		}
		const action = this.actionAt(e)?.dataset.dial;
		if (action && action === down) this.act(action);
	}

	private onCancel(e: PointerEvent): void {
		e.stopPropagation();
		this.downs.delete(e.pointerId);
		if (this.sliding === e.pointerId) this.sliding = null;
	}

	/** The pointer is on the ring of the width slider (where its dots are). */
	private onSliderBand(e: PointerEvent): boolean {
		const [dx, dy] = this.local(e);
		const r = Math.hypot(dx, dy);
		const a = angleOf(dx, dy);
		return r >= RING_RADIUS - 26 && r <= DIAL_RADIUS + 8 && a >= SLIDER_START - 14 && a <= SLIDER_END + 14;
	}

	private slideTo(e: PointerEvent): void {
		const scale = widthScale(this.ctx.tools().tool);
		if (!scale) return;
		const [dx, dy] = this.local(e);
		const value = scale.steps[stepAtAngle(angleOf(dx, dy), scale.steps.length)]!;
		if (this.ctx.tools()[scale.field] === value) return;
		this.ctx.apply({ [scale.field]: value });
		this.render(false);
	}

	private go(state: DialState): void {
		this.dialState = state;
		if (state !== "favourites") this.saveMode = false;
		this.render(true);
	}

	private act(action: string): void {
		if (!this.ctx.editable()) {
			this.close();
			return;
		}
		const colon = action.indexOf(":");
		const kind = colon < 0 ? action : action.slice(0, colon);
		const arg = colon < 0 ? "" : action.slice(colon + 1);
		switch (kind) {
			case "undo":
				if (this.ctx.canUndo()) this.ctx.undo();
				this.render(false);
				return;
			case "redo":
				if (this.ctx.canRedo?.() ?? true) this.ctx.redo?.();
				this.render(false);
				return;
			case "width":
			case "color":
			case "tools":
			case "shapes":
			case "markers":
				this.go(kind);
				return;
			case "marker":
				this.ctx.placeMarker?.(arg as (typeof MARKER_RING)[number][0]);
				this.close();
				return;
			case "favourites":
				this.saveMode = false;
				this.go("favourites");
				return;
			case "back":
				if (this.dialState === "favourites" && this.saveMode) {
					this.saveMode = false;
					this.render(false);
				} else {
					this.go("main");
				}
				return;
			case "swatch":
				this.applyColor(arg, true);
				return;
			case "custom":
				this.colorInput?.click();
				return;
			case "eyedropper":
				this.armEyedropper();
				return;
			case "tool":
				this.ctx.apply({ tool: arg as ToolName });
				this.close();
				return;
			case "save-favourite":
				if (this.dialState !== "favourites") {
					this.saveMode = true;
					this.dialState = "favourites";
					this.render(true);
				} else {
					this.saveMode = !this.saveMode;
					this.render(false);
				}
				return;
			case "fav": {
				const i = Number(arg);
				if (this.saveMode) {
					this.ctx.saveFavourite?.(i);
					this.saveMode = false;
					this.render(false);
				} else {
					this.ctx.applyFavourite?.(i);
					this.close();
				}
				return;
			}
			case "shape":
				this.ctx.apply({ tool: "shape", shapeKind: arg as ShapeKind });
				this.close();
				return;
			case "ruler":
				this.ctx.toggleRuler?.();
				this.render(false);
				return;
		}
	}

	/** Sets the colour of the tool in use (a tool without colour switches to the pen); `done`: back to the main ring. */
	private applyColor(color: string, done: boolean): void {
		if (!/^#[0-9a-f]{6}$/i.test(color)) return;
		const slot = colourSlot(this.ctx.tools().tool);
		const c = color.toLowerCase();
		if (slot === "highlighter") this.ctx.apply({ highlighterColor: c });
		else if (slot === "pen") this.ctx.apply({ penColor: c });
		else this.ctx.apply({ tool: "pen", penColor: c });
		if (!this.root) return;
		if (done) this.go("main");
		else this.render(false);
	}

	// --- eyedropper: the next tap on the page picks the colour under it (the stage's canvases, composited) ---

	private armEyedropper(): void {
		this.close();
		this.cancelEyedropper();
		this.ctx.notify?.(t("radial.eyedropperHint"));
		const stop = (e: Event): void => {
			e.stopPropagation();
			e.preventDefault();
		};
		const onDown = (e: PointerEvent): void => {
			stop(e);
			const rect = this.host.getBoundingClientRect();
			const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
			const color = inside ? this.sample(e.clientX - rect.left, e.clientY - rect.top) : null;
			// The rest of this pointer's sequence must not draw either.
			const id = e.pointerId;
			const types = ["pointermove", "pointerrawupdate", "pointerup", "pointercancel"];
			const swallow = (ev: Event): void => {
				if ((ev as PointerEvent).pointerId !== id) return;
				stop(ev);
				if (ev.type === "pointerup" || ev.type === "pointercancel") for (const type of types) window.removeEventListener(type, swallow, true);
			};
			for (const type of types) window.addEventListener(type, swallow, true);
			this.cancelEyedropper();
			if (color) this.applyColor(color, true);
		};
		window.addEventListener("pointerdown", onDown, true);
		this.eyedropperOff = () => window.removeEventListener("pointerdown", onDown, true);
	}

	private cancelEyedropper(): void {
		this.eyedropperOff?.();
		this.eyedropperOff = null;
	}

	/** The colour at (x, y) (CSS px in the stage): every canvas of the stage composited over white paper. */
	private sample(x: number, y: number): string | null {
		try {
			const out = createEl("canvas");
			out.width = out.height = 1;
			const g = out.getContext("2d");
			if (!g) return null;
			g.fillStyle = "#ffffff";
			g.fillRect(0, 0, 1, 1);
			const stage = this.host.getBoundingClientRect();
			for (const c of Array.from(this.host.querySelectorAll("canvas"))) {
				const r = c.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				const px = Math.floor((x + stage.left - r.left) * (c.width / r.width));
				const py = Math.floor((y + stage.top - r.top) * (c.height / r.height));
				if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
				g.drawImage(c, px, py, 1, 1, 0, 0, 1, 1);
			}
			const d = g.getImageData(0, 0, 1, 1).data;
			const hex = (v: number | undefined): string => (v ?? 0).toString(16).padStart(2, "0");
			return `#${hex(d[0])}${hex(d[1])}${hex(d[2])}`;
		} catch (e) {
			console.error("[notebook] eyedropper failed", e);
			return null;
		}
	}
}
