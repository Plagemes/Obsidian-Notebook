/**
 * Output of the advanced calculator (#182): numbers as text and as LaTeX with configurable notation and significant
 * figures, fractions, complex numbers, quantities with their unit, matrices, and the typed expression as LaTeX (for the
 * formula element that carries the expression with its result). Pure: no 'obsidian', no DOM.
 */
import { fracToNumber, isCx, isFrac, type Entry, type Mat, type Real } from "./calc-number";
import { inUnit, type Quantity, type Value } from "./calc";
import { type Node } from "./calc-parse";

export type Notation = "auto" | "sci" | "eng";
export type FractionMode = "exact" | "decimal";

export interface FormatOptions {
	/** Significant figures, 3–15; 0 = automatic (12, trailing zeros dropped). */
	sig: number;
	notation: Notation;
	/** Exact results as fractions ("7/12 ≈ 0.5833") or always as decimals. */
	fractions: FractionMode;
}

export const DEFAULT_FORMAT: FormatOptions = { sig: 0, notation: "auto", fractions: "exact" };
export const SIG_MIN = 3;
export const SIG_MAX = 15;
const AUTO_SIG = 12;

export function normaliseFormat(raw: unknown): FormatOptions {
	const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const sig = typeof o.sig === "number" && Number.isFinite(o.sig) ? Math.round(o.sig) : 0;
	return {
		sig: sig === 0 ? 0 : Math.min(SIG_MAX, Math.max(SIG_MIN, sig)),
		notation: o.notation === "sci" || o.notation === "eng" ? o.notation : "auto",
		fractions: o.fractions === "decimal" ? "decimal" : "exact",
	};
}

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n: number): string => (n < 0 ? "⁻" : "") + String(Math.abs(n)).replace(/\d/g, (c) => SUP[Number(c)]!);

interface Parts {
	neg: boolean;
	/** Digits of the significand without the point. */
	digits: string;
	/** Power of ten of the first digit. */
	exp: number;
}

function parts(x: number, sig: number): Parts {
	const [mant, e] = Math.abs(x).toExponential(sig - 1).split("e");
	return { neg: x < 0, digits: mant!.replace(".", ""), exp: Number(e) };
}

