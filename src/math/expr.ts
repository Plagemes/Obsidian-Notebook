/**
 * Safe maths expressions for function graphs (#113). A small hand-written tokenizer and Pratt parser produce a syntax
 * tree; `compile` turns it into nested closures over a fixed list of variable slots. Names resolve only through the
 * tables below (Maps created here) and the caller's variables and parameters: there is no eval, no Function, no
 * property access, so an expression cannot reach any global or object of the page. Pure: no 'obsidian', no DOM.
 *
 * Grammar: numbers (`2`, `0.5`, `.5`, `1e-3`), `+ - * / ^` (also `− × · ÷ **`), parentheses and brackets, `|x|`,
 * postfix `!`, implicit multiplication (`2x`, `3(x+1)`, `(x+1)(x-1)`, `2 sin x`, `ax` when `a` is a parameter),
 * function calls with or without parentheses (`sin(x)`, `sin x`, `sin 2x` = sin(2x)), comparisons
 * (`< <= > >= = == != ≤ ≥ ≠`, chains such as `0 < x < 1`) and `and`/`or`/`not` (also `&& || !`) for conditions.
 */

export type Node =
	| { k: "num"; v: number }
	| { k: "var"; name: string }
	| { k: "neg"; a: Node }
	| { k: "not"; a: Node }
	| { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
	| { k: "cmp"; op: "<" | "<=" | ">" | ">=" | "=" | "!="; a: Node; b: Node }
	| { k: "and" | "or"; a: Node; b: Node }
	| { k: "fact"; a: Node }
	| { k: "call"; name: string; args: Node[] };

/** Longest accepted expression, characters. */
export const EXPR_MAX = 1000;
/** Deepest accepted nesting (parentheses, powers, unary signs): a hostile expression cannot overflow the stack. */
const MAX_DEPTH = 60;

export class ExprError extends Error {
	constructor(message: string, readonly at: number) {
		super(message);
	}
}

type Fn = { arity: number | "variadic"; min?: number; trig?: "in" | "out"; f: (...a: number[]) => number };

const DEG = Math.PI / 180;

function factorial(n: number): number {
	if (!Number.isFinite(n) || n < 0 || n !== Math.floor(n)) return gamma(n + 1);
	if (n > 170) return Infinity;
	let r = 1;
	for (let i = 2; i <= n; i++) r *= i;
	return r;
}

/** Lanczos approximation (g = 7), for non-integer factorials. */
function gamma(z: number): number {
	if (!Number.isFinite(z)) return NaN;
	if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
	const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
		12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
	const x = z - 1;
	let a = c[0]!;
	const t = x + 7.5;
	for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
	return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

const FUNCTIONS: ReadonlyMap<string, Fn> = new Map<string, Fn>([
	["sin", { arity: 1, trig: "in", f: Math.sin }],
	["cos", { arity: 1, trig: "in", f: Math.cos }],
	["tan", { arity: 1, trig: "in", f: Math.tan }],
	["cot", { arity: 1, trig: "in", f: (x) => 1 / Math.tan(x) }],
	["sec", { arity: 1, trig: "in", f: (x) => 1 / Math.cos(x) }],
	["csc", { arity: 1, trig: "in", f: (x) => 1 / Math.sin(x) }],
	["asin", { arity: 1, trig: "out", f: Math.asin }],
	["acos", { arity: 1, trig: "out", f: Math.acos }],
	["atan", { arity: 1, trig: "out", f: Math.atan }],
	["arcsin", { arity: 1, trig: "out", f: Math.asin }],
	["arccos", { arity: 1, trig: "out", f: Math.acos }],
	["arctan", { arity: 1, trig: "out", f: Math.atan }],
	["atan2", { arity: 2, trig: "out", f: Math.atan2 }],
	["sinh", { arity: 1, f: Math.sinh }],
	["cosh", { arity: 1, f: Math.cosh }],
	["tanh", { arity: 1, f: Math.tanh }],
	["asinh", { arity: 1, f: Math.asinh }],
	["acosh", { arity: 1, f: Math.acosh }],
	["atanh", { arity: 1, f: Math.atanh }],
	["sqrt", { arity: 1, f: Math.sqrt }],
	["cbrt", { arity: 1, f: Math.cbrt }],
	["root", { arity: 2, f: (n, x) => (x < 0 && Math.abs(n % 2) === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)) }],
	["exp", { arity: 1, f: Math.exp }],
	["ln", { arity: 1, f: Math.log }],
	["log", { arity: "variadic", min: 1, f: (a, b) => (b === undefined ? Math.log10(a) : Math.log(b) / Math.log(a)) }],
	["log2", { arity: 1, f: Math.log2 }],
	["log10", { arity: 1, f: Math.log10 }],
	["abs", { arity: 1, f: Math.abs }],
	["sign", { arity: 1, f: Math.sign }],
	["sgn", { arity: 1, f: Math.sign }],
	["floor", { arity: 1, f: Math.floor }],
	["ceil", { arity: 1, f: Math.ceil }],
	["round", { arity: 1, f: Math.round }],
	["min", { arity: "variadic", min: 1, f: Math.min }],
	["max", { arity: "variadic", min: 1, f: Math.max }],
	["mod", { arity: 2, f: (a, b) => a - b * Math.floor(a / b) }],
	["hypot", { arity: "variadic", min: 1, f: Math.hypot }],
	["gamma", { arity: 1, f: gamma }],
]);

const CONSTANTS: ReadonlyMap<string, number> = new Map([
	["pi", Math.PI], ["π", Math.PI], ["tau", 2 * Math.PI], ["τ", 2 * Math.PI], ["e", Math.E],
	["inf", Infinity], ["infinity", Infinity], ["∞", Infinity],
]);

/** Words of the language: never a parameter name. */
const KEYWORDS = new Set(["and", "or", "not", "theta", "θ"]);

/** Names an expression may not use for a parameter (functions, constants, keywords and the graph variables). */
export function isReservedName(name: string): boolean {
	return FUNCTIONS.has(name) || CONSTANTS.has(name) || KEYWORDS.has(name) || ["x", "y", "t", "r"].includes(name);
}

/** Built-in function names (for the editor's hints). */
export function functionNames(): string[] {
	return [...FUNCTIONS.keys()];
}

type Tok =
	| { t: "num"; v: number; at: number }
	| { t: "id"; v: string; at: number }
	| { t: "op"; v: string; at: number }
	| { t: "end"; at: number };

const OP_ALIASES: ReadonlyMap<string, string> = new Map([
	["−", "-"], ["×", "*"], ["·", "*"], ["⋅", "*"], ["÷", "/"], ["≤", "<="], ["≥", ">="], ["≠", "!="], ["==", "="], ["**", "^"],
	["&&", "and"], ["||", "or"], ["[", "("], ["]", ")"],
]);

function isLetter(ch: string): boolean {
	return /\p{L}/u.test(ch) || ch === "_" || ch === "∞";
}

function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	const chars = Array.from(src);
	let i = 0;
	let at = 0;
	const peek = (k = 0) => chars[i + k] ?? "";
	while (i < chars.length) {
		const ch = chars[i]!;
		const start = at;
		const step = (n: number) => {
			for (let k = 0; k < n; k++) at += chars[i + k]!.length;
			i += n;
		};
		if (/\s/u.test(ch)) {
			step(1);
			continue;
		}
		if (/[0-9.]/.test(ch)) {
			let s = "";
			const take = (text: string) => {
				s += text;
				step(1);
			};
			const digits = () => {
				while (/[0-9]/.test(peek())) take(peek());
			};
			digits();
			if (peek() === "." && (s.length > 0 || /[0-9]/.test(peek(1)))) {
				take(".");
				digits();
			}
			if (s === "" || s === ".") throw new ExprError("unexpected '.'", start);
			// An exponent only when digits follow ("2e" is 2·e).
			if ((peek() === "e" || peek() === "E") && (/[0-9]/.test(peek(1)) || (/[+\-−]/.test(peek(1)) && /[0-9]/.test(peek(2))))) {
				take("e");
				if (/[+\-−]/.test(peek())) take(peek() === "+" ? "+" : "-");
				digits();
			}
			out.push({ t: "num", v: Number(s), at: start });
			continue;
		}
		if (isLetter(ch)) {
			let s = "";
			while (peek() && (isLetter(peek()) || /[0-9]/.test(peek()))) {
				s += peek();
				step(1);
			}
			out.push({ t: "id", v: s, at: start });
			continue;
		}
		const two = ch + peek(1);
		if (["<=", ">=", "!=", "==", "**", "&&", "||"].includes(two)) {
			step(2);
			const v = OP_ALIASES.get(two) ?? two;
			out.push(v === "and" || v === "or" ? { t: "id", v, at: start } : { t: "op", v, at: start });
			continue;
		}
		if ("+-*/^()<>=,|!".includes(ch) || OP_ALIASES.has(ch) || ch === "√") {
			step(1);
			out.push({ t: "op", v: OP_ALIASES.get(ch) ?? ch, at: start });
			continue;
		}
		throw new ExprError(`unexpected '${ch}'`, start);
	}
	out.push({ t: "end", at });
	return out;
}

