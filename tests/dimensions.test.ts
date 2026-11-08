/**
 * Dimensional analysis of formulas (#293): units and prefixes, derived units, propagation through the operators,
 * symbols bound by a value or declared, LaTeX forms (fractions, roots, powers, derivatives, integrals, sums), plain
 * text, the issues reported and the guarantees (unknown symbols never flag, hostile text never throws).
 */
import { describe, expect, it } from "vitest";
import {
	analyzeDimensions,
	cleanFormulaText,
	describeDimension,
	dimensionOf,
	DIMENSIONLESS,
	dimEqual,
	DIMENSIONS_TEXT_MAX,
	formatDimension,
	isDimensionless,
	parseUnit,
	quantityName,
	type Dim,
} from "../src/math/dimensions";

const si = (text: string): string | null => {
	const d = parseUnit(text);
	return d ? formatDimension(d) : null;
};
const kinds = (src: string, opts = {}): string[] => analyzeDimensions(src, opts).issues.map((i) => i.kind);
const clean = (src: string, opts = {}): boolean => analyzeDimensions(src, opts).issues.length === 0;
const dimOf = (src: string, opts = {}): string | null => {
	const d = dimensionOf(src, opts);
	return d ? formatDimension(d) : null;
};

describe("units", () => {
	it("reads the SI base units", () => {
		expect(si("m")).toBe("m");
		expect(si("kg")).toBe("kg");
		expect(si("g")).toBe("kg");
		expect(si("s")).toBe("s");
		expect(si("A")).toBe("A");
		expect(si("K")).toBe("K");
		expect(si("mol")).toBe("mol");
		expect(si("cd")).toBe("cd");
	});

	it("reads the derived units with a name", () => {
		expect(si("N")).toBe("kg·m/s²");
		expect(si("J")).toBe("kg·m²/s²");
		expect(si("W")).toBe("kg·m²/s³");
		expect(si("Pa")).toBe("kg/(m·s²)");
		expect(si("Hz")).toBe("1/s");
		expect(si("C")).toBe("s·A");
		expect(si("V")).toBe("kg·m²/(s³·A)");
		expect(si("Ω")).toBe("kg·m²/(s³·A²)");
		expect(si("\\Omega")).toBe("kg·m²/(s³·A²)");
		expect(si("S")).toBe("s³·A²/(kg·m²)");
		expect(si("F")).toBe("s⁴·A²/(kg·m²)");
		expect(si("H")).toBe("kg·m²/(s²·A²)");
		expect(si("Wb")).toBe("kg·m²/(s²·A)");
		expect(si("T")).toBe("kg/(s²·A)");
		expect(si("lx")).toBe("cd/m²");
		expect(si("Gy")).toBe("m²/s²");
		expect(si("kat")).toBe("mol/s");
	});

	it("reads prefixes, including the ambiguous ones", () => {
		expect(si("km")).toBe("m");
		expect(si("mm")).toBe("m");
		expect(si("µs")).toBe("s");
		expect(si("\\mu s")).toBe("s");
		expect(si("μs")).toBe("s");
		expect(si("ns")).toBe("s");
		expect(si("MHz")).toBe("1/s");
		expect(si("kPa")).toBe("kg/(m·s²)");
		expect(si("hPa")).toBe("kg/(m·s²)");
		expect(si("mmol")).toBe("mol");
		expect(si("mg")).toBe("kg");
		expect(si("daN")).toBe("kg·m/s²");
		// the unit wins over prefix + unit
		expect(si("min")).toBe("s");
		expect(si("Pa")).toBe("kg/(m·s²)");
		expect(si("cd")).toBe("cd");
		expect(si("Tm")).toBe("m");
		expect(si("T")).toBe("kg/(s²·A)");
	});

	it("reads common non-SI units", () => {
		expect(si("h")).toBe("s");
		expect(si("L")).toBe("m³");
		expect(si("mL")).toBe("m³");
		expect(si("t")).toBe("kg");
		expect(si("eV")).toBe("kg·m²/s²");
		expect(si("keV")).toBe("kg·m²/s²");
		expect(si("kWh")).toBe("kg·m²/s²");
		expect(si("bar")).toBe("kg/(m·s²)");
		expect(si("atm")).toBe("kg/(m·s²)");
		expect(si("kcal")).toBe("kg·m²/s²");
		expect(si("ft")).toBe("m");
		expect(si("lb")).toBe("kg");
		expect(si("rpm")).toBe("1/s");
		expect(si("°C")).toBe("K");
		expect(si("rad")).toBe("1");
		expect(si("°")).toBe("1");
		expect(si("%")).toBe("1");
	});

	it("reads products, quotients and powers", () => {
		expect(si("m/s")).toBe("m/s");
		expect(si("m/s^2")).toBe("m/s²");
		expect(si("m s^{-2}")).toBe("m/s²");
		expect(si("m s^-2")).toBe("m/s²");
		expect(si("kg·m^2·s^{-2}")).toBe("kg·m²/s²");
		expect(si("kg m^2 / s^2")).toBe("kg·m²/s²");
		expect(si("N m")).toBe("kg·m²/s²");
		expect(si("N*m")).toBe("kg·m²/s²");
		expect(si("J/(kg K)")).toBe("m²/(s²·K)");
		expect(si("J/(kg·K)")).toBe("m²/(s²·K)");
		expect(si("1/s")).toBe("1/s");
		expect(si("m^{1/2}")).toBe("m^(1/2)");
		expect(si("m²")).toBe("m²");
		expect(si("s⁻¹")).toBe("1/s");
		expect(si("m·s⁻²")).toBe("m/s²");
		expect(si("km/h")).toBe("m/s");
		expect(si("mol/L")).toBe("mol/m³");
	});

	it("reads LaTeX wrappers around units", () => {
		expect(si("\\mathrm{m/s}")).toBe("m/s");
		expect(si("\\mathrm{kg\\,m^2\\,s^{-2}}")).toBe("kg·m²/s²");
		expect(si("\\text{N}\\cdot\\text{m}")).toBe("kg·m²/s²");
		expect(si("\\frac{\\mathrm{m}}{\\mathrm{s}^2}")).toBe("m/s²");
		expect(si("\\mathrm{m}\\mathrm{s}^{-1}")).toBe("m/s");
		expect(si("\\mathrm{^\\circ C}")).toBe("K");
	});

	it("refuses what is not a unit", () => {
		expect(si("")).toBeNull();
		expect(si("foo")).toBeNull();
		expect(si("kgm")).toBeNull();
		expect(si("m/")).toBeNull();
		expect(si("m^")).toBeNull();
		expect(si("(m")).toBeNull();
		expect(si("m^{x}")).toBeNull();
		expect(si("x".repeat(500))).toBeNull();
	});
});

