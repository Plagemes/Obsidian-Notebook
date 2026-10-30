// ui redesign: the contextual bar, a floating pill at the bottom of the page with the actions of the current context
// (selection, lasso, PDF side pane, class now, PDF page, image page). The layout engine chooses the context and the
// actions; this only draws them. It can be collapsed to one round button per context (remembered on this device).
import { setIcon } from "obsidian";
import { t } from "../i18n";
import { actionById, isChecked, isEnabled, type ContextKind, type UiContext } from "./actions";
import { actionLabel } from "./action-sheet";
import type { ContextBarPlan } from "./layout";

export interface ContextBarHost {
	run(id: string): void;
	collapsed(kind: ContextKind): boolean;
	setCollapsed(kind: ContextKind, collapsed: boolean): void;
}

const ICONS: Record<ContextKind, string> = {
	selection: "lasso-select",
	lasso: "lasso",
	"side-pane": "columns-2",
	lecture: "graduation-cap",
	pdf: "file-text",
	image: "image",
};

export class ContextBar {
	readonly el: HTMLElement;
	private readonly mainEl: HTMLElement;
	/** Extra rows of the selection context (restyle colours and widths), filled by SelectionActions. */
	readonly extraEl: HTMLElement;
	private plan: ContextBarPlan | null = null;

	constructor(parent: HTMLElement, private readonly host: ContextBarHost) {
		this.el = parent.createDiv({ cls: "notebook-context-bar notebook-hidden", attr: { role: "toolbar" } });
		this.mainEl = this.el.createDiv({ cls: "notebook-context-main" });
		this.extraEl = this.el.createDiv({ cls: "notebook-context-extra" });
	}

	/** The context shown now (null: hidden). */
	get kind(): ContextKind | null {
		return this.plan?.kind ?? null;
	}

	destroy(): void {
		this.el.remove();
	}

	render(plan: ContextBarPlan | null, c: UiContext): void {
		this.plan = plan;
		this.el.toggleClass("notebook-hidden", !plan);
		this.mainEl.empty();
		if (!plan) return;
		const kind = plan.kind;
		const name = t(`ui.context.${kind}`);
		const collapsed = this.host.collapsed(kind);
		this.el.dataset.context = kind;
		this.el.setAttribute("aria-label", name);
		this.el.toggleClass("is-collapsed", collapsed);
		this.extraEl.toggleClass("notebook-hidden", kind !== "selection" || collapsed);
		if (collapsed) {
			const open = this.button(this.mainEl, ICONS[kind], t("ui.context.expand", { name }), () => this.host.setCollapsed(kind, false));
			open.addClass("notebook-context-chip");
			return;
		}
		const label = this.mainEl.createDiv({ cls: "notebook-context-label" });
		setIcon(label.createSpan({ cls: "notebook-context-label-icon" }), ICONS[kind]);
		label.createSpan({ cls: "notebook-context-label-text", text: name });
		for (const id of plan.actions) {
			const a = actionById(id);
			if (!a) continue;
			const b = this.button(this.mainEl, a.icon, actionLabel(a), () => this.host.run(id));
			b.dataset.action = id;
			b.disabled = !isEnabled(a, c);
			b.toggleClass("is-danger", !!a.danger);
			if (a.checked) {
				const on = isChecked(a, c);
				b.toggleClass("is-active", on);
				b.setAttribute("aria-pressed", String(on));
			}
		}
		const hide = this.button(this.mainEl, "chevron-down", t("ui.context.collapse"), () => this.host.setCollapsed(kind, true));
		hide.addClass("notebook-context-collapse");
	}

	private button(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "notebook-tool clickable-icon", attr: { type: "button", "aria-label": label } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}
}
