/**
 * 0.16 (roadmap #177): runs an edit of the plugin API (`Prepare`) on a notebook that is open (through its view: one undo
 * step, saved by its session) or closed (parse, apply, re-validate, back up, write only if the file still holds what was
 * read, read back). Nothing is written unless the change is found again when the file is read back.
 */
import { type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { Batch } from "../model/history";
import { lockedPageIds } from "../model/page-lock";
import { parse } from "../model/serialize";
import type { Asset } from "../model/types";
import { KeyedQueue, planClosedEdit, type Prepare } from "../integration/api-plan";
import { NotebookApiError } from "../integration/api-errors";
import { backupFolder, type NotebookSettings } from "../settings";
import { readNotebookText, writeNotebookText } from "../storage/format";
import { VaultDocumentIO } from "../storage/vault-io";
import { isEditContextSource, type EditContext } from "../view/edit-context";

const NOTEBOOK_VIEW_TYPE = "notebook-view";
const queue = new KeyedQueue();

/** Open, editable view of `file`; "busy" when it is open but cannot be edited right now; null when it is not open. */
function openContext(app: App, file: TFile): EditContext | "busy" | null {
	for (const leaf of app.workspace.getLeavesOfType(NOTEBOOK_VIEW_TYPE)) {
		const view: unknown = leaf.view;
		if (!isEditContextSource(view) || view.file?.path !== file.path) continue;
		return view.editContext() ?? "busy";
	}
	return null;
}

/**
 * `make` gets the index of the page in view when the notebook is open (null when it is closed) and returns the edit.
 * Resolves with the edit's result; throws, leaving the notebook as it was, on any doubt.
 */
export function editNotebook<R>(
	app: App, settings: NotebookSettings, file: TFile, make: (pageInView: number | null) => Prepare<R>, label: string, pending?: Asset,
): Promise<R> {
	return queue.run(file.path, async () => {
		const ctx = openContext(app, file);
		if (ctx === "busy") throw new Error(t("move.targetBusy"));
		try {
			if (ctx) return await editOpen(app, file, ctx, make(ctx.currentPage()), label, pending);
			return await editClosed(app, settings, file, make(null));
		} catch (e) {
			// A locked page (open notebook: the history refused it; closed: the plan did) is one message, in the user's language.
			if (e instanceof NotebookApiError && e.code === "page-locked") throw new NotebookApiError("page-locked", t("si.locked", { name: file.basename }), e.details);
			throw e;
		}
	});
}

async function editOpen<R>(app: App, file: TFile, ctx: EditContext, prepare: Prepare<R>, label: string, pending?: Asset): Promise<R> {
	if (pending) ctx.addPending(pending);
	try {
		const plan = prepare(ctx.doc);
		if (!ctx.execute(new Batch(label, plan.commands))) {
			// Refused by the history: a locked page keeps its content (the view has already said so), or the notebook is read-only.
			const locked = lockedPageIds(ctx.doc);
			if (locked.length > 0) throw new NotebookApiError("page-locked", "locked pages", { path: file.path, ids: locked });
			throw new Error(t("move.targetBusy"));
		}
		const flushed = await ctx.flush();
		const back = parse(readNotebookText(file.extension, await app.vault.read(file)));
		if (back.ok && plan.verify(back.doc)) return plan.result;
		throw new Error(flushed
			? `The change is in the open notebook but was not found in the saved file "${file.path}".`
			: `The change is in the open notebook (undo reverts it) but could not be saved yet; "${file.path}" will be saved when possible.`);
	} finally {
		if (pending) ctx.removePending(pending.id);
	}
}

async function editClosed<R>(app: App, settings: NotebookSettings, file: TFile, prepare: Prepare<R>): Promise<R> {
	const ext = file.extension;
	for (let attempt = 0; attempt < 2; attempt++) {
		const before = readNotebookText(ext, await app.vault.read(file));
		const plan = planClosedEdit(before, prepare, new Date());
		if (!plan.ok) throw plan.error;
		const io = new VaultDocumentIO(app, file, () => backupFolder(settings));
		await io.backup(before, "before-api");
		let stale = false;
		await app.vault.process(file, (current) => {
			if (readNotebookText(ext, current) !== before) {
				stale = true;
				return current;
			}
			return writeNotebookText(ext, plan.text, current);
		});
		if (stale) continue;
		if (!plan.verify(await io.read())) {
			throw new Error(`The change was written to "${file.path}" but was not found when reading it back. The previous version is in the backup folder.`);
		}
		return plan.result;
	}
	throw new Error(t("host.changedElsewhere"));
}
