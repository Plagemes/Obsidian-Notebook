/**
 * Link from the calculator to function graphs (#113): an expression in `x` (or `f(x) = …`) can be drawn. The graph engine
 * has its own safe parser (src/math/expr.ts), so the expression is handed over as text only after that parser compiles it;
 * the person's variables it uses become graph parameters (sliders). Pure: no 'obsidian', no DOM.
 */
import { isCx, toNum } from "./calc-number";
import { isDimensionless } from "./dimensions";
import { functionNames, type CalcSession } from "./calc";
import { namesIn, parseStatement } from "./calc-parse";
import { compileExpr } from "./expr";

export interface GraphLink {
	/** The function of x, in the graph parser's syntax. */
	expr: string;
	/** The calculator variables it uses, with their value now. */
	params: Array<{ name: string; value: number }>;
	/** The calculator is in degrees: the graph's trigonometric functions are too. */
	degrees: boolean;
}

/** The graph an expression in x gives, or null when it is not a plain function of x the graph engine reads. */
export function graphLink(src: string, session: CalcSession): GraphLink | null {
	let expr: string;
	let names: Set<string>;
	try {
		const st = parseStatement(src, { isVar: (n) => session.vars.has(n), isFn: (n) => session.fns.has(n) || functionNames().includes(n) });
		if (st.k === "defn") {
			if (st.params.length !== 1 || st.params[0] !== "x") return null;
			expr = st.body;
			names = namesIn(st.node);
		} else if (st.k === "expr") {
			expr = src.trim();
			names = namesIn(st.node);
		} else return null;
	} catch {
		return null;
	}
	if (!names.has("x") || session.vars.has("x")) return null;
	const params: GraphLink["params"] = [];
	for (const n of names) {
		if (n === "x") continue;
		const v = session.vars.get(n);
		if (!v) continue;
		if (v.t !== "q" || isCx(v.v) || !isDimensionless(v.dim)) return null;
		params.push({ name: n, value: toNum(v.v) });
	}
	const compiled = compileExpr(expr, { variables: ["x"], params: new Map(params.map((p) => [p.name, p.value])) });
	return compiled.ok ? { expr, params, degrees: session.angle === "deg" } : null;
}
