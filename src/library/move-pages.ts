import { normalizePath, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { cloneMeta } from "../model/document";
import { AddAsset, AddPage, Batch, DeletePage, InsertPages, SetMeta, type Command } from "../model/history";
import { parse, serializeChecked } from "../model/serialize";
import { DEFAULT_META, type Asset, type NotebookDocument } from "../model/types";
import { assetExtension, assetPath, assetsFolder } from "../pdf/assets";
import { backupFolder, type NotebookSettings } from "../settings";
import { readNotebookText, writeNotebookText } from "../storage/format";
import { listNotebooks } from "../storage/notebooks";
import { VaultDocumentIO } from "../storage/vault-io";
import { isEditContextSource, type EditContext } from "../view/edit-context";
import { resolveAssetFile, storeAsset } from "../view/media";
import { looseSheetPath } from "./loose-sheet-logic";
import { askMovePages } from "./move-pages-modal";
import {
	destinationVerdict, holdsPages, pageExcerpt, planPageMove, planSourceRemoval, withMovedBookmarks, type PageMoveFailure, type PageMovePlan,
} from "./page-move";
import { showNotice } from "../view/notice";

const NOTEBOOK_VIEW_TYPE = "notebook-view";

/** Open, editable view of `file`. A tab that is not loaded yet counts as not open: the file is then edited on disk. */
function openEditContext(app: App, file: TFile): EditContext | "busy" | null {
	for (const leaf of app.workspace.getLeavesOfType(NOTEBOOK_VIEW_TYPE)) {
		const view: unknown = leaf.view;
		if (!isEditContextSource(view) || view.file?.path !== file.path) continue;
		return view.editContext() ?? "busy";
	}
	return null;
}

/** Notebooks the pages can go to: the library's, plus the loose sheet when it lives outside the notebooks folder. */
export function moveTargets(app: App, settings: NotebookSettings, exclude: TFile | null): TFile[] {
	const files = listNotebooks(app, settings.folder);
	const loose = app.vault.getFileByPath(normalizePath(looseSheetPath(settings.folder, settings.looseSheetPath)));
	if (loose && !files.some((f) => f.path === loose.path)) files.push(loose);
	return files.filter((f) => f.path !== exclude?.path);
}

/**
 * Asset files live in `<notebooks folder>/_assets`, named by their content, and every notebook shares them: the target
 * only needs the records. A file that sits elsewhere (the notebooks folder setting changed) is copied there first.
 */
async function relocateAssets(app: App, folder: string, assets: readonly Asset[]): Promise<Asset[]> {
	const out: Asset[] = [];
	for (const record of assets) {
		const file = resolveAssetFile(app, record, folder);
		const wanted = normalizePath(assetPath(assetsFolder(folder), record.id, assetExtension(record.kind, record.name)));
		if (!file || file.path === wanted) {
			out.push(record);
			continue;
		}
		const copy = await storeAsset(app, folder, await app.vault.readBinary(file), record.name, record.kind);
		out.push(copy.id === record.id ? copy : record);
	}
	return out;
}

/**
 * Adds the pages to a notebook that is not open: parse, add, re-validate, keep a copy of what was there, write only if the
 * file still holds what was read, then read it back and check the pages are in it. Throws on any doubt; the file is then
 * unchanged (or, if the read-back fails, a backup of the original exists).
 */
async function appendToFile(
	app: App, file: TFile, doc: NotebookDocument, before: string, plan: PageMovePlan, settings: NotebookSettings,
): Promise<void> {
	for (const asset of plan.assets) (doc.assets ??= {})[asset.id] = asset;
	doc.pages.push(...plan.pages);
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

/**
 * After the open destination's flush: its file must still be there and hold the pages. The view may have closed, the
 * file may have been deleted or reloaded meanwhile (see destinationVerdict).
 */
async function storedInFile(app: App, file: TFile, pageIds: readonly string[]): Promise<boolean> {
	const current = app.vault.getFileByPath(file.path);
	if (!current || current !== file) return false;
	try {
		return holdsPages(readNotebookText(file.extension, await app.vault.read(file)), pageIds);
	} catch (e) {
		console.error("[notebook] move pages: read back", e);
		return false;
	}
}

function failureText(f: PageMoveFailure): string {
	return t(f.reason === "missing-asset" ? "move.missingAsset" : "move.noPages");
}

export interface MoveOutcome {
	/** Pages now in the target. */
	moved: number;
	/** Of those, pages removed from the source. */
	removed: number;
	/** Pages that are in the target and also stayed in the source (edited while moving, or the source was closed). */
	stayed: number;
	targetName: string;
}

/**
 * Copies pages to the end of another notebook and, only after that notebook has saved them, removes them from this one
 * (one undo step in each). Throws before touching the source if anything fails.
 */
export async function movePagesTo(src: EditContext, pageIds: readonly string[], target: TFile, settings: NotebookSettings): Promise<MoveOutcome> {
	const app = src.app;
	const targetCtx = openEditContext(app, target);
	if (targetCtx === "busy") throw new Error(t("move.targetBusy"));

	let before = "";
	let targetDoc: NotebookDocument;
	if (targetCtx) targetDoc = targetCtx.doc;
	else {
		before = readNotebookText(target.extension, await app.vault.read(target));
		const parsed = parse(before);
		if (!parsed.ok) throw new Error(t("move.targetUnreadable", { error: parsed.message }));
		targetDoc = parsed.doc;
	}

	const plan = planPageMove(src.doc, pageIds, targetDoc);
	if (!plan.ok) throw new Error(failureText(plan));
	const assets = await relocateAssets(app, src.folder, plan.assets);
	const ready: PageMovePlan = { ...plan, assets };

	if (targetCtx) {
		const commands: Command[] = assets.map((a) => new AddAsset(a));
		commands.push(new InsertPages(plan.pages, targetCtx.doc.pages.length));
		// v7: the moved pages' bookmarks (new page ids) in the same undo step and the same save.
		if (plan.bookmarks.length > 0) {
			const before = targetCtx.doc.meta ?? cloneMeta(DEFAULT_META);
			commands.push(new SetMeta(before, withMovedBookmarks(before, plan.bookmarks)));
		}
		targetCtx.execute(new Batch("Move pages in", commands));
		// flush() is also false when the user kept writing in the destination after the pages were saved: the file decides.
		const flushed = await targetCtx.flush();
		const verdict = destinationVerdict(flushed, await storedInFile(app, target, plan.pages.map((p) => p.id)));
		if (verdict !== "ok") throw new Error(t(verdict === "not-saved" ? "move.targetNotSaved" : "move.targetNotStored"));
	} else {
		await appendToFile(app, target, targetDoc, before, ready, settings);
	}

	// The target has them on disk. Only now may they leave the source, and only those still as they were copied.
	let removed = 0;
	let stayed = plan.moved.length;
	if (src.alive()) {
		const removal = planSourceRemoval(src.doc, plan.moved);
		if (removal.remove.length > 0) {
			const pages = src.doc.pages;
			const commands: Command[] = [];
			if (removal.replacement) commands.push(new AddPage(removal.replacement, pages.length));
			const going = removal.remove.map((page) => ({ page, index: pages.indexOf(page) })).sort((a, b) => b.index - a.index);
			for (const g of going) commands.push(new DeletePage(g.page, g.index));
			src.execute(new Batch("Move pages out", commands), Math.max(0, Math.min(src.currentPage(), pages.length - 1)));
			removed = removal.remove.length;
		}
		stayed = removal.changed.length;
	}
	return { moved: plan.pages.length, removed, stayed, targetName: target.basename };
}

/** "Move to notebook…": asks which pages and where, moves them and reports. `preselect` = indices of the pages ticked at first. */
export async function runMovePages(src: EditContext, settings: NotebookSettings, preselect: readonly number[]): Promise<void> {
	const pages = src.doc.pages;
	const items = pages.map((p, i) => ({ id: p.id, number: i + 1, excerpt: pageExcerpt(p) }));
	const preselected = preselect.map((i) => pages[i]?.id).filter((id): id is string => !!id);
	const answer = await askMovePages(src.app, items, preselected, moveTargets(src.app, settings, src.file));
	if (!answer || !src.alive()) return;
	try {
		const out = await movePagesTo(src, answer.pageIds, answer.target, settings);
		const vars = { n: String(out.moved), name: out.targetName, kept: String(out.stayed) };
		showNotice(t(out.stayed > 0 ? "move.doneKept" : "move.done", vars), 8000);
	} catch (e) {
		console.error("[notebook] move pages", e);
		showNotice(t("move.failed", { error: e instanceof Error ? e.message : String(e) }), 10000);
	}
}
