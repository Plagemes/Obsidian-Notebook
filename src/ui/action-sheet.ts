// ui redesign: the grouped, searchable action sheet. "All actions" (the ⊞ button) and the page sheet (page indicator,
// page panel thumbnails) are this component: a popover under the toolbar on a tablet or desktop, a bottom sheet on a
// phone. Its content is built by the layout engine (buildSheet) from the registry and the current context.
import { Platform, setIcon } from "obsidian";
import { t } from "../i18n";
import { PAGE_SIZES, PAPER_KINDS, type PageSizeName, type PaperKind } from "../model/types";
import { isChecked, isEnabled, type ActionDef, type ActionGroup, type UiContext } from "./actions";
import { listenDismiss } from "./dismiss";
import { buildSheet, type SectionId } from "./layout";
import type { UsageMap } from "./usage";

export type SheetKind = "all" | "page";

export interface SheetHost {
	/** The context of the page in view, or of page `pageIndex` for a page sheet. */
	context(pageIndex?: number): UiContext;
	usage(): UsageMap;
	/** Ids visible in the toolbar and the contextual bar right now. */
	visible(): ReadonlySet<string>;
	run(id: string, arg: { page?: number; value?: string }): void;
	/** The current paper and size of a page, for the choice rows. */
	pageValues(pageIndex: number): { paper: PaperKind; size: PageSizeName | null } | null;
	/** Extra controls placed at the end of a section (the dimming slider in "PDF & reading"). */
	extra?(section: SectionId): HTMLElement | null;
	/** True when the sheet should be a bottom sheet (phone-sized view). */
	narrow(): boolean;
}

export function actionLabel(a: ActionDef): string {
	return a.id.startsWith("favourite-") ? t(a.label, { n: a.id.slice(10) }) : t(a.label);
}

export function groupLabel(g: ActionGroup | SectionId): string {
	return t(`ui.group.${g}`);
}

/** Actions whose sheet stays open after use: the change is seen in the sheet itself. */
const STAYS_OPEN = (a: ActionDef): boolean => !!a.checked || !!a.choices;

export class ActionSheet {
	readonly el: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly searchEl: HTMLInputElement;
	private readonly bodyEl: HTMLElement;
	private kind: SheetKind = "all";
	private pageIndex: number | undefined;
	private anchor: HTMLElement | null = null;
	private stopDismiss: (() => void) | null = null;
	/** Called when the sheet opens or closes (the toolbar marks its buttons). */
	onToggle: ((open: boolean, kind: SheetKind) => void) | null = null;

