// Margin comments (0.18, roadmap #86, format v16). Pure data, geometry and commands: no 'obsidian', no DOM. A comment is a
// region of a page (page coordinates) with typed text and, optionally, a small handwritten sketch kept inside the comment; a
// flat thread of replies hangs off it. It belongs to the page, not to the ink, so it is not part of a selection and does not
// travel with a copied region (see docs/architecture.md, *Margin comments, format v16*). Every change is a `SetPageComments`
// command: one undo step, refused on a locked page by the history's one guard.
import type { BBox } from "../ink/hit-test";
import type { Matrix } from "../ink/transform";
import { mapRect } from "./pdf-view";
import { cleanCommentAuthor, cleanCommentText, clampRegion, normalizeSketch, readComments } from "./comments-format";
import { createId } from "./document";
import type { Command } from "./history";
import type { CommentRegion, CommentReply, CommentSketch, NotebookDocument, Page, PageComment, PageCommentNote } from "./types";
import { COMMENTS_MAX, COMMENT_ID_MAX, COMMENT_MIN_SIDE, COMMENT_TEXT_MAX } from "./types";

export { cleanCommentAuthor, cleanCommentText };

/** The comments with every region moved `dx` pt to the right (the margins of the page's background changed); a new frozen list. */
export function shiftComments(list: readonly PageComment[], dx: number): PageComment[] {
	if (dx === 0) return list as PageComment[];
	const round = (v: number) => Math.round(v * 10) / 10;
	return freezeList(list.map((c) => (isNote(c) ? freezeComment({ ...c, region: { ...c.region, x: round(c.region.x + dx) } }) : c)));
}

/**
 * 0.28 (#76): the comments after the page was turned or cropped: every region is the rectangle `m` (a quarter turn and a translation) carries it
 * to, kept inside the page that is now `size` (a comment is never dropped: one that falls outside is moved to the nearest edge and may shrink).
 * The sketches live in the comment's own frame and do not turn. A new frozen list.
 */
export function transformComments(list: readonly PageComment[], m: Matrix, size: { width: number; height: number }): PageComment[] {
	return freezeList(list.map((c) => (isNote(c) ? freezeComment({ ...c, region: clampRegion(mapRect(m, c.region), size) }) : c)));
}

/** The padding added around a selection when it becomes the region of a comment (pt). */
export const COMMENT_PAD = 6;

export function isReply(c: PageComment): c is CommentReply {
	return "parent" in c;
}

export function isNote(c: PageComment): c is PageCommentNote {
	return !("parent" in c);
}

/** The comments of the page (not the replies), in list order. */
export function notesOf(page: Page): PageCommentNote[] {
	return (page.comments ?? []).filter(isNote);
}

/** The replies to a comment, oldest first. */
export function repliesOf(page: Page, id: string): CommentReply[] {
	return (page.comments ?? []).filter((c): c is CommentReply => isReply(c) && c.parent === id).sort((a, b) => a.created - b.created);
}

export function findComment(page: Page, id: string): PageComment | undefined {
	return (page.comments ?? []).find((c) => c.id === id);
}

/** When the comment was last touched: its last edit, else when it was written. */
export function touched(c: PageComment): number {
	return c.edited ?? c.created;
}

/** The time a thread was last active: the comment's and its replies'. */
export function threadTouched(page: Page, note: PageCommentNote): number {
	return repliesOf(page, note.id).reduce((t, r) => Math.max(t, touched(r)), touched(note));
}

export interface ThreadRef {
	pageIndex: number;
	page: Page;
	note: PageCommentNote;
	replies: CommentReply[];
	/** 1-based number of the comment on its page (the number its margin marker shows): by place, top to bottom. */
	number: number;
}

export type CommentFilter = "open" | "resolved" | "all";

/** Comments of a page ordered as their markers are numbered: top to bottom, then left to right, then oldest first. */
export function orderedNotes(page: Page): PageCommentNote[] {
	return notesOf(page).sort((a, b) => a.region.y - b.region.y || a.region.x - b.region.x || a.created - b.created || (a.id < b.id ? -1 : 1));
}

/** Every thread of the notebook, in page order then marker number, with the filter applied. */
export function threadsOf(doc: NotebookDocument, filter: CommentFilter = "all"): ThreadRef[] {
	const out: ThreadRef[] = [];
	doc.pages.forEach((page, pageIndex) => {
		if (!page.comments) return;
		orderedNotes(page).forEach((note, k) => {
			if (filter === "open" && note.resolved) return;
			if (filter === "resolved" && !note.resolved) return;
			out.push({ pageIndex, page, note, replies: repliesOf(page, note.id), number: k + 1 });
		});
	});
	return out;
}

