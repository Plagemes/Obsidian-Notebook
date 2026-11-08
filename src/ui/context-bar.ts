// ui redesign: the contextual bar, a floating pill at the bottom of the page with the actions of the current context
// (selection, lasso, PDF side pane, class now, PDF page, image page). The layout engine chooses the context and the
// actions; this only draws them. It can be collapsed to one round button per context (remembered on this device).
import { setIcon } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { actionById, isChecked, isEnabled, type ContextKind, type UiContext } from "./actions";
import { actionLabel } from "./action-sheet";
import { attachLongPressHelp } from "./long-press-help";
import { CTX_LIFT_VAR, contextLift, publish, watchBox } from "./dock-metrics";
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

/** 0.14: the label of a bar adapted to its content ("Ink selection", "Slide"); the plain label of the context otherwise. */
const VARIANT_LABELS: Readonly<Record<string, MessageKey>> = {
	"selection:ink": "ui.context.selection.ink",
	"selection:image": "ui.context.selection.image",
	"selection:text": "ui.context.selection.text",
	"selection:mixed": "ui.context.selection.mixed",
	"pdf:slide": "ui.context.pdf.slide",
};

export function contextLabelKey(kind: ContextKind, variant?: string): MessageKey {
	return (variant ? VARIANT_LABELS[`${kind}:${variant}`] : undefined) ?? (`ui.context.${kind}` as MessageKey);
}

export class ContextBar {
	readonly el: HTMLElement;
	private readonly mainEl: HTMLElement;
	/** Extra rows of the selection context (restyle colours and widths), filled by SelectionActions. */
	readonly extraEl: HTMLElement;
	/** wave 0.10: the second row of the selection context (select similar, align, transform); above the main row, under the restyle rows. */
	private readonly secondEl: HTMLElement;
	private plan: ContextBarPlan | null = null;
	private readonly stopWatch: () => void;

	constructor(parent: HTMLElement, private readonly host: ContextBarHost) {
		this.el = parent.createDiv({ cls: "notebook-context-bar notebook-hidden", attr: { role: "toolbar" } });
		this.mainEl = this.el.createDiv({ cls: "notebook-context-main" });
		this.extraEl = this.el.createDiv({ cls: "notebook-context-extra" });
		this.secondEl = this.extraEl.createDiv({ cls: "notebook-context-second notebook-hidden", attr: { role: "toolbar" } });
		// The pieces that share the bottom of the page area stand above this bar (dock-metrics.ts).
		this.stopWatch = watchBox(this.el, () => publish(parent, CTX_LIFT_VAR, contextLift(this.el.offsetHeight)));
		this.stopHelp = attachLongPressHelp(this.el); // 0.24 iconhelp (#429)
	}

	private readonly stopHelp: () => void;

	/** The context shown now (null: hidden). */
	get kind(): ContextKind | null {
		return this.plan?.kind ?? null;
	}

	destroy(): void {
		this.stopWatch();
		this.stopHelp();
		publish(this.el.parentElement, CTX_LIFT_VAR, 0);
		this.el.remove();
	}

	render(plan: ContextBarPlan | null, c: UiContext): void {
		this.plan = plan;
		this.el.toggleClass("notebook-hidden", !plan);
		this.mainEl.empty();
		this.secondEl.empty();
		this.secondEl.addClass("notebook-hidden");
		if (!plan) return;
		const kind = plan.kind;
		const name = t(contextLabelKey(kind, plan.variant));
		const collapsed = this.host.collapsed(kind);
		this.el.dataset.context = kind;
		if (plan.variant) this.el.dataset.variant = plan.variant;
		else delete this.el.dataset.variant;
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
		for (const id of plan.actions) this.actionButton(this.mainEl, id, c);
		if (plan.second && plan.second.length > 0) {
			this.secondEl.removeClass("notebook-hidden");
			this.secondEl.setAttribute("aria-label", name);
			for (const id of plan.second) this.actionButton(this.secondEl, id, c);
		}
		const hide = this.button(this.mainEl, "chevron-down", t("ui.context.collapse"), () => this.host.setCollapsed(kind, true));
		hide.addClass("notebook-context-collapse");
	}

	private actionButton(parent: HTMLElement, id: string, c: UiContext): void {
		const a = actionById(id);
		if (!a) return;
		const b = this.button(parent, a.icon, actionLabel(a), () => this.host.run(id));
		b.dataset.action = id;
		b.disabled = !isEnabled(a, c);
		b.toggleClass("is-danger", !!a.danger);
		if (a.checked) {
			const on = isChecked(a, c);
			b.toggleClass("is-active", on);
			b.setAttribute("aria-pressed", String(on));
		}
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
