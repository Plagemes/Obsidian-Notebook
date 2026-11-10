/**
 * Numbers of the advanced calculator (#182): exact rationals (BigInt), doubles, complex numbers and matrices of them.
 * Everything is pure arithmetic on plain data: no 'obsidian', no DOM, no eval. A rational that grows past
 * `MAX_BITS` is an error ("too big"), never a hang, and matrices are limited to `MAX_DIM` per side.
 */

/** Largest numerator or denominator, bits (about 450 digits). */
export const MAX_BITS = 1500;
/** Largest matrix side. */
export const MAX_DIM = 24;
/** Longest list (a matrix with one row or one column). */
export const MAX_LIST = 500;

/** A stable code plus the values the message needs; the UI translates `calc.err.<code>`. */
export class CalcError extends Error {
	constructor(readonly code: string, readonly vars: Readonly<Record<string, string>> = {}, readonly at = -1) {
		super(code);
	}
}

/** An exact rational: `d` > 0 and gcd(n, d) = 1. */
export interface Frac {
	readonly n: bigint;
	readonly d: bigint;
}
/** A real number: exact or a double. */
export type Real = Frac | number;
/** A complex number (always a double pair; a real result collapses to a Real). */
export interface Cx {
	readonly re: number;
	readonly im: number;
}
export type Entry = Real | Cx;

export const isFrac = (v: unknown): v is Frac => typeof v === "object" && v !== null && "n" in v;
export const isCx = (v: unknown): v is Cx => typeof v === "object" && v !== null && "im" in v;

function bitLength(n: bigint): number {
	const a = n < 0n ? -n : n;
	return a === 0n ? 0 : a.toString(16).length * 4;
}

function gcd(a: bigint, b: bigint): bigint {
	let x = a < 0n ? -a : a;
	let y = b < 0n ? -b : b;
	while (y !== 0n) {
		[x, y] = [y, x % y];
	}
	return x;
}

/** A normalised rational. */
export function frac(n: bigint, d: bigint = 1n): Frac {
	if (d === 0n) throw new CalcError("div-zero");
	if (d < 0n) {
		n = -n;
		d = -d;
	}
	const g = gcd(n, d);
	if (g > 1n) {
		n /= g;
		d /= g;
	}
	if (bitLength(n) > MAX_BITS || bitLength(d) > MAX_BITS) throw new CalcError("too-big");
	return { n, d };
}

export const ZERO: Frac = { n: 0n, d: 1n };
export const ONE: Frac = { n: 1n, d: 1n };

/** The double nearest to a rational (also for numerators beyond the double range). */
export function fracToNumber(f: Frac): number {
	const extra = Math.max(0, Math.max(bitLength(f.n), bitLength(f.d)) - 1000);
	if (extra === 0) return Number(f.n) / Number(f.d);
	const s = BigInt(extra);
	const d = f.d >> s;
	return d === 0n ? (f.n < 0n ? -Infinity : Infinity) : Number(f.n >> s) / Number(d);
}

export const toNum = (r: Real): number => (typeof r === "number" ? r : fracToNumber(r));

export function isInteger(r: Real): boolean {
	return typeof r === "number" ? Number.isInteger(r) : r.d === 1n;
}

export function isZero(r: Real): boolean {
	return typeof r === "number" ? r === 0 : r.n === 0n;
}

export function sign(r: Real): number {
	return typeof r === "number" ? Math.sign(r) : r.n < 0n ? -1 : r.n > 0n ? 1 : 0;
}

/** An exact rational from a double that is an integer or has a short exact decimal form; the double itself otherwise. */
export function exactOrNumber(x: number): Real {
	if (Number.isInteger(x) && Math.abs(x) < 2 ** 53) return frac(BigInt(x));
	return x;
}

export const radd = (a: Real, b: Real): Real => (typeof a !== "number" && typeof b !== "number" ? frac(a.n * b.d + b.n * a.d, a.d * b.d) : toNum(a) + toNum(b));
export const rsub = (a: Real, b: Real): Real => (typeof a !== "number" && typeof b !== "number" ? frac(a.n * b.d - b.n * a.d, a.d * b.d) : toNum(a) - toNum(b));
export const rmul = (a: Real, b: Real): Real => (typeof a !== "number" && typeof b !== "number" ? frac(a.n * b.n, a.d * b.d) : toNum(a) * toNum(b));
export function rdiv(a: Real, b: Real): Real {
	if (typeof a !== "number" && typeof b !== "number") {
		if (b.n === 0n) throw new CalcError("div-zero");
		return frac(a.n * b.d, a.d * b.n);
	}
	const y = toNum(b);
	if (y === 0) throw new CalcError("div-zero");
	return toNum(a) / y;
}
export const rneg = (a: Real): Real => (typeof a === "number" ? -a : { n: -a.n, d: a.d });
export const rabs = (a: Real): Real => (typeof a === "number" ? Math.abs(a) : { n: a.n < 0n ? -a.n : a.n, d: a.d });

