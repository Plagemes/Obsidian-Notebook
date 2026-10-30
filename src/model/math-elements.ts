/**
 * v9 equations (#110) and function graphs (#113): limits, normalisation and pure helpers shared by the format, the
 * view, the exports and the tests. No 'obsidian', no canvas. Elements are immutable: helpers return new elements.
 */
import { isReservedName } from "../math/expr";
import { createId } from "./document";
import {
	GRAPH_FUNCTION_KINDS,
	type EquationElement, type GraphElement, type GraphFunction, type GraphFunctionKind, type GraphViewport, type Page, type PageElement,
} from "./types";

/** Longest LaTeX source of an equation, characters. */
export const EQUATION_LATEX_MAX = 4000;
/** Longest cached outline of an equation, characters (a long derivation stays well below). */
export const EQUATION_OUTLINE_MAX = 600_000;
/** Longest expression of a graphed function, characters. */
export const GRAPH_EXPR_MAX = 500;
/** Longest graph label (axis name, function label), characters. */
export const GRAPH_LABEL_MAX = 60;
export const GRAPH_MAX_FUNCTIONS = 12;
export const GRAPH_MAX_PARAMS = 12;
export const GRAPH_MAX_PIECES = 10;
export const GRAPH_TABLE_MAX_ROWS = 50;
/** Default and largest line width of a graphed function, pt. */
export const GRAPH_LINE_WIDTH = 1.2;
export const GRAPH_MAX_LINE_WIDTH = 20;
/** Largest coordinate of a graph viewport and smallest span (beyond these, doubles lose the curve). */
export const GRAPH_MAX_ABS = 1e12;
export const GRAPH_MIN_SPAN = 1e-9;
/** Longest function id, characters. */
export const GRAPH_ID_MAX = 64;

/** Default colours of the functions of a graph, in order. */
export const GRAPH_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#be185d", "#4d7c0f"] as const;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function isEquation(e: PageElement): e is EquationElement {
	return e.type === "equation";
}

export function isGraph(e: PageElement): e is GraphElement {
	return e.type === "graph";
}

export function isGraphFunctionKind(v: unknown): v is GraphFunctionKind {
	return typeof v === "string" && (GRAPH_FUNCTION_KINDS as readonly string[]).includes(v);
}

/** A graph label as one trimmed line, at most GRAPH_LABEL_MAX characters; undefined when empty. */
export function cleanGraphLabel(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const chars = Array.from(raw.replace(/\s+/g, " ").trim());
	const out = chars.slice(0, GRAPH_LABEL_MAX).join("").trim();
	return out.length > 0 ? out : undefined;
}

/** A parameter name: a letter, then letters, digits or "_" (at most 16), and not a name of the expression language. */
export function isParamName(v: unknown): v is string {
	return typeof v === "string" && /^\p{L}[\p{L}\p{N}_]{0,15}$/u.test(v) && !isReservedName(v);
}

/** A viewport the sampler can draw: finite, ordered, not too large and not too small. */
export function isViewport(v: GraphViewport): boolean {
	const ok = (n: number) => Number.isFinite(n) && Math.abs(n) <= GRAPH_MAX_ABS;
	return ok(v.xMin) && ok(v.xMax) && ok(v.yMin) && ok(v.yMax)
		&& v.xMax - v.xMin >= GRAPH_MIN_SPAN && v.yMax - v.yMin >= GRAPH_MIN_SPAN;
}

/** Parameter values of a graph by name. */
export function graphParams(g: GraphElement): Map<string, number> {
	return new Map((g.params ?? []).map((p) => [p.name, p.value]));
}

/** A function id that is not used by the graph yet. */
export function nextFunctionId(g: Pick<GraphElement, "functions">): string {
	const used = new Set(g.functions.map((f) => f.id));
	for (let n = g.functions.length + 1; ; n++) if (!used.has(`f${n}`)) return `f${n}`;
}

