/**
 * Balancing of typed chemical reactions (0.23, roadmap #294). Pure: no 'obsidian', no DOM.
 *
 * `parseReaction` reads a typed reaction (formulas with parentheses and brackets, hydrates with ·, charges like `Fe^3+`,
 * `SO4^2-`, `e^-` or superscript digits, arrows `->` `→` `⇌` `=`), `balanceReaction` builds the element and charge matrix and
 * finds the smallest positive whole coefficients by exact rational Gaussian elimination (BigInt fractions, no rounding), and
 * `balanceText` / `balanceLatex` apply it to the lines of a text box or the source of an equation. A reaction that cannot be
 * balanced, or that has more than one answer, is reported with a code and the species or elements involved; nothing is guessed.
 */

/** Why a reaction was not balanced. */
export type ChemErrorCode =
	| "empty"
	| "no-arrow"
	| "many-arrows"
	| "empty-side"
	| "bad-formula"
	| "unknown-element"
	| "bad-charge"
	| "too-large"
	| "one-sided"
	| "unbalanceable"
	| "unused-species"
	| "ambiguous";

export interface ChemError {
	code: ChemErrorCode;
	/** English description (the view shows its own translated text for the code). */
	message: string;
	/** The species, elements or text the problem is about. */
	detail: string[];
}

export interface Species {
	/** As typed, without the leading coefficient. */
	source: string;
	/** Atoms per element in one unit of the species. */
	counts: Record<string, number>;
	/** Electric charge of one unit. */
	charge: number;
	/** The coefficient that was typed, 1 when none. */
	coefficient: number;
	side: "left" | "right";
}

export interface ParsedReaction {
	species: Species[];
	/** The arrow as typed (`->`, `→`, `⇌`, `=`). */
	arrow: string;
}

export type BalanceResult =
	| {
			ok: true;
			reaction: ParsedReaction;
			/** One per species, reactants first. */
			coefficients: number[];
			/** The balanced reaction, species spelled as typed. */
			text: string;
			/** False when the coefficients typed were already the balanced ones. */
			changed: boolean;
	  }
	| { ok: false; error: ChemError };

const fail = (code: ChemErrorCode, message: string, detail: string[] = []): { ok: false; error: ChemError } => ({ ok: false, error: { code, message, detail } });

/** Symbols of the 118 elements. */
const ELEMENTS = new Set(
	("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe " +
		"Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr " +
		"Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" "),
);

/** Longest text read, characters. */
export const CHEM_TEXT_MAX = 2000;
/** Largest atom count or coefficient accepted. */
const COUNT_MAX = 1_000_000;

const SUB = "₀₁₂₃₄₅₆₇₈₉";
const SUP: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-" };

interface Norm {
	text: string;
	/** For each character of `text` (and one past the end), where it came from in the original. */
	from: number[];
	original: string;
}

/** Plain ASCII-ish spelling: subscript digits, superscript runs as `^...`, unicode minus and spaces. */
function normalize(raw: string): Norm {
	let text = "";
	const from: number[] = [];
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i]!;
		if (c in SUP) {
			const start = i;
			text += "^";
			from.push(start);
			while (i < raw.length && raw[i]! in SUP) {
				text += SUP[raw[i]!];
				from.push(i);
				i++;
			}
			i--;
			continue;
		}
		const sub = SUB.indexOf(c);
		if (sub >= 0) text += String(sub);
		else if (/\p{Zs}/u.test(c)) text += " ";
		else if (/[−–—]/.test(c)) text += "-";
		else text += c;
		from.push(i);
	}
	from.push(raw.length);
	return { text, from, original: raw };
}

/** Plain text of the normalised string (what the parser reads). */
const plain = (raw: string): string => normalize(raw).text;

/** The original spelling of the normalised range [a, b). */
const spelled = (n: Norm, a: number, b: number): string => n.original.slice(n.from[a], n.from[b]);

const ARROW = /<[-=]{1,3}>|[-=]{1,3}>|<[-=]{1,3}|⇌|⇄|⇋|↔|→|⟶|⟹|⇒|⟷|=/g;

