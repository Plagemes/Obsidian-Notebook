/**
 * Card templates (Z9), the surfaces: the template picker inside the "New card" dialog, and the manager for the person's own
 * templates (opened from Settings, Zettelkasten). The manager is built on the shared modal shell; the picker reuses the
 * type tiles of the card dialog. Nothing here decides what a template writes: that is card-templates.ts.
 */
import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { setIconSafe } from "../ui/components/dom";
import { modalShell, shellButton, shellNote, shellSection } from "../ui/components/modal-shell";
import { CARD_TYPES, parseTagInput, type CardType } from "./card-content";
import { CUSTOM_TEMPLATES_MAX, TEMPLATE_NAME_MAX, readCardTemplateSettings, type CustomCardTemplate } from "./card-template-settings";
import { BLANK_TEMPLATE_ID, builtinTemplates, newTemplateId, parseSections, type CardTemplate } from "./card-templates";

/**
 * The template choice of the card dialog: a blank tile and one tile per template, a radio group. Choosing a template
 * calls `onPick` with it (the dialog preselects its type) and nothing else; the headings are written at creation.
 */
export function renderTemplatePicker(
	form: HTMLElement,
	templates: readonly CardTemplate[],
	selected: string,
	onPick: (id: string, template: CardTemplate | null) => void,
): void {
	const wrap = form.createDiv({ cls: "nb-zk-field" });
	wrap.createDiv({ cls: "nb-zk-label", text: t("zettel.tpl.label") });
	wrap.createDiv({ cls: "nb-zk-field-hint", text: t("zettel.tpl.label.desc") });
	const group = wrap.createDiv({ cls: "nb-zk-types nb-zk-templates", attr: { role: "radiogroup", "aria-label": t("zettel.tpl.label") } });
	const tiles = new Map<string, HTMLButtonElement>();
	const choose = (id: string, template: CardTemplate | null) => {
		for (const [tileId, tile] of tiles) {
			tile.toggleClass("is-active", tileId === id);
			tile.setAttribute("aria-checked", String(tileId === id));
		}
		onPick(id, template);
	};
	const add = (id: string, icon: string, name: string, hint: string, template: CardTemplate | null) => {
		const tile = group.createEl("button", { cls: "nb-zk-type", attr: { type: "button", role: "radio", "aria-checked": "false" } });
		tile.dataset.id = id;
		setIconSafe(tile.createSpan({ cls: "nb-icon-square is-small", attr: { "aria-hidden": "true" } }), icon);
		tile.createSpan({ cls: "nb-zk-type-name", text: name });
		tile.createSpan({ cls: "nb-zk-type-hint", text: hint });
		tile.addEventListener("click", () => choose(id, template));
		tiles.set(id, tile);
	};
	add(BLANK_TEMPLATE_ID, "file", t("zettel.tpl.blank"), t("zettel.tpl.blank.hint"), null);
	for (const tpl of templates) add(tpl.id, tpl.icon, tpl.name, tpl.hint, tpl);
	const initial = tiles.has(selected) ? selected : BLANK_TEMPLATE_ID;
	for (const [tileId, tile] of tiles) {
		tile.toggleClass("is-active", tileId === initial);
		tile.setAttribute("aria-checked", String(tileId === initial));
	}
}

const TYPE_NAME: Record<CardType, MessageKey> = {
	permanent: "zettel.type.permanent",
	literature: "zettel.type.literature",
	fleeting: "zettel.type.fleeting",
};

/** What the manager needs: the saved templates, and a way to save them (validated by the lenient reader on the way in). */
export interface CardTemplatesHost {
	app: App;
	get(): CustomCardTemplate[];
	set(list: CustomCardTemplate[]): Promise<void>;
}

let fieldCount = 0;

/**
 * "Card templates": the built-in ones (read-only, each can be copied into a template of your own) and your own, edited in
 * place. Every change is saved as soon as a field is left; there is no Save button to forget.
 */
export class CardTemplatesModal extends Modal {
	private list: CustomCardTemplate[] = [];
	private custom!: HTMLElement;
	private addBtn!: HTMLButtonElement;
	private saving: Promise<void> = Promise.resolve();
	private armed: string | null = null;

	constructor(private readonly host: CardTemplatesHost) {
		super(host.app);
	}

