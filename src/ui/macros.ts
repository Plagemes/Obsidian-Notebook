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

// Review fixes (M6): the reader keeps every field it does not know, on the macro and on each step, exactly as stored (the objects carry
// them along; `{ ...step }` copies them), so data.json written by a newer version survives an older device saving the settings.
export interface MacroStep {
	/** An action id of the registry (kept as written when unknown). */
	action: string;
	/** The parameter of a step that takes one: a paper kind or a page size. (Read verbatim: a newer version may store another kind of value, which only stops this version from running the step.) */
	value?: string;
}

export interface Macro {
	/** Short, stable (the Obsidian command id and the toolbar pin use it). */
	id: string;
	name: string;
	icon: string;
	steps: MacroStep[];
	/** Steps stored beyond this version's limit or that this version cannot read as a step: kept as written and written back; they move into `steps` (and run) when there is room. */
	extraSteps?: unknown[];
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
	// A step kept as written that is not even an action id (a newer version's kind of step) is simply unknown.
	if (typeof step.action !== "string") return "unknown";
	const a = actionById(step.action);
	if (!a || isMacroActionId(step.action)) return "unknown";
	if (!MACRO_SAFE.has(step.action) || a.danger || a.scope !== "view") return "blocked";
	const choices = stepChoices(a);
	if (choices && (typeof step.value !== "string" || !choices.includes(step.value))) return "value";
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

/** A plain copy of data that came out of JSON (so it holds only values JSON can hold). */
function copyJson<T>(v: T): T {
	try {
		return JSON.parse(JSON.stringify(v)) as T;
	} catch {
		return v;
	}
}

/** A step as stored: its fields as written (unknown ones included), with a valid action id; null when it cannot be one. */
function readStep(data: unknown): MacroStep | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.action !== "string" || !ACTION_RE.test(d.action)) return null;
	return copyJson({ ...d }) as unknown as MacroStep;
}

/** At most this many foreign items (steps of a macro, whole macros) are kept as written; a bound for a stored list that grows without end. */
const MAX_KEPT = 200;

/** Where `readMacros` found the macros that do not fit this version, kept as written. */
export interface MacroRead {
	macros: Macro[];
	/** Whole macros beyond MAX_MACROS, as written, and macros with an id of a format this version does not know: written back with the settings; a macro beyond the limit moves into the list when there is room. */
	extra: unknown[];
	/** A stored id was invalid or used twice and got a new one. */
	repaired: boolean;
	/** The repair is worth saving once: an id was missing or used twice (not merely of a format this version does not know). */
	persist: boolean;
}

/** FNV-1a, 32 bits: a stable number for a string (the same on every device and every start). */
function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** The id an invalid or doubled stored id is replaced with: derived from the macro's place and name, so every start gives the same one (hotkeys and pins stay put). */
function repairedId(taken: ReadonlySet<string>, index: number, name: string): string {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const id = `m${(hash32(`${index}|${name}|${attempt}`) % 36 ** 5).toString(36).padStart(5, "0")}`;
		if (!taken.has(id)) return id;
	}
	for (let n = 1; ; n++) {
		const id = `m${n.toString(36).padStart(5, "0")}`;
		if (!taken.has(id)) return id;
	}
}

/**
 * Whatever was stored, as a valid list: at most MAX_MACROS macros of at most MAX_STEPS steps, unique ids, a name and an icon each.
 * Nothing that may belong to a newer version is thrown away: unknown action ids and unknown fields (of a macro and of a step) stay as
 * written, steps beyond the limit and macros beyond the limit are kept apart (`extraSteps`, `extra`) and written back; they move into the list (and run) when there is room.
 * Only what is not a list, a name or a step at all is dropped. `prior` is the `extra` list stored earlier.
 */
