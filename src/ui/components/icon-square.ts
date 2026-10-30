import { setIconSafe, subjectVars } from "./dom";

/** A 40–44 px rounded square with the colour tint and the icon in the base colour (DESIGN.md §2.6). */
export function iconSquare(parent: HTMLElement, icon: string, color?: string, cls = ""): HTMLElement {
	const sq = parent.createDiv({ cls: `nb-icon-square ${cls}`.trim(), attr: { "aria-hidden": "true" } });
	if (color) subjectVars(sq, color);
	setIconSafe(sq, icon);
	return sq;
}