describe("naming dimensions", () => {
	it("gives SI text and the quantity", () => {
		expect(describeDimension(parseUnit("N")!)).toEqual({ si: "kg·m/s²", quantity: "force" });
		expect(describeDimension(parseUnit("m/s")!)).toEqual({ si: "m/s", quantity: "velocity" });
		expect(describeDimension(parseUnit("m")!).quantity).toBe("length");
		expect(describeDimension(parseUnit("J")!).quantity).toBe("energy");
		expect(describeDimension(parseUnit("W")!).quantity).toBe("power");
		expect(describeDimension(parseUnit("Pa")!).quantity).toBe("pressure");
		expect(describeDimension(parseUnit("kg m/s")!).quantity).toBe("momentum");
		expect(describeDimension(parseUnit("m^3 kg^2")!).quantity).toBeNull();
		expect(formatDimension(DIMENSIONLESS)).toBe("1");
		expect(quantityName(DIMENSIONLESS)).toBe("dimensionless");
	});

	it("compares dimensions with a tolerance", () => {
		const a: Dim = [1, 0, -1, 0, 0, 0, 0];
		expect(dimEqual(a, parseUnit("m/s")!)).toBe(true);
		expect(dimEqual(a, parseUnit("m")!)).toBe(false);
		expect(isDimensionless(parseUnit("m/m")!)).toBe(true);
		expect(isDimensionless(a)).toBe(false);
	});
});

describe("sums", () => {
	it("flags adding length to time", () => {
		const r = analyzeDimensions("5\\,\\mathrm{m} + 3\\,\\mathrm{s}");
		expect(r.issues).toHaveLength(1);
		const i = r.issues[0]!;
		expect(i.kind).toBe("sum");
		expect(i.op).toBe("+");
		expect(i.left).toBe("5 m");
		expect(i.right).toBe("3 s");
		expect(i.message).toContain("Cannot add");
		expect(i.message).toContain("length, m");
		expect(i.message).toContain("time, s");
	});

	it("flags subtracting, with the right verb", () => {
		const i = analyzeDimensions("2\\,\\mathrm{kg} - 1\\,\\mathrm{N}").issues[0]!;
		expect(i.kind).toBe("sum");
		expect(i.op).toBe("-");
		expect(i.message).toContain("Cannot subtract");
		expect(i.message).toContain("mass, kg");
		expect(i.message).toContain("force, kg·m/s²");
	});

	it("accepts the same dimension in other units", () => {
		expect(clean("3\\,\\mathrm{m} + 2\\,\\mathrm{km} - 5\\,\\mathrm{cm}")).toBe(true);
		expect(clean("1\\,\\mathrm{h} + 30\\,\\mathrm{min} + 5\\,\\mathrm{s}")).toBe(true);
		expect(clean("2\\,\\mathrm{J} + 3\\,\\mathrm{N\\,m}")).toBe(true);
		expect(clean("1\\,\\mathrm{W\\,s} + 1\\,\\mathrm{J}")).toBe(true);
	});

	it("checks every term of a long sum against the first known one", () => {
		const r = analyzeDimensions("1\\,\\mathrm{m} + 2\\,\\mathrm{m} + 3\\,\\mathrm{m} + 4\\,\\mathrm{s} + 5\\,\\mathrm{m}");
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]!.right).toBe("4 s");
		expect(r.issues[0]!.left).toContain("1 m");
	});

	it("reports each bad term once and does not cascade", () => {
		const r = analyzeDimensions("1\\,\\mathrm{m} + 2\\,\\mathrm{s} + 3\\,\\mathrm{kg}");
		expect(r.issues).toHaveLength(1);
	});

	it("flags a bare number added to a quantity", () => {
		const i = analyzeDimensions("5\\,\\mathrm{m} + 3").issues[0]!;
		expect(i.kind).toBe("unit-missing");
		expect(i.bare).toBe("right");
		expect(i.message).toContain("a unit is missing");
		expect(analyzeDimensions("3 + 5\\,\\mathrm{m}").issues[0]!.bare).toBe("left");
	});

	it("lets zero stand for any dimension", () => {
		expect(clean("5\\,\\mathrm{m} + 0")).toBe(true);
		expect(clean("5\\,\\mathrm{m} - 5\\,\\mathrm{m} = 0")).toBe(true);
		expect(clean("x = 0 \\; \\mathrm{m}")).toBe(true);
	});

	it("adds dimensionless numbers freely", () => {
		expect(clean("1 + 2 + 3")).toBe(true);
		expect(clean("1 + 2\\,\\mathrm{rad}")).toBe(true);
		expect(clean("0.5 + 50\\%")).toBe(true);
	});

	it("handles parentheses and signs", () => {
		expect(clean("-(3\\,\\mathrm{m} + 4\\,\\mathrm{m})")).toBe(true);
		expect(kinds("(3\\,\\mathrm{m} + 4\\,\\mathrm{s}) + 5\\,\\mathrm{m}")).toEqual(["sum"]);
		expect(kinds("\\left(3\\,\\mathrm{m} + 4\\,\\mathrm{s}\\right)")).toEqual(["sum"]);
		expect(clean("+3\\,\\mathrm{m} - -2\\,\\mathrm{m}")).toBe(true);
		expect(kinds("3\\,\\mathrm{m} \\pm 1\\,\\mathrm{s}")).toEqual(["sum"]);
		expect(clean("3\\,\\mathrm{m} \\pm 1\\,\\mathrm{cm}")).toBe(true);
	});
});

