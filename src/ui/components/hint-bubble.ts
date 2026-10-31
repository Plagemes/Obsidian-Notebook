import { setIconSafe } from "./dom";

export interface HintBubbleOptions {
	icon: string;
	title: string;
	body: string;
	/** Labels of the two controls. */
	dismissLabel: string;
	turnOffLabel: string;
	onDismiss: () => void;
	onTurnOff: () => void;
}

/**
 * A just-in-time tip (DESIGN.md §3, floating card): icon, title, one sentence, an × and a "Turn off tips" link. The caller
 * places it (`.nb-hint-host`) and removes it; both controls only call back.
 */
export function hintBubble(parent: HTMLElement, o: HintBubbleOptions): HTMLElement {
	const card = parent.createDiv({ cls: "nb-hint", attr: { role: "status", "aria-live": "polite" } });
	setIconSafe(card.createDiv({ cls: "nb-hint-icon", attr: { "aria-hidden": "true" } }), o.icon);
	const text = card.createDiv({ cls: "nb-hint-text" });
	text.createDiv({ cls: "nb-hint-title", text: o.title });
	text.createDiv({ cls: "nb-hint-body", text: o.body });
	text.createEl("button", { cls: "nb-hint-off", text: o.turnOffLabel, attr: { type: "button" } }).addEventListener("click", o.onTurnOff);
	const close = card.createEl("button", { cls: "nb-hint-close", attr: { type: "button", "aria-label": o.dismissLabel, title: o.dismissLabel } });
	setIconSafe(close, "x");
	close.addEventListener("click", o.onDismiss);
	return card;
}
