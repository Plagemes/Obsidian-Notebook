/**
 * v8 undoable commands on markers that find their target by id when they are applied, so they still work after
 * another command of the same step replaced the element object (a margin change moves every element). Pure.
 */
import type { Command } from "./history";
import { withDone } from "./markers";
import type { MarkerElement, NotebookDocument } from "./types";

/** Resolves (or reopens) the marker `markerId` of page `pageId`. A missing marker, or one already in that state, is a no-op both ways. */
export class SetMarkerDone implements Command {
	readonly label: string;
	private replaced: { before: MarkerElement; after: MarkerElement } | null = null;

	constructor(readonly pageId: string, readonly markerId: string, readonly done: boolean) {
		this.label = done ? "Resolve marker" : "Reopen marker";
	}

	apply(doc: NotebookDocument): void {
		this.replaced = null;
		const els = doc.pages.find((p) => p.id === this.pageId)?.elements;
		if (!els) return;
		const i = els.findIndex((e) => e.id === this.markerId && e.type === "marker");
		const before = els[i] as MarkerElement | undefined;
		if (!before || !!before.done === this.done) return;
		const after = withDone(before, this.done);
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
		if (i >= 0) els[i] = r.before;
	}
}
