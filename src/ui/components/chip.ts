import { setIconSafe, subjectVars } from "./dom";

export interface ChipOptions {
	label: string;
	icon?: string;
	/** A coloured dot before the label (tag chips). */
	dot?: string;
	count?: number;
	active?: boolean;
	title?: string;
	key?: string;
	onClick: () => void;
}

/** A pill: optional icon or dot, label, optional count bubble (DESIGN.md §3, filter and tag chips). */
export function chip(parent: HTMLElement, o: ChipOptions): HTMLButtonElement {
	const b = parent.createEl("button", { cls: "nb-chip", attr: { type: "button", "aria-pressed": String(!!o.active) } });
	if (o.key) b.dataset.key = o.key;
	if (o.title) b.title = o.title;
	b.toggleClass("is-active", !!o.active);
	if (o.icon) setIconSafe(b.createSpan({ cls: "nb-chip-icon", attr: { "aria-hidden": "true" } }), o.icon);
	if (o.dot) {
		const dot = b.createSpan({ cls: "nb-chip-dot", attr: { "aria-hidden": "true" } });
		subjectVars(dot, o.dot);
	}
	b.createSpan({ cls: "nb-chip-label", text: o.label });
	if (o.count !== undefined) b.createSpan({ cls: "nb-chip-count", text: String(o.count) });
	b.addEventListener("click", o.onClick);
	return b;
}

export interface FilterChip<T extends string> {
	id: T;
	label: string;
	icon?: string;
}

/** A single-select row of filter chips; wraps on a phone. */
export function filterChips<T extends string>(parent: HTMLElement, items: ReadonlyArray<FilterChip<T>>, active: T | null, onSelect: (id: T) => void, label: string): HTMLElement {
	const row = parent.createDiv({ cls: "nb-chips", attr: { role: "toolbar", "aria-label": label } });
	for (const item of items) chip(row, { label: item.label, icon: item.icon, active: item.id === active, key: `chip:${item.id}`, onClick: () => onSelect(item.id) });
	return row;
}