function plainDigits(p: Parts, trim: boolean): string {
	const { digits, exp } = p;
	let s: string;
	if (exp >= digits.length - 1) s = digits + "0".repeat(exp - digits.length + 1);
	else if (exp >= 0) s = `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
	else s = `0.${"0".repeat(-exp - 1)}${digits}`;
	if (trim && s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
	return (p.neg ? "-" : "") + s;
}

/** The significand and exponent of a number in scientific or engineering form. */
function scientific(p: Parts, eng: boolean, trim: boolean): { mant: string; exp: number } {
	let exp = p.exp;
	let digits = p.digits;
	let lead = 1;
	if (eng) {
		lead = ((exp % 3) + 3) % 3 + 1;
		exp -= lead - 1;
		if (digits.length < lead) digits += "0".repeat(lead - digits.length);
	}
	let mant = digits.length > lead ? `${digits.slice(0, lead)}.${digits.slice(lead)}` : digits;
	if (trim && mant.includes(".")) mant = mant.replace(/0+$/, "").replace(/\.$/, "");
	return { mant: (p.neg ? "-" : "") + mant, exp };
}

/** A double as text; `latex` writes the exponent as \times 10^{n}. */
export function formatNumber(x: number, o: FormatOptions, latex = false): string {
	if (Number.isNaN(x)) return "NaN";
	if (!Number.isFinite(x)) return x < 0 ? (latex ? "-\\infty" : "-∞") : latex ? "\\infty" : "∞";
	if (x === 0) return "0";
	const trim = o.sig === 0;
	const sig = o.sig === 0 ? AUTO_SIG : o.sig;
	const p = parts(x, sig);
	const useSci = o.notation === "sci" || o.notation === "eng" || p.exp >= 12 || p.exp < -6;
	if (!useSci) return plainDigits(p, trim);
	const s = scientific(p, o.notation === "eng", trim);
	return latex ? `${s.mant}\\times 10^{${s.exp}}` : `${s.mant} × 10${sup(s.exp)}`;
}

function digitCount(n: bigint): number {
	return (n < 0n ? -n : n).toString().length;
}

function formatFrac(f: { n: bigint; d: bigint }, o: FormatOptions, latex: boolean): { main: string; approx: string | null } {
	if (f.d === 1n) {
		const forceFloat = o.sig > 0 || o.notation !== "auto" || digitCount(f.n) > 40;
		return { main: forceFloat ? formatNumber(fracToNumber(f), o, latex) : f.n.toString(), approx: null };
	}
	const dec = formatNumber(fracToNumber(f), o, latex);
	if (o.fractions === "decimal" || digitCount(f.n) > 20 || digitCount(f.d) > 20) return { main: dec, approx: null };
	const text = latex ? `${f.n < 0n ? "-" : ""}\\frac{${(f.n < 0n ? -f.n : f.n).toString()}}{${f.d.toString()}}` : `${f.n}/${f.d}`;
	return { main: text, approx: dec };
}

function formatReal(r: Real, o: FormatOptions, dec: boolean, latex: boolean): { main: string; approx: string | null } {
	if (isFrac(r)) return dec ? { main: formatNumber(fracToNumber(r), o, latex), approx: null } : formatFrac(r, o, latex);
	return { main: formatNumber(r, o, latex), approx: null };
}

function formatComplex(c: { re: number; im: number }, o: FormatOptions, latex: boolean): string {
	const re = c.re === 0 ? "" : formatNumber(c.re, o, latex);
	const imAbs = Math.abs(c.im);
	const im = imAbs === 1 ? "i" : `${formatNumber(imAbs, o, latex)}${latex ? "\\," : ""}i`;
	if (re === "") return `${c.im < 0 ? "-" : ""}${im}`;
	return `${re} ${c.im < 0 ? "-" : "+"} ${im}`;
}

export function formatEntry(e: Entry, o: FormatOptions, dec = false, latex = false): { main: string; approx: string | null } {
	if (isCx(e)) return { main: formatComplex(e, o, latex), approx: null };
	return formatReal(e, o, dec, latex);
}

/** A unit text for LaTeX: \mathrm{km/h}. */
export function unitLatex(unit: string): string {
	const body = unit
		.replace(/·/g, "\\cdot ")
		.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (m) => {
			const neg = m.startsWith("⁻");
			const digits = m.replace("⁻", "").replace(/./g, (c) => String(SUP.indexOf(c)));
			return `^{${neg ? "-" : ""}${digits}}`;
		})
		.replace(/°/g, "^\\circ ")
		.replace(/Ω/g, "\\Omega ");
	return `\\mathrm{${body}}`;
}

export interface Formatted {
	/** The answer. */
	text: string;
	/** A second reading of an exact answer (7/12 → 0.58333), null when there is none. */
	approx: string | null;
	/** The same as LaTeX. */
	latex: string;
	/** The cells of a matrix answer, row by row (null for a number). */
	grid: string[][] | null;
}

function gridOf(m: Mat, o: FormatOptions, dec: boolean): string[][] {
	const rows: string[][] = [];
	for (let i = 0; i < m.rows; i++) rows.push(Array.from({ length: m.cols }, (_, j) => formatEntry(m.a[i * m.cols + j]!, o, dec).main));
	return rows;
}

function quantityText(q: Quantity, o: FormatOptions): Formatted {
	const shown = inUnit(q);
	// A quantity with a unit reads as a decimal (16/5 km is 3.2 km).
	const dec = q.dec || shown.unit !== "";
	const main = formatEntry(shown.value, o, dec);
	const lat = formatEntry(shown.value, o, dec, true);
	const withParens = (s: string) => (isCx(shown.value) && shown.unit ? `(${s})` : s);
	if (!shown.unit) return { text: main.main, approx: main.approx, latex: lat.main, grid: null };
	return {
		text: `${withParens(main.main)} ${shown.unit}`,
		approx: main.approx ? `${main.approx} ${shown.unit}` : null,
		latex: `${withParens(lat.main)}\\,${unitLatex(shown.unit)}`,
		grid: null,
	};
}

/** Formats a calculator value for the answer line, the history tape and the page. */
export function formatValue(v: Value, o: FormatOptions = DEFAULT_FORMAT): Formatted {
	if (v.t === "q") return quantityText(v, o);
	const grid = gridOf(v.m, o, v.dec);
	const text = `[${grid.map((r) => r.join(", ")).join("; ")}]`;
	const latexGrid = v.m.rows;
	const body = Array.from({ length: latexGrid }, (_, i) =>
		Array.from({ length: v.m.cols }, (_, j) => formatEntry(v.m.a[i * v.m.cols + j]!, o, v.dec, true).main).join(" & ")).join(" \\\\ ");
	return { text, approx: null, latex: `\\begin{bmatrix} ${body} \\end{bmatrix}`, grid };
}

// ------------------------------------------------------------------------------------------------ the expression as LaTeX

const GREEK = new Map<string, string>([
	["alpha", "\\alpha"], ["beta", "\\beta"], ["gamma", "\\gamma"], ["delta", "\\delta"], ["epsilon", "\\epsilon"], ["zeta", "\\zeta"], ["eta", "\\eta"],
	["theta", "\\theta"], ["iota", "\\iota"], ["kappa", "\\kappa"], ["lambda", "\\lambda"], ["mu", "\\mu"], ["nu", "\\nu"], ["xi", "\\xi"], ["rho", "\\rho"],
	["sigma", "\\sigma"], ["tau", "\\tau"], ["upsilon", "\\upsilon"], ["phi", "\\varphi"], ["chi", "\\chi"], ["psi", "\\psi"], ["omega", "\\omega"], ["pi", "\\pi"],
	["Delta", "\\Delta"], ["Gamma", "\\Gamma"], ["Omega", "\\Omega"], ["Sigma", "\\Sigma"], ["Phi", "\\Phi"], ["Theta", "\\Theta"], ["Lambda", "\\Lambda"],
	["α", "\\alpha"], ["β", "\\beta"], ["γ", "\\gamma"], ["δ", "\\delta"], ["ε", "\\epsilon"], ["θ", "\\theta"], ["λ", "\\lambda"], ["μ", "\\mu"], ["π", "\\pi"],
	["ρ", "\\rho"], ["σ", "\\sigma"], ["τ", "\\tau"], ["φ", "\\varphi"], ["ψ", "\\psi"], ["ω", "\\omega"], ["Δ", "\\Delta"], ["Ω", "\\Omega"], ["Σ", "\\Sigma"],
	["ħ", "\\hbar"], ["hbar", "\\hbar"], ["inf", "\\infty"], ["∞", "\\infty"],
]);

const LATEX_FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "exp", "ln", "log", "det", "min", "max", "gcd", "arg"]);

function nameLatex(name: string): string {
	const g = GREEK.get(name);
	if (g) return g;
	const m = /^([\p{L}]+)_?(\d+|[\p{L}]+)$/u.exec(name);
	if (name.length === 1) return name;
	if (m && name.includes("_")) return `${m[1]}_{${m[2]}}`;
	if (/^[\p{L}]\d+$/u.test(name)) return `${name[0]}_{${name.slice(1)}}`;
	return `\\mathrm{${name.replace(/_/g, "\\_")}}`;
}

/** A unit as it was typed ("kg*m/s^2", "km/h", "m²") as LaTeX. */
function sourceUnitLatex(text: string): string {
	const body = text
		.replace(/[*·⋅]/g, "\\cdot ")
		.replace(/\^\(?(-?\d+)\)?/g, "^{$1}")
		.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (m) => `^{${m.replace("⁻", "-").replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => String(SUP.indexOf(c)))}}`)
		.replace(/°/g, "^\\circ ")
		.replace(/Ω/g, "\\Omega ");
	return `\\mathrm{${body}}`;
}

const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, imul: 2, "/": 2, "^": 4 };

function precOf(n: Node): number {
	switch (n.k) {
		case "bin": return PREC[n.op]!;
		case "neg": return 3;
		case "conv": return 0;
		case "unit": return 5;
		default: return 6;
	}
}

function wrap(n: Node, min: number): string {
	const s = latexOf(n);
	return precOf(n) < min ? `\\left(${s}\\right)` : s;
}

/** The typed expression as LaTeX, in the way the equation editor writes the same maths. */
export function latexOf(n: Node): string {
	switch (n.k) {
		case "num": {
			if (/e/.test(n.src)) {
				const [m, e] = n.src.split("e");
				return `${m}\\times 10^{${Number(e)}}`;
			}
			return n.src.startsWith(".") ? `0${n.src}` : n.src;
		}
		case "name":
			return nameLatex(n.name);
		case "neg":
			return `-${wrap(n.a, 4)}`;
		case "fact":
			return `${wrap(n.a, 5)}!`;
		case "unit":
			return `${latexOf(n.a)}\\,${sourceUnitLatex(n.text)}`;
		case "conv":
			return `${latexOf(n.a)}\\to ${sourceUnitLatex(n.text)}`;
		case "eq":
			return `${latexOf(n.a)} = ${latexOf(n.b)}`;
		case "bin": {
			switch (n.op) {
				case "+":
					return `${wrap(n.a, 1)} + ${wrap(n.b, 2)}`;
				case "-":
					return `${wrap(n.a, 1)} - ${wrap(n.b, 2)}`;
				case "*":
					return `${wrap(n.a, 2)}\\cdot ${wrap(n.b, 3)}`;
				case "imul": {
					const numericRight = n.b.k === "num";
					return `${wrap(n.a, 2)}${numericRight ? "\\cdot " : "\\,"}${wrap(n.b, 3)}`;
				}
				case "/":
					return `\\frac{${latexOf(n.a)}}{${latexOf(n.b)}}`;
				case "^":
					return `${wrap(n.a, 5)}^{${latexOf(n.b)}}`;
			}
			break;
		}
		case "mat":
			return `\\begin{bmatrix} ${n.rows.map((r) => r.map(latexOf).join(" & ")).join(" \\\\ ")} \\end{bmatrix}`;
		case "call": {
			const args = n.args.map(latexOf);
			if (n.name === "sqrt" && args.length === 1) return `\\sqrt{${args[0]}}`;
			if (n.name === "root" && args.length === 2) return `\\sqrt[${args[0]}]{${args[1]}}`;
			if (n.name === "abs" && args.length === 1) return `\\left|${args[0]}\\right|`;
			if (n.name === "floor" && args.length === 1) return `\\lfloor ${args[0]}\\rfloor`;
			if (n.name === "ceil" && args.length === 1) return `\\lceil ${args[0]}\\rceil`;
			const fname = LATEX_FUNCTIONS.has(n.name) ? `\\${n.name}` : `\\operatorname{${n.name.replace(/_/g, "\\_")}}`;
			return `${fname}\\left(${args.join(", ")}\\right)`;
		}
	}
	return "";
}

/** `expr = result` as one LaTeX line. */
export function equationLatex(expr: Node, result: Formatted): string {
	return `${latexOf(expr)} = ${result.latex}`;
}
