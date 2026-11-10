/**
 * Parser of the advanced calculator (#182): a hand-written tokenizer and recursive-descent parser. It produces a syntax
 * tree only; nothing is looked up by name here except to tell units from variables (the caller says which names are its
 * variables and functions). No eval, no Function: the tree is walked by calc.ts over fixed tables.
 *
 * Grammar (loosest first): `name = expr` (variable), `f(x, y) = expr` (function), `expr to unit`, `+ -`, `* / × ÷ ·` and
 * implicit multiplication (`2x`, `3(1+2)`, `2 pi`), unary signs, `^` (right-associative, also `²` `³`), postfix `!`,
 * numbers with an optional unit (`3 km/h`, `9.8 m/s^2`), names, calls `f(a, b)`, matrices `[1, 2; 3, 4]` and `√x`.
 * After a number, a name that is a unit reads as a unit (`3 g` is three grams); a name that is also a constant keeps
 * its constant meaning after `*` (`m*g` is mass times gravity, `5 kg*g` too).
 */
import { CalcError, frac, type Real } from "./calc-number";
import { unitMul, unitPow, isUnitName, type UnitExp } from "./calc-units";
import { lookupConstant } from "./calc-constants";

export type Node =
	| { k: "num"; v: Real; dec: boolean; src: string }
	| { k: "name"; name: string }
	| { k: "neg"; a: Node }
	| { k: "bin"; op: "+" | "-" | "*" | "/" | "^" | "imul"; a: Node; b: Node }
	| { k: "fact"; a: Node }
	| { k: "call"; name: string; args: Node[]; at: number }
	| { k: "mat"; rows: Node[][] }
	| { k: "unit"; a: Node; unit: UnitExp; text: string }
	| { k: "conv"; a: Node; unit: UnitExp; text: string }
	| { k: "eq"; a: Node; b: Node };

export type Statement =
	| { k: "expr"; node: Node }
	| { k: "assign"; name: string; node: Node }
	| { k: "defn"; name: string; params: string[]; node: Node; body: string };

/** Longest accepted input, characters. */
export const CALC_MAX = 1000;
const MAX_DEPTH = 50;
const MAX_TOKENS = 1200;

/** What the parser needs to know about the caller's names. */
export interface ParseContext {
	/** A variable the person defined (it shadows units and constants). */
	isVar(name: string): boolean;
	/** A function the person defined, or a built-in one. */
	isFn(name: string): boolean;
}

type Tok =
	| { t: "num"; v: string; at: number }
	| { t: "id"; v: string; at: number }
	| { t: "op"; v: string; at: number }
	| { t: "end"; at: number };

const SUPER = "⁰¹²³⁴⁵⁶⁷⁸⁹";

function isLetter(ch: string): boolean {
	return /[\p{L}_°µΩ]/u.test(ch);
}

