import { afterEach, describe, expect, it } from "vitest";
import viewActionsSrc from "../src/view/view-actions.ts?raw";
import enSrc from "../src/i18n/en.ts?raw";
import itSrc from "../src/i18n/it.ts?raw";
import { createPage } from "../src/model/document";
import { AddStroke, History } from "../src/model/history";
import { LABELS } from "../src/model/history-describe";
import { ACTIONS, actionById, allActions, baseContext, type UiContext } from "../src/ui/actions";
import { MAX_PINNED, normalisePinned, togglePinned } from "../src/ui/adapt";
import { contextBoost, forThisPage, HERE_MIN_BOOST } from "../src/ui/context-rank";
import { buildLayout, buildSheet } from "../src/ui/layout";
import {
	cleanName, currentMacros, MACRO_ICONS, MACRO_LABEL, MACRO_SAFE, macroAction, macroActionId, MAX_MACROS, MAX_NAME, MAX_STEPS, newMacroId, normaliseMacros,
	runMacro, setMacros, stepName, stepState, usableSteps, withoutMissingMacros, type Macro, type MacroEnv,
} from "../src/ui/macros";
import { line, sampleDocument } from "./helpers";

afterEach(() => setMacros([]));

const macro = (id: string, steps: Array<[string, string?]>, over: Partial<Macro> = {}): Macro => ({
	id, name: `Macro ${id}`, icon: "zap", steps: steps.map(([action, value]) => (value === undefined ? { action } : { action, value })), ...over,
});

type Ran = Array<[string, { value?: string }]>;

/** An environment that records what ran; `context` can be changed between steps. */
function fakeEnv(over: Partial<MacroEnv> = {}, context: () => UiContext = () => baseContext()) {
	const ran: Ran = [];
	let refusals = 0;
	const env: MacroEnv = {
		context, applies: () => true, run: (id, arg) => void ran.push([id, arg]), refusals: () => refusals, group: (_label, fn) => fn(), ...over,
	};
	return { env, ran, refuse: () => void refusals++ };
}

describe("reading the macros leniently", () => {
	it("keeps good macros, drops what is not one, and bounds the list", () => {
		expect(normaliseMacros(undefined)).toEqual([]);
		expect(normaliseMacros("nope")).toEqual([]);
		const read = normaliseMacros([
			{ id: "a1", name: "  Maths   page ", icon: "star", steps: [{ action: "tool-pen" }, { action: "page-paper", value: "grid" }, { action: 7 }, null, "x"] },
			null, 5, "x",
			{ id: "a1", name: "Same id", steps: [] },
			{ name: 4, icon: "Bad Icon!", steps: "no" },
		]);
		expect(read).toHaveLength(3);
		expect(read[0]).toEqual({ id: "a1", name: "Maths page", icon: "star", steps: [{ action: "tool-pen" }, { action: "page-paper", value: "grid" }] });
		expect(new Set(read.map((m) => m.id)).size).toBe(3);
		expect(read[1]!.name).toBe("Same id");
		expect(read[2]).toMatchObject({ name: "Macro", icon: "zap", steps: [] });
		const many = normaliseMacros(Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `n${i}`, steps: Array.from({ length: 50 }, () => ({ action: "tool-pen" })) })));
		expect(many).toHaveLength(MAX_MACROS);
		expect(many[0]!.steps).toHaveLength(MAX_STEPS);
	});

	it("keeps an action id it does not know, and drops one that cannot be an id", () => {
		const [m] = normaliseMacros([{ id: "x", name: "N", steps: [{ action: "from-a-newer-version", value: "42" }, { action: "bad id with spaces" }] }]);
		expect(m!.steps).toEqual([{ action: "from-a-newer-version", value: "42" }]);
	});

	it("cuts a long name and falls back for an empty one", () => {
		expect(Array.from(cleanName("x".repeat(100))).length).toBe(MAX_NAME);
		expect(cleanName("   ")).toBe("Macro");
		expect(cleanName(undefined, "Fallback")).toBe("Fallback");
	});

	it("makes ids that are not taken", () => {
		const taken = [macro("m00000", [])];
		expect(newMacroId(taken, () => 0)).not.toBe("m00000");
		expect(newMacroId([], () => 0.5)).toMatch(/^m[0-9a-z]{5}$/);
	});

	it("offers only icons that are lower-case Lucide names", () => {
		for (const icon of MACRO_ICONS) expect(icon).toMatch(/^[a-z0-9-]+$/);
	});
});

