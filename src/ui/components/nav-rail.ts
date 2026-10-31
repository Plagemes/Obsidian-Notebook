import { setIconSafe, subjectVars } from "./dom";

export interface RailItemOptions {
	key: string;
	icon: string;
	label: string;
	active?: boolean;
	count?: number;
	/** 0.13: pages inside (a folder row), already worded ("248 p"): drawn after the count, so the row says both "12 notebooks" and "248 pages". */
	pages?: string;
	/** The row's count and pages in words, for the tooltip and the accessible name. */
	detail?: string;
	/** Image URL drawn instead of the icon (the coloured folder icon). */
	image?: string;
	/** Subject colour of a folder row. */
	color?: string;
	onClick: () => void;
}

/** Brand of the navigation rail: icon, title and subtitle. */
export function railBrand(parent: HTMLElement, title: string, subtitle: string): HTMLElement {
	const b = parent.createDiv({ cls: "nb-rail-brand" });
	setIconSafe(b.createSpan({ cls: "nb-rail-brand-icon", attr: { "aria-hidden": "true" } }), "book-open");
	const text = b.createDiv({ cls: "nb-rail-brand-text" });
	text.createDiv({ cls: "nb-rail-brand-title", text: title });
	text.createDiv({ cls: "nb-rail-brand-sub", text: subtitle });
	return b;
}

/** An item of the rail (DESIGN.md §3): icon, label, optional count; the active one is an accent-tinted pill. */
export function railItem(parent: HTMLElement, o: RailItemOptions): HTMLButtonElement {
	const label = o.detail ? `${o.label} (${o.detail})` : o.count !== undefined ? `${o.label} (${o.count})` : o.label;
	const b = parent.createEl("button", { cls: "nb-rail-item", attr: { type: "button", "data-key": o.key, title: o.detail ? label : o.label, "aria-label": label } });
	b.toggleClass("is-active", !!o.active);
	if (o.active) b.setAttribute("aria-current", "page");
	if (o.color) subjectVars(b, o.color);
	const icon = b.createSpan({ cls: "nb-rail-icon", attr: { "aria-hidden": "true" } });
	if (o.image) icon.createEl("img", { attr: { src: o.image, alt: "", draggable: "false" } });
	else setIconSafe(icon, o.icon);
	b.createSpan({ cls: "nb-rail-label", text: o.label });
	if (o.count !== undefined) b.createSpan({ cls: "nb-rail-count", text: String(o.count) });
	if (o.pages !== undefined) b.createSpan({ cls: "nb-rail-pages", text: o.pages });
	b.addEventListener("click", o.onClick);
	return b;
}

/** A section label of the rail ("VAULT"). */
export function railLabel(parent: HTMLElement, text: string): HTMLElement {
	return parent.createDiv({ cls: "nb-rail-section", text });
}