export function tokenize(src: string): Tok[] {
	if (src.length > CALC_MAX) throw new CalcError("too-long", { max: String(CALC_MAX) });
	const chars = Array.from(src);
	const out: Tok[] = [];
	let i = 0;
	let at = 0;
	const peek = (k = 0) => chars[i + k] ?? "";
	const step = (n = 1) => {
		for (let k = 0; k < n; k++) at += (chars[i + k] ?? "").length;
		i += n;
	};
	while (i < chars.length) {
		if (out.length > MAX_TOKENS) throw new CalcError("too-long", { max: String(CALC_MAX) });
		const ch = chars[i]!;
		const start = at;
		if (/\s/u.test(ch)) {
			step();
			continue;
		}
		if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(peek(1)))) {
			let s = "";
			const digits = () => {
				while (/[0-9]/.test(peek())) {
					s += peek();
					step();
				}
			};
			digits();
			if (peek() === ".") {
				s += ".";
				step();
				digits();
			}
			// An exponent only when digits follow ("2e" is 2·e, "2eV" is 2 electronvolts).
			if ((peek() === "e" || peek() === "E") && (/[0-9]/.test(peek(1)) || (/[+\-−]/.test(peek(1)) && /[0-9]/.test(peek(2))))) {
				s += "e";
				step();
				if (/[+\-−]/.test(peek())) {
					s += peek() === "+" ? "+" : "-";
					step();
				}
				digits();
			}
			out.push({ t: "num", v: s, at: start });
			continue;
		}
		if (SUPER.includes(ch) || ch === "⁻") {
			let neg = false;
			if (ch === "⁻") {
				neg = true;
				step();
			}
			let s = "";
			while (SUPER.includes(peek()) && peek() !== "") {
				s += String(SUPER.indexOf(peek()));
				step();
			}
			if (s === "") throw new CalcError("bad-char", { ch }, start);
			out.push({ t: "op", v: "^", at: start });
			if (neg) out.push({ t: "op", v: "-", at: start });
			out.push({ t: "num", v: s, at: start });
			continue;
		}
		if (isLetter(ch)) {
			let s = "";
			while (peek() !== "" && (isLetter(peek()) || /[0-9]/.test(peek()))) {
				s += peek();
				step();
			}
			out.push({ t: "id", v: s, at: start });
			continue;
		}
		const two = ch + peek(1);
		if (two === "**") {
			step(2);
			out.push({ t: "op", v: "^", at: start });
			continue;
		}
		if (two === "->") {
			step(2);
			out.push({ t: "id", v: "to", at: start });
			continue;
		}
		if (two === "==") {
			step(2);
			out.push({ t: "op", v: "=", at: start });
			continue;
		}
		const alias: Record<string, string> = { "−": "-", "–": "-", "×": "*", "·": "*", "⋅": "*", "∙": "*", "÷": "/", "→": "to", "{": "(", "}": ")" };
		const op = alias[ch] ?? ch;
		if (op === "to") {
			step();
			out.push({ t: "id", v: "to", at: start });
			continue;
		}
		if ("+-*/^()[],;=!√".includes(op)) {
			step();
			out.push({ t: "op", v: op, at: start });
			continue;
		}
		throw new CalcError("bad-char", { ch }, start);
	}
	out.push({ t: "end", at });
	return out;
}

/** A decimal literal as an exact rational ("12.5", "1e-3"); doubles beyond a sane exponent. */
export function literal(text: string): { v: Real; dec: boolean } {
	const m = /^(\d*)\.?(\d*)(?:e([+-]?\d+))?$/.exec(text);
	if (!m) throw new CalcError("bad-number", { text });
	const intPart = m[1] ?? "";
	const fracPart = m[2] ?? "";
	const exp = m[3] ? Number(m[3]) : 0;
	const dec = text.includes(".") || m[3] !== undefined;
	const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "") || "0";
	const scale = exp - fracPart.length;
	if (digits.length > 400 || Math.abs(scale) > 300) return { v: Number(text), dec };
	const n = BigInt(digits);
	return { v: scale >= 0 ? frac(n * 10n ** BigInt(scale)) : frac(n, 10n ** BigInt(-scale)), dec };
}

const RESERVED = new Set(["to"]);

class Parser {
	private i = 0;
	private depth = 0;

	constructor(private readonly src: string, private readonly toks: Tok[], private readonly ctx: ParseContext) {}

	private get tok(): Tok {
		return this.toks[this.i]!;
	}

	private peekTok(k = 1): Tok {
		return this.toks[Math.min(this.i + k, this.toks.length - 1)]!;
	}

	private isOp(v: string, k = 0): boolean {
		const t = this.peekTok(k);
		return t.t === "op" && t.v === v;
	}

	private fail(code: string, vars: Record<string, string> = {}): never {
		throw new CalcError(code, vars, this.tok.at);
	}

	private enter(): void {
		if (++this.depth > MAX_DEPTH) this.fail("too-deep");
	}

