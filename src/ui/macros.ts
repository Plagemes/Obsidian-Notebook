// 0.27 macros (#170): a macro is a name, an icon and an ordered list of actions of the registry (ui/actions.ts), run with one tap from a
// toolbar button, the All actions sheet or an Obsidian command. This file is the pure part: the data and its lenient reader, the explicit
// allow-list of actions a macro may use, the registry entries the macros become, the context rule and the runner. The runner knows nothing
// of the notebook: the view gives it a small environment (view/macro-run.ts), so the whole behaviour is unit-tested in Node.
//
// Safety, by construction:
// - only actions on MACRO_SAFE can run: tools, pen and eraser choices, favourite pens, arranging a selection, page paper and size, adding and
//   duplicating pages, moving between pages. No file is ever deleted, overwritten, exported or synced; no dialog opens; every step is a
//   synchronous edit through the History (locked pages and elements refuse as usual), with the same entry point a tap uses.
// - a step the registry does not know (a macro from a newer version) or that is not on the list is kept in the data, shown as unavailable and
//   skipped; a step that is known but cannot run now (a locked page, nothing selected) stops the macro at once, with one notice.
import { PAGE_SIZES, PAPER_KINDS } from "../model/types";
import { actionById, isEnabled, isRelevant, setExtraActions, type ActionDef, type UiContext } from "./actions";

/** At most this many macros, and steps in a macro: a bounded setting. */
export const MAX_MACROS = 12;
export const MAX_STEPS = 20;
/** Longest name of a macro (characters). */
export const MAX_NAME = 32;
/** The action id of a macro in the registry, the toolbar pins and the usage counts. */
export const MACRO_PREFIX = "macro-";
/** The undo step a macro run makes (English label; history-describe gives it a title). */
export const MACRO_LABEL = "Run macro";
/** The icon of a macro that has none (or an unreadable one). */
export const DEFAULT_MACRO_ICON = "zap";
/** Icons the editor offers (Lucide names, all in the Obsidian set). */
export const MACRO_ICONS: readonly string[] = [
	"zap", "workflow", "play", "star", "heart", "flag", "pencil", "highlighter", "brush", "layers", "grid-3x3", "file-plus", "bookmark", "sparkles", "rocket", "timer",
];

export interface MacroStep {
	/** An action id of the registry (kept as written when unknown). */
	action: string;
	/** The parameter of a step that takes one: a paper kind or a page size. */
	value?: string;
}

export interface Macro {
	/** Short, stable (the Obsidian command id and the toolbar pin use it). */
	id: string;
	name: string;
	icon: string;
	steps: MacroStep[];
}

/**
 * The actions a macro may use, by id. Each is a view action that makes its change at once (no dialog, no file), that goes through the
 * History or only changes what the view shows, and that is not marked dangerous. tests/macros.test.ts pins the list against the registry.
 */
export const MACRO_SAFE: ReadonlySet<string> = new Set([
	// tools, pens and the eraser
	"tool-pen", "tool-highlighter", "tool-eraser", "tool-lasso", "tool-shape", "tool-text", "tool-space",
	"shape-line", "shape-arrow", "shape-rectangle", "shape-ellipse",
	"eraser-stroke", "eraser-segment", "eraser-area", "eraser-larger", "eraser-smaller",
	"favourite-1", "favourite-2", "favourite-3", "favourite-4", "favourite-5", "favourite-6",
	// arranging the selection
	"selection-duplicate", "layer-front", "layer-back", "layer-forward", "layer-backward",
	"selection-rotate-cw", "selection-rotate-ccw", "selection-mirror-h", "selection-mirror-v",
	"selection-align-left", "selection-align-centre", "selection-align-right", "selection-align-top", "selection-align-middle", "selection-align-bottom",
	"selection-distribute-h", "selection-distribute-v", "selection-group", "selection-ungroup",
	// the page in view
	"page-paper", "page-size", "page-orientation", "page-infinite", "page-bookmark", "page-duplicate", "add-page", "insert-blank-page",
	// moving about and the ruler
	"next-page", "previous-page", "fit-width", "toggle-ruler",
]);

/** Why a step cannot run: unknown to this version, not allowed in a macro, or missing the value it needs. */
export type StepState = "ok" | "unknown" | "blocked" | "value";

/** The values a step of this action takes (paper kinds, page sizes), or null when it takes none. */
export function stepChoices(a: ActionDef): readonly string[] | null {
	if (a.choices === "paper") return PAPER_KINDS;
	if (a.choices === "size") return Object.keys(PAGE_SIZES);
	return null;
}