function splitArrow(s: string): { left: string; right: string; arrow: string; rightAt: number; arrowAt: number } | ChemError {
	const found = [...s.matchAll(ARROW)];
	// A lone "=" counts as the arrow only when nothing else does.
	const strong = found.filter((m) => m[0] !== "=");
	const use = strong.length > 0 ? strong : found;
	if (use.length === 0) return { code: "no-arrow", message: "No arrow found (use ->, → or =).", detail: [] };
	if (use.length > 1) return { code: "many-arrows", message: "More than one arrow: balance one step at a time.", detail: use.map((m) => m[0]) };
	const m = use[0]!;
	const at = m.index;
	return { left: s.slice(0, at), right: s.slice(at + m[0].length), arrow: m[0], rightAt: at + m[0].length, arrowAt: at };
}

/** Splits one side at its `+` separators; a `+` that is a charge stays in its species. Each piece knows where it starts in the side. */
function splitSpecies(side: string): Array<{ text: string; at: number }> {
	const out: Array<{ text: string; at: number }> = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < side.length; i++) {
		const c = side[i]!;
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
		else if (c === "+" && depth === 0) {
			const before = side.slice(start, i);
			if (/\^\{?\d*$/.test(before)) continue; // ^+, ^3+ : the charge of this species
			const after = side.slice(i + 1);
			const prev = side[i - 1];
			const spaceBefore = prev === undefined || /\s/.test(prev);
			const spaceAfter = /^\s/.test(after);
			// "Na+ + Cl-": attached to the formula and followed by another separator or the end: a charge.
			if (!spaceBefore && (after.trim() === "" || (spaceAfter && after.trim().startsWith("+")))) continue;
			out.push({ text: before, at: start });
			start = i + 1;
		}
	}
	out.push({ text: side.slice(start), at: start });
	return out;
}

interface Charge {
	body: string;
	charge: number;
}

function takeCharge(text: string): Charge | null {
	let m = /\s*\^\s*\{?\s*(\d*)\s*([+-])\s*\}?\s*$/.exec(text);
	if (m) return { body: text.slice(0, m.index), charge: (m[2] === "+" ? 1 : -1) * (m[1] ? Number(m[1]) : 1) };
	m = /\s*\^\s*\{?\s*([+-])\s*(\d+)\s*\}?\s*$/.exec(text);
	if (m) return { body: text.slice(0, m.index), charge: (m[1] === "+" ? 1 : -1) * Number(m[2]) };
	m = /([A-Za-z0-9)\]])\s*([+-])$/.exec(text);
	if (m) return { body: text.slice(0, m.index + 1), charge: m[2] === "+" ? 1 : -1 };
	if (/\^/.test(text)) return null;
	return { body: text, charge: 0 };
}

class FormulaError extends Error {
	constructor(readonly code: ChemErrorCode, message: string, readonly token: string) {
		super(message);
	}
}

function addCounts(into: Record<string, number>, from: Record<string, number>, times: number, whole: string): void {
	for (const [el, n] of Object.entries(from)) {
		const total = (into[el] ?? 0) + n * times;
		if (total > COUNT_MAX) throw new FormulaError("too-large", "An atom count is too large.", whole);
		into[el] = total;
	}
}

