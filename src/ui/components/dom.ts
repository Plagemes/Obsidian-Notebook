// Shared helpers of the design-system components (DESIGN.md §3).
import { setIcon } from "obsidian";

/** `#rrggbb` with an alpha, as `rgba()`; anything else is returned as it is. */
export function tint(hex: string, alpha: number): string {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return hex;
	return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
}

/** Gives an element its subject colour: `--nb-c` (base), `--nb-c-tint` (16 %), `--nb-c-soft` (8 %) and `--nb-c-glow` (35 %). */
export function subjectVars(el: HTMLElement, color: string): void {
	el.setCssProps({ "--nb-c": color, "--nb-c-tint": tint(color, 0.16), "--nb-c-soft": tint(color, 0.08), "--nb-c-glow": tint(color, 0.35) });
}

/** An SVG document as an image URL (shown with <img>, never parsed into the page). */
export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Makes a non-button element a keyboard and pointer target: role, tab stop, click, Enter and Space. */
export function pressable(el: HTMLElement, activate: () => void, label?: string): void {
	el.setAttribute("role", "button");
	el.tabIndex = 0;
	if (label) el.setAttribute("aria-label", label);
	el.addEventListener("click", (e) => {
		// A nested button (kebab, star) handles its own click.
		if (e.target instanceof Element && e.target.closest("button") && e.target.closest("button") !== el) return;
		activate();
	});
	el.addEventListener("keydown", (e) => {
		if (e.target !== el) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			activate();
		}
	});
}

/** A round icon button (header tools, kebab menus). */
export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (button: HTMLButtonElement, e: MouseEvent) => void, cls = ""): HTMLButtonElement {
	const b = parent.createEl("button", { cls: `nb-icon-btn ${cls}`.trim(), attr: { type: "button", "aria-label": label, title: label } });
	setIconSafe(b, icon);
	b.addEventListener("click", (e) => {
		e.stopPropagation();
		onClick(b, e);
	});
	return b;
}

export function setIconSafe(el: HTMLElement, icon: string): void {
	setIcon(el, icon);
}
