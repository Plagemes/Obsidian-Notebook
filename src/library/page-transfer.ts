/**
 * Merge notebooks, split a notebook, extract pages into a new notebook (roadmap #77): the part that touches files. The plans
 * are in model/notebook-transfer.ts (pure and tested); this runs them in the one order that cannot lose ink:
 *
 *   1. read the source (what the open view holds, else the file) and the destination;
 *   2. plan, make sure the asset files are where the destination expects them;
 *   3. write the DESTINATION — a new notebook is created, validated and read back; an existing one gets the pages through
 *      its open view (one undo step) or through a re-validated, backed-up, stale-checked file write — and read it back;
 *   4. only then take the pages out of the SOURCE, and only those still exactly as they were copied (an open source through
 *      its history, one undo step; a closed one through the same careful file write), locked ones only when confirmed;
 *   5. a merged notebook that the user asked to remove goes to the library trash, never deleted, and only when every page of
 *      it is in the destination and unchanged.
 *
 * Anything that goes wrong before step 4 leaves the source as it was; after step 4 failed the pages simply exist twice.
 * Nothing here changes the document format.
 */
import type { App, TFile } from "obsidian";
import { t } from "../i18n";
import { cloneMeta, createId } from "../model/document";
import { AddAsset, AddPage, Batch, DeletePage, InsertPages, SetMeta, type Command } from "../model/history";
import {
	applyRemoval, planMerge, planNewNotebook, planRemoval, planSplit, planTransfer, textLinksToPages,
	type TransferMode, type TransferPlan, type TransferRemoval,
} from "../model/notebook-transfer";
import { parse, serializeChecked } from "../model/serialize";
import { AddSlideRef } from "../model/slide-links";
import { DEFAULT_META, type NotebookDocument } from "../model/types";
import { backupFolder, type NotebookSettings } from "../settings";
import { readNotebookText, writeNotebookText } from "../storage/format";
import { quickDocId } from "../storage/history";
import { createNotebook } from "../storage/notebooks";
import { VaultDocumentIO } from "../storage/vault-io";
import type { LibraryTrash } from "../storage/trash";
import type { EditContext } from "../view/edit-context";
import { holdsPages, withMovedBookmarks, type PageMoveFailure } from "./page-move";
import { openEditContext, recordRenamed, relocateAssets, storedInFile } from "./move-pages";
import { hasPendingJournal, type StorageEnv } from "./storage-actions";

const NOTEBOOK_VIEW_TYPE = "notebook-view";

export interface TransferEnv {
	app: App;
	settings(): NotebookSettings;
	/** The library trash; absent: a merged notebook cannot be moved to the trash (the option is not offered). */
	trash?: LibraryTrash;
	/**
	 * The instant-save journal (where it is). A closed notebook with an entry there has ink that was never saved to its file:
	 * rewriting the file, or trashing it, would take that ink away. Without it no journal is looked at (the caller then only
	 * works on notebooks that are open or new).
	 */
	journal?: StorageEnv["journal"];
}

/**
 * Throws when the closed notebook whose text is `raw` has edits waiting in the journal: they are in no file yet, so a rewrite
 * would make them miss their base (on the next open they would go to a backup), and the trash would lose them.
 */
async function assertNoPendingJournal(env: TransferEnv, file: TFile, raw: string): Promise<void> {
	if (await hasPendingJournal(env, quickDocId(raw))) throw new JournalPendingError(t("transfer.journalPending", { name: file.basename }));
}

/** The refusal of a rewrite because of the journal; told apart so a move that already made its copy can say what is true. */
class JournalPendingError extends Error {}

