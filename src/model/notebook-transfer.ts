/**
 * Merge notebooks, split a notebook, extract pages into a new notebook (roadmap #77). The pure planning, no 'obsidian', no
 * DOM, no format change: every operation is "copy these pages of one notebook into another document", optionally followed
 * by "take them out of the source". The caller (library/page-transfer.ts) does the writing in the one order that cannot lose
 * ink: the destination first and read back, the source only afterwards, only the pages still exactly as they were copied.
 *
 * It builds on the "Move to notebook…" planner (library/page-move.ts: asset records the destination lacks, page ids,
 * bookmarks, snapshots) and adds what a whole-notebook operation needs on top:
 * - `copy` gives the copies new page ids (the originals stay where they are, so one id would name two pages and
 *   "Update links" could not tell them apart); `move` keeps the ids, so stable links (`#p3&id=…`) follow the page;
 * - slide links (v12) are carried: the destination gets the entries of the slide table its strokes name (matched or added
 *   by `slideMerger`), so ink written beside a slide still shows it;
 * - a locked page (v14) keeps its lock in the copy; taking a locked page out of the source needs `allowLocked`, which the
 *   caller sets only after the user confirmed it;
 * - a new notebook is a document made from the plan against an empty destination (so nothing collides);
 * - text boxes that name a moved page in a page link are listed (`textLinksToPages`) so the caller can report them.
 */
import { removeBookmark } from "./bookmarks";
import { cloneMeta, createDocument, createId } from "./document";
import { lockedPages } from "./page-lock";
import { copyStroke } from "./pages";
import { AddSlideRef, slideMerger } from "./slide-links";
import { DEFAULT_META, type NotebookDocument, type Page, type SlideRef } from "./types";
import { scanPageLinks } from "../integration/link-update";
import { planPageMove, planSourceRemoval, withMovedBookmarks, type PageMoveFailure, type PageMovePlan, type SourceRemoval } from "../library/page-move";
import { parseSubpathParams } from "../zettel/subpath";

export type TransferMode = "copy" | "move";

export type TransferFailure = PageMoveFailure | { ok: false; reason: "bad-split"; at: number } | { ok: false; reason: "same-notebook" };

export interface TransferPlan extends PageMovePlan {
	mode: TransferMode;
	/** Index in the destination's page list where the copies go (0..length). */
	at: number;
	/** Slide table entries the destination needs and does not have; the copies' strokes already name the ids used here. */
	slides: SlideRef[];
	/** Ids of the chosen source pages that are locked (their copies are locked too). */
	locked: string[];
}

export interface TransferOptions {
	/** Where the pages go in the destination; default (and any value out of range): the end. */
	at?: number;
}

/**
 * Plans putting the pages `pageIds` of `source` into `target`, in the order they have in the source. Never changes either
 * document. `move` keeps the page ids (unless the destination already uses one), `copy` gives every copy a new id.
 */
export function planTransfer(
	source: NotebookDocument, pageIds: readonly string[], target: NotebookDocument, mode: TransferMode, opts: TransferOptions = {},
): TransferPlan | PageMoveFailure {
	// v17: a moved page is the same page (the originals are removed), so its checkboxes keep the link to their task lines; a copy never does.
	const base = planPageMove(source, pageIds, target, mode === "move");
	if (!base.ok) return base;
	const wanted = new Set(pageIds);
	const chosen = source.pages.filter((p) => wanted.has(p.id));
	const merger = slideMerger(target, source);
	const locked: string[] = [];
	const pages: Page[] = base.pages.map((copy, i) => {
		const from = chosen[i]!;
		if (from.locked === true) {
			copy.locked = true;
			locked.push(from.id);
		}
		// `planPageMove` left the slide links out (they name the source's table); here they are matched to the destination's.
		copy.strokes = copy.strokes.map((s, j) => {
			const slide = from.strokes[j]?.slide;
			if (slide === undefined) return s;
			const to = merger.map(slide);
			return to === null ? s : copyStroke(s, s.id, to);
		});
		return copy;
	});
	let renamed = base.renamed;
	let bookmarks = base.bookmarks;
	if (mode === "copy") {
		// The originals stay: a copy is a new page. Its bookmark follows it to the new id.
		const fresh = new Map<string, string>();
		for (const p of pages) {
			const id = createId();
			fresh.set(p.id, id);
			p.id = id;
		}
		renamed = [];
		bookmarks = bookmarks.map((b) => ({ ...b, pageId: fresh.get(b.pageId) ?? b.pageId }));
	}
	const slides = merger.commands().flatMap((c) => (c instanceof AddSlideRef ? [c.ref] : []));
	const at = opts.at === undefined || !Number.isInteger(opts.at) ? target.pages.length : Math.max(0, Math.min(opts.at, target.pages.length));
	return { ...base, mode, pages, renamed, bookmarks, at, slides, locked };
}

/**
 * Merge notebook `b` into `a`: all of `b`'s pages, in order, after the page with 0-based index `after` of `a` (absent or
 * negative: at the end). `move` when `b` goes to the trash afterwards (the ids follow), else `copy`.
 */
