import { fmt, parseCellNumber } from "./stats";

/**
 * Spreadsheet-like formulas for the cells of a hand-drawn table (0.30, roadmap #147). Pure: no 'obsidian', no DOM, no `eval`: a small
 * hand-written tokenizer and recursive-descent parser produce a syntax tree that is walked with the values of the cells. Names resolve
 * only through the tables below, so a formula cannot reach anything outside the table.
 *
 * Grammar: numbers (`2`, `0.5`, `.5`, `1e-3`), cell references `A1` (column letters, row number, both counted from the top-left cell of
 * the table, header row included; `$` signs are accepted and ignored), ranges `B1:B4`, `+ - * / ^` (also U+2212, U+00D7, U+00F7, U+00B7),
 * parentheses, a unary sign, a postfix `%` (a percentage: `10%` is 0.1) and the functions below, arguments separated by `,` or `;`.
 * `-2^2` is -4 (the power binds tighter than the sign), as in written maths.
 *
 * Functions (Italian names work too): SUM/SOMMA, AVG/AVERAGE/MEAN/MEDIA, MIN, MAX, COUNT/CONTA, MEDIAN/MEDIANA, PRODUCT/PRODOTTO take any
 * number of numbers, cells and ranges (text and empty cells in a range are skipped, as in a spreadsheet); ABS/ASS, SQRT/RADQ,
 * ROUND/ARROTONDA(x[, digits]) and PCT(part, whole) = part / whole * 100.
 *
 * Errors are values: #REF (a cell outside the table), #CYCLE (cells that depend on each other), #DIV/0, #VALUE (text or a range where a
 * number is needed), #NAME (unknown function), #NUM (no real result), #ERR (the formula does not read). An error in a cell makes every
 * formula that uses the cell show the same error.
 */

export type FormulaError = "#REF" | "#CYCLE" | "#DIV/0" | "#VALUE" | "#NAME" | "#NUM" | "#ERR";

/** What a cell holds once read: a number, nothing, other text, or an error. */
export type CellValue = { k: "num"; v: number } | { k: "blank" } | { k: "text" } | { k: "err"; code: FormulaError };

/** One cell of a sheet as the evaluator takes it: a formula (the text after the "="), or what is written in it. */
export type SheetCell = { formula: string } | { value: string };

/** Longest accepted formula, characters, and deepest nesting: a hostile formula cannot overflow the stack. */
export const FORMULA_MAX = 500;
const MAX_DEPTH = 40;
/** The sign between a formula and its result in a text box (U+2192, built from the code point so the source stays plain ASCII). */
export const RESULT_MARK = String.fromCharCode(0x2192);

export type Node =
	| { k: "num"; v: number }
	| { k: "ref"; r: number; c: number }
	| { k: "range"; r1: number; c1: number; r2: number; c2: number }
	| { k: "neg"; a: Node }
	| { k: "pct"; a: Node }
	| { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
	| { k: "call"; name: string; args: Node[] };

type OpSym = "+" | "-" | "*" | "/" | "^" | "(" | ")" | "," | ":" | "%";
const OP_SYMBOLS: readonly string[] = ["+", "-", "*", "/", "^", "(", ")", ",", ":", "%"];

type Token =
	| { t: "num"; v: number }
	| { t: "ref"; r: number; c: number }
	| { t: "name"; s: string }
	| { t: "op"; s: OpSym };

class SyntaxProblem extends Error {
	constructor(readonly code: FormulaError) {
		super(code);
	}
}

const err = (code: FormulaError): CellValue => ({ k: "err", code });

/** The column name of column `c` (0-based): A..Z, AA... */
export function colName(c: number): string {
	let s = "";
	let n = c + 1;
	while (n > 0) {
		const m = (n - 1) % 26;
		s = String.fromCharCode(65 + m) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}

/** The A1-style name of a cell (0-based row and column). */
export const refName = (r: number, c: number): string => `${colName(c)}${r + 1}`;

const OPERATOR_ALIASES: Record<string, string> = {
	[String.fromCharCode(0x2212)]: "-", [String.fromCharCode(0xd7)]: "*", [String.fromCharCode(0xb7)]: "*", [String.fromCharCode(0xf7)]: "/", ";": ",",
};

function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i]!;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
		if (num && !/^[A-Za-z]/.test(ch)) {
			out.push({ t: "num", v: Number(num[0]) });
			i += num[0].length;
			continue;
		}
		const word = /^\$?[A-Za-z]+\$?\d*/.exec(src.slice(i));
		if (word && /^[$A-Za-z]/.test(ch)) {
			const text = word[0];
			i += text.length;
			const ref = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(text);
			// A function name is followed by "(": "LOG10(x)" is a name, "B10" a cell.
			if (ref && src[skipSpaces(src, i)] !== "(") {
				const letters = ref[1]!.toUpperCase();
				let col = 0;
				for (const l of letters) col = col * 26 + (l.charCodeAt(0) - 64);
				out.push({ t: "ref", r: Number(ref[2]) - 1, c: col - 1 });
			} else out.push({ t: "name", s: text.replace(/\$/g, "").toUpperCase() });
			continue;
		}
		const op = OPERATOR_ALIASES[ch] ?? ch;
		if (OP_SYMBOLS.includes(op)) {
			out.push({ t: "op", s: op as OpSym });
			i++;
			continue;
		}
		throw new SyntaxProblem("#ERR");
	}
	return out;
}

