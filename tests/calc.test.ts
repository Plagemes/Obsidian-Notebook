import { describe, expect, it } from "vitest";
import { CalcSession, evaluate, functionNames } from "../src/math/calc";
import { DEFAULT_FORMAT, equationLatex, formatNumber, formatValue, normaliseFormat, type FormatOptions } from "../src/math/calc-format";
import { CONSTANTS, lookupConstant } from "../src/math/calc-constants";
import { parseUnitText, lookupUnit, formatUnit } from "../src/math/calc-units";
import { restoreSession, saveSession } from "../src/math/calc-state";

function run(src: string, session = new CalcSession(), o: FormatOptions = DEFAULT_FORMAT): string {
	const r = evaluate(src, session);
	if (!r.ok) return `ERR:${r.code}`;
	if (r.kind === "defn") return `fn:${r.name}`;
	const f = formatValue(r.value, o);
	return f.approx ? `${f.text} ≈ ${f.approx}` : f.text;
}

const num = (src: string, session = new CalcSession()): number => {
	const r = evaluate(src, session);
	if (!r.ok || r.kind === "defn") throw new Error(`${src}: ${r.ok ? "defn" : r.code}`);
	return Number(formatValue(r.value, { ...DEFAULT_FORMAT, sig: 15 }).text);
};

describe("calculator: exact numbers and precision", () => {
	it("keeps fractions exact", () => {
		expect(run("1/3 + 1/6")).toBe("1/2 ≈ 0.5");
		expect(run("1/3 * 3")).toBe("1");
		expect(run("7/12")).toBe("7/12 ≈ 0.583333333333");
		expect(run("2^-3")).toBe("1/8 ≈ 0.125");
		expect(run("(2/3)^3")).toBe("8/27 ≈ 0.296296296296");
		expect(run("-3/4")).toBe("-3/4 ≈ -0.75");
	});

	it("adds decimals without floating-point noise", () => {
		expect(run("0.1 + 0.2")).toBe("0.3");
		expect(run("1.1 * 1.1")).toBe("1.21");
		expect(run("0.3 - 0.1")).toBe("0.2");
		expect(run("1e-3 * 1e3")).toBe("1");
	});

	it("does big integers exactly", () => {
		expect(run("20!")).toBe("2432902008176640000");
		expect(run("2^100")).toBe("1267650600228229401496703205376");
		expect(run("nCr(52, 5)")).toBe("2598960");
		expect(run("gcd(84, 36)")).toBe("12");
		expect(run("lcm(4, 6)")).toBe("12");
	});

	it("formats with significant figures and notation", () => {
		const o = (sig: number, notation: FormatOptions["notation"] = "auto"): FormatOptions => ({ ...DEFAULT_FORMAT, sig, notation });
		expect(run("1/3", new CalcSession(), { ...o(4), fractions: "decimal" })).toBe("0.3333");
		expect(run("2.5", new CalcSession(), o(4))).toBe("2.500");
		expect(run("123456.789", new CalcSession(), o(3))).toBe("123000");
		expect(run("0.000123456", new CalcSession(), o(3))).toBe("0.000123");
		expect(run("123456", new CalcSession(), o(3, "sci"))).toBe("1.23 × 10⁵");
		expect(run("123456", new CalcSession(), o(4, "eng"))).toBe("123.5 × 10³");
		expect(run("0.00002", new CalcSession(), o(0, "eng"))).toBe("20 × 10⁻⁶");
		expect(run("10^15")).toBe("1000000000000000");
		expect(run("1e15")).toBe("1 × 10¹⁵");
		expect(run("1e20 + 0.5")).toBe("1 × 10²⁰");
		expect(run("pi")).toBe("3.14159265359");
		expect(formatNumber(1.5e-10, DEFAULT_FORMAT, true)).toBe("1.5\\times 10^{-10}");
	});

	it("normalises stored formats", () => {
		expect(normaliseFormat({ sig: 99, notation: "x", fractions: "decimal" })).toEqual({ sig: 15, notation: "auto", fractions: "decimal" });
		expect(normaliseFormat({ sig: 1 }).sig).toBe(3);
		expect(normaliseFormat(null)).toEqual(DEFAULT_FORMAT);
	});
});

