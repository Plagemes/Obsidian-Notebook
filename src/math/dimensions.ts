/**
 * Dimensional analysis of formulas (#293). A typed formula (LaTeX as in the equation editor, or plain text such as
 * `5 m + 3 s`) is read with a small hand-written tokenizer and recursive-descent parser; every quantity carries a
 * dimension, a vector of exponents of the seven SI base quantities. Dimensions propagate through + − × ÷ ^, roots,
 * functions, fractions, derivatives, integrals and sums, and are compared on both sides of `=` (and `<`, `≈`, …).
 *
 * Where the dimension comes from:
 * - units written next to numbers: `5\,\mathrm{m}`, `\text{kg}`, `\mathrm{m/s^2}`, `\SI{3}{N}` (SI units and prefixes,
 *   common derived units: N, J, W, Pa, Hz, C, V, Ω, F, H, T, Wb, S, lm, lx, Bq, Gy, Sv, kat, and a few non-SI ones:
 *   min, h, day, L, t, eV, bar, atm, cal, Wh, ft, in, mi, lb, …);
 * - symbols declared on a line of their own: `[v] = m/s`, or defined by a value: `m = 2\,\mathrm{kg}` (a symbol bound
 *   earlier in the text keeps its dimension on the following lines);
 * - `opts.symbols` (symbol → unit expression).
 * A symbol with no known dimension is a wildcard: nothing that touches it is flagged (the check never guesses). Only
 * dimensions are compared, not scales: `3 m + 2 km` is consistent.
 *
 * Pure: no 'obsidian', no DOM. A hostile text cannot overflow the stack or run long (token and depth limits).
 */

// ------------------------------------------------------------------------------------------------ dimensions

/** Exponents of length, mass, time, current, temperature, amount of substance and luminous intensity (SI). */
export type Dim = readonly number[];

function dim(l = 0, m = 0, t = 0, i = 0, th = 0, n = 0, j = 0): Dim {
	return [l, m, t, i, th, n, j];
}

export const DIMENSIONLESS: Dim = dim();
const TIME: Dim = dim(0, 0, 1);

const EPS = 1e-9;

export function dimEqual(a: Dim, b: Dim): boolean {
	for (let i = 0; i < 7; i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > EPS) return false;
	return true;
}

export function isDimensionless(a: Dim): boolean {
	return dimEqual(a, DIMENSIONLESS);
}

function dimMul(a: Dim, b: Dim): Dim {
	return a.map((x, i) => x + (b[i] ?? 0));
}

function dimDiv(a: Dim, b: Dim): Dim {
	return a.map((x, i) => x - (b[i] ?? 0));
}

function dimPow(a: Dim, p: number): Dim {
	return a.map((x) => x * p);
}

// ------------------------------------------------------------------------------------------------ units

interface UnitDef {
	dim: Dim;
	prefixable: boolean;
}

const UNITS = new Map<string, UnitDef>();

function defUnit(names: readonly string[], d: Dim, prefixable = false): void {
	for (const n of names) UNITS.set(n, { dim: d, prefixable });
}

// SI base units (the kilogram is the prefixed gram).
defUnit(["m"], dim(1), true);
defUnit(["g"], dim(0, 1), true);
defUnit(["s"], dim(0, 0, 1), true);
defUnit(["A"], dim(0, 0, 0, 1), true);
defUnit(["K"], dim(0, 0, 0, 0, 1), true);
defUnit(["mol"], dim(0, 0, 0, 0, 0, 1), true);
defUnit(["cd"], dim(0, 0, 0, 0, 0, 0, 1), true);
// Derived units with a name.
defUnit(["N"], dim(1, 1, -2), true);
defUnit(["Pa"], dim(-1, 1, -2), true);
defUnit(["J"], dim(2, 1, -2), true);
defUnit(["W"], dim(2, 1, -3), true);
defUnit(["C"], dim(0, 0, 1, 1), true);
defUnit(["V"], dim(2, 1, -3, -1), true);
defUnit(["Ω", "ohm", "Ohm"], dim(2, 1, -3, -2), true);
defUnit(["S"], dim(-2, -1, 3, 2), true);
defUnit(["F"], dim(-2, -1, 4, 2), true);
defUnit(["Wb"], dim(2, 1, -2, -1), true);
defUnit(["T"], dim(0, 1, -2, -1), true);
defUnit(["H"], dim(2, 1, -2, -2), true);
defUnit(["Hz", "Bq"], dim(0, 0, -1), true);
defUnit(["Gy", "Sv"], dim(2, 0, -2), true);
defUnit(["lm"], dim(0, 0, 0, 0, 0, 0, 1), true);
defUnit(["lx"], dim(-2, 0, 0, 0, 0, 0, 1), true);
defUnit(["kat"], dim(0, 0, -1, 0, 0, 1), true);
defUnit(["rad", "sr"], DIMENSIONLESS, true);
// Accepted with SI (and common in physics).
defUnit(["L", "l"], dim(3), true);
defUnit(["t"], dim(0, 1), true);
defUnit(["u", "Da"], dim(0, 1), true);
defUnit(["eV"], dim(2, 1, -2), true);
defUnit(["bar"], dim(-1, 1, -2), true);
defUnit(["Torr"], dim(-1, 1, -2), true);
defUnit(["cal"], dim(2, 1, -2), true);
defUnit(["Wh"], dim(2, 1, -2), true);
// Not prefixed.
defUnit(["min", "h", "hr", "day", "yr", "year"], TIME);
defUnit(["ha"], dim(2));
defUnit(["Å"], dim(1));
defUnit(["atm", "mmHg", "psi"], dim(-1, 1, -2));
defUnit(["°C", "°F", "degC", "degF"], dim(0, 0, 0, 0, 1));
defUnit(["°", "deg", "%", "ppm", "ppb", "dB"], DIMENSIONLESS);
defUnit(["rpm"], dim(0, 0, -1));
defUnit(["ft", "in", "yd", "mi"], dim(1));
defUnit(["lb", "oz"], dim(0, 1));
defUnit(["mph", "kn"], dim(1, 0, -1));

const PREFIXES = ["da", "Q", "R", "Y", "Z", "E", "P", "T", "G", "M", "k", "h", "d", "c", "m", "µ", "u", "n", "p", "f", "a", "z", "y", "r", "q"];

/** The dimension of a unit symbol with an optional SI prefix (`kg`, `mPa`, `µs`), or null. */
function lookupUnit(word: string): Dim | null {
	const exact = UNITS.get(word);
	if (exact) return exact.dim;
	for (const p of PREFIXES) {
		if (word.length > p.length && word.startsWith(p)) {
			const u = UNITS.get(word.slice(p.length));
			if (u?.prefixable) return u.dim;
		}
	}
	return null;
}

const SUPERSCRIPT: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+" };

