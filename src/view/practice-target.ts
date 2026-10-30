/**
 * Where practice copies go when they do not stay in the notebook they came from, and how a notebook is found again by its
 * document id (the sidecar of practice.json refers to notebooks by id, with the path as a hint). Obsidian side of the
 * practice feature; the rules are in model/practice.ts.
 */
import { normalizePath, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { createDocument } from "../model/document";
import { AddAsset, Batch, InsertPages, type Command } from "../model/history";
import { exercisesName } from "../model/practice";
import { parse, serializeChecked } from "../model/serialize";
import type { Asset, NotebookDocument, Page } from "../model/types";
import { holdsPages, pageAssetIds } from "../library/page-move";
import { backupFolder, type NotebookSettings } from "../settings";
import { isNotebookFile, readNotebookText, writeNotebookText } from "../storage/format";
import { quickDocId } from "../storage/history";
import { createNotebook, listNotebooks } from "../storage/notebooks";
import { VaultDocumentIO } from "../storage/vault-io";
import { isEditContextSource, type EditContext } from "./edit-context";

const NOTEBOOK_VIEW_TYPE = "notebook-view";

/** Open, editable view of `file`; "busy" when it is open but cannot take an edit right now; null when it is not open. */
function openEditContext(app: App, file: TFile): EditContext | "busy" | null {
	for (const leaf of app.workspace.getLeavesOfType(NOTEBOOK_VIEW_TYPE)) {
		const view: unknown = leaf.view;
		if (!isEditContextSource(view) || view.file?.path !== file.path) continue;
		return view.editContext() ?? "busy";
	}
	return null;
}

/** The notebook with this name (case-insensitive) in the notebooks folder, or null. */
export function findExercisesNotebook(app: App, folder: string, name: string): TFile | null {
	const wanted = exercisesName(name).toLowerCase();
	return listNotebooks(app, folder).find((f) => f.basename.toLowerCase() === wanted) ?? null;
}

/** The notebook with document id `doc`: the hinted path first, then a search of the notebooks folder. Null when none has it. */
export async function findNotebookByDocId(app: App, folder: string, ref: { doc: string; path?: string }): Promise<TFile | null> {
	const has = async (file: TFile): Promise<boolean> => {
		try {
			return quickDocId(readNotebookText(file.extension, await app.vault.cachedRead(file))) === ref.doc;
		} catch {
			return false;
		}
	};
	if (ref.path) {
		const hinted = app.vault.getFileByPath(normalizePath(ref.path));
		if (hinted && isNotebookFile(hinted) && (await has(hinted))) return hinted;
	}
	for (const file of listNotebooks(app, folder)) if (await has(file)) return file;
	return null;
}

/** Records of the assets `page` uses that `have` does not hold yet; throws when the source does not know one. */
function missingAssets(page: Page, source: NotebookDocument, have: NotebookDocument["assets"]): Asset[] {
	const out: Asset[] = [];
	for (const id of pageAssetIds(page)) {
		if (have && Object.prototype.hasOwnProperty.call(have, id)) continue;
		const record = source.assets?.[id];
		if (!record) throw new Error(t("move.missingAsset"));
		out.push({ ...record });
	}
	return out;
}

export interface StoredCopy {
	file: TFile;
	/** Index of the page in the notebook. */
	index: number;
	docId: string;
}

/**
 * Appends `page` to the exercises notebook called `name` (creating it in the notebooks folder when there is none) and
 * returns only once the page is in the file on disk. An open notebook takes it as one undo step and is saved; a closed one
 * is parsed, extended, re-validated, backed up and written only if it is still what was read, then read back. Throws on any
 * doubt, with the notebook as it was.
 */
export async function addCopyToExercises(
	app: App, settings: NotebookSettings, source: NotebookDocument, page: Page, name: string,
): Promise<StoredCopy> {
	const existing = findExercisesNotebook(app, settings.folder, name);
	if (!existing) {
		const doc = createDocument();
		doc.pages = [page];
		for (const asset of missingAssets(page, source, undefined)) (doc.assets ??= {})[asset.id] = asset;
		const file = await createNotebook(app, settings.folder, exercisesName(name), doc);
		if (!holdsPages(readNotebookText(file.extension, await app.vault.read(file)), [page.id])) throw new Error(t("move.verifyFailed"));
		return { file, index: 0, docId: doc.id };
	}

	const ctx = openEditContext(app, existing);
	if (ctx === "busy") throw new Error(t("move.targetBusy"));
	if (ctx) {
		const commands: Command[] = missingAssets(page, source, ctx.doc.assets).map((a) => new AddAsset(a));
		const index = ctx.doc.pages.length;
		commands.push(new InsertPages([page], index));
		ctx.execute(new Batch("Add practice page", commands));
		const flushed = await ctx.flush();
		let stored = false;
		try {
			stored = holdsPages(readNotebookText(existing.extension, await app.vault.read(existing)), [page.id]);
		} catch (e) {
			console.error("[notebook] practice: read back", e);
		}
		if (!stored) throw new Error(t(flushed ? "move.targetNotStored" : "move.targetNotSaved"));
		return { file: existing, index, docId: ctx.doc.id };
	}

	const before = readNotebookText(existing.extension, await app.vault.read(existing));
	const parsed = parse(before);
	if (!parsed.ok) throw new Error(t("move.targetUnreadable", { error: parsed.message }));
	const doc = parsed.doc;
	for (const asset of missingAssets(page, source, doc.assets)) (doc.assets ??= {})[asset.id] = asset;
	const index = doc.pages.length;
	doc.pages.push(page);
	doc.modifiedAt = new Date().toISOString();
	const checked = serializeChecked(doc, true);
	if (!checked.ok) throw new Error(checked.message);
	const io = new VaultDocumentIO(app, existing, () => backupFolder(settings));
	await io.backup(before, "before-move");
	let stale = false;
	await app.vault.process(existing, (current) => {
		if (readNotebookText(existing.extension, current) !== before) {
			stale = true;
			return current;
		}
		return writeNotebookText(existing.extension, checked.text, current);
	});
	if (stale) throw new Error(t("host.changedElsewhere"));
	if (!holdsPages(await io.read(), [page.id])) throw new Error(t("move.verifyFailed"));
	return { file: existing, index, docId: doc.id };
}