describe("products, quotients and powers", () => {
	it("multiplies and divides dimensions", () => {
		expect(dimOf("3\\,\\mathrm{m} \\cdot 2\\,\\mathrm{s}")).toBe("m·s");
		expect(dimOf("6\\,\\mathrm{m} / 2\\,\\mathrm{s}")).toBe("m·s");
		expect(dimOf("\\frac{6\\,\\mathrm{m}}{2\\,\\mathrm{s}}")).toBe("m/s");
		expect(dimOf("3\\,\\mathrm{m} \\times 4\\,\\mathrm{m}")).toBe("m²");
		expect(dimOf("2\\,\\mathrm{kg}\\,\\mathrm{m}\\,\\mathrm{s}^{-2}")).toBe("kg·m/s²");
		expect(dimOf("\\frac{\\mathrm{m}}{\\mathrm{s}} \\cdot \\mathrm{s}")).toBe("m");
		expect(dimOf("\\mathrm{m} \\div \\mathrm{s}")).toBe("m/s");
	});

	it("raises to numeric powers", () => {
		expect(dimOf("(3\\,\\mathrm{m})^2")).toBe("m²");
		expect(dimOf("(3\\,\\mathrm{m})^{3}")).toBe("m³");
		expect(dimOf("(3\\,\\mathrm{m})^{-1}")).toBe("1/m");
		expect(dimOf("(4\\,\\mathrm{m^2})^{1/2}")).toBe("m");
		expect(dimOf("(4\\,\\mathrm{m^2})^{0.5}")).toBe("m");
		expect(dimOf("(8\\,\\mathrm{m^3})^\\frac13")).toBe("m");
		expect(dimOf("2^{10}")).toBe("1");
		expect(dimOf("(2\\,\\mathrm{s})^0")).toBe("1");
	});

	it("takes one digit after ^ as TeX does", () => {
		expect(dimOf("(3\\,\\mathrm{m})^23")).toBe("m²");
	});

	it("takes roots", () => {
		expect(dimOf("\\sqrt{4\\,\\mathrm{m^2}}")).toBe("m");
		expect(dimOf("\\sqrt[3]{8\\,\\mathrm{m^3}}")).toBe("m");
		expect(dimOf("\\sqrt{\\frac{2\\,\\mathrm{m}}{9.8\\,\\mathrm{m/s^2}}}")).toBe("s");
		expect(dimOf("\\sqrt{3\\,\\mathrm{m}}")).toBe("m^(1/2)");
	});

	it("flags a dimensioned exponent", () => {
		const r = analyzeDimensions("2^{3\\,\\mathrm{m}}");
		expect(kinds("2^{3\\,\\mathrm{m}}")).toEqual(["exponent"]);
		expect(r.issues[0]!.message).toContain("exponent");
		expect(r.issues[0]!.message).toContain("dimensionless");
		expect(clean("2^{3} + 1")).toBe(true);
		expect(clean("(3\\,\\mathrm{m})^{2}")).toBe(true);
	});

	it("does not guess a power with a symbolic exponent", () => {
		expect(dimOf("(3\\,\\mathrm{m})^n")).toBeNull();
		expect(dimOf("2^n")).toBe("1");
		expect(dimOf("x^0")).toBe("1");
	});

	it("reads the degree sign", () => {
		expect(dimOf("30^\\circ")).toBe("1");
		expect(dimOf("30°")).toBe("1");
		expect(dimOf("30^\\circ\\mathrm{C}")).toBe("K");
		expect(clean("\\sin 30^\\circ + 1")).toBe(true);
		expect(dimOf("45\\degree")).toBe("1");
	});
});

describe("functions", () => {
	it("needs a dimensionless argument", () => {
		const r = analyzeDimensions("\\sin(5\\,\\mathrm{m})");
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]!.kind).toBe("function");
		expect(r.issues[0]!.left).toBe("sin");
		expect(r.issues[0]!.message).toContain("argument of sin");
		expect(kinds("\\ln(2\\,\\mathrm{s})")).toEqual(["function"]);
		expect(kinds("\\exp(3\\,\\mathrm{kg})")).toEqual(["function"]);
		expect(kinds("\\cos 2\\,\\mathrm{m}")).toEqual(["function"]);
	});

	it("accepts angles and ratios", () => {
		expect(clean("\\sin(30\\,\\mathrm{rad})")).toBe(true);
		expect(clean("\\sin(30^\\circ)")).toBe(true);
		expect(clean("\\cos\\left(\\frac{2\\,\\mathrm{m}}{3\\,\\mathrm{m}}\\right)")).toBe(true);
		expect(clean("\\ln\\frac{x}{x_0}")).toBe(true);
		expect(dimOf("\\sin(3\\,\\mathrm{rad})")).toBe("1");
	});

	it("reads the argument of a function written without parentheses", () => {
		expect(kinds("\\sin 2\\,\\mathrm{m}")).toEqual(["function"]);
		expect(clean("\\sin \\pi x")).toBe(true);
		expect(clean("\\sin^2 x + \\cos^2 x")).toBe(true);
		expect(clean("\\ln 2 + \\log_{10} 100")).toBe(true);
	});

	it("keeps the dimension through |x| and does not guess other functions", () => {
		expect(dimOf("\\left|3\\,\\mathrm{m}\\right|")).toBe("m");
		expect(dimOf("|3\\,\\mathrm{m}|")).toBe("m");
		expect(dimOf("\\max(1\\,\\mathrm{m}, 2\\,\\mathrm{m})")).toBeNull();
		expect(clean("\\max(1\\,\\mathrm{m}, 2\\,\\mathrm{s})")).toBe(true);
	});
});