/** Unicode look-alikes and superscripts turned into the plain forms the parsers read (`m²` → `m^{2}`). */
function normalizeSource(src: string): string {
	return src
		.replace(/\r\n?/g, "\n")
		.replace(/[−–—]/g, "-")
		.replace(/[μµ]/g, "µ")
		.replace(/Ω/g, "Ω")
		.replace(/Å/g, "Å")
		.replace(/\*\*/g, "^")
		.replace(/[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => `^{${[...m].map((c) => SUPERSCRIPT[c] ?? c).join("")}}`);
}

/** Unit text in LaTeX or plain form turned into the plain unit syntax (`\mathrm{kg\,m/s^2}` → `{kg m/s^2}`). */
function normalizeUnitText(raw: string): string {
	let s = normalizeSource(raw);
	for (let i = 0; i < 4; i++) {
		const next = s.replace(/\\(?:mathrm|textrm|text|mathsf|textsf|mathit|operatorname|unit|si)\s*\{([^{}]*)\}/g, "($1)");
		if (next === s) break;
		s = next;
	}
	s = s.replace(/\\(?:mathrm|textrm|text|mathsf|textsf|mathit|operatorname|rm|unit|si)\b/g, "");
	for (let i = 0; i < 6; i++) {
		const next = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
		if (next === s) break;
		s = next;
	}
	return s
		.replace(/\\(?:cdot|times|ast|bullet)\b/g, "·")
		.replace(/\\mu\b\s*/g, "µ")
		.replace(/\\Omega\b\s*/g, "Ω")
		.replace(/\^\s*\{?\s*\\circ\s*\}?/g, "°")
		.replace(/\\(?:circ|degree|textdegree)\b\s*/g, "°")
		.replace(/\\AA\b/g, "Å")
		.replace(/\\%/g, "%")
		.replace(/\\[,;:! ]|~|\\quad|\\qquad/g, " ")
		.replace(/×/g, "·")
		.replace(/⁄|÷/g, "/");
}

const WORD_CHAR = /[A-Za-zµΩ°%Å]/;

interface UnitRead {
	dim: Dim;
	end: number;
}

/** Reads a unit expression from `s` at `from`: factors, `^` powers, groups, products (space, `*`, `·`) and `/`. */
function readUnitExpr(s: string, from: number, depth = 0): UnitRead | null {
	if (depth > 12) return null;
	let pos = skipSpaces(s, from);
	const first = readUnitFactor(s, pos, depth);
	if (!first) return null;
	let acc = first.dim;
	pos = first.end;
	for (;;) {
		let p = skipSpaces(s, pos);
		let divide = false;
		const c = s[p];
		if (c === "/") {
			divide = true;
			p = skipSpaces(s, p + 1);
		} else if (c === "*" || c === "·") {
			p = skipSpaces(s, p + 1);
		} else if (!(c === "{" || c === "(" || (p > pos && c !== undefined && WORD_CHAR.test(c)))) {
			break;
		}
		const f = readUnitFactor(s, p, depth);
		if (!f) break;
		acc = divide ? dimDiv(acc, f.dim) : dimMul(acc, f.dim);
		pos = f.end;
	}
	return { dim: acc, end: pos };
}

function skipSpaces(s: string, i: number): number {
	let p = i;
	while (p < s.length && (s[p] === " " || s[p] === "\t")) p++;
	return p;
}

function readUnitFactor(s: string, pos: number, depth: number): UnitRead | null {
	let d: Dim;
	let p = pos;
	const c = s[p];
	if (c === "(" || c === "{") {
		const inner = readUnitExpr(s, p + 1, depth + 1);
		if (!inner) return null;
		const close = skipSpaces(s, inner.end);
		if (s[close] !== (c === "(" ? ")" : "}")) return null;
		d = inner.dim;
		p = close + 1;
	} else if (c === "1" && !/\d/.test(s[p + 1] ?? "")) {
		d = DIMENSIONLESS;
		p++;
	} else if (c !== undefined && WORD_CHAR.test(c)) {
		let q = p;
		while (q < s.length && WORD_CHAR.test(s[q]!)) q++;
		const u = lookupUnit(s.slice(p, q));
		if (!u) return null;
		d = u;
		p = q;
	} else {
		return null;
	}
	if (s[p] === "^") {
		const e = readUnitExponent(s, p + 1);
		if (!e) return null;
		d = dimPow(d, e.value);
		p = e.end;
	}
	return { dim: d, end: p };
}

function readUnitExponent(s: string, pos: number): { value: number; end: number } | null {
	const p = skipSpaces(s, pos);
	const open = s[p];
	if (open === "{" || open === "(") {
		const close = s.indexOf(open === "{" ? "}" : ")", p);
		if (close < 0) return null;
		const v = parseRational(s.slice(p + 1, close).replace(/\s+/g, ""));
		return v === null ? null : { value: v, end: close + 1 };
	}
	const m = /^[+-]?\d+(?:\.\d+)?/.exec(s.slice(p));
	if (!m) return null;
	return { value: Number(m[0]), end: p + m[0].length };
}

function parseRational(text: string): number | null {
	const m = /^([+-]?)(\d+(?:\.\d+)?)(?:\/(\d+))?$/.exec(text);
	if (!m) return null;
	const num = Number(m[2]);
	const den = m[3] === undefined ? 1 : Number(m[3]);
	if (den === 0) return null;
	return (m[1] === "-" ? -1 : 1) * (num / den);
}

/** The dimension of a whole unit expression (`m/s^2`, `\mathrm{kg\,m^2}`, `J/(kg K)`), or null when it is not one. */
export function parseUnit(text: string): Dim | null {
	const s = normalizeUnitText(text).trim();
	if (!s || s.length > 200) return null;
	const r = readUnitExpr(s, 0);
	if (!r || skipSpaces(s, r.end) !== s.length) return null;
	return r.dim;
}

// ------------------------------------------------------------------------------------------------ names and formatting

const QUANTITIES: ReadonlyArray<readonly [string, Dim]> = [
	["dimensionless", DIMENSIONLESS],
	["length", dim(1)],
	["mass", dim(0, 1)],
	["time", dim(0, 0, 1)],
	["current", dim(0, 0, 0, 1)],
	["temperature", dim(0, 0, 0, 0, 1)],
	["amount", dim(0, 0, 0, 0, 0, 1)],
	["luminousIntensity", dim(0, 0, 0, 0, 0, 0, 1)],
	["area", dim(2)],
	["volume", dim(3)],
	["wavenumber", dim(-1)],
	["velocity", dim(1, 0, -1)],
	["acceleration", dim(1, 0, -2)],
	["frequency", dim(0, 0, -1)],
	["force", dim(1, 1, -2)],
	["energy", dim(2, 1, -2)],
	["power", dim(2, 1, -3)],
	["pressure", dim(-1, 1, -2)],
	["momentum", dim(1, 1, -1)],
	["angularMomentum", dim(2, 1, -1)],
	["density", dim(-3, 1)],
	["charge", dim(0, 0, 1, 1)],
	["voltage", dim(2, 1, -3, -1)],
	["resistance", dim(2, 1, -3, -2)],
	["conductance", dim(-2, -1, 3, 2)],
	["capacitance", dim(-2, -1, 4, 2)],
	["inductance", dim(2, 1, -2, -2)],
	["magneticFlux", dim(2, 1, -2, -1)],
	["magneticField", dim(0, 1, -2, -1)],
	["electricField", dim(1, 1, -3, -1)],
	["currentDensity", dim(-2, 0, 0, 1)],
	["heatCapacity", dim(2, 1, -2, 0, -1)],
	["specificHeat", dim(2, 0, -2, 0, -1)],
	["viscosity", dim(-1, 1, -1)],
	["surfaceTension", dim(0, 1, -2)],
	["heatFlux", dim(0, 1, -3)],
	["concentration", dim(-3, 0, 0, 0, 0, 1)],
	["molarMass", dim(0, 1, 0, 0, 0, -1)],
];

/** The named physical quantity of a dimension (`length`, `force`, …), or null. */
export function quantityName(d: Dim): string | null {
	for (const [name, q] of QUANTITIES) if (dimEqual(q, d)) return name;
	return null;
}

const SUP_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

function fractionText(x: number): string {
	for (let den = 1; den <= 12; den++) {
		const n = x * den;
		if (Math.abs(n - Math.round(n)) < 1e-6) {
			const num = Math.round(n);
			return den === 1 ? String(num) : `${num}/${den}`;
		}
	}
	return String(Math.round(x * 1000) / 1000);
}

function powerText(x: number): string {
	if (Math.abs(x - 1) < EPS) return "";
	if (Number.isInteger(x) && x >= 0 && x <= 9) return SUP_DIGITS[x]!;
	if (Number.isInteger(x) && x < 0 && x >= -9) return `⁻${SUP_DIGITS[-x]!}`;
	return `^(${fractionText(x)})`;
}

const SI_ORDER: ReadonlyArray<readonly [number, string]> = [[1, "kg"], [0, "m"], [2, "s"], [3, "A"], [4, "K"], [5, "mol"], [6, "cd"]];

/** A dimension in SI base units, `kg·m/s²`; `1` for a dimensionless one. */
export function formatDimension(d: Dim): string {
	const top: string[] = [];
	const bottom: string[] = [];
	for (const [i, sym] of SI_ORDER) {
		const e = d[i] ?? 0;
		if (Math.abs(e) < EPS) continue;
		if (e > 0) top.push(sym + powerText(e));
		else bottom.push(sym + powerText(-e));
	}
	if (top.length === 0 && bottom.length === 0) return "1";
	const num = top.length ? top.join("·") : "1";
	if (bottom.length === 0) return num;
	return `${num}/${bottom.length > 1 ? `(${bottom.join("·")})` : bottom[0]}`;
}

/** The SI form of a dimension and the physical quantity it is, when it has a common name. */
export function describeDimension(d: Dim): { si: string; quantity: string | null } {
	return { si: formatDimension(d), quantity: quantityName(d) };
}

// ------------------------------------------------------------------------------------------------ result types

export type DimensionIssueKind = "sum" | "relation" | "unit-missing" | "exponent" | "function";

export interface DimensionIssue {
	kind: DimensionIssueKind;
	/**
	 * `+` or `-` (sum); `=`, `<`, `<=`, `>`, `>=`, `!=`, `~=` (relation); `^` (exponent); the function name (function).
	 */
	op: string;
	/** The reference operand as written (cleaned); for a function, its name. */
	left: string;
	/** The operand that does not agree (cleaned); for a function, its argument. */
	right: string;
	leftDim: Dim | null;
	rightDim: Dim | null;
	/** For `unit-missing`: which operand is the bare number (`left` or `right`). */
	bare?: "left" | "right";
	/** An English explanation. */
	message: string;
	/** The offending range of the (normalised) source. */
	at: [number, number];
}

export interface DimensionReport {
	issues: DimensionIssue[];
	/** Comparisons that involved a unit or a symbol of known dimension and agreed or not. */
	checked: number;
	/** The symbols with a known dimension at the end, as SI text. */
	symbols: Record<string, string>;
}

export interface DimensionOptions {
	/** Plain text: a unit may follow a number with only a space (`5 m + 3 s`). Default: LaTeX. */
	plain?: boolean;
	/** Dimensions of symbols known beforehand, as unit expressions (`{ v: "m/s" }`). */
	symbols?: Record<string, string>;
	/** Stop after this many issues. */
	maxIssues?: number;
}

/** Longest text analysed (the equation editor's limit). */
export const DIMENSIONS_TEXT_MAX = 4000;
const TOKEN_MAX = 3000;
const DEPTH_MAX = 120;

// ------------------------------------------------------------------------------------------------ display text

const GREEK: Record<string, string> = {
	alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ",
	lambda: "λ", mu: "µ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
	Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", hbar: "ħ", ell: "ℓ", partial: "∂", infty: "∞",
};

const GREEK_NAMES = new Set(Object.keys(GREEK).filter((k) => k !== "partial" && k !== "infty"));

/** A piece of the source as a reader would say it: no `\mathrm`, `\,` or braces around simple things. */
export function cleanFormulaText(s: string): string {
	let t = s;
	for (let i = 0; i < 6; i++) {
		const next = t
			.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
			.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");
		if (next === t) break;
		t = next;
	}
	t = t
		.replace(/\\(?:mathrm|textrm|text|mathsf|textsf|mathit|operatorname|left|right|big|Big|bigg|Bigg|displaystyle)\b/g, "")
		.replace(/\\[,;:! ]|~|\\quad|\\qquad/g, " ")
		.replace(/\\cdot\b/g, "·")
		.replace(/\\times\b/g, "×")
		.replace(/\\div\b/g, "÷")
		.replace(/\\pm\b/g, "±")
		.replace(/\\circ\b/g, "°")
		.replace(/\\([A-Za-z]+)/g, (m, name: string) => GREEK[name] ?? name)
		.replace(/\^\{([^{}]*)\}/g, (_m, x: string) => (/^[-+]?\w+$/.test(x) ? `^${x}` : `^(${x})`))
		.replace(/_\{([^{}]*)\}/g, (_m, x: string) => `_${x}`)
		.replace(/[{}$]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

// ------------------------------------------------------------------------------------------------ tokens

type TokType = "num" | "sym" | "word" | "cmd" | "op" | "rel" | "open" | "close" | "caret" | "under" | "sep" | "nl";

interface Tok {
	t: TokType;
	s: string;
	a: number;
	b: number;
}

const OPS: Record<string, string> = { cdot: "*", times: "*", ast: "*", star: "*", bullet: "*", div: "/", pm: "+", mp: "-" };
const RELS: Record<string, string> = {
	approx: "~=", simeq: "~=", cong: "~=", sim: "~=", equiv: "=", doteq: "=", ne: "!=", neq: "!=", le: "<=", leq: "<=", leqslant: "<=",
	ge: ">=", geq: ">=", geqslant: ">=", lt: "<", gt: ">", ll: "<", gg: ">", propto: "prop", coloneqq: "def", defeq: "def", triangleq: "def",
};
const SEPS = new Set([
	"quad", "qquad", "Rightarrow", "Longrightarrow", "implies", "impliedby", "iff", "Leftrightarrow", "Longleftrightarrow", "to", "rightarrow",
	"longrightarrow", "mapsto", "leftarrow", "Leftarrow", "in", "notin", "ni", "subset", "subseteq", "supset", "supseteq", "forall", "exists",
	"land", "lor", "wedge", "vee", "mid", "cup", "cap", "setminus",
]);
const DROP_WITH_GROUP = new Set(["hspace", "vspace", "phantom", "hphantom", "vphantom", "tag", "label", "mspace", "kern", "color", "textcolor", "colorbox"]);
const DROP = new Set([
	"nonumber", "notag", "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits", "mathstrut", "strut", "relax",
	"big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr", "hline", "centering", "thinspace", "enspace",
	"negthinspace", "medspace", "thickspace",
]);
const TRANSPARENT_ENVS = new Set(["aligned", "align", "alignat", "gather", "gathered", "split", "equation", "multline", "eqnarray", "array", "alignedat"]);
const VERT = new Set(["lvert", "rvert", "lVert", "rVert", "vert", "Vert"]);
const OPEN_CMD = new Set(["langle", "lbrace", "lceil", "lfloor"]);
const CLOSE_CMD = new Set(["rangle", "rbrace", "rceil", "rfloor"]);

function isLetter(c: string): boolean {
	return /\p{L}/u.test(c);
}

function skipBalanced(src: string, from: number): number {
	let i = from;
	while (i < src.length && /\s/.test(src[i]!)) i++;
	if (src[i] !== "{") return from;
	let depth = 0;
	for (; i < src.length; i++) {
		if (src[i] === "\\") i++;
		else if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return i + 1;
	}
	return src.length;
}

function tokenize(src: string, plain: boolean): Tok[] | null {
	const out: Tok[] = [];
	const n = src.length;
	let i = 0;
	const push = (t: TokType, s: string, a: number, b: number): void => {
		out.push({ t, s, a, b });
	};
	while (i < n) {
		if (out.length > TOKEN_MAX) return null;
		const c = src[i]!;
		if (c === "\n") {
			push("nl", c, i, i + 1);
			i++;
		} else if (/\s/.test(c) || c === "&" || c === "~" || c === "'" || c === "`") {
			i++;
		} else if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
			const sci = plain ? /^\d+(?:\.\d+)?[eE][+-]?\d+(?![A-Za-z])/.exec(src.slice(i)) : null;
			const m = sci ?? /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(src.slice(i))!;
			push("num", m[0], i, i + m[0].length);
			i += m[0].length;
		} else if (c === "\\") {
			i = tokenizeCommand(src, i, out, push);
			if (i < 0) return null;
		} else if (isLetter(c) || (plain && /[°%]/.test(c))) {
			if (plain) {
				let j = i;
				while (j < n && (isLetter(src[j]!) || src[j] === "°" || src[j] === "%")) j++;
				push("word", src.slice(i, j), i, j);
				i = j;
			} else {
				push("sym", c, i, i + 1);
				i++;
			}
		} else {
			i = tokenizePunct(src, i, push);
		}
	}
	return out;
}

function tokenizePunct(src: string, i: number, push: (t: TokType, s: string, a: number, b: number) => void): number {
	const c = src[i]!;
	switch (c) {
		case "+": push("op", "+", i, i + 1); return i + 1;
		case "-": push("op", "-", i, i + 1); return i + 1;
		case "*": case "·": case "×": push("op", "*", i, i + 1); return i + 1;
		case "/": case "÷": push("op", "/", i, i + 1); return i + 1;
		case "±": push("op", "+", i, i + 1); return i + 1;
		case "∓": push("op", "-", i, i + 1); return i + 1;
		case "!": push("op", "!", i, i + 1); return i + 1;
		case "|": push("op", "|", i, i + 1); return i + 1;
		case "=": push("rel", "=", i, i + 1); return i + 1;
		case "<": if (src[i + 1] === "=") { push("rel", "<=", i, i + 2); return i + 2; } push("rel", "<", i, i + 1); return i + 1;
		case ">": if (src[i + 1] === "=") { push("rel", ">=", i, i + 2); return i + 2; } push("rel", ">", i, i + 1); return i + 1;
		case "≤": push("rel", "<=", i, i + 1); return i + 1;
		case "≥": push("rel", ">=", i, i + 1); return i + 1;
		case "≠": push("rel", "!=", i, i + 1); return i + 1;
		case "≈": case "≃": case "∼": push("rel", "~=", i, i + 1); return i + 1;
		case "≡": push("rel", "=", i, i + 1); return i + 1;
		case "∝": push("rel", "prop", i, i + 1); return i + 1;
		case ":": if (src[i + 1] === "=") { push("rel", "def", i, i + 2); return i + 2; } push("sep", ":", i, i + 1); return i + 1;
		case ",": case ";": push("sep", c, i, i + 1); return i + 1;
		case "→": case "⇒": case "⟹": case "⇔": case "∈": push("sep", c, i, i + 1); return i + 1;
		case "(": case "[": case "{": push("open", c, i, i + 1); return i + 1;
		case ")": case "]": case "}": push("close", c, i, i + 1); return i + 1;
		case "^": push("caret", c, i, i + 1); return i + 1;
		case "_": push("under", c, i, i + 1); return i + 1;
		case "°": push("cmd", "degree", i, i + 1); return i + 1;
		case "%": push("cmd", "%", i, i + 1); return i + 1;
		default: return i + 1;
	}
}

/** Reads the command at `i` (a backslash); returns the index after it, or -1 when the text is too long. */
function tokenizeCommand(src: string, i: number, out: Tok[], push: (t: TokType, s: string, a: number, b: number) => void): number {
	const next = src[i + 1] ?? "";
	if (!/[A-Za-z]/.test(next)) {
		switch (next) {
			case "\\": push("sep", "\\\\", i, i + 2); return i + 2;
			case "{": push("open", "(", i, i + 2); return i + 2;
			case "}": push("close", ")", i, i + 2); return i + 2;
			case "%": push("cmd", "%", i, i + 2); return i + 2;
			case "|": return i + 2;
			default: return i + 2;
		}
	}
	let j = i + 1;
	while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
	const name = src.slice(i + 1, j);
	if (name === "left" || name === "right") {
		const open = name === "left";
		let k = j;
		while (k < src.length && src[k] === " ") k++;
		const d = src[k] ?? "";
		if (d === "(" || d === "[" || d === ")" || d === "]") { push(open ? "open" : "close", d, i, k + 1); return k + 1; }
		if (d === "|") { push("op", "|", i, k + 1); return k + 1; }
		if (d === "\\") {
			let e = k + 1;
			while (e < src.length && /[A-Za-z]/.test(src[e]!)) e++;
			const dn = e > k + 1 ? src.slice(k + 1, e) : src.slice(k + 1, k + 2);
			if (e === k + 1) e = k + 2;
			if (VERT.has(dn) || dn === "|") push("op", "|", i, e);
			else if (dn === "{" || dn === "}" || OPEN_CMD.has(dn) || CLOSE_CMD.has(dn)) push(open ? "open" : "close", "(", i, e);
			return e;
		}
		return d === "." ? k + 1 : k;
	}
	if (name === "begin" || name === "end") {
		const g = /^\s*\{([^{}]*)\}/.exec(src.slice(j));
		if (!g) return j;
		const env = g[1]!.replace(/\*$/, "");
		let end = j + g[0].length;
		if (TRANSPARENT_ENVS.has(env)) {
			if (name === "begin" && (env === "array" || env === "alignat" || env === "alignedat")) end = skipBalanced(src, end);
			return end;
		}
		push("cmd", name, i, end);
		out[out.length - 1]!.s = `${name}:${env}`;
		return end;
	}
	if (DROP_WITH_GROUP.has(name)) return skipBalanced(src, j);
	if (DROP.has(name)) return j;
	if (VERT.has(name)) { push("op", "|", i, j); return j; }
	if (OPEN_CMD.has(name)) { push("open", "(", i, j); return j; }
	if (CLOSE_CMD.has(name)) { push("close", ")", i, j); return j; }
	if (OPS[name] !== undefined) { push("op", OPS[name], i, j); return j; }
	if (RELS[name] !== undefined) { push("rel", RELS[name], i, j); return j; }
	if (SEPS.has(name)) { push("sep", name, i, j); return j; }
	push("cmd", name, i, j);
	return j;
}

// ------------------------------------------------------------------------------------------------ parser

class Fail extends Error {}

/** A value in a formula: its dimension (null: unknown), its numeric value when it is a plain number, and its span. */
interface Q {
	dim: Dim | null;
	num?: number;
	/** Only numbers and constants (no unit, no symbol). */
	pure: boolean;
	/** The symbol this is, when it is exactly one. */
	sym?: string;
	a: number;
	b: number;
}

interface Sink {
	issues: DimensionIssue[];
	checked: number;
}

interface Ctx {
	src: string;
	plain: boolean;
	env: ReadonlyMap<string, Dim>;
	sink: Sink;
}

const FUNCS_DIMENSIONLESS = new Set([
	"sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "arccot", "sinh", "cosh", "tanh", "coth", "arsinh", "arcosh", "artanh",
	"asin", "acos", "atan", "exp", "ln", "log", "lg", "lb",
]);
const FUNCS_OTHER = new Set(["max", "min", "gcd", "lcm", "det", "dim", "deg", "arg", "Pr", "hom", "ker", "mod", "bmod", "sgn", "Re", "Im", "sup", "inf", "limsup", "liminf", "atan2"]);
const ACCENTS_KEEP = new Set(["vec", "hat", "bar", "tilde", "overline", "underline", "widehat", "widetilde", "overrightarrow", "mathbf", "boldsymbol", "bm", "mathbb", "mathit", "check", "acute", "grave", "breve", "mathbfit", "pmb", "underbar"]);
const ACCENTS_OWN_NAME = new Set(["mathcal", "mathscr", "mathfrak", "mathbb"]);
const WRAP_TEXT = new Set(["mathrm", "text", "textrm", "mathsf", "textsf", "operatorname", "rm", "textnormal", "mathtt"]);

const isZeroLit = (q: Q): boolean => q.pure && q.num === 0;

function span(x: Q, y: Q): { a: number; b: number } {
	return { a: Math.min(x.a, y.a), b: Math.max(x.b, y.b) };
}

class Parser {
	pos = 0;
	private depth = 0;
	constructor(private readonly toks: Tok[], private readonly ctx: Ctx) {}

	get done(): boolean {
		return this.pos >= this.toks.length;
	}

	private peek(o = 0): Tok | undefined {
		return this.toks[this.pos + o];
	}

	private take(): Tok {
		const t = this.toks[this.pos];
		if (!t) throw new Fail();
		this.pos++;
		return t;
	}

	private enter(): void {
		if (++this.depth > DEPTH_MAX) throw new Fail();
	}

	private leave(): void {
		this.depth--;
	}

	private text(a: number, b: number): string {
		return cleanFormulaText(this.ctx.src.slice(a, b));
	}

	private issue(kind: DimensionIssueKind, op: string, x: Q, y: Q, extra: { bare?: "left" | "right"; fn?: string } = {}): void {
		const left = extra.fn ?? this.text(x.a, x.b);
		const right = this.text(y.a, y.b);
		const at: [number, number] = [Math.min(x.a, y.a), Math.max(x.b, y.b)];
		const issue: DimensionIssue = { kind, op, left, right, leftDim: x.dim, rightDim: y.dim, message: "", at };
		if (extra.bare) issue.bare = extra.bare;
		issue.message = explainIssue(issue);
		this.ctx.sink.issues.push(issue);
	}

	// ---- statements

	/** `expr (rel expr)*`, all of it. `carry`: the last value of the previous line, for a line that starts with `=`. */
	parseChain(carry: Q | null): { items: Q[]; rels: string[] } {
		const items: Q[] = [];
		const rels: string[] = [];
		if (this.peek()?.t === "rel" && carry) items.push(carry);
		else items.push(this.parseSum());
		while (this.peek()?.t === "rel") {
			rels.push(this.take().s);
			items.push(this.parseSum());
		}
		if (!this.done) throw new Fail();
		return { items, rels };
	}

	/** The whole slice as one sum. */
	parseAll(): Q {
		const q = this.parseSum();
		if (!this.done) throw new Fail();
		return q;
	}

	// ---- sums and products

	parseSum(): Q {
		this.enter();
		let x = this.parseTerm();
		for (;;) {
			const t = this.peek();
			if (t?.t !== "op" || (t.s !== "+" && t.s !== "-")) break;
			this.pos++;
			const y = this.parseTerm();
			x = this.add(x, y, t.s);
		}
		this.leave();
		return x;
	}

	private add(x: Q, y: Q, op: "+" | "-"): Q {
		const { a, b } = span(x, y);
		const num = x.num !== undefined && y.num !== undefined ? (op === "+" ? x.num + y.num : x.num - y.num) : undefined;
		const pure = x.pure && y.pure;
		const out = (d: Dim | null): Q => ({ dim: d, num, pure, a, b });
		if (x.dim && y.dim) {
			if (isZeroLit(x)) return out(y.dim);
			if (isZeroLit(y)) return out(x.dim);
			if (!x.pure || !y.pure) this.ctx.sink.checked++;
			if (dimEqual(x.dim, y.dim)) return out(x.dim);
			const bare = x.pure ? "left" : y.pure ? "right" : undefined;
			this.issue(bare ? "unit-missing" : "sum", op, x, y, bare ? { bare } : {});
			return { dim: null, pure: false, a, b };
		}
		if (x.dim || y.dim) {
			const known = (x.dim ? x : y);
			if (isZeroLit(known)) return { dim: null, pure: false, a, b };
			return out(known.dim);
		}
		return { dim: null, pure: false, a, b };
	}

	private parseTerm(): Q {
		this.enter();
		let x = this.parseUnary();
		for (;;) {
			const t = this.peek();
			if (!t) break;
			if (t.t === "op" && (t.s === "*" || t.s === "/")) {
				this.pos++;
				x = this.mul(x, this.parseUnary(), t.s);
			} else if (this.startsFactor(t)) {
				x = this.mul(x, this.parseUnary(), "*");
			} else {
				break;
			}
		}
		this.leave();
		return x;
	}

	private startsFactor(t: Tok): boolean {
		switch (t.t) {
			case "num": case "sym": case "word": case "open": return true;
			case "cmd": return !t.s.startsWith("end:");
			default: return false;
		}
	}

	private mul(x: Q, y: Q, op: "*" | "/"): Q {
		const { a, b } = span(x, y);
		let num: number | undefined;
		if (x.num !== undefined && y.num !== undefined) {
			const v = op === "*" ? x.num * y.num : x.num / y.num;
			if (Number.isFinite(v)) num = v;
		}
		const pure = x.pure && y.pure;
		if (!x.dim || !y.dim) return { dim: null, num, pure: false, a, b };
		return { dim: op === "*" ? dimMul(x.dim, y.dim) : dimDiv(x.dim, y.dim), num, pure, a, b };
	}

	private parseUnary(): Q {
		const t = this.peek();
		if (t?.t === "op" && (t.s === "-" || t.s === "+")) {
			this.pos++;
			this.enter();
			const q = this.parseUnary();
			this.leave();
			return { ...q, num: q.num !== undefined && t.s === "-" ? -q.num : q.num, sym: undefined, a: t.a };
		}
		return this.parsePower();
	}

	// ---- powers and postfix

	private parsePower(): Q {
		let base = this.parseAtom();
		for (;;) {
			const t = this.peek();
			if (t?.t === "caret") {
				this.pos++;
				if (this.eatDegreeMark()) {
					const celsius = this.eatTemperatureLetter();
					base = {
						dim: celsius ? dim(0, 0, 0, 0, 1) : base.dim,
						num: base.num !== undefined && !celsius ? base.num * (Math.PI / 180) : undefined,
						pure: base.pure && !celsius,
						a: base.a,
						b: this.toks[this.pos - 1]!.b,
					};
					continue;
				}
				const e = this.parseExponent();
				base = this.pow(base, e);
			} else if (t?.t === "under") {
				this.pos++;
				this.skipArgument();
			} else if (t?.t === "op" && t.s === "!") {
				this.pos++;
				base = { dim: base.dim && !isDimensionless(base.dim) ? null : DIMENSIONLESS, pure: base.pure, a: base.a, b: t.b };
			} else {
				break;
			}
		}
		return base;
	}

	private eatDegreeMark(): boolean {
		const t = this.peek();
		if (t?.t === "cmd" && (t.s === "circ" || t.s === "degree")) {
			this.pos++;
			return true;
		}
		if (t?.t === "open" && t.s === "{") {
			const c = this.peek(1);
			const e = this.peek(2);
			if (c?.t === "cmd" && c.s === "circ" && e?.t === "close") {
				this.pos += 3;
				return true;
			}
		}
		return false;
	}

	/** `^\circ\mathrm{C}` is a temperature, not degrees times coulombs. */
	private eatTemperatureLetter(): boolean {
		const w = this.peek();
		const o = this.peek(1);
		const l = this.peek(2);
		const c = this.peek(3);
		if (w?.t !== "cmd" || !WRAP_TEXT.has(w.s) || o?.t !== "open" || o.s !== "{" || c?.t !== "close") return false;
		if (l?.t !== "sym" || (l.s !== "C" && l.s !== "F")) return false;
		this.pos += 4;
		return true;
	}

	private parseExponent(): Q {
		const t = this.peek();
		if (!t) throw new Fail();
		if (t.t === "open" && t.s === "{") {
			this.pos++;
			const q = this.parseSum();
			this.expectClose();
			return q;
		}
		if (t.t === "op" && (t.s === "-" || t.s === "+")) {
			this.pos++;
			const q = this.parseExponent();
			return { ...q, num: q.num !== undefined && t.s === "-" ? -q.num : q.num, sym: undefined, a: t.a };
		}
		if (t.t === "num") {
			const first = t.s[0] === "." ? t.s : t.s.length > 1 && !t.s.includes(".") ? t.s.slice(0, 1) : t.s;
			if (first.length < t.s.length) this.toks[this.pos] = { ...t, s: t.s.slice(first.length), a: t.a + first.length };
			else this.pos++;
			return { dim: DIMENSIONLESS, num: Number(first), pure: true, a: t.a, b: t.a + first.length };
		}
		return this.parseAtom();
	}

	private pow(base: Q, e: Q): Q {
		const { a, b } = span(base, e);
		if (e.dim && !isDimensionless(e.dim) && !isZeroLit(e)) {
			this.issue("exponent", "^", base, e);
			return { dim: null, pure: false, a, b };
		}
		const pure = base.pure && e.pure;
		if (e.num !== undefined && Number.isFinite(e.num)) {
			let num: number | undefined;
			if (base.num !== undefined) {
				const v = Math.pow(base.num, e.num);
				if (Number.isFinite(v)) num = v;
			}
			if (base.dim) return { dim: dimPow(base.dim, e.num), num, pure, a, b };
			return { dim: e.num === 0 ? DIMENSIONLESS : null, num, pure: false, a, b };
		}
		if (base.dim && isDimensionless(base.dim)) return { dim: DIMENSIONLESS, pure, a, b };
		return { dim: null, pure: false, a, b };
	}

	// ---- groups

	private expectClose(): void {
		if (this.peek()?.t !== "close") throw new Fail();
		this.pos++;
	}

	/** The tokens of a balanced group (the opener at the cursor) without its delimiters. */
	private groupSlice(): Tok[] {
		const o = this.peek();
		if (o?.t !== "open") throw new Fail();
		let depth = 0;
		for (let i = this.pos; i < this.toks.length; i++) {
			const t = this.toks[i]!;
			if (t.t === "open" || (t.t === "cmd" && t.s.startsWith("begin:"))) depth++;
			else if (t.t === "close" || (t.t === "cmd" && t.s.startsWith("end:"))) {
				if (--depth === 0) {
					const inner = this.toks.slice(this.pos + 1, i);
					this.pos = i + 1;
					return inner;
				}
			}
		}
		throw new Fail();
	}

	/** One argument of a command: a group, or a single token (a number gives its first digit, as TeX does). */
	private argument(): Tok[] {
		const t = this.peek();
		if (!t) throw new Fail();
		if (t.t === "open" && (t.s === "{" || this.ctx.plain)) return this.groupSlice();
		if (t.t === "num" && t.s.length > 1 && !t.s.includes(".")) {
			const one: Tok = { ...t, s: t.s[0]!, b: t.a + 1 };
			this.toks[this.pos] = { ...t, s: t.s.slice(1), a: t.a + 1 };
			return [one];
		}
		this.pos++;
		return [t];
	}

	private skipArgument(): void {
		this.argument();
	}

	private sub(toks: Tok[]): Q {
		if (toks.length === 0) throw new Fail();
		this.enter();
		const p = new Parser(toks, this.ctx);
		p.depth = this.depth;
		const q = p.parseAll();
		this.leave();
		return q;
	}

	/** End of the last token read (the closing delimiter of an argument just taken). */
	private lastEnd(fallback: number): number {
		return this.toks[this.pos - 1]?.b ?? fallback;
	}

	private rawBetween(toks: Tok[]): string {
		if (toks.length === 0) return "";
		return this.ctx.src.slice(toks[0]!.a, toks[toks.length - 1]!.b);
	}

	// ---- atoms

	private parseAtom(): Q {
		this.enter();
		try {
			return this.parseAtomInner();
		} finally {
			this.leave();
		}
	}

	private parseAtomInner(): Q {
		const t = this.take();
		switch (t.t) {
			case "num": return this.number(t);
			case "sym": return this.symbol(t.s, t.a, t.b);
			case "word": return this.wordAtom(t);
			case "open": return this.groupAtom(t);
			case "op":
				if (t.s === "|") return this.absAtom(t);
				throw new Fail();
			case "cmd": return this.command(t);
			default: throw new Fail();
		}
	}

	private number(t: Tok): Q {
		const q: Q = { dim: DIMENSIONLESS, num: Number(t.s), pure: true, a: t.a, b: t.b };
		if (!this.ctx.plain) return q;
		// "5 m/s": a unit written after the number with nothing but spaces.
		const rest = this.ctx.src.slice(t.b);
		const w = /^[ \t]*([A-Za-zµΩ°%Å]+)/.exec(rest);
		if (!w) return q;
		const word = w[1]!;
		if (this.ctx.env.has(word) || FUNCS_DIMENSIONLESS.has(word) || FUNCS_OTHER.has(word) || word === "pi") return q;
		const r = readUnitExpr(this.ctx.src, t.b);
		if (!r) return q;
		while (this.pos < this.toks.length && this.toks[this.pos]!.a < r.end) this.pos++;
		return { dim: r.dim, num: q.num, pure: false, a: t.a, b: r.end };
	}

	private symbol(base: string, a: number, b: number): Q {
		let name = base;
		let end = b;
		if (this.peek()?.t === "under") {
			const u = this.peek()!;
			this.pos++;
			const arg = this.argument();
			name += `_${canonName(this.rawBetween(arg))}`;
			end = this.lastEnd(u.b);
		}
		return { dim: this.ctx.env.get(name) ?? null, pure: false, sym: name, a, b: end };
	}

	private wordAtom(t: Tok): Q {
		const w = t.s;
		if (FUNCS_DIMENSIONLESS.has(w) || w === "sqrt") return this.functionCall(w, t);
		if (w === "pi") return { dim: DIMENSIONLESS, num: Math.PI, pure: true, a: t.a, b: t.b };
		if (w === "abs") return this.functionCall("abs", t);
		return this.symbol(w, t.a, t.b);
	}

	private groupAtom(open: Tok): Q {
		this.pos--;
		const inner = this.groupSlice();
		const end = this.toks[this.pos - 1]!.b;
		if (inner.length === 0) throw new Fail();
		const p = new Parser(inner, this.ctx);
		p.depth = this.depth;
		const items: Q[] = [p.parseSum()];
		while (p.peek()?.t === "sep" && p.peek()!.s === ",") {
			p.pos++;
			items.push(p.parseSum());
		}
		if (!p.done) throw new Fail();
		if (items.length > 1) return { dim: null, pure: false, a: open.a, b: end };
		const q = items[0]!;
		return { ...q, a: open.a, b: end };
	}

	private absAtom(open: Tok): Q {
		const q = this.parseSum();
		const close = this.peek();
		if (close?.t !== "op" || close.s !== "|") throw new Fail();
		this.pos++;
		return { dim: q.dim, num: q.num !== undefined ? Math.abs(q.num) : undefined, pure: q.pure, a: open.a, b: close.b };
	}

	/** `\mathrm{…}` and `\text{…}`: a unit when the text is one, a (roman) symbol otherwise. */
	private textAtom(cmd: Tok): Q {
		const arg = this.argument();
		const raw = this.rawBetween(arg);
		const end = this.lastEnd(cmd.b);
		const trimmed = raw.trim();
		if (trimmed === "e") return { dim: DIMENSIONLESS, num: Math.E, pure: true, a: cmd.a, b: end };
		if (trimmed !== "" && trimmed !== "d" && trimmed !== "i") {
			const u = parseUnit(raw);
			if (u) return { dim: u, pure: false, a: cmd.a, b: end };
		}
		return this.symbol(canonName(raw) || "?", cmd.a, end);
	}

	private functionCall(name: string, t: Tok): Q {
		if (this.peek()?.t === "caret") {
			this.pos++;
			this.parseExponent();
		}
		if (this.peek()?.t === "under") {
			this.pos++;
			this.skipArgument();
		}
		if (name === "sqrt") return this.root(t);
		const arg = this.functionArgument();
		const a = t.a;
		const b = arg.b;
		if (name === "abs") return { dim: arg.dim, pure: arg.pure, a, b };
		if (FUNCS_DIMENSIONLESS.has(name)) {
			if (arg.dim && !isDimensionless(arg.dim) && !isZeroLit(arg)) {
				this.issue("function", name, arg, arg, { fn: name });
				return { dim: DIMENSIONLESS, pure: false, a, b };
			}
			if (arg.dim && !arg.pure) this.ctx.sink.checked++;
			return { dim: DIMENSIONLESS, pure: arg.pure, a, b };
		}
		return { dim: null, pure: false, a, b };
	}

	private functionArgument(): Q {
		const t = this.peek();
		if (!t) throw new Fail();
		if (t.t === "open") {
			this.pos++;
			return this.groupAtom(t);
		}
		// "sin 2x": the factors written next to each other, up to the first operator.
		let x = this.parsePower();
		while (this.peek() && this.startsFactor(this.peek()!)) x = this.mul(x, this.parsePower(), "*");
		return x;
	}

	private root(t: Tok): Q {
		let n = 2;
		const o = this.peek();
		if (o?.t === "open" && o.s === "[") {
			const idx = this.groupSlice();
			const q = this.sub(idx);
			if (q.num === undefined || q.num === 0) n = NaN;
			else n = q.num;
		}
		const arg = this.argument();
		const q = this.sub(arg);
		const end = this.lastEnd(t.b);
		const num = q.num !== undefined && Number.isFinite(n) ? Math.pow(q.num, 1 / n) : undefined;
		const d = q.dim && Number.isFinite(n) ? dimPow(q.dim, 1 / n) : null;
		return { dim: d, num: num !== undefined && Number.isFinite(num) ? num : undefined, pure: q.pure, a: t.a, b: end };
	}

	// ---- commands

	private command(t: Tok): Q {
		const name = t.s;
		if (name.startsWith("begin:")) return this.skipEnvironment(t);
		if (name.startsWith("end:")) throw new Fail();
		if (name === "pi") return { dim: DIMENSIONLESS, num: Math.PI, pure: true, a: t.a, b: t.b };
		if (GREEK_NAMES.has(name)) {
			if (name === "Delta") return this.deltaAtom(t);
			return this.symbol(`\\${name}`, t.a, t.b);
		}
		if (name === "infty") return { dim: null, pure: false, a: t.a, b: t.b };
		if (name === "partial" || name === "nabla") return this.symbol(`\\${name}`, t.a, t.b);
		if (name === "degree") return { dim: DIMENSIONLESS, num: Math.PI / 180, pure: true, a: t.a, b: t.b };
		if (name === "%") return { dim: DIMENSIONLESS, num: 0.01, pure: true, a: t.a, b: t.b };
		if (name === "frac" || name === "dfrac" || name === "tfrac") return this.fraction(t);
		if (name === "sqrt") return this.root(t);
		if (FUNCS_DIMENSIONLESS.has(name)) return this.functionCall(name, t);
		if (FUNCS_OTHER.has(name)) return this.otherFunction(t);
		if (WRAP_TEXT.has(name)) return this.textAtom(t);
		if (ACCENTS_OWN_NAME.has(name)) {
			const arg = this.argument();
			return this.symbol(`\\${name}{${canonName(this.rawBetween(arg))}}`, t.a, this.lastEnd(t.b));
		}
		if (ACCENTS_KEEP.has(name)) return this.accent(t);
		if (name === "dot" || name === "ddot") {
			const arg = this.argument();
			const q = this.sub(arg);
			const d = q.dim ? dimDiv(q.dim, name === "dot" ? TIME : dimMul(TIME, TIME)) : null;
			return { dim: d, pure: false, a: t.a, b: this.lastEnd(t.b) };
		}
		if (name === "int" || name === "oint" || name === "iint" || name === "iiint") return this.integral(t);
		if (name === "sum" || name === "prod" || name === "lim") return this.bigOperator(t);
		if (name === "SI" || name === "qty") return this.siQuantity(t);
		if (name === "si" || name === "unit") {
			const arg = this.argument();
			const u = parseUnit(this.rawBetween(arg));
			return { dim: u, pure: false, a: t.a, b: this.lastEnd(t.b) };
		}
		if (name === "circ") return { dim: null, pure: false, a: t.a, b: t.b };
		// \dots, \cdots, \hbar-like names, anything else: a value of unknown dimension.
		return { dim: null, pure: false, a: t.a, b: t.b };
	}

	private deltaAtom(t: Tok): Q {
		const n = this.peek();
		if (n && (n.t === "sym" || n.t === "word" || n.t === "cmd" || (n.t === "open" && n.s === "{"))) {
			const inner = this.parseAtom();
			return { dim: inner.dim, pure: false, a: t.a, b: inner.b };
		}
		return this.symbol("\\Delta", t.a, t.b);
	}

	private accent(t: Tok): Q {
		const arg = this.argument();
		const end = this.lastEnd(t.b);
		const q = this.sub(arg);
		return { ...q, a: t.a, b: end };
	}

	private otherFunction(t: Tok): Q {
		let end = t.b;
		if (this.peek()?.t === "under") {
			this.pos++;
			this.skipArgument();
		}
		const n = this.peek();
		if (n?.t === "open") {
			this.pos++;
			end = this.groupAtom(n).b;
		}
		return { dim: null, pure: false, a: t.a, b: end };
	}

	private skipEnvironment(t: Tok): Q {
		let depth = 1;
		while (this.pos < this.toks.length) {
			const x = this.toks[this.pos++]!;
			if (x.t === "cmd" && x.s.startsWith("begin:")) depth++;
			else if (x.t === "cmd" && x.s.startsWith("end:") && --depth === 0) return { dim: null, pure: false, a: t.a, b: x.b };
		}
		throw new Fail();
	}

	private siQuantity(t: Tok): Q {
		const num = this.argument();
		const unit = this.argument();
		const n = this.sub(num);
		const u = parseUnit(this.rawBetween(unit));
		const end = this.lastEnd(t.b);
		const ok = u !== null && n.dim !== null && isDimensionless(n.dim);
		return { dim: ok ? u : null, num: n.num, pure: false, a: t.a, b: end };
	}

	// ---- fractions, derivatives

	private fraction(t: Tok): Q {
		const top = this.argument();
		const bottom = this.argument();
		const end = this.lastEnd(t.b);
		const dn = differential(top);
		const dd = differential(bottom);
		const at = { a: t.a, b: end };
		if (dd && dd.rest.length > 0 && dn && dn.rest.length === 0) {
			// d/dx: an operator; whatever follows it is the thing differentiated.
			const q = this.sub(dd.rest);
			return { dim: q.dim ? dimDiv(DIMENSIONLESS, q.dim) : null, pure: false, ...at };
		}
		if (dd && dd.rest.length > 0 && dn && dn.rest.length > 0) {
			const n = this.sub(dn.rest);
			const d = this.sub(dd.rest);
			return { dim: n.dim && d.dim ? dimDiv(n.dim, d.dim) : null, pure: false, ...at };
		}
		const n = this.sub(top);
		const d = this.sub(bottom);
		const q = this.mul(n, d, "/");
		return { ...q, ...at };
	}

	// ---- integrals, sums, limits

	private skipLimits(): void {
		for (;;) {
			const t = this.peek();
			if (t?.t !== "under" && t?.t !== "caret") return;
			this.pos++;
			this.skipArgument();
		}
	}

	private integral(t: Tok): Q {
		this.skipLimits();
		// the differential: the first `d x` at the top level of the rest of the statement
		let depth = 0;
		let at = -1;
		let len = 0;
		for (let i = this.pos; i < this.toks.length; i++) {
			const x = this.toks[i]!;
			if (x.t === "open" || (x.t === "cmd" && x.s.startsWith("begin:"))) depth++;
			else if (x.t === "close" || (x.t === "cmd" && x.s.startsWith("end:"))) depth--;
			if (depth < 0 || (depth === 0 && (x.t === "rel" || x.t === "sep"))) break;
			if (depth === 0) {
				const l = diffMarkerLength(this.toks, i);
				const follow = this.toks[i + l];
				if (l > 0 && follow && (follow.t === "sym" || follow.t === "word" || follow.t === "cmd")) {
					at = i;
					len = l;
					break;
				}
			}
		}
		if (at < 0) {
			const q = this.parseTerm();
			return { dim: null, pure: false, a: t.a, b: q.b };
		}
		const body = this.toks.slice(this.pos, at);
		const integrand = body.length ? this.sub(body) : { dim: DIMENSIONLESS, pure: true, a: t.a, b: t.b } as Q;
		this.pos = at + len;
		const v = this.parseAtom();
		return { dim: integrand.dim && v.dim ? dimMul(integrand.dim, v.dim) : null, pure: false, a: t.a, b: v.b };
	}

	private bigOperator(t: Tok): Q {
		this.skipLimits();
		const body = this.parseTerm();
		const keeps = t.s !== "prod";
		return { dim: keeps ? body.dim : body.dim && isDimensionless(body.dim) ? DIMENSIONLESS : null, pure: false, a: t.a, b: body.b };
	}
}

// ------------------------------------------------------------------------------------------------ helpers of the parser

/** A symbol name written the same whatever the markup: `m_{1}`, `m_1`, `F_\mathrm{net}` → `m_1`, `F_net`. */
function canonName(raw: string): string {
	return raw.replace(/\\(?:mathrm|text|textrm|mathit|mathsf|operatorname|rm)\b/g, "").replace(/[{}\s]/g, "");
}

/** Length in tokens of a differential marker (`d`, `\mathrm{d}`, `\partial`) at `i`, or 0. */
function diffMarkerLength(toks: readonly Tok[], i: number): number {
	const t = toks[i];
	if (!t) return 0;
	if ((t.t === "sym" || t.t === "word") && t.s === "d") return 1;
	if (t.t === "cmd" && t.s === "partial") return 1;
	if (t.t === "cmd" && WRAP_TEXT.has(t.s)) {
		const o = toks[i + 1];
		const d = toks[i + 2];
		const c = toks[i + 3];
		if (o?.t === "open" && o.s === "{" && (d?.t === "sym" || d?.t === "word") && d.s === "d" && c?.t === "close") return 4;
	}
	return 0;
}

/** `dx`, `d^2x`, `\partial f`, `\mathrm{d}t`: what follows the marker, or null when the slice does not start with one. */
function differential(toks: readonly Tok[]): { rest: Tok[] } | null {
	const l = diffMarkerLength(toks, 0);
	if (l === 0 || toks[l]?.t === "under") return null;
	let i = l;
	if (toks[i]?.t === "caret") {
		const g = toks[i + 1];
		if (g?.t === "open" && g.s === "{") {
			let j = i + 2;
			while (j < toks.length && toks[j]!.t !== "close") j++;
			i = j + 1;
		} else {
			i += 2;
		}
	}
	return { rest: toks.slice(i) };
}

// ------------------------------------------------------------------------------------------------ explanations

function describeText(d: Dim | null): string {
	if (!d) return "?";
	const { si, quantity } = describeDimension(d);
	return quantity ? (quantity === "dimensionless" ? "dimensionless" : `${quantityLabel(quantity)}, ${si}`) : si === "1" ? "dimensionless" : si;
}

const QUANTITY_LABEL: Record<string, string> = {
	luminousIntensity: "luminous intensity", angularMomentum: "angular momentum", magneticFlux: "magnetic flux", magneticField: "magnetic field",
	electricField: "electric field", currentDensity: "current density", heatCapacity: "heat capacity", specificHeat: "specific heat",
	surfaceTension: "surface tension", heatFlux: "heat flux", molarMass: "molar mass",
};

function quantityLabel(key: string): string {
	return QUANTITY_LABEL[key] ?? key;
}

/** The English explanation of an issue. */
export function explainIssue(i: DimensionIssue): string {
	const l = `${i.left} (${describeText(i.leftDim)})`;
	const r = `${i.right} (${describeText(i.rightDim)})`;
	switch (i.kind) {
		case "sum":
			return `Cannot ${i.op === "-" ? "subtract" : "add"} ${l} and ${r}: the terms of a sum must have the same dimension.`;
		case "relation":
			return i.op === "=" || i.op === "~=" || i.op === "def" || i.op === "!="
				? `The two sides differ: ${l} and ${r}. An equation needs the same dimension on both sides.`
				: `Cannot compare ${l} with ${r}: they have different dimensions.`;
		case "unit-missing": {
			const bare = i.bare === "left" ? i.left : i.right;
			const other = i.bare === "left" ? `${i.right} (${describeText(i.rightDim)})` : `${i.left} (${describeText(i.leftDim)})`;
			return `${bare} is a plain number but it is used with ${other}: a unit is missing.`;
		}
		case "exponent":
			return `The exponent ${r} must be dimensionless.`;
		case "function":
			return `The argument of ${i.left} must be dimensionless, but ${i.right} is ${describeText(i.rightDim)}.`;
	}
}

// ------------------------------------------------------------------------------------------------ analysis

/** Splits the tokens into statements at the top level: `\\`, `;`, `,`, arrows, `\quad`, and line breaks between whole formulas. */
function splitStatements(toks: Tok[]): Tok[][] {
	// A line break is a separator only between two complete pieces.
	const marked: Tok[] = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!;
		if (t.t === "nl") {
			const prev = marked[marked.length - 1];
			let k = i + 1;
			while (toks[k]?.t === "nl") k++;
			const next = toks[k];
			const ends = prev && (prev.t === "num" || prev.t === "sym" || prev.t === "word" || prev.t === "close" || (prev.t === "cmd" && prev.s !== "frac"));
			const starts = next && (next.t === "num" || next.t === "sym" || next.t === "word" || next.t === "open" || next.t === "cmd" || (next.t === "op" && next.s === "-"));
			if (ends && starts) marked.push({ t: "sep", s: "nl", a: t.a, b: t.b });
		} else {
			marked.push(t);
		}
	}
	const out: Tok[][] = [];
	let cur: Tok[] = [];
	let depth = 0;
	for (const t of marked) {
		if (t.t === "open" || (t.t === "cmd" && t.s.startsWith("begin:"))) depth++;
		else if (t.t === "close" || (t.t === "cmd" && t.s.startsWith("end:"))) depth = Math.max(0, depth - 1);
		if (depth === 0 && t.t === "sep") {
			if (cur.length) out.push(cur);
			cur = [];
		} else {
			cur.push(t);
		}
	}
	if (cur.length) out.push(cur);
	return out;
}

const DECLARATION = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:=|:=|\\equiv|\\sim|\\coloneqq)\s*(.+?)\s*$/s;

