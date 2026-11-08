import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { balanceLatex, balanceText, hasLatexReaction, hasReaction, type ChemError } from "../math/chem-balance";
import { isLockedElement } from "../model/groups";
import { Batch, ReplaceElement, type Command } from "../model/history";
import { isLocked } from "../model/page-lock";
import type { EquationElement, NotebookDocument, PageElement, TextElement } from "../model/types";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { showNotice } from "./notice";

/**
 * View side of "Balance reaction" (0.23, roadmap #294). The selected text boxes and equations that hold a typed chemical reaction are
 * balanced (math/chem-balance.ts, pure); a preview shows each line before and after, or why it cannot be balanced, and "Balance"
 * replaces the text in ONE undo step through the history (which refuses a locked page; locked elements are never touched). It adds
 * nothing to the document format: a text box keeps its text field, an equation its LaTeX (written as mhchem, `\ce{...}`).
 */
export interface ChemHost {
	app: App;
	doc(): NotebookDocument | null;
	editable(): boolean;
	/** Selected elements and their page. */
	selection(): { pageIndex: number; elements: readonly PageElement[] } | null;
	/** Runs a command as one undo step (false when it was refused: a locked page, a read-only notebook). */
	execute(cmd: Command): boolean;
	select(pageIndex: number, elements: PageElement[]): void;
	refresh(): void;
}

/** True when an element holds a reaction (the contextual bar offers the action only then). */
export function holdsReaction(el: PageElement): boolean {
	if (el.type === "text") return hasReaction(el.text);
	if (el.type === "equation") return hasLatexReaction(el.latex);
	return false;
}

/** The sentence for an error (translated). */
export function chemErrorText(e: ChemError): string {
	const first = e.detail[0] ?? "";
	switch (e.code) {
		case "ambiguous":
			return t("chem.err.ambiguous", { count: String(e.detail.length) });
		case "bad-formula":
		case "bad-charge":
		case "unknown-element":
		case "one-sided":
		case "unused-species":
		case "unbalanceable":
		case "many-arrows":
		case "empty":
		case "no-arrow":
		case "empty-side":
		case "too-large":
			return t(`chem.err.${e.code}`, { detail: e.code === "unbalanceable" || e.code === "one-sided" || e.code === "unused-species" ? e.detail.join(", ") : first });
	}
}

/** One element's balance, ready to show and to apply. */
export interface ChemItem {
	element: TextElement | EquationElement;
	lines: Array<{ before: string; after: string | null; changed: boolean; error?: ChemError }>;
	/** The element with the balanced text; null when nothing in it changes. */
	next: TextElement | EquationElement | null;
}

/** Works out the balance of an element (pure; nothing is changed). */
export function planElement(el: TextElement | EquationElement): ChemItem {
	if (el.type === "text") {
		const r = balanceText(el.text);
		return { element: el, lines: r.lines, next: r.changed > 0 ? { ...el, text: r.text } : null };
	}
	const r = balanceLatex(el.latex);
	const next: EquationElement | null = r.balance.changed > 0 ? { ...el, latex: r.latex } : null;
	if (next) delete next.outline;
	return { element: el, lines: r.balance.lines, next };
}

export class ChemTools {
	constructor(private readonly host: ChemHost) {}

	/** "Balance reaction": previews the selected reactions and applies them on request. */
	balanceSelected(): void {
		const sel = this.host.selection();
		const doc = this.host.doc();
		const page = sel ? doc?.pages[sel.pageIndex] : undefined;
		if (!sel || !page || !this.host.editable()) return;
		const holders = sel.elements.filter((e): e is TextElement | EquationElement => (e.type === "text" || e.type === "equation") && holdsReaction(e));
		if (holders.length === 0) {
			showNotice(t("chem.nothing"));
			return;
		}
		const free = holders.filter((e) => !isLockedElement(e));
		if (free.length === 0) {
			showNotice(t("chem.locked"));
			return;
		}
		if (isLocked(page)) {
			showNotice(t("lock.needsUnlock", { n: String(sel.pageIndex + 1) }));
			return;
		}
		const items = free.map(planElement);
		new ChemPreviewModal(this.host.app, items, holders.length - free.length, () => this.apply(sel.pageIndex, page.id, items)).open();
	}

	private apply(pageIndex: number, pageId: string, items: readonly ChemItem[]): void {
		const doc = this.host.doc();
		const page = doc?.pages[pageIndex];
		if (!page || page.id !== pageId || !this.host.editable()) return;
		if (isLocked(page)) {
			showNotice(t("lock.needsUnlock", { n: String(pageIndex + 1) }));
			return;
		}
		// The elements must still be there as they were previewed (an edit or an undo may have run while the dialog was open).
		const steps: Command[] = [];
		const after: PageElement[] = [];
		for (const item of items) {
			if (!item.next || isLockedElement(item.element) || !page.elements?.includes(item.element)) continue;
			steps.push(new ReplaceElement(page.id, item.element, item.next));
			after.push(item.next);
		}
		if (steps.length === 0) return;
		if (!this.host.execute(steps.length === 1 ? steps[0]! : new Batch("Balance reaction", steps))) {
			showNotice(t("lock.needsUnlock", { n: String(pageIndex + 1) }));
			return;
		}
		const placed = (this.host.doc()?.pages[pageIndex]?.elements ?? []).filter((e) => after.some((a) => a.id === e.id));
		if (placed.length > 0) this.host.select(pageIndex, placed);
		this.host.refresh();
		showNotice(t("chem.done"));
	}
}

/** The preview: each line of each reaction before and after, or the reason it cannot be balanced. */
export class ChemPreviewModal extends Modal {
	private applied = false;

	constructor(app: App, private readonly items: readonly ChemItem[], private readonly lockedCount: number, private readonly onApply: () => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("chem.title"), subtitle: t("chem.subtitle"), icon: "flask-conical", size: "narrow", cls: "nb-chem-modal" });
		const list = shell.body.createDiv({ cls: "nb-chem-list", attr: { role: "list" } });
		let changes = 0;
		for (const item of this.items) {
			for (const line of item.lines) {
				const row = list.createDiv({ cls: "nb-chem-row", attr: { role: "listitem" } });
				row.toggleClass("is-error", !!line.error);
				row.createDiv({ cls: "nb-chem-before", text: line.before.trim() });
				if (line.error) row.createDiv({ cls: "nb-chem-problem", text: chemErrorText(line.error), attr: { role: "alert" } });
				else if (line.after !== null) {
					row.createDiv({ cls: "nb-chem-after", text: line.changed ? line.after.trim() : t("chem.same") });
					if (line.changed) changes++;
				}
			}
		}
		if (this.lockedCount > 0) shellNote(shell.body, t("chem.lockedSkipped", { n: String(this.lockedCount) }));
		shellButton(shell.foot, "secondary", t("chem.cancel"), () => this.close());
		shellButton(
			shell.foot, "primary", t("chem.apply"),
			() => {
				this.applied = true;
				this.close();
			},
			{ icon: "check", disabled: changes === 0 },
		);
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.applied) this.onApply();
	}
}