/** Whether `step` can run in this version: known, on the allow-list and with a valid value when it takes one. */
export function stepState(step: MacroStep): StepState {
	const a = actionById(step.action);
	if (!a || isMacroActionId(step.action)) return "unknown";
	if (!MACRO_SAFE.has(step.action) || a.danger || a.scope !== "view") return "blocked";
	const choices = stepChoices(a);
	if (choices && (step.value === undefined || !choices.includes(step.value))) return "value";
	return "ok";
}

/** The actions the editor offers when adding a step, in registry order. */
export function allowedActions(all: readonly ActionDef[]): ActionDef[] {
	return all.filter((a) => MACRO_SAFE.has(a.id) && a.scope === "view" && !a.danger);
}

// ------------------------------------------------------------------------------------------------------------------------- data

const ID_RE = /^[a-z0-9]{1,16}$/;
const ACTION_RE = /^[A-Za-z0-9:_.-]{1,80}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;

export function isMacroActionId(id: string): boolean {
	return id.startsWith(MACRO_PREFIX) && ID_RE.test(id.slice(MACRO_PREFIX.length));
}

export const macroActionId = (id: string): string => `${MACRO_PREFIX}${id}`;

/** A new macro id that no macro of `taken` has. */
export function newMacroId(taken: readonly Macro[], random: () => number = Math.random): string {
	const free = (id: string): boolean => !taken.some((m) => m.id === id);
	for (let i = 0; i < 20; i++) {
		const id = `m${Math.floor(random() * 36 ** 5).toString(36).padStart(5, "0")}`;
		if (free(id)) return id;
	}
	// A random source that keeps colliding (or is stuck): count up. There are at most MAX_MACROS ids taken, so this ends.
	for (let n = 1; ; n++) {
		const id = `m${n.toString(36).padStart(5, "0")}`;
		if (free(id)) return id;
	}
}

/** A name as stored: one line, trimmed, at most MAX_NAME characters; empty falls back to `fallback`. */
export function cleanName(name: unknown, fallback = "Macro"): string {
	const s = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
	return Array.from(s).slice(0, MAX_NAME).join("").trim() || fallback;
}

function readStep(data: unknown): MacroStep | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.action !== "string" || !ACTION_RE.test(d.action)) return null;
	const step: MacroStep = { action: d.action };
	if (typeof d.value === "string" && d.value.length > 0 && d.value.length <= 40) step.value = d.value;
	return step;
}

/**
 * Whatever was stored, as a valid list: at most MAX_MACROS macros of at most MAX_STEPS steps, unique ids, a name and an icon each.
 * Unknown action ids are kept (they may belong to a newer version); anything that is not a list, a name or a step is dropped.
 */
export function normaliseMacros(data: unknown): Macro[] {
	if (!Array.isArray(data)) return [];
	const out: Macro[] = [];
	for (const item of data) {
		if (out.length >= MAX_MACROS) break;
		if (typeof item !== "object" || item === null) continue;
		const d = item as Record<string, unknown>;
		let id = typeof d.id === "string" && ID_RE.test(d.id) ? d.id : "";
		if (!id || out.some((m) => m.id === id)) id = newMacroId(out);
		const steps = (Array.isArray(d.steps) ? d.steps : []).slice(0, MAX_STEPS).flatMap((s) => {
			const step = readStep(s);
			return step ? [step] : [];
		});
		out.push({ id, name: cleanName(d.name), icon: typeof d.icon === "string" && ICON_RE.test(d.icon) ? d.icon : DEFAULT_MACRO_ICON, steps });
	}
	return out;
}

export function cloneMacro(m: Macro): Macro {
	return { id: m.id, name: m.name, icon: m.icon, steps: m.steps.map((s) => ({ ...s })) };
}

/** The pinned toolbar ids without the macros that no longer exist. */
export function withoutMissingMacros(pinned: readonly string[], macros: readonly Macro[]): string[] {
	return pinned.filter((p) => !isMacroActionId(p) || macros.some((m) => macroActionId(m.id) === p));
}

// --------------------------------------------------------------------------------------------------------------------- the registry

/** The macros the registry currently holds. */
let CURRENT: readonly Macro[] = [];

/** The registry entry of a macro: in its own group of the sheet, pinnable to the toolbar, never ranked into a quick slot by itself. */
export function macroAction(m: Macro): ActionDef {
	return {
		id: macroActionId(m.id), label: "macros.action", name: m.name, icon: m.icon, group: "macros", surfaces: ["sheet", "quick"],
		priority: 40, scope: "view", pinOnly: true, keywords: "macro sequence",
	};
}