export interface ParseOptions {
	/** Names that are variables or parameters (e.g. x, y, t, θ, a). Everything else must be a function or a constant. */
	names: ReadonlySet<string>;
}

/** Splits an unknown identifier into known names ("ax" → a·x, "sinx" → sin x, "xy" → x·y); null when it cannot. */
function splitName(id: string, known: (s: string) => boolean): string[] | null {
	const chars = Array.from(id);
	const memo = new Map<number, string[] | null>();
	const go = (from: number): string[] | null => {
		if (from === chars.length) return [];
		if (memo.has(from)) return memo.get(from)!;
		let best: string[] | null = null;
		for (let to = chars.length; to > from; to--) {
			const part = chars.slice(from, to).join("");
			if (!known(part)) continue;
			const rest = go(to);
			if (rest) {
				best = [part, ...rest];
				break;
			}
		}
		memo.set(from, best);
		return best;
	};
	return go(0);
}

class Parser {
	private i = 0;
	private depth = 0;
	private absOpen = 0;

	constructor(private readonly toks: Tok[], private readonly names: ReadonlySet<string>) {}

	private get tok(): Tok {
		return this.toks[this.i]!;
	}

	private isOp(v: string): boolean {
		const t = this.tok;
		return t.t === "op" && t.v === v;
	}