	onOpen(): void {
		this.list = this.host.get().map((c) => ({ ...c, tags: [...c.tags], sections: [...c.sections] }));
		const shell = modalShell(this, { title: t("zettel.tpl.manage.title"), subtitle: t("zettel.tpl.manage.subtitle"), icon: "layout-template", size: "medium", cls: "nb-card-templates" });
		shellNote(shell.body, t("zettel.tpl.manage.note"));
		const builtin = shellSection(shell.body, t("zettel.tpl.manage.builtin"));
		for (const tpl of builtinTemplates((k) => t(k))) {
			const row = builtin.createDiv({ cls: "nb-tpl-row is-builtin" });
			setIconSafe(row.createSpan({ cls: "nb-icon-square is-small", attr: { "aria-hidden": "true" } }), tpl.icon);
			const text = row.createDiv({ cls: "nb-tpl-text" });
			text.createDiv({ cls: "nb-tpl-name", text: tpl.name });
			text.createDiv({ cls: "nb-tpl-sections", text: tpl.sections.join(" / ") });
			const copy = row.createEl("button", { cls: "nb-icon-btn", attr: { type: "button", "aria-label": t("zettel.tpl.manage.copy"), title: t("zettel.tpl.manage.copy") } });
			setIconSafe(copy, "copy");
			copy.addEventListener("click", () => this.add({ name: tpl.name, type: tpl.type, tags: tpl.tags, sections: tpl.sections }));
		}
		const mine = shell.body.createDiv({ cls: "nb-modal-section" });
		mine.createDiv({ cls: "nb-modal-section-title", text: t("zettel.tpl.manage.mine") });
		this.custom = mine.createDiv({ cls: "nb-tpl-list" });
		this.addBtn = shellButton(shell.foot, "secondary", t("zettel.tpl.manage.add"), () => this.add({ name: "", type: "permanent", tags: [], sections: [] }), { icon: "plus" });
		shellButton(shell.foot, "primary", t("zettel.tpl.manage.close"), () => this.close());
		this.draw();
	}

	onClose(): void {
		this.contentEl.empty();
		this.save();
	}

	private add(init: Pick<CustomCardTemplate, "name" | "type" | "tags" | "sections">): void {
		if (this.list.length >= CUSTOM_TEMPLATES_MAX) return;
		this.list.push({ id: newTemplateId(this.list), ...init, tags: [...init.tags], sections: [...init.sections] });
		this.save();
		this.draw();
	}

	/** Saves what is valid (a template needs a name); the reader drops the rest, as on load. */
	private save(): void {
		const next = readCardTemplateSettings({ zettelCardTemplates: this.list }).zettelCardTemplates;
		this.saving = this.saving.then(() => this.host.set(next)).catch(() => undefined);
	}

	private draw(): void {
		this.custom.empty();
		this.addBtn.disabled = this.list.length >= CUSTOM_TEMPLATES_MAX;
		if (this.list.length === 0) shellNote(this.custom, t("zettel.tpl.manage.empty"));
		for (const tpl of this.list) this.drawRow(tpl);
	}

	private drawRow(tpl: CustomCardTemplate): void {
		const row = this.custom.createDiv({ cls: "nb-tpl-edit", attr: { role: "group", "aria-label": tpl.name || t("zettel.tpl.manage.unnamed") } });
		const id = `nb-tpl-${++fieldCount}`;
		let k = 0;
		const labelled = (label: string): { f: HTMLElement; fid: string } => {
			const f = row.createDiv({ cls: "nb-zk-field" });
			const fid = `${id}-${++k}`;
			f.createEl("label", { cls: "nb-zk-label", text: label, attr: { for: fid } });
			return { f, fid };
		};
		const nameField = labelled(t("zettel.tpl.manage.name"));
		const name = nameField.f.createEl("input", { cls: "nb-zk-input", attr: { id: nameField.fid, type: "text", maxlength: String(TEMPLATE_NAME_MAX), placeholder: t("zettel.tpl.manage.name.ph") } });
		name.value = tpl.name;
		name.addEventListener("input", () => (tpl.name = name.value));
		name.addEventListener("change", () => this.save());

		const typeField = labelled(t("zettel.tpl.manage.type"));
		const type = typeField.f.createEl("select", { cls: "nb-zk-input", attr: { id: typeField.fid } });
		for (const ct of CARD_TYPES) type.createEl("option", { text: t(TYPE_NAME[ct]), value: ct });
		type.value = tpl.type;
		type.addEventListener("change", () => {
			tpl.type = type.value as CardType;
			this.save();
		});

		const tagField = labelled(t("zettel.tpl.manage.tags"));
		const tags = tagField.f.createEl("input", { cls: "nb-zk-input", attr: { id: tagField.fid, type: "text" } });
		tags.value = tpl.tags.join(", ");
		tags.addEventListener("input", () => (tpl.tags = parseTagInput(tags.value)));
		tags.addEventListener("change", () => this.save());

		const secField = labelled(t("zettel.tpl.manage.sections"));
		secField.f.createDiv({ cls: "nb-zk-field-hint", text: t("zettel.tpl.manage.sections.desc") });
		const sections = secField.f.createEl("textarea", { cls: "nb-zk-input nb-tpl-sections-input", attr: { id: secField.fid, rows: "4" } });
		sections.value = tpl.sections.join("\n");
		sections.addEventListener("input", () => (tpl.sections = parseSections(sections.value)));
		sections.addEventListener("change", () => this.save());

		const tools = row.createDiv({ cls: "nb-tpl-tools" });
		const armed = this.armed === tpl.id;
		const del = shellButton(tools, armed ? "danger" : "secondary", armed ? t("zettel.tpl.manage.confirmDelete") : t("zettel.tpl.manage.delete"), () => {
			if (this.armed !== tpl.id) {
				this.armed = tpl.id;
				this.draw();
				return;
			}
			this.armed = null;
			this.list = this.list.filter((x) => x.id !== tpl.id);
			this.save();
			this.draw();
		}, { icon: "trash-2" });
		del.setAttribute("aria-label", armed ? t("zettel.tpl.manage.confirmDelete") : t("zettel.tpl.manage.delete"));
	}
}