/** Makes `macros` the macros of the registry (sheet, toolbar, `actionById`). Call it when the settings load or change. */
export function setMacros(macros: readonly Macro[]): void {
	CURRENT = macros.map(cloneMacro);
	setExtraActions(CURRENT.map(macroAction));
}

export function currentMacros(): readonly Macro[] {
	return CURRENT;
}

export function macroById(id: string): Macro | undefined {
	return CURRENT.find((m) => m.id === id || macroActionId(m.id) === id);
}

/** The action a macro starts with (its first step that can run), or null for a macro with no step that can run. */
export function macroStart(macro: Macro): ActionDef | null {
	for (const s of macro.steps) if (stepState(s) === "ok") return actionById(s.action) ?? null;
	return null;
}

/** The action id of a macro (as `macro-<id>`) for the context rule of the sheet, or null when it is not a macro of the registry. */
export function startOfMacroAction(id: string): ActionDef | null {
	const m = isMacroActionId(id) ? macroById(id) : undefined;
	return m ? macroStart(m) : null;
}

/** A line naming a step ("Paper: Grid"). `label` names an action, `choice` names one of its values. */
export function stepName(step: MacroStep, label: (a: ActionDef) => string, choice: (a: ActionDef, value: string) => string): string {
	const a = actionById(step.action);
	if (!a || isMacroActionId(step.action)) return step.action;
	return step.value !== undefined && stepChoices(a) ? `${label(a)}: ${choice(a, step.value)}` : label(a);
}

/** How many steps of the macro can run in this version. */
export function usableSteps(macro: Macro): number {
	return macro.steps.filter((s) => stepState(s) === "ok").length;
}

// ------------------------------------------------------------------------------------------------------------------------ running

/** What the runner needs from the notebook view. */
export interface MacroEnv {
	/** The UI context now (read before every step: the earlier steps change it). */
	context(): UiContext;
	/** Whether the command applies in the view now (commandApplies of the view). */
	applies(id: string): boolean;
	/** Runs the action as a tap does (view.runAction). */
	run(id: string, arg: { value?: string }): void;
	/** How many edits the History or the page lock refused so far (a counter: a step is refused when it grows). */
	refusals(): number;
	/** Runs `fn` so that everything it records in the History is one undo step named `label`. */
	group<T>(label: string, fn: () => T): T;
}

/** Why a macro stopped: the step cannot run now ("unavailable"), the History refused its edit ("refused"), or it threw ("error"). */
export type MacroFailure = "unavailable" | "refused" | "error";

export type MacroResult =
	| { ok: true; ran: number; skipped: number }
	| { ok: false; reason: "empty" }
	| { ok: false; reason: MacroFailure; /** 0-based index of the step */ step: number; action: string; done: number; skipped: number };

/**
 * Runs the steps in order as one undo step. A step the registry does not know, that is not allowed or that lacks its value is skipped; a
 * step that cannot run now, whose edit is refused or that throws stops the macro (the steps before it stay done, in the same undo step).
 */
export function runMacro(macro: Macro, env: MacroEnv): MacroResult {
	if (usableSteps(macro) === 0) return { ok: false, reason: "empty" };
	let done = 0;
	let skipped = 0;
	const stop: { failure: MacroResult | null } = { failure: null };
	env.group(MACRO_LABEL, () => {
		for (let i = 0; i < macro.steps.length; i++) {
			const step = macro.steps[i]!;
			const a = actionById(step.action);
			if (!a || stepState(step) !== "ok") {
				skipped++;
				continue;
			}
			const c = env.context();
			if (!isRelevant(a, c) || !isEnabled(a, c) || !env.applies(step.action)) {
				stop.failure = { ok: false, reason: "unavailable", step: i, action: step.action, done, skipped };
				return;
			}
			const before = env.refusals();
			try {
				env.run(step.action, stepChoices(a) && step.value !== undefined ? { value: step.value } : {});
			} catch (e) {
				console.error("[notebook] macro step failed", step.action, e);
				stop.failure = { ok: false, reason: "error", step: i, action: step.action, done, skipped };
				return;
			}
			if (env.refusals() !== before) {
				stop.failure = { ok: false, reason: "refused", step: i, action: step.action, done, skipped };
				return;
			}
			done++;
		}
	});
	return stop.failure ?? { ok: true, ran: done, skipped };
}
