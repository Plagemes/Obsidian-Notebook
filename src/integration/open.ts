import { normalizePath, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { isNotebookFile, NOTEBOOK_EXTENSIONS } from "../storage/format";
import { listNotebooks } from "../storage/notebooks";
import { NotebookView, VIEW_TYPE } from "../view/notebook-view";
import type { SavedPosition } from "../ink/view-position";
import { candidatePaths, type EmbedTarget } from "./links";

function leafFile(leaf: WorkspaceLeaf): string | undefined {
	const state = leaf.getViewState().state as { file?: unknown } | undefined;
	return typeof state?.file === "string" ? state.file : undefined;
}

/**
 * Opens a notebook, focusing the tab that already shows it, and asks the view to go to `page`
 * (1-based) through the view state `{ page }`: `NotebookView.setState` reads it. `view` (zoom and scroll position on
 * that page) is passed along when known. v10: `region` (page coordinates of the page `pageId`) is outlined once the page
 * is shown (the jump back from an anchored excerpt).
 */
export async function openNotebookAtPage(
	app: App, file: TFile, page: number | null, view: SavedPosition | null = null, pageId: string | null = null,
	region: { x: number; y: number; width: number; height: number } | null = null,
): Promise<void> {
	const { workspace } = app;
	const open = workspace.getLeavesOfType(VIEW_TYPE).find((leaf) => leafFile(leaf) === file.path);
	// wave 0.8 (388): `pageId` (a link made by the plugin) wins over the number; the view resolves it once the document is loaded.
	const wanted = page !== null || pageId !== null;
	if (open) {
		if (wanted) {
			const state = open.getViewState().state ?? {};
			await open.setViewState({
				type: VIEW_TYPE, active: true,
				state: { ...state, file: file.path, page: page ?? undefined, pageId: pageId ?? undefined, view: view ?? undefined, region: region ?? undefined },
			});
		}
		await workspace.revealLeaf(open);
		return;
	}
	await workspace.getLeaf("tab").openFile(file, {
		active: true, state: wanted ? { page: page ?? undefined, pageId: pageId ?? undefined, view: view ?? undefined, region: region ?? undefined } : undefined,
	});
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
