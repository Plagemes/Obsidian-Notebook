import { normalizePath, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { isNotebookFile, NOTEBOOK_EXTENSIONS } from "../storage/format";
import { listNotebooks } from "../storage/notebooks";
import { NotebookView, VIEW_TYPE } from "../view/notebook-view";
import { candidatePaths, type EmbedTarget } from "./links";

function leafFile(leaf: WorkspaceLeaf): string | undefined {
	const state = leaf.getViewState().state as { file?: unknown } | undefined;
	return typeof state?.file === "string" ? state.file : undefined;
}

/**
 * Opens a notebook, focusing the tab that already shows it, and asks the view to go to `page`
 * (1-based) through the view state `{ page }`: `NotebookView.setState` reads it.
 */
export async function openNotebookAtPage(app: App, file: TFile, page: number | null): Promise<void> {
	const { workspace } = app;
	const open = workspace.getLeavesOfType(VIEW_TYPE).find((leaf) => leafFile(leaf) === file.path);
	if (open) {
		if (page !== null) {
			const state = open.getViewState().state ?? {};
			await open.setViewState({ type: VIEW_TYPE, state: { ...state, file: file.path, page }, active: true });
		}
		await workspace.revealLeaf(open);
		return;
	}
	await workspace.getLeaf("tab").openFile(file, { active: true, state: page !== null ? { page } : undefined });
}

/** Notebook views currently showing `file`. */
export function viewsOf(app: App, file: TFile): Array<{ leaf: WorkspaceLeaf; view: NotebookView }> {
	const out: Array<{ leaf: WorkspaceLeaf; view: NotebookView }> = [];
	for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE)) {
		if (leaf.view instanceof NotebookView && leaf.view.file?.path === file.path) out.push({ leaf, view: leaf.view });
	}
	return out;
}

/**
 * Finds the notebook a path or link refers to. A path is tried as written and with each notebook
 * extension; a link goes through Obsidian's link resolution; both fall back to a search by name
 * in the notebooks folder (so a moved notebook is still found).
 */
export function resolveNotebookFile(app: App, target: EmbedTarget, sourcePath: string, folder: string): TFile | null {
	const good = (f: TFile | null): f is TFile => f !== null && isNotebookFile(f);
	if (target.kind === "path") {
		for (const p of candidatePaths(target.value, NOTEBOOK_EXTENSIONS)) {
			const f = app.vault.getFileByPath(normalizePath(p));
			if (good(f)) return f;
		}
	}
	for (const c of candidatePaths(target.value, NOTEBOOK_EXTENSIONS)) {
		const f = app.metadataCache.getFirstLinkpathDest(c, sourcePath);
		if (good(f)) return f;
	}
	const wanted = (target.value.split("/").pop() ?? "").toLowerCase();
	if (!wanted) return null;
	return listNotebooks(app, folder).find((f) => f.name.toLowerCase() === wanted || f.basename.toLowerCase() === wanted) ?? null;
}
