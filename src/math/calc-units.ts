/**
 * Units of the advanced calculator (#182): a table of SI and common units with their scale to the SI base units
 * (value in SI = value × scale + offset), SI prefixes, unit expressions ("km/h", "kg*m/s^2") and the symbol to show for a
 * result. Pure: no 'obsidian', no DOM. The dimension vector is the one of `dimensions.ts` (L, M, T, I, Θ, N, J).
 */
import { DIMENSIONLESS, dimEqual, isDimensionless, type Dim } from "./dimensions";
import { CalcError } from "./calc-number";

const d = (l = 0, m = 0, t = 0, i = 0, th = 0, n = 0, j = 0): Dim => [l, m, t, i, th, n, j];

export interface UnitDef {
	dim: Dim;
	/** SI value of one unit (for degC and degF: the size of one degree). */
	scale: number;
	/** SI value of zero of the scale (273.15 for degC). */
	offset?: number;
	prefixable?: boolean;
}

const UNITS = new Map<string, UnitDef>();

function def(names: readonly string[], dim: Dim, scale: number, prefixable = false, offset?: number): void {
	for (const n of names) UNITS.set(n, { dim, scale, prefixable, ...(offset !== undefined ? { offset } : {}) });
}

const L = d(1), M = d(0, 1), T = d(0, 0, 1);
// SI base units (the kilogram is the prefixed gram: the scale of the gram is 1e-3).
def(["m", "metre", "meter"], L, 1, true);
def(["g", "gram"], M, 1e-3, true);
def(["s", "sec"], T, 1, true);
def(["A"], d(0, 0, 0, 1), 1, true);
def(["K"], d(0, 0, 0, 0, 1), 1, true);
def(["mol"], d(0, 0, 0, 0, 0, 1), 1, true);
// Derived units with a name.
def(["N"], d(1, 1, -2), 1, true);
def(["Pa"], d(-1, 1, -2), 1, true);
def(["J"], d(2, 1, -2), 1, true);
def(["W"], d(2, 1, -3), 1, true);
def(["Hz"], d(0, 0, -1), 1, true);
def(["C"], d(0, 0, 1, 1), 1, true);
def(["V"], d(2, 1, -3, -1), 1, true);
def(["ohm", "Ω", "Ω"], d(2, 1, -3, -2), 1, true);
def(["F"], d(-2, -1, 4, 2), 1, true);
def(["H"], d(2, 1, -2, -2), 1, true);
def(["T"], d(0, 1, -2, -1), 1, true);
def(["Wb"], d(2, 1, -2, -1), 1, true);
def(["S"], d(-2, -1, 3, 2), 1, true);
// Length, mass, time, others in common use.
def(["in", "inch"], L, 0.0254);
def(["ft", "foot", "feet"], L, 0.3048);
def(["yd"], L, 0.9144);
def(["mi", "mile"], L, 1609.344);
def(["nmi"], L, 1852);
def(["au"], L, 149597870700);
def(["ly"], L, 9460730472580800);
def(["pc"], L, 3.0856775814913673e16);
def(["Å", "angstrom"], L, 1e-10);
def(["t", "tonne"], M, 1000, true);
def(["lb", "lbs"], M, 0.45359237);
def(["oz"], M, 0.028349523125);
def(["u", "Da"], M, 1.66053906660e-27);
def(["min"], T, 60);
def(["h", "hr", "hour"], T, 3600);
def(["day"], T, 86400);
def(["week"], T, 604800);
def(["yr", "year"], T, 31557600);
def(["L", "l", "litre", "liter"], d(3), 1e-3, true);
def(["gal"], d(3), 3.785411784e-3);
def(["ha"], d(2), 1e4);
def(["acre"], d(2), 4046.8564224);
def(["bar"], d(-1, 1, -2), 1e5, true);
def(["atm"], d(-1, 1, -2), 101325);
def(["psi"], d(-1, 1, -2), 6894.757293168);
def(["mmHg", "torr", "Torr"], d(-1, 1, -2), 133.322387415);
def(["cal"], d(2, 1, -2), 4.184, true);
def(["eV"], d(2, 1, -2), 1.602176634e-19, true);
def(["Wh"], d(2, 1, -2), 3600, true);
def(["BTU"], d(2, 1, -2), 1055.05585262);
def(["hp"], d(2, 1, -3), 745.69987158227022);
def(["mph"], d(1, 0, -1), 0.44704);
def(["kn", "knot"], d(1, 0, -1), 1852 / 3600);
def(["degC", "°C"], d(0, 0, 0, 0, 1), 1, false, 273.15);
def(["degF", "°F"], d(0, 0, 0, 0, 1), 5 / 9, false, 255.3722222222222);
// Angles are dimensionless: the SI value is in radians.
def(["rad"], DIMENSIONLESS, 1, true);
def(["deg", "°"], DIMENSIONLESS, Math.PI / 180);
def(["grad", "gon"], DIMENSIONLESS, Math.PI / 200);
def(["turn", "rev"], DIMENSIONLESS, 2 * Math.PI);

