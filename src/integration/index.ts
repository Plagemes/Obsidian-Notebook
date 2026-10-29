import { TFile, type Plugin } from "obsidian";
import { t } from "../i18n";
import type { ThumbnailOptions } from "../library/thumbnail";
import type { NotebookDocument, Page } from "../model/types";
import type { NotebookSettings } from "../settings";
import { isNotebookFile } from "../storage/format";
import { whenIdle } from "../storage/idle";
import { registerCompanion } from "./companion";
import { registerEmbed } from "./embed";
import { registerFileMenu } from "./file-menu";
import { HistoryService } from "./history-service";
import { embedInsertText } from "./links";
import { registerNativeEmbed } from "./native-embed";
import { openNotebookAtPage } from "./open";
import { PageLinkSuggest } from "./page-link-suggest";
import { trackActiveNote } from "./page-share";
import { NotebookPickerModal } from "./picker";
import { registerProtocol } from "./protocol";

export { notebookUri } from "./links";

export interface IntegrationPlugin extends Plugin {
	settings: NotebookSettings;
}

export interface IntegrationDeps {
	/** Loads the PDF page or image behind a page, for embed previews. */
	background: (doc: NotebookDocument, page: Page, width: number) => Promise<ThumbnailOptions["drawBackground"] | null>;
	/** File explorer: asks for the details of a new notebook and creates it in this folder. */
	newNotebookIn: (folder: string) => void;
	/** File explorer: creates a notebook from a PDF of the vault and opens it. */
	annotatePdf: (pdf: TFile) => void;
}

/** Registers embeds, the `obsidian://notebook` link, version history and companion notes. Called once from onload. */
export function registerIntegration(plugin: IntegrationPlugin, deps: IntegrationDeps): void {
	const { app } = plugin;
	const folder = () => plugin.settings.folder;
	const open = (file: TFile, page: number | null) => void openNotebookAtPage(app, file, page);

	// #22 Embed a page in a Markdown note.
	registerEmbed(plugin, { app, folder, background: deps.background, open: (file, page) => open(file, page) });
	plugin.addCommand({
		id: "insert-embed",
		name: t("command.embedInsert"),
		editorCallback: (editor) => {
			new NotebookPickerModal(app, folder(), (file) => {
				editor.replaceSelection(embedInsertText(file.path, 1, editor.getCursor().ch === 0));
			}).open();
		},
	});

	// O6 `![[Notebook.notebook#p3]]`, O4 page suggestions, O9 file explorer menu, O20 insert into a note.
	registerNativeEmbed(plugin, { app, folder, background: deps.background, open: (file, page) => open(file, page) });
	plugin.registerEditorSuggest(new PageLinkSuggest(app));
	registerFileMenu(plugin, { newNotebookIn: deps.newNotebookIn, annotatePdf: deps.annotatePdf });
	trackActiveNote(plugin);

	// #58 obsidian://notebook?path=...&page=...
	registerProtocol(plugin, { app, folder, open });

	// #25 Version history.
	const history = new HistoryService(plugin);
	plugin.addCommand({ id: "restore-version", name: t("command.restore"), callback: () => history.start() });
	plugin.registerEvent(app.vault.on("modify", (f) => {
		if (f instanceof TFile && isNotebookFile(f)) void history.maybeSnapshot(f, new Date(), whenIdle);
	}));
	plugin.registerEvent(app.workspace.on("file-open", (f) => {
		if (f && isNotebookFile(f)) void history.maybeSnapshot(f, new Date(), whenIdle);
	}));

	// O1 Companion notes.
	registerCompanion(plugin);
}
