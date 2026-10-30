/** The safe expression parser of function graphs (#113): syntax, precedence, implicit multiplication, safety. */
import { describe, expect, it } from "vitest";
import { compileExpr, ExprError, isReservedName, parseExpr, splitEquation, stripLhs } from "../src/math/expr";

function ev(src: string, vars: Record<string, number> = {}, params: Record<string, number> = {}, degrees = false): number {
	const names = Object.keys(vars);
	const r = compileExpr(src, { variables: names, params: new Map(Object.entries(params)), degrees });
	if (!r.ok) throw new Error(`${src}: ${r.error} at ${r.at}`);
	return r.fn(names.map((n) => vars[n]!));
}

function err(src: string, vars: string[] = ["x"]): string {
	const r = compileExpr(src, { variables: vars });
	if (r.ok) throw new Error(`${src} compiled`);
	return r.error;
}

describe("expression parser", () => {
	it("numbers and operators with the usual precedence", () => {
		expect(ev("1 + 2 * 3")).toBe(7);
		expect(ev("(1 + 2) * 3")).toBe(9);
		expect(ev("2^3^2")).toBe(512);
		expect(ev("-2^2")).toBe(-4);
		expect(ev("2^-1")).toBe(0.5);
		expect(ev("10 / 4 / 5")).toBe(0.5);
		expect(ev(".5 + 1.25 + 2.")).toBe(3.75);
		expect(ev("1e3 + 2E-2")).toBe(1000.02);
		expect(ev("3!")).toBe(6);
		expect(ev("0.5!")).toBeCloseTo(Math.sqrt(Math.PI) / 2, 10);
		expect(ev("7 − 2 × 3 ÷ 2 · 1")).toBe(4);
		expect(ev("2 ** 4")).toBe(16);
		expect(ev("[1 + 1] * 2")).toBe(4);
	});

	it("constants, functions and implicit multiplication", () => {
		expect(ev("pi")).toBe(Math.PI);
		expect(ev("π")).toBe(Math.PI);
		expect(ev("2e")).toBe(2 * Math.E);
		expect(ev("e^x", { x: 2 })).toBeCloseTo(Math.E ** 2, 12);
		expect(ev("2x", { x: 3 })).toBe(6);
		expect(ev("2(x + 1)", { x: 3 })).toBe(8);
		expect(ev("(x + 1)(x - 1)", { x: 3 })).toBe(8);
		expect(ev("2x^2", { x: 3 })).toBe(18);
		expect(ev("sin x", { x: 1 })).toBe(Math.sin(1));
		expect(ev("sin 2x", { x: 1 })).toBe(Math.sin(2));
		expect(ev("sin x cos x", { x: 1 })).toBeCloseTo(Math.sin(1) * Math.cos(1), 15);
		expect(ev("sinx", { x: 1 })).toBe(Math.sin(1));
		expect(ev("ax", { x: 3 }, { a: 2 })).toBe(6);
		expect(ev("xy", { x: 3, y: 4 })).toBe(12);
		expect(ev("2 sin(x) + 1", { x: 0 })).toBe(1);
		expect(ev("|x - 3|", { x: 1 })).toBe(2);
		expect(ev("2|x|", { x: -4 })).toBe(8);
		expect(ev("√4 + √(9)")).toBe(5);
		expect(ev("log(100) + ln(e) + log(2, 8)")).toBeCloseTo(6, 12);
		expect(ev("max(1, 5, 3) - min(4, 2)")).toBe(3);
		expect(ev("mod(-1, 3)")).toBe(2);
		expect(ev("root(3, -8)")).toBe(-2);
		expect(ev("x^(1/3)", { x: -8 })).toBeCloseTo(-2, 12);
		expect(ev("2θ", { θ: 1.5 })).toBe(3);
		expect(ev("theta", { θ: 1.5 })).toBe(1.5);
	});

	it("degrees mode converts the trigonometric functions only", () => {
		expect(ev("sin(30)", {}, {}, true)).toBeCloseTo(0.5, 15);
		expect(ev("asin(0.5)", {}, {}, true)).toBeCloseTo(30, 12);
		expect(ev("atan2(1, 1)", {}, {}, true)).toBeCloseTo(45, 12);
		expect(ev("sqrt(16)", {}, {}, true)).toBe(4);
	});

	it("comparisons and logic for conditions", () => {
		expect(ev("x < 0", { x: -1 })).toBe(1);
		expect(ev("0 < x < 1", { x: 0.5 })).toBe(1);
		expect(ev("0 < x < 1", { x: 2 })).toBe(0);
		expect(ev("x >= 1 and x != 2", { x: 2 })).toBe(0);
		expect(ev("x ≤ 1 or not x > 0", { x: 3 })).toBe(0);
		expect(ev("x == 3 && x ≠ 4", { x: 3 })).toBe(1);
	});

	it("reports errors with a position", () => {
		expect(err("sin(")).toMatch(/unexpected end|expected/);
		expect(err("2 +")).toMatch(/unexpected end/);
		expect(err("foo(x)")).toMatch(/unknown name 'foo'/);
		expect(err("x $ 2")).toMatch(/unexpected '\$'/);
		expect(err("atan2(1)")).toMatch(/takes 2/);
		expect(err("")).toMatch(/empty/);
		expect(err("y", ["x"])).toMatch(/unknown name 'y'/);
		try {
			parseExpr("1 + )", { names: new Set() });
		} catch (e) {
			expect(e).toBeInstanceOf(ExprError);
			expect((e as ExprError).at).toBe(4);
		}
	});

	it("is safe: no globals, no properties, no eval, bounded depth and length", () => {
		for (const src of ["constructor", "__proto__", "globalThis", "window", "process", "eval(1)", "Function", "this", "toString", "x.constructor", "x['a']", "`1`", "a=>1", "x;1", "alert(1)", "require"]) {
			const r = compileExpr(src, { variables: ["x"] });
			expect(r.ok, src).toBe(false);
		}
		// Names are looked up in Maps, never on objects: a parameter called like an Object property is just a number.
		expect(ev("valueOf + 1", {}, { valueOf: 2 })).toBe(3);
		expect(compileExpr("(".repeat(500) + "1" + ")".repeat(500), { variables: [] }).ok).toBe(false);
		expect(compileExpr("-".repeat(200) + "1", { variables: [] }).ok).toBe(false);
		expect(compileExpr("1+".repeat(600) + "1", { variables: [] }).ok).toBe(false);
		expect(compileExpr("2^".repeat(100) + "1", { variables: [] }).ok).toBe(false);
	});

	it("splits equations and strips a named left side", () => {
		expect(splitEquation("x^2 + y^2 = 4")).toEqual({ lhs: "x^2 + y^2 ", rhs: " 4" });
		expect(splitEquation("x <= 1")).toBeNull();
		expect(splitEquation("a = b = c")).toBeNull();
		expect(stripLhs("y = 2x", "y")).toBe(" 2x");
		expect(stripLhs("2x", "y")).toBe("2x");
		expect(stripLhs("r = 1 + cos(θ)", "r")).toBe(" 1 + cos(θ)");
		expect(isReservedName("sin")).toBe(true);
		expect(isReservedName("a")).toBe(false);
	});
});