describe("calculator: angles", () => {
	it("follows the angle mode and the units", () => {
		const deg = new CalcSession();
		expect(run("sin(30)", deg)).toBe("0.5");
		expect(run("cos(60)", deg)).toBe("0.5");
		expect(run("sin(180)", deg)).toBe("0");
		expect(run("asin(1)", deg)).toBe("90");
		expect(run("sin(30 deg)", deg)).toBe("0.5");
		const rad = new CalcSession();
		rad.angle = "rad";
		expect(run("sin(pi/2)", rad)).toBe("1");
		expect(run("sin(30 deg)", rad)).toBe("0.5");
		expect(run("acos(0)", rad)).toBe("1.57079632679");
		expect(run("pi rad to deg", rad)).toBe("180 deg");
	});

	it("refuses values out of range", () => {
		expect(run("asin(2)")).toBe("ERR:domain");
		expect(run("sin(5 m)")).toBe("ERR:need-angle");
	});
});

describe("calculator: units", () => {
	it("converts", () => {
		expect(run("3 km/h to m/s")).toBe("0.833333333333 m/s");
		expect(run("1 mi to km")).toBe("1.609344 km");
		expect(run("100 degC to K")).toBe("373.15 K");
		expect(run("32 degF to degC")).toBe("0 degC");
		expect(run("1 atm to Pa")).toBe("101325 Pa");
		expect(run("2 h to min")).toBe("120 min");
		expect(run("1 L to mL")).toBe("1000 mL");
		expect(run("5 kg to lb")).toBe("11.0231131092 lb");
		expect(run("60 mph to km/h")).toBe("96.56064 km/h");
	});

	it("does arithmetic with units", () => {
		expect(run("3 km + 200 m")).toBe("3.2 km");
		expect(run("200 m + 3 km")).toBe("3200 m");
		expect(run("2 h * 30 km/h")).toBe("60 km");
		expect(run("10 m / 2 s")).toBe("5 m/s");
		expect(run("6 m / 2 m")).toBe("3");
		expect(run("1 km / 1 m")).toBe("1000");
		expect(run("(3 m)^2")).toBe("9 m²");
		expect(run("sqrt(9 m^2)")).toBe("3 m");
		expect(run("5 N * 2 m to J")).toBe("10 J");
		expect(run("2 kg * 9.8 m/s^2")).toBe("19.6 N");
		expect(run("1 h + 30 min")).toBe("1.5 h");
	});

	it("rejects mismatched units", () => {
		expect(run("3 m + 2 s")).toBe("ERR:dim-mismatch");
		expect(run("3 m to s")).toBe("ERR:convert-mismatch");
		expect(run("3 foo")).toBe("ERR:unknown-name");
		expect(run("3 m to foo")).toBe("ERR:unknown-unit");
		expect(run("sin(3 m)")).toBe("ERR:need-angle");
		expect(run("2^(3 m)")).toBe("ERR:exponent-units");
	});

	it("reads g, h and m*g the documented way", () => {
		expect(run("3 g to kg")).toBe("0.003 kg");
		expect(run("2 h to min")).toBe("120 min");
		expect(run("g")).toBe("9.80665 m/s²");
		const s = new CalcSession();
		run("m = 5 kg", s);
		expect(run("m * g", s)).toBe("49.03325 N");
		expect(run("5 kg * g")).toBe("49.03325 N");
	});

	it("parses unit text", () => {
		expect(formatUnit(parseUnitText("kg*m/s^2"))).toBe("kg·m/s²");
		expect(formatUnit(parseUnitText("W/(m^2*K)"))).toBe("W/(m²·K)");
		expect(lookupUnit("km")?.scale).toBe(1000);
		expect(lookupUnit("MPa")?.scale).toBe(1e6);
		expect(lookupUnit("foo")).toBeNull();
		expect(() => parseUnitText("m/foo")).toThrow();
	});
});

