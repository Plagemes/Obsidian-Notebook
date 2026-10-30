import { getLanguage, Modal, Notice, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { daysLeft } from "../storage/trash-paths";
import type { LibraryTrash, TrashItem } from "../storage/trash";
import { relativeTime } from "./format";
import { ConfirmModal } from "./library-modals";

/** Moves a notebook or folder to the library trash, after a confirmation that says it can be restored. */
export function confirmMoveToTrash(app: App, target: { name: string; isFolder: boolean }, run: () => Promise<unknown>, failed: (e: unknown) => void): void {
	new ConfirmModal(
		app,
		{
			title: t(target.isFolder ? "trash.moveFolder.title" : "trash.move.title"),
			body: t(target.isFolder ? "trash.moveFolder.body" : "trash.move.body", { name: target.name }),
			cta: t("trash.move.cta"),
		},
		() => void run().then(() => new Notice(t("trash.notice.moved", { name: target.name }))).catch(failed),
	).open();
}

/** The library's trash: restore, delete permanently, empty. Every action asks before anything is deleted for good. */
export class TrashModal extends Modal {
	private items: TrashItem[] = [];
	private busy = false;

	constructor(app: App, private readonly trash: LibraryTrash) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("notebook-trash-modal");
		this.setTitle(t("trash.title"));
		void this.reload();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async reload(): Promise<void> {
		try {
			this.items = await this.trash.list();
		} catch (e) {
			console.error("[notebook] could not list the trash", e);
			new Notice(t("trash.notice.failed", { error: (e as Error).message }));
			this.items = [];
		}
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const days = this.trash.retentionDays();
		el.createEl("p", { cls: "notebook-trash-hint", text: days > 0 ? `${t("trash.hint")} ${t("trash.hint.auto", { days: String(days) })}` : t("trash.hint") });
		if (this.items.length === 0) {
			el.createDiv({ cls: "notebook-trash-empty", text: t("trash.empty") });
			return;
		}
		const bar = el.createDiv({ cls: "notebook-trash-bar" });
		const emptyBtn = bar.createEl("button", { cls: "mod-warning", text: t("trash.emptyAll") });
		emptyBtn.addEventListener("click", () => this.askEmpty());
		const list = el.createDiv({ cls: "notebook-trash-list" });
		const now = Date.now();
		for (const item of this.items) {
			const row = list.createDiv({ cls: "notebook-trash-row" });
			setIcon(row.createSpan({ cls: "notebook-trash-icon" }), item.kind === "folder" ? "folder" : "book-open");
			const text = row.createDiv({ cls: "notebook-trash-text" });
			text.createDiv({ cls: "notebook-trash-name", text: item.kind === "notebook" ? item.name.replace(/\.[^.]+$/, "") : item.name });
			text.createDiv({ cls: "notebook-trash-path", text: item.originalPath });
			const left = daysLeft(item.deletedAt, now, days);
			const when = t("trash.deleted", { when: relativeTime(item.deletedAt, now, getLanguage()) });
			text.createDiv({ cls: "notebook-trash-meta", text: left === null ? when : `${when} · ${t("trash.daysLeft", { n: String(left) })}` });
			const actions = row.createDiv({ cls: "notebook-trash-actions" });
			actions.createEl("button", { cls: "mod-cta", text: t("trash.restore") }).addEventListener("click", () => void this.restore(item));
			actions.createEl("button", { cls: "mod-warning", text: t("trash.delete") }).addEventListener("click", () => this.askDelete(item));
		}
	}

	private async restore(item: TrashItem): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const path = await this.trash.restore(item.id);
			new Notice(t("trash.notice.restored", { path }));
		} catch (e) {
			new Notice(t("trash.notice.failed", { error: (e as Error).message }));
		} finally {
			this.busy = false;
		}
		await this.reload();
	}

	private askDelete(item: TrashItem): void {
		new ConfirmModal(
			this.app,
			{ title: t("trash.deleteConfirm.title"), body: t("trash.deleteConfirm.body", { name: item.name }), cta: t("trash.delete") },
			() => void this.run(() => this.trash.deletePermanently(item.id)),
		).open();
	}

	private askEmpty(): void {
		new ConfirmModal(
			this.app,
			{ title: t("trash.emptyConfirm.title"), body: t("trash.emptyConfirm.body", { n: String(this.items.length) }), cta: t("trash.emptyAll") },
			() => void this.run(async () => {
				const n = await this.trash.empty();
				new Notice(t("trash.notice.emptied", { n: String(n) }));
			}),
		).open();
	}

	private async run(job: () => Promise<unknown>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await job();
		} catch (e) {
			new Notice(t("trash.notice.failed", { error: (e as Error).message }));
		} finally {
			this.busy = false;
		}
		await this.reload();
	}
}

/** The "Trash" entry of the library sidebar. */
export function addTrashNavItem(parent: HTMLElement, onOpen: () => void): void {
	const b = parent.createEl("button", { cls: "notebook-lib-nav-item", attr: { "data-key": "nav:trash" } });
	setIcon(b.createSpan({ cls: "notebook-lib-nav-icon" }), "trash-2");
	b.createSpan({ cls: "notebook-lib-nav-label", text: t("library.nav.trash") });
	b.addEventListener("click", onOpen);
}