/** What an operation did, for the notice and the tests of the harness. */
export interface TransferSummary {
	/** Pages now in the destination. */
	added: number;
	/** Of those, pages taken out of the source. */
	removed: number;
	/** Copied pages that stayed in the source because they changed while the operation ran. */
	changed: number;
	/** Locked pages that stayed in the source (their removal was not confirmed). */
	keptLocked: number;
	/** Pages that got a new id in the destination (it already had that id). */
	renamed: number;
	/** The destination (a new notebook, or the one pages were added to). */
	destination: TFile;
	/** The source notebook went to the trash (merge with "move to trash"). */
	trashed: boolean;
	/** The merged notebook could not go to the trash (changed meanwhile, or the trash failed): why. */
	trashSkipped: "changed" | "failed" | null;
	/** Text boxes of the notebooks involved that link to a page that moved. */
	textLinks: number;
}

interface Loaded {
	file: TFile;
	doc: NotebookDocument;
	/** Open, editable view of the file. */
	ctx: EditContext | null;
}

/** The text of the document in the file as parse() wants it. */
async function readDoc(app: App, file: TFile): Promise<{ raw: string; doc: NotebookDocument }> {
	const raw = readNotebookText(file.extension, await app.vault.read(file));
	const parsed = parse(raw);
	if (!parsed.ok) throw new Error(t("transfer.unreadable", { name: file.basename, error: parsed.message }));
	return { raw, doc: parsed.doc };
}

/** The document an open view holds, editable or not (a read-only view still has the latest ink in memory). */
function openDocument(app: App, file: TFile): NotebookDocument | null {
	for (const leaf of app.workspace.getLeavesOfType(NOTEBOOK_VIEW_TYPE)) {
		const view = leaf.view as unknown as { file?: TFile | null; document?: unknown };
		if (view.file?.path !== file.path) continue;
		const doc = view.document;
		if (typeof doc === "object" && doc !== null && Array.isArray((doc as { pages?: unknown }).pages)) return doc as NotebookDocument;
	}
	return null;
}

/**
 * The source: what the open view holds when there is one (an unsaved stroke is part of the notebook), else the file. A source
 * whose pages will be taken out must be editable here; one that is only read can be any open view.
 */
async function loadSource(env: TransferEnv, file: TFile, willEdit: boolean): Promise<Loaded> {
	const app = env.app;
	const ctx = openEditContext(app, file);
	if (ctx === "busy") {
		const doc = willEdit ? null : openDocument(app, file);
		if (!doc) throw new Error(t("transfer.busy", { name: file.basename }));
		return { file, doc, ctx: null };
	}
	if (ctx) return { file, doc: ctx.doc, ctx };
	const { raw, doc } = await readDoc(app, file);
	// Pages will leave it, so the file will be rewritten (or trashed): not while edits wait in the journal.
	if (willEdit) await assertNoPendingJournal(env, file, raw);
	return { file, doc, ctx: null };
}

