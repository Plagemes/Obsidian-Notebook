/**
 * The advanced calculator's evaluator (#182). It walks the tree of calc-parse.ts over fixed tables of functions,
 * constants and units: no eval, no Function, no property access by name (names go through Maps built here), a step and
 * time budget per statement, and bounded sizes everywhere (see calc-number.ts). Values are quantities (an exact
 * rational, a double or a complex number with a dimension and the unit to show it in) and matrices.
 * Pure: no 'obsidian', no DOM.
 */
import {
	CalcError, ONE, ZERO, at as matAt, ccos, cexp, cln, csin, csqrt, cx, determinant, dot, eadd, ediv, emul, eneg, epow, esub, frac,
	identity, inverse, isCx, isFrac, isInteger, isZero, mat, mmap, mmul, mpow, mzip, radd, rcmp, rdiv, rmul, rneg, rpow, rsub, sign, solveLinear, toCx, toNum,
	transpose, cross, cabs, carg, collapse, MAX_DIM, MAX_LIST, type Entry, type Mat, type Real,
} from "./calc-number";
import { DIMENSIONLESS, dimEqual, isDimensionless, type Dim } from "./dimensions";
import { lookupConstant } from "./calc-constants";
import { parseStatement, type Node, type ParseContext } from "./calc-parse";
import { formatUnit, isBaseUnit, lookupUnit, parseUnitText, siUnit, unitInfo, unitMul, unitPow, type UnitExp } from "./calc-units";
import { derivative, integrate } from "./numeric";

export { CalcError };

// ------------------------------------------------------------------------------------------------ values

/** A number with a dimension. `v` is in SI base units; `unit` is the unit to show it in (null: SI, or none for a pure number). */
export interface Quantity {
	readonly t: "q";
	readonly v: Entry;
	readonly dim: Dim;
	readonly unit: UnitExp | null;
	/** Show as a decimal, not as a fraction (a decimal was typed, or a double came into it). */
	readonly dec: boolean;
}
export interface MatrixValue {
	readonly t: "m";
	readonly m: Mat;
	readonly dec: boolean;
}
export type Value = Quantity | MatrixValue;

export const num = (v: Entry, dec = false): Quantity => ({ t: "q", v, dim: DIMENSIONLESS, unit: null, dec });
const matrix = (m: Mat, dec = false): MatrixValue => ({ t: "m", m, dec });
const fromNumber = (x: number): Quantity => num(x, true);

export interface UserFunction {
	params: string[];
	node: Node;
	body: string;
}

export type CalcAngle = "deg" | "rad";

/** The state of a calculator: variables, functions, the last answer and the angle unit. */
export class CalcSession {
	readonly vars = new Map<string, Value>();
	readonly fns = new Map<string, UserFunction>();
	ans: Value | null = null;
	angle: CalcAngle = "deg";
}

export const MAX_VARS = 64;

// ------------------------------------------------------------------------------------------------ helpers

const unitName = (dim: Dim, unit: UnitExp | null): string => formatUnit(unit ?? siUnit(dim)) || "1";

function scalar(v: Value, fn: string): Quantity {
	if (v.t !== "q") throw new CalcError("need-number", { fn });
	return v;
}

function plain(v: Value, fn: string): Entry {
	const q = scalar(v, fn);
	if (!isDimensionless(q.dim) || (q.unit && hasDimUnit(q.unit))) throw new CalcError("need-plain", { fn });
	return q.v;
}

function hasDimUnit(u: UnitExp): boolean {
	return !isDimensionless(unitInfo(u).dim);
}

/** A real (not complex) plain number as a double. */
function real(v: Value, fn: string): number {
	const e = plain(v, fn);
	if (isCx(e)) throw new CalcError("need-real", { fn });
	return toNum(e);
}

function realExact(v: Value, fn: string): Real {
	const e = plain(v, fn);
	if (isCx(e)) throw new CalcError("need-real", { fn });
	return e;
}

function int(v: Value, fn: string, lo = -1e9, hi = 1e9): number {
	const x = real(v, fn);
	if (!Number.isInteger(x) || x < lo || x > hi) throw new CalcError("need-integer", { fn });
	return x;
}

/** SI scale of a unit text as an exact rational where it is a whole number. */
function exactScale(s: number): Real {
	return Number.isInteger(s) && Math.abs(s) < 2 ** 53 ? frac(BigInt(s)) : s;
}

function offsetOf(unit: UnitExp | null): number | undefined {
	return unit ? unitInfo(unit).offset : undefined;
}

/** The value of `x` shown in its unit (or in SI units with the name of that unit), with the unit's text. */
export function inUnit(q: Quantity): { value: Entry; unit: string } {
	const unit = q.unit ?? siUnit(q.dim);
	if (!unit) return { value: q.v, unit: "" };
	const info = unitInfo(unit);
	if (isCx(q.v)) return { value: ediv(q.v, info.scale), unit: formatUnit(unit) };
	const off = info.offset;
	if (off !== undefined) return { value: (toNum(q.v) - off) / info.scale, unit: formatUnit(unit) };
	return { value: rdiv(q.v, exactScale(info.scale)), unit: formatUnit(unit) };
}

/** Display unit of a product or quotient of two quantities. */
function combineUnits(a: Quantity, b: Quantity, power: 1 | -1, dim: Dim): UnitExp | null {
	const ua = a.unit && offsetOf(a.unit) === undefined ? a.unit : siUnit(a.dim);
	const ub = b.unit && offsetOf(b.unit) === undefined ? b.unit : siUnit(b.dim);
	const u = unitMul(ua, ub, power);
	if (!u) return null;
	// A ratio of two units of the same kind is a plain number (km/m).
	if (isDimensionless(dim)) {
		for (const name of u.keys()) if (!isDimensionless(unitInfo(new Map([[name, 1]])).dim)) return null;
		return u;
	}
	// Only SI base units (kg·m/s²): the named unit of that dimension (N) reads better.
	if ([...u.keys()].every(isBaseUnit)) return siUnit(dim);
	return dimEqual(unitInfo(u).dim, dim) ? u : siUnit(dim);
}

function addDims(a: Dim, b: Dim, k: number): Dim {
	return a.map((x, i) => x + k * (b[i] ?? 0));
}

// ------------------------------------------------------------------------------------------------ arithmetic on values

function entryBin(op: "+" | "-" | "*" | "/", a: Entry, b: Entry): Entry {
	switch (op) {
		case "+": return eadd(a, b);
		case "-": return esub(a, b);
		case "*": return emul(a, b);
		default: return ediv(a, b);
	}
}

function matrixOnly(v: Quantity): Entry {
	if (!isDimensionless(v.dim) || v.unit) throw new CalcError("matrix-units");
	return v.v;
}