/**
 * Checks the dimensions of a formula. Pure and total: text that cannot be read gives no issue, never an exception.
 *
 * Several formulas may be written one after another (separated by `\\`, `;`, a line break or `,`); a symbol defined by a
 * value or declared as `[v] = m/s` keeps its dimension on the following ones.
 */
export function analyzeDimensions(source: string, opts: DimensionOptions = {}): DimensionReport {
	const report: DimensionReport = { issues: [], checked: 0, symbols: {} };
	if (typeof source !== "string" || source.length === 0 || source.length > DIMENSIONS_TEXT_MAX) return report;
	const plain = opts.plain === true;
	const limit = Math.max(1, opts.maxIssues ?? 20);
	const src = normalizeSource(source);
	const env = new Map<string, Dim>();
	for (const [name, unit] of Object.entries(opts.symbols ?? {})) {
		const d = parseUnit(unit);
		if (d) env.set(canonName(name), d);
	}
	const toks = tokenize(src, plain);
	if (!toks) return report;
	let carry: Q | null = null;
	for (const stmt of splitStatements(toks)) {
		if (report.issues.length >= limit) break;
		// "[v] = m/s": a declaration.
		const raw = src.slice(stmt[0]!.a, stmt[stmt.length - 1]!.b);
		const decl = DECLARATION.exec(raw);
		if (decl) {
			const unit = parseUnit(decl[2]!);
			if (unit) {
				env.set(canonName(decl[1]!), unit);
				carry = null;
				continue;
			}
		}
		const sink: Sink = { issues: [], checked: 0 };
		const ctx: Ctx = { src, plain, env, sink };
		try {
			const p = new Parser(stmt, ctx);
			const { items, rels } = p.parseChain(carry);
			checkChain(items, rels, ctx);
			bindSymbols(items, rels, env);
			carry = items[items.length - 1] ?? null;
			report.issues.push(...sink.issues);
			report.checked += sink.checked;
		} catch {
			carry = null;
		}
	}
	if (report.issues.length > limit) report.issues.length = limit;
	for (const [name, d] of env) report.symbols[name] = formatDimension(d);
	return report;
}