export function planMerge(a: NotebookDocument, b: NotebookDocument, mode: TransferMode, after?: number): TransferPlan | TransferFailure {
	if (a.id === b.id) return { ok: false, reason: "same-notebook" };
	const at = after === undefined || after < 0 ? undefined : after + 1;
	return planTransfer(b, b.pages.map((p) => p.id), a, mode, at === undefined ? {} : { at });
}

export interface SplitPlan {
	ok: true;
	/** Pages that go to the new notebook (from `at` to the end), and how many stay. */
	tail: string[];
	head: number;
}

/** Split before the page with 0-based index `at`: the new notebook starts there. Both halves must have a page. */
export function planSplit(source: NotebookDocument, at: number): SplitPlan | TransferFailure {
	if (!Number.isInteger(at) || at < 1 || at >= source.pages.length) return { ok: false, reason: "bad-split", at };
	return { ok: true, tail: source.pages.slice(at).map((p) => p.id), head: at };
}

export interface NewNotebookPlan {
	ok: true;
	plan: TransferPlan;
	/** The document to create: fresh identity, the pages, the assets and slides they need, the source's look. */
	doc: NotebookDocument;
}

/**
 * The document of a notebook made from pages of `source` (extract, split): validated against an empty destination, so ids
 * and assets never collide. The cover colour, tags and a generated cover style follow the source; the favourite flag, the
 * description, a picture cover and the reading position do not (they belong to the notebook it came from).
 */
export function planNewNotebook(source: NotebookDocument, pageIds: readonly string[], mode: TransferMode, now: Date = new Date()): NewNotebookPlan | PageMoveFailure {
	const doc = createDocument(now);
	doc.pages = [];
	const plan = planTransfer(source, pageIds, doc, mode);
	if (!plan.ok) return plan;
	doc.pages = plan.pages;
	doc.assets = Object.fromEntries(plan.assets.map((a) => [a.id, a]));
	if (plan.slides.length > 0) doc.slides = plan.slides;
	const meta = cloneMeta(DEFAULT_META);
	if (source.meta) {
		meta.cover = source.meta.cover;
		meta.tags = [...source.meta.tags];
		if (source.meta.coverArt?.kind === "art") meta.coverArt = { ...source.meta.coverArt, seed: createId().slice(0, 8) };
	}
	doc.meta = withMovedBookmarks(meta, plan.bookmarks);
	return { ok: true, plan, doc };
}

export interface TransferRemoval extends SourceRemoval {
	/** Locked pages that were copied and stay in the source because their removal was not confirmed. */
	keptLocked: string[];
}

/**
 * Which pages may leave the source now that the destination holds them: those still exactly as they were copied
 * (`planSourceRemoval`), and, unless `allowLocked`, not the locked ones. `moved` is the plan's snapshot list.
 */
export function planRemoval(current: NotebookDocument, moved: PageMovePlan["moved"], allowLocked: boolean): TransferRemoval {
	const locked = new Set(lockedPages(current, moved.map((m) => m.pageId)));
	const eligible = allowLocked ? moved : moved.filter((m) => !locked.has(m.pageId));
	return { ...planSourceRemoval(current, eligible), keptLocked: allowLocked ? [] : [...locked] };
}

/**
 * Takes the pages of `removal` out of `doc` (a document parsed from the file, for a source that is not open) and keeps it
 * consistent: a blank replacement when it would be left without pages, no bookmark and no reading position on a page that is
 * gone. The slide table and the assets need nothing: entries nothing refers to are not written.
 */
export function applyRemoval(doc: NotebookDocument, removal: SourceRemoval): void {
	const gone = new Set(removal.remove.map((p) => p.id));
	const keep = doc.pages.filter((p) => !removal.remove.includes(p));
	if (removal.replacement) keep.push(removal.replacement);
	doc.pages.splice(0, doc.pages.length, ...keep);
	if (doc.meta) {
		let meta = doc.meta;
		for (const id of gone) if (meta.bookmarks.includes(id)) meta = removeBookmark(meta, id);
		doc.meta = meta;
	}
	if (doc.position && gone.has(doc.position.page)) delete doc.position;
}

/** A text box whose text holds a page link (`[[Notebook#p3&id=…]]`) to one of the pages in question. */
export interface PageTextLink {
	pageId: string;
	elementId: string;
	/** The linked page ids that are among those asked for. */
	targets: string[];
}

/**
 * Text boxes of `pages` that link to a page with one of `ids`. Such a link names a notebook and a page id; when the page
 * leaves that notebook the link has to follow it. Links in notes are updated by "Update links to notebook pages"; this finds
 * the ones written inside notebooks, which nothing else rewrites, so the caller can tell the user.
 */
export function textLinksToPages(pages: readonly Page[], ids: ReadonlySet<string>): PageTextLink[] {
	const out: PageTextLink[] = [];
	if (ids.size === 0) return out;
	for (const page of pages) {
		for (const el of page.elements ?? []) {
			if (el.type !== "text" || !el.text.includes("#")) continue;
			const targets = new Set<string>();
			for (const ref of scanPageLinks(el.text)) {
				const id = parseSubpathParams(ref.fragment).pageId;
				if (id !== null && ids.has(id)) targets.add(id);
			}
			if (targets.size > 0) out.push({ pageId: page.id, elementId: el.id, targets: [...targets] });
		}
	}
	return out;
}