const skipSpaces = (s: string, from: number): number => {
	let i = from;
	while (i < s.length && /\s/.test(s[i]!)) i++;
	return i;
};

/** Aggregates take any number of arguments (cells, ranges, numbers); scalars take the stated count. */
const AGGREGATES = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT", "MEDIAN", "PRODUCT"]);
const SCALARS: Record<string, { min: number; max: number }> = { ABS: { min: 1, max: 1 }, SQRT: { min: 1, max: 1 }, ROUND: { min: 1, max: 2 }, PCT: { min: 2, max: 2 } };
const ALIASES: Record<string, string> = {
	AVERAGE: "AVG", MEAN: "AVG", SOMMA: "SUM", MEDIA: "AVG", CONTA: "COUNT", MEDIANA: "MEDIAN", PRODOTTO: "PRODUCT", ASS: "ABS", RADQ: "SQRT", ARROTONDA: "ROUND",
};
const canonical = (name: string): string => ALIASES[name] ?? name;
const isFunction = (name: string): boolean => AGGREGATES.has(name) || name in SCALARS;

class Parser {
	private pos = 0;
	private depth = 0;
	constructor(private readonly tokens: readonly Token[]) {}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private isOp(s: string): boolean {
		const t = this.peek();
		return t?.t === "op" && t.s === s;
	}

	private enter(): void {
		if (++this.depth > MAX_DEPTH) throw new SyntaxProblem("#ERR");
	}

	parse(): Node {
		const n = this.expr();
		if (this.pos < this.tokens.length) throw new SyntaxProblem("#ERR");
		return n;
	}

	private expr(): Node {
		this.enter();
		let a = this.term();
		for (;;) {
			const t = this.peek();
			if (t?.t === "op" && (t.s === "+" || t.s === "-")) {
				this.pos++;
				a = { k: "bin", op: t.s, a, b: this.term() };
			} else break;
		}
		this.depth--;
		return a;
	}

	private term(): Node {
		let a = this.unary();
		for (;;) {
			const t = this.peek();
			if (t?.t === "op" && (t.s === "*" || t.s === "/")) {
				this.pos++;
				a = { k: "bin", op: t.s, a, b: this.unary() };
			} else break;
		}
		return a;
	}

	private unary(): Node {
		const t = this.peek();
		if (t?.t === "op" && (t.s === "-" || t.s === "+")) {
			this.pos++;
			this.enter();
			const a = this.unary();
			this.depth--;
			return t.s === "-" ? { k: "neg", a } : a;
		}
		return this.power();
	}

	private power(): Node {
		const base = this.postfix();
		if (this.isOp("^")) {
			this.pos++;
			this.enter();
			const exp = this.unary();
			this.depth--;
			return { k: "bin", op: "^", a: base, b: exp };
		}
		return base;
	}

	private postfix(): Node {
		let a = this.primary();
		while (this.isOp("%")) {
			this.pos++;
			a = { k: "pct", a };
		}
		return a;
	}

