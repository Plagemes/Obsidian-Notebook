// 0.27 inputlayout (roadmap #431): the layout follows the input device in use. Pure (no DOM, no 'obsidian'): unit-tested.
//
// The view only READS `pointerType` from events it already receives (a passive listener); this module decides what the layout
// should be. A device switch needs a few consistent events in a row, ignores touches that follow the pen closely (a resting palm)
// and never happens while a stroke or a drag is in progress, so the bars never reshape under the pen.
import type { ToolbarSize } from "./toolbar-size";

/** The device the layout is shaped for. */
export type InputKind = "pen" | "touch" | "mouse";
export const INPUT_KINDS: readonly InputKind[] = ["pen", "touch", "mouse"];

/** The setting "Adapt layout to input": automatic follows the detected device, the others pin one. */
export type InputPref = "auto" | InputKind;
export const INPUT_PREFS: readonly InputPref[] = ["auto", "pen", "touch", "mouse"];
export const DEFAULT_INPUT_PREF: InputPref = "auto";
/** What the layout is until a device has been seen: the current default (compact bar shaped for the pen). */
export const DEFAULT_INPUT_KIND: InputKind = "pen";

export function isInputPref(v: unknown): v is InputPref {
	return typeof v === "string" && (INPUT_PREFS as readonly string[]).includes(v);
}

/** Consistent events in a row needed to switch the detected device. */
export const SWITCH_AFTER = 3;
/** A touch this soon after the last pen event is a resting palm or a knuckle: it never counts towards a switch. */
export const PALM_MS = 1500;

/** `pointerType` as one of ours, or null for anything else (unknown, empty). */
export function kindOfPointer(pointerType: string): InputKind | null {
	return pointerType === "pen" ? "pen" : pointerType === "touch" ? "touch" : pointerType === "mouse" ? "mouse" : null;
}

/**
 * Follows the pointer events of one view. `feed` returns the new device when it changed, otherwise null.
 * A device change needs `SWITCH_AFTER` events of that device with no other device in between; events during a stroke are ignored.
 */
export class InputDetector {
	private cur: InputKind;
	private cand: InputKind | null = null;
	private count = 0;
	private lastPen = -Infinity;

	constructor(initial: InputKind = DEFAULT_INPUT_KIND) {
		this.cur = initial;
	}

	get current(): InputKind {
		return this.cur;
	}

	feed(pointerType: string, now: number, busy: boolean): InputKind | null {
		const kind = kindOfPointer(pointerType);
		if (!kind) return null;
		if (kind === "pen") this.lastPen = now;
		if (busy) {
			this.cand = null;
			this.count = 0;
			return null;
		}
		// A palm resting beside the pen reports touch: it is neither a vote for touch nor a break in the pen's run.
		if (kind === "touch" && now - this.lastPen < PALM_MS) return null;
		if (kind === this.cur) {
			this.cand = null;
			this.count = 0;
			return null;
		}
		if (this.cand !== kind) {
			this.cand = kind;
			this.count = 0;
		}
		this.count++;
		if (this.count < SWITCH_AFTER) return null;
		this.cur = kind;
		this.cand = null;
		this.count = 0;
		return kind;
	}
}

/** The layout in use: the pinned device of the setting, else the detected one. */
export function resolveInput(pref: InputPref, detected: InputKind): InputKind {
	return pref === "auto" ? detected : pref;
}

export const INPUT_CLASS_PREFIX = "nb-input-";
/** The CSS class of a device, next to the `nb-vp-*` classes on the view root. */
export function inputClass(kind: InputKind): string {
	return `${INPUT_CLASS_PREFIX}${kind}`;
}
/** Every class `inputClass` can return (to clear before applying). */
export const ALL_INPUT_CLASSES: readonly string[] = INPUT_KINDS.map(inputClass);

/**
 * The toolbar size in use: a finger gets one step more (bigger targets), the pen and the mouse keep the person's size.
 * The explicit size setting stays the base, so "Compact" still means smaller than "Normal" for a finger.
 */
export function effectiveToolbarSize(size: ToolbarSize, kind: InputKind): ToolbarSize {
	if (kind !== "touch") return size;
	return size === "compact" ? "normal" : "large";
}

/** Whether tooltips carry the keyboard shortcut (only a mouse and keyboard user can press it). */
export function showsShortcutHints(kind: InputKind): boolean {
	return kind === "mouse";
}

/** One Obsidian hotkey as stored by the hotkey manager. */
export interface HotkeyLike {
	modifiers?: readonly string[];
	key?: string;
}

const MOD_ORDER = ["Mod", "Ctrl", "Meta", "Alt", "Shift"] as const;

/** "Ctrl+Shift+K" (or "⌘⇧K" on a Mac) for a hotkey, or null when it has no key. */
export function formatHotkey(h: HotkeyLike, mac: boolean): string | null {
	const key = typeof h.key === "string" ? (h.key === " " ? h.key : h.key.trim()) : "";
	if (!key) return null;
	const mods = (h.modifiers ?? []).filter((m): m is (typeof MOD_ORDER)[number] => (MOD_ORDER as readonly string[]).includes(m));
	const sorted = MOD_ORDER.filter((m) => mods.includes(m));
	const names = sorted.map((m) => {
		if (m === "Mod") return mac ? "⌘" : "Ctrl";
		if (m === "Meta") return mac ? "⌘" : "Win";
		if (m === "Ctrl") return mac ? "⌃" : "Ctrl";
		if (m === "Alt") return mac ? "⌥" : "Alt";
		return mac ? "⇧" : "Shift";
	});
	const shown = key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;
	return mac ? `${names.join("")}${shown}` : [...names, shown].join("+");
}

/** The label with its shortcut: "Undo (Ctrl+Z)"; the label as it is when there is no hotkey. */
export function labelWithHotkey(label: string, hotkeys: readonly HotkeyLike[], mac: boolean): string {
	const shown = hotkeys.map((h) => formatHotkey(h, mac)).find((s): s is string => !!s);
	return shown ? `${label} (${shown})` : label;
}