function addSub(op: "+" | "-", a: Value, b: Value): Value {
	if (a.t === "m" || b.t === "m") {
		if (a.t === "m" && b.t === "m") return matrix(mzip(a.m, b.m, (x, y) => entryBin(op, x, y)), a.dec || b.dec);
		throw new CalcError("matrix-scalar-add");
	}
	if (!dimEqual(a.dim, b.dim)) throw new CalcError("dim-mismatch", { a: unitName(a.dim, a.unit), b: unitName(b.dim, b.unit), op });
	const dec = a.dec || b.dec;
	const keep = a.unit ?? b.unit;
	const unit = keep && offsetOf(keep) === undefined ? keep : null;
	return { t: "q", v: entryBin(op, a.v, b.v), dim: a.dim, unit, dec };
}

function mulDiv(op: "*" | "/", a: Value, b: Value): Value {
	if (a.t === "m" || b.t === "m") {
		const dec = a.dec || b.dec;
		if (a.t === "m" && b.t === "m") {
			if (op === "*") return matrix(mmul(a.m, b.m), dec);
			return matrix(mmul(a.m, inverse(b.m)), dec);
		}
		if (a.t === "m") {
			const s = matrixOnly(b as Quantity);
			return matrix(mmap(a.m, (e) => entryBin(op, e, s)), dec);
		}
		if (op === "/") throw new CalcError("matrix-divide");
		const s = matrixOnly(a);
		return matrix(mmap((b as MatrixValue).m, (e) => emul(s, e)), dec);
	}
	const dim = addDims(a.dim, b.dim, op === "*" ? 1 : -1);
	const v = entryBin(op, a.v, b.v);
	if (!isDimensionless(dim) && isCx(v)) throw new CalcError("complex-units");
	return { t: "q", v, dim, unit: combineUnits(a, b, op === "*" ? 1 : -1, dim), dec: a.dec || b.dec };
}

function power(a: Value, b: Value): Value {
	if (b.t === "m") throw new CalcError("matrix-exponent");
	if (a.t === "m") {
		const k = int(b, "^", -1000, 1000);
		return matrix(mpow(a.m, k), a.dec);
	}
	if (!isDimensionless(b.dim) || (b.unit && hasDimUnit(b.unit))) throw new CalcError("exponent-units");
	const dec = a.dec || b.dec;
	if (isDimensionless(a.dim)) {
		// A plain number (an angle in degrees stays a number here).
		const r = epow(a.v, b.v);
		return { t: "q", v: r, dim: a.dim, unit: null, dec: dec || !isExactEntry(r) };
	}
	if (isCx(b.v) || isCx(a.v)) throw new CalcError("complex-units");
	const p = toNum(b.v);
	const r = rpow(a.v, b.v);
	if (r === null) throw new CalcError("domain", { fn: "^" });
	const base = a.unit && offsetOf(a.unit) === undefined ? a.unit : siUnit(a.dim);
	return { t: "q", v: r, dim: a.dim.map((x) => x * p), unit: unitPow(base, p), dec: dec || !isExactEntry(r) };
}

const isExactEntry = (e: Entry): boolean => isFrac(e);

function negate(a: Value): Value {
	return a.t === "m" ? matrix(mmap(a.m, eneg), a.dec) : { ...a, v: eneg(a.v) };
}

function factorialOf(q: Quantity): Value {
	const x = real(q, "!");
	if (Number.isInteger(x) && x >= 0) {
		if (x > 1000) throw new CalcError("too-big");
		let r = 1n;
		for (let i = 2n; i <= BigInt(x); i++) r *= i;
		return num(frac(r));
	}
	return fromNumber(gammaFn(x + 1));
}