/** Folder part of a vault path ("" at the top). */
export function dirOf(path: string): string {
	return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function failureText(f: PageMoveFailure | { ok: false; reason: string }): string {
	if (f.reason === "missing-asset") return t("move.missingAsset");
	if (f.reason === "same-notebook") return t("transfer.sameNotebook");
	if (f.reason === "bad-split") return t("transfer.badSplit");
	return t("move.noPages");
}

/**
 * Adds a plan's pages to a notebook that is not open: parse, add, re-validate, keep a copy of what was there, write only if
 * the file still holds what was read, then read it back and check the pages are in it. Throws on any doubt; the file is then
 * unchanged (or, if the read-back fails, a backup of the original exists).
 */
async function insertIntoFile(env: TransferEnv, file: TFile, doc: NotebookDocument, before: string, plan: TransferPlan): Promise<void> {
	const app = env.app;
	const settings = env.settings();
	await assertNoPendingJournal(env, file, before);
	for (const asset of plan.assets) (doc.assets ??= {})[asset.id] = asset;
	if (plan.slides.length > 0) doc.slides = [...(doc.slides ?? []), ...plan.slides];
	doc.pages.splice(plan.at, 0, ...plan.pages);
	if (plan.bookmarks.length > 0) doc.meta = withMovedBookmarks(doc.meta, plan.bookmarks);
	doc.modifiedAt = new Date().toISOString();
	const checked = serializeChecked(doc, true);
	if (!checked.ok) throw new Error(checked.message);
	const io = new VaultDocumentIO(app, file, () => backupFolder(settings));
	await io.backup(before, "before-move");
	let stale = false;
	await app.vault.process(file, (current) => {
		if (readNotebookText(file.extension, current) !== before) {
			stale = true;
			return current;
		}
		return writeNotebookText(file.extension, checked.text, current);
	});
	if (stale) throw new Error(t("host.changedElsewhere"));
	if (!holdsPages(await io.read(), plan.pages.map((p) => p.id))) throw new Error(t("move.verifyFailed"));
}

/** Takes the pages out of a notebook that is not open: the same careful write as above, then a read-back of what stays. */
async function removeFromFile(env: TransferEnv, file: TFile, removal: (doc: NotebookDocument) => TransferRemoval): Promise<{ removal: TransferRemoval; removed: number }> {
	const app = env.app;
	const settings = env.settings();
	const { raw, doc } = await readDoc(app, file);
	const r = removal(doc);
	if (r.remove.length === 0) return { removal: r, removed: 0 };
	// Checked again here, right before the rewrite: the journal may have got an entry since the source was loaded.
	await assertNoPendingJournal(env, file, raw);
	const staying = doc.pages.filter((p) => !r.remove.includes(p)).map((p) => p.id);
	applyRemoval(doc, r);
	doc.modifiedAt = new Date().toISOString();
	const checked = serializeChecked(doc, true);
	if (!checked.ok) throw new Error(checked.message);
	const io = new VaultDocumentIO(app, file, () => backupFolder(settings));
	await io.backup(raw, "before-move");
	let stale = false;
	await app.vault.process(file, (current) => {
		if (readNotebookText(file.extension, current) !== raw) {
			stale = true;
			return current;
		}
		return writeNotebookText(file.extension, checked.text, current);
	});
	if (stale) throw new Error(t("host.changedElsewhere"));
	// Everything that was to stay is still in the file (it was written by this call, the read-back catches a lost write).
	const back = await io.read();
	if (staying.length > 0 && !holdsPages(back, staying)) throw new Error(t("transfer.verifySource", { name: file.basename }));
	return { removal: r, removed: r.remove.length };
}

/** Adds the plan's pages to an existing notebook (open: one undo step through its view; closed: a careful file write). */
async function writeIntoExisting(env: TransferEnv, dest: TFile, plan: TransferPlan, sourceFolder: string): Promise<void> {
	const app = env.app;
	const ctx = openEditContext(app, dest);
	if (ctx === "busy") throw new Error(t("transfer.destinationBusy", { name: dest.basename }));
	if (ctx) {
		const assets = await relocateAssets(app, sourceFolder, plan.assets);
		const commands: Command[] = assets.map((a) => new AddAsset(a));
		for (const ref of plan.slides) commands.push(new AddSlideRef(ref));
		commands.push(new InsertPages(plan.pages, plan.at));
		if (plan.bookmarks.length > 0) {
			const before = ctx.doc.meta ?? cloneMeta(DEFAULT_META);
			commands.push(new SetMeta(before, withMovedBookmarks(before, plan.bookmarks)));
		}
		// Refused (read-only, the content check): nothing was added there, so nothing may leave the source.
		if (!ctx.execute(new Batch("Add pages from another notebook", commands), plan.at)) throw new Error(t("move.targetNotSaved"));
		const flushed = await ctx.flush();
		const stored = await storedInFile(app, dest, plan.pages.map((p) => p.id));
		if (!stored) throw new Error(t(flushed ? "move.targetNotStored" : "move.targetNotSaved"));
		return;
	}
	const { raw, doc } = await readDoc(app, dest);
	await assertNoPendingJournal(env, dest, raw);
	const assets = await relocateAssets(app, sourceFolder, plan.assets);
	await insertIntoFile(env, dest, doc, raw, { ...plan, assets });
}

interface RemovalRequest {
	/** Remove locked pages too (the user confirmed it). */
	allowLocked: boolean;
}

/** Takes the copied pages out of the source (open: one undo step; closed: a file write). Never throws for "some stayed". */
async function removeFromSource(env: TransferEnv, src: Loaded, moved: TransferPlan["moved"], req: RemovalRequest): Promise<{ removal: TransferRemoval; removed: number }> {
	let ctx = src.ctx;
	if (!ctx) {
		// A view may have opened the file since it was read: then it is the view's to change (one undo step), not ours.
		const now = openEditContext(env.app, src.file);
		if (now === "busy") throw new Error(t("transfer.busy", { name: src.file.basename }));
		ctx = now;
	}
	if (ctx) {
		if (!ctx.alive()) throw new Error(t("transfer.sourceGone", { name: src.file.basename }));
		const removal = planRemoval(ctx.doc, moved, req.allowLocked);
		if (removal.remove.length === 0) return { removal, removed: 0 };
		const pages = ctx.doc.pages;
		const commands: Command[] = [];
		if (removal.replacement) commands.push(new AddPage(removal.replacement, pages.length));
		const going = removal.remove.map((page) => ({ page, index: pages.indexOf(page) })).sort((a, b) => b.index - a.index);
		for (const g of going) commands.push(new DeletePage(g.page, g.index));
		const lockedGoing = removal.remove.some((p) => p.locked === true);
		// A confirmed removal of a locked page is the one edit the page-lock guard is told to let through.
		const batch = new Batch("Take pages out", commands, lockedGoing);
		const done = ctx.execute(batch, Math.max(0, Math.min(ctx.currentPage(), pages.length - 1)));
		return { removal, removed: done ? removal.remove.length : 0 };
	}
	return removeFromFile(env, src.file, (doc) => planRemoval(doc, moved, req.allowLocked));
}

function summarise(p: TransferPlan, destination: TFile, extra: Partial<TransferSummary>): TransferSummary {
	return {
		added: p.pages.length, removed: 0, changed: 0, keptLocked: 0, renamed: p.renamed.length, destination,
		trashed: false, trashSkipped: null, textLinks: 0, ...extra,
	};
}

/** Text boxes, in what stays of the source and in the pages that came over, that link to a page which moved. */
function linksAfter(src: NotebookDocument, plan: TransferPlan, moved: ReadonlySet<string>): number {
	return textLinksToPages([...src.pages.filter((p) => !moved.has(p.id)), ...plan.pages], moved).length;
}

// ------------------------------------------------------------------------------------------------ extract and split

export interface ExtractRequest {
	source: TFile;
	pageIds: readonly string[];
	/** `copy`: the pages stay in the source. `move`: they leave it once the new notebook is safe. */
	mode: TransferMode;
	/** Name of the new notebook (made unique in the folder). */
	name: string;
	/** Folder of the new notebook. */
	folder: string;
	/** The user confirmed that locked pages leave the source. */
	allowLocked: boolean;
}

/** The source of a move is looked at again before anything is created: still closed with edits in its journal means stop. */
async function assertSourceClosedAndSaved(env: TransferEnv, src: Loaded): Promise<void> {
	if (openEditContext(env.app, src.file) !== null) return; // open (or busy): its view owns the edits, nothing is rewritten by file
	const { raw } = await readDoc(env.app, src.file);
	await assertNoPendingJournal(env, src.file, raw);
}

/**
 * The new notebook exists but the pages could not be taken out of the source. Said truthfully: the pages are in both. When the
 * source still holds every page that was copied, the copy gets new page ids, so the two notebooks never share one; if even
 * that fails, the error says the ids are shared. Returns the error to throw.
 */
async function copiedButNotMoved(env: TransferEnv, src: Loaded, made: TFile, plan: TransferPlan, cause: unknown): Promise<Error> {
	const args = { name: made.basename, source: src.file.basename };
	const now = await currentDocument(env.app, src.file);
	const ids = plan.moved.map((m) => m.pageId);
	const stillThere = now !== null && ids.every((id) => now.pages.some((p) => p.id === id));
	let renewed = false;
	if (stillThere) {
		try {
			await renewPageIds(env, made, ids);
			renewed = true;
		} catch (e) {
			console.error("[notebook] transfer: could not give the copied pages new ids", e);
		}
	}
	const reason = cause instanceof JournalPendingError ? "journal" : "other";
	const key = reason === "journal"
		? (renewed ? "transfer.copiedJournal" : "transfer.copiedJournalShared")
		: (!stillThere ? "transfer.copiedMaybeMoved" : renewed ? "transfer.copiedNotMoved" : "transfer.copiedNotMovedShared");
	return new Error(t(key, { ...args, error: cause instanceof Error ? cause.message : String(cause) }));
}

/** Gives the pages `ids` of a notebook this run just created new ids (and moves their bookmarks along): a careful, stale-checked write. */
async function renewPageIds(env: TransferEnv, file: TFile, ids: readonly string[]): Promise<void> {
	const app = env.app;
	const { raw, doc } = await readDoc(app, file);
	const fresh = new Map<string, string>();
	for (const p of doc.pages) {
		if (!ids.includes(p.id)) continue;
		const id = createId();
		fresh.set(p.id, id);
		p.id = id;
	}
	if (fresh.size === 0) return;
	if (doc.meta) {
		doc.meta.bookmarks = doc.meta.bookmarks.map((b) => fresh.get(b) ?? b);
		if (doc.meta.bookmarkInfo) doc.meta.bookmarkInfo = Object.fromEntries(Object.entries(doc.meta.bookmarkInfo).map(([k, v]) => [fresh.get(k) ?? k, v]));
	}
	doc.modifiedAt = new Date().toISOString();
	const checked = serializeChecked(doc, true);
	if (!checked.ok) throw new Error(checked.message);
	let stale = false;
	await app.vault.process(file, (current) => {
		if (readNotebookText(file.extension, current) !== raw) {
			stale = true;
			return current;
		}
		return writeNotebookText(file.extension, checked.text, current);
	});
	if (stale) throw new Error(t("host.changedElsewhere"));
	if (!holdsPages(readNotebookText(file.extension, await app.vault.read(file)), [...fresh.values()])) throw new Error(t("move.verifyFailed"));
}

/** Makes a new notebook from pages of `source` and, for `move`, takes them out of the source afterwards. */
export async function extractPages(env: TransferEnv, req: ExtractRequest): Promise<TransferSummary> {
	const app = env.app;
	const src = await loadSource(env, req.source, req.mode === "move");
	const made = planNewNotebook(src.doc, req.pageIds, req.mode);
	if (!made.ok) throw new Error(failureText(made));
	const { plan, doc } = made;
	// Pages leave a closed source, so its file will be rewritten: looked at again right before the new notebook is made (not
	// only when the source was loaded), so a failure is a refusal with nothing created, not a half-done move.
	if (req.mode === "move") await assertSourceClosedAndSaved(env, src);
	doc.assets = Object.fromEntries((await relocateAssets(app, env.settings().folder, plan.assets)).map((a) => [a.id, a]));
	const checked = serializeChecked(doc, true);
	if (!checked.ok) throw new Error(checked.message);
	// 3. The destination first: created, then read back. If it does not hold the pages the source is not touched.
	const file = await createNotebook(app, req.folder, req.name, doc);
	if (!holdsPages(readNotebookText(file.extension, await app.vault.read(file)), plan.pages.map((p) => p.id))) {
		throw new Error(t("transfer.verifyNew", { name: file.basename }));
	}
	if (req.mode === "copy") return summarise(plan, file, {});
	const moved = new Set(plan.moved.map((m) => m.pageId));
	let out: { removal: TransferRemoval; removed: number };
	try {
		out = await removeFromSource(env, src, plan.moved, { allowLocked: req.allowLocked });
	} catch (e) {
		throw await copiedButNotMoved(env, src, file, plan, e);
	}
	return summarise(plan, file, {
		removed: out.removed, changed: out.removal.changed.length + (out.removal.remove.length - out.removed),
		keptLocked: out.removal.keptLocked.length, textLinks: linksAfter(src.doc, plan, moved),
	});
}

export interface SplitRequest {
	source: TFile;
	/** 0-based index of the first page of the new notebook. */
	at: number;
	name: string;
	allowLocked: boolean;
}

/** Splits a notebook before a page: the pages from there to the end become a new notebook next to it. */
export async function splitNotebook(env: TransferEnv, req: SplitRequest): Promise<TransferSummary> {
	const src = await loadSource(env, req.source, true);
	const split = planSplit(src.doc, req.at);
	if (!split.ok) throw new Error(failureText(split));
	return extractPages(env, { source: req.source, pageIds: split.tail, mode: "move", name: req.name, folder: dirOf(req.source.path), allowLocked: req.allowLocked });
}

// -------------------------------------------------------------------------------------------------------------- merge

export interface MergeRequest {
	/** The notebook that receives the pages (A). */
	into: TFile;
	/** The notebook whose pages are added (B). */
	from: TFile;
	/** 0-based index of the page of A to insert after; absent: at the end. */
	after?: number;
	/** Move B to the library trash once its pages are in A. */
	trashFrom: boolean;
	allowLocked: boolean;
}

/** Every page of `doc` is in the removal and none stays behind (changed, gone or locked): the notebook may go to the trash. */
function wholeRemoval(removal: TransferRemoval, doc: NotebookDocument): boolean {
	return removal.remove.length === doc.pages.length && removal.changed.length === 0 && removal.gone.length === 0 && removal.keptLocked.length === 0;
}

/** Merges B into A: B's pages are added to A and, if asked, B goes to the library trash. B is changed only by that. */
export async function mergeNotebooks(env: TransferEnv, req: MergeRequest): Promise<TransferSummary> {
	const app = env.app;
	if (req.into.path === req.from.path) throw new Error(t("transfer.sameNotebook"));
	if (req.trashFrom && !env.trash) throw new Error(t("transfer.noTrash"));
	const from = await loadSource(env, req.from, req.trashFrom);
	// A's document as it is now, to plan against (an open view's in-memory document, else the file).
	const intoCtx = openEditContext(app, req.into);
	if (intoCtx === "busy") throw new Error(t("transfer.destinationBusy", { name: req.into.basename }));
	const intoDoc = intoCtx ? intoCtx.doc : (await readDoc(app, req.into)).doc;
	// B goes to the trash afterwards: its pages move (the ids follow, links keep working); otherwise they are copies. The ids
	// may follow only when the trash is certain: if B has pages that would stay (changed, or locked and not confirmed), A gets
	// copies with new ids instead, so A and B never share a page id.
	let plan = planMerge(intoDoc, from.doc, req.trashFrom ? "move" : "copy", req.after);
	if (!plan.ok) throw new Error(failureText(plan));
	let keptBack: TransferRemoval | null = null;
	if (req.trashFrom) {
		const pre = planRemoval(from.doc, plan.moved, req.allowLocked);
		if (!wholeRemoval(pre, from.doc)) {
			const copies = planMerge(intoDoc, from.doc, "copy", req.after);
			if (copies.ok) {
				plan = copies;
				keptBack = pre;
			}
		}
	}
	// 3. A first.
	await writeIntoExisting(env, req.into, plan, env.settings().folder);
	if (plan.renamed.length > 0) await recordRenamed(app, env.settings(), plan.renamed, intoDoc.id);
	const links = textLinksToPages([...plan.pages], new Set(plan.moved.map((m) => m.pageId))).length;
	if (!req.trashFrom) return summarise(plan, req.into, { textLinks: links });
	if (keptBack) {
		return summarise(plan, req.into, { trashSkipped: "changed", changed: keptBack.changed.length, keptLocked: keptBack.keptLocked.length, textLinks: links });
	}
	// 5. B goes to the trash only if all of it is in A and nothing was written to it meanwhile.
	let now: Loaded;
	try {
		now = await loadSource(env, req.from, true);
	} catch (e) {
		console.error("[notebook] merge: the merged notebook cannot be checked before the trash", e);
		return summarise(plan, req.into, { trashSkipped: "changed", textLinks: links });
	}
	const removal = planRemoval(now.doc, plan.moved, req.allowLocked);
	if (!wholeRemoval(removal, now.doc)) {
		return summarise(plan, req.into, { trashSkipped: "changed", changed: removal.changed.length, keptLocked: removal.keptLocked.length, textLinks: links });
	}
	try {
		await env.trash!.trash(req.from);
	} catch (e) {
		console.error("[notebook] merge: could not move the merged notebook to the trash", e);
		return summarise(plan, req.into, { trashSkipped: "failed", textLinks: links });
	}
	return summarise(plan, req.into, { removed: plan.pages.length, trashed: true, textLinks: links });
}

// ------------------------------------------------------------------------------------------------ copy into a notebook

export interface CopyIntoRequest {
	source: TFile;
	pageIds: readonly string[];
	dest: TFile;
	/** 0-based index in the destination the copies start at; absent: at the end. */
	at?: number;
	/**
	 * Called with the plan right before it is written (the copies are plain objects nobody else holds yet): lets a caller add
	 * to the copies in the same write, so they arrive complete. `sourceDoc` is the source as planned from.
	 */
	decorate?: (plan: TransferPlan, sourceDoc: NotebookDocument) => void;
}

/** What `copyPagesInto` did. `pageIds` are the ids of the copies, in the order of their pages in the source. */
export interface CopyIntoResult {
	summary: TransferSummary;
	pageIds: string[];
	/** 0-based index of the first copy in the destination. */
	at: number;
}

/**
 * Copies pages of `source` into an existing notebook at a position (the pages stay in the source, the copies get new ids).
 * The same planning and the same careful write as a merge: an open destination takes them as one undo step, a closed one is
 * rewritten with a backup, a stale check and a read-back, and not while its journal holds unsaved edits.
 */
export async function copyPagesInto(env: TransferEnv, req: CopyIntoRequest): Promise<CopyIntoResult> {
	const app = env.app;
	if (req.source.path === req.dest.path) throw new Error(t("transfer.sameNotebook"));
	const src = await loadSource(env, req.source, false);
	const destCtx = openEditContext(app, req.dest);
	if (destCtx === "busy") throw new Error(t("transfer.destinationBusy", { name: req.dest.basename }));
	const destDoc = destCtx ? destCtx.doc : (await readDoc(app, req.dest)).doc;
	if (destDoc.id === src.doc.id) throw new Error(t("transfer.sameNotebook"));
	const plan = planTransfer(src.doc, req.pageIds, destDoc, "copy", req.at === undefined ? {} : { at: req.at });
	if (!plan.ok) throw new Error(failureText(plan));
	req.decorate?.(plan, src.doc);
	await writeIntoExisting(env, req.dest, plan, env.settings().folder);
	return { summary: summarise(plan, req.dest, {}), pageIds: plan.pages.map((p) => p.id), at: plan.at };
}

/** The notebook as it is now: what an open view holds (unsaved ink included), else the file. Null when it cannot be read. */
export async function currentDocument(app: App, file: TFile): Promise<NotebookDocument | null> {
	try {
		return openDocument(app, file) ?? (await readDoc(app, file)).doc;
	} catch (e) {
		console.error("[notebook] transfer: could not read", file.path, e);
		return null;
	}
}

/** Pages and locked pages of a notebook, for the dialogs. */
export async function inspectNotebook(app: App, file: TFile): Promise<{ pages: number; locked: number } | null> {
	const doc = await currentDocument(app, file);
	return doc ? { pages: doc.pages.length, locked: doc.pages.filter((p) => p.locked === true).length } : null;
}
