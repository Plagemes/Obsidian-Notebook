// v13 (#241): erasing part of a stroke gives the surviving pieces new ids (the segment eraser and the area eraser cut a
// stroke into new strokes), so a piece would leave the part its stroke was in. These helpers keep the pieces in the part:
// the view adds the returned `SetPageStates` to the same `Batch` as the cuts, so one gesture is one undo step and undo and
// redo put the table back with the strokes. Pure, no 'obsidian'; the stroke engine and the erasers are not involved.
import { Batch, ReplaceStroke, type Command } from "./history";
import { replaceItem, SetPageStates } from "./states";
import type { NotebookDocument, PageStates } from "./types";

/** The `ReplaceStroke` commands inside `commands` (a `Batch` is searched, in order). */
function replacements(commands: readonly Command[]): ReplaceStroke[] {
	const out: ReplaceStroke[] = [];
	for (const c of commands) {
		if (c instanceof ReplaceStroke) out.push(c);
		else if (c instanceof Batch) out.push(...replacements(c.commands));
	}
	return out;
}

/**
 * The commands that put the pieces of the cut strokes into the parts of the strokes they came from: one `SetPageStates`
 * per page whose table changes, built from the table the page has now. It does not depend on whether the cuts are applied
 * yet (the segment eraser applies them while the pen moves, the area eraser's batch runs later): the table is not touched
 * by them. The caller adds the result to the same `Batch` as the cuts, after them, and applies it if the cuts already ran. A stroke cut more than
 * once in a gesture is followed through its pieces, and a stroke that was erased whole stays in its part untouched (the writer drops it, and undo of the erase brings it back into the part).
 */
export function statesAfterCuts(doc: NotebookDocument, commands: readonly Command[]): SetPageStates[] {
	const byPage = new Map<string, ReplaceStroke[]>();
	for (const r of replacements(commands)) {
		const list = byPage.get(r.pageId);
		if (list) list.push(r);
		else byPage.set(r.pageId, [r]);
	}
	const out: SetPageStates[] = [];
	for (const [pageId, cuts] of byPage) {
		const page = doc.pages.find((p) => p.id === pageId);
		const before = page?.states;
		if (!page || !before) continue;
		let table: PageStates | undefined = before;
		for (const cut of cuts) {
			if (cut.after.length > 0) table = replaceItem(table, cut.before.id, cut.after.map((s) => s.id));
		}
		if (table && table !== before) out.push(new SetPageStates(pageId, before, table, "Keep parts"));
	}
	return out;
}