	private isWord(v: string): boolean {
		const t = this.tok;
		return t.t === "id" && t.v === v;
	}

	private expectOp(v: string): void {
		if (!this.isOp(v)) throw new ExprError(`expected '${v}'`, this.tok.at);
		this.i++;
	}

	private enter(): void {
		if (++this.depth > MAX_DEPTH) throw new ExprError("expression nested too deeply", this.tok.at);
	}

	private leave(): void {
		this.depth--;
	}

	parse(): Node {
		const n = this.or();
		if (this.tok.t !== "end") throw new ExprError("unexpected input", this.tok.at);
		return n;
	}

	private or(): Node {
		let a = this.and();
		while (this.isWord("or")) {
			this.i++;
			a = { k: "or", a, b: this.and() };
		}
		return a;
	}

	private and(): Node {
		let a = this.not();
		while (this.isWord("and")) {
			this.i++;
			a = { k: "and", a, b: this.not() };
		}
		return a;
	}

	private not(): Node {
		if (this.isWord("not")) {
			this.i++;
			this.enter();
			const a = this.not();
			this.leave();
			return { k: "not", a };
		}
		return this.compare();
	}

	private compare(): Node {
		const first = this.additive();
		let left = first;
		let out: Node | null = null;
		for (;;) {
			const t = this.tok;
			if (t.t !== "op" || !["<", "<=", ">", ">=", "=", "!="].includes(t.v)) break;
			this.i++;
			const right = this.additive();
			const c: Node = { k: "cmp", op: t.v as "<", a: left, b: right };
			out = out ? { k: "and", a: out, b: c } : c;
			left = right;
		}
		return out ?? first;
	}

	private additive(): Node {
		let a = this.term();
		for (;;) {
			if (this.isOp("+") || this.isOp("-")) {
				const op = (this.tok as { v: "+" | "-" }).v;
				this.i++;
				a = { k: "bin", op, a, b: this.term() };
			} else return a;
		}
	}