const PREFIXES: ReadonlyArray<readonly [string, number]> = [
	["Y", 1e24], ["Z", 1e21], ["E", 1e18], ["P", 1e15], ["T", 1e12], ["G", 1e9], ["M", 1e6], ["k", 1e3], ["h", 1e2], ["da", 10],
	["d", 1e-1], ["c", 1e-2], ["m", 1e-3], ["µ", 1e-6], ["μ", 1e-6], ["u", 1e-6], ["n", 1e-9], ["p", 1e-12], ["f", 1e-15], ["a", 1e-18], ["z", 1e-21], ["y", 1e-24],
];

/** The unit named `name`, with a prefix when the unit takes one ("km", "mL", "MPa"); null when it is not a unit. */
export function lookupUnit(name: string): UnitDef | null {
	const exact = UNITS.get(name);
	if (exact) return exact;
	for (const [p, f] of PREFIXES) {
		if (!name.startsWith(p) || name.length === p.length) continue;
		const base = UNITS.get(name.slice(p.length));
		if (base?.prefixable && base.offset === undefined) return { dim: base.dim, scale: base.scale * f, prefixable: false };
	}
	return null;
}

export const isUnitName = (name: string): boolean => lookupUnit(name) !== null;

/** Exponents of the named units that make up a quantity's display unit ("km" → 1, "h" → −1). */
export type UnitExp = ReadonlyMap<string, number>;

/** Dimension and SI scale of a product of units. */
export function unitInfo(u: UnitExp): { dim: Dim; scale: number; offset?: number } {
	let dim: Dim = DIMENSIONLESS;
	let scale = 1;
	let offset: number | undefined;
	for (const [name, e] of u) {
		const def = lookupUnit(name);
		if (!def) throw new CalcError("unknown-unit", { name });
		dim = dim.map((x, i) => x + (def.dim[i] ?? 0) * e);
		scale *= Math.pow(def.scale, e);
		if (def.offset !== undefined && u.size === 1 && e === 1) offset = def.offset;
	}
	return offset === undefined ? { dim, scale } : { dim, scale, offset };
}

export function unitMul(a: UnitExp | null, b: UnitExp | null, power = 1): UnitExp | null {
	const out = new Map<string, number>(a ?? []);
	for (const [k, v] of b ?? []) {
		const n = (out.get(k) ?? 0) + v * power;
		if (Math.abs(n) < 1e-12) out.delete(k);
		else out.set(k, n);
	}
	return out.size > 0 ? out : null;
}

export function unitPow(a: UnitExp | null, p: number): UnitExp | null {
	if (!a) return null;
	const out = new Map<string, number>();
	for (const [k, v] of a) out.set(k, v * p);
	return out;
}

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
function superscript(n: number): string {
	if (!Number.isInteger(n)) return `^${n}`;
	const s = String(Math.abs(n)).replace(/\d/g, (c) => SUP[Number(c)]!);
	return (n < 0 ? "⁻" : "") + s;
}

/** "km/h", "m/s²", "kg·m²/s²": positive exponents first, the negative ones after the slash. */
export function formatUnit(u: UnitExp | null): string {
	if (!u) return "";
	const pos: string[] = [];
	const neg: string[] = [];
	for (const [k, v] of u) {
		if (v === 1) pos.push(k);
		else if (v > 0) pos.push(k + superscript(v));
		else if (v === -1) neg.push(k);
		else neg.push(k + superscript(-v));
	}
	if (neg.length === 0) return pos.join("·");
	const den = neg.length > 1 ? `(${neg.join("·")})` : neg[0]!;
	return `${pos.length > 0 ? pos.join("·") : "1"}/${den}`;
}

