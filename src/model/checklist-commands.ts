/**
 * v17 undoable commands on checkboxes that find their target by id when they are applied, so they still work after another
 * command of the same step replaced the element object (a margin change moves every element). Pure.
 */
import type { Command, ElementSwap } from "./history";
import { toggledCheckbox, withChecked, withCheckboxLabel, withCheckboxTask } from "./checklist";
import { freezeElement } from "./serialize";
import type { CheckboxElement, CheckboxTask, NotebookDocument } from "./types";

/**
 * Changes the checkbox `checkboxId` of page `pageId` to `change(before)`. A missing checkbox, or a change that leaves it as it was,
 * is a no-op both ways. Undo puts the object it replaced back.
 */
export class UpdateCheckbox implements Command {
	private replaced: { before: CheckboxElement; after: CheckboxElement } | null = null;
	/** 0.19: what the last undo put back exactly: a redo on that same object puts the same `after` back, so the steps above find it. */
	private undone: { before: CheckboxElement; after: CheckboxElement } | null = null;

	constructor(
		readonly pageId: string, readonly checkboxId: string, private readonly change: (before: CheckboxElement) => CheckboxElement, readonly label = "Edit checkbox",
	) {}

	apply(doc: NotebookDocument): void {
		this.replaced = null;
		const again = this.undone;
		this.undone = null;
		const els = doc.pages.find((p) => p.id === this.pageId)?.elements;
		if (!els) return;
		const i = els.findIndex((e) => e.id === this.checkboxId && e.type === "checkbox");
		const before = els[i] as CheckboxElement | undefined;
		if (!before) return;
		if (again && again.before === before) {
			els[i] = again.after;
			this.replaced = again;
			return;
		}
		const after = this.change(before);
		if (JSON.stringify(after) === JSON.stringify(before)) return;
		freezeElement(after);
		els[i] = after;
		this.replaced = { before, after };
	}

	revert(doc: NotebookDocument): void {
		const r = this.replaced;
		if (!r) return;
		this.replaced = null;
		const els = doc.pages.find((p) => p.id === this.pageId)?.elements;
		if (!els) return;
		const i = els.indexOf(r.after);
		if (i >= 0) {
			els[i] = r.before;
			this.undone = r;
			return;
		}
		// The object was replaced since by a change that is no undo step (the link followed a renamed note, or was dropped because its
		// line is gone: `History.applyQuietly`). This step is undone on what is there now, and that change stays unless this step is
		// the link's own change.
		const j = els.findIndex((e) => e.id === this.checkboxId && e.type === "checkbox");
		const current = els[j] as CheckboxElement | undefined;
		if (!current) return;
		const ownsLink = JSON.stringify(r.before.task) !== JSON.stringify(r.after.task);
		els[j] = freezeElement(ownsLink ? r.before : keepingLink(r.before, current));
	}

	remap(swap: ElementSwap): void {
		const pair = (r: { before: CheckboxElement; after: CheckboxElement } | null) => (r ? { before: swap(r.before) as CheckboxElement, after: swap(r.after) as CheckboxElement } : null);
		this.replaced = pair(this.replaced);
		this.undone = pair(this.undone);
	}
}

/** `base` with the task link (and its time) of `from`. */
function keepingLink(base: CheckboxElement, from: CheckboxElement): CheckboxElement {
	const out: CheckboxElement = { ...base };
	delete out.task;
	delete out.taskAt;
	if (from.taskAt !== undefined) out.taskAt = from.taskAt;
	if (from.task) out.task = from.task;
	return out;
}

/** Ticks or unticks a checkbox (one undo step): `checked` set at time `at` (ms). */
export function setCheckboxChecked(pageId: string, id: string, checked: boolean, at: number): UpdateCheckbox {
	return new UpdateCheckbox(pageId, id, (el) => ((el.checked === true) === checked ? el : withChecked(el, checked, at)), checked ? "Tick checkbox" : "Untick checkbox");
}

/** Flips a checkbox (one undo step). */
export function toggleCheckbox(pageId: string, id: string, at: number): UpdateCheckbox {
	return new UpdateCheckbox(pageId, id, (el) => toggledCheckbox(el, at), "Toggle checkbox");
}

/**
 * Links a checkbox to a task line, or unlinks it (`task` null). The change is stamped with `at` (`taskAt`) so that merging an
 * older copy of the notebook, which still has the link, does not bring it back. Linking again to what it already is changes nothing.
 */
export function setCheckboxTask(pageId: string, id: string, task: CheckboxTask | null, at: number = Date.now()): UpdateCheckbox {
	return new UpdateCheckbox(pageId, id, (el) => {
		const plain = withCheckboxTask(el, task);
		return JSON.stringify(plain) === JSON.stringify(el) ? el : withCheckboxTask(el, task, at);
	}, task ? "Link checkbox to task" : "Unlink checkbox from task");
}

/** Changes the typed label of a checkbox. */
export function setCheckboxLabel(pageId: string, id: string, label: string): UpdateCheckbox {
	return new UpdateCheckbox(pageId, id, (el) => withCheckboxLabel(el, label), "Edit checkbox label");
}
