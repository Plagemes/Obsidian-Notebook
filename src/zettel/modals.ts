import { FuzzySuggestModal, Modal, Setting, type App, type FuzzyMatch } from "obsidian";
import { t } from "../i18n";
import { CARD_TYPES, parseTagInput, type CardRecord, type CardType } from "./card-content";

export interface CardAnswer {
	title: string;
	type: CardType;
	source: string;
	tags: string[];
	/** Luhmann numbering: the card this one branches from (empty: a new top-level card). */
	parent: string;
}

const typeOptions = (): Record<CardType, string> => ({
	permanent: t("zettel.type.permanent"),
	literature: t("zettel.type.literature"),
	fleeting: t("zettel.type.fleeting"),
});

/** "Make card": typed title (Z11), type, source, tags and, with Luhmann numbering, the card it branches from. */
export class CardModal extends Modal {
	private readonly answer: CardAnswer = { title: "", type: "permanent", source: "", tags: [], parent: "" };
	private tagText = "";
	private done = false;

	constructor(app: App, private readonly opts: { luhmann: boolean; preview: string | null }, private readonly finish: (answer: CardAnswer | null) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("zettel.modal.title"));
		const { contentEl } = this;
		if (this.opts.preview) {
			const img = contentEl.createEl("img", { cls: "notebook-zettel-preview" });
			img.src = this.opts.preview;
			img.alt = t("zettel.modal.preview");
		}
		const enter = (el: HTMLInputElement) => el.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
		new Setting(contentEl)
			.setName(t("zettel.modal.cardTitle"))
			.setDesc(t("zettel.modal.cardTitle.desc"))
			.addText((text) => {
				text.onChange((v) => (this.answer.title = v));
				enter(text.inputEl);
				window.setTimeout(() => text.inputEl.focus(), 0);
			});
		new Setting(contentEl)
			.setName(t("zettel.modal.type"))
			.addDropdown((dd) => dd.addOptions(typeOptions()).setValue(this.answer.type).onChange((v) => {
				if ((CARD_TYPES as readonly string[]).includes(v)) this.answer.type = v as CardType;
			}));
		new Setting(contentEl)
			.setName(t("zettel.modal.source"))
			.setDesc(t("zettel.modal.source.desc"))
			.addText((text) => {
				text.onChange((v) => (this.answer.source = v));
				enter(text.inputEl);
			});
		new Setting(contentEl)
			.setName(t("zettel.modal.tags"))
			.setDesc(t("zettel.modal.tags.desc"))
			.addText((text) => {
				text.onChange((v) => (this.tagText = v));
				enter(text.inputEl);
			});
		if (this.opts.luhmann) {
			new Setting(contentEl)
				.setName(t("zettel.modal.parent"))
				.setDesc(t("zettel.modal.parent.desc"))
				.addText((text) => {
					text.onChange((v) => (this.answer.parent = v.trim()));
					enter(text.inputEl);
				});
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("zettel.modal.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("zettel.modal.create")).setCta().onClick(() => this.submit()));
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
		el.createDiv({ text: card.title ? `${card.id} · ${card.title}` : card.id });
		el.createDiv({ text: match.item.where, cls: match.item.orphaned ? "notebook-zettel-list-orphan" : "notebook-picker-path" });
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
		this.setTitle(t("zettel.slipBox.confirmTitle"));
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("zettel.modal.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("zettel.slipBox.confirm")).setCta().onClick(() => {
				this.close();
				this.onConfirm();
			}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