/** Counts of the notebook's comments (threads, not replies). */
export function commentCounts(doc: NotebookDocument): { open: number; resolved: number; total: number } {
	let open = 0;
	let resolved = 0;
	for (const page of doc.pages) {
		for (const c of page.comments ?? []) {
			if (!isNote(c)) continue;
			if (c.resolved) resolved++;
			else open++;
		}
	}
	return { open, resolved, total: open + resolved };
}

/** Open comments of one page. */
export function openCountOf(page: Page): number {
	return notesOf(page).filter((n) => !n.resolved).length;
}

function freezeComment<T extends PageComment>(c: T): T {
	if ("sketch" in c && c.sketch) {
		for (const s of c.sketch.strokes) Object.freeze(s);
		Object.freeze(c.sketch.strokes);
		Object.freeze(c.sketch);
	}
	if ("region" in c) Object.freeze(c.region);
	return Object.freeze(c);
}

function freezeList(list: readonly PageComment[]): PageComment[] {
	return Object.freeze(list.map((c) => (Object.isFrozen(c) ? c : freezeComment(c)))) as PageComment[];
}

/** Region of a comment made from `bounds` (a selection or a drawn rectangle): padded, kept inside the page, at least the minimum side. */
export function regionFromBounds(bounds: BBox, page: { width: number; height: number }, pad = COMMENT_PAD): CommentRegion {
	return clampRegion({ x: bounds.minX - pad, y: bounds.minY - pad, width: bounds.maxX - bounds.minX + pad * 2, height: bounds.maxY - bounds.minY + pad * 2 }, page);
}

/** Whether a rectangle drawn on the page is big enough to be a region (a tap is not). */
export function isDrawnRegion(a: readonly [number, number], b: readonly [number, number]): boolean {
	return Math.abs(a[0] - b[0]) >= COMMENT_MIN_SIDE && Math.abs(a[1] - b[1]) >= COMMENT_MIN_SIDE;
}

/** The region a drag from `a` to `b` covers (page coordinates), kept inside the page. */
export function regionFromDrag(a: readonly [number, number], b: readonly [number, number], page: { width: number; height: number }): CommentRegion {
	return clampRegion({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) }, page);
}

/** A new id not used by the page's comments. */
export function newCommentId(page: Page): string {
	const used = new Set((page.comments ?? []).map((c) => c.id));
	let id = createId();
	while (used.has(id)) id = createId();
	return id;
}

export interface NewComment {
	region: CommentRegion;
	text: string;
	sketch?: CommentSketch;
	author: string;
	now: number;
}

/** A new comment, cleaned: null when it holds nothing (no text, no sketch). */
export function createComment(page: Page, c: NewComment): PageCommentNote | null {
	const text = cleanCommentText(c.text);
	const sketch = normalizeSketch(c.sketch);
	if (text === "" && !sketch) return null;
	return freezeComment({
		id: newCommentId(page), region: clampRegion(c.region, page), text, ...(sketch ? { sketch } : {}),
		author: cleanCommentAuthor(c.author), created: Math.max(0, Math.round(c.now)),
	});
}

/** A new reply to the comment `parent`, cleaned: null when it holds no text. */
export function createReply(page: Page, parent: string, text: string, author: string, now: number): CommentReply | null {
	const clean = cleanCommentText(text);
	if (clean === "" || !(page.comments ?? []).some((c) => c.id === parent && isNote(c))) return null;
	return freezeComment({ id: newCommentId(page), parent, text: clean, author: cleanCommentAuthor(author), created: Math.max(0, Math.round(now)) });
}

/** The comment with its text and sketch replaced (`sketch` undefined removes it) and its edit time set; null when nothing is left in it or nothing changed. */
export function editedComment(c: PageCommentNote, change: { text: string; sketch?: CommentSketch | undefined }, now: number): PageCommentNote | null {
	const text = cleanCommentText(change.text);
	const sketch = normalizeSketch(change.sketch);
	if (text === "" && !sketch) return null;
	if (text === c.text && JSON.stringify(sketch) === JSON.stringify(c.sketch)) return null;
	const { sketch: _s, ...rest } = c;
	void _s;
	return freezeComment({ ...rest, text, ...(sketch ? { sketch } : {}), edited: Math.max(touched(c) + 1, Math.round(now)) });
}

export function editedReply(r: CommentReply, text: string, now: number): CommentReply | null {
	const clean = cleanCommentText(text);
	if (clean === "" || clean === r.text) return null;
	return freezeComment({ ...r, text: clean, edited: Math.max(touched(r) + 1, Math.round(now)) });
}

/** The comment resolved or reopened; null when it already is in that state. Counts as an edit (the latest edit wins on a merge). */
export function resolvedComment(c: PageCommentNote, resolved: boolean, now: number): PageCommentNote | null {
	if ((c.resolved === true) === resolved) return null;
	const { resolved: _r, ...rest } = c;
	void _r;
	return freezeComment({ ...rest, ...(resolved ? { resolved: true as const } : {}), edited: Math.max(touched(c) + 1, Math.round(now)) });
}