	constructor(parent: HTMLElement, private readonly host: SheetHost) {
		this.el = parent.createDiv({ cls: "notebook-sheet notebook-hidden", attr: { role: "dialog", "aria-modal": "false" } });
		const head = this.el.createDiv({ cls: "notebook-sheet-head" });
		this.el.createDiv({ cls: "notebook-sheet-grabber", attr: { "aria-hidden": "true" } });
		this.titleEl = head.createDiv({ cls: "notebook-sheet-title", attr: { id: `notebook-sheet-${Math.random().toString(36).slice(2, 8)}` } });
		this.el.setAttribute("aria-labelledby", this.titleEl.id);
		const close = head.createEl("button", { cls: "notebook-tool clickable-icon notebook-sheet-close", attr: { type: "button", "aria-label": t("ui.sheet.close") } });
		setIcon(close, "x");
		close.addEventListener("click", (e) => {
			e.preventDefault();
			this.close();
		});
		const search = this.el.createDiv({ cls: "notebook-sheet-search" });
		setIcon(search.createSpan({ cls: "notebook-sheet-search-icon" }), "search");
		this.searchEl = search.createEl("input", { attr: { type: "search", placeholder: t("ui.sheet.search"), "aria-label": t("ui.sheet.search"), enterkeyhint: "search" } });
		this.searchEl.addEventListener("input", () => this.render());
		this.searchEl.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			const first = this.bodyEl.querySelector<HTMLButtonElement>("button.notebook-menu-item:not(:disabled)");
			first?.click();
		});
		this.bodyEl = this.el.createDiv({ cls: "notebook-sheet-body" });
	}

	get isOpen(): boolean {
		return !this.el.hasClass("notebook-hidden");
	}

	get openKind(): SheetKind | null {
		return this.isOpen ? this.kind : null;
	}

	/** Opens the sheet (or closes it when the same sheet is open). `pageIndex`: the page of a page sheet. */
	toggle(kind: SheetKind, anchor: HTMLElement | null, pageIndex?: number): void {
		if (this.isOpen && this.kind === kind && this.pageIndex === pageIndex) {
			this.close();
			return;
		}
		this.open(kind, anchor, pageIndex);
	}

	open(kind: SheetKind, anchor: HTMLElement | null, pageIndex?: number): void {
		this.stopDismiss?.();
		this.kind = kind;
		this.pageIndex = pageIndex;
		this.anchor = anchor;
		this.searchEl.value = "";
		this.el.toggleClass("is-page", kind === "page");
		this.el.removeClass("notebook-hidden");
		this.place();
		this.render();
		this.stopDismiss = listenDismiss({
			inside: () => [this.el, this.anchor],
			close: () => this.close(),
			page: ".notebook-stage",
		});
		this.onToggle?.(true, kind);
		// A keyboard is there on desktop only: focusing the field on a tablet would pop up the on-screen keyboard.
		if (Platform.isDesktop && kind === "all") this.searchEl.focus();
	}

	close(): void {
		this.stopDismiss?.();
		this.stopDismiss = null;
		if (!this.isOpen) return;
		// Extra controls belong to their owner: take them out before the body is emptied.
		for (const child of Array.from(this.bodyEl.querySelectorAll(".notebook-sheet-extra > *"))) child.remove();
		this.el.addClass("notebook-hidden");
		this.onToggle?.(false, this.kind);
	}

	/** Re-renders an open sheet (the context changed: selection, page, toggles). */
	refresh(): void {
		if (this.isOpen) this.render();
	}

	destroy(): void {
		this.close();
		this.el.remove();
	}

	private place(): void {
		const bottom = this.host.narrow();
		this.el.toggleClass("is-bottom", bottom);
		const parent = this.el.parentElement;
		if (!parent || bottom) {
			this.el.setCssProps({ "--notebook-sheet-top": "auto", "--notebook-sheet-max": "70%" });
			return;
		}
		const host = parent.getBoundingClientRect();
		const a = this.anchor?.getBoundingClientRect();
		const top = a ? a.bottom - host.top + 6 : 8;
		this.el.setCssProps({ "--notebook-sheet-top": `${Math.round(top)}px`, "--notebook-sheet-max": `${Math.max(160, Math.floor(host.height - top - 12))}px` });
	}

	private render(): void {
		const c = this.host.context(this.pageIndex);
		const page = c.page;
		this.titleEl.setText(this.kind === "page" && page ? t("ui.pageSheet.title", { n: String(page.index + 1) }) : t("ui.sheet.title"));
		const query = this.searchEl.value;
		const sections = buildSheet(c, {
			kind: this.kind, usage: this.host.usage(), now: Date.now(), query, label: actionLabel, groupLabel,
			visible: this.host.visible(),
		});
		for (const child of Array.from(this.bodyEl.querySelectorAll(".notebook-sheet-extra > *"))) child.remove();
		this.bodyEl.empty();
		if (sections.length === 0) {
			this.bodyEl.createDiv({ cls: "notebook-sheet-empty", text: t("ui.sheet.none", { query: query.trim() }) });
			return;
		}
		for (const section of sections) {
			const el = this.bodyEl.createDiv({ cls: "notebook-sheet-section", attr: { role: "group" } });
			const title = el.createDiv({ cls: "notebook-sheet-section-title", text: groupLabel(section.id) });
			title.id = `${this.titleEl.id}-${section.id}`;
			el.setAttribute("aria-labelledby", title.id);
			const list = el.createDiv({ cls: "notebook-sheet-list" });
			for (const a of section.actions) {
				if (a.choices && page) this.choiceRow(list, a, c, page.index);
				else this.item(list, a, c);
			}
			const extra = query ? null : this.host.extra?.(section.id);
			if (extra) el.createDiv({ cls: "notebook-sheet-extra" }).appendChild(extra);
		}
	}

	private item(parent: HTMLElement, a: ActionDef, c: UiContext): void {
		const checked = isChecked(a, c);
		const b = parent.createEl("button", { cls: "notebook-menu-item", attr: { type: "button", "data-action": a.id } });
		b.toggleClass("is-danger", !!a.danger);
		setIcon(b.createSpan({ cls: "notebook-menu-icon" }), a.icon);
		b.createSpan({ cls: "notebook-menu-label", text: actionLabel(a) });
		if (a.checked) {
			b.setAttribute("aria-pressed", String(checked));
			b.toggleClass("is-checked", checked);
			b.createSpan({ cls: "notebook-switch", attr: { "aria-hidden": "true" } });
		}
		b.disabled = !isEnabled(a, c);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			const pageIndex = this.pageIndex ?? c.page?.index;
			if (!STAYS_OPEN(a)) this.close();
			this.host.run(a.id, { page: pageIndex });
			if (this.isOpen) this.render();
		});
	}

	private choiceRow(parent: HTMLElement, a: ActionDef, c: UiContext, pageIndex: number): void {
		const current = this.host.pageValues(pageIndex);
		const row = parent.createDiv({ cls: "notebook-sheet-choices", attr: { role: "radiogroup", "aria-label": actionLabel(a) } });
		const head = row.createDiv({ cls: "notebook-sheet-choices-label" });
		setIcon(head.createSpan({ cls: "notebook-menu-icon" }), a.icon);
		head.createSpan({ text: actionLabel(a) });
		const chips = row.createDiv({ cls: "notebook-chips" });
		const values: readonly string[] = a.choices === "paper" ? PAPER_KINDS : Object.keys(PAGE_SIZES);
		for (const value of values) {
			const on = a.choices === "paper" ? current?.paper === value : current?.size === value;
			const chip = chips.createEl("button", {
				cls: "notebook-chip-choice",
				text: t(a.choices === "paper" ? `paper.${value as PaperKind}` : `size.${value as PageSizeName}`),
				attr: { type: "button", role: "radio", "aria-checked": String(on) },
			});
			chip.toggleClass("is-active", on);
			chip.disabled = !isEnabled(a, c);
			chip.addEventListener("click", (e) => {
				e.preventDefault();
				this.host.run(a.id, { page: pageIndex, value });
				this.render();
			});
		}
	}
}