describe("calculator: constants", () => {
	it("knows the physical constants by name with their units", () => {
		expect(run("c")).toBe("299792458 m/s");
		expect(run("h")).toBe("6.62607015 × 10⁻³⁴ kg·m²/s");
		expect(run("G")).toBe("6.6743 × 10⁻¹¹ m³/(kg·s²)");
		expect(run("2 * pi * 1 m")).toBe("6.28318530718 m");
		expect(run("kB * 300 K")).toBe("4.141947 × 10⁻²¹ J");
		expect(run("c^2 * 1 kg to J")).toBe("8.98755178737 × 10¹⁶ J");
		expect(CONSTANTS.length).toBeGreaterThanOrEqual(15);
		expect(lookupConstant("NA")?.value).toBe(6.02214076e23);
		expect(new Set(CONSTANTS.flatMap((c) => c.names)).size).toBe(CONSTANTS.flatMap((c) => c.names).length);
	});
});

describe("calculator: variables and functions", () => {
	it("keeps variables and ans", () => {
		const s = new CalcSession();
		expect(run("a = 3.2", s)).toBe("3.2");
		expect(run("a * 2", s)).toBe("6.4");
		expect(run("ans + 1", s)).toBe("7.4");
		expect(run("b = a^2 + 1", s)).toBe("11.24");
		expect(run("dist = 5 m", s)).toBe("5 m");
		expect(run("dist * 2", s)).toBe("10 m");
		expect(run("zzz", s)).toBe("ERR:unknown-name");
	});

	it("defines functions", () => {
		const s = new CalcSession();
		expect(run("f(x) = x^2 + 1", s)).toBe("fn:f");
		expect(run("f(3)", s)).toBe("10");
		expect(run("g2(a, b) = a*b", s)).toBe("fn:g2");
		expect(run("g2(3, 4) + f(1)", s)).toBe("14");
		expect(run("f(1, 2)", s)).toBe("ERR:arity");
		expect(run("h2(x) = y + 1", s)).toBe("ERR:unknown-name");
		expect(run("r(n) = n * r(n - 1)", s)).toBe("ERR:unknown-function");
	});

	it("refuses reserved names", () => {
		expect(run("pi = 3")).toBe("ERR:reserved-name");
		expect(run("sin = 3")).toBe("ERR:reserved-name");
		expect(run("ans = 3")).toBe("ERR:reserved-name");
	});

	it("saves and restores", () => {
		const s = new CalcSession();
		run("a = 3.2", s);
		run("m = 5 kg", s);
		run("t = 1/3", s);
		run("z = 2 + 3i", s);
		run("M = [1, 2; 3, 4]", s);
		run("f(x) = a * x", s);
		const saved = JSON.parse(JSON.stringify(saveSession(s))) as unknown;
		const t = new CalcSession();
		restoreSession(t, saved);
		expect(run("a * 2", t)).toBe("6.4");
		expect(run("m * 2", t)).toBe("10 kg");
		expect(run("t * 3", t)).toBe("1");
		expect(run("z * i", t)).toBe("-3 + 2i");
		expect(run("det(M)", t)).toBe("-2");
		expect(run("f(2)", t)).toBe("6.4");
	});

	it("restores leniently", () => {
		const t = new CalcSession();
		restoreSession(t, { a: { kind: "val", value: { t: "q", v: { x: 1 }, dim: [0, 0, 0, 0, 0, 0, 0], unit: null, dec: true } }, "bad name!": 1, b: { kind: "val", value: { t: "q", v: "no" } }, c: 5, sin: { kind: "val", value: null } });
		expect([...t.vars.keys()]).toEqual(["a"]);
		restoreSession(t, "nonsense");
		restoreSession(t, null);
		restoreSession(t, [1, 2]);
		expect(t.vars.size).toBe(1);
	});
});

describe("calculator: complex numbers", () => {
	it("does complex arithmetic", () => {
		expect(run("(1 + 2i) * (3 - i)")).toBe("5 + 5i");
		expect(run("i^2")).toBe("-1");
		expect(run("sqrt(-4)")).toBe("2i");
		expect(run("sqrt(-2)")).toBe("1.41421356237i");
		expect(run("abs(3 + 4i)")).toBe("5");
		expect(run("conj(1 + 2i)")).toBe("1 - 2i");
		expect(run("(1 + 2i) / (3 - i)")).toBe("0.1 + 0.7i");
		expect(run("re(2 + 3i) + im(2 + 3i)")).toBe("5");
		expect(run("exp(i * pi)")).toBe("-1");
		expect(run("(-8)^(1/3)")).toBe("1 + 1.73205080757i");
		expect(run("ln(-1)")).toBe("3.14159265359i");
	});
});