	statement(): Statement {
		const t0 = this.tok;
		if (t0.t === "end") this.fail("empty");
		if (t0.t === "id" && !RESERVED.has(t0.v) && this.isOp("=", 1) && !this.isOp("=", 2)) {
			this.i += 2;
			const node = this.convert();
			this.expectEnd();
			return { k: "assign", name: t0.v, node };
		}
		if (t0.t === "id" && this.isOp("(", 1)) {
			const params = this.paramList();
			if (params) {
				const bodyStart = this.toks[this.i]!.at;
				const node = this.convert();
				this.expectEnd();
				return { k: "defn", name: t0.v, params, node, body: this.src.slice(bodyStart).trim() };
			}
		}
		const node = this.convert();
		this.expectEnd();
		return { k: "expr", node };
	}

	/** `f(a, b) =` at the start: consumes through the `=` and returns the parameters; otherwise leaves the position alone. */
	private paramList(): string[] | null {
		let j = this.i + 2;
		const names: string[] = [];
		for (;;) {
			const t = this.toks[j];
			if (t?.t === "op" && t.v === ")") {
				j++;
				break;
			}
			if (names.length > 0) {
				if (!(t?.t === "op" && t.v === ",")) return null;
				j++;
			}
			const n = this.toks[j];
			if (n?.t !== "id" || RESERVED.has(n.v)) return null;
			names.push(n.v);
			j++;
		}
		const eq = this.toks[j];
		const eq2 = this.toks[j + 1];
		if (!(eq?.t === "op" && eq.v === "=") || (eq2?.t === "op" && eq2.v === "=")) return null;
		this.i = j + 1;
		return names;
	}

	private expectEnd(): void {
		const t = this.tok;
		if (t.t !== "end") {
			if (t.t === "op" && t.v === ")") this.fail("paren-close");
			this.fail("unexpected", { text: t.v });
		}
	}

	/** expr [to unit] */
	private convert(): Node {
		let node = this.sum();
		while (this.tok.t === "id" && this.tok.v === "to") {
			this.i++;
			const u = this.unitStrict();
			node = { k: "conv", a: node, unit: u.unit, text: u.text };
		}
		return node;
	}

	private sum(): Node {
		let a = this.product();
		for (;;) {
			const t = this.tok;
			if (t.t === "op" && (t.v === "+" || t.v === "-")) {
				this.i++;
				a = { k: "bin", op: t.v, a, b: this.product() };
			} else return a;
		}
	}

	private startsPrimary(): boolean {
		const t = this.tok;
		if (t.t === "num") return true;
		if (t.t === "id") return !RESERVED.has(t.v);
		return t.t === "op" && (t.v === "(" || t.v === "[" || t.v === "√");
	}

	private product(): Node {
		let a = this.unary();
		for (;;) {
			const t = this.tok;
			if (t.t === "op" && (t.v === "*" || t.v === "/")) {
				this.i++;
				a = { k: "bin", op: t.v, a, b: this.unary() };
			} else if (this.startsPrimary()) {
				a = { k: "bin", op: "imul", a, b: this.unary() };
			} else return a;
		}
	}

	private unary(): Node {
		const t = this.tok;
		if (t.t === "op" && (t.v === "-" || t.v === "+")) {
			this.enter();
			this.i++;
			const a = this.unary();
			this.depth--;
			return t.v === "-" ? { k: "neg", a } : a;
		}
		return this.power();
	}

	private power(): Node {
		const base = this.postfix();
		if (this.isOp("^")) {
			this.i++;
			this.enter();
			// The exponent may carry a sign: 2^-3.
			const exp = this.tok.t === "op" && (this.tok.v === "-" || this.tok.v === "+") ? this.unary() : this.power();
			this.depth--;
			return { k: "bin", op: "^", a: base, b: exp };
		}
		return base;
	}

	private postfix(): Node {
		let a = this.primary();
		while (this.isOp("!") && !this.isOp("=", 1)) {
			this.i++;
			a = { k: "fact", a };
		}
		return a;
	}

