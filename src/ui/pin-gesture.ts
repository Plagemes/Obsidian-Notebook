// 0.14 generative UI (393): press and hold (or right click) on a quick-capable action to pin it to the toolbar or unpin it.
// Shared by the quick slots of the toolbar and the rows of the "All actions" sheet.
import { Menu } from "obsidian";
import { t } from "../i18n";

/** How long an element is held before the pin menu opens, ms. */
export const PIN_PRESS_MS = 550;

export interface PinTarget {
	/** Whether the action is pinned now (read when the menu opens). */
	pinned(): boolean;
	toggle(): void;
}

export interface PinGesture {
	/** True just after the menu opened from a long press: the click that ends the press must be ignored. */
	justOpened(): boolean;
}

/** Opens the pin menu under `anchor`. */
export function openPinMenu(anchor: HTMLElement, target: PinTarget): void {
	const menu = new Menu();
	const pinned = target.pinned();
	menu.addItem((i) => i.setTitle(t(pinned ? "ui.pin.unpin" : "ui.pin.pin")).setIcon(pinned ? "pin-off" : "pin").onClick(() => target.toggle()));
	const r = anchor.getBoundingClientRect();
	menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
}

/** Wires the long press (touch and pen) and the context menu event (mouse, and touch where the platform sends it) on `el`. */
export function attachPinGesture(el: HTMLElement, target: PinTarget): PinGesture {
	let timer = 0;
	let last = 0;
	const cancel = (): void => {
		if (timer) window.clearTimeout(timer);
		timer = 0;
	};
	const open = (): void => {
		last = performance.now();
		openPinMenu(el, target);
	};
	el.addEventListener("pointerdown", (e) => {
		if (e.pointerType === "mouse") return;
		cancel();
		timer = window.setTimeout(() => {
			timer = 0;
			open();
		}, PIN_PRESS_MS);
	});
	for (const type of ["pointerup", "pointerleave", "pointercancel"] as const) el.addEventListener(type, cancel);
	el.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		if (performance.now() - last < 900) return; // the long press already opened it
		open();
	});
	return { justOpened: () => performance.now() - last < 700 };
}
