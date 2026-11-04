/**
 * What the Storage manager does after the user confirms (roadmap #128). The Obsidian side: every function re-checks what it
 * is about to touch, because minutes can pass between the scan and the tap.
 *
 * The rules, in one place:
 * - **Nothing is deleted by this code.** Unused and duplicate asset files are renamed into `<notebooks folder>/_trash/assets/` (a move
 *   inside the vault, as the library check does it: a sync service sees a move, and putting a file back is a move back).
 *   Backups go through `app.fileManager.trashFile` (the same call that prunes version history), which follows the user's
 *   "Deleted files" setting of Obsidian: the system trash, Obsidian's `.trash`, or a **permanent delete** (the confirmation says
 *   so). A conflicted copy goes through the library trash (`_trash/items/`, restorable from the Trash).
 * - **No notebook is edited that cannot be edited safely.** An open notebook is changed only through its view's `EditContext`
 *   (one undo step, saved by its own session, so what is not saved yet is part of the change, not overwritten by it); one that
 *   is open but gives no context (read-only, loading, a stroke in progress) is skipped. A closed notebook is rewritten only
 *   after a backup copy, from text that passed the save check, only if the file still holds what was read, and the result is
 *   read back. A notebook that does not parse is never written, and neither is one with edits waiting in the instant-save
 *   journal (they were never saved to its file; rewriting it would orphan them).
 * - **Pointing at another picture never removes the old one.** The old file stays in `_assets/` (undo, backups and other
 *   notebooks may still name it); once nothing names it, the library check offers it as an unused file.
 */