	private primary(): Node {
		const t = this.peek();
		if (!t) throw new SyntaxProblem("#ERR");
		this.pos++;
		if (t.t === "num") return { k: "num", v: t.v };
		if (t.t === "ref") {
			if (this.isOp(":")) {
				this.pos++;
				const u = this.peek();
				if (u?.t !== "ref") throw new SyntaxProblem("#ERR");
				this.pos++;
				return { k: "range", r1: Math.min(t.r, u.r), c1: Math.min(t.c, u.c), r2: Math.max(t.r, u.r), c2: Math.max(t.c, u.c) };
			}
			return { k: "ref", r: t.r, c: t.c };
		}
		if (t.t === "name") {
			const name = canonical(t.s);
			if (!isFunction(name) || !this.isOp("(")) throw new SyntaxProblem(isFunction(name) ? "#ERR" : "#NAME");
			this.pos++;
			const args: Node[] = [];
			if (!this.isOp(")")) {
				for (;;) {
					args.push(this.expr());
					if (this.isOp(",")) this.pos++;
					else break;
				}
			}
			if (!this.isOp(")")) throw new SyntaxProblem("#ERR");
			this.pos++;
			const scalar = SCALARS[name];
			if (scalar ? args.length < scalar.min || args.length > scalar.max : args.length === 0) throw new SyntaxProblem("#ERR");
			return { k: "call", name, args };
		}
		if (t.s === "(") {
			const inner = this.expr();
			if (!this.isOp(")")) throw new SyntaxProblem("#ERR");
			this.pos++;
			return inner;
		}
		throw new SyntaxProblem("#ERR");
	}
}

export type ParsedFormula = { ok: true; node: Node } | { ok: false; code: FormulaError };

/** Parses the text of a formula (without its leading "="). */
export function parseFormula(src: string): ParsedFormula {
	const text = src.replace(/\s+/g, " ").trim();
	if (text === "" || text.length > FORMULA_MAX) return { ok: false, code: "#ERR" };
	try {
		return { ok: true, node: new Parser(tokenize(text)).parse() };
	} catch (e) {
		return { ok: false, code: e instanceof SyntaxProblem ? e.code : "#ERR" };
	}
}

// --- reading a text box ------------------------------------------------------------------------------------------------------------

/**
 * The formula a text box holds, or null when it is not a formula. A formula starts with "=" (spaces before it are fine); once the table has
 * been computed the box reads `=SUM(B1:B4) -> 42` (the arrow is RESULT_MARK): the formula is what comes before the arrow, so it is always
 * recoverable and computing again is safe; whatever the person wrote after the result is theirs and is not read. A box without an arrow
 * that holds notes on lines below the formula ("=A1+B1" / "(net of VAT)") reads the leading lines that parse as the formula.
 * `typed` is the formula as written, with its "=".
 */
export function formulaOfText(text: string): { src: string; typed: string } | null {
	const s = splitFormulaBox(text);
	return s ? { src: s.src, typed: s.typed } : null;
}

const flatFormula = (s: string): string => s.replace(/\s+/g, " ").trim();
const parses = (formulaText: string): boolean => parseFormula(flatFormula(formulaText).slice(1)).ok;