	private primary(): Node {
		const t = this.tok;
		this.enter();
		try {
			if (t.t === "num") {
				this.i++;
				const { v, dec } = literal(t.v);
				const num: Node = { k: "num", v, dec, src: t.v };
				return this.withUnit(num);
			}
			if (t.t === "op" && t.v === "√") {
				this.i++;
				const arg = this.power();
				return { k: "call", name: "sqrt", args: [arg], at: t.at };
			}
			if (t.t === "op" && t.v === "(") {
				this.i++;
				const inner = this.convert();
				if (!this.isOp(")")) this.fail("paren-open");
				this.i++;
				return inner;
			}
			if (t.t === "op" && t.v === "[") return this.matrix();
			if (t.t === "id" && !RESERVED.has(t.v)) {
				this.i++;
				if (this.isOp("(") && (this.ctx.isFn(t.v) || !this.ctx.isVar(t.v))) {
					this.i++;
					const args: Node[] = [];
					if (!this.isOp(")")) {
						for (;;) {
							args.push(this.argument());
							if (this.isOp(",")) {
								this.i++;
								continue;
							}
							break;
						}
					}
					if (!this.isOp(")")) this.fail("paren-open");
					this.i++;
					if (args.length > 12) this.fail("too-many-args");
					return { k: "call", name: t.v, args, at: t.at };
				}
				return { k: "name", name: t.v };
			}
			if (t.t === "end") this.fail("incomplete");
			this.fail("unexpected", { text: "v" in t ? t.v : "" });
		} finally {
			this.depth--;
		}
	}

	/** One argument of a call: an expression, or `lhs = rhs` (an equation for solve). */
	private argument(): Node {
		const a = this.convert();
		if (this.isOp("=")) {
			this.i++;
			return { k: "eq", a, b: this.convert() };
		}
		return a;
	}

	private matrix(): Node {
		this.i++;
		const rows: Node[][] = [[]];
		if (this.isOp("]")) this.fail("empty-matrix");
		for (;;) {
			rows[rows.length - 1]!.push(this.convert());
			if (this.isOp(",")) {
				this.i++;
				continue;
			}
			if (this.isOp(";")) {
				this.i++;
				rows.push([]);
				continue;
			}
			break;
		}
		if (!this.isOp("]")) this.fail("bracket-open");
		this.i++;
		return { k: "mat", rows };
	}

	// -------------------------------------------------------------------------------------------- units

	/** The token at `idx` reads as a unit here: a unit name that is not the person's variable, not a function being called, and (unless `allowConstants`) not a constant. */
	private isUnitTok(t: Tok, allowConstants: boolean): boolean {
		if (t.t !== "id" || RESERVED.has(t.v) || !isUnitName(t.v) || this.ctx.isVar(t.v)) return false;
		if (!allowConstants && lookupConstant(t.v)) return false;
		const idx = this.toks.indexOf(t);
		const after = this.toks[idx + 1];
		return !(after?.t === "op" && after.v === "(" && this.ctx.isFn(t.v));
	}

	/** A number followed by a unit expression: `3 km/h`, `9.8 m/s^2`, `2 h 30 min`? (no: one unit expression per number). */
	private withUnit(num: Node): Node {
		if (!this.isUnitTok(this.tok, true)) return num;
		const start = this.tok.at;
		const unit = this.unitProduct(false);
		return { k: "unit", a: num, unit: unit ?? new Map(), text: this.src.slice(start, this.lastEnd()).trim() };
	}

	private lastEnd(): number {
		const next = this.toks[this.i]!;
		return next.t === "end" ? this.src.length : next.at;
	}

	/** After `to`: every name must be a unit. */
	private unitStrict(): { unit: UnitExp; text: string } {
		const start = this.tok.at;
		const unit = this.unitProduct(true);
		if (unit === undefined) this.fail("unit-expected");
		return { unit: unit ?? new Map(), text: this.src.slice(start, this.lastEnd()).trim() };
	}

