/**
 * Drawing v9 equations (#110) and function graphs (#113) on a canvas, in page coordinates. Equations are filled from
 * their vector outline (the cached one in the element, or one typeset this session); graphs draw the scene of
 * src/math/graph-scene.ts. Used by the renderer, the live layer and the thumbnails. No 'obsidian'.
 */
import { EQUATION_NUMBER_GAP, equationNumberLabel } from "../model/math-elements";
import type { EquationElement, GraphElement } from "../model/types";
import { graphScene, GRAPH_STYLE, type GraphScene } from "../math/graph-scene";
import { parseOutline, type Polygon } from "../math/outline";

/** An outline typeset this session for an equation without a cached one: its natural size and path. */
export interface Typeset {
	width: number;
	height: number;
	outline: string;
}

const typeset = new Map<string, Typeset>();
let request: ((el: EquationElement) => void) | null = null;

/** Key of what a typeset outline depends on. */
export function typesetKey(el: Pick<EquationElement, "latex" | "inline" | "fontSize">): string {
	return `${el.inline ? "i" : "d"}|${el.fontSize}|${el.latex}`;
}

/** Remembers an outline typeset for `key` (the view, after MathJax). */
export function storeTypeset(key: string, value: Typeset): void {
	if (typeset.size > 500) typeset.clear();
	typeset.set(key, value);
}

/** The view's hook that typesets equations drawn without an outline (null: none, the source is shown instead). */
export function setTypesetRequest(fn: ((el: EquationElement) => void) | null): void {
	request = fn;
}

/** The outline to draw for an equation, scaled to its box: the cached one, or one typeset this session. */
export function equationOutline(el: EquationElement): { polys: Polygon[]; sx: number; sy: number } | null {
	if (el.outline !== undefined) {
		const polys = parsedOutline(el.outline);
		if (polys) return { polys, sx: 1, sy: 1 };
	}
	const t = typeset.get(typesetKey(el));
	if (!t) return null;
	const polys = parsedOutline(t.outline);
	return polys ? { polys, sx: el.width / t.width, sy: el.height / t.height } : null;
}

const parsed = new Map<string, Polygon[] | null>();

function parsedOutline(d: string): Polygon[] | null {
	let p = parsed.get(d);
	if (p === undefined) {
		if (parsed.size > 300) parsed.clear();
		p = parseOutline(d);
		parsed.set(d, p);
	}
	return p;
}

function tracePolys(ctx: CanvasRenderingContext2D, polys: readonly Polygon[], ox: number, oy: number, sx: number, sy: number): void {
	ctx.beginPath();
	for (const p of polys) {
		ctx.moveTo(ox + p[0]![0] * sx, oy + p[0]![1] * sy);
		for (let i = 1; i < p.length; i++) ctx.lineTo(ox + p[i]![0] * sx, oy + p[i]![1] * sy);
		ctx.closePath();
	}
}

/** Draws an equation; `number` is its automatic number when it is numbered. */
export function drawEquation(ctx: CanvasRenderingContext2D, el: EquationElement, number?: number): void {
	const o = equationOutline(el);
	ctx.save();
	try {
		if (o) {
			ctx.fillStyle = el.color;
			tracePolys(ctx, o.polys, el.x, el.y, o.sx, o.sy);
			ctx.fill("evenodd");
		} else {
			// Not typeset yet (or no maths engine): the source, readable, in a light frame.
			request?.(el);
			ctx.fillStyle = "rgba(148, 163, 184, 0.12)";
			ctx.fillRect(el.x, el.y, el.width, el.height);
			ctx.fillStyle = el.color;
			ctx.font = `${Math.max(4, Math.min(el.fontSize, el.height) * 0.8)}px monospace`;
			ctx.textBaseline = "middle";
			ctx.fillText(el.latex.replace(/\s+/g, " "), el.x + 2, el.y + el.height / 2, Math.max(4, el.width - 4));
		}
		if (number !== undefined) {
			ctx.fillStyle = el.color;
			ctx.font = `${el.fontSize}px serif`;
			ctx.textBaseline = "middle";
			ctx.fillText(equationNumberLabel(number), el.x + el.width + el.fontSize * EQUATION_NUMBER_GAP, el.y + el.height / 2);
		}
	} finally {
		ctx.restore();
	}
}

/**
 * Colours of a graph drawn in another palette (night mode, view only): `paper` replaces the white background and the
 * panels, `ink` maps the colours of curves, points and labels, `line` the grid, axes and borders.
 */