/** Coherent SI symbols tried for a result with no unit of its own, in this order. */
const NAMED: ReadonlyArray<readonly [string, Dim]> = [
	["N", d(1, 1, -2)], ["Pa", d(-1, 1, -2)], ["J", d(2, 1, -2)], ["W", d(2, 1, -3)], ["C", d(0, 0, 1, 1)], ["V", d(2, 1, -3, -1)],
	["Ω", d(2, 1, -3, -2)], ["F", d(-2, -1, 4, 2)], ["H", d(2, 1, -2, -2)], ["T", d(0, 1, -2, -1)], ["Wb", d(2, 1, -2, -1)], ["S", d(-2, -1, 3, 2)],
];

/** SI base units in the dimension vector's order (length, mass, time, current, temperature, amount, luminous intensity). */
const BASE: readonly string[] = ["m", "kg", "s", "A", "K", "mol", "cd"];
/** The order they are written in: kg·m²/s². */
const WRITE_ORDER: readonly string[] = ["kg", "m", "s", "A", "K", "mol", "cd"];

export const isBaseUnit = (name: string): boolean => BASE.includes(name);

/** The unit to show for an SI value of dimension `dim` that came with no unit of its own. */
export function siUnit(dim: Dim): UnitExp | null {
	if (isDimensionless(dim)) return null;
	for (const [name, nd] of NAMED) if (dimEqual(nd, dim)) return new Map([[name, 1]]);
	const exps = new Map<string, number>();
	dim.forEach((e, i) => {
		if (Math.abs(e) > 1e-12) exps.set(BASE[i]!, e);
	});
	const out = new Map<string, number>();
	for (const name of WRITE_ORDER) {
		const e = exps.get(name);
		if (e !== undefined) out.set(name, e);
	}
	return out;
}

// ------------------------------------------------------------------------------------------------ parsing a unit text

/** Reads a unit expression such as "km/h", "m/s^2", "kg*m/s²", "N·m" or "1/s" into exponents. */
export function parseUnitText(text: string): UnitExp {
	const src = text.trim().replace(/[×·⋅]/g, "*").replace(/\s+/g, " ");
	if (src === "") throw new CalcError("unknown-unit", { name: "" });
	const tokens = src.match(/[\p{L}µ°Ω_]+|\d+|[*/^()\-+ ²³]/gu) ?? [];
	let i = 0;
	const peek = () => tokens[i];
	function atom(): UnitExp | null {
		const t = peek();
		if (t === "(") {
			i++;
			const inner = product();
			if (peek() !== ")") throw new CalcError("unknown-unit", { name: src });
			i++;
			return withPower(inner);
		}
		if (t !== undefined && /^[\p{L}µ°Ω_]/u.test(t)) {
			i++;
			if (!isUnitName(t)) throw new CalcError("unknown-unit", { name: t });
			return withPower(new Map([[t, 1]]));
		}
		if (t === "1") {
			i++;
			return null;
		}
		throw new CalcError("unknown-unit", { name: t ?? src });
	}
	function withPower(u: UnitExp | null): UnitExp | null {
		let t = peek();
		let p: number | null = null;
		if (t === "²") p = 2;
		else if (t === "³") p = 3;
		if (p !== null) {
			i++;
			return unitPow(u, p);
		}
		if (t === "^") {
			i++;
			let sgn = 1;
			t = peek();
			if (t === "-") {
				sgn = -1;
				i++;
			} else if (t === "+") i++;
			const n = peek();
			if (n === undefined || !/^\d+$/.test(n)) throw new CalcError("unknown-unit", { name: src });
			i++;
			return unitPow(u, sgn * Number(n));
		}
		return u;
	}
	function product(): UnitExp | null {
		let acc = atom();
		for (;;) {
			const t = peek();
			if (t === "*" || t === " ") {
				i++;
				if (peek() === undefined || peek() === ")") break;
				if (peek() === " ") continue;
				acc = unitMul(acc, atom());
			} else if (t === "/") {
				i++;
				acc = unitMul(acc, atom(), -1);
			} else break;
		}
		return acc;
	}
	const result = product();
	if (i < tokens.length) throw new CalcError("unknown-unit", { name: src });
	return result ?? new Map();
}
