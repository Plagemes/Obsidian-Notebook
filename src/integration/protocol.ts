import { Notice, type App, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { parseProtocolParams } from "./links";
import { resolveNotebookFile } from "./open";

export interface ProtocolDeps {
	app: App;
	folder: () => string;
	open: (file: TFile, page: number | null) => void;
}

/** `obsidian://notebook?path=<vault path>&page=<n>`: opens the notebook (focusing its tab) at that page. */
export function registerProtocol(plugin: Plugin, deps: ProtocolDeps): void {
	plugin.registerObsidianProtocolHandler("notebook", (params) => {
		const target = parseProtocolParams(params);
		if (!target.ok) {
			new Notice(t("link.invalid"));
			return;
		}
		const file = resolveNotebookFile(deps.app, { kind: "path", value: target.path }, "", deps.folder());
		if (!file) {
			new Notice(t("link.notFound", { path: target.path }));
			return;
		}
		deps.open(file, target.page);
	});
}
