/**
 * 0.20 reference window (#107): the ways to open the floating reference window from outside the notebook view: an "Open as
 * reference" item in the file menu, and the helper that finds the notebook view the window floats over and opens a file in it.
 */
import { TFile, type App, type Menu, type Plugin } from "obsidian";
import { t } from "../i18n";
import { pageTargetFromSubpath } from "../integration/page-links";
import { NotebookView, VIEW_TYPE } from "./notebook-view";
import { showNotice } from "./notice";
import { canShowAsReference } from "./ref-window-picker";

/** The notebook view a reference opens over: the active one, else a visible one. */
export function referenceHost(app: App): NotebookView | null {
	const active = app.workspace.getActiveViewOfType(NotebookView);
	if (active) return active;
	for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE)) {
		if (leaf.view instanceof NotebookView && leaf.view.containerEl.isShown()) return leaf.view;
	}
	return null;
}

/** Opens `file` (at the page a link subpath names, when it is a notebook) in the reference window of the notebook in view. */
export function openAsReference(app: App, file: TFile, subpath = ""): boolean {
	const view = referenceHost(app);
	if (!view) {
		showNotice(t("refwin.noNotebook"));
		return false;
	}
	const target = pageTargetFromSubpath(subpath);
	void view.openReference(file, { page: target?.page ?? null, pageId: target?.pageId ?? null });
	return true;
}

/** The "Open as reference" item of the file menu (file explorer, links): only while a notebook is open to float over. */
export function registerReferenceMenu(plugin: Plugin): void {
	plugin.registerEvent(plugin.app.workspace.on("file-menu", (menu: Menu, file) => {
		if (!(file instanceof TFile) || !canShowAsReference(file) || !referenceHost(plugin.app)) return;
		menu.addItem((item) => item.setTitle(t("refwin.openFile")).setIcon("picture-in-picture-2").setSection("open").onClick(() => void openAsReference(plugin.app, file)));
	}));
}