/** A result Compute wrote right after the arrow: a number as `showValue` prints it, an error code, or "-" (not finite). */
const RESULT_TOKEN = /^[ \t]*(?:#[A-Z]+(?:\/0)?|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|-)(?=\s|$)/;
/** Most leading lines tried as the formula of a box that holds notes below it. */
const NOTE_PREFIX_TRIES = 12;

interface FormulaBox {
	src: string;
	typed: string;
	/** The raw text of the formula (line breaks kept), trailing blanks removed. */
	head: string;
	/** What the person wrote after the formula and its result, kept as it is (leading blank or line break included); "" when nothing. */
	rest: string;
	/** True when the formula is followed by an arrow (the first one of the box). */
	arrow: boolean;
	/** With an arrow: the text after it starts with a result Compute could have written, which is the part to replace. */
	owned: boolean;
}

/**
 * Splits a formula box into the part Compute owns (the formula and the result right after the arrow) and the words the person added.
 * The formula is what comes before the first arrow. If that does not parse and spans lines, or there is no arrow and the whole text does
 * not parse, the longest run of leading lines that does parse is the formula and the lines below are notes.
 */
function splitFormulaBox(text: string): FormulaBox | null {
	if (!text.trimStart().startsWith("=")) return null;
	const cut = text.indexOf(RESULT_MARK);
	const before = cut >= 0 ? text.slice(0, cut) : text;
	let head = before;
	let rest = "";
	let arrow = cut >= 0;
	let owned = false;
	if (before.includes("\n") && !parses(before)) {
		const lines = before.split("\n");
		for (let k = Math.min(lines.length - 1, NOTE_PREFIX_TRIES); k >= 1; k--) {
			if (!parses(lines.slice(0, k).join("\n"))) continue;
			head = lines.slice(0, k).join("\n");
			rest = text.slice(head.length);
			arrow = false;
			break;
		}
	}
	if (arrow) {
		const tail = text.slice(cut + RESULT_MARK.length);
		const m = RESULT_TOKEN.exec(tail);
		owned = m !== null;
		rest = m ? tail.slice(m[0].length) : tail;
	}
	const typed = flatFormula(head);
	const src = typed.slice(1).trim();
	if (src === "") return null;
	return { src, typed, head: head.replace(/\s+$/, ""), rest: rest.trim() === "" ? "" : rest, arrow, owned };
}

/** The text a formula box holds after computing: the formula as typed, the arrow and the shown result. */
export const withResult = (typed: string, shown: string): string => `${typed} ${RESULT_MARK} ${shown}`;

/**
 * The text of the formula box `text` once its result is `shown`, or null when it is not a formula box. Only the result Compute owns is
 * replaced (the value right after the arrow); every other word, and the box's line breaks, stay. If what follows the arrow is not a result
 * (the person's own "-> see p.3"), the result is put in before it and their words are kept after a second arrow, so a later Compute
 * finds the result and changes nothing else (idempotent) and no text is lost.
 */
export function rewriteWithResult(text: string, shown: string): string | null {
	const s = splitFormulaBox(text);
	if (!s) return null;
	if (s.arrow && !s.owned) {
		return s.rest === "" ? withResult(s.head, shown) : `${withResult(s.head, shown)} ${RESULT_MARK}${/^\s/.test(s.rest) ? "" : " "}${s.rest}`;
	}
	return withResult(s.head, shown) + s.rest;
}

/** A result as a text box shows it: at most 10 significant digits, no trailing zeros; an error as its code. */
export function showValue(v: CellValue): string {
	if (v.k === "num") return fmt(v.v, 10);
	if (v.k === "err") return v.code;
	return "";
}

/** A cell that is not a formula, as a value: a number (a trailing "%" is a percentage), nothing, or other text. */
export function valueOfText(raw: string): CellValue {
	const s = raw.trim();
	if (s === "") return { k: "blank" };
	const n = parseCellNumber(s);
	if (n !== null) return { k: "num", v: n };
	const pct = /^(.*\S)\s*%$/.exec(s);
	const p = pct ? parseCellNumber(pct[1]!) : null;
	return p !== null ? { k: "num", v: p / 100 } : { k: "text" };
}

// --- evaluating --------------------------------------------------------------------------------------------------------------------

/** Where a formula reads its cells from. */
export interface CellSource {
	rows: number;
	cols: number;
	/** The value of the cell (0-based, inside the table). */
	at(r: number, c: number): CellValue;
}

type Scalar = { k: "num"; v: number } | { k: "err"; code: FormulaError };
type Result = Scalar | { k: "list"; items: CellValue[] };

const fail = (code: FormulaError): Scalar => ({ k: "err", code });

function scalar(n: Node, src: CellSource): Scalar {
	const r = evalNode(n, src);
	return r.k === "list" ? fail("#VALUE") : r;
}

/** A cell used as a number: empty is 0, text is #VALUE. */
function number(v: CellValue): Scalar {
	if (v.k === "num" || v.k === "err") return v;
	return v.k === "blank" ? { k: "num", v: 0 } : fail("#VALUE");
}

function inside(src: CellSource, r: number, c: number): boolean {
	return r >= 0 && c >= 0 && r < src.rows && c < src.cols;
}

function evalNode(n: Node, src: CellSource): Result {
	switch (n.k) {
		case "num":
			return n;
		case "ref":
			return inside(src, n.r, n.c) ? number(src.at(n.r, n.c)) : fail("#REF");
		case "range": {
			if (!inside(src, n.r1, n.c1) || !inside(src, n.r2, n.c2)) return fail("#REF");
			const items: CellValue[] = [];
			for (let r = n.r1; r <= n.r2; r++) for (let c = n.c1; c <= n.c2; c++) items.push(src.at(r, c));
			return { k: "list", items };
		}
		case "neg": {
			const a = scalar(n.a, src);
			return a.k === "num" ? { k: "num", v: -a.v } : a;
		}
		case "pct": {
			const a = scalar(n.a, src);
			return a.k === "num" ? { k: "num", v: a.v / 100 } : a;
		}
		case "bin": {
			const a = scalar(n.a, src);
			if (a.k !== "num") return a;
			const b = scalar(n.b, src);
			if (b.k !== "num") return b;
			return finite(arith(n.op, a.v, b.v));
		}
		case "call":
			return call(n.name, n.args, src);
	}
}

function arith(op: "+" | "-" | "*" | "/" | "^", a: number, b: number): number | FormulaError {
	switch (op) {
		case "+": return a + b;
		case "-": return a - b;
		case "*": return a * b;
		case "/": return b === 0 ? "#DIV/0" : a / b;
		case "^": return a === 0 && b < 0 ? "#DIV/0" : a ** b;
	}
}

function finite(v: number | FormulaError): Scalar {
	if (typeof v === "string") return fail(v);
	return Number.isFinite(v) ? { k: "num", v: Object.is(v, -0) ? 0 : v } : fail("#NUM");
}

/** The numbers the arguments of an aggregate hold (text and empty cells skipped), or the first error met. */
function numbersOf(args: readonly Node[], src: CellSource): number[] | FormulaError {
	const out: number[] = [];
	for (const a of args) {
		if (a.k === "ref" || a.k === "range") {
			const items: CellValue[] = [];
			if (a.k === "ref") {
				if (!inside(src, a.r, a.c)) return "#REF";
				items.push(src.at(a.r, a.c));
			} else {
				const r = evalNode(a, src);
				if (r.k === "err") return r.code;
				if (r.k === "list") items.push(...r.items);
			}
			for (const v of items) {
				if (v.k === "err") return v.code;
				if (v.k === "num") out.push(v.v);
			}
			continue;
		}
		const v = scalar(a, src);
		if (v.k === "err") return v.code;
		out.push(v.v);
	}
	return out;
}

function call(name: string, args: readonly Node[], src: CellSource): Scalar {
	if (AGGREGATES.has(name)) {
		const xs = numbersOf(args, src);
		if (typeof xs === "string") return fail(xs);
		const sum = xs.reduce((s, v) => s + v, 0);
		switch (name) {
			case "SUM": return finite(sum);
			case "COUNT": return { k: "num", v: xs.length };
			case "AVG": return xs.length === 0 ? fail("#DIV/0") : finite(sum / xs.length);
			case "MIN": return { k: "num", v: xs.length === 0 ? 0 : Math.min(...xs) };
			case "MAX": return { k: "num", v: xs.length === 0 ? 0 : Math.max(...xs) };
			case "PRODUCT": return finite(xs.length === 0 ? 0 : xs.reduce((p, v) => p * v, 1));
			default: {
				if (xs.length === 0) return fail("#NUM");
				const s = [...xs].sort((p, q) => p - q);
				const mid = s.length >> 1;
				return { k: "num", v: s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2 };
			}
		}
	}
	const vals: number[] = [];
	for (const a of args) {
		const v = scalar(a, src);
		if (v.k !== "num") return v;
		vals.push(v.v);
	}
	const [x = 0, y] = vals;
	switch (name) {
		case "ABS": return finite(Math.abs(x));
		case "SQRT": return x < 0 ? fail("#NUM") : finite(Math.sqrt(x));
		case "PCT": return y === 0 ? fail("#DIV/0") : finite((x / (y ?? 1)) * 100);
		default: {
			const d = Math.max(0, Math.min(10, Math.trunc(y ?? 0)));
			const f = 10 ** d;
			// away from zero on a tie, as a spreadsheet rounds
			return finite((Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9)) / f);
		}
	}
}