describe("equations", () => {
	it("flags the two sides of an equation that differ", () => {
		const r = analyzeDimensions("5\\,\\mathrm{m} = 3\\,\\mathrm{s}");
		expect(r.issues).toHaveLength(1);
		const i = r.issues[0]!;
		expect(i.kind).toBe("relation");
		expect(i.op).toBe("=");
		expect(i.message).toContain("The two sides differ");
		expect(i.message).toContain("length, m");
		expect(i.message).toContain("time, s");
	});

	it("accepts consistent equations", () => {
		expect(clean("1\\,\\mathrm{N} = 1\\,\\mathrm{kg\\,m/s^2}")).toBe(true);
		expect(clean("1\\,\\mathrm{J} = 1\\,\\mathrm{N\\,m}")).toBe(true);
		expect(clean("1\\,\\mathrm{V} = 1\\,\\mathrm{W/A}")).toBe(true);
		expect(clean("1\\,\\mathrm{\\Omega} = 1\\,\\mathrm{V/A}")).toBe(true);
		expect(clean("1\\,\\mathrm{Hz} = 1\\,\\mathrm{s^{-1}}")).toBe(true);
		expect(clean("1\\,\\mathrm{Pa} = 1\\,\\mathrm{N/m^2}")).toBe(true);
		expect(clean("1\\,\\mathrm{C} = 1\\,\\mathrm{A\\,s}")).toBe(true);
		expect(clean("1\\,\\mathrm{T} = 1\\,\\mathrm{Wb/m^2}")).toBe(true);
		expect(clean("1\\,\\mathrm{H} = 1\\,\\mathrm{Wb/A}")).toBe(true);
		expect(clean("1\\,\\mathrm{F} = 1\\,\\mathrm{C/V}")).toBe(true);
	});

	it("flags a velocity written as a force", () => {
		expect(kinds("1\\,\\mathrm{N} = 1\\,\\mathrm{kg\\,m/s}")).toEqual(["relation"]);
		expect(kinds("1\\,\\mathrm{J} = 1\\,\\mathrm{W}")).toEqual(["relation"]);
	});

	it("checks comparisons and approximations", () => {
		expect(kinds("3\\,\\mathrm{m} < 4\\,\\mathrm{s}")).toEqual(["relation"]);
		expect(analyzeDimensions("3\\,\\mathrm{m} < 4\\,\\mathrm{s}").issues[0]!.message).toContain("Cannot compare");
		expect(kinds("3\\,\\mathrm{m} \\leq 4\\,\\mathrm{s}")).toEqual(["relation"]);
		expect(kinds("3\\,\\mathrm{m} \\ge 4\\,\\mathrm{s}")).toEqual(["relation"]);
		expect(kinds("3\\,\\mathrm{m} \\approx 4\\,\\mathrm{s}")).toEqual(["relation"]);
		expect(kinds("3\\,\\mathrm{m} \\neq 4\\,\\mathrm{s}")).toEqual(["relation"]);
		expect(kinds("3\\,\\mathrm{m} ≤ 4\\,\\mathrm{s}")).toEqual(["relation"]);
		expect(clean("3\\,\\mathrm{m} < 4\\,\\mathrm{km}")).toBe(true);
		expect(clean("3\\,\\mathrm{m} > 0")).toBe(true);
	});

	it("does not compare what is only proportional", () => {
		expect(clean("3\\,\\mathrm{m} \\propto 4\\,\\mathrm{s}")).toBe(true);
	});

	it("checks chains", () => {
		expect(clean("1\\,\\mathrm{J} = 1\\,\\mathrm{N\\,m} = 1\\,\\mathrm{W\\,s}")).toBe(true);
		const r = analyzeDimensions("1\\,\\mathrm{J} = 1\\,\\mathrm{N\\,m} = 1\\,\\mathrm{W}");
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]!.right).toBe("1 W");
	});

	it("flags a bare number against a quantity", () => {
		const r = analyzeDimensions("5\\,\\mathrm{m} = 5");
		expect(r.issues[0]!.kind).toBe("unit-missing");
		expect(r.issues[0]!.bare).toBe("right");
		expect(clean("5 = 5")).toBe(true);
		expect(clean("\\frac{3\\,\\mathrm{m}}{2\\,\\mathrm{m}} = 1.5")).toBe(true);
	});

	it("keeps dimensionless things comparable", () => {
		expect(clean("\\frac{2\\,\\mathrm{m}}{4\\,\\mathrm{m}} = 0.5")).toBe(true);
		expect(clean("\\frac{2\\,\\mathrm{m}}{4\\,\\mathrm{s}} = 0.5")).toBe(false);
	});
});