describe("the allow-list", () => {
	it("holds only view actions of the registry that are not dangerous, and each has a runner", () => {
		for (const id of MACRO_SAFE) {
			const a = ACTIONS.find((x) => x.id === id);
			expect(a, id).toBeDefined();
			expect(a!.scope, id).toBe("view");
			expect(a!.danger, id).toBeFalsy();
			expect(viewActionsSrc.includes(`"${id}":`), `${id} has no runner`).toBe(true);
		}
	});

	it("never lets a macro delete, export, sync, undo or switch modes", () => {
		for (const id of [
			"delete-selection", "page-delete", "move-pages", "page-lock", "page-unlock", "page-lock-toggle", "export-pdf", "export-dialog", "export-png", "export-markdown",
			"share-page", "backup-now", "cloud-sync-now", "sync-check", "check-integrity", "library-check", "storage-manager", "undo", "redo", "toggle-read-only",
			"night-mode", "present", "insert-image", "restore-page", "page-restore-version", "notebook-save-template", "create", "open-library", "macros-open",
		]) expect(MACRO_SAFE.has(id), id).toBe(false);
		for (const id of MACRO_SAFE) expect(id, id).not.toMatch(/delete|trash|export|sync|backup|restore|share|remove|overwrite/);
	});

	it("tells why a step cannot run", () => {
		expect(stepState({ action: "tool-pen" })).toBe("ok");
		expect(stepState({ action: "page-paper", value: "grid" })).toBe("ok");
		expect(stepState({ action: "page-paper", value: "tartan" })).toBe("value");
		expect(stepState({ action: "page-paper" })).toBe("value");
		expect(stepState({ action: "page-size", value: "a4" })).toBe("ok");
		expect(stepState({ action: "from-a-newer-version" })).toBe("unknown");
		expect(stepState({ action: "macro-abc" })).toBe("unknown");
		expect(stepState({ action: "delete-selection" })).toBe("blocked");
		expect(stepState({ action: "export-pdf" })).toBe("blocked");
		expect(stepState({ action: "open-library" })).toBe("blocked");
	});

	it("names a step with its value", () => {
		const label = (a: { id: string }) => `<${a.id}>`;
		const choice = (_a: unknown, v: string) => v.toUpperCase();
		expect(stepName({ action: "page-paper", value: "grid" }, label, choice)).toBe("<page-paper>: GRID");
		expect(stepName({ action: "tool-pen" }, label, choice)).toBe("<tool-pen>");
		expect(stepName({ action: "gone" }, label, choice)).toBe("gone");
	});
});

