/**
 * Locking a finished page (roadmap #124, format v14). Pure, no Obsidian.
 *
 * `Page.locked` makes a page refuse every edit until it is unlocked. There is ONE guard: `History` takes a `LockSnapshot` of
 * the locked pages before it runs, undoes or redoes a command and compares afterwards; a command that changed the content
 * of a page that was locked (ink, elements, text, paste, states, comments, paper, size, margins, background, deletion, a restored
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
export function exemptFromLocks(cmd: Command): Command & { readonly inner: Command } {
	// `inner` stays a plain field on purpose: the library check and the storage dialog walk the objects of the history (not
	// closures) for the assets an undone command still names, so an exempt merge on the redo stack must still show them.
	return { label: cmd.label, lockExempt: true, inner: cmd, apply: (doc) => cmd.apply(doc), revert: (doc) => cmd.revert(doc), remap: (swap) => cmd.remap?.(swap) };
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
	/** Copies: the stroke and element arrays of a page are edited in place, their items never are. */
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
	states: Page["states"];
	/** v16: the comments list is replaced as a whole by every command that changes it, so identity tells. */
	comments: Page["comments"];
	width: number;
	height: number;
	paperKind: string;
	paperSpacing: number;
	infinite: boolean;
	/** Replaced as a whole by every command that changes them: compared by reference, and by value only when that differs. */
	background: Page["background"];
	margins: Page["margins"];
	backgroundJson: string | undefined;
	marginsJson: string | undefined;
}

/** What the guard remembers of the locked pages before a command. */
export type LockSnapshot = ReadonlyMap<string, PageSnap>;

/**
 * The locked pages of `doc` as they are now, or null when none is locked (the usual case costs nothing). The item arrays are
 * copied (they are spliced in place), the items themselves are immutable so a reference is enough; the small shape fields are
 * kept as plain values (the background and margins also once as text, the only stringify, and only when present).
 */
export function snapshotLocked(doc: NotebookDocument): LockSnapshot | null {
	let out: Map<string, PageSnap> | null = null;
	for (const page of doc.pages) {
		if (page.locked !== true) continue;
		out ??= new Map();
		out.set(page.id, {
			strokes: page.strokes.slice(), elements: page.elements?.slice() ?? [], states: page.states, comments: page.comments,
			width: page.width, height: page.height, paperKind: page.paper.kind, paperSpacing: page.paper.spacing, infinite: page.infinite ?? false,
			background: page.background, margins: page.margins,
			backgroundJson: page.background ? JSON.stringify(page.background) : undefined,
			marginsJson: page.margins ? JSON.stringify(page.margins) : undefined,
		});
	}
	return out;
}

function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Same object, or (replaced by an equal one) the same text. */
function sameValue(now: object | undefined, ref: object | undefined, before: string | undefined): boolean {
	if (now === ref) return true;
	if (!now || before === undefined) return false;
	return JSON.stringify(now) === before;
}

function unchanged(page: Page, snap: PageSnap): boolean {
	return (
		page.states === snap.states && page.comments === snap.comments && page.width === snap.width && page.height === snap.height && page.paper.kind === snap.paperKind &&
		page.paper.spacing === snap.paperSpacing && (page.infinite ?? false) === snap.infinite &&
		sameValue(page.background, snap.background, snap.backgroundJson) && sameValue(page.margins, snap.margins, snap.marginsJson) &&
		sameItems(page.strokes, snap.strokes) && sameItems(page.elements ?? [], snap.elements)
	);
}

/**
 * Ids of the pages in `before` whose content is not what it was (changed, or gone). Empty when the command left them alone.
 * One pass over the pages of `doc`. A page that is gone counts as changed (a command that deletes a finished page is an
 * edit), except with `removalAllowed`: undoing a command removes the pages that command had added (restoring a page from the
 * trash keeps its lock, and undoing that restore must work), so there a missing page is judged by the command, not the lock.
 */
export function lockedChanges(doc: NotebookDocument, before: LockSnapshot, removalAllowed = false): string[] {
	const hit: string[] = [];
	let seen = 0;
	for (const page of doc.pages) {
		const snap = before.get(page.id);
		if (!snap) continue;
		seen++;
		if (!unchanged(page, snap)) hit.push(page.id);
	}
	if (seen < before.size && !removalAllowed) {
		const present = new Set<string>();
		for (const page of doc.pages) present.add(page.id);
		for (const id of before.keys()) if (!present.has(id)) hit.push(id);
	}
	return hit;
}
