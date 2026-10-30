import { t } from "../i18n";
import { InboxService, type InboxHost } from "./inbox-service";
import { INBOX_VIEW_TYPE, InboxView } from "./inbox-view";
import type { ZettelService } from "./service";

export { registerInboxSource } from "./inbox-items";
export type { InboxItem, InboxSource, InboxEnv, InboxNotebook } from "./inbox-items";

/** Registers the Inbox (M15 Z4): the view and its two commands. Called from `registerZettel`. */
export function registerInbox(plugin: InboxHost, zettel: ZettelService): InboxService {
	const service = new InboxService(plugin, zettel);
	plugin.registerView(INBOX_VIEW_TYPE, (leaf) => new InboxView(leaf, service, () => plugin.settings.zettelIdScheme === "luhmann"));

	const open = async (): Promise<InboxView | null> => {
		const { workspace } = plugin.app;
		let leaf = workspace.getLeavesOfType(INBOX_VIEW_TYPE)[0];
		const existed = !!leaf;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		return existed && leaf.view instanceof InboxView ? leaf.view : null;
	};
	plugin.addCommand({ id: "zettel-inbox", name: t("inbox.command.open"), callback: () => void open() });
	plugin.addCommand({
		id: "zettel-inbox-process",
		name: t("inbox.command.process"),
		// A view that was already open scans again and starts at the first open item; a new one scans when it opens.
		callback: () => void open().then((view) => view?.startFromCommand()),
	});
	return service;
}