describe("macros in the registry, the sheet and the toolbar", () => {
	const M = [macro("aaa", [["tool-pen"]]), macro("bbb", [["selection-duplicate"]], { name: "Copy it" })];

	it("join the registry without touching the fixed actions", () => {
		const before = ACTIONS.length;
		setMacros(M);
		expect(ACTIONS).toHaveLength(before);
		expect(actionById("macro-aaa")).toMatchObject({ name: "Macro aaa", icon: "zap", group: "macros", pinOnly: true });
		expect(allActions()).toHaveLength(before + 2);
		expect(currentMacros().map((m) => m.id)).toEqual(["aaa", "bbb"]);
		setMacros([]);
		expect(actionById("macro-aaa")).toBeUndefined();
		expect(allActions()).toBe(ACTIONS);
	});

	it("are never part of the fixed registry", () => {
		expect(macroAction(M[0]!).id.startsWith("macro-")).toBe(true);
		expect(ACTIONS.some((a) => a.id.startsWith("macro-"))).toBe(false);
	});

	it("are listed in their own section of All actions, after the manager's entry", () => {
		setMacros(M);
		const sections = buildSheet(baseContext(), { kind: "all", usage: {}, now: 0, label: (a) => a.name ?? a.id });
		const mine = sections.find((s) => s.id === "macros")!;
		expect(mine.actions.map((a) => a.id)).toEqual(["macros-open", "macro-aaa", "macro-bbb"]);
		expect(buildSheet(baseContext(), { kind: "page", usage: {}, now: 0, label: (a) => a.id }).some((s) => s.actions.some((a) => a.id.startsWith("macro-")))).toBe(false);
		const found = buildSheet(baseContext(), { kind: "all", usage: {}, now: 0, query: "copy it", label: (a) => a.name ?? a.id });
		expect(found[0]!.actions.map((a) => a.id)).toContain("macro-bbb");
	});

	it("the manager is in the sheet even with no macro", () => {
		const sections = buildSheet(baseContext(), { kind: "all", usage: {}, now: 0, label: (a) => a.id });
		expect(sections.find((s) => s.id === "macros")!.actions.map((a) => a.id)).toEqual(["macros-open"]);
	});

	it("are on the toolbar only when pinned, in the pinned order, and never ranked in by themselves", () => {
		setMacros(M);
		const plain = buildLayout(baseContext(), 1280, { "macro-aaa": { n: 99, last: 0 } }, 0);
		expect(plain.quick.some((id) => id.startsWith("macro-"))).toBe(false);
		const pinned = buildLayout(baseContext(), 1280, {}, 0, undefined, undefined, { pageType: false, selection: false, pinned: ["macro-bbb", "macro-aaa"] });
		expect(pinned.quick.slice(0, 2)).toEqual(["macro-bbb", "macro-aaa"]);
		const gone = buildLayout(baseContext(), 1280, {}, 0, undefined, undefined, { pageType: false, selection: false, pinned: ["macro-deleted", "macro-aaa"] });
		expect(gone.quick[0]).toBe("macro-aaa");
	});

	it("keep their button on a phone, where no ranked slot fits", () => {
		setMacros(M);
		const adapt = { pageType: false, selection: false, pinned: ["macro-aaa", "macro-bbb"] };
		const phone = buildLayout(baseContext({ narrow: true }), 360, {}, 0, undefined, undefined, adapt);
		expect(phone.quickSlots).toBe(0);
		expect(phone.quick).toEqual(["macro-aaa", "macro-bbb"]);
		const none = buildLayout(baseContext({ narrow: true }), 360, {}, 0);
		expect(none.quick).toEqual([]);
	});

	it("are not offered on a read-only notebook", () => {
		setMacros(M);
		const layout = buildLayout(baseContext({ editable: false }), 1280, {}, 0, undefined, undefined, { pageType: false, selection: false, pinned: ["macro-aaa"] });
		expect(layout.quick).not.toContain("macro-aaa");
	});

	it("pinning keeps a macro id and honours the limit of three", () => {
		expect(normalisePinned(["macro-abc", "tool-pen", "undo", "nav-back", "macro-def"])).toEqual(["macro-abc", "nav-back", "macro-def"]);
		expect(normalisePinned(["macro-../etc", "macro-", "macro-UPPER"])).toEqual([]);
		let p: string[] = [];
		for (const id of ["macro-a1", "macro-a2", "macro-a3", "macro-a4"]) p = togglePinned(p, id);
		expect(p).toHaveLength(MAX_PINNED);
		expect(togglePinned(p, "macro-a1")).toEqual(["macro-a2", "macro-a3"]);
		expect(withoutMissingMacros(["macro-a1", "nav-back", "macro-zz"], [macro("a1", [])])).toEqual(["macro-a1", "nav-back"]);
	});
});

describe("the context rule", () => {
	const onSelection = macro("sel", [["selection-duplicate"]]);
	const onPage = macro("pg", [["page-paper", "grid"]]);
	const selecting = baseContext({ tool: "lasso", selection: { strokes: 2, elements: 0, images: 0 } });

	it("puts a macro that starts on the selection first when something is selected, and steps back otherwise", () => {
		setMacros([onSelection, onPage]);
		const a = actionById("macro-sel")!;
		expect(contextBoost(a, selecting)).toBeGreaterThanOrEqual(HERE_MIN_BOOST);
		expect(contextBoost(a, baseContext())).toBe(-10);
		// It qualifies for "For this page" (the section keeps the best five of everything that qualifies).
		expect(forThisPage(allActions(), selecting, {}, 0, new Set(), 100).map((x) => x.id)).toContain("macro-sel");
		expect(forThisPage(allActions(), baseContext(), {}, 0, new Set(), 100).map((x) => x.id)).not.toContain("macro-sel");
	});

	it("leans a page macro forward a little, and a macro with nothing to run back", () => {
		setMacros([onPage, macro("none", [["from-a-newer-version"]])]);
		expect(contextBoost(actionById("macro-pg")!, baseContext())).toBe(6);
		expect(contextBoost(actionById("macro-pg")!, baseContext({ page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false, locked: true } }))).toBe(-10);
		expect(contextBoost(actionById("macro-none")!, baseContext())).toBe(-10);
		expect(contextBoost(actionById("macro-pg")!, baseContext({ open: false }))).toBe(0);
	});
});

