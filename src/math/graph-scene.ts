/**
 * What a function graph (#113) looks like, as plain drawing primitives in page coordinates (pt): frame, grid, axes,
 * ticks and labels, curves, shaded areas, marked points (roots, maxima and minima, intersections), tangents, the
 * table of values and a legend. The canvas renderer, the thumbnails and the PDF and SVG exports all draw this scene,
 * so they agree. Built from the element only (elements are immutable, so the scene is cached per element object).
 * Pure: no 'obsidian', no DOM.
 */
import type { GraphElement, GraphFunction } from "../model/types";
import { compileExpr, splitEquation, stripLhs, type Compiled } from "./expr";
import { derivative, findExtrema, findIntersections, findRoots, integrate } from "./numeric";
import { clipPolylines, sampleFunction, sampleImplicit, sampleParametric, samplePolar, type Polyline, type Pt, type ViewRect } from "./sample";

export interface SceneLine {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface SceneText {
	x: number;
	y: number;
	text: string;
	/** Horizontal anchor of (x, y). */
	align: "left" | "center" | "right";
	/** Vertical anchor of (x, y). */
	baseline: "top" | "middle" | "bottom";
	size: number;
	color: string;
}

export interface SceneCurve {
	color: string;
	width: number;
	lines: Polyline[];
	/** Dash pattern in pt (tangents). */
	dash?: readonly number[];
}

export interface SceneArea {
	color: string;
	polygons: Polyline[];
}

export interface ScenePoint {
	x: number;
	y: number;
	color: string;
}

export interface GraphScene {
	frame: { x: number; y: number; width: number; height: number };
	grid: SceneLine[];
	axes: SceneLine[];
	areas: SceneArea[];
	curves: SceneCurve[];
	points: ScenePoint[];
	/** Lines drawn above the panels (the legend's colour samples). */
	overlay: SceneCurve[];
	/** Boxes behind text (the table, the legend), drawn before `texts`. */
	panels: Array<{ x: number; y: number; width: number; height: number }>;
	texts: SceneText[];
	/** Functions that could not be drawn: id and the parser's message. */
	errors: Array<{ fn: string; message: string }>;
}

/** Colours shared by every renderer of a graph. */
export const GRAPH_STYLE = {
	background: "#ffffff",
	border: "#94a3b8",
	grid: "#e2e8f0",
	axis: "#475569",
	text: "#334155",
	panel: "#ffffff",
	panelBorder: "#cbd5e1",
	areaAlpha: 0.18,
	gridWidth: 0.4,
	axisWidth: 0.8,
	borderWidth: 0.6,
	pointRadius: 1.8,
	textSize: 6.5,
} as const;

/** A step of 1, 2 or 5 × 10^k close to `raw`. */
export function niceStep(raw: number): number {
	if (!(raw > 0) || !Number.isFinite(raw)) return 1;
	const p = Math.pow(10, Math.floor(Math.log10(raw)));
	const m = raw / p;
	return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** A tick label: as many decimals as the step needs, no "-0", exponent notation for very large or small values. */
export function formatTick(v: number, step: number): string {
	if (Math.abs(v) < step * 1e-9) return "0";
	const abs = Math.abs(v);
	if (abs >= 1e6 || abs < 1e-4) return v.toExponential(Math.max(0, Math.min(6, -Math.floor(Math.log10(step)) + Math.floor(Math.log10(abs)))));
	const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
	return v.toFixed(decimals);
}

/** A value with about four significant digits (points, table, area). */
export function formatValue(v: number): string {
	if (!Number.isFinite(v)) return v > 0 ? "∞" : v < 0 ? "−∞" : "—";
	if (v === 0) return "0";
	const abs = Math.abs(v);
	if (abs >= 1e6 || abs < 1e-4) return v.toExponential(3);
	const s = v.toPrecision(4);
	const out = s.includes(".") ? s.replace(/\.?0+$/, "") : s;
	return out === "-0" ? "0" : out;
}

/** The function of x of a cartesian or piecewise function (null with a message when it does not compile). */
export function functionOfX(fn: GraphFunction, params: ReadonlyMap<string, number>, degrees: boolean): { f: (x: number) => number } | { error: string } {
	const opts = { variables: ["x"], params, degrees };
	if (fn.kind === "cartesian") {
		const c = compileExpr(stripLhs(fn.expr ?? "", "y"), opts);
		if (!c.ok) return { error: c.error };
		const f = c.fn;
		const v = [0];
		const lo = fn.min, hi = fn.max;
		return {
			f: (x) => {
				if (lo !== undefined && hi !== undefined && (x < lo || x > hi)) return NaN;
				v[0] = x;
				return f(v);
			},
		};
	}
	if (fn.kind === "piecewise") {
		const pieces: Array<{ f: Compiled; when: Compiled | null }> = [];
		for (const p of fn.pieces ?? []) {
			const e = compileExpr(stripLhs(p.expr, "y"), opts);
			if (!e.ok) return { error: e.error };
			let when: Compiled | null = null;
			if (p.when !== undefined && p.when.trim() !== "") {
				const w = compileExpr(p.when, opts);
				if (!w.ok) return { error: w.error };
				when = w.fn;
			}
			pieces.push({ f: e.fn, when });
		}
		const v = [0];
		const lo = fn.min, hi = fn.max;
		return {
			f: (x) => {
				if (lo !== undefined && hi !== undefined && (x < lo || x > hi)) return NaN;
				v[0] = x;
				let otherwise: Compiled | null = null;
				for (const p of pieces) {
					if (!p.when) {
						otherwise ??= p.f;
						continue;
					}
					const c = p.when(v);
					if (c !== 0 && !Number.isNaN(c)) return p.f(v);
				}
				return otherwise ? otherwise(v) : NaN;
			},
		};
	}
	return { error: "not a function of x" };
}

/** Graph units → page pt and back for an element. */
export function graphMapping(g: Pick<GraphElement, "x" | "y" | "width" | "height" | "view">): {
	toPage: (gx: number, gy: number) => Pt;
	toGraph: (px: number, py: number) => Pt;
} {
	const { xMin, xMax, yMin, yMax } = g.view;
	const kx = g.width / (xMax - xMin);
	const ky = g.height / (yMax - yMin);
	return {
		toPage: (gx, gy) => [g.x + (gx - xMin) * kx, g.y + (yMax - gy) * ky],
		toGraph: (px, py) => [xMin + (px - g.x) / kx, yMax - (py - g.y) / ky],
	};
}

const cache = new WeakMap<GraphElement, GraphScene>();

/** The scene of a graph, cached per element object (elements never change: an edit makes a new one). */
export function graphScene(g: GraphElement): GraphScene {
	let s = cache.get(g);
	if (!s) {
		s = buildScene(g);
		cache.set(g, s);
	}
	return s;
}

function ticks(min: number, max: number, step: number): number[] {
	const out: number[] = [];
	const first = Math.ceil(min / step - 1e-9);
	for (let k = first; k * step <= max + step * 1e-9 && out.length < 400; k++) out.push(k * step);
	return out;
}

function stepFor(span: number, pt: number, given: number | undefined): number {
	if (given !== undefined && given > 0 && span / given <= 200) return given;
	return niceStep(span / Math.max(1, pt / 42));
}

function buildScene(g: GraphElement): GraphScene {
	const S = GRAPH_STYLE;
	const view: ViewRect = g.view;
	const { toPage } = graphMapping(g);
	const scene: GraphScene = {
		frame: { x: g.x, y: g.y, width: g.width, height: g.height },
		grid: [], axes: [], areas: [], curves: [], points: [], overlay: [], panels: [], texts: [], errors: [],
	};
	const xStep = stepFor(view.xMax - view.xMin, g.width, g.xStep);
	const yStep = stepFor(view.yMax - view.yMin, g.height, g.yStep);
	const xs = ticks(view.xMin, view.xMax, xStep);
	const ys = ticks(view.yMin, view.yMax, yStep);
	if (g.grid !== false) {
		for (const x of xs) {
			const [px] = toPage(x, 0);
			scene.grid.push({ x1: px, y1: g.y, x2: px, y2: g.y + g.height });
		}
		for (const y of ys) {
			const [, py] = toPage(0, y);
			scene.grid.push({ x1: g.x, y1: py, x2: g.x + g.width, y2: py });
		}
	}
	const T = (x: number, y: number, text: string, align: SceneText["align"], baseline: SceneText["baseline"], color: string = S.text, size: number = S.textSize): void => {
		scene.texts.push({ x, y, text, align, baseline, size, color });
	};
	if (g.axes !== false) {
		// Axes through the origin when it is in view, else along the nearest edge (ticks keep their labels).
		const ax = Math.min(Math.max(0, view.xMin), view.xMax);
		const ay = Math.min(Math.max(0, view.yMin), view.yMax);
		const [pax, pay] = toPage(ax, ay);
		const showX = view.yMin <= 0 && view.yMax >= 0;
		const showY = view.xMin <= 0 && view.xMax >= 0;
		if (showX) scene.axes.push({ x1: g.x, y1: pay, x2: g.x + g.width, y2: pay });
		if (showY) scene.axes.push({ x1: pax, y1: g.y, x2: pax, y2: g.y + g.height });
		const labelY = Math.min(g.y + g.height - S.textSize - 1, Math.max(g.y + 1, pay + 1.5));
		const labelX = Math.min(g.x + g.width - 1, Math.max(g.x + S.textSize * 2.2, pax - 1.5));
		for (const x of xs) {
			if (Math.abs(x) < xStep * 1e-9 && showY) continue;
			const [px] = toPage(x, 0);
			if (showX) scene.axes.push({ x1: px, y1: pay - 1.5, x2: px, y2: pay + 1.5 });
			if (px < g.x + 4 || px > g.x + g.width - 4) continue;
			T(px, labelY, formatTick(x, xStep), "center", "top");
		}
		for (const y of ys) {
			const [, py] = toPage(0, y);
			if (showY) scene.axes.push({ x1: pax - 1.5, y1: py, x2: pax + 1.5, y2: py });
			if (py < g.y + 4 || py > g.y + g.height - 4) continue;
			T(labelX, py, formatTick(y, yStep), "right", "middle");
		}
		if (showX && showY) T(labelX, labelY, "0", "right", "top");
		if (g.xLabel) T(g.x + g.width - 2, Math.max(g.y + 1, pay - 2), g.xLabel, "right", "bottom");
		if (g.yLabel) T(Math.min(g.x + g.width - 2, pax + 3), g.y + 2, g.yLabel, "left", "top");
	}

	const params = new Map((g.params ?? []).map((p) => [p.name, p.value]));
	const degrees = g.degrees === true;
	const opts = { width: g.width, height: g.height };
	const toPageLines = (lines: Polyline[]) => lines.map((l) => l.map(([x, y]) => toPage(x, y)));
	const ofX = new Map<string, (x: number) => number>();
	const visible = g.functions.filter((f) => !f.hidden);
	for (const fn of visible) {
		const width = fn.width ?? 1.2;
		let lines: Polyline[] = [];
		if (fn.kind === "cartesian" || fn.kind === "piecewise") {
			const r = functionOfX(fn, params, degrees);
			if ("error" in r) {
				scene.errors.push({ fn: fn.id, message: r.error });
				continue;
			}
			ofX.set(fn.id, r.f);
			lines = sampleFunction(r.f, view, opts, fn.min ?? view.xMin, fn.max ?? view.xMax);
		} else if (fn.kind === "parametric") {
			const cx = compileExpr(fn.x ?? "", { variables: ["t"], params, degrees });
			const cy = compileExpr(fn.y ?? "", { variables: ["t"], params, degrees });
			if (!cx.ok || !cy.ok) {
				scene.errors.push({ fn: fn.id, message: !cx.ok ? cx.error : !cy.ok ? cy.error : "" });
				continue;
			}
			const v = [0];
			lines = sampleParametric((t) => ((v[0] = t), cx.fn(v)), (t) => ((v[0] = t), cy.fn(v)), fn.min ?? 0, fn.max ?? 2 * Math.PI, view, opts);
		} else if (fn.kind === "polar") {
			const c = compileExpr(stripLhs(fn.expr ?? "", "r"), { variables: ["θ"], params, degrees });
			if (!c.ok) {
				scene.errors.push({ fn: fn.id, message: c.error });
				continue;
			}
			const v = [0];
			lines = samplePolar((t) => ((v[0] = t), c.fn(v)), fn.min ?? 0, fn.max ?? (degrees ? 360 : 2 * Math.PI), view, opts, degrees);
		} else {
			const src = fn.expr ?? "";
			const eq = splitEquation(src);
			const vars = { variables: ["x", "y"], params, degrees };
			const lhs = compileExpr(eq ? eq.lhs : src, vars);
			const rhs = eq ? compileExpr(eq.rhs, vars) : null;
			if (!lhs.ok || (rhs && !rhs.ok)) {
				scene.errors.push({ fn: fn.id, message: !lhs.ok ? lhs.error : rhs && !rhs.ok ? rhs.error : "" });
				continue;
			}
			const v = [0, 0];
			const L = lhs.fn;
			const R = rhs && rhs.ok ? rhs.fn : null;
			lines = sampleImplicit((x, y) => ((v[0] = x), (v[1] = y), R ? L(v) - R(v) : L(v)), view, opts);
		}
		scene.curves.push({ color: fn.color, width, lines: toPageLines(lines) });
	}

	// Analysis of the functions of x: tangents, shaded areas, roots, extrema, intersections.
	const mark = (gx: number, gy: number, color: string, label: string) => {
		if (!(gx >= view.xMin && gx <= view.xMax && gy >= view.yMin && gy <= view.yMax)) return;
		const [px, py] = toPage(gx, gy);
		scene.points.push({ x: px, y: py, color });
		if (label) T(px + 2.5, py - 2.5, label, "left", "bottom", color, S.textSize - 0.5);
	};
	const pairs = new Set<string>();
	for (const fn of visible) {
		const f = ofX.get(fn.id);
		if (!f) continue;
		if (fn.area) {
			const a = Math.max(Math.min(fn.area.from, fn.area.to), view.xMin - (view.xMax - view.xMin));
			const b = Math.min(Math.max(fn.area.from, fn.area.to), view.xMax + (view.xMax - view.xMin));
			const parts = sampleFunction(f, { ...view, xMin: a, xMax: b }, { ...opts, width: g.width * (b - a) / (view.xMax - view.xMin) }, a, b);
			const polygons = clipPolylines(parts, { xMin: a, xMax: b, yMin: -1e300, yMax: 1e300 })
				.filter((l) => l.length > 1)
				.map((l) => toPageLines([[[l[0]![0], 0], ...l, [l[l.length - 1]![0], 0]]])[0]!);
			if (polygons.length > 0) scene.areas.push({ color: fn.color, polygons });
			const value = integrate(f, fn.area.from, fn.area.to);
			const mid = (fn.area.from + fn.area.to) / 2;
			const fm = f(mid);
			const [lx, ly] = toPage(Math.min(Math.max(mid, view.xMin), view.xMax), Number.isFinite(fm) ? Math.min(Math.max(fm / 2, view.yMin), view.yMax) : 0);
			T(lx, ly, `∫ = ${formatValue(value)}`, "center", "middle", fn.color);
		}
		if (fn.tangent !== undefined && Number.isFinite(fn.tangent)) {
			const x0 = fn.tangent;
			const y0 = f(x0);
			const m = derivative(f, x0);
			if (Number.isFinite(y0) && Number.isFinite(m)) {
				const line: Polyline = [[view.xMin, y0 + m * (view.xMin - x0)], [view.xMax, y0 + m * (view.xMax - x0)]];
				const clipped = clipPolylines([line], { xMin: view.xMin, xMax: view.xMax, yMin: view.yMin - (view.yMax - view.yMin), yMax: view.yMax + (view.yMax - view.yMin) });
				scene.curves.push({ color: fn.color, width: Math.max(0.6, (fn.width ?? 1.2) * 0.7), lines: toPageLines(clipped), dash: [3, 2] });
				const q = y0 - m * x0;
				mark(x0, y0, fn.color, `y = ${formatValue(m)}x ${q < 0 ? "−" : "+"} ${formatValue(Math.abs(q))}`);
			}
		}
		if (fn.roots) for (const x of findRoots(f, view.xMin, view.xMax, 600, 20)) mark(x, 0, fn.color, formatValue(x));
		if (fn.extrema) {
			for (const e of findExtrema(f, view.xMin, view.xMax, 600, 20)) mark(e.x, e.y, fn.color, `(${formatValue(e.x)}, ${formatValue(e.y)})`);
		}
		if (fn.intersections) {
			for (const other of visible) {
				const h = ofX.get(other.id);
				if (!h || other.id === fn.id) continue;
				const key = [fn.id, other.id].sort().join(" ");
				if (pairs.has(key)) continue;
				pairs.add(key);
				for (const x of findIntersections(f, h, view.xMin, view.xMax, 600, 20)) mark(x, f(x), fn.color, `(${formatValue(x)}, ${formatValue(f(x))})`);
			}
		}
	}

	// Table of values, top left; legend (labels and errors), top right.
	const rowH = S.textSize + 2;
	const t = g.table;
	const tf = t ? ofX.get(t.fn) : undefined;
	if (t && tf) {
		const rows = Math.max(0, Math.min(t.rows, Math.floor((g.height - 6) / rowH) - 1));
		const cells = Array.from({ length: rows }, (_, i) => {
			const x = t.from + i * t.step;
			return [formatValue(x), formatValue(tf(x))] as const;
		});
		const fnLabel = g.functions.find((f) => f.id === t.fn)?.label ?? `${t.fn}(x)`;
		const colW = Math.max(4, ...cells.map((c) => c[0].length), 1) * S.textSize * 0.55 + 4;
		const valW = Math.max(fnLabel.length, ...cells.map((c) => c[1].length), 1) * S.textSize * 0.55 + 4;
		const px = g.x + 3, py = g.y + 3;
		scene.panels.push({ x: px, y: py, width: colW + valW, height: rowH * (rows + 1) + 2 });
		T(px + 2, py + 1, "x", "left", "top", S.axis);
		T(px + colW + 2, py + 1, fnLabel, "left", "top", S.axis);
		cells.forEach(([a, b], i) => {
			T(px + 2, py + 1 + rowH * (i + 1), a, "left", "top");
			T(px + colW + 2, py + 1 + rowH * (i + 1), b, "left", "top");
		});
	}
	const legend = g.functions.filter((f) => !f.hidden && (f.label !== undefined || scene.errors.some((e) => e.fn === f.id)));
	if (legend.length > 0) {
		const lines = legend.map((f) => {
			const err = scene.errors.find((e) => e.fn === f.id);
			return { color: f.color, text: err ? `${f.label ?? f.id}: ${err.message}` : f.label! };
		});
		const w = Math.min(g.width - 6, Math.max(...lines.map((l) => l.text.length)) * S.textSize * 0.55 + 12);
		const px = g.x + g.width - 3 - w, py = g.y + 3;
		scene.panels.push({ x: px, y: py, width: w, height: rowH * lines.length + 2 });
		lines.forEach((l, i) => {
			const y = py + 1 + rowH * i + rowH / 2;
			scene.overlay.push({ color: l.color, width: 1.2, lines: [[[px + 2, y], [px + 8, y]]] });
			T(px + 10, y, l.text, "left", "middle", l.color);
		});
	}
	return scene;
}