	/** Whether the next token starts a factor that multiplies the previous one without a sign. */
	private startsImplicit(): boolean {
		const t = this.tok;
		if (t.t === "num" || t.t === "id") return t.t === "num" || !["and", "or", "not"].includes(t.v);
		if (t.t !== "op") return false;
		if (t.v === "(" || t.v === "√") return true;
		// A bar opens an absolute value unless one is open (then it closes it).
		return t.v === "|" && this.absOpen === 0;
	}

	private term(): Node {
		let a = this.unary();
		for (;;) {
			if (this.isOp("*") || this.isOp("/")) {
				const op = (this.tok as { v: "*" | "/" }).v;
				this.i++;
				a = { k: "bin", op, a, b: this.unary() };
			} else if (this.startsImplicit()) {
				a = { k: "bin", op: "*", a, b: this.power() };
			} else return a;
		}
	}

	private unary(): Node {
		if (this.isOp("-") || this.isOp("+")) {
			const neg = this.isOp("-");
			this.i++;
			this.enter();
			const a = this.unary();
			this.leave();
			return neg ? { k: "neg", a } : a;
		}
		return this.power();
	}

	private power(): Node {
		const base = this.postfix();
		if (this.isOp("^")) {
			this.i++;
			this.enter();
			// Right associative; the exponent may carry a sign (x^-2).
			const exp = this.unary();
			this.leave();
			return { k: "bin", op: "^", a: base, b: exp };
		}
		return base;
	}

	private postfix(): Node {
		let a = this.primary();
		while (this.isOp("!")) {
			this.i++;
			a = { k: "fact", a };
		}
		return a;
	}

	/** A function applied without parentheses takes the implicit product that follows ("sin 2x" = sin(2x)). */
	private bareArgument(): Node {
		let a = this.power();
		while (this.startsImplicit() && !(this.tok.t === "id" && FUNCTIONS.has(this.tok.v))) a = { k: "bin", op: "*", a, b: this.power() };
		return a;
	}

	private call(name: string, at: number): Node {
		const fn = FUNCTIONS.get(name)!;
		const args: Node[] = [];
		this.enter();
		if (this.isOp("(")) {
			this.i++;
			if (!this.isOp(")")) {
				args.push(this.or());
				while (this.isOp(",")) {
					this.i++;
					args.push(this.or());
				}
			}
			this.expectOp(")");
		} else {
			if (this.tok.t === "end" || !this.startsImplicit()) throw new ExprError(`'${name}' needs an argument`, at);
			args.push(this.bareArgument());
		}
		this.leave();
		if (fn.arity === "variadic" ? args.length < (fn.min ?? 1) : args.length !== fn.arity) {
			throw new ExprError(`'${name}' takes ${fn.arity === "variadic" ? `at least ${fn.min ?? 1}` : fn.arity} argument(s)`, at);
		}
		return { k: "call", name, args };
	}

	private known(s: string): boolean {
		return this.names.has(s) || FUNCTIONS.has(s) || CONSTANTS.has(s);
	}