describe("running a macro", () => {
	it("runs the steps in order with their values, and says how many", () => {
		const { env, ran } = fakeEnv();
		const r = runMacro(macro("a", [["tool-pen"], ["page-paper", "dotted"], ["add-page"]]), env);
		expect(r).toEqual({ ok: true, ran: 3, skipped: 0 });
		expect(ran).toEqual([["tool-pen", {}], ["page-paper", { value: "dotted" }], ["add-page", {}]]);
	});

	it("runs everything as one group named for the history", () => {
		const labels: string[] = [];
		const { env } = fakeEnv({ group: (label, fn) => { labels.push(label); return fn(); } });
		runMacro(macro("a", [["tool-pen"]]), env);
		expect(labels).toEqual([MACRO_LABEL]);
		expect(LABELS[MACRO_LABEL]).toBeDefined();
	});

	it("skips a step it does not know or does not allow, keeps going, and counts it", () => {
		const { env, ran } = fakeEnv();
		const r = runMacro(macro("a", [["tool-pen"], ["from-a-newer-version"], ["delete-selection"], ["page-paper", "tartan"], ["tool-eraser"]]), env);
		expect(r).toEqual({ ok: true, ran: 2, skipped: 3 });
		expect(ran.map(([id]) => id)).toEqual(["tool-pen", "tool-eraser"]);
	});

	it("never runs a blocked action even when the data says so", () => {
		const { env, ran } = fakeEnv();
		const r = runMacro(macro("a", [["delete-selection"], ["export-pdf"], ["cloud-sync-now"], ["page-delete"]]), env);
		expect(r).toEqual({ ok: false, reason: "empty" });
		expect(ran).toEqual([]);
		expect(usableSteps(macro("a", [["delete-selection"]]))).toBe(0);
	});

	it("an empty macro runs nothing", () => {
		const { env, ran } = fakeEnv();
		expect(runMacro(macro("a", []), env)).toEqual({ ok: false, reason: "empty" });
		expect(ran).toEqual([]);
	});

	it("stops at a step that cannot run now and names it; the steps before it are done", () => {
		const { env, ran } = fakeEnv();
		const r = runMacro(macro("a", [["tool-pen"], ["selection-duplicate"], ["tool-eraser"]]), env);
		expect(r).toEqual({ ok: false, reason: "unavailable", step: 1, action: "selection-duplicate", done: 1, skipped: 0 });
		expect(ran.map(([id]) => id)).toEqual(["tool-pen"]);
	});

	it("reads the context again before each step (an earlier step may make a later one possible)", () => {
		let selected = false;
		const context = () => baseContext(selected ? { tool: "lasso", selection: { strokes: 1, elements: 0, images: 0 } } : {});
		const trace: string[] = [];
		const { env } = fakeEnv({ run: (id) => { trace.push(id); if (id === "tool-lasso") selected = true; } }, context);
		const r = runMacro(macro("a", [["tool-lasso"], ["selection-duplicate"]]), env);
		expect(r).toEqual({ ok: true, ran: 2, skipped: 0 });
		expect(trace).toEqual(["tool-lasso", "selection-duplicate"]);
	});

	it("refuses to start a step on a read-only notebook or a locked page", () => {
		const first = fakeEnv({}, () => baseContext({ editable: false }));
		expect(runMacro(macro("a", [["tool-pen"]]), first.env)).toMatchObject({ ok: false, reason: "unavailable", step: 0, done: 0 });
		const locked = baseContext({ page: { index: 0, count: 2, background: "none", infinite: false, bookmarked: false, locked: true } });
		const second = fakeEnv({}, () => locked);
		expect(runMacro(macro("a", [["tool-pen"], ["page-paper", "grid"]]), second.env)).toMatchObject({ ok: false, reason: "unavailable", step: 1, done: 1 });
		expect(first.ran).toEqual([]);
		expect(second.ran.map(([id]) => id)).toEqual(["tool-pen"]);
	});

	it("stops when the command does not apply in the view", () => {
		const { env } = fakeEnv({ applies: (id) => id !== "next-page" });
		expect(runMacro(macro("a", [["tool-pen"], ["next-page"]]), env)).toMatchObject({ ok: false, reason: "unavailable", step: 1, done: 1 });
	});

	it("stops when a step is refused (the History or the page lock counted a refusal)", () => {
		const ctl = fakeEnv();
		ctl.env.run = (id) => {
			ctl.ran.push([id, {}]);
			if (id === "page-bookmark") ctl.refuse();
		};
		const r = runMacro(macro("a", [["tool-pen"], ["page-bookmark"], ["tool-eraser"]]), ctl.env);
		expect(r).toEqual({ ok: false, reason: "refused", step: 1, action: "page-bookmark", done: 1, skipped: 0 });
		expect(ctl.ran.map(([id]) => id)).toEqual(["tool-pen", "page-bookmark"]);
	});

	it("stops, with the group closed, when a step throws", () => {
		let closed = false;
		const { env } = fakeEnv({
			run: (id) => { if (id === "tool-eraser") throw new Error("boom"); },
			group: (_l, fn) => { try { return fn(); } finally { closed = true; } },
		});
		const r = runMacro(macro("a", [["tool-pen"], ["tool-eraser"], ["tool-lasso"]]), env);
		expect(r).toEqual({ ok: false, reason: "error", step: 1, action: "tool-eraser", done: 1, skipped: 0 });
		expect(closed).toBe(true);
	});
});

