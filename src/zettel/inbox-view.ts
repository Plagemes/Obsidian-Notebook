import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { InboxItem } from "./inbox-items";
import type { InboxService } from "./inbox-service";
import type { CardType } from "./card-content";
import { CardListModal, CardModal, type CardAnswer, type CardListItem } from "./modals";

export const INBOX_VIEW_TYPE = "notebook-inbox";

const PREVIEW_WIDTH = 520;

const SOURCE_LABEL: Record<string, MessageKey> = {
	"loose-sheet": "inbox.source.looseSheet",
	pdf: "inbox.source.pdf",
};

function sourceLabel(id: string): string {
	const key = SOURCE_LABEL[id];
	return key ? t(key) : id;
}

/**
 * The Inbox (Z4): everything still to process, and a guided way through it. Selecting an item opens its panel (the ink, the
 * text, what can be done); after an action the next open item is selected. Looking at the list never writes anything.
 */
export class InboxView extends ItemView {
	private selected: string | null = null;
	private showProcessed = false;
	private sourceFilter: string | null = null;
	private scanning = false;
	private progress = "";
	private busy = false;
	private token = 0;
	private listEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private filterEl!: HTMLElement;
	private offChange: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly service: InboxService, private readonly luhmann: () => boolean) {
		super(leaf);
		this.navigation = true;
	}

	getViewType(): string {
		return INBOX_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t("inbox.title");
	}

	getIcon(): string {
		return "inbox";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("notebook-inbox");
		const bar = root.createDiv({ cls: "notebook-inbox-bar" });
		bar.createEl("h2", { text: t("inbox.title"), cls: "notebook-inbox-heading" });
		this.summaryEl = bar.createDiv({ cls: "notebook-inbox-summary" });
		const actions = bar.createDiv({ cls: "notebook-inbox-actions" });
		const start = actions.createEl("button", { text: t("inbox.start"), cls: "mod-cta", attr: { type: "button" } });
		start.addEventListener("click", () => this.startProcessing());
		const refresh = actions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": t("inbox.refresh"), title: t("inbox.refresh") } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.scan());
		const label = root.createEl("label", { cls: "notebook-inbox-toggle" });
		const box = label.createEl("input", { attr: { type: "checkbox" } });
		box.addEventListener("change", () => {
			this.showProcessed = box.checked;
			this.render();
		});
		label.createSpan({ text: t("inbox.showProcessed") });
		this.filterEl = root.createDiv({ cls: "notebook-inbox-filter" });
		root.createEl("p", { text: t("inbox.hint"), cls: "setting-item-description notebook-inbox-hint" });
		this.listEl = root.createDiv({ cls: "notebook-inbox-list" });
		this.offChange = this.service.onChange(() => {
			if (!this.scanning) this.render();
		});
		this.render();
		await this.scan();
	}

	onClose(): Promise<void> {
		this.offChange?.();
		this.offChange = null;
		this.token++;
		return Promise.resolve();
	}

	/** Command: opens the view and selects the first open item. */
	async startFromCommand(): Promise<void> {
		await this.scan();
		this.startProcessing();
	}

	private async scan(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
		this.progress = "";
		this.render();
		try {
			await this.service.refresh((done, total) => {
				this.progress = t("inbox.scanning", { done: String(done), total: String(total) });
				this.summaryEl.setText(this.progress);
			});
		} finally {
			this.scanning = false;
			this.render();
		}
	}

	private visible(): InboxItem[] {
		return this.service.all.filter((i) => {
			if (this.sourceFilter && i.source !== this.sourceFilter) return false;
			return this.showProcessed || this.service.status(i).status === "open";
		});
	}

	private openItems(): InboxItem[] {
		return this.service.all.filter((i) => (!this.sourceFilter || i.source === this.sourceFilter) && this.service.status(i).status === "open");
	}

	private startProcessing(): void {
		const first = this.openItems()[0];
		this.selected = first?.key ?? null;
		if (!first) new Notice(t("inbox.nothing"));
		this.render();
		this.scrollToSelected();
	}

	/** The next open item after `from` (then from the top), or null. */
	private nextOpen(from: InboxItem): InboxItem | null {
		const open = this.openItems().filter((i) => i.key !== from.key);
		if (open.length === 0) return null;
		const all = this.service.all;
		const at = all.findIndex((i) => i.key === from.key);
		return open.find((i) => all.indexOf(i) > at) ?? open[0] ?? null;
	}

	private advance(from: InboxItem): void {
		this.selected = this.nextOpen(from)?.key ?? null;
		this.render();
		this.scrollToSelected();
		if (!this.selected) new Notice(t("inbox.allDone"));
	}

	private scrollToSelected(): void {
		window.requestAnimationFrame(() => this.listEl.querySelector(".is-selected")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
	}

	// ------------------------------------------------------------------- rendering

	private render(): void {
		if (!this.listEl) return;
		const all = this.service.all;
		const open = all.filter((i) => this.service.status(i).status === "open");
		this.summaryEl.setText(this.scanning ? this.progress || t("inbox.scanning", { done: "0", total: "…" }) : open.length > 0 ? t("inbox.summary", { n: String(open.length) }) : t("inbox.summaryNone"));

		this.filterEl.empty();
		const sources = [...new Set(all.map((i) => i.source))];
		if (sources.length > 1) {
			const chip = (id: string | null, text: string) => {
				const b = this.filterEl.createEl("button", { text, cls: `notebook-inbox-chip${this.sourceFilter === id ? " is-active" : ""}`, attr: { type: "button" } });
				b.addEventListener("click", () => {
					this.sourceFilter = id;
					this.render();
				});
			};
			chip(null, t("inbox.filter.all"));
			for (const id of sources) chip(id, `${sourceLabel(id)} (${open.filter((i) => i.source === id).length})`);
		}

		this.listEl.empty();
		const items = this.visible();
		if (items.length === 0 && !this.scanning) {
			this.listEl.createDiv({ cls: "notebook-inbox-empty", text: all.length === 0 ? t("inbox.empty") : t("inbox.summaryNone") });
			return;
		}
		let group = "";
		for (const item of items) {
			const heading = `${sourceLabel(item.source)} · ${item.notebookName}`;
			if (heading !== group) {
				group = heading;
				this.listEl.createEl("h3", { text: heading, cls: "notebook-inbox-group" });
			}
			this.renderItem(item);
		}
	}

	private describe(item: InboxItem): string {
		const place = `p. ${item.pageIndex + 1}`;
		if (item.origin) return `${place} · ${item.origin.pdfName}, p. ${item.origin.pdfPage}`;
		return place;
	}

	private renderItem(item: InboxItem): void {
		const status = this.service.status(item);
		const selected = this.selected === item.key;
		const row = this.listEl.createDiv({ cls: `notebook-inbox-item${selected ? " is-selected" : ""}${status.status === "open" ? "" : " is-done"}` });
		const head = row.createEl("button", { cls: "notebook-inbox-item-head", attr: { type: "button", "aria-expanded": String(selected) } });
		head.createSpan({ text: this.describe(item), cls: "notebook-inbox-item-place" });
		const snippet = item.text.replace(/\s+/g, " ").trim();
		head.createSpan({ text: snippet ? (snippet.length > 90 ? `${snippet.slice(0, 90)}…` : snippet) : t(item.kind === "pdf-highlight" ? "inbox.kind.highlight" : "inbox.kind.writing"), cls: "notebook-inbox-item-text" });
		if (status.status === "open" && status.changed) head.createSpan({ text: t("inbox.changed"), cls: "notebook-inbox-item-badge" });
		if (status.status !== "open") head.createSpan({ text: this.stateText(status), cls: "notebook-inbox-item-badge" });
		head.addEventListener("click", () => {
			this.selected = selected ? null : item.key;
			this.render();
		});
		if (!selected) return;
		const panel = row.createDiv({ cls: "notebook-inbox-panel" });
		void this.fillPanel(panel, item, status.status === "open");
	}

	private stateText(status: ReturnType<InboxService["status"]>): string {
		if (status.status === "open") return "";
		if (status.status === "discarded") return t("inbox.state.discarded");
		if (status.status === "card") return t("inbox.state.card", { id: status.entry.card ?? "" });
		return t("inbox.state.linked", { id: status.entry.card ?? "" });
	}

	private async fillPanel(panel: HTMLElement, item: InboxItem, open: boolean): Promise<void> {
		const ticket = ++this.token;
		const img = panel.createEl("img", { cls: "notebook-inbox-preview", attr: { alt: t("zettel.modal.preview") } });
		const textEl = panel.createDiv({ cls: "notebook-inbox-text" });
		const covering = this.service.coveringCards(item);
		if (open && covering.length > 0) {
			const box = panel.createDiv({ cls: "notebook-inbox-covered" });
			for (const card of covering) {
				const line = box.createDiv();
				line.createSpan({ text: t("inbox.covered", { card: card.title ? `${card.id} ${card.title}` : card.id }) });
				const openBtn = line.createEl("button", { text: t("inbox.openCard"), attr: { type: "button" } });
				openBtn.addEventListener("click", () => this.service.openCard(card.path));
				const mark = line.createEl("button", { text: t("inbox.markCovered"), attr: { type: "button" } });
				mark.addEventListener("click", () => void this.run(item, () => this.service.markCovered(item, card)));
			}
		}
		const bar = panel.createDiv({ cls: "notebook-inbox-buttons" });
		const button = (text: string, fn: () => void, cta = false) => {
			const b = bar.createEl("button", { text, cls: cta ? "mod-cta" : "", attr: { type: "button" } });
			b.addEventListener("click", fn);
			return b;
		};
		if (open) {
			const literature = item.cardType === "literature";
			button(t(literature ? "inbox.action.literature" : "inbox.action.permanent"), () => void this.makeCard(item, item.cardType, img.src), true);
			if (literature) button(t("inbox.action.permanent"), () => void this.makeCard(item, "permanent", img.src));
			button(t("inbox.action.link"), () => this.linkExisting(item));
			button(t("inbox.action.discard"), () => void this.run(item, () => this.service.discard(item)));
			button(t("inbox.action.skip"), () => this.advance(item));
		} else {
			button(t("inbox.action.reopen"), () => void this.run(item, () => this.service.reopen(item), false));
			const status = this.service.status(item);
			if (status.status !== "open" && "entry" in status && status.entry.path) button(t("inbox.openCard"), () => this.service.openCard(status.entry.path!));
		}
		button(t("inbox.action.open"), () => this.service.openItem(item));

		const [src, text] = await Promise.all([this.service.preview(item, PREVIEW_WIDTH), this.service.textOf(item)]);
		if (ticket !== this.token || !panel.isConnected) return;
		if (src) img.src = src;
		else img.remove();
		textEl.setText(text || t("inbox.noText"));
		textEl.toggleClass("is-empty", !text);
	}

	// ------------------------------------------------------------------- actions

	/** Runs a write; on success the next open item is selected (unless `advance` is false). */
	private async run(item: InboxItem, action: () => Promise<boolean>, advance = true): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const ok = await action();
			if (!ok) return;
			if (advance) this.advance(item);
			else this.render();
		} finally {
			this.busy = false;
		}
	}

	private async makeCard(item: InboxItem, type: CardType, preview: string): Promise<void> {
		const defaults = await this.service.cardDefaults(item, type);
		new CardModal(this.app, { luhmann: this.luhmann(), preview: preview.startsWith("data:") ? preview : null, defaults }, (answer: CardAnswer | null) => {
			if (answer) void this.run(item, () => this.service.createCard(item, answer));
		}).open();
	}

	private linkExisting(item: InboxItem): void {
		const cards = this.service.cards();
		if (cards.length === 0) {
			new Notice(t("inbox.noCards"));
			return;
		}
		const list: CardListItem[] = cards.map((card) => ({ card, where: card.orphaned ? t("zettel.list.pageDeleted") : card.notebookLink.replace(/^\[\[|\]\]$/g, "").replace(/^.*\|/, ""), orphaned: card.orphaned }));
		new CardListModal(this.app, list, (chosen) => void this.run(item, () => this.service.link(item, chosen.card))).open();
	}
}
