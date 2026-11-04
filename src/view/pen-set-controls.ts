import { Menu, Notice, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { PromptModal } from "../library/library-modals";
import type { FavouritePen } from "./favourites";
import {
	addPenSet, assign, ancestorFolders, displayName, MAX_FOLDER_ASSIGNMENTS, MAX_NOTEBOOK_ASSIGNMENTS, MAX_PEN_SETS, resolvePenSet,
	type PenSet,
} from "./pen-sets";
import { PenSetsModal, penDots, type PenSetsData } from "./pen-sets-modal";

/** What the switcher needs from the notebook view. */
export interface PenSetHost {
	app: App;
	data(): PenSetsData;
	update(next: PenSetsData): void;
	/** The set the strip shows now (null: the favourite pens). */
	activeId(): string | null;
	/** Chooses the set for this view until another notebook is opened (not saved). */
	choose(id: string | null): void;
	/** The notebook open here: its document id and vault path (null while nothing is loaded). */
	notebook(): { id: string | null; path: string } | null;
	/** The six pens on the strip now. */
	strip(): FavouritePen[];
	/** The notebook can be edited (the chip is disabled otherwise). */
	editable(): boolean;
}

/**
 * The pen set switcher: a chip at the top of the pen and highlighter options ("Pen set: Maths") that opens a menu to pick a
 * set for this notebook, save the pens on the strip as a new set, make the set the one of this notebook or folder, and open
 * the manager. Choosing a set never rewrites a set; the assignments are what opening a notebook reads (see pen-sets.ts).
 */
export class PenSetControls {
	private readonly button: HTMLButtonElement;
	private readonly dots: HTMLElement;
	private readonly label: HTMLElement;

	constructor(parent: HTMLElement, private readonly host: PenSetHost) {
		this.button = parent.createEl("button", { cls: "nb-ui notebook-penset-chip", attr: { type: "button", "aria-haspopup": "menu" } });
		setIcon(this.button.createSpan({ cls: "notebook-penset-icon", attr: { "aria-hidden": "true" } }), "layers");
		this.dots = this.button.createSpan({ cls: "notebook-penset-dots-slot" });
		this.label = this.button.createSpan({ cls: "notebook-penset-label" });
		setIcon(this.button.createSpan({ cls: "notebook-penset-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
		this.button.addEventListener("click", (e) => {
			e.preventDefault();
			this.openMenu();
		});
		this.refresh();
	}

	/** Redraws the chip for the active set. Cheap. */
	refresh(): void {
		const set = this.active();
		const name = set ? displayName(set, (k) => t(k)) : t("pensets.default");
		this.label.setText(name);
		this.dots.empty();
		if (set) penDots(this.dots, set.pens);
		this.button.setAttribute("aria-label", `${t("pensets.switcher")}: ${name}`);
		this.button.disabled = !this.host.editable();
	}

	private active(): PenSet | null {
		const id = this.host.activeId();
		return id ? this.host.data().sets.find((s) => s.id === id) ?? null : null;
	}

	private openMenu(): void {
		const d = this.host.data();
		const active = this.active();
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(t("pensets.default")).setIcon("star").setChecked(!active).onClick(() => this.pick(null)));
		for (const set of d.sets) {
			menu.addItem((i) => i.setTitle(displayName(set, (k) => t(k))).setIcon("pen-tool").setChecked(active?.id === set.id).onClick(() => this.pick(set.id)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t("pensets.saveAs")).setIcon("plus").setDisabled(d.sets.length >= MAX_PEN_SETS).onClick(() => this.saveAs()));
		const nb = this.host.notebook();
		if (active && nb) {
			const name = displayName(active, (k) => t(k));
			if (nb.id) {
				const mine = d.notebooks[nb.id] === active.id;
				menu.addItem((i) => i.setTitle(t(mine ? "pensets.clearNotebook" : "pensets.useNotebook", { name })).setIcon("book").setChecked(mine).onClick(() => this.assignNotebook(nb.id, mine ? null : active)));
			}
			const folder = ancestorFolders(nb.path)[0];
			if (folder) {
				const mine = d.folders[folder] === active.id;
				menu.addItem((i) => i.setTitle(t(mine ? "pensets.clearFolder" : "pensets.useFolder", { name, folder })).setIcon("folder").setChecked(mine).onClick(() => this.assignFolder(folder, mine ? null : active)));
			}
		} else if (nb && !active) {
			const own = nb.id !== null && d.notebooks[nb.id] !== undefined;
			if (own && nb.id) menu.addItem((i) => i.setTitle(t("pensets.clearNotebookAny")).setIcon("book").onClick(() => this.assignNotebook(nb.id, null)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle(t("pensets.manage")).setIcon("settings").onClick(() => this.manage()));
		const r = this.button.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
	}

	private pick(id: string | null): void {
		this.host.choose(id);
		this.refresh();
	}

	private saveAs(): void {
		const pens = this.host.strip();
		new PromptModal(this.host.app, { title: t("pensets.saveAs"), label: t("pensets.name.label"), cta: t("pensets.name.cta") }, (value) => {
			const d = this.host.data();
			const next = addPenSet(d.sets, value, pens);
			if (!next) {
				new Notice(t("pensets.limit", { n: String(MAX_PEN_SETS) }));
				return;
			}
			this.host.update({ ...d, sets: next.sets });
			this.host.choose(next.id);
			this.refresh();
			new Notice(t("pensets.created", { name: value.trim() }));
		}).open();
	}

	private assignNotebook(id: string | null, set: PenSet | null): void {
		if (!id) return;
		const d = this.host.data();
		this.host.update({ ...d, notebooks: assign(d.notebooks, id, set?.id ?? null, MAX_NOTEBOOK_ASSIGNMENTS) });
		new Notice(set ? t("pensets.assignedNotebook", { name: displayName(set, (k) => t(k)) }) : t("pensets.cleared"));
	}

	private assignFolder(folder: string, set: PenSet | null): void {
		const d = this.host.data();
		this.host.update({ ...d, folders: assign(d.folders, folder, set?.id ?? null, MAX_FOLDER_ASSIGNMENTS) });
		new Notice(set ? t("pensets.assignedFolder", { name: displayName(set, (k) => t(k)), folder }) : t("pensets.cleared"));
	}

	private manage(): void {
		new PenSetsModal(this.host.app, {
			get: () => this.host.data(),
			update: (next) => this.host.update(next),
			currentPens: () => this.host.strip(),
		}, () => this.refresh()).open();
	}
}

/** The set a freshly opened notebook starts with, from the saved assignments (pure helper for the view). */
export function setForOpen(d: PenSetsData, notebookId: string | null, filePath: string): PenSet | null {
	return resolvePenSet({ sets: d.sets, folders: d.folders, notebooks: d.notebooks, notebookId, filePath }).set;
}