describe("calculator: matrices and vectors", () => {
	it("computes with matrices, exactly", () => {
		expect(run("[1, 2; 3, 4] * [5, 6; 7, 8]")).toBe("[19, 22; 43, 50]");
		expect(run("det([1, 2; 3, 4])")).toBe("-2");
		expect(run("inv([1, 2; 3, 4])")).toBe("[-2, 1; 3/2, -1/2]");
		expect(run("transpose([1, 2, 3])")).toBe("[1; 2; 3]");
		expect(run("[1, 2; 3, 4]^2")).toBe("[7, 10; 15, 22]");
		expect(run("2 * [1, 2]")).toBe("[2, 4]");
		expect(run("[1, 2] + [3, 4]")).toBe("[4, 6]");
		expect(run("trace([1, 2; 3, 4])")).toBe("5");
		expect(run("identity(2)")).toBe("[1, 0; 0, 1]");
		expect(run("[[1, 2], [3, 4]]")).toBe("[1, 2; 3, 4]");
		expect(run("det([2, 0, 0; 0, 3, 0; 0, 0, 4])")).toBe("24");
	});

	it("does vectors", () => {
		expect(run("dot([1, 2, 3], [4, 5, 6])")).toBe("32");
		expect(run("cross([1, 0, 0], [0, 1, 0])")).toBe("[0, 0, 1]");
		expect(run("norm([3, 4])")).toBe("5");
		expect(run("sqrt([4, 9])")).toBe("[2, 3]");
		expect(run("linsolve([2, 0; 0, 4], [2, 8])")).toBe("[1; 2]");
	});

	it("reports matrix errors", () => {
		expect(run("[1, 2] * [3, 4]")).toBe("ERR:matrix-shape");
		expect(run("inv([1, 2; 2, 4])")).toBe("ERR:matrix-singular");
		expect(run("det([1, 2, 3])")).toBe("ERR:matrix-square");
		expect(run("[1, 2; 3]")).toBe("ERR:matrix-shape");
		expect(run("[1, 2] + 1")).toBe("ERR:matrix-scalar-add");
		expect(run("[1 m, 2]")).toBe("ERR:matrix-units");
		expect(run("zeros(100)")).toBe("ERR:need-integer");
		expect(run("identity(50)")).toBe("ERR:need-integer");
		expect(run("1 / [1, 2]")).toBe("ERR:matrix-divide");
	});
});

describe("calculator: statistics", () => {
	it("summarises lists", () => {
		expect(run("sum([1, 2, 3, 4])")).toBe("10");
		expect(run("mean([1, 2, 3, 4])")).toBe("5/2 ≈ 2.5");
		expect(run("median([5, 1, 3])")).toBe("3");
		expect(run("median([4, 1, 3, 2])")).toBe("5/2 ≈ 2.5");
		expect(run("mode([1, 2, 2, 3])")).toBe("2");
		expect(run("std([2, 4, 4, 4, 5, 5, 7, 9])")).toBe("2.1380899353");
		expect(run("stdp([2, 4, 4, 4, 5, 5, 7, 9])")).toBe("2");
		expect(run("var([1, 2, 3, 4])")).toBe("1.66666666667");
		expect(run("min(3, 1, 2)")).toBe("1");
		expect(run("max([3, 9, 2])")).toBe("9");
		expect(run("span([3, 9, 2])")).toBe("7");
		expect(run("count([1, 2, 3])")).toBe("3");
		expect(run("quantile([1, 2, 3, 4, 5], 0.5)")).toBe("3");
		expect(run("sort([3, 1, 2])")).toBe("[1, 2, 3]");
		expect(run("seq(1, 5)")).toBe("[1, 2, 3, 4, 5]");
		expect(run("sum(seq(1, 100))")).toBe("5050");
	});

	it("keeps units on a list's summary", () => {
		expect(run("mean(2 m, 4 m)")).toBe("3 m");
		expect(run("max(1 km, 500 m)")).toBe("1 km");
		expect(run("sum(1 m, 1 s)")).toBe("ERR:dim-mismatch");
	});

	it("fits a line", () => {
		expect(run("slope([1, 2, 3], [2, 4, 6])")).toBe("2");
		expect(run("intercept([1, 2, 3], [3, 5, 7])")).toBe("1");
		expect(run("corr([1, 2, 3], [2, 4, 6])")).toBe("1");
	});

	it("reports statistics errors", () => {
		expect(run("mode([1, 2, 3])")).toBe("ERR:no-mode");
		expect(run("var([1])")).toBe("ERR:need-two");
		expect(run("median([])")).toBe("ERR:empty-matrix");
		expect(run("slope([1, 2], [1, 2, 3])")).toBe("ERR:matrix-shape");
	});
});