export function rcmp(a: Real, b: Real): number {
	if (typeof a !== "number" && typeof b !== "number") {
		const l = a.n * b.d;
		const r = b.n * a.d;
		return l < r ? -1 : l > r ? 1 : 0;
	}
	const x = toNum(a), y = toNum(b);
	return x < y ? -1 : x > y ? 1 : 0;
}

/** Integer power by squaring (exact), exponent a plain integer. */
function fracPowInt(base: Frac, e: bigint): Frac {
	if (e < 0n) {
		if (base.n === 0n) throw new CalcError("div-zero");
		return fracPowInt(frac(base.d, base.n), -e);
	}
	if (e > 4000n) throw new CalcError("too-big");
	let result: Frac = ONE;
	let b = base;
	let k = e;
	while (k > 0n) {
		if (k & 1n) result = frac(result.n * b.n, result.d * b.d);
		k >>= 1n;
		if (k > 0n) b = frac(b.n * b.n, b.d * b.d);
	}
	return result;
}

/** Exact integer root of a non-negative integer when it is a perfect power, else null. */
function intRoot(n: bigint, k: number): bigint | null {
	if (n < 2n) return n;
	let lo = 0n;
	let hi = 1n << BigInt(Math.ceil(bitLength(n) / k) + 1);
	const K = BigInt(k);
	while (lo < hi) {
		const mid = (lo + hi + 1n) >> 1n;
		if (mid ** K <= n) lo = mid;
		else hi = mid - 1n;
	}
	return lo ** K === n ? lo : null;
}

/** a^b for reals: exact for a rational base and a small integer exponent, exact for perfect roots, otherwise doubles. A negative base with a fractional exponent returns null (the caller goes complex). */
export function rpow(a: Real, b: Real): Real | null {
	if (typeof a !== "number" && typeof b !== "number") {
		if (b.d === 1n) return fracPowInt(a, b.n);
		if (b.d <= 12n && b.n >= -64n && b.n <= 64n && a.n > 0n) {
			const k = Number(b.d);
			const rn = intRoot(a.n, k);
			const rd = intRoot(a.d, k);
			if (rn !== null && rd !== null) return fracPowInt(frac(rn, rd), b.n);
		}
	}
	const x = toNum(a), y = toNum(b);
	if (x === 0 && y < 0) throw new CalcError("div-zero");
	if (x < 0 && !Number.isInteger(y)) return null;
	return Math.pow(x, y);
}

// ------------------------------------------------------------------------------------------------ complex

export const cx = (re: number, im: number): Cx => ({ re, im });
export const toCx = (e: Entry): Cx => (isCx(e) ? e : { re: toNum(e), im: 0 });
/** A complex number with no imaginary part is a real one; rounding dust (exp(iπ) = −1 + 1.2e-16i) is dropped. */
export function collapse(c: Cx): Real | Cx {
	const big = Math.max(Math.abs(c.re), Math.abs(c.im));
	const re = Math.abs(c.re) < 1e-15 * big ? 0 : c.re;
	const im = Math.abs(c.im) < 1e-15 * big ? 0 : c.im;
	return im === 0 ? re : cx(re, im);
}

