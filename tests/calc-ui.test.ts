import { describe, expect, it } from "vitest";
import { CalcSession, evaluate, functionNames } from "../src/math/calc";
import { CONSTANTS } from "../src/math/calc-constants";
import { graphLink } from "../src/math/calc-graph";
import { tokenize } from "../src/math/calc-parse";
import { ACTIONS, baseContext } from "../src/ui/actions";
import { EXAMPLES, GROUPS, PAD, keyTexts } from "../src/ui/calc-keys";
import { CALC_STORE_KEY, EMPTY_STORE, MAX_BOOKS, MAX_TAPE, answerOf, booksVars, loadCalcStore, normaliseCalcStore, pushTape, saveCalcStore, withBook } from "../src/ui/calc-store";
import { HERE_MIN_BOOST, contextBoost } from "../src/ui/context-rank";
import { ACTION_HELP } from "../src/ui/help-text";

import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";

const SOURCES = import.meta.glob<string>("../src/math/calc*.ts", { query: "?raw", import: "default", eager: true });

const hasKey = (src: string, key: string): boolean => src.includes(`"${key}":`);

describe("calculator: strings", () => {
	it("has a message for every error code, in English and Italian", () => {
		const codes = new Set<string>(["generic", "unknown-function", "not-a-function"]);
		for (const text of Object.values(SOURCES)) {
			for (const m of text.matchAll(/(?:CalcError\(|this\.fail\()\s*"([a-z][a-z-]*)"/g)) codes.add(m[1]!);
		}
		expect(codes.size).toBeGreaterThan(40);
		for (const code of codes) {
			expect(hasKey(enSrc, `calc.err.${code}`), `en ${code}`).toBe(true);
			expect(hasKey(itSrc, `calc.err.${code}`), `it ${code}`).toBe(true);
		}
	});

	it("names every constant, key and group", () => {
		const keys = [
			...CONSTANTS.map((c) => c.label as string),
			...PAD.map((k) => k.name as string),
			...GROUPS.map((g) => g.title as string),
		];
		for (const key of keys) {
			expect(hasKey(enSrc, key), `en ${key}`).toBe(true);
			expect(hasKey(itSrc, key), `it ${key}`).toBe(true);
		}
	});

	it("has every calc.* string in both languages", () => {
		const re = /"(calc\.[A-Za-z0-9.-]+|help\.calculator)":/g;
		const en = new Set([...enSrc.matchAll(re)].map((m) => m[1]!));
		const it_ = new Set([...itSrc.matchAll(re)].map((m) => m[1]!));
		expect(en.size).toBeGreaterThan(150);
		expect([...en].filter((k) => !it_.has(k))).toEqual([]);
		expect([...it_].filter((k) => !en.has(k))).toEqual([]);
	});

	it("uses every calc.* key it is given from the dialog", () => {
		// The keys the dialog asks for by name exist.
		const view = import.meta.glob<string>("../src/view/calculator.ts", { query: "?raw", import: "default", eager: true });
		const text = Object.values(view)[0]!;
		for (const m of text.matchAll(/"(calc\.[A-Za-z0-9.-]+)"/g)) {
			if (m[1]!.endsWith(".err.")) continue;
			expect(hasKey(enSrc, m[1]!), m[1]).toBe(true);
		}
	});
});

describe("calculator: keys", () => {
	it("puts only text the tokenizer reads", () => {
		// The point only means something between digits.
		for (const text of keyTexts()) expect(() => tokenize(text === "." ? "1.5" : text), JSON.stringify(text)).not.toThrow();
	});

	it("offers functions that exist and constants that evaluate", () => {
		const fns = new Set(functionNames());
		for (const g of GROUPS) {
			for (const k of g.keys) {
				if (k.text.endsWith("(") && /^[A-Za-z]+\($/.test(k.text)) expect(fns.has(k.text.slice(0, -1)) || k.text === "sqrt(", k.text).toBe(true);
			}
		}
		for (const c of GROUPS.find((g) => g.id === "constants")!.keys) {
			const r = evaluate(c.text, new CalcSession());
			expect(r.ok, c.text).toBe(true);
		}
		for (const k of GROUPS.find((g) => g.id === "units")!.keys) {
			if (k.text === " to ") continue;
			const r = evaluate(`5${k.text}`, new CalcSession());
			expect(r.ok, k.text).toBe(true);
		}
	});

	it("has a pad of five by five with one equals key", () => {
		expect(PAD).toHaveLength(25);
		expect(PAD.filter((k) => k.action === "eval")).toHaveLength(1);
		expect(new Set(PAD.map((k) => k.label)).size).toBe(25);
	});

	it("gives examples that work on their own", () => {
		for (const ex of EXAMPLES) expect(evaluate(ex, new CalcSession()).ok, ex).toBe(true);
	});
});

describe("calculator: store", () => {
	it("reads whatever was stored, bounded", () => {
		expect(normaliseCalcStore(null)).toEqual(EMPTY_STORE);
		expect(normaliseCalcStore("junk")).toEqual(EMPTY_STORE);
		expect(normaliseCalcStore([1])).toEqual(EMPTY_STORE);
		const rows = Array.from({ length: 300 }, (_, i) => ({ expr: `${i}+1`, text: String(i + 1), latex: "" }));
		const s = normaliseCalcStore({ angle: "rad", tape: [...rows, { expr: 5 }, null, { expr: "", text: "x" }], format: { sig: 4, notation: "sci" } });
		expect(s.angle).toBe("rad");
		expect(s.tape).toHaveLength(MAX_TAPE);
		expect(s.format).toEqual({ sig: 4, notation: "sci", fractions: "exact" });
		expect(normaliseCalcStore({ angle: "grad" }).angle).toBe("deg");
	});

	it("keeps the variables of a bounded number of notebooks", () => {
		let store = EMPTY_STORE;
		for (let i = 0; i < MAX_BOOKS + 10; i++) store = withBook(store, `book-${i}`, { a: { kind: "fn", params: ["x"], body: "x" } });
		expect(store.books).toHaveLength(MAX_BOOKS);
		expect(store.books[0]!.id).toBe(`book-${MAX_BOOKS + 9}`);
		expect(booksVars(store, "book-0")).toBeNull();
		expect(booksVars(store, `book-${MAX_BOOKS + 9}`)).not.toBeNull();
		// An empty set forgets the notebook; a bad id is ignored.
		expect(withBook(store, `book-${MAX_BOOKS + 9}`, {}).books.some((b) => b.id === `book-${MAX_BOOKS + 9}`)).toBe(false);
		expect(withBook(store, "../evil", { a: { kind: "fn", params: [], body: "1" } })).toBe(store);
		const big = { v: { kind: "fn", params: [], body: "x".repeat(70_000) } } as never;
		expect(normaliseCalcStore({ books: [{ id: "ok", vars: big }] }).books).toHaveLength(0);
		expect(normaliseCalcStore({ books: [{ id: "a b", vars: {} }, { id: "ok", vars: {} }, { id: "ok", vars: {} }] }).books.map((b) => b.id)).toEqual(["ok"]);
	});

	it("pushes the tape without repeating the newest line", () => {
		const a = { expr: "1+1", text: "2", latex: "" };
		const t1 = pushTape([], a);
		expect(pushTape(t1, a)).toEqual([a]);
		expect(pushTape(t1, { ...a, expr: "2+2", text: "4" })).toHaveLength(2);
		expect(pushTape(Array.from({ length: MAX_TAPE }, () => a), { ...a, expr: "x" })).toHaveLength(MAX_TAPE);
	});

	it("loads and saves through the local storage, surviving a failing one", () => {
		const data = new Map<string, unknown>();
		const app = { loadLocalStorage: (k: string) => data.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => void data.set(k, v) };
		saveCalcStore(app, { ...EMPTY_STORE, angle: "rad", tape: [{ expr: "1", text: "1", latex: "" }] });
		expect(data.has(CALC_STORE_KEY)).toBe(true);
		const back = loadCalcStore(app);
		expect(back.angle).toBe("rad");
		expect(back.tape).toHaveLength(1);
		const broken = { loadLocalStorage: () => { throw new Error("no"); }, saveLocalStorage: () => { throw new Error("no"); } };
		expect(loadCalcStore(broken)).toEqual(EMPTY_STORE);
		expect(() => saveCalcStore(broken, EMPTY_STORE)).not.toThrow();
	});

	it("takes the answer of a tape row without its name", () => {
		expect(answerOf({ expr: "a = 3.2", text: "a = 3.2", latex: "" })).toBe("3.2");
		expect(answerOf({ expr: "1+1", text: "2", latex: "" })).toBe("2");
		expect(answerOf({ expr: "x", text: "1 = 2", latex: "" })).toBe("1 = 2");
	});
});

describe("calculator: graph link", () => {
	it("offers a graph for a function of x only", () => {
		const s = new CalcSession();
		expect(graphLink("sin(x)", s)).toEqual({ expr: "sin(x)", params: [], degrees: true });
		expect(graphLink("f(x) = x^2 - 3", s)).toEqual({ expr: "x^2 - 3", params: [], degrees: true });
		expect(graphLink("2 + 2", s)).toBeNull();
		expect(graphLink("f(t) = t^2", s)).toBeNull();
		expect(graphLink("3 m * x", s)).toBeNull();
		expect(graphLink("solve(x = 1, x)", s)).toBeNull();
		expect(graphLink("((", s)).toBeNull();
		s.angle = "rad";
		expect(graphLink("cos(x)", s)?.degrees).toBe(false);
	});

	it("turns the person's variables into parameters", () => {
		const s = new CalcSession();
		evaluate("a = 3.2", s);
		evaluate("v = 2 m", s);
		expect(graphLink("a * x", s)).toEqual({ expr: "a * x", params: [{ name: "a", value: 3.2 }], degrees: true });
		expect(graphLink("v * x", s)).toBeNull();
		evaluate("x = 1", s);
		expect(graphLink("x + 1", s)).toBeNull();
	});
});

describe("calculator: the action", () => {
	const def = ACTIONS.find((a) => a.id === "calculator")!;

	it("is registered with a command, a help text and a sheet place", () => {
		expect(def).toBeDefined();
		expect(def.surfaces).toContain("sheet");
		expect(def.command).toBe("calc.command.open");
		expect(ACTION_HELP.calculator).toBe("help.calculator");
		expect(def.readOnly).toBe(true);
	});

	it("ranks higher where numbers are being worked on, and never tops an ordinary page", () => {
		const plain = baseContext();
		const withText = baseContext({ tool: "lasso", selection: { strokes: 0, elements: 1, images: 0, texts: 1 } });
		const withEq = baseContext({ tool: "lasso", selection: { strokes: 0, elements: 1, images: 0, equations: 1, graphs: 0 } });
		const textTool = baseContext({ tool: "text" });
		expect(contextBoost(def, plain)).toBeLessThan(HERE_MIN_BOOST);
		expect(contextBoost(def, textTool)).toBeLessThan(HERE_MIN_BOOST);
		expect(contextBoost(def, textTool)).toBeGreaterThan(contextBoost(def, plain));
		expect(contextBoost(def, withText)).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		expect(contextBoost(def, withEq)).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		expect(contextBoost(def, { ...plain, open: false })).toBe(0);
	});
});