function checkChain(items: Q[], rels: string[], ctx: Ctx): void {
	let ref: Q | null = items[0]?.dim ? items[0] : null;
	for (let k = 1; k < items.length; k++) {
		const rel = rels[k - 1]!;
		const cur = items[k]!;
		if (rel === "prop") {
			ref = null;
			continue;
		}
		if (ref && cur.dim && !isZeroLit(ref) && !isZeroLit(cur)) {
			if (!ref.pure || !cur.pure) ctx.sink.checked++;
			if (!dimEqual(ref.dim!, cur.dim)) {
				const bare = ref.pure ? "left" : cur.pure ? "right" : undefined;
				const issue: DimensionIssue = {
					kind: bare ? "unit-missing" : "relation",
					op: rel,
					left: cleanFormulaText(ctx.src.slice(ref.a, ref.b)),
					right: cleanFormulaText(ctx.src.slice(cur.a, cur.b)),
					leftDim: ref.dim,
					rightDim: cur.dim,
					message: "",
					at: [Math.min(ref.a, cur.a), Math.max(ref.b, cur.b)],
				};
				if (bare) issue.bare = bare;
				issue.message = explainIssue(issue);
				ctx.sink.issues.push(issue);
			}
		}
		if (cur.dim && !isZeroLit(cur)) ref = cur;
	}
}

