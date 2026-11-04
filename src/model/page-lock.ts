/**
 * Locking a finished page (roadmap #124, format v14). Pure, no Obsidian.
 *
 * `Page.locked` makes a page refuse every edit until it is unlocked. There is ONE guard: `History` takes a `LockSnapshot` of
 * the locked pages before it runs, undoes or redoes a command and compares afterwards; a command that changed the content
 * of a page that was locked (ink, elements, text, paste, states, paper, size, margins, background, deletion, a restored
 * version...) is reverted at once and reported. Nothing has to be listed per command, so a command added later is covered
 * without anyone remembering to. The flag itself is not content: `SetPageLocked` goes through (that is how a page is
 * unlocked), and so do the tags, the bookmarks and the order of the pages (organisation, not content).
 *
 * Flows that are not commands on the open document (moving pages to another notebook, the page trash, a merge of a conflicted
 * copy) use `lockedPages` / `exemptFromLocks` below.
 */
import type { Command } from "./history";
import type { NotebookDocument, Page, PageElement, Stroke } from "./types";

/** Locks or unlocks a page: one undo step. Unlocked is stored as the absence of the flag. A missing page is a no-op both ways. */
export class SetPageLocked implements Command {
	readonly label: string;
	private previous: true | undefined;
	private applied = false;

	constructor(readonly pageId: string, readonly value: boolean) {
		this.label = value ? "Lock page" : "Unlock page";
	}

	apply(doc: NotebookDocument): void {
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (!page) return;
		this.previous = page.locked;
		this.applied = true;
		if (this.value) page.locked = true;
		else delete page.locked;
	}

	revert(doc: NotebookDocument): void {
		if (!this.applied) return;
		this.applied = false;
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (!page) return;
		if (this.previous === undefined) delete page.locked;
		else page.locked = this.previous;
	}
}

/**
 * A command that the guard lets through on locked pages. Only for a deliberate, confirmed operation whose point is to bring
 * content in (merging a conflicted copy: the ink of the other copy must not be lost because a page was locked).
 */
export function exemptFromLocks(cmd: Command): Command {
	return { label: cmd.label, lockExempt: true, apply: (doc) => cmd.apply(doc), revert: (doc) => cmd.revert(doc) };
}

export function isLocked(page: Page | null | undefined): boolean {
	return page?.locked === true;
}

/** Ids of the locked pages of `doc`. */
export function lockedPageIds(doc: NotebookDocument): string[] {
	return doc.pages.filter((p) => p.locked === true).map((p) => p.id);
}

/** The locked ones among `pageIds` (ids that are not pages of `doc` are ignored). */
export function lockedPages(doc: NotebookDocument, pageIds: Iterable<string>): string[] {
	const wanted = new Set(pageIds);
	return doc.pages.filter((p) => p.locked === true && wanted.has(p.id)).map((p) => p.id);
}

interface PageSnap {
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
	/** Everything of the page that is neither ink nor an element nor the lock, tags or position in the document. */
	shape: string;
	states: Page["states"];
}

/** What the guard remembers of the locked pages before a command. */
export type LockSnapshot = ReadonlyMap<string, PageSnap>;

function shapeOf(page: Page): string {
	return JSON.stringify([page.width, page.height, page.paper.kind, page.paper.spacing, page.background ?? null, page.margins ?? null, page.infinite ?? false]);
}

/**
 * The locked pages of `doc` as they are now, or null when none is locked (the usual case costs nothing). Strokes and
 * elements are immutable objects, so keeping the arrays' contents by reference is enough to see any change.
 */
export function snapshotLocked(doc: NotebookDocument): LockSnapshot | null {
	let out: Map<string, PageSnap> | null = null;
	for (const page of doc.pages) {
		if (page.locked !== true) continue;
		out ??= new Map();
		out.set(page.id, { strokes: [...page.strokes], elements: [...(page.elements ?? [])], shape: shapeOf(page), states: page.states });
	}
	return out;
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Ids of the pages in `before` whose content is not what it was (changed, or gone). Empty when the command left them alone. */
export function lockedChanges(doc: NotebookDocument, before: LockSnapshot): string[] {
	const hit: string[] = [];
	for (const [id, snap] of before) {
		const page = doc.pages.find((p) => p.id === id);
		if (!page || page.states !== snap.states || shapeOf(page) !== snap.shape || !sameItems(page.strokes, snap.strokes) || !sameItems(page.elements ?? [], snap.elements)) hit.push(id);
	}
	return hit;
}