export function readMacros(data: unknown, prior?: unknown): MacroRead {
	const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
	const stored = Array.isArray(prior) ? prior.filter(isObj) : [];
	if (!Array.isArray(data)) return { macros: [], extra: stored.slice(0, MAX_KEPT), repaired: false, persist: false };
	const listed = data.filter(isObj);
	// Review fix (R3): the macros kept apart earlier come back after the listed ones and are split again by this version's limit (a newer
	// version that wrote its whole list gets it back), without a macro twice: an id already in the list, or kept twice, is dropped.
	const ids = new Set(listed.flatMap((d) => (typeof d.id === "string" && ID_RE.test(d.id) ? [d.id] : [])));
	const back = stored.filter((d) => {
		if (typeof d.id !== "string" || !ID_RE.test(d.id)) return true;
		if (ids.has(d.id)) return false;
		ids.add(d.id);
		return true;
	});
	const items = [...listed, ...back];
	// Review fix (T1): a macro whose id is of a format this version does not know (a newer version's) cannot have a command or a pin here, and
	// its id must not be replaced (the next save would write the replacement over it): it is kept apart as written, whatever room there is.
	const foreign = (d: Record<string, unknown>): boolean => typeof d.id === "string" && d.id !== "" && !ID_RE.test(d.id);
	const ours = items.filter((d) => !foreign(d));
	const kept = ours.slice(0, MAX_MACROS);
	const extra = [...ours.slice(MAX_MACROS), ...items.filter(foreign)].slice(0, MAX_KEPT).map((d) => copyJson(d));
	let persist = false;
	// An id that is fine and first is never changed; only the others get a new one (which avoids all of them).
	const claimed = new Set<string>();
	for (const d of kept) if (typeof d.id === "string" && ID_RE.test(d.id) && !claimed.has(d.id)) claimed.add(d.id);
	const seen = new Set<string>();
	const taken = new Set(claimed);
	let repaired = false;
	const macros = kept.map((d, index): Macro => {
		let id = typeof d.id === "string" && ID_RE.test(d.id) && !seen.has(d.id) ? d.id : "";
		const name = cleanName(d.name);
		if (!id) {
			id = repairedId(taken, index, name);
			taken.add(id);
			repaired = true;
			// Only a missing or doubled id is replaced (an id of another format was set apart above), and that is worth saving once.
			persist = true;
		}
		seen.add(id);
		// Review fix (R3): the steps kept apart earlier follow the listed ones and are split again by count; a step this version cannot read
		// (not an action id it knows the form of) stays where it was, in `steps`, and is shown and skipped as unavailable.
		const listedSteps: unknown[] = Array.isArray(d.steps) ? (d.steps as unknown[]) : [];
		const keptSteps: unknown[] = Array.isArray(d.extraSteps) ? (d.extraSteps as unknown[]) : [];
		const raw: unknown[] = [...listedSteps, ...keptSteps];
		const steps: MacroStep[] = [];
		const extraSteps: unknown[] = [];
		for (const s of raw) {
			if (!isObj(s)) continue;
			if (steps.length < MAX_STEPS) steps.push((readStep(s) ?? copyJson({ ...s })) as unknown as MacroStep);
			else if (extraSteps.length < MAX_KEPT) extraSteps.push(copyJson(s));
		}
		const macro = { ...copyJson(d), id, name, icon: typeof d.icon === "string" && ICON_RE.test(d.icon) ? d.icon : DEFAULT_MACRO_ICON, steps } as Macro;
		if (extraSteps.length > 0) macro.extraSteps = extraSteps;
		else delete macro.extraSteps;
		return macro;
	});
	return { macros, extra, repaired, persist };
}

/**
 * Review fix (R4): the settings as stored again after a repair of macro ids. Only the fields the repair changed are replaced in what was
 * read, so keys this version does not know (a newer version's settings) stay exactly as they were.
 */
export function withRepairedFields(raw: Record<string, unknown>, fields: { macros: readonly Macro[]; macrosExtra: readonly unknown[]; pinnedQuick: readonly string[] }): Record<string, unknown> {
	return { ...raw, macros: fields.macros, macrosExtra: fields.macrosExtra, pinnedQuick: fields.pinnedQuick };
}

/** The macros of `readMacros` (see there). */
export function normaliseMacros(data: unknown): Macro[] {
	return readMacros(data).macros;
}

export function cloneMacro(m: Macro): Macro {
	return { ...m, steps: m.steps.map((s) => ({ ...s })), ...(m.extraSteps ? { extraSteps: copyJson(m.extraSteps) } : {}) };
}

/**
 * Review fix (T2): the pins of macros that are not in the registry of this version (a newer version's, kept in the settings) draw nothing, so
 * they take none of the visible toolbar places: these are the pins that do.
 */
