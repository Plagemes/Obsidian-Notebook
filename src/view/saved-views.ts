// Saved views (0.23, #264), the view side: capture what is in view, save / rename / update / reorder / remove through the history (one
// undo step each) and recall one. The dialog is saved-views-modal.ts; the format and the pure rules are model/views.ts.
import type { App } from "obsidian";
import { t } from "../i18n";
import type { ViewRegion } from "../ink/view-region";
import type { Command } from "../model/history";
import { VIEWS_MAX, type NotebookDocument, type SavedView } from "../model/types";
import {
	isUsableViewPage, makeView, setViews, uniqueViewName, viewsOf, withViewAdded, withViewMoved, withViewRemoved, withViewRenamed, withViewReplaced,
} from "../model/views";
import { showNotice } from "./notice";
import { findView, viewRows, zoomPercent, type ViewRow } from "./saved-views-logic";
import { SavedViewsModal, type SavedViewsApi } from "./saved-views-modal";

/** What the tools need from the notebook view. */
export interface SavedViewsHost {
	app: App;
	/** The document to read (the complete one, or the part read so far), or null. */
	doc(): NotebookDocument | null;
	/** The document can be edited (not read-only mode, not loading). */
	editable(): boolean;
	/** Runs a command as one undo step; false when the history refused it (it says why itself). */
	execute(cmd: Command): boolean;
	/** The region in view now with the id of the page the middle of the view is on, or null while there is nothing to measure. */
	capture(): { pageId: string; region: ViewRegion } | null;
	/** Shows a page region (the middle of it in the middle of the view, at its zoom). */
	show(pageIndex: number, region: Omit<ViewRegion, "pageIndex">): void;
}

export class SavedViewTools implements SavedViewsApi {
	constructor(private readonly host: SavedViewsHost) {}

	/** The dialog; `save` puts the focus in the name field and closes it once the view is saved (the "Save current view" command). */
	open(save = false): void {
		if (!this.host.doc()) return;
		new SavedViewsModal(this.host.app, this, { save }).open();
	}

	rows(): ViewRow[] {
		const doc = this.host.doc();
		return doc ? viewRows(doc) : [];
	}

	canEdit(): boolean {
		return this.host.editable();
	}

	current(): { page: number; zoom: number } | null {
		const doc = this.host.doc();
		const cap = this.host.capture();
		if (!doc || !cap) return null;
		return { page: cap.region.pageIndex + 1, zoom: zoomPercent(cap.region.zoom) };
	}

	suggestedName(): string {
		const doc = this.host.doc();
		const views = doc ? viewsOf(doc) : [];
		return uniqueViewName(views, t("views.defaultName", { n: String(views.length + 1) }));
	}

	save(name: string): boolean {
		const doc = this.edit();
		if (!doc) return false;
		const views = viewsOf(doc);
		if (views.length >= VIEWS_MAX) {
			showNotice(t("views.notice.full", { max: String(VIEWS_MAX) }), 6000);
			return false;
		}
		const cap = this.host.capture();
		const made = cap ? makeView({ name, page: cap.pageId, x: cap.region.x, y: cap.region.y, width: cap.region.width, height: cap.region.height, zoom: cap.region.zoom }, new Set(views.map((v) => v.id))) : null;
		if (!made) {
			showNotice(t("views.notice.failed"), 5000);
			return false;
		}
		if (!this.run(doc, withViewAdded(views, made), "Save view")) return false;
		showNotice(t("views.notice.saved", { name: made.name }), 3000);
		return true;
	}

	rename(id: string, name: string): boolean {
		return this.change(id, (views) => withViewRenamed(views, id, name), "Rename view");
	}

	update(id: string): boolean {
		const cap = this.host.capture();
		if (!cap) return false;
		if (!isUsableViewPage(cap.pageId)) {
			showNotice(t("views.notice.failed"), 5000);
			return false;
		}
		const place ={ page: cap.pageId, x: cap.region.x, y: cap.region.y, width: cap.region.width, height: cap.region.height, zoom: cap.region.zoom };
		const doc = this.host.doc();
		const name = doc ? findView(doc, id)?.name : undefined;
		if (!this.change(id, (views) => withViewReplaced(views, id, place), "Update view")) return false;
		if (name) showNotice(t("views.notice.updated", { name }), 3000);
		return true;
	}

	move(id: string, by: -1 | 1): boolean {
		return this.change(id, (views) => {
			const at = views.findIndex((v) => v.id === id);
			return at < 0 ? views : withViewMoved(views, id, at + by);
		}, "Move view");
	}

	remove(id: string): boolean {
		const doc = this.host.doc();
		const name = doc ? findView(doc, id)?.name : undefined;
		if (!this.change(id, (views) => withViewRemoved(views, id), "Delete view")) return false;
		if (name) showNotice(t("views.notice.removed", { name }), 4000);
		return true;
	}

	go(id: string): boolean {
		const doc = this.host.doc();
		const view = doc ? findView(doc, id) : null;
		if (!doc || !view) return false;
		const index = doc.pages.findIndex((p) => p.id === view.page);
		if (index < 0) {
			showNotice(t("views.notice.missing"), 5000);
			return false;
		}
		this.host.show(index, view);
		return true;
	}

	/** The document, when the notebook can be changed; else says so. */
	private edit(): NotebookDocument | null {
		const doc = this.host.doc();
		if (!doc || !this.host.editable()) {
			showNotice(t("views.notice.readOnly"), 5000);
			return null;
		}
		return doc;
	}

	/** Replaces the list with what `next` makes of it, as one undo step. False when nothing changed or the history refused it. */
	private change(id: string, next: (views: readonly SavedView[]) => readonly SavedView[], label: string): boolean {
		const doc = this.edit();
		if (!doc || !findView(doc, id)) return false;
		return this.run(doc, next(viewsOf(doc)), label);
	}

	private run(doc: NotebookDocument, next: readonly SavedView[], label: string): boolean {
		const cmd = setViews(doc, next, label);
		return cmd !== null && this.host.execute(cmd);
	}
}
