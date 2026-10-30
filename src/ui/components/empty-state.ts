import { setIconSafe } from "./dom";

export interface EmptyStateAction {
	icon: string;
	label: string;
	key?: string;
	onClick: () => void;
}

export interface EmptyStateOptions {
	/** Decoration: a generated illustration (data URL from the art engine); omitted with reduced effects. */
	art?: string;
	/** Shown in an icon square when there is no illustration. */
	icon: string;
	title: string;
	/** One line that says what to do next. */
	body?: string;
	/** The next step (accent button); only for things that can be created here. */
	primary?: EmptyStateAction;
	secondary?: EmptyStateAction[];
}

/**
 * Empty state (DESIGN.md §3, §5): a centred illustration, a title, one line of explanation and the next step as
 * buttons. It teaches what the surface is for instead of hiding it.
 */
export function emptyState(parent: HTMLElement, o: EmptyStateOptions): HTMLElement {
	const box = parent.createDiv({ cls: "nb-empty-state" });
	if (o.art) box.createDiv({ cls: "nb-empty-art", attr: { "aria-hidden": "true" } }).setCssProps({ "--nb-art": `url("${o.art}")` });
	else setIconSafe(box.createDiv({ cls: "nb-empty-icon", attr: { "aria-hidden": "true" } }), o.icon);
	box.createEl("h2", { cls: "nb-empty-title", text: o.title });
	if (o.body) box.createEl("p", { cls: "nb-empty-body", text: o.body });
	const actions = [...(o.primary ? [{ ...o.primary, primary: true }] : []), ...(o.secondary ?? []).map((a) => ({ ...a, primary: false }))];
	if (actions.length > 0) {
		const row = box.createDiv({ cls: "nb-empty-actions" });
		for (const a of actions) {
			const b = row.createEl("button", { cls: `nb-pill-btn${a.primary ? " mod-cta" : ""}`, attr: { type: "button" } });
			if (a.key) b.dataset.key = a.key;
			setIconSafe(b.createSpan({ attr: { "aria-hidden": "true" } }), a.icon);
			b.createSpan({ text: a.label });
			b.addEventListener("click", () => a.onClick());
		}
	}
	return box;
}