	private unitAtom(strict: boolean): UnitExp | null | undefined {
		const t = this.tok;
		if (t.t === "op" && t.v === "(") {
			const inner = this.toks[this.i + 1];
			if (inner && (this.isUnitTok(inner, true) || (inner.t === "num" && inner.v === "1"))) {
				this.i++;
				const u = this.unitProduct(true);
				if (!this.isOp(")")) this.fail("paren-open");
				this.i++;
				return this.unitPower(u ?? null);
			}
			return undefined;
		}
		if (t.t === "num" && t.v === "1" && strict) {
			this.i++;
			return null;
		}
		if (t.t === "id" && !RESERVED.has(t.v)) {
			if (!isUnitName(t.v) || (!strict && this.ctx.isVar(t.v))) {
				if (strict) this.fail("unknown-unit", { name: t.v });
				return undefined;
			}
			this.i++;
			return this.unitPower(new Map([[t.v, 1]]));
		}
		return undefined;
	}

	private unitPower(u: UnitExp | null): UnitExp | null {
		if (!this.isOp("^")) return u;
		let j = this.i + 1;
		let sgn = 1;
		const s = this.toks[j];
		if (s?.t === "op" && (s.v === "-" || s.v === "+")) {
			sgn = s.v === "-" ? -1 : 1;
			j++;
		}
		const n = this.toks[j];
		if (n?.t !== "num") return u;
		const p = Number(n.v);
		if (!Number.isFinite(p) || Math.abs(p) > 12) this.fail("bad-exponent");
		this.i = j + 1;
		return unitPow(u, sgn * p);
	}

	/**
	 * `km/h`, `kg*m/s^2`, `W/(m^2*K)`. In the lenient form (after a number) a name that is a variable ends it, and `*`
	 * only continues with a unit that is not also a constant. Returns undefined when no unit could be read.
	 */
	private unitProduct(strict: boolean): UnitExp | null | undefined {
		let acc = this.unitAtom(strict);
		if (acc === undefined) return undefined;
		for (;;) {
			const t = this.tok;
			if (t.t === "op" && t.v === "/") {
				const save = this.i;
				this.i++;
				const next = this.unitAtom(strict);
				if (next === undefined) {
					this.i = save;
					return acc;
				}
				acc = unitMul(acc, next, -1);
			} else if (t.t === "op" && t.v === "*") {
				const nextTok = this.peekTok();
				if (!strict && !this.isUnitTok(nextTok, false)) return acc;
				if (strict && !(nextTok.t === "id" || (nextTok.t === "op" && nextTok.v === "("))) return acc;
				const save = this.i;
				this.i++;
				const next = this.unitAtom(strict);
				if (next === undefined) {
					this.i = save;
					return acc;
				}
				acc = unitMul(acc, next);
			} else if (t.t === "id" && (strict ? isUnitName(t.v) : this.isUnitTok(t, false))) {
				const next = this.unitAtom(strict);
				if (next === undefined) return acc;
				acc = unitMul(acc, next);
			} else return acc;
		}
	}
}

/** Reads one statement. */
export function parseStatement(src: string, ctx: ParseContext): Statement {
	return new Parser(src, tokenize(src), ctx).statement();
}

/** Walks a tree (children first) and lists the names it uses. */
export function namesIn(node: Node, out = new Set<string>()): Set<string> {
	switch (node.k) {
		case "name":
			out.add(node.name);
			break;
		case "neg":
		case "fact":
		case "unit":
		case "conv":
			namesIn(node.a, out);
			break;
		case "bin":
		case "eq":
			namesIn(node.a, out);
			namesIn(node.b, out);
			break;
		case "call":
			for (const a of node.args) namesIn(a, out);
			break;
		case "mat":
			for (const r of node.rows) for (const e of r) namesIn(e, out);
			break;
		default:
			break;
	}
	return out;
}