/**
 * Replaces the comments of a page (one user action = one command). Undo puts the previous list back. A missing page is a
 * no-op. Lists are frozen once they are in a command (like elements, a committed list is never edited: a new action builds a
 * new one), so the page-lock guard can tell an edit by identity.
 */
export class SetPageComments implements Command {
	private readonly after: readonly PageComment[] | undefined;

	constructor(readonly pageId: string, readonly before: readonly PageComment[] | undefined, after: readonly PageComment[] | undefined, readonly label = "Change comments") {
		this.after = after && after.length > 0 ? freezeList(after) : undefined;
	}

	private set(doc: NotebookDocument, list: readonly PageComment[] | undefined): void {
		const page = doc.pages.find((p) => p.id === this.pageId);
		if (!page) return;
		if (list && list.length > 0) page.comments = list as PageComment[];
		else delete page.comments;
	}

	apply(doc: NotebookDocument): void {
		this.set(doc, this.after);
	}

	revert(doc: NotebookDocument): void {
		this.set(doc, this.before);
	}
}

const current = (page: Page): readonly PageComment[] => page.comments ?? [];

/** The command that adds a comment (null when the page is full). */
export function addCommentCommand(page: Page, note: PageCommentNote): Command | null {
	if (current(page).length >= COMMENTS_MAX) return null;
	return new SetPageComments(page.id, page.comments, [...current(page), note], "Add comment");
}

/** What adding a new comment to a page comes to: the comment and its command, or why there is none (nothing typed or drawn; the page is full). */
export type AddCommentPlan = { ok: true; note: PageCommentNote; command: Command } | { ok: false; reason: "empty" | "full" };

export function planAddComment(page: Page, c: NewComment): AddCommentPlan {
	const note = createComment(page, c);
	// Nothing typed and nothing drawn is no comment, not a full page: there is nothing to say.
	if (!note) return { ok: false, reason: "empty" };
	const command = addCommentCommand(page, note);
	return command ? { ok: true, note, command } : { ok: false, reason: "full" };
}

export function addReplyCommand(page: Page, reply: CommentReply): Command | null {
	if (current(page).length >= COMMENTS_MAX) return null;
	return new SetPageComments(page.id, page.comments, [...current(page), reply], "Reply to comment");
}

/** Replaces one item of the page's list by `next` (same id); null when it is not there. */
export function replaceCommentCommand(page: Page, id: string, next: PageComment, label: string): Command | null {
	const list = current(page);
	if (!list.some((c) => c.id === id)) return null;
	return new SetPageComments(page.id, page.comments, list.map((c) => (c.id === id ? next : c)), label);
}

/** Deletes a comment together with its replies, or one reply. Null when it is not there. */
export function deleteCommentCommand(page: Page, id: string): Command | null {
	const list = current(page);
	const target = list.find((c) => c.id === id);
	if (!target) return null;
	const gone = isNote(target) ? new Set([id, ...list.filter((c) => isReply(c) && c.parent === id).map((c) => c.id)]) : new Set([id]);
	return new SetPageComments(page.id, page.comments, list.filter((c) => !gone.has(c.id)), isNote(target) ? "Delete comment" : "Delete reply");
}

/**
 * The comments of two copies of one page, joined (merge of a conflicted copy, restoring a page version). Items are matched by
 * id: an item only one side has is kept; an item both have comes from the side that touched it last (`edited`, else `created`;
 * the main side on a tie). So two devices adding comments or replies both keep theirs, and for one comment edited on both the
 * later edit wins and, when both edited the text (or sketch), the losing version is kept beside it as a marked item (`conflictOf`, with a
 * stable id so merging again adds nothing; `options.conflicts: false` drops it, as a deliberate restore does). Nothing is deleted here: a
 * comment one device deleted comes back from a copy that still has it.
 * `added` counts the items the main side did not have. Pure: the result is a new list, or `main` itself when nothing changes.
 */