export const cadd = (a: Cx, b: Cx): Cx => cx(a.re + b.re, a.im + b.im);
export const csub = (a: Cx, b: Cx): Cx => cx(a.re - b.re, a.im - b.im);
export const cmul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export function cdiv(a: Cx, b: Cx): Cx {
	const d = b.re * b.re + b.im * b.im;
	if (d === 0) throw new CalcError("div-zero");
	return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
}
export const cabs = (a: Cx): number => Math.hypot(a.re, a.im);
export const carg = (a: Cx): number => Math.atan2(a.im, a.re);
export const cexp = (a: Cx): Cx => cx(Math.exp(a.re) * Math.cos(a.im), Math.exp(a.re) * Math.sin(a.im));
export function cln(a: Cx): Cx {
	if (a.re === 0 && a.im === 0) throw new CalcError("domain", { fn: "ln" });
	return cx(Math.log(cabs(a)), carg(a));
}
export function csqrt(a: Cx): Cx {
	const r = cabs(a);
	const re = Math.sqrt((r + a.re) / 2);
	const im = Math.sqrt((r - a.re) / 2);
	return cx(re, a.im < 0 ? -im : im);
}
export function cpow(a: Cx, b: Cx): Cx {
	if (a.re === 0 && a.im === 0) {
		if (b.re === 0 && b.im === 0) return cx(1, 0);
		if (b.re < 0) throw new CalcError("div-zero");
		return cx(0, 0);
	}
	// Small integer powers by multiplication keep (1+2i)^2 = -3+4i exact.
	if (b.im === 0 && Number.isInteger(b.re) && Math.abs(b.re) <= 64) {
		let r = cx(1, 0);
		for (let i = 0; i < Math.abs(b.re); i++) r = cmul(r, a);
		return b.re < 0 ? cdiv(cx(1, 0), r) : r;
	}
	return cexp(cmul(b, cln(a)));
}
export const csin = (a: Cx): Cx => cx(Math.sin(a.re) * Math.cosh(a.im), Math.cos(a.re) * Math.sinh(a.im));
export const ccos = (a: Cx): Cx => cx(Math.cos(a.re) * Math.cosh(a.im), -Math.sin(a.re) * Math.sinh(a.im));

// ------------------------------------------------------------------------------------------------ entries

const toEntry = (c: Cx): Entry => collapse(c);

export function eadd(a: Entry, b: Entry): Entry {
	return isCx(a) || isCx(b) ? toEntry(cadd(toCx(a), toCx(b))) : radd(a, b);
}
export function esub(a: Entry, b: Entry): Entry {
	return isCx(a) || isCx(b) ? toEntry(csub(toCx(a), toCx(b))) : rsub(a, b);
}
export function emul(a: Entry, b: Entry): Entry {
	return isCx(a) || isCx(b) ? toEntry(cmul(toCx(a), toCx(b))) : rmul(a, b);
}
export function ediv(a: Entry, b: Entry): Entry {
	return isCx(a) || isCx(b) ? toEntry(cdiv(toCx(a), toCx(b))) : rdiv(a, b);
}
export const eneg = (a: Entry): Entry => (isCx(a) ? cx(-a.re, -a.im) : rneg(a));
export const eabsNum = (a: Entry): number => (isCx(a) ? cabs(a) : Math.abs(toNum(a)));
export const eIsZero = (a: Entry): boolean => (isCx(a) ? a.re === 0 && a.im === 0 : isZero(a));
export function epow(a: Entry, b: Entry): Entry {
	if (!isCx(a) && !isCx(b)) {
		const r = rpow(a, b);
		if (r !== null) return r;
	}
	return toEntry(cpow(toCx(a), toCx(b)));
}

// ------------------------------------------------------------------------------------------------ matrices

/** A matrix (a list is a 1 × n matrix, a column vector n × 1), row-major. */
export interface Mat {
	readonly rows: number;
	readonly cols: number;
	readonly a: readonly Entry[];
}

export function mat(rows: number, cols: number, a: readonly Entry[]): Mat {
	const list = rows === 1 || cols === 1;
	if (rows < 1 || cols < 1 || (list ? Math.max(rows, cols) > MAX_LIST : rows > MAX_DIM || cols > MAX_DIM)) throw new CalcError("matrix-size", { max: String(list ? MAX_LIST : MAX_DIM) });
	if (a.length !== rows * cols) throw new CalcError("matrix-shape");
	return { rows, cols, a };
}

export const at = (m: Mat, r: number, c: number): Entry => m.a[r * m.cols + c]!;
export const isVector = (m: Mat): boolean => m.rows === 1 || m.cols === 1;

export function mmap(m: Mat, f: (e: Entry) => Entry): Mat {
	return mat(m.rows, m.cols, m.a.map(f));
}

export function mzip(x: Mat, y: Mat, f: (a: Entry, b: Entry) => Entry): Mat {
	if (x.rows !== y.rows || x.cols !== y.cols) throw new CalcError("matrix-shape");
	return mat(x.rows, x.cols, x.a.map((e, i) => f(e, y.a[i]!)));
}

export function mmul(x: Mat, y: Mat): Mat {
	if (x.cols !== y.rows) throw new CalcError("matrix-shape");
	const out: Entry[] = [];
	for (let i = 0; i < x.rows; i++) {
		for (let j = 0; j < y.cols; j++) {
			let s: Entry = ZERO;
			for (let k = 0; k < x.cols; k++) s = eadd(s, emul(at(x, i, k), at(y, k, j)));
			out.push(s);
		}
	}
	return mat(x.rows, y.cols, out);
}