describe("symbols", () => {
	it("never flags what it cannot know", () => {
		expect(clean("F = m a")).toBe(true);
		expect(clean("x + y = z")).toBe(true);
		expect(clean("E = m c^2")).toBe(true);
		expect(clean("a + b\\,\\mathrm{m} = c\\,\\mathrm{s}^{-1}")).toBe(true);
		expect(clean("f(x) = 3 x + 2")).toBe(true);
		expect(clean("\\alpha + \\beta = \\gamma")).toBe(true);
	});

	it("takes the dimension of a symbol from its value", () => {
		expect(clean("m = 2\\,\\mathrm{kg} \\\\ a = 3\\,\\mathrm{m/s^2} \\\\ F = m a")).toBe(true);
		const r = analyzeDimensions("m = 2\\,\\mathrm{kg} \\\\ a = 3\\,\\mathrm{m/s^2} \\\\ F = m a \\\\ F = 6\\,\\mathrm{N}");
		expect(r.issues).toHaveLength(0);
		expect(r.symbols.F).toBe("kg·m/s²");
		expect(kinds("m = 2\\,\\mathrm{kg} \\\\ a = 3\\,\\mathrm{m/s^2} \\\\ F = m a \\\\ F = 6\\,\\mathrm{J}")).toEqual(["relation"]);
	});

	it("checks a derived symbol against the next value", () => {
		const src = "m = 2\\,\\mathrm{kg} \\\\ v = 3\\,\\mathrm{m/s} \\\\ E = \\frac{1}{2} m v^2 \\\\ E = 9\\,\\mathrm{J}";
		expect(clean(src)).toBe(true);
		expect(kinds(src.replace("9\\,\\mathrm{J}", "9\\,\\mathrm{N}"))).toEqual(["relation"]);
	});

	it("reads declarations on a line of their own", () => {
		expect(clean("[v] = m/s \\\\ [t] = s \\\\ x = v t \\\\ x = 5\\,\\mathrm{m}")).toBe(true);
		expect(kinds("[v] = m/s \\\\ [t] = s \\\\ x = v t \\\\ x = 5\\,\\mathrm{s}")).toEqual(["relation"]);
		expect(kinds("[v] = \\mathrm{m/s} \\\\ v + 3\\,\\mathrm{m} = 1\\,\\mathrm{m}")).toEqual(["sum"]);
		expect(kinds("[F_{net}] = N \\\\ F_{net} = 3\\,\\mathrm{m}")).toEqual(["relation"]);
	});

	it("tells subscripted symbols apart", () => {
		expect(clean("m_1 = 2\\,\\mathrm{kg} \\\\ m_2 = 3\\,\\mathrm{s} \\\\ m_1 + 1\\,\\mathrm{kg} = 3\\,\\mathrm{kg}")).toBe(true);
		expect(kinds("m_1 = 2\\,\\mathrm{kg} \\\\ m_2 = 3\\,\\mathrm{s} \\\\ m_1 + m_2")).toEqual(["sum"]);
		expect(clean("m_{1} = 2\\,\\mathrm{kg} \\\\ m_1 + 1\\,\\mathrm{kg}")).toBe(true);
		expect(clean("x_\\mathrm{max} = 2\\,\\mathrm{m} \\\\ x_{max} + 1\\,\\mathrm{m}")).toBe(true);
	});

	it("reads vectors and accents as the same symbol", () => {
		expect(kinds("F = 3\\,\\mathrm{N} \\\\ \\vec{F} + 1\\,\\mathrm{m}")).toEqual(["sum"]);
		expect(kinds("v = 3\\,\\mathrm{m/s} \\\\ \\mathbf{v} + 1\\,\\mathrm{s}")).toEqual(["sum"]);
		expect(kinds("x = 3\\,\\mathrm{m} \\\\ \\bar{x} + 1\\,\\mathrm{s}")).toEqual(["sum"]);
	});

	it("takes symbols given beforehand", () => {
		const opts = { symbols: { m: "kg", a: "m/s^2", F: "N" } };
		expect(clean("F = m a", opts)).toBe(true);
		expect(kinds("F = m v", { symbols: { ...opts.symbols, v: "m/s" } })).toEqual(["relation"]);
		expect(kinds("F + m = 0.5", opts)).toEqual(["sum"]);
	});

	it("does not bind a symbol to a bare number", () => {
		expect(clean("x = 3 \\\\ x = 5\\,\\mathrm{m}")).toBe(true);
	});

	it("flags a rebinding that disagrees", () => {
		expect(kinds("x = 3\\,\\mathrm{m} \\\\ x = 5\\,\\mathrm{s}")).toEqual(["relation"]);
	});

	it("lets an unknown term take the dimension of its neighbours in a sum", () => {
		expect(kinds("x + 5\\,\\mathrm{m} = 3\\,\\mathrm{s}")).toEqual(["relation"]);
		expect(clean("x + 5\\,\\mathrm{m} = 3\\,\\mathrm{km}")).toBe(true);
		expect(kinds("x + 5\\,\\mathrm{m} + 3\\,\\mathrm{s}")).toEqual(["sum"]);
	});

	it("treats a plain 1 next to an unknown as dimensionless", () => {
		expect(clean("\\gamma = \\frac{1}{\\sqrt{1 - v^2/c^2}}")).toBe(true);
		expect(kinds("L = 3\\,\\mathrm{m} \\\\ L + 1 = 4\\,\\mathrm{m}")).toEqual(["unit-missing"]);
	});
});

describe("several formulas and line continuation", () => {
	it("splits on \\\\, semicolons, line breaks and commas", () => {
		expect(kinds("1\\,\\mathrm{m} + 1\\,\\mathrm{s} ; 2\\,\\mathrm{m} + 2\\,\\mathrm{kg}")).toEqual(["sum", "sum"]);
		expect(kinds("1\\,\\mathrm{m} + 1\\,\\mathrm{s}\n2\\,\\mathrm{m} + 2\\,\\mathrm{kg}")).toEqual(["sum", "sum"]);
		expect(kinds("1\\,\\mathrm{m} + 1\\,\\mathrm{s}, 2\\,\\mathrm{m} + 2\\,\\mathrm{kg}")).toEqual(["sum", "sum"]);
		expect(kinds("1\\,\\mathrm{m} + 1\\,\\mathrm{s} \\quad 2\\,\\mathrm{m} + 2\\,\\mathrm{kg}")).toEqual(["sum", "sum"]);
		expect(kinds("1\\,\\mathrm{m} = 1\\,\\mathrm{s} \\Rightarrow 2\\,\\mathrm{m} = 2\\,\\mathrm{kg}")).toEqual(["relation", "relation"]);
	});

	it("does not split a long formula broken over lines", () => {
		expect(clean("1\\,\\mathrm{m} +\n2\\,\\mathrm{m}\n+ 3\\,\\mathrm{m}")).toBe(true);
		expect(kinds("1\\,\\mathrm{m}\n= 1\\,\\mathrm{s}")).toEqual(["relation"]);
	});

	it("follows an aligned block", () => {
		const aligned = "\\begin{aligned} x &= 3\\,\\mathrm{m} \\\\ &= 300\\,\\mathrm{cm} \\\\ &= 2\\,\\mathrm{s} \\end{aligned}";
		const r = analyzeDimensions(aligned);
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]!.right).toBe("2 s");
		expect(clean("\\begin{aligned} x &= 3\\,\\mathrm{m} \\\\ &= 300\\,\\mathrm{cm} \\end{aligned}")).toBe(true);
		expect(clean("\\begin{align*} a &= 1 \\\\ b &= 2 \\end{align*}")).toBe(true);
	});

	it("skips environments it does not read", () => {
		expect(clean("\\begin{pmatrix} 1\\,\\mathrm{m} & 2\\,\\mathrm{s} \\\\ 3 & 4 \\end{pmatrix}")).toBe(true);
		expect(clean("f(x) = \\begin{cases} 1\\,\\mathrm{m} & x > 0 \\\\ 2\\,\\mathrm{s} & x \\le 0 \\end{cases}")).toBe(true);
	});

	it("stops after the maximum number of issues", () => {
		const lines = Array.from({ length: 30 }, () => "1\\,\\mathrm{m} + 1\\,\\mathrm{s}").join(" \\\\ ");
		expect(analyzeDimensions(lines).issues).toHaveLength(20);
		expect(analyzeDimensions(lines, { maxIssues: 3 }).issues).toHaveLength(3);
	});
});

