import { setIcon } from "obsidian";
import { t, type MessageKey } from "../i18n";
import {
	GRAPH_EXPR_MAX, GRAPH_MAX_FUNCTIONS, GRAPH_MAX_PARAMS, GRAPH_MAX_PIECES, GRAPH_TABLE_MAX_ROWS, isParamName, isViewport, newGraphFunction, normalizeGraph,
} from "../model/math-elements";
import { GRAPH_FUNCTION_KINDS, type GraphElement, type GraphFunction, type GraphFunctionKind, type GraphParam } from "../model/types";
import { graphScene } from "../math/graph-scene";

/**
 * The edit panel of a function graph (#113): functions (kind, expressions, colour, analysis options), parameters with
 * sliders, the view (range, zoom, reset), axes, grid, labels, steps, degrees and the table of values. Every change
 * shows at once on the page (the view draws the draft); Done commits it as one undo step, Cancel drops it. The panel
 * keeps a working copy and rebuilds its rows only when the structure changes (so typing keeps the focus).
 */

export interface GraphPanelHandlers {
	/** The draft changed (draw it). */
	change: (draft: GraphElement) => void;
	done: () => void;
	cancel: () => void;
}

const ISOLATED = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;

const KIND_LABEL: Record<GraphFunctionKind, MessageKey> = {
	cartesian: "math.graph.kind.cartesian",
	parametric: "math.graph.kind.parametric",
	polar: "math.graph.kind.polar",
	implicit: "math.graph.kind.implicit",
	piecewise: "math.graph.kind.piecewise",
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A deep, unfrozen copy of a graph to edit. */
function workingCopy(g: GraphElement): Mutable<GraphElement> {
	return JSON.parse(JSON.stringify(g)) as Mutable<GraphElement>;
}

function numberOr(v: string, fallback: number | undefined): number | undefined {
	if (v.trim() === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

export class GraphPanel {
	readonly el: HTMLElement;
	private model: Mutable<GraphElement>;
	private readonly original: GraphElement;
	private readonly fnBox: HTMLElement;
	private readonly paramBox: HTMLElement;
	private readonly viewInputs: Record<"xMin" | "xMax" | "yMin" | "yMax", HTMLInputElement>;
	private readonly tableBox: HTMLElement;
	private readonly errors = new Map<string, HTMLElement>();
	private closed = false;
	/** Shown when the graph reached its work limits (see GraphScene.simplified). */
	private readonly simplified: HTMLElement;
	private soon: number | null = null;

	constructor(parent: HTMLElement, graph: GraphElement, private readonly handlers: GraphPanelHandlers) {
		this.original = graph;
		this.model = workingCopy(graph);
		this.el = parent.createDiv({ cls: "notebook-math-panel notebook-graph-panel", attr: { role: "dialog", "aria-label": t("math.graph.title") } });
		for (const type of ISOLATED) this.el.addEventListener(type, (e) => e.stopPropagation());
		this.el.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.cancel();
			}
		});
		const head = this.el.createDiv({ cls: "notebook-graph-head" });
		head.createDiv({ cls: "notebook-graph-title", text: t("math.graph.title") });
		head.createDiv({ cls: "notebook-graph-hint", text: t("math.graph.hint") });
		this.simplified = head.createDiv({ cls: "notebook-graph-hint notebook-hidden", text: t("math.graph.simplified") });
		const body = this.el.createDiv({ cls: "notebook-graph-body" });

		this.section(body, "math.graph.functions");
		this.fnBox = body.createDiv({ cls: "notebook-graph-functions" });
		const add = body.createDiv({ cls: "notebook-graph-add" });
		for (const kind of GRAPH_FUNCTION_KINDS) {
			add.createEl("button", { text: `+ ${t(KIND_LABEL[kind])}`, attr: { type: "button" } }).addEventListener("click", () => {
				if (this.model.functions.length >= GRAPH_MAX_FUNCTIONS) return;
				this.model.functions.push(newGraphFunction(this.model, kind));
				this.renderFunctions();
				this.changed();
			});
		}

		this.section(body, "math.graph.params");
		this.paramBox = body.createDiv({ cls: "notebook-graph-params" });
		body.createEl("button", { cls: "notebook-graph-add-param", text: `+ ${t("math.graph.addParam")}`, attr: { type: "button" } }).addEventListener("click", () => {
			const params = (this.model.params ??= []);
			if (params.length >= GRAPH_MAX_PARAMS) return;
			const used = new Set(params.map((p) => p.name));
			const name = ["a", "b", "c", "k", "m", "n", "p", "q", "s", "u", "v", "w"].find((n) => !used.has(n)) ?? `k${params.length + 1}`;
			params.push({ name, value: 1, min: -5, max: 5, step: 0.1 });
			this.renderParams();
			this.changed();
		});

		this.section(body, "math.graph.view");
		const view = body.createDiv({ cls: "notebook-graph-view" });
		const vi = (key: "xMin" | "xMax" | "yMin" | "yMax") => {
			const label = view.createEl("label", { cls: "notebook-graph-field", text: key });
			const input = label.createEl("input", { attr: { type: "number", step: "any", "aria-label": key } });
			input.value = String(this.model.view[key]);
			input.addEventListener("change", () => {
				const v = Number(input.value);
				const next = { ...this.model.view, [key]: v };
				if (Number.isFinite(v) && isViewport(next)) {
					this.model.view = next;
					this.changed();
				} else input.value = String(this.model.view[key]);
			});
			return input;
		};
		this.viewInputs = { xMin: vi("xMin"), xMax: vi("xMax"), yMin: vi("yMin"), yMax: vi("yMax") };
		const zoom = body.createDiv({ cls: "notebook-graph-zoom" });
		this.iconButton(zoom, "zoom-in", "math.graph.zoomIn", () => this.zoom(1.5));
		this.iconButton(zoom, "zoom-out", "math.graph.zoomOut", () => this.zoom(1 / 1.5));
		this.iconButton(zoom, "rotate-ccw", "math.graph.reset", () => {
			this.model.view = { ...this.original.view };
			this.changed();
		});

		this.section(body, "math.graph.style");
		const style = body.createDiv({ cls: "notebook-graph-style" });
		this.check(style, "math.graph.axes", this.model.axes !== false, (on) => (on ? delete this.model.axes : (this.model.axes = false)));
		this.check(style, "math.graph.grid", this.model.grid !== false, (on) => (on ? delete this.model.grid : (this.model.grid = false)));
		this.check(style, "math.graph.degrees", this.model.degrees === true, (on) => (on ? (this.model.degrees = true) : delete this.model.degrees));
		this.text(style, "math.graph.xLabel", this.model.xLabel ?? "", 60, (v) => (v.trim() ? (this.model.xLabel = v) : delete this.model.xLabel));
		this.text(style, "math.graph.yLabel", this.model.yLabel ?? "", 60, (v) => (v.trim() ? (this.model.yLabel = v) : delete this.model.yLabel));
		this.num(style, "math.graph.xStep", this.model.xStep, (v) => (v !== undefined && v > 0 ? (this.model.xStep = v) : delete this.model.xStep));
		this.num(style, "math.graph.yStep", this.model.yStep, (v) => (v !== undefined && v > 0 ? (this.model.yStep = v) : delete this.model.yStep));

		this.section(body, "math.graph.table");
		this.tableBox = body.createDiv({ cls: "notebook-graph-table" });

		const actions = this.el.createDiv({ cls: "notebook-graph-actions" });
		actions.createEl("button", { text: t("math.graph.cancel"), attr: { type: "button" } }).addEventListener("click", () => this.cancel());
		actions.createEl("button", { cls: "mod-cta", text: t("math.graph.done"), attr: { type: "button" } }).addEventListener("click", () => this.done());

		this.renderFunctions();
		this.renderParams();
		this.renderTable();
		this.showErrors();
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** The graph as edited so far (a new frozen-ready element; the same id). */
	draft(): GraphElement {
		// What the fields hold may be out of order (a range typed backwards): the draft is always valid for the writer.
		return normalizeGraph(this.model);
	}

	/** The view was panned or zoomed on the page: take it over. */
	setView(view: GraphElement["view"]): void {
		this.model.view = { ...view };
		for (const k of ["xMin", "xMax", "yMin", "yMax"] as const) this.viewInputs[k].value = String(Math.round(view[k] * 1e6) / 1e6);
		this.changed(false);
	}

	destroy(): void {
		if (this.soon !== null) window.clearTimeout(this.soon);
		this.soon = null;
		this.el.remove();
	}

	/** Applies a change still waiting for the typing to pause (before a commit). */
	flush(): void {
		if (this.soon === null) return;
		window.clearTimeout(this.soon);
		this.soon = null;
		if (!this.closed) this.changed();
	}

	/** A change from typing: the graph is redrawn once the typing pauses (each redraw samples every function). */
	private changedSoon(): void {
		if (this.soon !== null) window.clearTimeout(this.soon);
		this.soon = window.setTimeout(() => {
			this.soon = null;
			if (!this.closed) this.changed();
		}, 150);
	}

	private zoom(factor: number): void {
		const v = this.model.view;
		const cx = (v.xMin + v.xMax) / 2, cy = (v.yMin + v.yMax) / 2;
		const next = { xMin: cx - (cx - v.xMin) / factor, xMax: cx + (v.xMax - cx) / factor, yMin: cy - (cy - v.yMin) / factor, yMax: cy + (v.yMax - cy) / factor };
		if (isViewport(next)) this.setView(next);
	}

	private changed(syncView = true): void {
		if (syncView) for (const k of ["xMin", "xMax", "yMin", "yMax"] as const) this.viewInputs[k].value = String(Math.round(this.model.view[k] * 1e6) / 1e6);
		// The same object is drawn by the view and checked here: the scene is computed once (cached per element).
		const draft = this.draft();
		this.handlers.change(draft);
		this.showErrors(draft);
	}

	/** Parser messages next to the functions that do not compile. */
	private showErrors(draft: GraphElement = this.draft()): void {
		const scene = graphScene(draft);
		this.simplified.toggleClass("notebook-hidden", !scene.simplified);
		for (const [id, el] of this.errors) {
			const err = scene.errors.find((e) => e.fn === id);
			el.toggleClass("notebook-hidden", !err);
			el.setText(err ? t("math.graph.error", { message: err.message }) : "");
		}
	}

	private section(parent: HTMLElement, label: MessageKey): void {
		parent.createDiv({ cls: "notebook-graph-section", text: t(label) });
	}

	private iconButton(parent: HTMLElement, icon: string, label: MessageKey, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": t(label), title: t(label) } });
		setIcon(b, icon);
		b.addEventListener("click", onClick);
		return b;
	}

	private check(parent: HTMLElement, label: MessageKey, on: boolean, set: (on: boolean) => unknown): void {
		const l = parent.createEl("label", { cls: "notebook-graph-check" });
		const input = l.createEl("input", { attr: { type: "checkbox" } });
		input.checked = on;
		l.appendText(t(label));
		input.addEventListener("change", () => {
			set(input.checked);
			this.changed();
		});
	}

	private text(parent: HTMLElement, label: MessageKey, value: string, max: number, set: (v: string) => unknown, cls = "notebook-graph-field"): HTMLInputElement {
		const l = parent.createEl("label", { cls, text: t(label) });
		const input = l.createEl("input", { attr: { type: "text", maxlength: String(max), spellcheck: "false", "aria-label": t(label) } });
		input.value = value;
		input.addEventListener("input", () => {
			set(input.value);
			this.changed();
		});
		return input;
	}

	private num(parent: HTMLElement, label: MessageKey, value: number | undefined, set: (v: number | undefined) => unknown): HTMLInputElement {
		const l = parent.createEl("label", { cls: "notebook-graph-field", text: t(label) });
		const input = l.createEl("input", { attr: { type: "number", step: "any", "aria-label": t(label) } });
		input.value = value === undefined ? "" : String(value);
		input.addEventListener("change", () => {
			set(numberOr(input.value, undefined));
			this.changed();
		});
		return input;
	}

	private renderFunctions(): void {
		this.fnBox.empty();
		this.errors.clear();
		this.model.functions.forEach((fn, index) => this.functionRow(fn, index));
		this.renderTable();
	}

	private functionRow(fn: Mutable<GraphFunction>, index: number): void {
		const row = this.fnBox.createDiv({ cls: "notebook-graph-fn" });
		const top = row.createDiv({ cls: "notebook-graph-fn-top" });
		const color = top.createEl("input", { attr: { type: "color", "aria-label": t("math.graph.color") } });
		color.value = fn.color;
		color.addEventListener("input", () => {
			if (/^#[0-9a-f]{6}$/i.test(color.value)) {
				fn.color = color.value.toLowerCase();
				this.changed();
			}
		});
		top.createSpan({ cls: "notebook-graph-kind", text: t(KIND_LABEL[fn.kind]) });
		this.iconButton(top, fn.hidden ? "eye-off" : "eye", "math.graph.hide", () => {
			if (fn.hidden) delete fn.hidden;
			else fn.hidden = true;
			this.renderFunctions();
			this.changed();
		});
		this.iconButton(top, "trash-2", "math.graph.remove", () => {
			this.model.functions.splice(index, 1);
			this.renderFunctions();
			this.changed();
		});
		const exprs = row.createDiv({ cls: "notebook-graph-exprs" });
		const field = (label: string, value: string, set: (v: string) => void) => {
			const l = exprs.createEl("label", { cls: "notebook-graph-expr", text: label });
			const input = l.createEl("input", { attr: { type: "text", maxlength: String(GRAPH_EXPR_MAX), spellcheck: "false", autocapitalize: "off", "aria-label": label } });
			input.value = value;
			input.addEventListener("input", () => {
				set(input.value);
				this.changedSoon();
			});
		};
		if (fn.kind === "parametric") {
			field("x(t) =", fn.x ?? "", (v) => (fn.x = v));
			field("y(t) =", fn.y ?? "", (v) => (fn.y = v));
		} else if (fn.kind === "piecewise") {
			const pieces = (fn.pieces ??= [{ expr: "x" }]);
			pieces.forEach((p, i) => {
				const line = exprs.createDiv({ cls: "notebook-graph-piece" });
				const e = line.createEl("input", { attr: { type: "text", maxlength: String(GRAPH_EXPR_MAX), spellcheck: "false", "aria-label": t("math.graph.kind.cartesian") } });
				e.value = p.expr;
				e.addEventListener("input", () => {
					p.expr = e.value;
					this.changedSoon();
				});
				line.createSpan({ text: t("math.graph.when") });
				const w = line.createEl("input", { attr: { type: "text", maxlength: String(GRAPH_EXPR_MAX), spellcheck: "false", placeholder: t("math.graph.otherwise"), "aria-label": t("math.graph.when") } });
				w.value = p.when ?? "";
				w.addEventListener("input", () => {
					if (w.value.trim() === "") delete p.when;
					else p.when = w.value;
					this.changedSoon();
				});
				if (pieces.length > 1) {
					this.iconButton(line, "x", "math.graph.remove", () => {
						pieces.splice(i, 1);
						this.renderFunctions();
						this.changed();
					});
				}
			});
			if (pieces.length < GRAPH_MAX_PIECES) {
				exprs.createEl("button", { text: `+ ${t("math.graph.addPiece")}`, attr: { type: "button" } }).addEventListener("click", () => {
					pieces.push({ expr: "0" });
					this.renderFunctions();
					this.changed();
				});
			}
		} else {
			const prefix = fn.kind === "polar" ? "r(θ) =" : fn.kind === "implicit" ? "" : "y =";
			field(prefix || t("math.graph.kind.implicit"), fn.expr ?? "", (v) => (fn.expr = v));
		}
		const err = row.createDiv({ cls: "notebook-graph-error notebook-hidden" });
		this.errors.set(fn.id, err);
		const opts = row.createDiv({ cls: "notebook-graph-fn-opts" });
		if (fn.kind === "parametric" || fn.kind === "polar") {
			this.num(opts, "math.graph.rangeFrom", fn.min, (v) => {
				if (v === undefined) {
					delete fn.min;
					delete fn.max;
				} else {
					fn.min = v;
					if (fn.max === undefined || fn.max <= v) fn.max = v + 2 * Math.PI;
				}
			});
			this.num(opts, "math.graph.rangeTo", fn.max, (v) => {
				if (v === undefined) {
					delete fn.min;
					delete fn.max;
				} else {
					fn.max = v;
					if (fn.min === undefined || fn.min >= v) fn.min = v - 2 * Math.PI;
				}
			});
		}
		if (fn.kind === "cartesian" || fn.kind === "piecewise") {
			const flag = (key: "roots" | "extrema" | "intersections", label: MessageKey) =>
				this.check(opts, label, fn[key] === true, (on) => (on ? (fn[key] = true) : delete fn[key]));
			flag("roots", "math.graph.roots");
			flag("extrema", "math.graph.extrema");
			flag("intersections", "math.graph.intersections");
			this.num(opts, "math.graph.tangent", fn.tangent, (v) => (v === undefined ? delete fn.tangent : (fn.tangent = v)));
			this.num(opts, "math.graph.areaFrom", fn.area?.from, (v) => {
				if (v === undefined) delete fn.area;
				else fn.area = { from: v, to: fn.area?.to !== undefined && fn.area.to !== v ? fn.area.to : v + 1 };
			});
			this.num(opts, "math.graph.areaTo", fn.area?.to, (v) => {
				if (v === undefined) delete fn.area;
				else fn.area = { from: fn.area?.from !== undefined && fn.area.from !== v ? fn.area.from : v - 1, to: v };
			});
		}
		this.text(opts, "math.graph.label", fn.label ?? "", 60, (v) => (v.trim() ? (fn.label = v) : delete fn.label));
	}

	private renderParams(): void {
		this.paramBox.empty();
		const params = this.model.params ?? [];
		params.forEach((p, i) => this.paramRow(p, i));
	}

	private paramRow(p: Mutable<GraphParam>, index: number): void {
		const row = this.paramBox.createDiv({ cls: "notebook-graph-param" });
		const name = row.createEl("input", { cls: "notebook-graph-param-name", attr: { type: "text", maxlength: "16", spellcheck: "false", "aria-label": t("math.graph.paramName") } });
		name.value = p.name;
		name.addEventListener("change", () => {
			const v = name.value.trim();
			const taken = (this.model.params ?? []).some((q, i) => i !== index && q.name === v);
			if (isParamName(v) && !taken) {
				p.name = v;
				this.changed();
			} else name.value = p.name;
		});
		const slider = row.createEl("input", { cls: "notebook-graph-slider", attr: { type: "range", "aria-label": p.name } });
		const value = row.createEl("input", { cls: "notebook-graph-param-value", attr: { type: "number", step: "any", "aria-label": t("math.graph.value") } });
		const sync = () => {
			slider.min = String(p.min);
			slider.max = String(p.max);
			slider.step = p.step !== undefined ? String(p.step) : "any";
			slider.value = String(p.value);
			value.value = String(p.value);
		};
		sync();
		slider.addEventListener("input", () => {
			p.value = Number(slider.value);
			value.value = slider.value;
			this.changed();
		});
		value.addEventListener("change", () => {
			const v = Number(value.value);
			if (Number.isFinite(v)) {
				p.value = v;
				if (v < p.min) p.min = v;
				if (v > p.max) p.max = v;
				sync();
				this.changed();
			} else value.value = String(p.value);
		});
		const range = row.createDiv({ cls: "notebook-graph-param-range" });
		const bound = (label: MessageKey, get: () => number | undefined, set: (v: number | undefined) => boolean) => {
			const l = range.createEl("label", { cls: "notebook-graph-field", text: t(label) });
			const input = l.createEl("input", { attr: { type: "number", step: "any", "aria-label": t(label) } });
			input.value = get() === undefined ? "" : String(get());
			input.addEventListener("change", () => {
				if (set(numberOr(input.value, undefined))) {
					sync();
					this.changed();
				} else input.value = get() === undefined ? "" : String(get());
			});
		};
		bound("math.graph.min", () => p.min, (v) => v !== undefined && v < p.max && ((p.min = v), (p.value = Math.max(p.value, v)), true));
		bound("math.graph.max", () => p.max, (v) => v !== undefined && v > p.min && ((p.max = v), (p.value = Math.min(p.value, v)), true));
		bound("math.graph.step", () => p.step, (v) => {
			if (v === undefined) delete p.step;
			else if (v > 0) p.step = v;
			else return false;
			return true;
		});
		this.iconButton(row, "trash-2", "math.graph.remove", () => {
			this.model.params?.splice(index, 1);
			this.renderParams();
			this.changed();
		});
	}

	private renderTable(): void {
		const box = this.tableBox;
		box.empty();
		const fns = this.model.functions.filter((f) => f.kind === "cartesian" || f.kind === "piecewise");
		const l = box.createEl("label", { cls: "notebook-graph-field", text: t("math.graph.tableFn") });
		const select = l.createEl("select", { attr: { "aria-label": t("math.graph.tableFn") } });
		select.createEl("option", { text: t("math.graph.none"), value: "" });
		for (const f of fns) select.createEl("option", { text: f.label ?? f.expr ?? f.id, value: f.id });
		const tbl = this.model.table;
		select.value = tbl && fns.some((f) => f.id === tbl.fn) ? tbl.fn : "";
		select.addEventListener("change", () => {
			if (select.value === "") delete this.model.table;
			else this.model.table = { fn: select.value, from: this.model.table?.from ?? 0, step: this.model.table?.step ?? 1, rows: this.model.table?.rows ?? 6 };
			this.renderTable();
			this.changed();
		});
		const table = this.model.table;
		if (!table || select.value === "") return;
		this.num(box, "math.graph.tableFrom", table.from, (v) => {
			if (v !== undefined) table.from = v;
		});
		this.num(box, "math.graph.tableStep", table.step, (v) => {
			if (v !== undefined && v !== 0) table.step = v;
		});
		this.num(box, "math.graph.tableRows", table.rows, (v) => {
			if (v !== undefined) table.rows = Math.min(GRAPH_TABLE_MAX_ROWS, Math.max(1, Math.round(v)));
		});
	}

	private done(): void {
		if (this.closed) return;
		this.flush();
		this.closed = true;
		this.destroy();
		this.handlers.done();
	}

	private cancel(): void {
		if (this.closed) return;
		this.closed = true;
		this.destroy();
		this.handlers.cancel();
	}
}
