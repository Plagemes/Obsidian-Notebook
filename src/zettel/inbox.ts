import type { App } from "obsidian";
import { InboxService, type InboxHost } from "./inbox-service";
import { INBOX_VIEW_TYPE, InboxView } from "./inbox-view";
import type { ZettelService } from "./service";

export { registerInboxSource } from "./inbox-items";
export type { InboxItem, InboxSource, InboxEnv, InboxNotebook } from "./inbox-items";

/** Registers the Inbox view (M15 Z4). Its commands are global actions of the registry (ui/actions.ts, main.ts). Called from `registerZettel`. */
export function registerInbox(plugin: InboxHost, zettel: ZettelService): InboxService {
	const service = new InboxService(plugin, zettel);
	plugin.registerView(INBOX_VIEW_TYPE, (leaf) => new InboxView(leaf, service, () => plugin.settings.zettelIdScheme === "luhmann"));

	return service;
}

/** Shows the Inbox in its tab (opening one if needed). Returns the view when it was already open, else null (a new one scans when it opens). */
export async function openInbox(app: App): Promise<InboxView | null> {
	const { workspace } = app;
	let leaf = workspace.getLeavesOfType(INBOX_VIEW_TYPE)[0];
	const existed = !!leaf;
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true });
	}
	await workspace.revealLeaf(leaf);
	return existed && leaf.view instanceof InboxView ? leaf.view : null;
}

/** Opens the Inbox and selects the first open item (a view that was already open scans again first). */
export async function processNextInbox(app: App): Promise<void> {
	await (await openInbox(app))?.startFromCommand();
}