describe("LaTeX forms", () => {
	it("reads fractions", () => {
		expect(dimOf("\\frac{1\\,\\mathrm{m}}{1\\,\\mathrm{s}}")).toBe("m/s");
		expect(dimOf("\\dfrac{1\\,\\mathrm{m}}{1\\,\\mathrm{s}}")).toBe("m/s");
		expect(dimOf("\\tfrac12")).toBe("1");
		expect(dimOf("\\frac12 \\cdot 3\\,\\mathrm{kg}")).toBe("kg");
		expect(dimOf("\\frac{\\frac{1\\,\\mathrm{m}}{1\\,\\mathrm{s}}}{1\\,\\mathrm{s}}")).toBe("m/s²");
	});

	it("reads derivatives", () => {
		const opts = { symbols: { x: "m", t: "s", v: "m/s", f: "N", y: "m" } };
		expect(dimOf("\\frac{dx}{dt}", opts)).toBe("m/s");
		expect(dimOf("\\frac{\\mathrm{d}x}{\\mathrm{d}t}", opts)).toBe("m/s");
		expect(dimOf("\\frac{d^2x}{dt^2}", opts)).toBe("m/s²");
		expect(dimOf("\\frac{\\mathrm{d}^2 x}{\\mathrm{d}t^2}", opts)).toBe("m/s²");
		expect(dimOf("\\frac{\\partial f}{\\partial x}", opts)).toBe("kg/s²");
		expect(dimOf("\\frac{d}{dt} x", opts)).toBe("m/s");
		expect(clean("v = \\frac{dx}{dt}", opts)).toBe(true);
		expect(kinds("v = \\frac{dx}{dt} + 1\\,\\mathrm{m}", opts)).toEqual(["sum"]);
		expect(clean("\\frac{dx}{dt} = v", opts)).toBe(true);
		expect(kinds("\\frac{dx}{dt} = x", opts)).toEqual(["relation"]);
	});

	it("is not fooled by d as a distance", () => {
		expect(dimOf("\\frac{d_1}{d_2}", { symbols: { d_1: "m", d_2: "m" } })).toBe("1");
		expect(dimOf("\\frac{d}{t}", { symbols: { d: "m", t: "s" } })).toBe("m/s");
		expect(dimOf("\\frac{d}{2}", { symbols: { d: "m" } })).toBe("m");
	});

	it("reads dots as time derivatives", () => {
		expect(dimOf("\\dot{x}", { symbols: { x: "m" } })).toBe("m/s");
		expect(dimOf("\\ddot{x}", { symbols: { x: "m" } })).toBe("m/s²");
		expect(dimOf("\\dot{x}", {})).toBeNull();
	});

	it("reads integrals", () => {
		const opts = { symbols: { F: "N", x: "m", t: "s", v: "m/s" } };
		expect(dimOf("\\int F\\,dx", opts)).toBe("kg·m²/s²");
		expect(dimOf("\\int_0^L F \\, \\mathrm{d}x", opts)).toBe("kg·m²/s²");
		expect(dimOf("\\int_{0}^{T} v\\,dt", opts)).toBe("m");
		expect(dimOf("\\int dx", opts)).toBe("m");
		expect(clean("W = \\int F\\,dx \\\\ W = 3\\,\\mathrm{J}", opts)).toBe(true);
		expect(kinds("W = \\int F\\,dx \\\\ W = 3\\,\\mathrm{N}", opts)).toEqual(["relation"]);
		expect(dimOf("\\int \\sin x\\,dx", opts)).toBe("m");
	});

	it("reads sums and limits", () => {
		const opts = { symbols: { m: "kg", x: "m" } };
		expect(dimOf("\\sum_{i=1}^{n} m_i x_i", { symbols: { m_i: "kg", x_i: "m" } })).toBe("kg·m");
		expect(dimOf("\\sum_{i=1}^{n} 2\\,\\mathrm{m}")).toBe("m");
		expect(dimOf("\\lim_{x \\to 0} 3\\,\\mathrm{m}", opts)).toBe("m");
		expect(dimOf("\\prod_{i=1}^{n} 2\\,\\mathrm{m}")).toBeNull();
		expect(dimOf("\\prod_{i=1}^{n} 2")).toBe("1");
	});

	it("reads text wrappers and symbols in roman", () => {
		expect(dimOf("\\text{kg}")).toBe("kg");
		expect(dimOf("\\textrm{m}/\\textrm{s}")).toBe("m/s");
		expect(dimOf("\\mathsf{N}")).toBe("kg·m/s²");
		expect(dimOf("\\mathrm{e}^{x}")).toBe("1");
		expect(dimOf("\\mathrm{e}")).toBe("1");
		expect(dimOf("\\mathrm{foo}")).toBeNull();
		expect(clean("\\mathrm{foo} + 5\\,\\mathrm{m}")).toBe(true);
	});

	it("reads siunitx quantities", () => {
		expect(dimOf("\\SI{5}{m/s}")).toBe("m/s");
		expect(dimOf("\\qty{5}{\\kilo\\gram}")).toBeNull();
		expect(dimOf("\\SI{3}{\\newton}")).toBeNull();
		expect(kinds("\\SI{5}{m} + \\SI{3}{s}")).toEqual(["sum"]);
		expect(dimOf("\\si{m/s}")).toBe("m/s");
		expect(dimOf("\\unit{kg}")).toBe("kg");
	});

	it("ignores spacing, sizes and decoration", () => {
		expect(clean("5\\,\\mathrm{m}\\;+\\;3\\:\\mathrm{m}\\!+ 1\\ \\mathrm{m}")).toBe(true);
		expect(clean("\\displaystyle 5\\,\\mathrm{m} + 3\\,\\mathrm{m}")).toBe(true);
		expect(clean("\\Big(5\\,\\mathrm{m} + 3\\,\\mathrm{m}\\Big)")).toBe(true);
		expect(clean("5\\,\\mathrm{m} = 5\\,\\mathrm{m} \\tag{1}")).toBe(true);
		expect(clean("\\left[5\\,\\mathrm{m} + 3\\,\\mathrm{m}\\right]")).toBe(true);
		expect(clean("\\color{red}{5\\,\\mathrm{m}} + 3\\,\\mathrm{m}")).toBe(true);
		expect(kinds("5\\,\\mathrm{m} + 3\\,\\mathrm{s} \\label{eq}")).toEqual(["sum"]);
	});

	it("reads Δ as a difference with the dimension of its operand", () => {
		expect(kinds("x = 3\\,\\mathrm{m} \\\\ \\Delta x + 1\\,\\mathrm{s}")).toEqual(["sum"]);
		expect(clean("x = 3\\,\\mathrm{m} \\\\ \\Delta x = 1\\,\\mathrm{m}")).toBe(true);
		expect(clean("x = 3\\,\\mathrm{m} \\\\ \\Delta x = \\Delta t")).toBe(true);
	});

	it("keeps Greek letters as symbols", () => {
		expect(kinds("\\lambda = 3\\,\\mathrm{m} \\\\ \\lambda + 1\\,\\mathrm{s}")).toEqual(["sum"]);
		expect(clean("\\lambda = 3\\,\\mathrm{m} \\\\ \\lambda + 1\\,\\mathrm{km}")).toBe(true);
		expect(dimOf("2\\pi \\cdot 3\\,\\mathrm{m}")).toBe("m");
	});
});

