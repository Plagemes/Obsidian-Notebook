import { setIconSafe } from "./dom";

export interface NewButtonOptions {
	/** The visible label ("New"); a compact button shows only the plus and uses `tip` as its name. */
	label: string;
	/** What the button does, as a tooltip (and the accessible name of the compact button). */
	tip: string;
	/** A round "+" for tight places (the navigation rail). */
	compact?: boolean;
	key?: string;
	cls?: string;
	/** Opens the New menu next to the button. */
	onOpen: (anchor: HTMLElement) => void;
}

/**
 * The primary "+ New" control (DESIGN.md §3, §5: creation is always reachable): an accent pill with a plus and its
 * label, or a compact round "+". A plain button, so pen, finger, mouse and keyboard all reach it.
 */
export function newButton(parent: HTMLElement, o: NewButtonOptions): HTMLButtonElement {
	const cls = ["nb-new-btn", o.compact ? "is-compact" : "", o.cls ?? ""].filter(Boolean).join(" ");
	const b = parent.createEl("button", { cls, attr: { type: "button", title: o.tip, "aria-haspopup": "menu" } });
	if (o.compact) b.setAttribute("aria-label", o.tip);
	if (o.key) b.dataset.key = o.key;
	setIconSafe(b.createSpan({ cls: "nb-new-icon", attr: { "aria-hidden": "true" } }), "plus");
	if (!o.compact) b.createSpan({ cls: "nb-new-label", text: o.label });
	b.addEventListener("click", (e) => {
		e.stopPropagation();
		o.onOpen(b);
	});
	return b;
}