export function visiblePins(pinned: readonly string[]): string[] {
	return pinned.filter((p) => !isMacroActionId(p) || macroById(p) !== undefined);
}

/** The pinned toolbar ids without the macros that no longer exist. */
export function withoutMissingMacros(pinned: readonly string[], macros: ReadonlyArray<{ id: string }>): string[] {
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
	if (typeof step.action !== "string") return "?";
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
	/** True while a stroke, an erase or a drag is in progress: the macro does not start then (it would relayout under the pen). */
	writing?(): boolean;
	/**
	 * Called once, before the group opens: ends what is still open so it stays its own undo step (a text box or an equation being typed)
	 * and settles page-turn animations, so every page step starts from the page the one before arrived on.
	 */
	prepare?(): void;
	/** How many edits the History has recorded so far in this run (a counter): an edit step that leaves it unchanged changed nothing. */
	edits?(): number;
}

/** Why a macro stopped: the step cannot run now ("unavailable"), the History refused its edit ("refused"), or it threw ("error"). */
export type MacroFailure = "unavailable" | "refused" | "error";

/** `noEffect`: steps that ran but changed nothing (not counted as done); left out when there are none. */
export type MacroResult =
	| { ok: true; ran: number; skipped: number; noEffect?: number }
	| { ok: false; reason: "empty" | "writing" }
	| { ok: false; reason: MacroFailure; /** 0-based index of the step */ step: number; action: string; done: number; skipped: number; noEffect?: number };

/**
 * The steps that edit the notebook (through the History). Only these can be told to have had no effect: a tool or pen choice, a page
 * turn or a ruler leaves no edit behind and is done as soon as it ran.
 */
export function isEditStep(id: string): boolean {
	return /^(layer-|selection-|page-(paper|size|orientation|infinite|bookmark|duplicate)$|add-page$|insert-blank-page$)/.test(id);
}

/**
 * Runs the steps in order as one undo step. A step the registry does not know, that is not allowed or that lacks its value is skipped; a
 * step that cannot run now, whose edit is refused or that throws stops the macro (the steps before it stay done, in the same undo step).
 * An edit step that changed nothing (read-only, nothing to arrange, a page that already has that paper) is counted apart, not as done.
 * Nothing that goes wrong inside a step or while asking whether it can run escapes: it stops the macro with a "error" result.
 */
export function runMacro(macro: Macro, env: MacroEnv): MacroResult {
	if (usableSteps(macro) === 0) return { ok: false, reason: "empty" };
	if (env.writing?.()) return { ok: false, reason: "writing" };
	let done = 0;
	let skipped = 0;
	let noEffect = 0;
	const failed = (reason: MacroFailure, step: number, action: string): MacroResult => ({
		ok: false, reason, step, action, done, skipped, ...(noEffect > 0 ? { noEffect } : {}),
	});
	const stop: { failure: MacroResult | null } = { failure: null };
	try {
		env.prepare?.();
	} catch (e) {
		console.error("[notebook] macro could not get ready", e);
		return failed("error", 0, macro.steps[0]?.action ?? "");
	}
	env.group(MACRO_LABEL, () => {
		for (let i = 0; i < macro.steps.length; i++) {
			const step = macro.steps[i]!;
			const a = actionById(step.action);
			if (!a || stepState(step) !== "ok") {
				skipped++;
				continue;
			}
			let refusalsBefore = 0;
			let editsBefore = 0;
			try {
				const c = env.context();
				if (!isRelevant(a, c) || !isEnabled(a, c) || !env.applies(step.action)) {
					stop.failure = failed("unavailable", i, step.action);
					return;
				}
				refusalsBefore = env.refusals();
				editsBefore = env.edits?.() ?? 0;
				env.run(step.action, stepChoices(a) && typeof step.value === "string" ? { value: step.value } : {});
			} catch (e) {
				console.error("[notebook] macro step failed", step.action, e);
				stop.failure = failed("error", i, step.action);
				return;
			}
			if (env.refusals() !== refusalsBefore) {
				stop.failure = failed("refused", i, step.action);
				return;
			}
			if (env.edits && isEditStep(step.action) && env.edits() === editsBefore) noEffect++;
			else done++;
		}
	});
	return stop.failure ?? { ok: true, ran: done, skipped, ...(noEffect > 0 ? { noEffect } : {}) };
}
