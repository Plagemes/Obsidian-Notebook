// 0.29 calculator (#182): the keys of the advanced calculator as data. The big pad (digits, operators) is always on screen; the
// groups under it (functions, units, constants, lists and matrices) are rows of chips that put text into the expression. Pure:
// no 'obsidian', so the tests can check that every key inserts something the parser reads.
import type { MessageKey } from "../i18n/en";
import { CONSTANTS } from "../math/calc-constants";

export type KeyAction = "clear" | "back" | "eval" | "insert";

export interface PadKey {
	/** What the key shows. */
	label: string;
	action: KeyAction;
	/** Text put into the expression at the cursor ("insert"). */
	text?: string;
	/** Spoken name (screen readers, long-press help). */
	name: MessageKey;
	/** Visual weight: operators are tinted, "eval" is the accent key. */
	kind?: "digit" | "op" | "eval" | "util";
}

/** 5 columns, 5 rows, row by row. */
export const PAD: readonly PadKey[] = [
	{ label: "C", action: "clear", name: "calc.key.clear", kind: "util" },
	{ label: "⌫", action: "back", name: "calc.key.back", kind: "util" },
	{ label: "(", action: "insert", text: "(", name: "calc.key.open", kind: "op" },
	{ label: ")", action: "insert", text: ")", name: "calc.key.close", kind: "op" },
	{ label: "÷", action: "insert", text: "/", name: "calc.key.divide", kind: "op" },
	{ label: "7", action: "insert", text: "7", name: "calc.key.digit", kind: "digit" },
	{ label: "8", action: "insert", text: "8", name: "calc.key.digit", kind: "digit" },
	{ label: "9", action: "insert", text: "9", name: "calc.key.digit", kind: "digit" },
	{ label: "x²", action: "insert", text: "^2", name: "calc.key.square", kind: "op" },
	{ label: "×", action: "insert", text: "*", name: "calc.key.times", kind: "op" },
	{ label: "4", action: "insert", text: "4", name: "calc.key.digit", kind: "digit" },
	{ label: "5", action: "insert", text: "5", name: "calc.key.digit", kind: "digit" },
	{ label: "6", action: "insert", text: "6", name: "calc.key.digit", kind: "digit" },
	{ label: "xʸ", action: "insert", text: "^", name: "calc.key.power", kind: "op" },
	{ label: "−", action: "insert", text: "-", name: "calc.key.minus", kind: "op" },
	{ label: "1", action: "insert", text: "1", name: "calc.key.digit", kind: "digit" },
	{ label: "2", action: "insert", text: "2", name: "calc.key.digit", kind: "digit" },
	{ label: "3", action: "insert", text: "3", name: "calc.key.digit", kind: "digit" },
	{ label: "√", action: "insert", text: "sqrt(", name: "calc.key.sqrt", kind: "op" },
	{ label: "+", action: "insert", text: "+", name: "calc.key.plus", kind: "op" },
	{ label: "0", action: "insert", text: "0", name: "calc.key.digit", kind: "digit" },
	{ label: ".", action: "insert", text: ".", name: "calc.key.point", kind: "digit" },
	{ label: "π", action: "insert", text: "pi", name: "calc.key.pi", kind: "digit" },
	{ label: "ans", action: "insert", text: "ans", name: "calc.key.ans", kind: "digit" },
	{ label: "=", action: "eval", name: "calc.key.equals", kind: "eval" },
];

export type KeyGroupId = "functions" | "units" | "constants" | "lists" | "more";

export interface ChipKey {
	label: string;
	text: string;
	/** A hint shown as the title of the chip. */
	hint?: string;
}

export interface KeyGroup {
	id: KeyGroupId;
	title: MessageKey;
	keys: readonly ChipKey[];
}

const fn = (name: string, hint?: string): ChipKey => ({ label: name, text: `${name}(`, ...(hint ? { hint } : {}) });

export const GROUPS: readonly KeyGroup[] = [
	{
		id: "functions", title: "calc.group.functions",
		keys: [
			fn("sin"), fn("cos"), fn("tan"), fn("asin"), fn("acos"), fn("atan"), fn("ln"), fn("log"), fn("exp"), fn("abs"), fn("root"), fn("floor"), fn("round"),
			{ label: "n!", text: "!" }, fn("nCr"), fn("gcd"), fn("mod"), fn("fraction"),
		],
	},
	{
		id: "units", title: "calc.group.units",
		keys: [
			{ label: "to", text: " to " },
			{ label: "m", text: " m" }, { label: "km", text: " km" }, { label: "cm", text: " cm" }, { label: "mm", text: " mm" }, { label: "mi", text: " mi" }, { label: "ft", text: " ft" },
			{ label: "kg", text: " kg" }, { label: "g", text: " g" }, { label: "lb", text: " lb" },
			{ label: "s", text: " s" }, { label: "min", text: " min" }, { label: "h", text: " h" },
			{ label: "m/s", text: " m/s" }, { label: "km/h", text: " km/h" }, { label: "N", text: " N" }, { label: "J", text: " J" }, { label: "W", text: " W" }, { label: "Pa", text: " Pa" },
			{ label: "L", text: " L" }, { label: "°C", text: " degC" }, { label: "K", text: " K" }, { label: "deg", text: " deg" }, { label: "rad", text: " rad" },
		],
	},
	{
		id: "constants", title: "calc.group.constants",
		keys: CONSTANTS.map((c) => ({ label: c.names[0]!, text: c.names[0]!, hint: c.unit })),
	},
	{
		id: "lists", title: "calc.group.lists",
		keys: [
			{ label: "[ ]", text: "[" }, { label: ",", text: ", " }, { label: ";", text: "; " },
			fn("mean"), fn("median"), fn("mode"), fn("std"), fn("var"), fn("sum"), fn("min"), fn("max"), fn("sort"), fn("seq"), fn("slope"), fn("corr"),
			fn("det"), fn("inv"), fn("transpose"), fn("dot"), fn("cross"), fn("norm"), fn("identity"), fn("linsolve"),
		],
	},
	{
		id: "more", title: "calc.group.more",
		keys: [
			{ label: "i", text: "i" }, fn("conj"), fn("re"), fn("im"), fn("arg"),
			{ label: "solve", text: "solve(", hint: "solve(x^2 = 2, x)" }, { label: "integrate", text: "integrate(", hint: "integrate(x^2, x, 0, 3)" }, { label: "diff", text: "diff(", hint: "diff(x^3, x, 2)" },
			{ label: "x", text: "x" }, { label: "=", text: " = " },
		],
	},
];

/** Expressions that show what the calculator reads (the "Try" chips); each fills the expression and works on its own. */
export const EXAMPLES: readonly string[] = [
	"3 km/h to m/s",
	"1/3 + 1/6",
	"a = 3.2",
	"2 * pi * 1.5 m",
	"5 kg * g",
	"(1 + 2i) * (3 - i)",
	"det([1, 2; 3, 4])",
	"inv([1, 2; 3, 4])",
	"mean([2, 4, 4, 5])",
	"std([2, 4, 4, 4, 5, 5, 7, 9])",
	"solve(x^2 = 2, x)",
	"f(x) = x^2 - 3",
	"integrate(x^2, x, 0, 3)",
	"sin(30 deg)",
	"2 h to min",
];

/** The text a key puts at the cursor; the pad and the chips share this so the tests can walk them. */
export function keyTexts(): string[] {
	return [...PAD.filter((k) => k.action === "insert").map((k) => k.text!), ...GROUPS.flatMap((g) => g.keys.map((k) => k.text))];
}