/** Reads `(`group`)n`, `[`group`]n` and `Elem n` sequences. */
function readGroups(s: string, whole: string): Record<string, number> {
	let i = 0;
	const number = (): number => {
		const m = /^\d+/.exec(s.slice(i));
		if (!m) return 1;
		i += m[0].length;
		const n = Number(m[0]);
		if (n === 0 || n > COUNT_MAX) throw new FormulaError("too-large", "A subscript is out of range.", whole);
		return n;
	};
	const sequence = (close: string | null): Record<string, number> => {
		const counts: Record<string, number> = {};
		let any = false;
		while (i < s.length) {
			const c = s[i]!;
			if (c === ")" || c === "]") {
				if (close === c) return counts;
				throw new FormulaError("bad-formula", `Unmatched "${c}".`, whole);
			}
			if (c === "(" || c === "[") {
				i++;
				const closing = c === "(" ? ")" : "]";
				const inner = sequence(closing);
				if (s[i] !== closing) throw new FormulaError("bad-formula", `Missing "${closing}".`, whole);
				i++;
				addCounts(counts, inner, number(), whole);
				any = true;
				continue;
			}
			if (/[A-Z]/.test(c)) {
				const two = s.slice(i, i + 2);
				let sym = "";
				if (/^[A-Z][a-z]$/.test(two) && ELEMENTS.has(two)) sym = two;
				else if (ELEMENTS.has(c)) sym = c;
				else throw new FormulaError("unknown-element", `"${two.length === 2 && /[a-z]/.test(two[1]!) ? two : c}" is not an element.`, whole);
				i += sym.length;
				addCounts(counts, { [sym]: 1 }, number(), whole);
				any = true;
				continue;
			}
			throw new FormulaError("bad-formula", `Unexpected "${c}".`, whole);
		}
		if (close) throw new FormulaError("bad-formula", `Missing "${close}".`, whole);
		if (!any) throw new FormulaError("bad-formula", "Empty formula.", whole);
		return counts;
	};
	return sequence(null);
}