/** A new function of `kind` with a sensible example expression and the next default colour. */
export function newGraphFunction(g: Pick<GraphElement, "functions">, kind: GraphFunctionKind = "cartesian"): GraphFunction {
	const id = nextFunctionId(g);
	const color = GRAPH_COLORS[g.functions.length % GRAPH_COLORS.length]!;
	switch (kind) {
		case "parametric": return { id, kind, color, x: "cos(t)", y: "sin(2t)", min: 0, max: 2 * Math.PI };
		case "polar": return { id, kind, color, expr: "1 + cos(θ)", min: 0, max: 2 * Math.PI };
		case "implicit": return { id, kind, color, expr: "x^2 + y^2 = 4" };
		case "piecewise": return { id, kind, color, pieces: [{ expr: "-x", when: "x < 0" }, { expr: "x^2" }] };
		default: return { id, kind, color, expr: g.functions.length === 0 ? "sin(x)" : "x^2" };
	}
}

/**
 * A new graph of `width` × `height` pt with its top-left corner at (`x`, `y`): one function, the x range −6…6 and a y
 * range of the same scale (squares look square).
 */
export function createGraph(x: number, y: number, width = 240, height = 160): GraphElement {
	const halfX = 6;
	const halfY = round2((halfX * height) / width);
	const g: GraphElement = {
		id: createId(), type: "graph", x: round2(x), y: round2(y), width: round2(width), height: round2(height),
		view: { xMin: -halfX, xMax: halfX, yMin: -halfY, yMax: halfY }, functions: [],
	};
	g.functions = [newGraphFunction(g)];
	return g;
}

/** A new equation; `size` is the box the typeset maths takes (pt). */
export function createEquation(
	x: number, y: number, latex: string, fontSize: number, color: string,
	options: { width?: number; height?: number; inline?: boolean; numbered?: boolean; outline?: string } = {},
): EquationElement {
	const eq: EquationElement = {
		id: createId(), type: "equation", x: round2(x), y: round2(y),
		width: round2(Math.max(1, options.width ?? fontSize * Math.max(1, latex.length) * 0.5)),
		height: round2(Math.max(1, options.height ?? fontSize * 1.2)),
		latex, fontSize: round2(fontSize), color,
	};
	if (options.inline) eq.inline = true;
	if (options.numbered) eq.numbered = true;
	if (options.outline) eq.outline = options.outline;
	return eq;
}

/**
 * Numbers of the numbered equations of `pages`, in reading order (page by page, then top to bottom, then left to
 * right within a row of about the same height): 1, 2, 3…
 */
export function equationNumbers(pages: readonly Page[]): Map<string, number> {
	const out = new Map<string, number>();
	let n = 0;
	for (const page of pages) {
		const eqs = (page.elements ?? []).filter((e): e is EquationElement => e.type === "equation" && e.numbered === true);
		if (eqs.length === 0) continue;
		eqs.sort((a, b) => {
			const row = Math.min(a.height, b.height) / 2;
			const ca = a.y + a.height / 2;
			const cb = b.y + b.height / 2;
			if (Math.abs(ca - cb) > row) return ca - cb;
			return a.x - b.x;
		});
		for (const e of eqs) out.set(e.id, ++n);
	}
	return out;
}

/** Text of an equation number. */
export function equationNumberLabel(n: number): string {
	return `(${n})`;
}

/** Gap between an equation and its number, in em of the equation. */
export const EQUATION_NUMBER_GAP = 1;

/**
 * JSON with keys sorted at every level: a content key for elements with nested data (graphs), where the replacer-array
 * form of JSON.stringify would drop nested keys that are not also top-level keys.
 */
export function stableStringify(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Record<string, unknown>;
		const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
	}
	return JSON.stringify(v) ?? "null";
}

/** Freezes the nested data of a graph (functions, pieces, parameters, viewport, table) so a copy can share it safely. */
export function deepFreezeGraph(g: GraphElement): void {
	Object.freeze(g.view);
	for (const f of g.functions) {
		if (f.pieces) {
			for (const p of f.pieces) Object.freeze(p);
			Object.freeze(f.pieces);
		}
		if (f.area) Object.freeze(f.area);
		Object.freeze(f);
	}
	Object.freeze(g.functions);
	if (g.params) {
		for (const p of g.params) Object.freeze(p);
		Object.freeze(g.params);
	}
	if (g.table) Object.freeze(g.table);
}
