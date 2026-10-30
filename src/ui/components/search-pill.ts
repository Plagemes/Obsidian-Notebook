import { setIconSafe } from "./dom";

export interface SearchPillOptions {
	placeholder: string;
	label: string;
	/** Keyboard hint chip ("Ctrl K"); null on touch devices. */
	hint: string | null;
	onInput: (value: string) => void;
}

/** The search pill (DESIGN.md §3): fully rounded, magnifier, placeholder, keyboard hint. Escape clears it. */
export function searchPill(parent: HTMLElement, o: SearchPillOptions): { el: HTMLElement; input: HTMLInputElement } {
	const el = parent.createDiv({ cls: "nb-search" });
	setIconSafe(el.createSpan({ cls: "nb-search-icon", attr: { "aria-hidden": "true" } }), "search");
	const input = el.createEl("input", { cls: "nb-search-input", attr: { type: "search", placeholder: o.placeholder, "aria-label": o.label, enterkeyhint: "search", spellcheck: "false" } });
	if (o.hint) el.createSpan({ cls: "nb-search-hint", text: o.hint, attr: { "aria-hidden": "true" } });
	input.addEventListener("input", () => o.onInput(input.value));
	input.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && input.value) {
			e.preventDefault();
			e.stopPropagation();
			input.value = "";
			o.onInput("");
		}
	});
	el.addEventListener("click", (e) => {
		if (e.target === el) input.focus();
	});
	return { el, input };
}