	private primary(): Node {
		const t = this.tok;
		if (t.t === "num") {
			this.i++;
			return { k: "num", v: t.v };
		}
		if (t.t === "op" && t.v === "(") {
			this.i++;
			this.enter();
			const saved = this.absOpen;
			this.absOpen = 0;
			const n = this.or();
			this.absOpen = saved;
			this.leave();
			this.expectOp(")");
			return n;
		}
		if (t.t === "op" && t.v === "|") {
			this.i++;
			this.enter();
			this.absOpen++;
			const n = this.additive();
			this.absOpen--;
			this.leave();
			this.expectOp("|");
			return { k: "call", name: "abs", args: [n] };
		}
		if (t.t === "op" && t.v === "√") {
			this.i++;
			this.enter();
			const a = this.power();
			this.leave();
			return { k: "call", name: "sqrt", args: [a] };
		}
		if (t.t === "id") {
			this.i++;
			const id = t.v === "theta" ? "θ" : t.v;
			if (this.names.has(id)) return { k: "var", name: id };
			if (CONSTANTS.has(id)) return { k: "num", v: CONSTANTS.get(id)! };
			if (FUNCTIONS.has(id)) return this.call(id, t.at);
			const parts = splitName(id, (s) => this.known(s === "theta" ? "θ" : s));
			if (!parts) throw new ExprError(`unknown name '${t.v}'`, t.at);
			// Rewrite the split identifier as a product, a trailing function applying to what follows.
			let node: Node | null = null;
			for (let k = 0; k < parts.length; k++) {
				const p = parts[k]!;
				let factor: Node;
				if (this.names.has(p)) factor = { k: "var", name: p };
				else if (CONSTANTS.has(p)) factor = { k: "num", v: CONSTANTS.get(p)! };
				else {
					// A function inside the word applies to the rest of the word ("sinx") or to what follows.
					const rest = parts.slice(k + 1);
					if (rest.length > 0) {
						const restNode = rest.map((r): Node => (this.names.has(r) ? { k: "var", name: r } : CONSTANTS.has(r) ? { k: "num", v: CONSTANTS.get(r)! } : (() => {
							throw new ExprError(`unknown name '${t.v}'`, t.at);
						})())).reduce((a, b): Node => ({ k: "bin", op: "*", a, b }));
						const fn = FUNCTIONS.get(p)!;
						if (fn.arity !== 1 && !(fn.arity === "variadic" && (fn.min ?? 1) <= 1)) throw new ExprError(`'${p}' takes ${String(fn.arity)} arguments`, t.at);
						factor = { k: "call", name: p, args: [restNode] };
						node = node ? { k: "bin", op: "*", a: node, b: factor } : factor;
						return node;
					}
					factor = this.call(p, t.at);
				}
				node = node ? { k: "bin", op: "*", a: node, b: factor } : factor;
			}
			return node!;
		}
		if (t.t === "end") throw new ExprError("unexpected end of expression", t.at);
		throw new ExprError(`unexpected '${t.v}'`, t.at);
	}
}

/** Parses an expression; throws ExprError with the position of the problem. */
export function parseExpr(src: string, options: ParseOptions): Node {
	if (src.length > EXPR_MAX) throw new ExprError(`longer than ${EXPR_MAX} characters`, EXPR_MAX);
	const toks = tokenize(src);
	if (toks.length === 1) throw new ExprError("empty expression", 0);
	return new Parser(toks, options.names).parse();
}

export type Compiled = (vars: ArrayLike<number>) => number;

export interface CompileOptions {
	/** Variable names in slot order: `vars[i]` is the value of `variables[i]`. */
	variables: readonly string[];
	/** Parameter values, bound when compiling. */
	params?: ReadonlyMap<string, number>;
	/** Trigonometric functions take and give degrees. */
	degrees?: boolean;
}

const truth = (v: number) => (v !== 0 && !Number.isNaN(v) ? 1 : 0);