export interface GraphPalette {
	paper: string;
	ink: (color: string) => string;
	line: (color: string) => string;
}

const SAME: GraphPalette = { paper: GRAPH_STYLE.background, ink: (c) => c, line: (c) => c };

/** Draws a graph scene (frame, grid, axes, areas, curves, points, panels, texts), clipped to the frame. */
export function drawGraphScene(ctx: CanvasRenderingContext2D, s: GraphScene, palette: GraphPalette = SAME): void {
	const S = GRAPH_STYLE;
	const P = palette;
	const f = s.frame;
	ctx.save();
	try {
		ctx.fillStyle = P.paper;
		ctx.fillRect(f.x, f.y, f.width, f.height);
		ctx.beginPath();
		ctx.rect(f.x, f.y, f.width, f.height);
		ctx.clip();
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const lines = (list: GraphScene["grid"], color: string, width: number) => {
			if (list.length === 0) return;
			ctx.strokeStyle = P.line(color);
			ctx.lineWidth = width;
			ctx.beginPath();
			for (const l of list) {
				ctx.moveTo(l.x1, l.y1);
				ctx.lineTo(l.x2, l.y2);
			}
			ctx.stroke();
		};
		lines(s.grid, S.grid, S.gridWidth);
		lines(s.axes, S.axis, S.axisWidth);
		for (const a of s.areas) {
			ctx.globalAlpha = S.areaAlpha;
			ctx.fillStyle = P.ink(a.color);
			ctx.beginPath();
			for (const p of a.polygons) {
				ctx.moveTo(p[0]![0], p[0]![1]);
				for (let i = 1; i < p.length; i++) ctx.lineTo(p[i]![0], p[i]![1]);
				ctx.closePath();
			}
			ctx.fill();
			ctx.globalAlpha = 1;
		}
		for (const c of s.curves) {
			ctx.strokeStyle = P.ink(c.color);
			ctx.lineWidth = c.width;
			ctx.setLineDash(c.dash ? [...c.dash] : []);
			ctx.beginPath();
			for (const l of c.lines) {
				if (l.length === 0) continue;
				ctx.moveTo(l[0]![0], l[0]![1]);
				if (l.length === 1) ctx.lineTo(l[0]![0] + 0.01, l[0]![1]);
				for (let i = 1; i < l.length; i++) ctx.lineTo(l[i]![0], l[i]![1]);
			}
			ctx.stroke();
		}
		ctx.setLineDash([]);
		for (const p of s.points) {
			ctx.fillStyle = P.ink(p.color);
			ctx.beginPath();
			ctx.arc(p.x, p.y, S.pointRadius, 0, Math.PI * 2);
			ctx.fill();
		}
		for (const p of s.panels) {
			ctx.fillStyle = P === SAME ? S.panel : P.paper;
			ctx.globalAlpha = 0.92;
			ctx.fillRect(p.x, p.y, p.width, p.height);
			ctx.globalAlpha = 1;
			ctx.strokeStyle = P.line(S.panelBorder);
			ctx.lineWidth = 0.5;
			ctx.strokeRect(p.x, p.y, p.width, p.height);
		}
		// Legend colour samples, above the panels.
		for (const c of s.overlay) {
			ctx.strokeStyle = P.ink(c.color);
			ctx.lineWidth = c.width;
			ctx.beginPath();
			for (const l of c.lines) {
				if (l.length < 2) continue;
				ctx.moveTo(l[0]![0], l[0]![1]);
				for (let i = 1; i < l.length; i++) ctx.lineTo(l[i]![0], l[i]![1]);
			}
			ctx.stroke();
		}
		for (const t of s.texts) {
			ctx.fillStyle = P.ink(t.color);
			ctx.font = `${t.size}px sans-serif`;
			ctx.textAlign = t.align;
			ctx.textBaseline = t.baseline === "top" ? "top" : t.baseline === "bottom" ? "bottom" : "middle";
			ctx.fillText(t.text, t.x, t.y);
		}
	} finally {
		ctx.restore();
	}
	ctx.save();
	ctx.strokeStyle = P.line(S.border);
	ctx.lineWidth = S.borderWidth;
	ctx.strokeRect(f.x, f.y, f.width, f.height);
	ctx.restore();
}

/** Draws a graph element (in `palette`, e.g. night mode; default its own colours). */
export function drawGraph(ctx: CanvasRenderingContext2D, el: GraphElement, palette?: GraphPalette): void {
	drawGraphScene(ctx, graphScene(el), palette);
}