describe("a macro run on a real History", () => {
	function world() {
		const doc = sampleDocument(0);
		const first = doc.pages[0]!;
		const second = createPage();
		doc.pages.push(second);
		let refusals = 0;
		const history = new History(() => doc, 500, null, null, null, () => void refusals++);
		let n = 0;
		const add = (page: typeof first) => () => {
			history.execute(new AddStroke(page.id, line(0, n * 10, 5, n * 10 + 5), page.strokes.length));
			n++;
		};
		const env = (steps: Record<string, () => void>): MacroEnv => ({
			context: () => baseContext(), applies: () => true, run: (id) => steps[id]!(), refusals: () => refusals, group: (l, fn) => history.group(l, fn),
		});
		return { first, second, history, add, env };
	}

	it("is one undo step for all of its edits", () => {
		const w = world();
		const r = runMacro(macro("a", [["tool-pen"], ["tool-eraser"], ["tool-lasso"]]), w.env({ "tool-pen": w.add(w.first), "tool-eraser": w.add(w.second), "tool-lasso": w.add(w.first) }));
		expect(r).toEqual({ ok: true, ran: 3, skipped: 0 });
		expect(w.history.depth().undo).toBe(1);
		w.history.undo();
		expect(w.first.strokes).toHaveLength(0);
		expect(w.second.strokes).toHaveLength(0);
	});

	it("stops at the locked page, keeps the earlier steps as ONE undo step and the locked page untouched", () => {
		const w = world();
		w.second.locked = true;
		const r = runMacro(macro("a", [["tool-pen"], ["tool-eraser"], ["tool-lasso"], ["tool-text"]]), w.env({
			"tool-pen": w.add(w.first), "tool-eraser": w.add(w.first), "tool-lasso": w.add(w.second), "tool-text": w.add(w.first),
		}));
		expect(r).toEqual({ ok: false, reason: "refused", step: 2, action: "tool-lasso", done: 2, skipped: 0 });
		expect(w.second.strokes).toHaveLength(0);
		expect(w.first.strokes).toHaveLength(2);
		expect(w.history.depth().undo).toBe(1);
		w.history.undo();
		expect(w.first.strokes).toHaveLength(0);
	});
});

describe("the texts", () => {
	it("every macro string exists in English and Italian with the same variables", () => {
		const keys = [...enSrc.matchAll(/^\t"((?:macros|help\.macro|settings\.macros|ui\.group\.macros|histpanel\.t\.macro)[^"]*)": "((?:[^"\\]|\\.)*)"/gm)];
		expect(keys.length).toBeGreaterThan(40);
		const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
		for (const [, key, en] of keys) {
			const it = new RegExp(`^\\t"${key!.replace(/\./g, "\\.")}": "((?:[^"\\\\]|\\\\.)*)"`, "m").exec(itSrc);
			expect(it, `${key} in Italian`).not.toBeNull();
			expect(vars(it![1]!), key).toEqual(vars(en!));
		}
	});

	it("the id of a macro is the toolbar pin", () => {
		expect(macroActionId("abc")).toBe("macro-abc");
	});
});
