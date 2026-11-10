import { Menu, Modal, setIcon, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { ResolvedSection } from "../model/sections";
import { SECTIONS_MAX, SECTION_TITLE_MAX } from "../model/types";
import { modalShell, shellButton, shellField, shellNote } from "../ui/components/modal-shell";
import { SUBJECT_COLORS, tintFor, type SubjectColor } from "../ui/palette";
import { sectionSpan } from "./sections-logic";

/** What the list dialog needs from the view (SectionTools). */
export interface SectionsApi {
	/** The sections that show, in page order (asked again after every change). */
	resolved(): ResolvedSection[];
	/** The notebook can be changed (false: read-only mode, a document still loading). Jumping always works. */
	canEdit(): boolean;
	/** The page in view (0-based). */
	currentIndex(): number;
	/** The section of page `index`, or null. */
	at(index: number): ResolvedSection | null;
	/** Starts a section at page `index` (opens the dialog for its title and colour). */
	create(index: number): void;
	/** Opens the dialog to rename and recolour a section. */
	editSection(id: string, focus: "title" | "color"): void;
	/** Removes a section (its pages stay). */
	remove(id: string): boolean;
	/** Shows the first page of a section. */
	go(id: string): boolean;
}

const COLOUR_NAMES: Readonly<Record<SubjectColor["name"], MessageKey>> = {
	Red: "sections.colour.red", Blue: "sections.colour.blue", Violet: "sections.colour.violet", Teal: "sections.colour.teal",
	Amber: "sections.colour.amber", Pink: "sections.colour.pink", Indigo: "sections.colour.indigo", Green: "sections.colour.green",
};

/** The colour name of a palette entry, for screen readers and tooltips. */
function colourName(name: SubjectColor["name"]): string {
	return t(COLOUR_NAMES[name]);
}

/**
 * The sections of the notebook (0.30, #52): a row per section in page order (its colour, title and pages), a tap to go to its first page,
 * and a menu to rename, recolour or remove it; a button starts a new section at the page in view. Built on the shared modal shell; it
 * lists what is there now and redraws after each change.
 */
export class SectionsModal extends Modal {
	constructor(app: App, private readonly api: SectionsApi) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const rows = this.api.resolved();
		const editable = this.api.canEdit();
		const index = this.api.currentIndex();
		const here = this.api.at(index);
		const shell = modalShell(this, { title: t("sections.title"), subtitle: t("sections.subtitle"), icon: "layers", size: "narrow", cls: "nb-sections-modal" });

		if (editable) {
			const starts = here !== null && here.start === index;
			const add = shellButton(shell.body, "primary", t("sections.new.button", { page: String(index + 1) }), () => {
				this.close();
				this.api.create(index);
			}, { icon: "plus", disabled: starts || rows.length >= SECTIONS_MAX });
			add.addClass("nb-sections-new");
			if (starts) shellNote(shell.body, t("sections.new.already", { title: here.section.title }));
		} else {
			shellNote(shell.body, t("sections.readOnly"));
		}

		if (rows.length === 0) {
			shellNote(shell.body, t("sections.empty"));
		} else {
			const list = shell.body.createDiv({ cls: "nb-sections-list", attr: { role: "list", "aria-label": t("sections.title") } });
			for (const row of rows) this.renderRow(list, row, here?.section.id === row.section.id, editable);
		}
		shellButton(shell.foot, "secondary", t("sections.close"), () => this.close());
	}

	private renderRow(list: HTMLElement, row: ResolvedSection, current: boolean, editable: boolean): void {
		const s = row.section;
		const el = list.createDiv({ cls: "nb-sections-row", attr: { role: "listitem", "data-section": s.id } });
		el.setCssProps({ "--nb-section-color": s.color, "--nb-section-tint": tintFor(s.color) });
		el.toggleClass("is-current", current);
		el.createSpan({ cls: "nb-sections-row-bar", attr: { "aria-hidden": "true" } });
		const span = sectionSpan(row);
		const go = el.createEl("button", { cls: "nb-sections-row-text", attr: { type: "button", "aria-label": t("sections.go", { title: s.title }) } });
		go.createSpan({ cls: "nb-sections-row-label", text: s.title });
		go.createSpan({
			cls: "nb-sections-row-detail",
			text: span.count === 1 ? t("sections.row.one", { page: String(span.first) }) : t("sections.row.many", { first: String(span.first), last: String(span.last), count: String(span.count) }),
		});
		go.addEventListener("click", () => {
			if (this.api.go(s.id)) this.close();
		});
		if (!editable) return;
		const more = el.createEl("button", { cls: "nb-sections-row-more clickable-icon", attr: { type: "button", "aria-label": t("sections.options", { title: s.title }), title: t("sections.options", { title: s.title }) } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (e) => {
			e.preventDefault();
			const r = more.getBoundingClientRect();
			const menu = new Menu();
			menu.addItem((i) => i.setTitle(t("sections.action.rename")).setIcon("pencil").onClick(() => {
				this.close();
				this.api.editSection(s.id, "title");
			}));
			menu.addItem((i) => i.setTitle(t("sections.action.recolour")).setIcon("palette").onClick(() => {
				this.close();
				this.api.editSection(s.id, "color");
			}));
			menu.addSeparator();
			menu.addItem((i) => i.setTitle(t("sections.action.delete")).setIcon("trash-2").onClick(() => {
				if (this.api.remove(s.id)) this.render();
			}));
			menu.showAtPosition({ x: r.left, y: r.bottom });
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface SectionEditOptions {
	mode: "new" | "edit";
	title: string;
	color: string;
	/** The page (1-based) the section starts at, for the line under the title. */
	page: number;
	/** What takes the focus first. */
	focus: "title" | "color";
}

/** The dialog that names a section and picks its colour from the subject palette (new section, rename, recolour). */
export class SectionEditModal extends Modal {
	private draft: string;
	private colour: string;
	private saved = false;

	constructor(app: App, private readonly options: SectionEditOptions, private readonly onSave: (title: string, color: string) => boolean) {
		super(app);
		this.draft = options.title;
		this.colour = options.color.toLowerCase();
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const o = this.options;
		const shell = modalShell(this, {
			title: t(o.mode === "new" ? "sections.edit.newTitle" : "sections.edit.editTitle"),
			subtitle: t("sections.edit.subtitle", { page: String(o.page) }),
			icon: "layers", color: this.colour, size: "narrow", cls: "nb-sections-edit",
		});
		const field = shellField(shell.body, t("sections.edit.name"), "nb-sections-name");
		const input = field.createEl("input", {
			cls: "nb-modal-input", attr: { id: "nb-sections-name", type: "text", maxlength: String(SECTION_TITLE_MAX), autocomplete: "off", spellcheck: "false", placeholder: t("sections.edit.placeholder") },
		});
		input.value = this.draft;
		const colours = shellField(shell.body, t("sections.edit.colour"));
		const row = colours.createDiv({ cls: "nb-sections-swatches", attr: { role: "radiogroup", "aria-label": t("sections.edit.colour") } });
		const preview = createDiv({ cls: "nb-sections-preview", attr: { "aria-hidden": "true" } });
		const paint = () => preview.setCssProps({ "--nb-section-color": this.colour, "--nb-section-tint": tintFor(this.colour) });
		const swatches: Array<{ el: HTMLButtonElement; base: string }> = [];
		let focusSwatch: HTMLButtonElement | null = null;
		for (const c of SUBJECT_COLORS) {
			const base = c.base.toLowerCase();
			const on = base === this.colour;
			const sw = row.createEl("button", { cls: "nb-sections-swatch", attr: { type: "button", role: "radio", "aria-checked": String(on), "aria-label": colourName(c.name), title: colourName(c.name) } });
			sw.setCssProps({ "--nb-section-color": c.base });
			sw.toggleClass("is-on", on);
			if (on) focusSwatch = sw;
			swatches.push({ el: sw, base });
			// Picking a colour changes the swatches and the preview in place (the dialog is not rebuilt).
			sw.addEventListener("click", () => {
				this.colour = base;
				for (const s of swatches) {
					s.el.toggleClass("is-on", s.base === base);
					s.el.setAttribute("aria-checked", String(s.base === base));
				}
				paint();
			});
		}
		shell.body.appendChild(preview);
		paint();
		preview.createSpan({ cls: "nb-sections-tab-dot" });
		const previewText = preview.createSpan({ cls: "nb-sections-tab-label", text: this.draft.trim() || t("sections.edit.placeholder") });

		shellButton(shell.foot, "secondary", t("sections.edit.cancel"), () => this.close());
		const save = shellButton(shell.foot, "primary", t(o.mode === "new" ? "sections.edit.create" : "sections.edit.save"), () => this.save(), { disabled: this.draft.trim() === "" });
		input.addEventListener("input", () => {
			this.draft = input.value;
			save.disabled = input.value.trim() === "";
			previewText.setText(input.value.trim() || t("sections.edit.placeholder"));
		});
		input.addEventListener("keydown", (e) => {
			if (e.key !== "Enter" || e.isComposing) return;
			e.preventDefault();
			if (!save.disabled) this.save();
		});
		if (o.focus === "color" && focusSwatch) focusSwatch.focus();
		else {
			input.focus();
			input.select();
		}
	}

	private save(): void {
		if (this.saved || this.draft.trim() === "") return;
		if (!this.onSave(this.draft, this.colour)) return;
		this.saved = true;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