export function mergeComments(
	main: readonly PageComment[] | undefined,
	other: readonly PageComment[] | undefined,
	options: { conflicts?: boolean } = {},
): { list: readonly PageComment[] | undefined; added: number; replaced: number; conflicts: number } {
	if (!other || other.length === 0) return { list: main, added: 0, replaced: 0, conflicts: 0 };
	const keepConflicts = options.conflicts !== false;
	const mine = main ?? [];
	const at = new Map(mine.map((c, i) => [c.id, i]));
	const out = [...mine];
	let added = 0;
	let replaced = 0;
	let conflicts = 0;
	for (const c of other) {
		const i = at.get(c.id);
		if (i === undefined) {
			if (out.length >= COMMENTS_MAX) continue;
			at.set(c.id, out.length);
			out.push(c);
			added++;
			continue;
		}
		const m = out[i]!;
		if (JSON.stringify(c) === JSON.stringify(m)) continue;
		const copyWins = touched(c) > touched(m);
		if (copyWins) {
			out[i] = c;
			replaced++;
		}
		// Both edited the text (or sketch) differently: the later edit stays the comment, the other is kept beside it, marked.
		if (keepConflicts && isEditConflict(m, c)) {
			const lost = conflictOf(copyWins ? m : c);
			if (!at.has(lost.id) && out.length < COMMENTS_MAX) {
				at.set(lost.id, out.length);
				out.push(lost);
				conflicts++;
			}
		}
	}
	return added + replaced + conflicts === 0 ? { list: main, added, replaced, conflicts } : { list: out, added, replaced, conflicts };
}

/** The mark that opens the text of a comment (or reply) kept from an edit that lost a merge: no word, so it reads in any language. */
export const CONFLICT_MARK = "⚠ ";

const CONFLICT_ID_SEP = "~";

/** Whether two versions of one comment (same id) differ in what was written: text, or the sketch of a comment. */
function contentDiffers(a: PageComment, b: PageComment): boolean {
	if (a.text !== b.text) return true;
	return isNote(a) && isNote(b) && JSON.stringify(a.sketch ?? null) !== JSON.stringify(b.sketch ?? null);
}

/**
 * Two versions of one comment (same id) that differ in what was written, and that were both edited (or both never edited): a real
 * conflict. When only one side has an edit, the other is the text it started from (a stale copy), and the edited one is just newer.
 */
export function isEditConflict(a: PageComment, b: PageComment): boolean {
	return (a.edited !== undefined) === (b.edited !== undefined) && contentDiffers(a, b);
}

/** A short stable fingerprint of a string (two FNV-1a runs with different offsets, base 36): fixed length, the same on every device. */
function fingerprint(s: string): string {
	let a = 0x811c9dc5;
	let b = 0x2f0b4a27;
	for (let i = 0; i < s.length; i++) {
		const ch = s.charCodeAt(i);
		a = Math.imul(a ^ ch, 0x01000193) >>> 0;
		b = Math.imul(b ^ ch, 0x01000193) >>> 0;
		b = (b ^ (b >>> 15)) >>> 0;
	}
	return a.toString(36).padStart(7, "0") + b.toString(36).padStart(7, "0");
}

/**
 * The id the losing version of `c` is kept under: the same on every device, so merging the same copy again adds nothing. It is built
 * from a fingerprint of the whole original id plus the version's time, so it always fits `COMMENT_ID_MAX` without cutting anything
 * (cutting made ids that differ only at the end collide), and the marked copy of a marked copy gets an id of its own.
 */
export function conflictId(c: PageComment): string {
	const id = `${fingerprint(c.id)}${CONFLICT_ID_SEP}${touched(c).toString(36)}`;
	return id.length <= COMMENT_ID_MAX ? id : id.slice(0, COMMENT_ID_MAX);
}

/** The losing version of `c`, kept as an item of its own (a comment with the same region and sketch, or a reply in the same thread), marked. */
function conflictOf(c: PageComment): PageComment {
	const marked = c.text.startsWith(CONFLICT_MARK.trim()) ? c.text : (CONFLICT_MARK + c.text).trimEnd();
	const text = marked.length <= COMMENT_TEXT_MAX ? marked : c.text;
	if (isReply(c)) return freezeComment({ id: conflictId(c), parent: c.parent, text, author: c.author, created: c.created });
	return freezeComment({ id: conflictId(c), region: c.region, text, ...(c.sketch ? { sketch: c.sketch } : {}), author: c.author, created: c.created });
}

/** Whether `result` holds the version `c` of a comment: as it is, as a newer version of it, or as a marked copy kept beside the winner. */
export function commentCovered(result: readonly PageComment[], c: PageComment): boolean {
	const r = result.find((x) => x.id === c.id);
	if (!r || touched(r) < touched(c)) return false;
	if (!isEditConflict(r, c)) return true;
	return result.some((x) => x.id === conflictId(c));
}

/**
 * Copy of a page's comments for another page (duplicate, move or copy to another notebook): the same ids (they only have to be
 * unique within a page), frozen. Undefined when none. The list is read again against the new page's size so nothing outside it
 * is kept.
 */
export function copyComments(list: readonly PageComment[] | undefined, page: { width: number; height: number }): PageComment[] | undefined {
	if (!list || list.length === 0) return undefined;
	const { comments } = readComments(list, page);
	return comments.length > 0 ? freezeList(comments) : undefined;
}
