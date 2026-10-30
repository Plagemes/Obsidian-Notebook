import { pressable, setIconSafe, subjectVars } from "./dom";
import { iconSquare } from "./icon-square";

export interface QuickActionOptions {
	icon: string;
	color: string;
	title: string;
	description: string;
	/** Decoration: a faint generated artwork (data URL) on the right, behind the text; omit with reduced effects. */
	art?: string;
	key?: string;
	onRun: () => void;
}

/** Quick action tile (DESIGN.md §3): tinted gradient, icon square, title, two-line description, chevron. */
export function quickAction(parent: HTMLElement, o: QuickActionOptions): HTMLElement {
	const tile = parent.createDiv({ cls: "nb-quick" });
	subjectVars(tile, o.color);
	if (o.key) tile.dataset.key = o.key;
	pressable(tile, o.onRun, o.title);
	if (o.art) tile.createDiv({ cls: "nb-quick-art", attr: { "aria-hidden": "true" } }).setCssProps({ "--nb-art": `url("${o.art}")` });
	iconSquare(tile, o.icon, o.color);
	const text = tile.createDiv({ cls: "nb-quick-text" });
	text.createDiv({ cls: "nb-quick-title", text: o.title });
	text.createDiv({ cls: "nb-quick-desc", text: o.description });
	setIconSafe(tile.createSpan({ cls: "nb-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
	return tile;
}
