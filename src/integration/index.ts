import { TFile, type Plugin } from "obsidian";
import { t } from "../i18n";
import type { ThumbnailOptions } from "../library/thumbnail";
import type { NotebookDocument, Page } from "../model/types";
import type { NotebookSettings } from "../settings";
import { isNotebookFile } from "../storage/format";
import { whenIdle } from "../storage/idle";
import { registerEmbed } from "./embed";
import { HistoryService } from "./history-service";
import { embedInsertText } from "./links";
import { openNotebookAtPage } from "./open";
import { NotebookPickerModal } from "./picker";
import { registerProtocol } from "./protocol";

export { notebookUri } from "./links";

export interface IntegrationPlugin extends Plugin {
	settings: NotebookSettings;
}

export interface IntegrationDeps {
	/** Loads the PDF page or image behind a page, for embed previews. */
	background: (doc: NotebookDocument, page: Page, width: number) => Promise<ThumbnailOptions["drawBackground"] | null>;
}

/** Registers embeds, the `obsidian://notebook` link and version history. Called once from onload. */
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
}
