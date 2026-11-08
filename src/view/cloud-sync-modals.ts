/**
 * 0.22 synccore (#126): the cloud sync's two questions, on the shared dialog shell (DESIGN.md §4): the mass-deletion guard
 * ("Delete N files?") and the large-file rule ("Sync N large files?"). Closing a dialog decides nothing: the next run asks again.
 */
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { formatBytes } from "../storage/sync-state";
import type { SyncResult } from "../sync/engine";
import { modalShell, shellButton, shellCheck, shellNote, shellSection } from "../ui/components/modal-shell";

/** Paths shown per list; the rest is counted. */
const SHOWN = 12;

function pathList(parent: HTMLElement, title: string, items: readonly { path: string; size?: number }[]): void {
	if (items.length === 0) return;
	const list = shellSection(parent, title, "nb-cloudsync-list");
	for (const item of items.slice(0, SHOWN)) {
		const row = list.createDiv({ cls: "nb-cloudsync-path" });
		row.createSpan({ cls: "nb-cloudsync-path-name", text: item.path });
		if (item.size !== undefined) row.createSpan({ cls: "nb-cloudsync-path-size", text: formatBytes(item.size) });
	}
	if (items.length > SHOWN) list.createDiv({ cls: "nb-cloudsync-more", text: t("cloudSync.deletes.more", { count: String(items.length - SHOWN) }) });
}

/** "Delete N files?": the deletions the guard held back. "Keep them" copies them back to the side that lost them. */
export class CloudDeletesModal extends Modal {
	private decided = false;

	constructor(app: App, private readonly items: SyncResult["heldDeletes"], private readonly decide: (choice: "delete" | "keep" | null) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, {
			title: t("cloudSync.deletes.title", { count: String(this.items.length) }), subtitle: t("cloudSync.deletes.subtitle"), icon: "trash-2", size: "medium", cls: "nb-cloudsync-modal",
		});
		pathList(shell.body, t("cloudSync.deletes.local"), this.items.filter((i) => i.side === "local"));
		pathList(shell.body, t("cloudSync.deletes.remote"), this.items.filter((i) => i.side === "remote"));
		shellNote(shell.body, t("cloudSync.deletes.note"));
		shellButton(shell.foot, "secondary", t("cloudSync.deletes.keep"), () => this.choose("keep"), { icon: "undo-2" });
		shellButton(shell.foot, "danger", t("cloudSync.deletes.delete"), () => this.choose("delete"), { icon: "trash-2" });
	}

	private choose(choice: "delete" | "keep"): void {
		this.decided = true;
		this.close();
		this.decide(choice);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) this.decide(null);
	}
}

/**
 * "Disconnect from Google Drive?": confirms the disconnection; for Google it offers to forget the client secret typed on this
 * device too (unchecked by default: signing in again later needs no typing). Closing it disconnects nothing.
 */
export class CloudDisconnectModal extends Modal {
	private forgetSecret = false;

	constructor(app: App, private readonly provider: string, private readonly hasSecret: boolean, private readonly decide: (o: { forgetSecret: boolean }) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, {
			title: t("cloudSync.disconnect.title", { provider: this.provider }), subtitle: t("cloudSync.disconnect.subtitle"), icon: "cloud-off", size: "narrow", cls: "nb-cloudsync-modal",
		});
		if (this.hasSecret) {
			shellCheck(shell.body, t("cloudSync.disconnect.secret"), false, (on) => (this.forgetSecret = on));
			shellNote(shell.body, t("cloudSync.disconnect.secretDesc"));
		}
		shellButton(shell.foot, "secondary", t("cloudSync.disconnect.cancel"), () => this.close());
		shellButton(shell.foot, "danger", t("cloudSync.disconnect.confirm"), () => {
			this.close();
			this.decide({ forgetSecret: this.forgetSecret });
		}, { icon: "cloud-off" });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** "Sync N large files?": files above the size limit. "Skip for now" is remembered until Obsidian restarts. */
export class CloudLargeModal extends Modal {
	private decided = false;

	constructor(app: App, private readonly items: SyncResult["askLarge"], private readonly limitMb: number, private readonly decide: (choice: "sync" | "skip" | null) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, {
			title: t("cloudSync.large.title", { count: String(this.items.length) }), subtitle: t("cloudSync.large.subtitle", { limit: String(this.limitMb) }), icon: "file-up", size: "medium", cls: "nb-cloudsync-modal",
		});
		pathList(shell.body, t("cloudSync.large.list"), this.items);
		shellButton(shell.foot, "secondary", t("cloudSync.large.skip"), () => this.choose("skip"));
		shellButton(shell.foot, "primary", t("cloudSync.large.sync"), () => this.choose("sync"), { icon: "upload" });
	}

	private choose(choice: "sync" | "skip"): void {
		this.decided = true;
		this.close();
		this.decide(choice);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) this.decide(null);
	}
}