/** `m = 2 kg`, `F := m a`: a symbol with no dimension yet takes the one of the value it is set equal to. */
function bindSymbols(items: Q[], rels: string[], env: Map<string, Dim>): void {
	if (!rels.every((r) => r === "=" || r === "def")) return;
	const value = items.find((q) => q.dim && !q.pure);
	if (!value?.dim) return;
	for (const q of items) {
		if (q.sym && !env.has(q.sym) && !q.dim) env.set(q.sym, value.dim);
	}
}

/** The dimension of a formula or expression: its last value, or null when it is unknown. */
export function dimensionOf(source: string, opts: DimensionOptions = {}): Dim | null {
	if (typeof source !== "string" || source.length === 0 || source.length > DIMENSIONS_TEXT_MAX) return null;
	const src = normalizeSource(source);
	const toks = tokenize(src, opts.plain === true);
	if (!toks || toks.length === 0) return null;
	const env = new Map<string, Dim>();
	for (const [name, unit] of Object.entries(opts.symbols ?? {})) {
		const d = parseUnit(unit);
		if (d) env.set(canonName(name), d);
	}
	try {
		const p = new Parser(toks.filter((t) => t.t !== "nl"), { src, plain: opts.plain === true, env, sink: { issues: [], checked: 0 } });
		return p.parseAll().dim;
	} catch {
		return null;
	}
}

/** The names `quantityName` can return, for the texts that translate them. */
export const QUANTITY_NAMES: readonly string[] = QUANTITIES.map(([name]) => name);
