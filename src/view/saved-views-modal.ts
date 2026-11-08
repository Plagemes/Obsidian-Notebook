import { Menu, Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { VIEWS_MAX, VIEW_NAME_MAX } from "../model/types";
import { modalShell, shellButton, shellField, shellNote } from "../ui/components/modal-shell";
import { moveOptions, type ViewRow } from "./saved-views-logic";

/** What the dialog needs from the view (SavedViewTools): the list as it is now, and the things it can do with it. */
export interface SavedViewsApi {
	/** The views as rows, in list order (asked again after every change). */
	rows(): ViewRow[];
	/** The notebook can be changed (false: read-only mode, a document still loading). Views can always be recalled. */
	canEdit(): boolean;
	/** Where the view is now (page number and zoom percent), or null while there is nothing to measure. */
	current(): { page: number; zoom: number } | null;
	/** A name for the next view that no view has yet. */
	suggestedName(): string;
	/** Saves what is in view under this name as one undo step; true when it was saved (the reason is said when not). */
	save(name: string): boolean;
	rename(id: string, name: string): boolean;
	/** Points the view at what is in view now (its name and place in the list stay). */
	update(id: string): boolean;
	/** Moves the view up (-1) or down (+1) by one place. */
	move(id: string, by: -1 | 1): boolean;
	remove(id: string): boolean;
	/** Shows the view; false when its page is gone (said). */
	go(id: string): boolean;
}

export interface SavedViewsOptions {
	/** The dialog was opened to save: the name field has the focus, and the dialog closes once the view is saved. */
	save?: boolean;
}

/**
 * The saved views of the notebook (0.23, #264): a field to name and save what is in view, and the list with a tap to go to a view and a
 * menu to rename, update, reorder and remove it. Built on the shared modal shell; it lists what is there now and redraws after each
 * change, so it never offers a view that was removed or undone in the meantime. A view whose page is gone is shown as missing.
 */
export class SavedViewsModal extends Modal {
	private editing: string | null = null;
	private draft = "";
	/** The view saved last, highlighted for a moment so the new row is easy to find. */
	private fresh: string | null = null;

	constructor(app: App, private readonly api: SavedViewsApi, private readonly options: SavedViewsOptions = {}) {
		super(app);
	}

	onOpen(): void {
		this.draft = this.api.suggestedName();
		this.render(this.options.save === true);
	}

	private render(focusName = false): void {
		const rows = this.api.rows();
		const editable = this.api.canEdit();
		const shell = modalShell(this, { title: t("views.title"), subtitle: t("views.subtitle"), icon: "frame", size: "narrow", cls: "nb-views-modal" });

		const field = shellField(shell.body, t("views.save.label"), "nb-views-name");
		const saveRow = field.createDiv({ cls: "nb-modal-inputrow nb-views-save" });
		const input = saveRow.createEl("input", {
			cls: "nb-modal-input", attr: { id: "nb-views-name", type: "text", maxlength: String(VIEW_NAME_MAX), autocomplete: "off", spellcheck: "false", placeholder: t("views.save.placeholder") },
		});
		input.value = this.draft;
		input.disabled = !editable;
		input.addEventListener("input", () => {
			this.draft = input.value;
			save.disabled = !editable || input.value.trim() === "";
		});
		const save = shellButton(saveRow, "primary", t("views.save.button"), () => this.saveNow(), { icon: "plus", disabled: !editable || this.draft.trim() === "" });
		input.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" || e.isComposing) return;
			e.preventDefault();
			if (!save.disabled) this.saveNow();
		});
		const now = this.api.current();
		if (now) field.createDiv({ cls: "nb-modal-note nb-views-now", text: t("views.save.now", { page: String(now.page), zoom: String(now.zoom) }) });
		if (!editable) shellNote(shell.body, t("views.readOnly"));

		if (rows.length === 0) {
			shellNote(shell.body, t("views.empty"));
		} else {
			const list = shell.body.createDiv({ cls: "nb-views-list", attr: { role: "list", "aria-label": t("views.title") } });
			for (const row of rows) this.renderRow(list, row, rows, editable);
			shellNote(shell.body, t("views.count", { count: String(rows.length), max: String(VIEWS_MAX) }));
		}
		shellButton(shell.foot, "secondary", t("views.close"), () => this.close());
		if (focusName) {
			input.focus();
			input.select();
		}
		if (this.editing !== null) activeDocument.querySelector<HTMLInputElement>(".nb-views-rename")?.focus();
	}

	private saveNow(): void {
		const name = this.draft;
		const before = this.api.rows().map((r) => r.id);
		if (!this.api.save(name)) return;
		if (this.options.save) {
			this.close();
			return;
		}
		this.fresh = this.api.rows().map((r) => r.id).find((id) => !before.includes(id)) ?? null;
		this.draft = this.api.suggestedName();
		this.render();
		this.fresh = null;
	}

	private renderRow(list: HTMLElement, row: ViewRow, rows: readonly ViewRow[], editable: boolean): void {
		const el = list.createDiv({ cls: "nb-views-row", attr: { role: "listitem", "data-view": row.id } });
		if (row.missing) el.addClass("is-missing");
		if (row.id === this.fresh) el.addClass("is-fresh");
		setIcon(el.createSpan({ cls: "nb-views-row-icon", attr: { "aria-hidden": "true" } }), row.missing ? "frame" : "scan-eye");
		if (this.editing === row.id) {
			const edit = el.createEl("input", {
				cls: "nb-modal-input nb-views-rename", attr: { type: "text", maxlength: String(VIEW_NAME_MAX), autocomplete: "off", spellcheck: "false", "aria-label": t("views.rename.label", { name: row.name }) },
			});
			edit.value = row.name;
			const done = (commit: boolean) => {
				if (this.editing !== row.id) return;
				this.editing = null;
				if (commit && edit.value.trim() !== "") this.api.rename(row.id, edit.value);
				this.render();
			};
			edit.addEventListener("keydown", (e) => {
				if (e.isComposing) return;
				if (e.key === "Enter") {
					e.preventDefault();
					done(true);
				} else if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					done(false);
				}
			});
			edit.addEventListener("blur", () => done(true));
			return;
		}
		const go = el.createEl("button", { cls: "nb-views-row-text", attr: { type: "button", "aria-label": t("views.go", { name: row.name }), title: row.missing ? t("views.missing.hint") : t("views.go", { name: row.name }) } });
		go.createSpan({ cls: "nb-views-row-label", text: row.name });
		go.createSpan({ cls: "nb-views-row-detail", text: row.missing ? t("views.missing") : t("views.row.detail", { page: String(row.pageNumber ?? 0), zoom: String(row.zoomPercent) }) });
		go.addEventListener("click", () => {
			if (this.api.go(row.id)) this.close();
		});
		// A missing view of a read-only notebook has nothing to offer (it can be neither recalled nor changed).
		if (row.missing && !editable) return;
		const more = el.createEl("button", { cls: "nb-views-row-more", attr: { type: "button", "aria-label": t("views.options", { name: row.name }), title: t("views.options", { name: row.name }) } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (e) => {
			e.preventDefault();
			const r = more.getBoundingClientRect();
			this.menu(row, rows, editable, { x: r.left, y: r.bottom });
		});
	}

	private menu(row: ViewRow, rows: readonly ViewRow[], editable: boolean, at: { x: number; y: number }): void {
		const menu = new Menu();
		const can = moveOptions(rows, row.id);
		if (!row.missing) {
			menu.addItem((i) => i.setTitle(t("views.go", { name: row.name })).setIcon("locate-fixed").onClick(() => {
				if (this.api.go(row.id)) this.close();
			}));
		}
		if (editable) {
			menu.addItem((i) => i.setTitle(t("views.rename")).setIcon("pencil").onClick(() => {
				this.editing = row.id;
				this.render();
			}));
			menu.addItem((i) => i.setTitle(t("views.update")).setIcon("crosshair").onClick(() => {
				if (this.api.update(row.id)) this.render();
			}));
			if (can.up) menu.addItem((i) => i.setTitle(t("views.moveUp")).setIcon("arrow-up").onClick(() => this.moved(row.id, -1)));
			if (can.down) menu.addItem((i) => i.setTitle(t("views.moveDown")).setIcon("arrow-down").onClick(() => this.moved(row.id, 1)));
			menu.addSeparator();
			menu.addItem((i) => i.setTitle(t("views.remove")).setIcon("trash-2").onClick(() => {
				if (this.api.remove(row.id)) this.render();
			}));
		}
		menu.showAtPosition(at);
	}

	private moved(id: string, by: -1 | 1): void {
		if (this.api.move(id, by)) this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