import { normalizePath, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { assetUses, repointInText, useCount, planAssetRepoint } from "../model/asset-ops";
import { parse } from "../model/serialize";
import type { Asset } from "../model/types";
import { sha256Hex } from "../pdf/hash";
import { storeAsset } from "../view/media";
import { backupFolder, type NotebookSettings } from "../settings";
import { readNotebookText, writeNotebookText } from "../storage/format";
import { parseBackupName } from "../storage/storage-backups";
import { parseSnapshotName, quickDocId } from "../storage/history";
import { sameNotebookText } from "../storage/conflicts";
import { ensureFolder, VaultDocumentIO } from "../storage/vault-io";
import { isEditContextSource, type EditContext } from "../view/edit-context";
import { assetTrashPath, isAssetFilePath, type AssetFile } from "./library-check";
import type { JournalReader } from "./library-check-live";
import type { ConflictCopy, OldBackup } from "../storage/storage-backups";
import type { DuplicateGroup, HeavyImage } from "./storage-scan";
import { downscaleImage } from "./storage-image";
import { canDownscale } from "./storage-image-logic";

const NOTEBOOK_VIEW_TYPE = "notebook-view";

export interface StorageEnv {
	app: App;
	settings: () => NotebookSettings;
	/** Moves a notebook to the library trash (restorable). */
	trashNotebook(file: TFile): Promise<unknown>;
	/**
	 * The instant-save journal (where its files are). A closed notebook with an entry there still has edits that were never
	 * saved: rewriting its file would make the entry's base not match any more, and on the next open those edits would go to
	 * a backup and be dropped from the notebook. Without it, no journal is looked at.
	 */
	journal?: { reader: Pick<JournalReader, "exists" | "list">; folder: string };
}

/**
 * Whether the closed notebook with document id `docId` has a journal entry waiting. Anything that cannot be listed counts as
 * "yes": better to leave a notebook alone than to take its unsaved edits away.
 */
export async function hasPendingJournal(env: StorageEnv, docId: string | null): Promise<boolean> {
	const journal = env.journal;
	if (!journal) return false;
	try {
		if (!(await journal.reader.exists(journal.folder))) return false;
		if (docId === null) return true;
		const key = docId.replace(/[^A-Za-z0-9_-]/g, "_");
		return (await journal.reader.list(journal.folder)).some((p) => {
			const name = p.slice(p.lastIndexOf("/") + 1);
			return name.endsWith(".journal") && name.split(".")[0] === key;
		});
	} catch {
		return true;
	}
}

/** Open, editable view of `file`; "busy" when a view shows it but hands out no context; null when it is not open. */
export function openContext(app: App, file: TFile): EditContext | "busy" | null {
	for (const leaf of app.workspace.getLeavesOfType(NOTEBOOK_VIEW_TYPE)) {
		const view: unknown = leaf.view;
		if (!isEditContextSource(view) || view.file?.path !== file.path) continue;
		return view.editContext() ?? "busy";
	}
	return null;
}

/** Whether any notebook view shows the file (a tab that is still loading counts). */
export function isOpen(app: App, path: string): boolean {
	return app.workspace.getLeavesOfType(NOTEBOOK_VIEW_TYPE).some((leaf) => {
		const view: unknown = leaf.view;
		return typeof view === "object" && view !== null && (view as { file?: { path?: string } }).file?.path === path;
	});
}

// ------------------------------------------------------------------ pointing notebooks at another picture

export interface RepointOutcome {
	/** Notebooks now using the new picture. */
	updated: string[];
	/** Open notebooks among them (one undo step each). */
	openUpdated: string[];
	/** Open notebooks among those whose change is applied but could not be saved yet: their own session saves it later. */
	unsaved: string[];
	/** Notebooks that did not use the old picture any more. */
	unchanged: string[];
	/** Left alone, and why. */
	skipped: Array<{ path: string; reason: "busy" | "missing" | "unreadable" | "changed" }>;
	failed: Array<{ path: string; error: string }>;
}

/**
 * Makes the notebooks `paths` use `to` instead of image asset `fromId`. One failure never stops the others: every notebook
 * ends up either on the new picture or untouched, and the old file is still there for the ones left behind.
 */
export async function repointAsset(env: StorageEnv, fromId: string, to: Asset, paths: readonly string[]): Promise<RepointOutcome> {
	const out: RepointOutcome = { updated: [], openUpdated: [], unsaved: [], unchanged: [], skipped: [], failed: [] };
	for (const path of paths) {
		const file = env.app.vault.getFileByPath(path);
		if (!file) {
			out.skipped.push({ path, reason: "missing" });
			continue;
		}
		try {
			const ctx = openContext(env.app, file);
			if (ctx === "busy") out.skipped.push({ path, reason: "busy" });
			else if (ctx) await repointOpen(ctx, fromId, to, path, out);
			else await repointClosed(env, file, fromId, to, out);
		} catch (e) {
			console.error("[notebook] storage: could not point", path, "at the new picture", e);
			out.failed.push({ path, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}

async function repointOpen(ctx: EditContext, fromId: string, to: Asset, path: string, out: RepointOutcome): Promise<void> {
	const batch = planAssetRepoint(ctx.doc, fromId, to);
	if (!batch) {
		out.unchanged.push(path);
		return;
	}
	// Readable before the command that registers it runs (the view draws as soon as the command is applied).
	ctx.addPending(to);
	let saved = false;
	try {
		ctx.execute(batch);
		saved = await ctx.flush();
	} finally {
		// Applied, so the document itself names the new picture now; if the save did not go through, the view's session
		// saves it later (and the journal holds it meanwhile).
		ctx.removePending(to.id);
	}
	out.updated.push(path);
	out.openUpdated.push(path);
	if (!saved) out.unsaved.push(path);
}

async function repointClosed(env: StorageEnv, file: TFile, fromId: string, to: Asset, out: RepointOutcome): Promise<void> {
	const app = env.app;
	const before = readNotebookText(file.extension, await app.vault.read(file));
	const result = repointInText(before, fromId, to);
	if (!result.ok) {
		// Does not parse (or would not pass the save check): never written.
		out.skipped.push({ path: file.path, reason: "unreadable" });
		return;
	}
	if (result.text === null) {
		out.unchanged.push(file.path);
		return;
	}
	// A view may have opened it while the file was read: then it is the view's to change, not ours.
	if (isOpen(app, file.path)) {
		out.skipped.push({ path: file.path, reason: "busy" });
		return;
	}
	// Edits waiting in the instant-save journal were never saved to this file: rewriting it would orphan them.
	if (await hasPendingJournal(env, quickDocId(before))) {
		out.skipped.push({ path: file.path, reason: "busy" });
		return;
	}
	const text = result.text;
	await new VaultDocumentIO(app, file, () => backupFolder(env.settings())).backup(before, "before-move");
	let stale = false;
	await app.vault.process(file, (current) => {
		if (readNotebookText(file.extension, current) !== before) {
			stale = true;
			return current;
		}
		return writeNotebookText(file.extension, text, current);
	});
	if (stale) {
		out.skipped.push({ path: file.path, reason: "changed" });
		return;
	}
	const back = parse(readNotebookText(file.extension, await app.vault.read(file)));
	if (!back.ok || useCount(assetUses(back.doc, to.id)) === 0) throw new Error(t("storage.error.verify"));
	out.updated.push(file.path);
}

// ------------------------------------------------------------------ downscale

export type DownscaleOutcome =
	| { ok: true; saved: number; from: number; to: number; asset: Asset; repoint: RepointOutcome }
	| { ok: false; reason: "no-gain" | "cannot-decode" | "unreadable-file" | "not-editable" | "unsupported" };

/**
 * Writes a smaller copy of an image asset and points every readable notebook that uses it at the copy. The original stays in
 * `_assets/`: undo (open notebooks), backups and any notebook that could not be changed may still name it. Returns without
 * writing anything when the copy would not be clearly smaller, or when no notebook can be changed right now.
 */
export async function downscaleHeavy(env: StorageEnv, heavy: HeavyImage): Promise<DownscaleOutcome> {
	const app = env.app;
	if (!canDownscale(heavy.file.path)) return { ok: false, reason: "unsupported" };
	const original = app.vault.getFileByPath(heavy.file.path);
	if (!original || original.stat.size !== heavy.file.size) return { ok: false, reason: "unreadable-file" };
	// Before any file is written: at least one notebook has to be changeable now.
	const editable = heavy.users.filter((p) => {
		const f = app.vault.getFileByPath(p);
		return !!f && openContext(app, f) !== "busy";
	});
	if (editable.length === 0) return { ok: false, reason: "not-editable" };
	let bytes: ArrayBuffer;
	try {
		bytes = await app.vault.readBinary(original);
	} catch {
		return { ok: false, reason: "unreadable-file" };
	}
	const smaller = await downscaleImage(bytes, original.name);
	if (!smaller.ok) return { ok: false, reason: smaller.reason };
	const asset = await storeAsset(app, env.settings().folder, smaller.image.bytes, smaller.image.name, "image");
	if (asset.id === heavy.file.id) return { ok: false, reason: "no-gain" };
	const repoint = await repointAsset(env, heavy.file.id, asset, editable);
	return { ok: true, saved: heavy.file.size - asset.bytes, from: heavy.file.size, to: asset.bytes, asset, repoint };
}

// ------------------------------------------------------------------ duplicates

export interface MergeOutcome {
	/** Extra copies of the same picture moved to `_trash/assets/`. */
	moved: AssetFile[];
	/** Notebooks pointed at the file that stays. */
	repoint: RepointOutcome;
	/** Copies left alone (changed since the scan, or no longer identical). */
	skipped: string[];
	failed: Array<{ path: string; error: string }>;
}

async function sameContent(app: App, a: TFile, b: TFile): Promise<boolean> {
	if (a.stat.size !== b.stat.size) return false;
	return (await sha256Hex(await app.vault.readBinary(a))) === (await sha256Hex(await app.vault.readBinary(b)));
}

/** Moves one asset file into `_trash/assets/` (a rename inside the vault). */
async function moveAside(app: App, root: string, file: TFile): Promise<string> {
	const taken = new Set(app.vault.getFiles().map((f) => f.path));
	const to = assetTrashPath(root, file, taken);
	await ensureFolder(app, to.slice(0, to.lastIndexOf("/")));
	await app.vault.rename(file, to);
	return to;
}

/**
 * Merges one group of identical pictures. A copy stored twice under another extension (same id) is moved aside after the two
 * files are compared again, byte for byte: every notebook finds the one that stays by the id. A copy under another id has its
 * notebooks pointed at the one that stays; the copy itself is left for the unused files.
 */
export async function mergeDuplicates(env: StorageEnv, group: DuplicateGroup, root: string): Promise<MergeOutcome> {
	const app = env.app;
	const out: MergeOutcome = { moved: [], repoint: { updated: [], openUpdated: [], unsaved: [], unchanged: [], skipped: [], failed: [] }, skipped: [], failed: [] };
	const keep = app.vault.getFileByPath(group.keep.path);
	if (!keep || keep.stat.size !== group.keep.size) {
		out.skipped.push(...group.extras.map((e) => e.file.path));
		return out;
	}
	const record: Asset = { id: group.keep.id, kind: "image", path: group.keep.path, name: group.keep.path.slice(group.keep.path.lastIndexOf("/") + 1), bytes: group.keep.size };
	for (const extra of group.extras) {
		const file = app.vault.getFileByPath(extra.file.path);
		try {
			if (!file || !isAssetFilePath(file.path, root) || !(await sameContent(app, file, keep))) {
				out.skipped.push(extra.file.path);
				continue;
			}
			if (extra.kind === "same-id") {
				// Readers other than this version find the picture by the record's path (library covers, shared clips, devices
				// on 0.14 or older): while any notebook's record names this very file, moving it would leave them without it.
				if (await recordsNameFile(env, [...extra.users, ...extra.blocked, ...(extra.holders ?? [])], file.path)) {
					out.skipped.push(extra.file.path);
					continue;
				}
				await moveAside(app, root, file);
				out.moved.push(extra.file);
			} else {
				const r = await repointAsset(env, extra.file.id, record, extra.users);
				mergeOutcome(out.repoint, r);
			}
		} catch (e) {
			out.failed.push({ path: extra.file.path, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}

/**
 * Whether the asset record of any of the notebooks `paths` names `filePath`. What cannot be told (open but busy, does not
 * parse, cannot be read, or a journal entry may hold a newer record) counts as "yes".
 */
export async function recordsNameFile(env: StorageEnv, paths: readonly string[], filePath: string): Promise<boolean> {
	const names = (assets: Record<string, Asset> | undefined): boolean => Object.values(assets ?? {}).some((a) => a.path === filePath || normalizePath(a.path) === filePath);
	for (const path of paths) {
		const nb = env.app.vault.getFileByPath(path);
		if (!nb) continue;
		try {
			const ctx = openContext(env.app, nb);
			if (ctx === "busy") return true;
			if (ctx) {
				if (names(ctx.doc.assets)) return true;
				continue;
			}
			const text = readNotebookText(nb.extension, await env.app.vault.read(nb));
			if (await hasPendingJournal(env, quickDocId(text))) return true;
			const parsed = parse(text);
			if (!parsed.ok) return true;
			if (names(parsed.doc.assets)) return true;
		} catch {
			return true;
		}
	}
	return false;
}

function mergeOutcome(into: RepointOutcome, from: RepointOutcome): void {
	into.updated.push(...from.updated);
	into.openUpdated.push(...from.openUpdated);
	into.unsaved.push(...from.unsaved);
	into.unchanged.push(...from.unchanged);
	into.skipped.push(...from.skipped);
	into.failed.push(...from.failed);
}

// ------------------------------------------------------------------ backups and conflicted copies

export interface TrashOutcome {
	trashed: string[];
	skipped: string[];
	failed: Array<{ path: string; error: string }>;
}

/**
 * Backups to the trash, through `fileManager.trashFile`. Each is checked again first: still where it was, still the size that
 * was listed, still inside the backup folder and still named like a backup or a snapshot.
 */
export async function trashOldBackups(env: StorageEnv, items: readonly OldBackup[]): Promise<TrashOutcome> {
	const out: TrashOutcome = { trashed: [], skipped: [], failed: [] };
	const folder = normalizePath(backupFolder(env.settings()));
	for (const item of items) {
		const file = env.app.vault.getFileByPath(item.path);
		const name = item.path.slice(item.path.lastIndexOf("/") + 1);
		const named = item.kind === "backup" ? parseBackupName(name) !== null : parseSnapshotName(name) !== null;
		if (!file || file.stat.size !== item.size || !item.path.startsWith(`${folder}/`) || !named) {
			out.skipped.push(item.path);
			continue;
		}
		try {
			await env.app.fileManager.trashFile(file);
			out.trashed.push(item.path);
		} catch (e) {
			out.failed.push({ path: item.path, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}

/**
 * Conflicted copies to the library trash (restorable from the Trash). Each copy and its main notebook are read again and
 * compared first; a copy that is open in a view, differs from its main notebook now, or whose main notebook is gone is left
 * alone.
 */
export async function trashConflictCopies(env: StorageEnv, items: readonly ConflictCopy[]): Promise<TrashOutcome> {
	const out: TrashOutcome = { trashed: [], skipped: [], failed: [] };
	for (const item of items) {
		const copy = env.app.vault.getFileByPath(item.path);
		const main = env.app.vault.getFileByPath(item.main);
		if (!copy || !main || isOpen(env.app, copy.path)) {
			out.skipped.push(item.path);
			continue;
		}
		try {
			const [a, b] = [readNotebookText(copy.extension, await env.app.vault.read(copy)), readNotebookText(main.extension, await env.app.vault.read(main))];
			const idA = quickDocId(a);
			if (idA === null || idA !== quickDocId(b) || !sameNotebookText(a, b)) {
				out.skipped.push(item.path);
				continue;
			}
			await env.trashNotebook(copy);
			out.trashed.push(item.path);
		} catch (e) {
			out.failed.push({ path: item.path, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}
