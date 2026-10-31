import { FuzzySuggestModal, Modal, type App, type FuzzyMatch } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { setIconSafe, subjectVars } from "../ui/components/dom";
import { CARD_TYPES, parseTagInput, type CardRecord, type CardType } from "./card-content";
import { CARD_TYPE_LOOK } from "./zk-ui";

export interface CardAnswer {
	title: string;
	type: CardType;
	source: string;
	tags: string[];
	/** Luhmann numbering: the card this one branches from (empty: a new top-level card). */
	parent: string;
}

const TYPE_LABEL: Record<CardType, MessageKey> = {
	permanent: "zettel.type.permanent",
	literature: "zettel.type.literature",
	fleeting: "zettel.type.fleeting",
};

const TYPE_HINT: Record<CardType, MessageKey> = {
	permanent: "zettel.type.permanent.hint",
	literature: "zettel.type.literature.hint",
	fleeting: "zettel.type.fleeting.hint",
};

let fieldCount = 0;

/** A labelled field of the dialogs (DESIGN.md §3): label, optional one-line hint, then the control. */
function field(parent: HTMLElement, label: string, hint?: string): { wrap: HTMLElement; id: string } {
	const wrap = parent.createDiv({ cls: "nb-zk-field" });
	const id = `nb-zk-field-${++fieldCount}`;
	wrap.createEl("label", { cls: "nb-zk-label", text: label, attr: { for: id } });
	if (hint) wrap.createDiv({ cls: "nb-zk-field-hint", text: hint });
	return { wrap, id };
}

/** The icon square + title + one line that opens a dialog's body. */
function dialogHead(parent: HTMLElement, icon: string, title: string, subtitle: string): void {
	const head = parent.createDiv({ cls: "nb-zk-dialog-head" });
	setIconSafe(head.createDiv({ cls: "nb-icon-square", attr: { "aria-hidden": "true" } }), icon);
	const text = head.createDiv({ cls: "nb-zk-dialog-titles" });
	text.createEl("h2", { cls: "nb-zk-dialog-title", text: title });
	text.createDiv({ cls: "nb-zk-dialog-sub", text: subtitle });
}

/** "Make card": typed title (Z11), type, source, tags and, with Luhmann numbering, the card it branches from. */
export class CardModal extends Modal {
	private readonly answer: CardAnswer;
	private tagText = "";
	private done = false;
	private tagPreview: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly opts: { luhmann: boolean; preview: string | null; /** Z4: values the dialog starts with. */ defaults?: Partial<CardAnswer> },
		private readonly finish: (answer: CardAnswer | null) => void,
	) {
		super(app);
		this.answer = { title: "", type: "permanent", source: "", tags: [], parent: "", ...opts.defaults };
		this.tagText = this.answer.tags.join(", ");
	}

	onOpen(): void {
		// nb-ui: the scope of the design-system styles (styles.css), above Obsidian's own button and input rules.
		this.modalEl.addClass("nb-ui", "notebook-card-modal");
		this.modalEl.setAttribute("aria-label", t("zettel.modal.title"));
		this.titleEl.empty();
		const { contentEl } = this;
		contentEl.empty();
		const body = contentEl.createDiv({ cls: "nb-zk-dialog" });
		dialogHead(body, "file-text", t("zettel.modal.title"), t("zettel.modal.subtitle"));
		if (this.opts.preview) {
			const frame = body.createDiv({ cls: "nb-zk-preview-frame is-modal" });
			const img = frame.createEl("img", { cls: "nb-zk-preview notebook-zettel-preview" });
			img.src = this.opts.preview;
			img.alt = t("zettel.modal.preview");
		}
		const form = body.createDiv({ cls: "nb-zk-form" });
		const enter = (el: HTMLInputElement) => el.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
		const input = (f: { wrap: HTMLElement; id: string }, value: string, onChange: (v: string) => void): HTMLInputElement => {
			const el = f.wrap.createEl("input", { cls: "nb-zk-input", attr: { id: f.id, type: "text" } });
			el.value = value;
			el.addEventListener("input", () => onChange(el.value));
			enter(el);
			return el;
		};

		const title = field(form, t("zettel.modal.cardTitle"), t("zettel.modal.cardTitle.desc"));
		const titleInput = input(title, this.answer.title, (v) => (this.answer.title = v));
		window.setTimeout(() => titleInput.focus(), 0);

		this.renderTypes(form);

		const source = field(form, t("zettel.modal.source"), t("zettel.modal.source.desc"));
		input(source, this.answer.source, (v) => (this.answer.source = v));

		const tags = field(form, t("zettel.modal.tags"), t("zettel.modal.tags.desc"));
		input(tags, this.tagText, (v) => {
			this.tagText = v;
			this.paintTags();
		});
		this.tagPreview = tags.wrap.createDiv({ cls: "nb-zk-tag-preview" });
		this.paintTags();

		if (this.opts.luhmann) {
			const parent = field(form, t("zettel.modal.parent"), t("zettel.modal.parent.desc"));
			input(parent, "", (v) => (this.answer.parent = v.trim()));
		}

		const footer = body.createDiv({ cls: "nb-zk-footer" });
		const cancel = footer.createEl("button", { cls: "nb-pill-btn", text: t("zettel.modal.cancel"), attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		const create = footer.createEl("button", { cls: "nb-pill-btn mod-cta", attr: { type: "button" } });
		setIconSafe(create.createSpan({ attr: { "aria-hidden": "true" } }), "check");
		create.createSpan({ text: t("zettel.modal.create") });
		create.addEventListener("click", () => this.submit());
	}

	/** The card type as three option tiles (a radio group): icon in the type's colour, name and one line. */
	private renderTypes(form: HTMLElement): void {
		const wrap = form.createDiv({ cls: "nb-zk-field" });
		wrap.createDiv({ cls: "nb-zk-label", text: t("zettel.modal.type") });
		const group = wrap.createDiv({ cls: "nb-zk-types", attr: { role: "radiogroup", "aria-label": t("zettel.modal.type") } });
		const tiles = new Map<CardType, HTMLButtonElement>();
		const select = (type: CardType) => {
			this.answer.type = type;
			for (const [id, tile] of tiles) {
				tile.toggleClass("is-active", id === type);
				tile.setAttribute("aria-checked", String(id === type));
			}
		};
		for (const type of CARD_TYPES) {
			const look = CARD_TYPE_LOOK[type];
			const tile = group.createEl("button", { cls: "nb-zk-type", attr: { type: "button", role: "radio", "aria-checked": "false" } });
			tile.dataset.id = type;
			subjectVars(tile, look.color);
			setIconSafe(tile.createSpan({ cls: "nb-icon-square is-small", attr: { "aria-hidden": "true" } }), look.icon);
			tile.createSpan({ cls: "nb-zk-type-name", text: t(TYPE_LABEL[type]) });
			tile.createSpan({ cls: "nb-zk-type-hint", text: t(TYPE_HINT[type]) });
			tile.addEventListener("click", () => select(type));
			tiles.set(type, tile);
		}
		select(this.answer.type);
	}

	/** The tags as they will be saved (cleaned, no #, no spaces): a preview, not a control. */
	private paintTags(): void {
		if (!this.tagPreview) return;
		this.tagPreview.empty();
		for (const tag of parseTagInput(this.tagText)) this.tagPreview.createSpan({ cls: "nb-pill nb-zk-tag", text: `#${tag}` });
		this.tagPreview.toggleClass("is-hidden", this.tagPreview.childElementCount === 0);
	}

	private submit(): void {
		if (this.done) return;
		this.done = true;
		this.answer.tags = parseTagInput(this.tagText);
		this.close();
		this.finish({ ...this.answer });
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			this.finish(null);
		}
	}
}

