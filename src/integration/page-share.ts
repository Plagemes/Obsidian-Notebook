import { Notice, type App, type MarkdownView, type Menu, type Plugin, type TFile, type WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { insertionText, pageSubpath, withEmbedMarker } from "./page-links";

export type ShareMode = "link" | "embed";

/** Remembers the Markdown note the user was last in, so a notebook page can be inserted into it. */
let lastNoteLeaf: WorkspaceLeaf | null = null;

/** Checked by view type rather than `instanceof`, so this module needs nothing from Obsidian at load time but `Notice`. */
function isNoteLeaf(leaf: WorkspaceLeaf): boolean {
	return leaf.view.getViewType() === "markdown";
}

/** Tracks the last Markdown note that had focus. Called once from onload. */
export function trackActiveNote(plugin: Plugin): void {
	const { workspace } = plugin.app;
	const remember = (leaf: WorkspaceLeaf | null) => {
		if (leaf && isNoteLeaf(leaf)) lastNoteLeaf = leaf;
	};
	remember(workspace.getMostRecentLeaf());
	plugin.registerEvent(workspace.on("active-leaf-change", remember));
	plugin.register(() => {
		lastNoteLeaf = null;
	});
}

/** The note to insert into: the last one with focus if it is still open, else any open note. */
function targetNote(app: App): MarkdownView | null {
	const open = app.workspace.getLeavesOfType("markdown");
	const leaf = lastNoteLeaf && open.includes(lastNoteLeaf) ? lastNoteLeaf : open[0];
	return leaf && isNoteLeaf(leaf) ? (leaf.view as MarkdownView) : null;
}

/** The link or embed for a page, in the user's link style (wikilink or Markdown link). */
export function pageLinkText(app: App, file: TFile, page: number, mode: ShareMode): string {
	const source = targetNote(app)?.file?.path ?? "";
	const alias = mode === "link" ? t("share.linkAlias", { name: file.basename, page: String(page) }) : undefined;
	return withEmbedMarker(app.fileManager.generateMarkdownLink(file, source, pageSubpath(page), alias), mode === "embed");
}

export async function copyPageLink(app: App, file: TFile, page: number): Promise<void> {
	const link = pageLinkText(app, file, page, "link");
	try {
		await navigator.clipboard.writeText(link);
		new Notice(t("share.copied", { link }));
	} catch (e) {
		new Notice(t("share.copyFailed", { error: e instanceof Error ? e.message : String(e) }));
	}
}

/** Inserts a link or an embed of the page at the cursor of the active note. */
export function insertPageIntoNote(app: App, file: TFile, page: number, mode: ShareMode): void {
	const note = targetNote(app);
	if (!note?.file) {
		new Notice(t("share.noNote"));
		return;
	}
	if (note.getMode() !== "source") {
		new Notice(t("share.readingMode", { name: note.file.basename }));
		return;
	}
	const { editor } = note;
	const text = insertionText(pageLinkText(app, file, page, mode), mode === "embed", editor.getCursor().ch === 0);
	editor.replaceSelection(text);
	new Notice(t("share.inserted", { name: note.file.basename }));
}

/** Page menu entries: copy the link, insert a link, insert a preview. */
export function addPageShareItems(menu: Menu, app: App, file: TFile, page: number): void {
	menu.addItem((i) => i.setTitle(t("share.copyLink")).setIcon("link").onClick(() => void copyPageLink(app, file, page)));
	menu.addItem((i) => i.setTitle(t("share.insertLink")).setIcon("file-symlink").onClick(() => insertPageIntoNote(app, file, page, "link")));
	menu.addItem((i) => i.setTitle(t("share.insertEmbed")).setIcon("picture-in-picture").onClick(() => insertPageIntoNote(app, file, page, "embed")));
	menu.addSeparator();
}