/** The value of a parsed formula over `src`. */
export function evaluate(node: Node, src: CellSource): CellValue {
	const r = evalNode(node, src);
	return r.k === "list" ? err("#VALUE") : r;
}

/**
 * The value of every cell of a sheet. A formula is evaluated once, on demand, with the cells it names evaluated first; a cell reached
 * again while it is being worked out is a cycle (#CYCLE for it and for every formula that depends on it).
 */
export function evaluateSheet(cells: readonly (readonly SheetCell[])[]): CellValue[][] {
	const rows = cells.length;
	const cols = rows === 0 ? 0 : Math.max(...cells.map((r) => r.length));
	const done: (CellValue | undefined)[][] = cells.map((r) => r.map(() => undefined));
	const busy = cells.map((r) => r.map(() => false));
	const parsed = new Map<string, ParsedFormula>();

	const valueAt = (r: number, c: number): CellValue => {
		const cell = cells[r]?.[c];
		if (!cell) return { k: "blank" };
		const known = done[r]![c];
		if (known) return known;
		if ("value" in cell) return (done[r]![c] = valueOfText(cell.value));
		if (busy[r]![c]) return err("#CYCLE");
		busy[r]![c] = true;
		let p = parsed.get(cell.formula);
		if (!p) parsed.set(cell.formula, (p = parseFormula(cell.formula)));
		const v: CellValue = p.ok ? evaluate(p.node, { rows, cols, at: valueAt }) : err(p.code);
		busy[r]![c] = false;
		// a cycle found on the way is seen by every cell of it: none keeps a stale partial answer
		return (done[r]![c] = v);
	};

	return cells.map((row, r) => row.map((_, c) => valueAt(r, c)));
}
