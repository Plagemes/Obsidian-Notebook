/**
 * The list of global bookmarks (roadmap #265): pages of different notebooks in one place. A dialog on the modal shell: one
 * row per bookmark (tap opens the notebook at the page), with rename, move up / down and remove. A page that is gone, or a
 * notebook that cannot be found, is shown as missing and can still be removed. Reached from Home and from the notebook view.
 */
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import type { GlobalBookmark } from "../library/bookmarks";
import { PromptModal } from "../library/library-modals";
import { iconButton } from "../ui/components/dom";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import type { BookmarkStatus, BookmarksService } from "./bookmarks-service";

/** What a row says: the name the reader gave it, else the page's own bookmark title, else "<notebook> p. N". */
export function bookmarkTitle(b: GlobalBookmark, status: BookmarkStatus | undefined, notebookName: string): string {
	if (b.label) return b.label;
	if (status?.kind === "page" && status.title) return status.title;
	const n = status?.kind === "page" ? status.index + 1 : b.num;
	return `${notebookName} ${t("gbm.page", { n: String(n) })}`;
}

const nameOfPath = (path: string): string => (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");

export class BookmarksModal extends Modal {
	private body!: HTMLElement;
	private status = new Map<string, BookmarkStatus>();
	private checked = false;
	private off: (() => void) | null = null;
	private token = 0;

	constructor(app: App, private readonly service: BookmarksService) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("gbm.title"), subtitle: t("gbm.subtitle"), icon: "bookmark", size: "medium", cls: "nb-gbm-modal" });
		this.body = shell.body;
		shellButton(shell.foot, "secondary", t("gbm.done"), () => this.close());
		this.off = this.service.onChange(() => this.refresh());
		this.draw();
		void this.check();
	}

	onClose(): void {
		this.off?.();
		this.off = null;
		this.token++;
		this.contentEl.empty();
	}

	/** The list changed (here, or on another device): draw it again and look at the pages that are new. */
	private refresh(): void {
		this.draw();
		void this.check();
	}

	/** Looks at the notebooks (once per change) to learn which pages are gone; the rows are drawn without waiting for it. */
	private async check(): Promise<void> {
		const mine = ++this.token;
		const list = this.service.list();
		const status = await this.service.inspect(list);
		if (mine !== this.token) return;
		this.status = status;
		this.checked = true;
		this.draw();
	}

	private draw(): void {
		const list = this.service.list();
		this.body.empty();
		if (list.length === 0) {
			shellNote(this.body, t("gbm.empty")).addClass("nb-gbm-empty");
			return;
		}
		const ul = this.body.createDiv({ cls: "nb-gbm-list", attr: { role: "list" } });
		list.forEach((b, i) => this.row(ul, b, i, list.length));
		if (!this.checked) ul.createDiv({ cls: "nb-hint nb-gbm-checking", text: t("gbm.checking") });
	}

	private row(parent: HTMLElement, b: GlobalBookmark, index: number, total: number): void {
		const st = this.status.get(b.id);
		const missing = st?.kind === "notebook-gone" || st?.kind === "page-gone";
		const name = st && st.kind !== "notebook-gone" ? st.file.basename : nameOfPath(b.path);
		const title = bookmarkTitle(b, st, name);
		const row = parent.createDiv({ cls: "nb-gbm-row", attr: { role: "listitem" } });
		row.dataset.key = `gbm:${b.id}`;
		row.toggleClass("is-missing", missing);
		const main = row.createEl("button", { cls: "nb-gbm-main", attr: { type: "button", "aria-label": t("gbm.openRow", { text: title }) } });
		main.createDiv({ cls: "nb-gbm-title", text: title });
		const detail = st?.kind === "notebook-gone" ? t("gbm.notebookGone", { path: b.path })
			: st?.kind === "page-gone" ? t("gbm.pageGone", { name })
			: t("gbm.detail", { name, n: String(st?.kind === "page" ? st.index + 1 : b.num) });
		main.createDiv({ cls: "nb-gbm-detail", text: detail });
		if (missing) main.createSpan({ cls: "nb-gbm-badge", text: t("gbm.badgeMissing") });
		main.addEventListener("click", () => {
			this.close();
			void this.service.open(b);
		});
		const actions = row.createDiv({ cls: "nb-gbm-actions" });
		iconButton(actions, "arrow-up", t("gbm.moveUp"), () => void this.service.move(b.id, index - 1), "nb-gbm-up").disabled = index === 0;
		iconButton(actions, "arrow-down", t("gbm.moveDown"), () => void this.service.move(b.id, index + 1), "nb-gbm-down").disabled = index === total - 1;
		iconButton(actions, "pencil", t("gbm.rename"), () => {
			new PromptModal(this.app, { title: t("gbm.renameTitle"), label: t("gbm.renameLabel"), value: title, cta: t("gbm.renameCta") }, (value) => void this.service.rename(b.id, value)).open();
		}, "nb-gbm-rename");
		iconButton(actions, "trash-2", t("gbm.remove"), () => void this.service.remove(b.id), "nb-gbm-remove");
	}
}

export function openBookmarks(app: App, service: BookmarksService): BookmarksModal {
	const modal = new BookmarksModal(app, service);
	modal.open();
	return modal;
}
