/**
 * 0.16 (roadmap #177): the screens of the shared-files inbox: Home's card, the full list opened from the library rail, the
 * notebook picker and the "where does the image go" choice. Rows are the library's own list rows; every control works.
 */
import { FuzzySuggestModal, Menu, Modal, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { listRow, type ListRowOptions } from "../ui/components/list-row";
import { modalShell, shellNote, shellRow } from "../ui/components/modal-shell";
import { sectionHeader } from "../ui/components/section-header";
import type { SharedInboxPort } from "./shared-inbox";
import { sizeLabel, type InboxItem } from "./shared-inbox-logic";
import type { ImagePlacement } from "./shared-inbox-plan";

/** Rows on Home's card; the rest is behind "Show all". */
export const HOME_ROWS = 3;

const withoutExtension = (path: string) => path.replace(/\.[^./]+$/, "");

/** "PDF · 1.4 MB · 2 hours ago". */
export function itemMeta(port: Pick<SharedInboxPort, "ago">, item: InboxItem): string {
	return [t(item.kind === "pdf" ? "si.kind.pdf" : "si.kind.image"), sizeLabel(item.size), port.ago(item)].filter(Boolean).join(" · ");
}

/** The four actions of a received file, as a menu under `anchor`. */
export function itemMenu(port: SharedInboxPort, item: InboxItem, anchor: HTMLElement): void {
	const menu = new Menu();
	menu.addItem((i) => i.setTitle(t("si.action.newNotebook")).setIcon("file-plus").onClick(() => void port.newNotebook(item)));
	menu.addItem((i) => i.setTitle(t("si.action.addTo")).setIcon("book-plus").onClick(() => void port.addToNotebook(item)));
	menu.addSeparator();
	menu.addItem((i) => i.setTitle(t("si.action.dismiss")).setIcon("eye-off").onClick(() => port.dismiss(item)));
	menu.addItem((i) => i.setTitle(t("si.action.trash")).setIcon("trash-2").onClick(() => port.moveToTrash(item)));
	const r = anchor.getBoundingClientRect();
	menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
}

/** Draws the rows of `items` into `list`. */
export function renderItemRows(list: HTMLElement, port: SharedInboxPort, items: readonly InboxItem[]): void {
	for (const item of items) {
		let row: HTMLElement | null = null;
		const options: ListRowOptions = {
			icon: item.kind === "pdf" ? "file-text" : "image",
			title: item.name,
			meta: itemMeta(port, item),
			pills: [],
			key: `shared:${item.path}`,
			menuLabel: t("si.menu", { file: item.name }),
			onOpen: () => {
				if (row) itemMenu(port, item, row);
			},
			onMenu: (anchor) => itemMenu(port, item, anchor),
		};
		row = listRow(list, options);
	}
}

/** Home's card: the newest files with their actions, and "Show all" when there are more. Nothing when there are none. */
export function renderSharedInboxCard(parent: HTMLElement, port: SharedInboxPort, showAll: () => void): void {
	const items = port.items();
	if (items.length === 0) return;
	const panel = parent.createEl("section", { cls: "nb-panel nb-home-shared" });
	const head = sectionHeader(panel, {
		icon: "inbox", title: t("si.title"), link: items.length > HOME_ROWS ? { label: t("si.showAll"), onClick: showAll } : undefined,
	});
	head.createSpan({ cls: "nb-dyn-count", text: String(items.length) });
	renderItemRows(panel.createDiv({ cls: "nb-list" }), port, items.slice(0, HOME_ROWS));
	panel.createDiv({ cls: "nb-hint nb-shared-hint", text: t("si.hint") });
}

/** The full list, opened from Home or the library rail. It follows the inbox while it is open. */
export class SharedInboxModal extends Modal {
	private off: (() => void) | null = null;
	private listEl: HTMLElement | null = null;

	constructor(app: App, private readonly port: SharedInboxPort) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, {
			title: t("si.title"), subtitle: t("si.subtitle"), icon: "inbox", size: "wide", footer: false, cls: "nb-shared-modal",
		});
		this.listEl = shell.body.createDiv({ cls: "nb-list nb-shared-list" });
		this.draw();
		this.off = this.port.onChange(() => this.draw());
	}

	private draw(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		const items = this.port.items();
		const problem = this.port.problem();
		if (items.length === 0) {
			shellNote(list, problem ?? t("si.empty"));
			return;
		}
		renderItemRows(list, this.port, items);
	}

	onClose(): void {
		this.off?.();
		this.off = null;
		this.listEl = null;
		this.contentEl.empty();
	}
}

/** Notebook search list ("Add to notebook…"). Resolves with the chosen notebook, or null when dismissed. */
class NotebookPicker extends FuzzySuggestModal<TFile> {
	private chosen = false;

	constructor(app: App, private readonly files: TFile[], private readonly done: (f: TFile | null) => void) {
		super(app);
		this.setPlaceholder(t("si.pick.placeholder"));
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(f: TFile): string {
		return withoutExtension(f.path);
	}

	onChooseItem(f: TFile): void {
		this.chosen = true;
		this.done(f);
	}

	onClose(): void {
		// onChooseItem runs after onClose: wait a tick before reporting a cancel.
		window.setTimeout(() => {
			if (!this.chosen) this.done(null);
		}, 0);
	}
}

export function askNotebook(app: App, files: TFile[]): Promise<TFile | null> {
	return new Promise((resolve) => new NotebookPicker(app, files, resolve).open());
}

/** "As a new page" or "On a page" for an image going into an existing notebook. */
class PlacementModal extends Modal {
	private answered = false;

	constructor(app: App, private readonly notebook: string, private readonly done: (p: ImagePlacement | null) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("si.image.title"), icon: "image-plus", size: "narrow", footer: false, cls: "nb-shared-placement" });
		const pick = (p: ImagePlacement) => {
			this.answered = true;
			this.done(p);
			this.close();
		};
		shellRow(shell.body, { label: t("si.image.page"), detail: t("si.image.page.desc", { name: this.notebook }), onClick: () => pick("page") });
		shellRow(shell.body, { label: t("si.image.element"), detail: t("si.image.element.desc", { name: this.notebook }), onClick: () => pick("element") });
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.done(null);
	}
}

export function askImagePlacement(app: App, notebook: string): Promise<ImagePlacement | null> {
	return new Promise((resolve) => new PlacementModal(app, notebook, resolve).open());
}
