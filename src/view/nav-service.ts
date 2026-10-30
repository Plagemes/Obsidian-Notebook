import { type App, type Plugin, type TFile } from "obsidian";
import { openNotebookAtPage } from "../integration/open";
import type { NavPlace } from "../model/nav-history";
import type { NotebookDocument } from "../model/types";
import { mouseNavDirection, NavController } from "./nav-controller";
import { NotebookView, VIEW_TYPE } from "./notebook-view";

/** The notebook views that are open. */
function openViews(app: App): NotebookView[] {
	return app.workspace.getLeavesOfType(VIEW_TYPE)
		.map((leaf) => leaf.view)
		.filter((view): view is NotebookView => view instanceof NotebookView);
}

/**
 * Roadmap 18: the session's back/forward history of visited pages, across notebooks. The views record deliberate jumps
 * (`NotebookView.recordJump`); this wires the controller to the vault and the workspace, follows renames and
 * deletions, and (desktop) uses the mouse back/forward buttons while the pointer is over a notebook.
 */
export function registerNavigation(plugin: Plugin, readNotebook: (file: TFile) => Promise<NotebookDocument | null>): NavController {
	const app = plugin.app;
	const active = (): NotebookView | null => app.workspace.getActiveViewOfType(NotebookView);

	const nav = new NavController({
		here: () => active()?.navPlace() ?? null,
		exists: async (place) => {
			const file = app.vault.getFileByPath(place.path);
			if (!file) return false;
			const open = openViews(app).find((v) => v.file?.path === place.path && v.document !== null);
			if (open) return open.document!.pages.some((p) => p.id === place.pageId);
			const doc = await readNotebook(file);
			// An unreadable notebook keeps its entry: opening it shows its own explanation.
			return doc ? doc.pages.some((p) => p.id === place.pageId) : true;
		},
		open: async (place: NavPlace) => {
			const view = active();
			if (view?.file?.path === place.path && view.showPlace(place)) {
				nav.shown();
				return;
			}
			const file = app.vault.getFileByPath(place.path);
			if (file) await openNotebookAtPage(app, file, place.page, null, place.pageId);
		},
	});

	plugin.registerEvent(app.vault.on("rename", (f, oldPath) => nav.renamed(oldPath, f.path)));
	plugin.registerEvent(app.vault.on("delete", (f) => nav.removed(f.path)));
	plugin.registerEvent(app.workspace.on("active-leaf-change", () => nav.seen(active()?.navPlace() ?? null)));

	// Desktop: the side buttons of the mouse. Only while the pointer is over a notebook and there is somewhere to go;
	// otherwise the event is left to Obsidian (its own back/forward through the tabs).
	const side = (e: MouseEvent): -1 | 1 | 0 => {
		const dir = mouseNavDirection(e.button);
		if (dir === 0 || !(e.target as Element | null)?.closest?.(".notebook-view")) return 0;
		return (dir < 0 ? nav.canBack : nav.canForward) ? dir : 0;
	};
	plugin.registerDomEvent(document, "mouseup", (e) => {
		const dir = side(e);
		if (dir === 0) return;
		e.preventDefault();
		e.stopPropagation();
		void nav.go(dir);
	}, { capture: true });
	// The press and the auxiliary click are swallowed too, so nothing else reacts to the same button.
	for (const type of ["mousedown", "auxclick"] as const) {
		plugin.registerDomEvent(document, type, (e) => {
			if (side(e) === 0) return;
			e.preventDefault();
			e.stopPropagation();
		}, { capture: true });
	}
	return nav;
}
