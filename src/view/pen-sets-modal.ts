import { FuzzySuggestModal, Menu, Modal, Notice, TFolder, type App, type FuzzyMatch } from "obsidian";
import { t } from "../i18n";
import { PromptModal } from "../library/library-modals";
import { iconButton } from "../ui/components/dom";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { confirmDestructive } from "../ui/destructive";
import type { FavouritePen } from "./favourites";
import { PEN_KINDS } from "../ink/pen-kinds";
import {
	assign, displayName, folderKey, MAX_FOLDER_ASSIGNMENTS, MAX_PEN_SETS, removePenSet, renamePenSet, replacePens, restoreStarters,
	type PenSet,
} from "./pen-sets";

/** The part of the settings the manager reads and writes. */
export interface PenSetsData {
	sets: PenSet[];
	folders: Record<string, string>;
	notebooks: Record<string, string>;
}

/** Where the manager reads and saves the sets (the plugin settings; the settings tab and the notebook view each provide it). */
export interface PenSetsStore {
	get(): PenSetsData;
	update(next: PenSetsData): void;
	/** The six pens on the strip now, for "replace with my current pens"; null when no notebook is open (the settings tab). */
	currentPens(): FavouritePen[] | null;
}

/** A row of pen dots: the colour and the kind (round pen, square highlighter) of each pen of a set. */
export function penDots(parent: HTMLElement, pens: readonly FavouritePen[]): HTMLElement {
	const row = parent.createSpan({ cls: "nb-penset-dots", attr: { "aria-hidden": "true" } });
	for (const p of pens) {
		const dot = row.createSpan({ cls: "nb-penset-dot" });
		dot.toggleClass("is-highlighter", p.tool === "highlighter");
		for (const kind of PEN_KINDS) if (kind !== "pen") dot.toggleClass(`is-kind-${kind}`, p.kind === kind);
		dot.setCssProps({ "--nb-penset-color": p.color });
	}
	return row;
}

class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private readonly onPick: (folder: TFolder) => void) {
		super(app);
		this.setPlaceholder(t("pensets.pickFolder"));
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(false);
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onPick(folder);
	}

	renderSuggestion(match: FuzzyMatch<TFolder>, el: HTMLElement): void {
		el.setText(match.item.path);
	}
}

/** The pen set manager: rename, delete, replace the pens of a set, the folders that carry a set, restore the starter sets. */
export class PenSetsModal extends Modal {
	private bodyEl: HTMLElement | null = null;

	constructor(app: App, private readonly store: PenSetsStore, private readonly changed: () => void = () => undefined) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("pensets.title"), subtitle: t("pensets.subtitle"), icon: "pen-tool", size: "medium", cls: "nb-penset-modal" });
		this.bodyEl = shell.body;
		shellButton(shell.foot, "secondary", t("pensets.restore"), () => {
			const d = this.store.get();
			this.save({ ...d, sets: restoreStarters(d.sets) });
		}, { icon: "rotate-ccw" });
		shellButton(shell.foot, "primary", t("pensets.done"), () => this.close());
		this.draw();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private save(next: PenSetsData): void {
		this.store.update(next);
		this.changed();
		this.draw();
	}

	private draw(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();
		const d = this.store.get();
		const current = this.store.currentPens();
		const name = (s: PenSet): string => displayName(s, (k) => t(k));

		body.createDiv({ cls: "nb-modal-section-title", text: t("pensets.sets") });
		const list = body.createDiv({ cls: "nb-modal-list nb-penset-list" });
		if (d.sets.length === 0) shellNote(list, t("pensets.empty"));
		for (const set of d.sets) {
			const row = list.createDiv({ cls: "nb-penset-row" });
			penDots(row, set.pens);
			row.createSpan({ cls: "nb-penset-name", text: name(set) });
			const tools = row.createDiv({ cls: "nb-penset-tools" });
			if (current) iconButton(tools, "refresh-cw", t("pensets.useCurrent", { name: name(set) }), () => {
				this.save({ ...d, sets: replacePens(d.sets, set.id, current) });
				new Notice(t("pensets.updated", { name: name(set) }));
			});
			iconButton(tools, "pencil", t("pensets.rename", { name: name(set) }), () => {
				new PromptModal(this.app, { title: t("pensets.rename", { name: name(set) }), label: t("pensets.name.label"), value: name(set), cta: t("pensets.name.cta") }, (value) => {
					this.save({ ...this.store.get(), sets: renamePenSet(this.store.get().sets, set.id, value) });
				}).open();
			});
			iconButton(tools, "trash-2", t("pensets.delete", { name: name(set) }), () => {
				confirmDestructive(this.app, { title: t("pensets.delete.title"), body: t("pensets.delete.body", { name: name(set) }), confirm: t("pensets.delete.cta") }, () => {
					const cur = this.store.get();
					this.save(removePenSet(cur.sets, cur.folders, cur.notebooks, set.id));
				});
			});
		}

		body.createDiv({ cls: "nb-modal-section-title", text: t("pensets.folders") });
		const folders = body.createDiv({ cls: "nb-modal-list nb-penset-list" });
		const entries = Object.entries(d.folders);
		if (entries.length === 0) shellNote(folders, t("pensets.noFolders"));
		for (const [folder, setId] of entries) {
			const set = d.sets.find((s) => s.id === setId);
			const row = folders.createDiv({ cls: "nb-penset-row" });
			row.createSpan({ cls: "nb-penset-name", text: folder });
			row.createSpan({ cls: "nb-penset-for", text: set ? name(set) : t("pensets.missing") });
			iconButton(row.createDiv({ cls: "nb-penset-tools" }), "x", t("pensets.unassign", { folder }), () => {
				this.save({ ...this.store.get(), folders: assign(this.store.get().folders, folder, null, MAX_FOLDER_ASSIGNMENTS) });
			});
		}
		shellButton(body, "secondary", t("pensets.addFolder"), () => this.assignFolder(), { icon: "folder-plus", disabled: d.sets.length === 0 });

		const count = Object.keys(d.notebooks).length;
		body.createDiv({ cls: "nb-modal-section-title", text: t("pensets.notebooks") });
		const nb = body.createDiv({ cls: "nb-penset-row" });
		nb.createSpan({ cls: "nb-penset-name", text: t("pensets.notebooksCount", { n: String(count) }) });
		if (count > 0) {
			shellButton(nb, "secondary", t("pensets.clearNotebooks"), () => {
				confirmDestructive(this.app, { title: t("pensets.clearNotebooks.title"), body: t("pensets.clearNotebooks.body", { n: String(count) }), confirm: t("pensets.clearNotebooks") }, () => {
					this.save({ ...this.store.get(), notebooks: {} });
				});
			});
		}
		if (d.sets.length >= MAX_PEN_SETS) shellNote(body, t("pensets.limit", { n: String(MAX_PEN_SETS) }));
	}

	private assignFolder(): void {
		new FolderPicker(this.app, (folder) => {
			const d = this.store.get();
			const menu = new Menu();
			for (const set of d.sets) {
				menu.addItem((i) => i.setTitle(displayName(set, (k) => t(k))).setIcon("pen-tool").onClick(() => {
					this.save({ ...this.store.get(), folders: assign(this.store.get().folders, folderKey(folder.path), set.id, MAX_FOLDER_ASSIGNMENTS) });
				}));
			}
			const rect = this.contentEl.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left + rect.width / 2, y: rect.top + 120 });
		}).open();
	}
}