/** `CuSO4·5H2O`, `Fe(OH)3`, `[Fe(CN)6]`: atoms per element. */
function readFormula(body: string, whole: string): Record<string, number> {
	const compact = body.replace(/\s*[·•*]\s*/g, "·").replace(/\s*\.\s*(?=[\d([A-Z])/g, "·");
	const counts: Record<string, number> = {};
	for (const part of compact.trim().split("·")) {
		const m = /^\s*(\d+)\s*(.*)$/.exec(part);
		const inner = (m ? m[2]! : part).trim();
		if (/\s/.test(inner)) throw new FormulaError("bad-formula", "Unexpected space in a formula.", whole);
		const times = m ? Number(m[1]) : 1;
		if (times > COUNT_MAX) throw new FormulaError("too-large", "A hydrate count is too large.", whole);
		addCounts(counts, readGroups(inner, whole), times, whole);
	}
	return counts;
}

function readSpecies(raw: string, at: number, side: "left" | "right", n: Norm): Species | ChemError {
	const text = raw.trim();
	if (text === "") return { code: "empty-side", message: "A side of the reaction is empty or has a stray +.", detail: [] };
	let coefficient = 1;
	let rest = text;
	let offset = raw.length - raw.trimStart().length;
	const frac = /^(\d+)\s*\/\s*(\d+)\s*/.exec(rest);
	const lead = /^(\d+)\s*(?=[A-Z([e·])/.exec(rest);
	if (frac) {
		rest = rest.slice(frac[0].length);
		offset += frac[0].length;
		coefficient = Number(frac[1]) / Number(frac[2]);
	} else if (lead) {
		rest = rest.slice(lead[0].length);
		offset += lead[0].length;
		coefficient = Number(lead[1]);
	}
	const trimmed = rest.trim();
	offset += rest.length - rest.trimStart().length;
	rest = trimmed;
	const source = spelled(n, at + offset, at + offset + rest.length);
	const ch = takeCharge(rest);
	if (!ch) return { code: "bad-charge", message: `The charge of "${text}" is not clear (write e.g. Fe^3+ or SO4^2-).`, detail: [text] };
	const body = ch.body.trim();
	if (Math.abs(ch.charge) > 99) return { code: "bad-charge", message: `The charge of "${text}" is out of range.`, detail: [text] };
	if (body === "e") return { source, counts: {}, charge: ch.charge === 0 ? -1 : ch.charge, coefficient, side };
	try {
		return { source, counts: readFormula(body, text), charge: ch.charge, coefficient, side };
	} catch (e) {
		if (e instanceof FormulaError) return { code: e.code, message: `${e.message} (in "${e.token}")`, detail: [e.token] };
		throw e;
	}
}

const isError = (v: unknown): v is ChemError => typeof v === "object" && v !== null && "code" in v && "detail" in v;

/** Reads one typed reaction. */
export function parseReaction(input: string): { ok: true; reaction: ParsedReaction } | { ok: false; error: ChemError } {
	if (input.length > CHEM_TEXT_MAX) return fail("too-large", "The text is too long.");
	const n = normalize(input);
	if (n.text.trim() === "") return fail("empty", "Nothing to balance.");
	const parts = splitArrow(n.text);
	if (isError(parts)) return { ok: false, error: parts };
	const species: Species[] = [];
	for (const [text, side, base] of [[parts.left, "left", 0], [parts.right, "right", parts.rightAt]] as const) {
		for (const piece of splitSpecies(text)) {
			const sp = readSpecies(piece.text, base + piece.at, side, n);
			if (isError(sp)) return { ok: false, error: sp };
			species.push(sp);
		}
	}
	if (species.length > 40) return fail("too-large", "Too many species.");
	return { ok: true, reaction: { species, arrow: spelled(n, parts.arrowAt, parts.rightAt) } };
}

// --- exact rational arithmetic -------------------------------------------------------------------------------------

interface Q {
	n: bigint;
	d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
	a = a < 0n ? -a : a;
	b = b < 0n ? -b : b;
	while (b !== 0n) [a, b] = [b, a % b];
	return a;
};
const q = (n: bigint, d: bigint = 1n): Q => {
	if (d < 0n) [n, d] = [-n, -d];
	const g = gcd(n, d) || 1n;
	return { n: n / g, d: d / g };
};
const qSub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const qMul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const qDiv = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const isZero = (a: Q): boolean => a.n === 0n;

/** A basis of the nullspace of `rows` (columns = unknowns), as rational vectors. */
function nullspace(rows: number[][], cols: number): Q[][] {
	const m: Q[][] = rows.map((r) => r.map((v) => q(BigInt(v))));
	const pivots: number[] = [];
	let r = 0;
	for (let c = 0; c < cols && r < m.length; c++) {
		let p = r;
		while (p < m.length && isZero(m[p]![c]!)) p++;
		if (p === m.length) continue;
		[m[r], m[p]] = [m[p]!, m[r]!];
		const pv = m[r]![c]!;
		m[r] = m[r]!.map((v) => qDiv(v, pv));
		for (let k = 0; k < m.length; k++) {
			if (k === r || isZero(m[k]![c]!)) continue;
			const f = m[k]![c]!;
			m[k] = m[k]!.map((v, j) => qSub(v, qMul(f, m[r]![j]!)));
		}
		pivots.push(c);
		r++;
	}
	const free: number[] = [];
	for (let c = 0; c < cols; c++) if (!pivots.includes(c)) free.push(c);
	return free.map((f) => {
		const v: Q[] = Array.from({ length: cols }, () => q(0n));
		v[f] = q(1n);
		pivots.forEach((pc, row) => {
			v[pc] = q(-m[row]![f]!.n, m[row]![f]!.d);
		});
		return v;
	});
}

/** Smallest whole numbers with the same ratios (signs kept). */
function toIntegers(v: Q[]): bigint[] {
	let lcm = 1n;
	for (const x of v) lcm = (lcm / (gcd(lcm, x.d) || 1n)) * x.d;
	const ints = v.map((x) => (x.n * lcm) / x.d);
	const g = ints.reduce((a, b) => gcd(a, b), 0n) || 1n;
	return ints.map((x) => x / g);
}

const listNames = (sp: Species[], idx: number[]): string[] => idx.map((i) => sp[i]!.source);

/** Balances a parsed reaction. */
export function balanceParsed(reaction: ParsedReaction): BalanceResult {
	const sp = reaction.species;
	const elements = [...new Set(sp.flatMap((s) => Object.keys(s.counts)))].sort();
	// An element on one side only can never be balanced: say which.
	const oneSided = elements.filter((el) => {
		const left = sp.some((s) => s.side === "left" && (s.counts[el] ?? 0) > 0);
		const right = sp.some((s) => s.side === "right" && (s.counts[el] ?? 0) > 0);
		return left !== right;
	});
	if (oneSided.length > 0) return fail("one-sided", `${oneSided.join(", ")} appear${oneSided.length === 1 ? "s" : ""} on one side only.`, oneSided);
	const sign = (s: Species) => (s.side === "left" ? 1 : -1);
	const rows: number[][] = elements.map((el) => sp.map((s) => sign(s) * (s.counts[el] ?? 0)));
	if (sp.some((s) => s.charge !== 0)) rows.push(sp.map((s) => sign(s) * s.charge));
	const basis = nullspace(rows, sp.length);
	if (basis.length === 0) return fail("unbalanceable", "These species cannot be balanced: no set of coefficients keeps every element and the charge equal.");
	if (basis.length > 1) {
		const sample = basis.map((b) => toIntegers(b).map((x) => x.toString()).join(" "));
		return fail("ambiguous", `${basis.length} independent balanced equations exist for these species; the reaction needs fewer or different species.`, sample);
	}
	let ints = toIntegers(basis[0]!);
	const unused = ints.map((x, i) => (x === 0n ? i : -1)).filter((i) => i >= 0);
	if (unused.length > 0) return fail("unused-species", "Some species would need a coefficient of 0: they do not belong in this reaction.", listNames(sp, unused));
	if (ints.some((x) => x < 0n) && ints.some((x) => x > 0n)) {
		const odd = ints.map((x, i) => (x < 0n ? i : -1)).filter((i) => i >= 0);
		const rest = ints.map((x, i) => (x > 0n ? i : -1)).filter((i) => i >= 0);
		return fail("unbalanceable", "No positive coefficients balance this reaction: some species would have to move to the other side.", listNames(sp, odd.length <= rest.length ? odd : rest));
	}
	if (ints[0]! < 0n) ints = ints.map((x) => -x);
	if (ints.some((x) => x > BigInt(COUNT_MAX))) return fail("too-large", "The coefficients are too large.");
	const coefficients = ints.map((x) => Number(x));
	const text = formatReaction(reaction, coefficients);
	const changed = coefficients.some((c, i) => c !== sp[i]!.coefficient);
	return { ok: true, reaction, coefficients, text, changed };
}

/** The reaction with these coefficients (1 is left out), species and arrow as typed. */
export function formatReaction(reaction: ParsedReaction, coefficients: readonly number[]): string {
	const side = (which: "left" | "right") =>
		reaction.species
			.map((s, i) => ({ s, c: coefficients[i]! }))
			.filter((x) => x.s.side === which)
			.map((x) => (x.c === 1 ? x.s.source : `${x.c} ${x.s.source}`))
			.join(" + ");
	return `${side("left")} ${reaction.arrow} ${side("right")}`;
}

/** Parses and balances one typed reaction. */
export function balanceReaction(input: string): BalanceResult {
	const parsed = parseReaction(input);
	if (!parsed.ok) return parsed;
	return balanceParsed(parsed.reaction);
}

// --- text boxes ----------------------------------------------------------------------------------------------------

export interface LineResult {
	/** 0-based line of the text. */
	line: number;
	before: string;
	/** The balanced line; null when it failed. */
	after: string | null;
	changed: boolean;
	error?: ChemError;
}

export interface TextBalance {
	lines: LineResult[];
	/** The whole text with the balanced lines in place of the originals (failed lines untouched). */
	text: string;
	/** Lines that were rewritten. */
	changed: number;
	/** Lines that have an arrow and could not be balanced. */
	failed: number;
	/** Lines that are balanced already. */
	same: number;
}

const LEAD = /^(\s*(?:\d+[.)]\s+|[-*•]\s+)?(?:[^:\n]{0,40}:\s+(?=\S))?)/;

/** Splits a line into text before the reaction, the reaction and the trailing punctuation. */
function frame(line: string): { head: string; core: string; tail: string } {
	let head = "";
	let rest = line;
	const m = LEAD.exec(rest);
	if (m && m[1] && !ARROW_TEST.test(m[1].replace(/:\s*$/, ""))) {
		head = m[1];
		rest = rest.slice(head.length);
	}
	const t = /[\s.;,]*$/.exec(rest);
	const tail = t ? t[0] : "";
	return { head, core: rest.slice(0, rest.length - tail.length), tail };
}

const ARROW_TEST = /<[-=]{1,3}>|[-=]{1,3}>|<[-=]{1,3}|⇌|⇄|⇋|↔|→|⟶|⟹|⇒|⟷|=/;

/** True when the text holds a line that parses as a reaction (a cheap test for the contextual bar). */
export function hasReaction(text: string): boolean {
	if (text.length > CHEM_TEXT_MAX || !ARROW_TEST.test(text)) return false;
	return plain(text).split("\n").some((line) => {
		const { core } = frame(line);
		return ARROW_TEST.test(core) && parseReaction(core).ok;
	});
}

/** Balances every line of a text that holds a reaction; other lines are left alone. */
export function balanceText(text: string): TextBalance {
	const original = text.split("\n");
	const lines: LineResult[] = [];
	const out = [...original];
	let changed = 0;
	let failed = 0;
	let same = 0;
	original.forEach((raw, i) => {
		const line = raw.replace(/\r$/, "");
		const cr = raw.endsWith("\r") ? "\r" : "";
		if (!ARROW_TEST.test(plain(line))) return;
		const f = frame(line);
		if (!ARROW_TEST.test(plain(f.core))) return;
		const r = balanceReaction(f.core);
		if (!r.ok) {
			// A sentence with an "=" or an arrow in it is not a reaction: not worth a failure. Formulas never hold three lowercase letters in a row.
			if (r.error.code === "unknown-element" || r.error.code === "bad-formula" || r.error.code === "bad-charge" || r.error.code === "empty-side" || r.error.code === "no-arrow" || r.error.code === "many-arrows") {
				if (/[a-z]{3,}/.test(plain(f.core)) || !/[-=]>|→|⇌|⇄|↔|⟶|⇒/.test(plain(f.core))) return;
			}
			failed++;
			lines.push({ line: i, before: line, after: null, changed: false, error: r.error });
			return;
		}
		const after = f.head + r.text + f.tail;
		if (r.changed) {
			changed++;
			out[i] = after + cr;
		} else same++;
		lines.push({ line: i, before: line, after, changed: r.changed });
	});
	return { lines, text: out.join("\n"), changed, failed, same };
}

// --- LaTeX / mhchem ------------------------------------------------------------------------------------------------

/** The plain spelling of a small LaTeX/mhchem chemistry source (one reaction per `\\` line). */
export function latexToPlain(latex: string): string {
	let s = latex;
	for (let i = 0; i < 4; i++) s = s.replace(/\\(?:ce|text|mathrm|textrm|mathit|rm)\s*\{([^{}]*)\}/g, "$1");
	s = s
		.replace(/\\(?:rightleftharpoons|leftrightharpoons|rightleftarrows|Leftrightarrow|leftrightarrow)\b/g, "⇌")
		.replace(/\\(?:longrightarrow|rightarrow|Rightarrow|longrightarrow|to)\b/g, "→")
		.replace(/\\cdot\b/g, "·")
		.replace(/\\(?:quad|qquad)\b|\\[,;:!]/g, " ")
		.replace(/~/g, " ")
		.replace(/_\{([^{}]*)\}/g, "$1")
		.replace(/_([A-Za-z0-9])/g, "$1")
		.replace(/\^\{([^{}]*)\}/g, "^$1")
		.replace(/&/g, " ")
		.replace(/\\\\/g, "\n");
	return s;
}

/** True when a LaTeX source holds a reaction. */
export function hasLatexReaction(latex: string): boolean {
	return latex.length <= CHEM_TEXT_MAX && hasReaction(latexToPlain(latex));
}

/** Balances the reactions of an equation's LaTeX; the result is mhchem (`\ce{...}`), one line per reaction. */
export function balanceLatex(latex: string): { balance: TextBalance; latex: string } {
	const balance = balanceText(latexToPlain(latex));
	const lines = balance.text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
	return { balance, latex: lines.map((l) => `\\ce{${l}}`).join(" \\\\ ") };
}
