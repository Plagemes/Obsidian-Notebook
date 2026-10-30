import { iconButton, pressable, setIconSafe, subjectVars } from "./dom";

export interface Pill {
	label: string;
	/** Subject colour: a tinted pill with coloured text. Without it, a neutral pill. */
	color?: string;
}

export interface ListRowOptions {
	icon: string;
	title: string;
	meta: string;
	pills: readonly Pill[];
	key?: string;
	menuLabel: string;
	onOpen: () => void;
	onMenu: (anchor: HTMLElement) => void;
}

/** Subject pill (tinted, coloured text) or neutral pill. */
export function pills(parent: HTMLElement, list: readonly Pill[]): HTMLElement {
	const box = parent.createDiv({ cls: "nb-pills" });
	for (const p of list) {
		const el = box.createSpan({ cls: "nb-pill", text: p.label, attr: { title: p.label } });
		if (p.color) {
			el.addClass("is-subject");
			subjectVars(el, p.color);
		}
	}
	return box;
}

/** A row of a list panel (DESIGN.md §3): doc icon, title, meta, pills, kebab. */
export function listRow(parent: HTMLElement, o: ListRowOptions): HTMLElement {
	const row = parent.createDiv({ cls: "nb-list-row" });
	if (o.key) row.dataset.key = o.key;
	pressable(row, o.onOpen, `${o.title}, ${o.meta}`);
	setIconSafe(row.createSpan({ cls: "nb-row-icon", attr: { "aria-hidden": "true" } }), o.icon);
	const text = row.createDiv({ cls: "nb-row-text" });
	text.createDiv({ cls: "nb-row-title", text: o.title, attr: { title: o.title } });
	text.createDiv({ cls: "nb-row-meta", text: o.meta });
	pills(row, o.pills);
	iconButton(row, "more-vertical", o.menuLabel, (b) => o.onMenu(b), "nb-kebab");
	return row;
}