export interface CardListItem {
	card: CardRecord;
	/** Where the card is now: `p. 3`, or why it is not on a page. */
	where: string;
	orphaned: boolean;
}

/** List of cards (of a notebook, or the orphaned ones of the vault); choosing one opens its note. */
export class CardListModal extends FuzzySuggestModal<CardListItem> {
	constructor(app: App, private readonly items: CardListItem[], private readonly onChoose: (item: CardListItem) => void) {
		super(app);
		this.modalEl.addClass("nb-ui", "notebook-card-list");
		this.setPlaceholder(t("zettel.list.placeholder"));
		this.emptyStateText = t("zettel.list.empty");
	}

	getItems(): CardListItem[] {
		return this.items;
	}

	getItemText(item: CardListItem): string {
		return `${item.card.id} ${item.card.title}`;
	}

	renderSuggestion(match: FuzzyMatch<CardListItem>, el: HTMLElement): void {
		const { card } = match.item;
		el.addClass("nb-zk-card-row");
		el.toggleClass("is-orphan", match.item.orphaned);
		el.createSpan({ cls: "nb-zk-card-id", text: card.id });
		const text = el.createDiv({ cls: "nb-zk-card-text" });
		text.createDiv({ cls: "nb-zk-card-title", text: card.title || card.id });
		text.createDiv({ text: match.item.where, cls: `nb-zk-card-where ${match.item.orphaned ? "notebook-zettel-list-orphan" : "notebook-picker-path"}` });
	}

	onChooseItem(item: CardListItem): void {
		this.onChoose(item);
	}
}

/** Asks before creating many notes at once (making a slip-box of an existing notebook). */
export class ConfirmCardsModal extends Modal {
	constructor(app: App, private readonly body: string, private readonly onConfirm: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("nb-ui", "notebook-card-modal");
		this.modalEl.setAttribute("aria-label", t("zettel.slipBox.confirmTitle"));
		this.titleEl.empty();
		const body = this.contentEl.createDiv({ cls: "nb-zk-dialog" });
		dialogHead(body, "layers", t("zettel.slipBox.confirmTitle"), t("zettel.slipBox.confirmSub"));
		body.createEl("p", { text: this.body, cls: "nb-zk-confirm-body" });
		const footer = body.createDiv({ cls: "nb-zk-footer" });
		footer.createEl("button", { cls: "nb-pill-btn", text: t("zettel.modal.cancel"), attr: { type: "button" } }).addEventListener("click", () => this.close());
		const ok = footer.createEl("button", { cls: "nb-pill-btn mod-cta", attr: { type: "button" } });
		setIconSafe(ok.createSpan({ attr: { "aria-hidden": "true" } }), "check");
		ok.createSpan({ text: t("zettel.slipBox.confirm") });
		ok.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
