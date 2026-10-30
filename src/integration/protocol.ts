import { type App, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { parseProtocolParams } from "./links";
import { resolveNotebookFile } from "./open";
import { showNotice } from "../view/notice";

export interface ProtocolDeps {
	app: App;
	folder: () => string;
	open: (file: TFile, page: number | null, pageId?: string | null) => void;
}

/** `obsidian://notebook?path=<vault path>&page=<n>&id=<page id>`: opens the notebook (focusing its tab) at that page (by id first). */
export function registerProtocol(plugin: Plugin, deps: ProtocolDeps): void {
	plugin.registerObsidianProtocolHandler("notebook", (params) => {
		const target = parseProtocolParams(params);
		if (!target.ok) {
			showNotice(t("link.invalid"));
			return;
		}
		const file = resolveNotebookFile(deps.app, { kind: "path", value: target.path }, "", deps.folder());
		if (!file) {
			showNotice(t("link.notFound", { path: target.path }));
			return;
		}
		deps.open(file, target.page, target.pageId);
	});
}
