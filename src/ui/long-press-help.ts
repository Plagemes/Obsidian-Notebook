// 0.24 iconhelp (#429): long-press explanation bubble. A finger resting on an icon button of the toolbar, the selection and
// contextual bars or Home shows a small bubble (name, one line on what it does, a gesture hint) next to it, without pressing
// the button. One delegated listener per surface root, so buttons that are rebuilt need nothing. Mouse keeps the hover tooltip
// and the pen is never touched (S Pen button rules, writing). The timing and placement are pure (long-press-logic.ts).
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { ACTION_HELP } from "./help-text";
import { isMacroActionId } from "./macros";
import { cleanHelp, ClickGuard, HELP_LINGER_MS, LongPressTracker, placeBubble, startsHelp, type HelpContent } from "./long-press-logic";

let enabledFlag = true;

/** Setting "Explain icons on long press" (Appearance). Set from main.ts when the settings load or change. */
export function setLongPressHelpEnabled(on: boolean): void {
	enabledFlag = on;
	if (!on) hideActiveBubble();
}

let activeHide: (() => void) | null = null;
function hideActiveBubble(): void {
	activeHide?.();
	activeHide = null;
}

/** What the control under the finger says, or null when it has no bubble (own long-press, no label). */
export function resolveHelp(button: HTMLElement): HelpContent | null {
	if (button.dataset.noHelp !== undefined) return null;
	const name = button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "";
	const action = button.dataset.action;
	// 0.27 macros (#170): every macro button (a name the person chose) shares one explanation.
	const key = button.dataset.help ?? (action ? (isMacroActionId(action) ? "help.macro" : ACTION_HELP[action]) : undefined);
	const hintKey = button.dataset.helpHint;
	return cleanHelp({
		name,
		description: key ? t(key as MessageKey) : undefined,
		hint: hintKey ? t(hintKey as MessageKey) : undefined,
	});
}

/** The element a press started on that may carry a bubble: the nearest button of `root`. */
function targetButton(e: Event, root: HTMLElement): HTMLElement | null {
	const el = e.target instanceof Element ? e.target.closest<HTMLElement>("button, [role='button']") : null;
	return el && root.contains(el) ? el : null;
}

/** Builds the bubble in `host` (an element, never the Document) and returns it. */
function buildBubble(host: HTMLElement, c: HelpContent): HTMLElement {
	const b = host.createDiv({ cls: "nb-ui nb-help-bubble", attr: { role: "tooltip" } });
	b.createDiv({ cls: "nb-help-name", text: c.name });
	if (c.description) b.createDiv({ cls: "nb-help-desc", text: c.description });
	if (c.hint) b.createDiv({ cls: "nb-help-hint", text: c.hint });
	b.createDiv({ cls: "nb-help-arrow", attr: { "aria-hidden": "true" } });
	return b;
}

/**
 * Wires the long-press explanation on `root` (a toolbar, a bar, a Home header). Idempotent per root is the caller's job.
 * The disposer removes the listeners and any bubble showing.
 */
export function attachLongPressHelp(root: HTMLElement, resolve: (button: HTMLElement) => HelpContent | null = resolveHelp): () => void {
	const tracker = new LongPressTracker();
	let timer = 0;
	let target: HTMLElement | null = null;
	let pointerId = -1;
	let bubble: HTMLElement | null = null;
	const guard = new ClickGuard<HTMLElement>();
	let lingerTimer = 0;

	const clearTimer = (): void => {
		if (timer) window.clearTimeout(timer);
		timer = 0;
	};
	let doc: Document | null = null;
	// A tap anywhere else dismisses it (the press that opened it began before this listener existed).
	const onOutside = (): void => {
		guard.newPress(); // a second finger or the palm while the first still holds does not disarm it
		hide();
	};
	function hide(): void {
		if (lingerTimer) window.clearTimeout(lingerTimer);
		lingerTimer = 0;
		bubble?.remove();
		bubble = null;
		if (activeHide === hide) activeHide = null;
		doc?.removeEventListener("pointerdown", onOutside, true);
	}

	const show = (): void => {
		timer = 0;
		const btn = target;
		if (!btn || !enabledFlag || !btn.isConnected) return;
		const content = resolve(btn);
		if (!content) return;
		hideActiveBubble();
		doc = btn.ownerDocument;
		const host = doc.body;
		bubble = buildBubble(host, content);
		const r = btn.getBoundingClientRect();
		const w = bubble.offsetWidth;
		const h = bubble.offsetHeight;
		const win = doc.defaultView ?? window;
		const p = placeBubble(r, w, h, { width: win.innerWidth, height: win.innerHeight });
		bubble.setCssProps({ left: `${p.left}px`, top: `${p.top}px`, "--nb-help-arrow-x": `${p.arrowX}px` });
		bubble.toggleClass("is-above", p.above);
		guard.arm(btn);
		activeHide = hide;
		doc.addEventListener("pointerdown", onOutside, true);
	};

	const onDown = (e: PointerEvent): void => {
		guard.newPress(); // a new press after the lift is a new gesture: its tap is never swallowed
		if (!enabledFlag || !startsHelp(e.pointerType, e.isPrimary)) return;
		const btn = targetButton(e, root);
		if (!btn || !resolve(btn)) return;
		hide();
		clearTimer();
		target = btn;
		pointerId = e.pointerId;
		tracker.begin(e.clientX, e.clientY, performance.now());
		timer = window.setTimeout(show, tracker.remaining(performance.now()));
	};
	const onMove = (e: PointerEvent): void => {
		if (e.pointerId !== pointerId) return;
		if (tracker.move(e.clientX, e.clientY)) {
			clearTimer();
			hide();
		}
	};
	const onUp = (e: PointerEvent): void => {
		if (e.pointerId !== pointerId) return;
		clearTimer();
		tracker.end();
		guard.lift(performance.now());
		if (bubble) {
			// The finger lifted: let the reader finish, then hide.
			lingerTimer = window.setTimeout(hide, HELP_LINGER_MS);
		}
	};
	const onCancel = (e: PointerEvent): void => {
		if (e.pointerId !== pointerId) return;
		clearTimer();
		tracker.end();
		guard.lift(performance.now());
		hide();
	};
	// The click that ends the long press must not press the button.
	const onClick = (e: Event): void => {
		if (guard.consume(targetButton(e, root), performance.now())) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	};
	// Touch long press raises a context menu on some WebViews: keep it from opening on top of the bubble.
	const onContext = (e: Event): void => {
		if (timer !== 0 || bubble) e.preventDefault();
	};

	root.addEventListener("pointerdown", onDown);
	root.addEventListener("pointermove", onMove);
	root.addEventListener("pointerup", onUp);
	root.addEventListener("pointercancel", onCancel);
	root.addEventListener("click", onClick, true);
	root.addEventListener("contextmenu", onContext);
	return () => {
		clearTimer();
		hide();
		root.removeEventListener("pointerdown", onDown);
		root.removeEventListener("pointermove", onMove);
		root.removeEventListener("pointerup", onUp);
		root.removeEventListener("pointercancel", onCancel);
		root.removeEventListener("click", onClick, true);
		root.removeEventListener("contextmenu", onContext);
	};
}