describe("textbook formulas", () => {
	const kin = { symbols: { m: "kg", v: "m/s", a: "m/s^2", t: "s", x: "m", g: "m/s^2", h: "m", L: "m", k: "N/m", r: "m", F: "N", E: "J", P: "W", p: "Pa", V: "m^3", T: "s", rho: "kg/m^3" } };

	it("accepts the correct ones", () => {
		for (const f of [
			"F = m a",
			"E = \\frac{1}{2} m v^2",
			"E = m g h",
			"v = a t",
			"x = \\frac{1}{2} a t^2",
			"v^2 = 2 a x",
			"T = 2\\pi\\sqrt{\\frac{L}{g}}",
			"T = 2\\pi\\sqrt{\\frac{m}{k}}",
			"F = k x",
			"E = \\frac{1}{2} k x^2",
			"P = F v",
			"P = \\frac{E}{t}",
			"p = \\frac{F}{r^2}",
			"F = m \\frac{v^2}{r}",
			"x = x_0 + v t + \\frac{1}{2} a t^2",
			"v = \\sqrt{2 g h}",
			"m = \\rho V",
			"\\omega = \\sqrt{\\frac{k}{m}}",
		]) {
			expect(analyzeDimensions(f, { symbols: { ...kin.symbols, x_0: "m" } }).issues, f).toEqual([]);
		}
	});

	it("flags the wrong ones", () => {
		for (const f of [
			"F = m v",
			"E = m v",
			"E = m g",
			"v = a t^2",
			"x = v t^2",
			"T = 2\\pi\\sqrt{\\frac{g}{L}}",
			"P = F x",
			"F = k x^2",
			"v = x + t",
			"x = \\frac{1}{2} a t",
		]) {
			expect(analyzeDimensions(f, kin).issues.length, f).toBeGreaterThan(0);
		}
	});

	it("reads a worked example with units on the numbers", () => {
		const good = "m = 2\\,\\mathrm{kg} \\\\ a = 3\\,\\mathrm{m/s^2} \\\\ F = m a = 6\\,\\mathrm{kg\\,m/s^2} = 6\\,\\mathrm{N}";
		expect(clean(good)).toBe(true);
		const bad = "m = 2\\,\\mathrm{kg} \\\\ a = 3\\,\\mathrm{m/s^2} \\\\ F = m a = 6\\,\\mathrm{J}";
		const r = analyzeDimensions(bad);
		expect(r.issues).toHaveLength(1);
		expect(r.issues[0]!.message).toContain("force");
		expect(r.issues[0]!.message).toContain("energy");
	});

	it("checks Ohm's law and the power of a resistor", () => {
		expect(clean("V = I R", { symbols: { V: "V", I: "A", R: "Ω" } })).toBe(true);
		expect(clean("P = I^2 R", { symbols: { P: "W", I: "A", R: "Ω" } })).toBe(true);
		expect(clean("P = \\frac{V^2}{R}", { symbols: { P: "W", V: "V", R: "Ω" } })).toBe(true);
		expect(kinds("P = V R", { symbols: { P: "W", V: "V", R: "Ω" } })).toEqual(["relation"]);
		expect(clean("\\tau = R C", { symbols: { R: "Ω", C: "F", "\\tau": "s" } })).toBe(true);
	});
});

