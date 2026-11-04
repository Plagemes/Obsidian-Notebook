import { attachedInk } from "../ink/attach";
import { measureText } from "../ink/renderer";
import { AddElement, Batch, ReplaceElement, type Command } from "../model/history";
import { createSticky, editedSticky, isSticky, STICKY_DEFAULT_COLOR, toggledSticky } from "../model/sticky";
import type { NotebookDocument, Page, PageElement, StickyElement } from "../model/types";
import { StickyModal, type StickyDraft } from "./sticky-modal";
import type { App } from "obsidian";

/**
 * View side of sticky notes (0.17, roadmap #20): inserting a note, editing its text and colour, collapsing and opening it.
 * Moving, resizing, deleting, copying and the ink written on a note are the ordinary selection tools (a note is a page
 * element that owns the ink on it, ink/attach.ts). Every change is one undo step through the view's history, which also
 * refuses it on a locked page. The view passes itself as a StickyHost.
 */
export interface StickyHost {
	app: App;
	doc(): NotebookDocument | null;
	/** The document can be edited now. */
	editable(): boolean;
	/** Runs a command as one undo step (false when it was refused: a locked page, a read-only notebook). */
	execute(cmd: Command): boolean;
	/** Page in view and the page point at the centre of the view. */
	insertTarget(): { pageIndex: number; x: number; y: number } | null;
	/** Selected elements and their page. */
	selection(): { pageIndex: number; elements: readonly PageElement[] } | null;
	/** Selects these elements (the lasso tool, so the contextual bar and the handles appear). */
	select(pageIndex: number, elements: PageElement[]): void;
	refresh(): void;
}

/** The colour of the next new note: the one last chosen in this session (a note is usually followed by another of its kind). */
let lastColour = STICKY_DEFAULT_COLOR;

export class StickyTools {
	constructor(private readonly host: StickyHost) {}

	/** "Insert sticky note": an empty note at the centre of the view, selected, ready to be moved, resized or written on. */
	insert(): void {
		if (!this.host.editable()) return;
		const target = this.host.insertTarget();
		const page = target ? this.host.doc()?.pages[target.pageIndex] : undefined;
		if (!target || !page) return;
		const note = createSticky(target.x, target.y, page, lastColour);
		if (!this.host.execute(new AddElement(page.id, note, page.elements?.length ?? 0))) return;
		this.host.select(target.pageIndex, [note]);
		this.host.refresh();
	}

	/** The notes of the selection and their page (null when it holds none, or the page is gone). */
	private selected(): { pageIndex: number; page: Page; notes: StickyElement[] } | null {
		const sel = this.host.selection();
		const page = sel ? this.host.doc()?.pages[sel.pageIndex] : undefined;
		if (!sel || !page) return null;
		const notes = sel.elements.filter(isSticky).filter((e) => page.elements?.includes(e));
		return notes.length > 0 ? { pageIndex: sel.pageIndex, page, notes } : null;
	}

	/** "Edit note": its text, colour and text size. Works on the one note of the selection. */
	editSelected(): void {
		const s = this.selected();
		if (!s || s.notes.length !== 1 || !this.host.editable()) return;
		const note = s.notes[0]!;
		new StickyModal(this.host.app, { text: note.text ?? "", color: note.color, fontSize: note.fontSize }, (d) => this.finish(s.pageIndex, s.page, note, d)).open();
	}

	/** Done in the editor: one undo step, and the new note stays selected. */
	private finish(pageIndex: number, page: Page, note: StickyElement, d: StickyDraft): void {
		lastColour = d.color;
		const after = editedSticky(note, { text: d.text, color: d.color, fontSize: d.fontSize });
		if (JSON.stringify(after) === JSON.stringify(note) || !page.elements?.includes(note)) return;
		if (this.host.execute(new ReplaceElement(page.id, note, after))) this.host.select(pageIndex, [after]);
		this.host.refresh();
	}

	/**
	 * "Collapse note" / "Open note": every selected note that is not yet in that state, as one undo step. Collapsing keeps the
	 * ink that is on the note (it is hidden with it and moves with the icon); opening shows it again.
	 */
	setCollapsed(collapsed: boolean): void {
		const s = this.selected();
		if (!s || !this.host.editable()) return;
		const changing = s.notes.filter((n) => (n.collapsed === true) !== collapsed);
		if (changing.length === 0) return;
		const steps: ReplaceElement[] = [];
		const after: PageElement[] = s.notes.filter((n) => !changing.includes(n));
		for (const note of changing) {
			// The ink written on it, except invisible ink and what another collapsed note already keeps.
			const ink = collapsed
				? attachedInk(s.page.strokes, s.page.elements ?? [], [note], new Set(), measureText).filter((st) => !st.hidden).map((st) => st.id)
				: [];
			const next = toggledSticky(note, ink);
			steps.push(new ReplaceElement(s.page.id, note, next));
			after.push(next);
		}
		const cmd = steps.length === 1 ? steps[0]! : new Batch(collapsed ? "Collapse notes" : "Open notes", steps);
		if (this.host.execute(cmd)) this.host.select(s.pageIndex, after);
		this.host.refresh();
	}
}
