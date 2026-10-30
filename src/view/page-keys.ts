// wave 0.9 (372): the page turner. Keyboard arrows, PageUp / PageDown, space and the Bluetooth presentation clickers
// (which send PageUp / PageDown or the arrow keys) turn pages. Pure: the view feeds it the key and the situation.
// Android's volume keys never reach web content (the system handles them), so they cannot be used: see the README.

export type PageKeyAction = "next" | "previous";

export interface KeyLike {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	isComposing?: boolean;
	repeat?: boolean;
	defaultPrevented?: boolean;
}

/** Keys that turn forward, and keys that turn back. Space goes forward, Shift+Space back (as in any reader). */
const NEXT_KEYS = ["ArrowRight", "ArrowDown", "PageDown"];
const PREVIOUS_KEYS = ["ArrowLeft", "ArrowUp", "PageUp"];

/** What the key does, or null when it is not a page-turning key (any of Ctrl, Alt, Meta makes it a shortcut of something else). */
export function pageKeyAction(e: KeyLike): PageKeyAction | null {
	if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.repeat || e.defaultPrevented) return null;
	if (e.key === " " || e.key === "Spacebar") return e.shiftKey ? "previous" : "next";
	if (e.shiftKey) return null;
	if (NEXT_KEYS.includes(e.key)) return "next";
	if (PREVIOUS_KEYS.includes(e.key)) return "previous";
	return null;
}

/** Where the key was pressed and what the view is doing. */
export interface KeyScene {
	/** This notebook view is the active one. */
	viewActive: boolean;
	/** The focused element takes this key for itself (see takesKey). */
	targetEditable: boolean;
	/** A text box of the notebook is being edited, a stroke is being drawn or dragged. */
	busy: boolean;
	/** A modal dialog or a menu is open. */
	overlayOpen: boolean;
	/** The user turned the feature off. */
	enabled: boolean;
}

/** True when the page turner may act on the key now. */
export function shouldTurnPage(scene: KeyScene): boolean {
	return scene.enabled && scene.viewActive && !scene.targetEditable && !scene.busy && !scene.overlayOpen;
}

/**
 * Whether the focused element takes this key for itself: text fields, selects, sliders and editable elements take every
 * key; buttons, links and menu rows only the space bar (a button that was just tapped keeps the focus, and the arrows
 * and PageUp / PageDown must still turn pages then).
 */
export function takesKey(el: { tagName?: string; isContentEditable?: boolean; getAttribute?(name: string): string | null } | null, key: string): boolean {
	if (!el) return false;
	if (el.isContentEditable) return true;
	const tag = (el.tagName ?? "").toUpperCase();
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	const role = el.getAttribute?.("role");
	if (role === "textbox" || role === "slider" || role === "combobox" || role === "listbox") return true;
	const activates = tag === "BUTTON" || tag === "A" || role === "button" || role === "menuitem" || role === "option" || role === "tab";
	return activates && (key === " " || key === "Spacebar");
}
