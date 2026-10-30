import { setIconSafe } from "./dom";

export interface SectionHeaderOptions {
	icon: string;
	title: string;
	/** "Show all →": hidden when everything is already shown (omit it then). */
	link?: { label: string; onClick: () => void };
}

/** Icon + section title on the left, an accent link on the right (DESIGN.md §3). Returns the header; extra controls go in `.nb-section-tools`. */
export function sectionHeader(parent: HTMLElement, o: SectionHeaderOptions): HTMLElement {
	const head = parent.createDiv({ cls: "nb-section-header" });
	setIconSafe(head.createSpan({ cls: "nb-section-icon", attr: { "aria-hidden": "true" } }), o.icon);
	head.createEl("h2", { cls: "nb-section-title", text: o.title });
	const tools = head.createDiv({ cls: "nb-section-tools" });
	if (o.link) {
		const { label, onClick } = o.link;
		const a = tools.createEl("button", { cls: "nb-link", attr: { type: "button" } });
		a.createSpan({ text: label });
		setIconSafe(a.createSpan({ cls: "nb-link-arrow", attr: { "aria-hidden": "true" } }), "arrow-right");
		a.addEventListener("click", onClick);
	}
	return head;
}