/** Lanczos approximation (g = 7). */
function gammaFn(z: number): number {
	if (!Number.isFinite(z)) return NaN;
	if (z <= 0 && Number.isInteger(z)) throw new CalcError("domain", { fn: "gamma" });
	if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
	const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
		12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
	const x = z - 1;
	let a = c[0]!;
	const t = x + 7.5;
	for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
	return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

// ------------------------------------------------------------------------------------------------ functions

interface Ev {
	session: CalcSession;
	/** Evaluates a node (for the special forms that take expressions). */
	eval(node: Node): Value;
	/** Evaluates a node with a name bound to a double. */
	withVar<T>(name: string, run: (set: (x: number) => void) => T): T;
}

type Impl = (args: Value[], ev: Ev, nodes: Node[]) => Value;

interface FnDef {
	min: number;
	max: number;
	f: Impl;
	/** Applies to every entry of a matrix argument. */
	each?: boolean;
	/** Needs the unevaluated argument expressions (solve, integrate, diff). */
	special?: boolean;
}

const FUNCS = new Map<string, FnDef>();

function fn(names: string | readonly string[], min: number, max: number, f: Impl, opts: { each?: boolean; special?: boolean } = {}): void {
	for (const n of typeof names === "string" ? [names] : names) FUNCS.set(n, { min, max, f, ...opts });
}

function angleToRad(q: Quantity, ev: Ev, name: string): Entry {
	if (!isDimensionless(q.dim)) throw new CalcError("need-angle", { fn: name });
	// An angle with a unit (30 deg) is already radians in SI; a plain number follows the angle mode.
	if (q.unit) return q.v;
	return ev.session.angle === "deg" ? emul(q.v, Math.PI / 180) : q.v;
}

function fromRad(x: number, ev: Ev): Quantity {
	return fromNumber(ev.session.angle === "deg" ? (x * 180) / Math.PI : x);
}

function realFn(name: string, f: (x: number) => number, check?: (x: number) => boolean): void {
	fn(name, 1, 1, (a) => {
		const x = real(a[0]!, name);
		if (check && !check(x)) throw new CalcError("domain", { fn: name });
		return fromNumber(f(x));
	}, { each: true });
}

function trig(name: string, real_: (x: number) => number, cplx?: (c: ReturnType<typeof cx>) => ReturnType<typeof cx>): void {
	fn(name, 1, 1, (a, ev) => {
		const q = scalar(a[0]!, name);
		const r = angleToRad(q, ev, name);
		if (isCx(r)) {
			if (!cplx) throw new CalcError("need-real", { fn: name });
			return num(collapse(cplx(r)), true);
		}
		const y = real_(toNum(r));
		// Exact zeros and ones at the usual angles (sin 180° = 0, cos 90° = 0).
		if (Math.abs(y) < 1e-15) return num(ZERO);
		return fromNumber(y);
	}, { each: true });
}

trig("sin", Math.sin, csin);
trig("cos", Math.cos, ccos);
trig("tan", Math.tan);
trig("cot", (x) => 1 / Math.tan(x));
trig("sec", (x) => 1 / Math.cos(x));
trig("csc", (x) => 1 / Math.sin(x));

function invTrig(names: string[], f: (x: number) => number, ok: (x: number) => boolean): void {
	for (const name of names) {
		fn(name, 1, 1, (a, ev) => {
			const x = real(a[0]!, name);
			if (!ok(x)) throw new CalcError("domain", { fn: name });
			return fromRad(f(x), ev);
		}, { each: true });
	}
}
invTrig(["asin", "arcsin"], Math.asin, (x) => x >= -1 && x <= 1);
invTrig(["acos", "arccos"], Math.acos, (x) => x >= -1 && x <= 1);
invTrig(["atan", "arctan"], Math.atan, () => true);
fn(["atan2"], 2, 2, (a, ev) => fromRad(Math.atan2(real(a[0]!, "atan2"), real(a[1]!, "atan2")), ev));

realFn("sinh", Math.sinh);
realFn("cosh", Math.cosh);
realFn("tanh", Math.tanh);
realFn("asinh", Math.asinh);
realFn("acosh", Math.acosh, (x) => x >= 1);
realFn("atanh", Math.atanh, (x) => x > -1 && x < 1);
realFn("log2", Math.log2, (x) => x > 0);
realFn("log10", Math.log10, (x) => x > 0);
realFn("cbrt", Math.cbrt);
realFn("gamma", gammaFn);

fn("sqrt", 1, 1, (a) => {
	const q = scalar(a[0]!, "sqrt");
	if (!isDimensionless(q.dim)) {
		if (isCx(q.v) || sign(q.v) < 0) throw new CalcError("domain", { fn: "sqrt" });
		return power(q, num(frac(1n, 2n)));
	}
	if (!isCx(q.v) && sign(q.v) >= 0) return num(rpow(q.v, frac(1n, 2n))!, !isFrac(q.v) || q.dec);
	return num(collapse(csqrt(toCx(q.v))), true);
}, { each: true });

fn("root", 2, 2, (a) => {
	const n = real(a[0]!, "root");
	const x = scalar(a[1]!, "root");
	if (n === 0) throw new CalcError("domain", { fn: "root" });
	if (n % 2 !== 0 && Number.isInteger(n) && !isCx(x.v) && sign(x.v) < 0 && isDimensionless(x.dim)) {
		return fromNumber(-Math.pow(-toNum(x.v), 1 / n));
	}
	return power(x, num(rdiv(ONE, realExact(a[0]!, "root"))));
});

fn("exp", 1, 1, (a) => {
	const e = plain(a[0]!, "exp");
	return num(isCx(e) ? collapse(cexp(e)) : Math.exp(toNum(e)), true);
}, { each: true });

fn("ln", 1, 1, (a) => {
	const e = plain(a[0]!, "ln");
	if (!isCx(e) && sign(e) > 0) {
		// ln(1) is exactly 0.
		return rcmp(e, ONE) === 0 ? num(ZERO) : fromNumber(Math.log(toNum(e)));
	}
	return num(collapse(cln(toCx(e))), true);
}, { each: true });

fn("log", 1, 2, (a) => {
	const x = real(a[0]!, "log");
	if (a.length === 1) {
		if (x <= 0) throw new CalcError("domain", { fn: "log" });
		return fromNumber(Math.log10(x));
	}
	const b = real(a[1]!, "log");
	if (x <= 0 || b <= 0 || b === 1) throw new CalcError("domain", { fn: "log" });
	return fromNumber(Math.log(x) / Math.log(b));
});

/** Functions that keep the unit of their argument. */
function sameUnit(name: string, f: (x: Entry) => Entry): void {
	fn(name, 1, 1, (a) => {
		const q = scalar(a[0]!, name);
		return { ...q, v: f(q.v) };
	}, { each: true });
}

fn("abs", 1, 1, (a) => {
	const q = scalar(a[0]!, "abs");
	return { ...q, v: isCx(q.v) ? cabs(q.v) : sign(q.v) < 0 ? rneg(q.v) : q.v, dec: q.dec || isCx(q.v) };
}, { each: true });
sameUnit("conj", (e) => (isCx(e) ? cx(e.re, -e.im) : e));
fn("re", 1, 1, (a) => {
	const q = scalar(a[0]!, "re");
	return { ...q, v: isCx(q.v) ? q.v.re : q.v };
});
fn("im", 1, 1, (a) => {
	const q = scalar(a[0]!, "im");
	return { ...q, v: isCx(q.v) ? q.v.im : ZERO };
});
fn("arg", 1, 1, (a, ev) => fromRad(carg(toCx(plain(a[0]!, "arg"))), ev));
fn("sign", 1, 1, (a) => num(frac(BigInt(sign(realExact(a[0]!, "sign"))))), { each: true });

function rounder(name: string, f: (x: number) => number): void {
	fn(name, 1, 1, (a) => {
		const q = scalar(a[0]!, name);
		if (isCx(q.v)) throw new CalcError("need-real", { fn: name });
		if (isFrac(q.v) && q.v.d === 1n) return q;
		const x = toNum(q.v);
		const unit = q.unit ?? siUnit(q.dim);
		// Round in the unit shown (floor(2.7 m) is 2 m).
		const scale = unit ? unitInfo(unit).scale : 1;
		const y = f(x / scale) * scale;
		return { ...q, v: Number.isInteger(y) && Math.abs(y) < 2 ** 53 && scale === 1 ? frac(BigInt(y)) : y, dec: false };
	}, { each: true });
}
rounder("floor", Math.floor);
rounder("ceil", Math.ceil);
rounder("trunc", Math.trunc);

fn("round", 1, 2, (a) => {
	const q = scalar(a[0]!, "round");
	if (isCx(q.v)) throw new CalcError("need-real", { fn: "round" });
	const digits = a.length > 1 ? int(a[1]!, "round", -15, 15) : 0;
	const unit = q.unit ?? siUnit(q.dim);
	const scale = unit ? unitInfo(unit).scale : 1;
	const k = Math.pow(10, digits);
	const y = (Math.round((toNum(q.v) / scale) * k + Number.EPSILON * Math.sign(toNum(q.v))) / k) * scale;
	return { ...q, v: digits <= 0 && scale === 1 && Number.isInteger(y) ? frac(BigInt(y)) : y, dec: digits > 0 };
}, { each: true });

fn("mod", 2, 2, (a) => {
	const x = scalar(a[0]!, "mod"), y = scalar(a[1]!, "mod");
	if (!dimEqual(x.dim, y.dim)) throw new CalcError("dim-mismatch", { a: unitName(x.dim, x.unit), b: unitName(y.dim, y.unit), op: "mod" });
	if (isCx(x.v) || isCx(y.v)) throw new CalcError("need-real", { fn: "mod" });
	if (isZero(y.v)) throw new CalcError("div-zero");
	if (isFrac(x.v) && isFrac(y.v)) {
		const q = rdiv(x.v, y.v) as { n: bigint; d: bigint };
		const fl = q.n >= 0n ? q.n / q.d : -((-q.n + q.d - 1n) / q.d);
		return { ...x, v: rsub(x.v, rmul(frac(fl), y.v)) };
	}
	const p = toNum(x.v), r = toNum(y.v);
	return { ...x, v: p - r * Math.floor(p / r), dec: true };
});

function gcdBig(a: bigint, b: bigint): bigint {
	let x = a < 0n ? -a : a;
	let y = b < 0n ? -b : b;
	while (y !== 0n) [x, y] = [y, x % y];
	return x;
}

function bigInts(a: Value[], name: string): bigint[] {
	return flatten(a, name).map((v) => {
		const e = plain(v, name);
		if (isCx(e) || !isInteger(e)) throw new CalcError("need-integer", { fn: name });
		return isFrac(e) ? e.n : BigInt(e);
	});
}

fn("gcd", 1, 40, (a) => num(frac(bigInts(a, "gcd").reduce((x, y) => gcdBig(x, y)))));
fn("lcm", 1, 40, (a) => num(frac(bigInts(a, "lcm").reduce((x, y) => (x === 0n || y === 0n ? 0n : (x / gcdBig(x, y)) * (y < 0n ? -y : y))))));

function binom(n: number, k: number): bigint {
	if (k < 0 || k > n) return 0n;
	k = Math.min(k, n - k);
	let r = 1n;
	for (let i = 1; i <= k; i++) r = (r * BigInt(n - k + i)) / BigInt(i);
	return r;
}
fn(["nCr", "comb", "binom"], 2, 2, (a) => num(frac(binom(int(a[0]!, "nCr", 0, 5000), int(a[1]!, "nCr", 0, 5000)))));
fn(["nPr", "perm"], 2, 2, (a) => {
	const n = int(a[0]!, "nPr", 0, 5000), k = int(a[1]!, "nPr", 0, 5000);
	let r = 1n;
	if (k <= n) for (let i = 0; i < k; i++) r *= BigInt(n - i);
	else r = 0n;
	return num(frac(r));
});

fn("hypot", 1, 12, (a) => {
	const qs = a.map((v) => scalar(v, "hypot"));
	for (const q of qs) if (!dimEqual(q.dim, qs[0]!.dim)) throw new CalcError("dim-mismatch", { a: unitName(qs[0]!.dim, qs[0]!.unit), b: unitName(q.dim, q.unit), op: "hypot" });
	const values = qs.map((q) => {
		if (isCx(q.v)) throw new CalcError("need-real", { fn: "hypot" });
		return toNum(q.v);
	});
	return { ...qs[0]!, v: Math.hypot(...values), dec: true };
});

// Fractions
fn(["fraction", "frac"], 1, 2, (a) => {
	const x = real(a[0]!, "fraction");
	const maxDen = a.length > 1 ? int(a[1]!, "fraction", 1, 1e9) : 1e6;
	if (!Number.isFinite(x)) throw new CalcError("domain", { fn: "fraction" });
	// Continued fraction.
	let h1 = 1, h0 = 0, k1 = 0, k0 = 1, y = Math.abs(x);
	for (let i = 0; i < 40; i++) {
		const ai = Math.floor(y);
		const h2 = ai * h1 + h0, k2 = ai * k1 + k0;
		if (k2 > maxDen) break;
		[h0, h1, k0, k1] = [h1, h2, k1, k2];
		if (Math.abs(Math.abs(x) - h1 / k1) < 1e-12 * Math.max(1, Math.abs(x))) break;
		const rest = y - ai;
		if (rest < 1e-15) break;
		y = 1 / rest;
	}
	return num(frac(BigInt(Math.sign(x) * h1), BigInt(Math.max(1, k1))));
});
fn("numer", 1, 1, (a) => {
	const e = realExact(a[0]!, "numer");
	return num(isFrac(e) ? frac(e.n) : e);
});
fn("denom", 1, 1, (a) => {
	const e = realExact(a[0]!, "denom");
	return num(isFrac(e) ? frac(e.d) : ONE);
});

// ---- matrices and vectors

const asMat = (v: Value, name: string): Mat => {
	if (v.t !== "m") throw new CalcError("need-matrix", { fn: name });
	return v.m;
};

fn("det", 1, 1, (a) => num(determinant(asMat(a[0]!, "det")), a[0]!.dec));
fn(["inv", "inverse"], 1, 1, (a) => matrix(inverse(asMat(a[0]!, "inv")), a[0]!.dec));
fn(["transpose", "T"], 1, 1, (a) => matrix(transpose(asMat(a[0]!, "transpose")), a[0]!.dec));
fn("trace", 1, 1, (a) => {
	const m = asMat(a[0]!, "trace");
	if (m.rows !== m.cols) throw new CalcError("matrix-square");
	let s: Entry = ZERO;
	for (let i = 0; i < m.rows; i++) s = eadd(s, matAt(m, i, i));
	return num(s, a[0]!.dec);
});
fn(["identity", "eye"], 1, 1, (a) => matrix(identity(int(a[0]!, "identity", 1, MAX_DIM))));
fn("zeros", 1, 2, (a) => {
	const r = int(a[0]!, "zeros", 1, MAX_DIM);
	const c = a.length > 1 ? int(a[1]!, "zeros", 1, MAX_DIM) : r;
	return matrix(mat(r, c, Array.from({ length: r * c }, () => ZERO)));
});
fn("ones", 1, 2, (a) => {
	const r = int(a[0]!, "ones", 1, MAX_DIM);
	const c = a.length > 1 ? int(a[1]!, "ones", 1, MAX_DIM) : r;
	return matrix(mat(r, c, Array.from({ length: r * c }, () => ONE)));
});
fn("dot", 2, 2, (a) => num(dot(asMat(a[0]!, "dot"), asMat(a[1]!, "dot")), a[0]!.dec || a[1]!.dec));
fn("cross", 2, 2, (a) => matrix(cross(asMat(a[0]!, "cross"), asMat(a[1]!, "cross")), a[0]!.dec || a[1]!.dec));
fn(["norm", "length"], 1, 1, (a) => {
	const m = asMat(a[0]!, "norm");
	let s = 0;
	for (const e of m.a) s += isCx(e) ? e.re * e.re + e.im * e.im : toNum(e) ** 2;
	return fromNumber(Math.sqrt(s));
});
fn("size", 1, 1, (a) => {
	const m = asMat(a[0]!, "size");
	return matrix(mat(1, 2, [frac(BigInt(m.rows)), frac(BigInt(m.cols))]));
});
fn("linsolve", 2, 2, (a) => {
	const A = asMat(a[0]!, "linsolve");
	let b = asMat(a[1]!, "linsolve");
	if (b.rows === 1 && b.cols === A.rows) b = transpose(b);
	return matrix(solveLinear(A, b), a[0]!.dec || a[1]!.dec);
});

// ---- statistics

/** Scalars of the arguments in order, matrices flattened. */
function flatten(a: Value[], name: string): Quantity[] {
	const out: Quantity[] = [];
	for (const v of a) {
		if (v.t === "m") for (const e of v.m.a) out.push(num(e, v.dec));
		else out.push(v);
	}
	if (out.length === 0) throw new CalcError("empty-list", { fn: name });
	if (out.length > 5000) throw new CalcError("too-big");
	return out;
}

interface Series {
	xs: Real[];
	proto: Quantity;
}

/** The numbers of a list or of several arguments, all of one dimension. */
function series(a: Value[], name: string): Series {
	const q = flatten(a, name);
	const proto = q[0]!;
	for (const x of q) {
		if (isCx(x.v)) throw new CalcError("need-real", { fn: name });
		if (!dimEqual(x.dim, proto.dim)) throw new CalcError("dim-mismatch", { a: unitName(proto.dim, proto.unit), b: unitName(x.dim, x.unit), op: name });
	}
	return { xs: q.map((x) => x.v as Real), proto };
}

const keep = (s: Series, v: Real, dec = s.proto.dec): Quantity => ({ ...s.proto, v, dec: dec || !isFrac(v) });

function sumReal(xs: readonly Real[]): Real {
	let s: Real = ZERO;
	for (const x of xs) s = radd(s, x);
	return s;
}

function sortedReals(xs: readonly Real[]): Real[] {
	return [...xs].sort(rcmp);
}

function medianOf(xs: readonly Real[]): Real {
	const s = sortedReals(xs);
	const mid = s.length >> 1;
	return s.length % 2 === 1 ? s[mid]! : rdiv(radd(s[mid - 1]!, s[mid]!), frac(2n));
}

function quantileOf(xs: readonly Real[], p: number): Real {
	const s = sortedReals(xs).map(toNum);
	const pos = (s.length - 1) * p;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function varianceOf(xs: readonly Real[], sample: boolean): number {
	const n = xs.length;
	if (sample && n < 2) throw new CalcError("need-two", { fn: "var" });
	const m = toNum(sumReal(xs)) / n;
	let s = 0;
	for (const x of xs) s += (toNum(x) - m) ** 2;
	return s / (sample ? n - 1 : n);
}

fn("sum", 1, 5000, (a) => {
	const s = series(a, "sum");
	return keep(s, sumReal(s.xs));
});
fn(["mean", "avg"], 1, 5000, (a) => {
	const s = series(a, "mean");
	return keep(s, rdiv(sumReal(s.xs), frac(BigInt(s.xs.length))));
});
fn("median", 1, 5000, (a) => {
	const s = series(a, "median");
	return keep(s, medianOf(s.xs));
});
fn("mode", 1, 5000, (a) => {
	const s = series(a, "mode");
	const counts = new Map<string, { x: Real; n: number }>();
	for (const x of s.xs) {
		const key = isFrac(x) ? `${x.n}/${x.d}` : String(x);
		const c = counts.get(key);
		if (c) c.n++;
		else counts.set(key, { x, n: 1 });
	}
	const top = Math.max(...[...counts.values()].map((c) => c.n));
	const modes = [...counts.values()].filter((c) => c.n === top).map((c) => c.x);
	if (top === 1 && s.xs.length > 1) throw new CalcError("no-mode");
	const sorted = sortedReals(modes);
	if (sorted.length === 1) return keep(s, sorted[0]!);
	return matrix(mat(1, Math.min(MAX_DIM, sorted.length), sorted.slice(0, MAX_DIM)), true);
});
fn("prod", 1, 5000, (a) => {
	const q = flatten(a, "prod");
	let p: Entry = ONE;
	for (const x of q) p = emul(p, plain(x, "prod"));
	return num(p, q.some((x) => x.dec));
});
fn("min", 1, 5000, (a) => {
	const s = series(a, "min");
	return keep(s, s.xs.reduce((m, x) => (rcmp(x, m) < 0 ? x : m)));
});
fn("max", 1, 5000, (a) => {
	const s = series(a, "max");
	return keep(s, s.xs.reduce((m, x) => (rcmp(x, m) > 0 ? x : m)));
});
fn("count", 1, 5000, (a) => num(frac(BigInt(flatten(a, "count").length))));
fn("span", 1, 5000, (a) => {
	const s = series(a, "span");
	const sorted = sortedReals(s.xs);
	return keep(s, rsub(sorted[sorted.length - 1]!, sorted[0]!));
});
fn(["var", "variance"], 1, 5000, (a) => {
	const s = series(a, "var");
	if (!isDimensionless(s.proto.dim)) throw new CalcError("need-plain", { fn: "var" });
	return fromNumber(varianceOf(s.xs, true));
});
fn("varp", 1, 5000, (a) => {
	const s = series(a, "varp");
	if (!isDimensionless(s.proto.dim)) throw new CalcError("need-plain", { fn: "varp" });
	return fromNumber(varianceOf(s.xs, false));
});
fn(["std", "stdev"], 1, 5000, (a) => {
	const s = series(a, "std");
	return keep(s, Math.sqrt(varianceOf(s.xs, true)), true);
});
fn(["stdp", "stdevp"], 1, 5000, (a) => {
	const s = series(a, "stdp");
	return keep(s, Math.sqrt(varianceOf(s.xs, false)), true);
});
fn(["quantile", "percentile"], 2, 2, (a, _ev) => {
	const s = series([a[0]!], "quantile");
	let p = real(a[1]!, "quantile");
	if (p > 1) p /= 100;
	if (p < 0 || p > 1) throw new CalcError("domain", { fn: "quantile" });
	return keep(s, quantileOf(s.xs, p), true);
});
fn("sort", 1, 1, (a) => {
	const s = series(a, "sort");
	return matrix(mat(1, s.xs.length, sortedReals(s.xs)));
});
fn("seq", 2, 3, (a) => {
	const lo = realExact(a[0]!, "seq"), hi = realExact(a[1]!, "seq");
	const st = a.length > 2 ? realExact(a[2]!, "seq") : ONE;
	if (isZero(st)) throw new CalcError("domain", { fn: "seq" });
	const out: Real[] = [];
	for (let x = lo; (sign(st) > 0 ? rcmp(x, hi) <= 0 : rcmp(x, hi) >= 0); x = radd(x, st)) {
		out.push(x);
		if (out.length > MAX_LIST) throw new CalcError("matrix-size", { max: String(MAX_LIST) });
	}
	return matrix(mat(1, out.length, out));
});

function pair(a: Value[], name: string): { xs: number[]; ys: number[] } {
	const x = flatten([a[0]!], name).map((q) => real(q, name));
	const y = flatten([a[1]!], name).map((q) => real(q, name));
	if (x.length !== y.length) throw new CalcError("matrix-shape");
	if (x.length < 2) throw new CalcError("need-two", { fn: name });
	return { xs: x, ys: y };
}
function moments(p: { xs: number[]; ys: number[] }): { sxx: number; syy: number; sxy: number; mx: number; my: number } {
	const n = p.xs.length;
	const mx = p.xs.reduce((s, x) => s + x, 0) / n;
	const my = p.ys.reduce((s, x) => s + x, 0) / n;
	let sxx = 0, syy = 0, sxy = 0;
	for (let i = 0; i < n; i++) {
		sxx += (p.xs[i]! - mx) ** 2;
		syy += (p.ys[i]! - my) ** 2;
		sxy += (p.xs[i]! - mx) * (p.ys[i]! - my);
	}
	return { sxx, syy, sxy, mx, my };
}
fn(["corr", "correlation"], 2, 2, (a) => {
	const m = moments(pair(a, "corr"));
	if (m.sxx === 0 || m.syy === 0) throw new CalcError("domain", { fn: "corr" });
	return fromNumber(m.sxy / Math.sqrt(m.sxx * m.syy));
});
fn("slope", 2, 2, (a) => {
	const m = moments(pair(a, "slope"));
	if (m.sxx === 0) throw new CalcError("domain", { fn: "slope" });
	return fromNumber(m.sxy / m.sxx);
});
fn("intercept", 2, 2, (a) => {
	const m = moments(pair(a, "intercept"));
	if (m.sxx === 0) throw new CalcError("domain", { fn: "intercept" });
	return fromNumber(m.my - (m.sxy / m.sxx) * m.mx);
});

// ---- special forms: solve, integrate, diff

function nameOf(node: Node | undefined, fnName: string): string {
	if (!node || node.k !== "name") throw new CalcError("need-name", { fn: fnName });
	return node.name;
}

/** A function of one variable from an expression, a double in, a double out (NaN where undefined). */
function scalarFunction(ev: Ev, node: Node, variable: string): (x: number) => number {
	const body: Node = node.k === "eq" ? { k: "bin", op: "-", a: node.a, b: node.b } : node;
	return ev.withVar(variable, (set) => (x: number): number => {
		set(x);
		try {
			const v = ev.eval(body);
			if (v.t !== "q" || isCx(v.v)) return NaN;
			return toNum(v.v);
		} catch (e) {
			if (e instanceof CalcError && (e.code === "timeout" || e.code === "too-many-steps")) throw e;
			return NaN;
		}
	});
}

function cleanRoot(x: number): number {
	const r = Math.round(x);
	return Math.abs(x - r) < 1e-9 * Math.max(1, Math.abs(x)) ? r : x;
}

/**
 * Roots of f on [lo, hi]: sign changes refined by bisection (not through a pole, where |f| grows instead of vanishing)
 * and points where f touches zero without crossing it ((x−1)²), found as strict local minima of |f| and refined by
 * ternary search. A function that is flat elsewhere (exp for x ≪ 0) has no strict minima there, so nothing floods.
 */
function scanRoots(f: (x: number) => number, lo: number, hi: number, n: number): number[] {
	const xs: number[] = [];
	const ys: number[] = [];
	for (let i = 0; i <= n; i++) {
		const x = lo + ((hi - lo) * i) / n;
		xs.push(x);
		ys.push(f(x));
	}
	const out: number[] = [];
	const push = (x: number) => {
		if (!out.some((o) => Math.abs(o - x) <= 1e-9 * Math.max(1, Math.abs(x)))) out.push(x);
	};
	for (let i = 0; i < n; i++) {
		const y0 = ys[i]!, y1 = ys[i + 1]!;
		if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
		if (y0 === 0) push(xs[i]!);
		else if (y1 !== 0 && Math.sign(y0) !== Math.sign(y1)) {
			let a = xs[i]!, b = xs[i + 1]!, fa = y0;
			for (let k = 0; k < 100; k++) {
				const m = (a + b) / 2;
				if (m === a || m === b) break;
				const fm = f(m);
				if (!Number.isFinite(fm)) break;
				if (fm === 0) {
					a = b = m;
					break;
				}
				if (Math.sign(fm) === Math.sign(fa)) {
					a = m;
					fa = fm;
				} else b = m;
			}
			const x = (a + b) / 2;
			if (Math.abs(f(x)) <= Math.min(Math.abs(y0), Math.abs(y1))) push(x);
		}
		if (out.length >= 40) break;
	}
	if (Number.isFinite(ys[n]!) && ys[n] === 0) push(xs[n]!);
	for (let i = 1; i < n && out.length < 40; i++) {
		const a0 = Math.abs(ys[i - 1]!), a1 = Math.abs(ys[i]!), a2 = Math.abs(ys[i + 1]!);
		if (!(Number.isFinite(a0) && Number.isFinite(a1) && Number.isFinite(a2)) || !(a1 < a0 && a1 <= a2) || a1 === 0) continue;
		if (Math.sign(ys[i - 1]!) !== Math.sign(ys[i + 1]!)) continue;
		let a = xs[i - 1]!, b = xs[i + 1]!;
		for (let k = 0; k < 80; k++) {
			const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
			if (Math.abs(f(m1)) < Math.abs(f(m2))) b = m2;
			else a = m1;
		}
		const x = (a + b) / 2;
		if (Math.abs(f(x)) <= 1e-9 * Math.max(1, a0, a2)) push(x);
	}
	return out.sort((p, q) => p - q);
}

fn("solve", 2, 4, (args, ev, nodes) => {
	const variable = nameOf(nodes[1], "solve");
	const f = scalarFunction(ev, nodes[0]!, variable);
	const bounds = args.length >= 4 ? [real(args[2]!, "solve"), real(args[3]!, "solve")] : null;
	if (bounds && !(bounds[1]! > bounds[0]!)) throw new CalcError("domain", { fn: "solve" });
	const ranges: Array<[number, number, number]> = bounds ? [[bounds[0]!, bounds[1]!, 6000]] : [[-1000, 1000, 5000], [-1e6, 1e6, 4000]];
	for (const [lo, hi, n] of ranges) {
		const good = scanRoots(f, lo, hi, n).map(cleanRoot).filter((r, i, all) => Math.abs(f(r)) <= 1e-6 * Math.max(1, Math.abs(r)) && all.indexOf(r) === i).slice(0, 12);
		if (good.length === 0) continue;
		if (good.length === 1) return Number.isInteger(good[0]!) ? num(frac(BigInt(good[0]!))) : fromNumber(good[0]!);
		return matrix(mat(1, good.length, good.map((r) => (Number.isInteger(r) ? frac(BigInt(r)) : r))), true);
	}
	throw new CalcError("no-solution");
}, { special: true });

fn(["integrate", "integral"], 4, 4, (args, ev, nodes) => {
	const variable = nameOf(nodes[1], "integrate");
	const f = scalarFunction(ev, nodes[0]!, variable);
	const a = real(args[2]!, "integrate"), b = real(args[3]!, "integrate");
	const r = integrate(f, a, b);
	if (!Number.isFinite(r)) throw new CalcError("no-converge");
	return fromNumber(Math.abs(r) < 1e-13 ? 0 : r);
}, { special: true });

fn(["diff", "derivative"], 3, 3, (args, ev, nodes) => {
	const variable = nameOf(nodes[1], "diff");
	const f = scalarFunction(ev, nodes[0]!, variable);
	const r = derivative(f, real(args[2]!, "diff"));
	if (!Number.isFinite(r)) throw new CalcError("domain", { fn: "diff" });
	// The stencil leaves ~1e-10 noise: a result that close to a whole number is that number.
	return fromNumber(Math.abs(r - Math.round(r)) < 1e-7 ? Math.round(r) : r);
}, { special: true });

/** Names of the built-in functions (hints, tests, reserved names). */
export function functionNames(): string[] {
	return [...FUNCS.keys()];
}

// ------------------------------------------------------------------------------------------------ names

const CONST_VALUES = new Map<string, () => Value>([
	["pi", () => fromNumber(Math.PI)],
	["π", () => fromNumber(Math.PI)],
	["tau", () => fromNumber(2 * Math.PI)],
	["τ", () => fromNumber(2 * Math.PI)],
	["e", () => fromNumber(Math.E)],
	["phi", () => fromNumber((1 + Math.sqrt(5)) / 2)],
	["φ", () => fromNumber((1 + Math.sqrt(5)) / 2)],
	["i", () => num(cx(0, 1), true)],
	["j", () => num(cx(0, 1), true)],
	["inf", () => fromNumber(Infinity)],
	["∞", () => fromNumber(Infinity)],
]);

/** Constants that cannot be reassigned (`e`, `i` and the physical constants can: they are ordinary names). */
const READ_ONLY = new Set(["pi", "π", "tau", "τ", "inf", "∞"]);

/** Names that cannot be assigned. */
export function isReserved(name: string): boolean {
	return FUNCS.has(name) || ["to", "ans"].includes(name);
}

function unitQuantity(name: string): Quantity | null {
	const u = lookupUnit(name);
	if (!u) return null;
	return unitTimes(num(ONE), new Map([[name, 1]]));
}

/** `a` times one of `unit` (the number is in the unit: 3 km is 3000 m shown in km). */
function unitTimes(a: Quantity, unit: UnitExp): Quantity {
	const info = unitInfo(unit);
	let v = a.v;
	if (info.offset !== undefined) {
		if (isCx(v)) throw new CalcError("complex-units");
		v = toNum(v) * info.scale + info.offset;
	} else v = isCx(v) ? emul(v, info.scale) : rmul(v, exactScale(info.scale));
	return { t: "q", v, dim: addDims(a.dim, info.dim, 1), unit: unit.size === 0 ? a.unit : unit, dec: a.dec };
}

function constantQuantity(name: string): Quantity | null {
	const c = lookupConstant(name);
	if (!c) return null;
	const unit = c.unit === "" ? new Map<string, number>() : parseUnitText(c.unit);
	const info = unitInfo(unit);
	// A constant is a double with the unit of its definition (the display unit is the SI one).
	return { t: "q", v: c.value * info.scale, dim: info.dim, unit: unit.size > 0 ? siUnit(info.dim) : null, dec: true };
}

// ------------------------------------------------------------------------------------------------ evaluation

const STEP_LIMIT = 4_000_000;
const TIME_LIMIT_MS = 2500;
const CALL_DEPTH = 24;

class Evaluator implements Ev {
	steps = 0;
	private readonly started = Date.now();
	private readonly scopes: Array<Map<string, Value>> = [];
	private depth = 0;

	constructor(readonly session: CalcSession) {}

	private tick(): void {
		if (++this.steps > STEP_LIMIT) throw new CalcError("too-many-steps");
		if ((this.steps & 4095) === 0 && Date.now() - this.started > TIME_LIMIT_MS) throw new CalcError("timeout");
	}

	withVar<T>(name: string, run: (set: (x: number) => void) => T): T {
		// The scope stays in use while the function `run` returns is called; `call` drops it when the special form is done.
		const scope = new Map<string, Value>();
		this.scopes.push(scope);
		return run((x) => scope.set(name, fromNumber(x)));
	}

	lookup(name: string): Value {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const v = this.scopes[i]!.get(name);
			if (v) return v;
		}
		if (name === "ans" && this.session.ans) return this.session.ans;
		const v = this.session.vars.get(name);
		if (v) return v;
		const k = CONST_VALUES.get(name);
		if (k) return k();
		const c = constantQuantity(name);
		if (c) return c;
		const u = unitQuantity(name);
		if (u) return u;
		throw new CalcError("unknown-name", { name });
	}

	eval(node: Node): Value {
		this.tick();
		switch (node.k) {
			case "num":
				return num(node.v, node.dec);
			case "name":
				return this.lookup(node.name);
			case "neg":
				return negate(this.eval(node.a));
			case "fact":
				return factorialOf(scalar(this.eval(node.a), "!"));
			case "unit": {
				const a = this.eval(node.a);
				return unitTimes(scalar(a, "unit"), node.unit);
			}
			case "conv":
				return this.convert(this.eval(node.a), node.unit);
			case "bin": {
				const a = this.eval(node.a);
				const b = this.eval(node.b);
				switch (node.op) {
					case "+":
					case "-":
						return addSub(node.op, a, b);
					case "*":
					case "imul":
						return mulDiv("*", a, b);
					case "/":
						return mulDiv("/", a, b);
					case "^":
						return power(a, b);
				}
				break;
			}
			case "mat":
				return this.matrix(node);
			case "eq":
				throw new CalcError("equation-here");
			case "call":
				return this.call(node);
		}
		throw new CalcError("unexpected");
	}

	private convert(v: Value, unit: UnitExp): Value {
		const q = scalar(v, "to");
		const info = unitInfo(unit);
		if (!dimEqual(info.dim, q.dim)) throw new CalcError("convert-mismatch", { from: unitName(q.dim, q.unit), to: formatUnit(unit) || "1" });
		return { ...q, unit: unit.size === 0 ? null : unit };
	}

	private matrix(node: Extract<Node, { k: "mat" }>): Value {
		const rows = node.rows.map((r) => r.map((e) => this.eval(e)));
		// [[1, 2], [3, 4]]: one row made of row vectors stacks them.
		if (rows.length === 1 && rows[0]!.every((v) => v.t === "m")) {
			const ms = rows[0].map((v) => v.m);
			const cols = ms[0]!.cols;
			if (ms.some((m) => m.cols !== cols)) throw new CalcError("matrix-shape");
			const data: Entry[] = [];
			for (const m of ms) data.push(...m.a);
			return matrix(mat(ms.reduce((n, m) => n + m.rows, 0), cols, data), rows[0].some((v) => v.dec));
		}
		const width = rows[0]!.length;
		const data: Entry[] = [];
		let dec = false;
		for (const r of rows) {
			if (r.length !== width) throw new CalcError("matrix-shape");
			for (const v of r) {
				if (v.t !== "q" || !isDimensionless(v.dim) || v.unit) throw new CalcError("matrix-units");
				data.push(v.v);
				dec = dec || v.dec;
			}
		}
		return matrix(mat(rows.length, width, data), dec);
	}

	private call(node: Extract<Node, { k: "call" }>): Value {
		const user = this.session.fns.get(node.name);
		if (user && !this.session.vars.has(node.name)) return this.callUser(node, user);
		const f = FUNCS.get(node.name);
		if (!f) throw new CalcError(this.session.vars.has(node.name) ? "not-a-function" : "unknown-function", { name: node.name }, node.at);
		if (node.args.length < f.min || node.args.length > f.max) {
			throw new CalcError("arity", { name: node.name, min: String(f.min), max: String(f.max === f.min ? f.min : f.max > 100 ? "…" : f.max) });
		}
		const evaluated = f.special ? node.args.map((a, i) => (i < 2 ? ZERO_VALUE : this.eval(a))) : node.args.map((a) => this.eval(a));
		if (f.each && evaluated.length === 1 && evaluated[0]!.t === "m") {
			const m = (evaluated[0] as MatrixValue).m;
			return matrix(mmap(m, (e) => {
				const r = f.f([num(e)], this, node.args);
				if (r.t !== "q") throw new CalcError("need-number", { fn: node.name });
				return r.v;
			}), true);
		}
		const scopeBefore = this.scopes.length;
		try {
			return f.f(evaluated, this, node.args);
		} finally {
			this.scopes.length = scopeBefore;
		}
	}

	private callUser(node: Extract<Node, { k: "call" }>, fnDef: UserFunction): Value {
		if (node.args.length !== fnDef.params.length) {
			throw new CalcError("arity", { name: node.name, min: String(fnDef.params.length), max: String(fnDef.params.length) });
		}
		if (this.depth >= CALL_DEPTH) throw new CalcError("too-deep");
		const args = node.args.map((a) => this.eval(a));
		const scope = new Map<string, Value>();
		fnDef.params.forEach((p, i) => scope.set(p, args[i]!));
		// A function sees its parameters and the global names, never the caller's local ones.
		const saved = this.scopes.splice(0, this.scopes.length, scope);
		this.depth++;
		try {
			return this.eval(fnDef.node);
		} finally {
			this.depth--;
			this.scopes.splice(0, this.scopes.length, ...saved);
		}
	}
}

const ZERO_VALUE: Value = num(ZERO);

// ------------------------------------------------------------------------------------------------ public API

export type CalcResult =
	| { ok: true; kind: "value"; value: Value; node: Node }
	| { ok: true; kind: "assign"; name: string; value: Value; node: Node }
	| { ok: true; kind: "defn"; name: string; params: string[]; body: string; node: Node }
	| { ok: false; code: string; vars: Record<string, string>; at: number };

function context(session: CalcSession): ParseContext {
	return {
		isVar: (name) => session.vars.has(name),
		isFn: (name) => FUNCS.has(name) || session.fns.has(name),
	};
}

/** Evaluates one line against `session`; an assignment or a definition changes the session, and so does the answer (`ans`). */
export function evaluate(src: string, session: CalcSession): CalcResult {
	try {
		const st = parseStatement(src, context(session));
		const ev = new Evaluator(session);
		if (st.k === "defn") {
			if (isReserved(st.name) || session.vars.has(st.name)) throw new CalcError("reserved-name", { name: st.name });
			if (st.params.length > 6) throw new CalcError("too-many-args");
			if (st.params.includes(st.name)) throw new CalcError("reserved-name", { name: st.name });
			if (!session.fns.has(st.name) && session.fns.size + session.vars.size >= MAX_VARS) throw new CalcError("too-many-vars", { max: String(MAX_VARS) });
			// Check the body at once with every parameter bound to 1, so a typo is reported where it is made.
			const probe = new CalcSession();
			for (const [k, v] of session.vars) probe.vars.set(k, v);
			for (const [k, v] of session.fns) probe.fns.set(k, v);
			probe.angle = session.angle;
			const pev = new Evaluator(probe);
			for (const p of st.params) probe.vars.set(p, num(ONE));
			try {
				pev.eval(st.node);
			} catch (e) {
				if (e instanceof CalcError && ["unknown-name", "unknown-function", "syntax"].includes(e.code)) throw e;
			}
			session.fns.set(st.name, { params: st.params, node: st.node, body: st.body });
			return { ok: true, kind: "defn", name: st.name, params: st.params, body: st.body, node: st.node };
		}
		const value = ev.eval(st.node);
		if (st.k === "assign") {
			if (isReserved(st.name) || READ_ONLY.has(st.name)) throw new CalcError("reserved-name", { name: st.name });
			if (!session.vars.has(st.name) && session.fns.size + session.vars.size >= MAX_VARS) throw new CalcError("too-many-vars", { max: String(MAX_VARS) });
			session.fns.delete(st.name);
			session.vars.set(st.name, value);
			session.ans = value;
			return { ok: true, kind: "assign", name: st.name, value, node: st.node };
		}
		session.ans = value;
		return { ok: true, kind: "value", value, node: st.node };
	} catch (e) {
		if (e instanceof CalcError) return { ok: false, code: e.code, vars: { ...e.vars }, at: e.at };
		if (e instanceof RangeError) return { ok: false, code: "too-deep", vars: {}, at: -1 };
		throw e;
	}
}

/** The names a person has defined, in a stable order (variables, then functions). */
export function definedNames(session: CalcSession): string[] {
	return [...session.vars.keys(), ...[...session.fns.keys()].map((n) => `${n}()`)];
}