function build(n: Node, slots: ReadonlyMap<string, number>, params: ReadonlyMap<string, number>, degrees: boolean): Compiled {
	switch (n.k) {
		case "num": {
			const v = n.v;
			return () => v;
		}
		case "var": {
			const slot = slots.get(n.name);
			if (slot !== undefined) return (vars) => vars[slot]!;
			const p = params.get(n.name);
			if (p !== undefined) return () => p;
			throw new ExprError(`unknown name '${n.name}'`, 0);
		}
		case "neg": {
			const a = build(n.a, slots, params, degrees);
			return (v) => -a(v);
		}
		case "not": {
			const a = build(n.a, slots, params, degrees);
			return (v) => 1 - truth(a(v));
		}
		case "fact": {
			const a = build(n.a, slots, params, degrees);
			return (v) => factorial(a(v));
		}
		case "and": {
			const a = build(n.a, slots, params, degrees);
			const b = build(n.b, slots, params, degrees);
			return (v) => (truth(a(v)) && truth(b(v)) ? 1 : 0);
		}
		case "or": {
			const a = build(n.a, slots, params, degrees);
			const b = build(n.b, slots, params, degrees);
			return (v) => (truth(a(v)) || truth(b(v)) ? 1 : 0);
		}
		case "cmp": {
			const a = build(n.a, slots, params, degrees);
			const b = build(n.b, slots, params, degrees);
			switch (n.op) {
				case "<": return (v) => (a(v) < b(v) ? 1 : 0);
				case "<=": return (v) => (a(v) <= b(v) ? 1 : 0);
				case ">": return (v) => (a(v) > b(v) ? 1 : 0);
				case ">=": return (v) => (a(v) >= b(v) ? 1 : 0);
				case "=": return (v) => (a(v) === b(v) ? 1 : 0);
				case "!=": return (v) => (a(v) !== b(v) ? 1 : 0);
			}
			break;
		}
		case "bin": {
			const a = build(n.a, slots, params, degrees);
			const b = build(n.b, slots, params, degrees);
			switch (n.op) {
				case "+": return (v) => a(v) + b(v);
				case "-": return (v) => a(v) - b(v);
				case "*": return (v) => a(v) * b(v);
				case "/": return (v) => a(v) / b(v);
				case "^": return (v) => {
					const base = a(v);
					const e = b(v);
					// A negative base with an odd-denominator rational exponent (x^(1/3)) is real.
					if (base < 0 && !Number.isInteger(e)) {
						const inv = 1 / e;
						if (Number.isFinite(inv) && Math.abs(inv - Math.round(inv)) < 1e-12 && Math.abs(Math.round(inv)) % 2 === 1) return -Math.pow(-base, e);
					}
					return Math.pow(base, e);
				};
			}
			break;
		}
		case "call": {
			const fn = FUNCTIONS.get(n.name);
			if (!fn) throw new ExprError(`unknown function '${n.name}'`, 0);
			const args = n.args.map((x) => build(x, slots, params, degrees));
			const f = fn.f;
			const inDeg = degrees && fn.trig === "in";
			const outDeg = degrees && fn.trig === "out";
			if (args.length === 1) {
				const a = args[0]!;
				if (inDeg) return (v) => f(a(v) * DEG);
				if (outDeg) return (v) => f(a(v)) / DEG;
				return (v) => f(a(v));
			}
			if (args.length === 2) {
				const [a, b] = args as [Compiled, Compiled];
				return outDeg ? (v) => f(a(v), b(v)) / DEG : (v) => f(a(v), b(v));
			}
			return (v) => f(...args.map((g) => g(v)));
		}
	}
	throw new ExprError("unknown node", 0);
}

/** Closure evaluating `node` with `vars` in the order of `options.variables`. */
export function compile(node: Node, options: CompileOptions): Compiled {
	const slots = new Map(options.variables.map((v, i) => [v, i] as const));
	return build(node, slots, options.params ?? new Map(), !!options.degrees);
}

export type CompileResult = { ok: true; fn: Compiled } | { ok: false; error: string; at: number };

/** Parses and compiles in one step; a problem comes back as a message and a position instead of an exception. */
export function compileExpr(src: string, options: CompileOptions): CompileResult {
	try {
		const names = new Set<string>([...options.variables, ...(options.params?.keys() ?? [])]);
		const node = parseExpr(src, { names });
		return { ok: true, fn: compile(node, options) };
	} catch (e) {
		if (e instanceof ExprError) return { ok: false, error: e.message, at: e.at };
		throw e;
	}
}

/** Splits `lhs = rhs` at a top-level "=" (outside parentheses), or null when there is none or more than one. */
export function splitEquation(src: string): { lhs: string; rhs: string } | null {
	let depth = 0;
	let at = -1;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i]!;
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		else if (ch === "=" && depth === 0) {
			const prev = src[i - 1] ?? "";
			const next = src[i + 1] ?? "";
			if (prev === "<" || prev === ">" || prev === "!" || prev === "=" || next === "=") continue;
			if (at >= 0) return null;
			at = i;
		}
	}
	return at < 0 ? null : { lhs: src.slice(0, at), rhs: src.slice(at + 1) };
}

/**
 * The body of a function written with its name: "y = x^2" → "x^2" (cartesian), "r = 2θ" → "2θ" (polar). Anything
 * else is returned unchanged.
 */
export function stripLhs(src: string, name: string): string {
	const eq = splitEquation(src);
	if (!eq) return src;
	return eq.lhs.trim() === name ? eq.rhs : src;
}