describe("calculator: numeric solver", () => {
	it("finds roots", () => {
		expect(run("solve(x^2 = 4, x)")).toBe("[-2, 2]");
		expect(run("solve(2x + 3 = 11, x)")).toBe("4");
		expect(run("solve(x^2 - 2 = 0, x, 0, 5)")).toBe("1.41421356237");
		const rad = new CalcSession();
		rad.angle = "rad";
		expect(num("solve(cos(x) = x, x, 0, 1)", rad)).toBeCloseTo(0.7390851332, 8);
		expect(run("solve(x^2 + 1, x)")).toBe("ERR:no-solution");
		expect(run("solve((x - 1)^2 = 0, x)")).toBe("1");
		expect(run("solve(x^3 - x = 0, x)")).toBe("[-1, 0, 1]");
		expect(run("solve(1/x = 0, x)")).toBe("ERR:no-solution");
		expect(num("solve(exp(x) = 5, x)")).toBeCloseTo(Math.log(5), 10);
	});

	it("integrates and differentiates", () => {
		expect(run("integrate(x^2, x, 0, 3)")).toBe("9");
		const rad = new CalcSession();
		rad.angle = "rad";
		expect(num("integrate(sin(x), x, 0, pi)", rad)).toBeCloseTo(2, 8);
		expect(run("diff(x^3, x, 2)")).toBe("12");
		expect(run("diff(x^2, y, 2)")).toBe("ERR:domain");
	});

	it("uses the person's variables and functions", () => {
		const s = new CalcSession();
		run("k = 3", s);
		run("f(x) = x^2 - k", s);
		expect(run("solve(f(x) = 0, x, 0, 10)", s)).toBe("1.73205080757");
	});
});

describe("calculator: syntax", () => {
	it("reads what is written on paper", () => {
		expect(run("2(3 + 4)")).toBe("14");
		expect(run("(1 + 2)(3 + 4)")).toBe("21");
		expect(run("3 pi")).toBe("9.42477796077");
		expect(run("2 sqrt(9)")).toBe("6");
		expect(run("√16")).toBe("4");
		expect(run("√(2 + 2)")).toBe("2");
		expect(run("3²")).toBe("9");
		expect(run("2⁻¹")).toBe("1/2 ≈ 0.5");
		expect(run("2 ** 3")).toBe("8");
		expect(run("6 ÷ 3 × 2")).toBe("4");
		expect(run("8 − 3")).toBe("5");
		expect(run("2^3^2")).toBe("512");
		expect(run("-2^2")).toBe("-4");
		expect(run("2^-2")).toBe("1/4 ≈ 0.25");
		expect(run("mod(10, 3)")).toBe("1");
		expect(run("4!")).toBe("24");
		expect(run("(2 + 3)!")).toBe("120");
		expect(run("1.5e3")).toBe("1500");
		expect(run(".5 + .25")).toBe("0.75");
		expect(run("  7 ")).toBe("7");
		expect(run("round(2.567, 1)")).toBe("2.6");
		expect(run("floor(-2.5)")).toBe("-3");
		expect(run("pi/2 to deg")).toBe("90 deg");
	});

	it("does not mistake exponents for constants", () => {
		expect(run("2e")).toBe("5.43656365692");
		expect(run("2e3")).toBe("2000");
		expect(run("2 eV to J")).toBe("3.204353268 × 10⁻¹⁹ J");
	});

	it("keeps a user variable over a unit or a constant", () => {
		const s = new CalcSession();
		run("m = 4", s);
		expect(run("3 m", s)).toBe("12");
		expect(run("3 * 1 km", s)).toBe("3 km");
		run("c = 2", s);
		expect(run("c * 3", s)).toBe("6");
	});
});