describe("plain text", () => {
	const plain = { plain: true };

	it("reads units after numbers", () => {
		expect(dimOf("5 m", plain)).toBe("m");
		expect(dimOf("5 m/s", plain)).toBe("m/s");
		expect(dimOf("9.8 m/s^2", plain)).toBe("m/s²");
		expect(dimOf("9.8 m/s²", plain)).toBe("m/s²");
		expect(dimOf("3 kg*m/s^2", plain)).toBe("kg·m/s²");
		expect(dimOf("2 N m", plain)).toBe("kg·m²/s²");
		expect(dimOf("100 km/h", plain)).toBe("m/s");
		expect(dimOf("1e3 m", plain)).toBe("m");
		expect(dimOf("5m", plain)).toBe("m");
		expect(dimOf("20 °C", plain)).toBe("K");
		expect(dimOf("3 µs", plain)).toBe("s");
	});

	it("flags the same mistakes", () => {
		expect(kinds("5 m + 3 s", plain)).toEqual(["sum"]);
		expect(kinds("5 m = 3 s", plain)).toEqual(["relation"]);
		expect(kinds("5 m - 3 kg", plain)).toEqual(["sum"]);
		expect(kinds("sin(5 m)", plain)).toEqual(["function"]);
		expect(kinds("2^(3 m)", plain)).toEqual(["exponent"]);
		expect(clean("5 m + 3 km", plain)).toBe(true);
		expect(clean("5 m * 3 s", plain)).toBe(true);
		expect(clean("10 m / 2 s = 5 m/s", plain)).toBe(true);
		expect(clean("(10 m) / (2 s) = 5 m/s", plain)).toBe(true);
		expect(clean("1 N = 1 kg*m/s^2", plain)).toBe(true);
		expect(kinds("1 N = 1 kg*m/s", plain)).toEqual(["relation"]);
	});

	it("stops reading the unit where the unit ends", () => {
		expect(dimOf("3 m * 2", plain)).toBe("m");
		expect(kinds("3 m + 2 s * 4", plain)).toEqual(["sum"]);
		expect(clean("3 m + 2 m * 4", plain)).toBe(true);
	});

	it("keeps a bound word out of the units", () => {
		expect(clean("m = 2 kg\nF = 3 m", { plain: true })).toBe(true);
		expect(dimOf("2 m", { plain: true, symbols: { m: "kg" } })).toBe("kg");
	});

	it("knows constants and functions by name", () => {
		expect(dimOf("2 pi", plain)).toBe("1");
		expect(clean("sin(pi) + 1", plain)).toBe(true);
		expect(dimOf("sqrt(9 m^2)", plain)).toBe("m");
		expect(dimOf("sqrt 4", plain)).toBe("1");
	});

	it("reads declarations and several lines", () => {
		expect(clean("[v] = m/s\n[t] = s\nx = v*t\nx = 5 m", plain)).toBe(true);
		expect(kinds("[v] = m/s\n[t] = s\nx = v*t\nx = 5 s", plain)).toEqual(["relation"]);
	});

	it("does not read a unit in LaTeX mode", () => {
		expect(clean("5 m + 3 s")).toBe(true);
	});
});

describe("quiet by construction", () => {
	it("returns nothing for text it cannot read", () => {
		for (const s of ["", " ", "((", "))", "\\frac{", "\\frac{1}", "x^", "^2", "_", "\\begin{pmatrix}", "\\end{x}", "a = ", "= b", "+", "\\sqrt", "\\int", "\\sum_", "|", "||", "a | b", "\\left(", "{{{{", "}}}}", "\\\\", ";;;", "5\\,\\mathrm{", "\\mathrm"]) {
			expect(() => analyzeDimensions(s), JSON.stringify(s)).not.toThrow();
			expect(analyzeDimensions(s).issues, JSON.stringify(s)).toEqual([]);
		}
	});

	it("reports no issue for a statement it cannot read to the end", () => {
		expect(clean("5\\,\\mathrm{m} + 3\\,\\mathrm{s} )")).toBe(true);
		expect(clean("5\\,\\mathrm{m} + 3\\,\\mathrm{s} \\foo{")).toBe(true);
	});

	it("survives hostile input", () => {
		const deep = "(".repeat(5000) + "1" + ")".repeat(5000);
		expect(() => analyzeDimensions(deep)).not.toThrow();
		expect(analyzeDimensions(deep).issues).toEqual([]);
		const pows = "x^".repeat(3000) + "2";
		expect(() => analyzeDimensions(pows)).not.toThrow();
		const nest = "\\frac{".repeat(300) + "1" + "}{2}".repeat(300);
		expect(() => analyzeDimensions(nest)).not.toThrow();
		const sqrt = "\\sqrt{".repeat(500) + "2" + "}".repeat(500);
		expect(() => analyzeDimensions(sqrt)).not.toThrow();
		const huge = "1+".repeat(DIMENSIONS_TEXT_MAX) + "1";
		expect(analyzeDimensions(huge).issues).toEqual([]);
		const many = Array.from({ length: 1500 }, () => "1\\,\\mathrm{m}").join(" + ");
		expect(() => analyzeDimensions(many)).not.toThrow();
		expect(() => analyzeDimensions("\u0000\uffff\ud800 x = \\")).not.toThrow();
		expect(() => analyzeDimensions(null as unknown as string)).not.toThrow();
		expect(() => analyzeDimensions(undefined as unknown as string)).not.toThrow();
	});

	it("is fast on a long but legal text", () => {
		const text = Array.from({ length: 200 }, (_, i) => `x_${i} = ${i}\\,\\mathrm{m}`).join(" \\\\ ");
		const t0 = Date.now();
		analyzeDimensions(text);
		expect(Date.now() - t0).toBeLessThan(1000);
	});

	it("ignores prototype names as symbols", () => {
		expect(clean("__proto__ = 3\\,\\mathrm{m} \\\\ constructor + 1\\,\\mathrm{s}")).toBe(true);
		expect(clean("x = 1", { symbols: { __proto__: "m" } as unknown as Record<string, string> })).toBe(true);
	});
});

describe("display text", () => {
	it("cleans the markup", () => {
		expect(cleanFormulaText("5\\,\\mathrm{m}")).toBe("5 m");
		expect(cleanFormulaText("\\frac{a}{b}")).toBe("(a)/(b)");
		expect(cleanFormulaText("x^{2}")).toBe("x^2");
		expect(cleanFormulaText("x^{n+1}")).toBe("x^(n+1)");
		expect(cleanFormulaText("a \\cdot b \\times c")).toBe("a · b × c");
		expect(cleanFormulaText("\\mu_{0}")).toBe("µ_0");
		expect(cleanFormulaText("\\sqrt{x}")).toBe("√(x)");
		expect(cleanFormulaText("x".repeat(100)).length).toBeLessThanOrEqual(48);
	});

	it("keeps the offending range", () => {
		const src = "5\\,\\mathrm{m} + 3\\,\\mathrm{s}";
		const i = analyzeDimensions(src).issues[0]!;
		expect(src.slice(i.at[0], i.at[1])).toBe(src);
	});
});