export function transpose(m: Mat): Mat {
	const out: Entry[] = [];
	for (let j = 0; j < m.cols; j++) for (let i = 0; i < m.rows; i++) out.push(at(m, i, j));
	return mat(m.cols, m.rows, out);
}

export function identity(n: number): Mat {
	const out: Entry[] = [];
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push(i === j ? ONE : ZERO);
	return mat(n, n, out);
}

/** Gauss-Jordan elimination on `m` | `rhs`; returns the determinant and the reduced right-hand side (null when singular). */
function eliminate(m: Mat, rhs: Mat | null): { det: Entry; inv: Mat | null } {
	if (m.rows !== m.cols) throw new CalcError("matrix-square");
	const n = m.rows;
	const A: Entry[][] = [];
	for (let i = 0; i < n; i++) A.push(Array.from({ length: n }, (_, j) => at(m, i, j)));
	const B: Entry[][] = [];
	if (rhs) for (let i = 0; i < n; i++) B.push(Array.from({ length: rhs.cols }, (_, j) => at(rhs, i, j)));
	let det: Entry = ONE;
	let scale = 0;
	for (const e of m.a) scale = Math.max(scale, eabsNum(e));
	for (let col = 0; col < n; col++) {
		let p = -1;
		let best = 0;
		for (let r = col; r < n; r++) {
			const v = eabsNum(A[r]![col]!);
			if (v > best) {
				best = v;
				p = r;
			}
		}
		const exact = A.every((row) => row.every((e) => !isCx(e) && typeof e !== "number"));
		if (p < 0 || (!exact && best <= 1e-12 * scale)) return { det: ZERO, inv: null };
		if (p !== col) {
			[A[p], A[col]] = [A[col]!, A[p]!];
			if (rhs) [B[p], B[col]] = [B[col]!, B[p]!];
			det = eneg(det);
		}
		const pivot = A[col]![col]!;
		det = emul(det, pivot);
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = ediv(A[r]![col]!, pivot);
			if (eIsZero(f)) continue;
			for (let c = col; c < n; c++) A[r]![c] = esub(A[r]![c]!, emul(f, A[col]![c]!));
			if (rhs) for (let c = 0; c < rhs.cols; c++) B[r]![c] = esub(B[r]![c]!, emul(f, B[col]![c]!));
		}
	}
	if (!rhs) return { det, inv: null };
	const out: Entry[] = [];
	for (let i = 0; i < n; i++) for (let j = 0; j < rhs.cols; j++) out.push(ediv(B[i]![j]!, A[i]![i]!));
	return { det, inv: mat(n, rhs.cols, out) };
}

export function determinant(m: Mat): Entry {
	return eliminate(m, null).det;
}

export function inverse(m: Mat): Mat {
	const r = eliminate(m, identity(m.rows));
	if (!r.inv) throw new CalcError("matrix-singular");
	return r.inv;
}

/** Solves A·X = B (square A). */
export function solveLinear(a: Mat, b: Mat): Mat {
	if (a.rows !== b.rows) throw new CalcError("matrix-shape");
	const r = eliminate(a, b);
	if (!r.inv) throw new CalcError("matrix-singular");
	return r.inv;
}

export function mpow(m: Mat, k: number): Mat {
	if (m.rows !== m.cols) throw new CalcError("matrix-square");
	if (!Number.isInteger(k) || Math.abs(k) > 1000) throw new CalcError("matrix-power");
	let base = k < 0 ? inverse(m) : m;
	let e = Math.abs(k);
	let result = identity(m.rows);
	while (e > 0) {
		if (e & 1) result = mmul(result, base);
		e = Math.floor(e / 2);
		if (e > 0) base = mmul(base, base);
	}
	return result;
}

export function cross(x: Mat, y: Mat): Mat {
	if (!isVector(x) || !isVector(y) || x.a.length !== 3 || y.a.length !== 3) throw new CalcError("cross-size");
	const [a1, a2, a3] = x.a as [Entry, Entry, Entry];
	const [b1, b2, b3] = y.a as [Entry, Entry, Entry];
	const out = [esub(emul(a2, b3), emul(a3, b2)), esub(emul(a3, b1), emul(a1, b3)), esub(emul(a1, b2), emul(a2, b1))];
	return x.cols === 1 ? mat(3, 1, out) : mat(1, 3, out);
}

export function dot(x: Mat, y: Mat): Entry {
	if (!isVector(x) || !isVector(y) || x.a.length !== y.a.length) throw new CalcError("matrix-shape");
	let s: Entry = ZERO;
	for (let i = 0; i < x.a.length; i++) s = eadd(s, emul(x.a[i]!, y.a[i]!));
	return s;
}