describe("calculator: errors and limits", () => {
	it("explains errors", () => {
		expect(run("1/0")).toBe("ERR:div-zero");
		expect(run("0^-1")).toBe("ERR:div-zero");
		expect(run("(1 +")).toBe("ERR:incomplete");
		expect(run("1 +* 2")).toBe("ERR:unexpected");
		expect(run("2 $ 3")).toBe("ERR:bad-char");
		expect(run("")).toBe("ERR:empty");
		expect(run("sin()")).toBe("ERR:arity");
		expect(run("nope(3)")).toBe("ERR:unknown-function");
		expect(run("ln(0)")).toBe("ERR:domain");
		expect(run("(1")).toBe("ERR:paren-open");
		expect(run("1)")).toBe("ERR:paren-close");
		expect(run("[1, 2")).toBe("ERR:bracket-open");
	});

	it("is bounded", () => {
		expect(run("2^100000")).toBe("ERR:too-big");
		expect(run("5000!")).toBe("ERR:too-big");
		expect(run("1".repeat(1001))).toBe("ERR:too-long");
		expect(run(`${"(".repeat(200)}1${")".repeat(200)}`)).toBe("ERR:too-deep");
		expect(run(`${"-".repeat(200)}1`)).toBe("ERR:too-deep");
		expect(run("f(x) = f2(x)")).toBe("ERR:unknown-function");
	});

	it("never runs code", () => {
		for (const bad of ["constructor", "__proto__", "this", "process", "window", "toString", "eval(1)", "Function(1)"]) {
			expect(run(bad).startsWith("ERR:"), bad).toBe(true);
		}
		const s = new CalcSession();
		expect(run("x = 1", s)).toBe("1");
		expect(run("__proto__ = 5", s)).toBe("5");
		expect(Object.getPrototypeOf({})).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(functionNames()).not.toContain("eval");
	});

	it("limits user functions and variables", () => {
		const s = new CalcSession();
		for (let i = 0; i < 64; i++) expect(evaluate(`v${i} = ${i}`, s).ok).toBe(true);
		expect(run("extra = 1", s)).toBe("ERR:too-many-vars");
		expect(run("v3 = 9", s)).toBe("9");
	});
});

describe("calculator: LaTeX", () => {
	const latex = (src: string): string => {
		const s = new CalcSession();
		const r = evaluate(src, s);
		if (!r.ok || r.kind === "defn") throw new Error(src);
		return equationLatex(r.node, formatValue(r.value, DEFAULT_FORMAT));
	};
	it("writes the expression with its result", () => {
		expect(latex("1/2 + 1/3")).toBe("\\frac{1}{2} + \\frac{1}{3} = \\frac{5}{6}");
		expect(latex("sqrt(16)")).toBe("\\sqrt{16} = 4");
		expect(latex("2^10")).toBe("2^{10} = 1024");
		expect(latex("sin(30)")).toBe("\\sin\\left(30\\right) = 0.5");
		expect(latex("3 km/h to m/s")).toBe("3\\,\\mathrm{km/h}\\to \\mathrm{m/s} = 0.833333333333\\,\\mathrm{m/s}");
		expect(latex("[1, 2; 3, 4]")).toBe("\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix} = \\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}");
		expect(latex("(1 + 2)^2")).toBe("\\left(1 + 2\\right)^{2} = 9");
		expect(latex("2 * 3")).toBe("2\\cdot 3 = 6");
		expect(latex("pi * 2")).toBe("\\pi\\cdot 2 = 6.28318530718");
		expect(latex("5 N*m")).toBe("5\\,\\mathrm{N\\cdot m} = 5\\,\\mathrm{N\\cdot m}");
		expect(latex("1.5e-3 * 2")).toBe("1.5\\times 10^{-3}\\cdot 2 = 0.003");
	});
});
