// wave 0.9 (385): "Add page to Obsidian bookmarks". Says clearly when the core Bookmarks plugin is off or unavailable.
// The logic is in bookmark-logic.ts.
import type { App, TFile } from "obsidian";
import { t } from "../i18n";
import { showNotice } from "../view/notice";
import { bookmarksInstance, hasBookmark, pageBookmark } from "./bookmark-logic";

/** Adds page `page` (1-based) of the notebook to the Bookmarks pane; says what happened. */
export function addPageToObsidianBookmarks(app: App, file: TFile, page: number, pageId: string | null | undefined): void {
	const instance = bookmarksInstance(app);
	if (!instance) {
		showNotice(t("bookmarks.unavailable"));
		return;
	}
	const item = pageBookmark(file.path, page, pageId, t("share.linkAlias", { name: file.basename, page: String(page) }));
	if (hasBookmark(instance.items, item.path, item.subpath)) {
		showNotice(t("bookmarks.already", { name: item.title }));
		return;
	}
	try {
		instance.addItem(item);
		showNotice(t("bookmarks.added", { name: item.title }));
	} catch (e) {
		console.error("[notebook] adding an Obsidian bookmark failed", e);
		showNotice(t("bookmarks.failed", { error: e instanceof Error ? e.message : String(e) }));
	}
}
