import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { chip } from "../ui/components/chip";
import { iconButton, setIconSafe, subjectVars } from "../ui/components/dom";
import { emptyState, type EmptyStateAction } from "../ui/components/empty-state";
import { drawSafely } from "../ui/components/error-card";
import type { InboxItem } from "./inbox-items";
import type { InboxService } from "./inbox-service";
import type { CardType } from "./card-content";
import { CardListModal, CardModal, type CardAnswer, type CardListItem } from "./modals";
import { emptyArt, headerArt, itemIcon, notebookColor, sourceIcon } from "./zk-ui";

export const INBOX_VIEW_TYPE = "notebook-inbox";

const PREVIEW_WIDTH = 520;
/** Narrower than this (CSS px) the view uses the phone layout. */
const PHONE_PX = 600;

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
 *
 * 0.13: drawn with the design system (DESIGN.md §3, §4): a page header with the count, filter chips, one panel per notebook
 * in its subject colour, item rows that expand in place, and empty states that teach what arrives here.
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
	private headerArtEl!: HTMLElement;
	private offChange: (() => void) | null = null;
	private resizeObserver: ResizeObserver | null = null;

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
		// nb-ui: the scope of the design-system styles (styles.css), above Obsidian's own button and input rules.
		root.addClass("notebook-inbox", "nb-app", "nb-ui");
		const scroll = root.createDiv({ cls: "nb-zk-scroll" });
		const header = scroll.createEl("header", { cls: "nb-page-header nb-zk-header" });
		this.headerArtEl = header.createDiv({ cls: "nb-header-art is-hidden", attr: { "aria-hidden": "true" } });
		const titles = header.createDiv({ cls: "nb-header-titles" });
		titles.createEl("h1", { text: t("inbox.title"), cls: "nb-page-title notebook-inbox-heading" });
		this.summaryEl = titles.createDiv({ cls: "nb-page-subtitle notebook-inbox-summary", attr: { "aria-live": "polite" } });
		const tools = header.createDiv({ cls: "nb-header-tools" });
		const actions = tools.createDiv({ cls: "nb-header-buttons notebook-inbox-actions" });
		const start = actions.createEl("button", { cls: "nb-pill-btn mod-cta nb-zk-start", attr: { type: "button" } });
		setIconSafe(start.createSpan({ attr: { "aria-hidden": "true" } }), "play");
		start.createSpan({ text: t("inbox.start") });
		start.addEventListener("click", () => this.startProcessing());
		iconButton(actions, "refresh-cw", t("inbox.refresh"), () => void this.scan(), "nb-zk-refresh");
		this.filterEl = scroll.createDiv({ cls: "nb-zk-filters notebook-inbox-filter" });
		const hint = scroll.createEl("p", { cls: "nb-zk-hint notebook-inbox-hint" });
		setIconSafe(hint.createSpan({ cls: "nb-zk-hint-icon", attr: { "aria-hidden": "true" } }), "archive");
		hint.createSpan({ text: t("inbox.hint") });
		this.listEl = scroll.createDiv({ cls: "nb-zk-list notebook-inbox-list" });
		this.paintHeaderArt();
		this.resizeObserver = new ResizeObserver(() => {
			const w = root.clientWidth;
			if (w > 0) root.toggleClass("is-phone", w < PHONE_PX);
		});
		this.resizeObserver.observe(root);
		root.toggleClass("is-phone", root.clientWidth > 0 && root.clientWidth < PHONE_PX);
		this.offChange = this.service.onChange(() => {
			if (!this.scanning) this.render();
		});
		this.render();
		await this.scan();
	}

	/** Decoration only (DESIGN.md §2.6): a faint line-art band behind the title; absent with reduced effects. */
	private paintHeaderArt(): void {
		const art = headerArt("inbox:header");
		this.headerArtEl.toggleClass("is-hidden", !art);
		if (art) this.headerArtEl.setCssProps({ "--nb-art": `url("${art}")` });
	}

	onClose(): Promise<void> {
		this.offChange?.();
		this.offChange = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
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
		drawSafely(this.filterEl, "inbox filters", t("inbox.part.filters"), () => this.renderFilters(all, open));
		this.listEl.empty();
		drawSafely(this.listEl, "inbox list", t("inbox.part.list"), () => this.renderList(all));
	}

	private renderFilters(all: readonly InboxItem[], open: readonly InboxItem[]): void {
		this.filterEl.toggleClass("is-hidden", all.length === 0);
		const sources = [...new Set(all.map((i) => i.source))];
		const row = this.filterEl.createDiv({ cls: "nb-chips" });
		if (sources.length > 1) {
			const pick = (id: string | null) => () => {
				this.sourceFilter = id;
				this.render();
			};
			chip(row, { label: t("inbox.filter.all"), icon: "layers", count: open.length, active: this.sourceFilter === null, key: "source:all", onClick: pick(null) });
			for (const id of sources) {
				chip(row, { label: sourceLabel(id), icon: sourceIcon(id), count: open.filter((i) => i.source === id).length, active: this.sourceFilter === id, key: `source:${id}`, onClick: pick(id) });
			}
		}
		// A toggle, not a filter: the processed items join the list.
		const toggle = chip(row, {
			label: t("inbox.showProcessed"), icon: "check-check", active: this.showProcessed, key: "processed",
			onClick: () => {
				this.showProcessed = !this.showProcessed;
				this.render();
			},
		});
		toggle.addClass("nb-zk-toggle");
	}

	private renderList(all: readonly InboxItem[]): void {
		const items = this.visible();
		if (items.length === 0) {
			if (this.scanning) this.renderSkeleton();
			else this.renderEmpty(all.length === 0);
			return;
		}
		// One panel per notebook (the items arrive sorted by source, then notebook, then reading order).
		const groups: { key: string; first: InboxItem; items: InboxItem[]; open: number }[] = [];
		for (const item of items) {
			const key = `${item.source}|${item.notebookPath}`;
			let g = groups[groups.length - 1];
			if (g?.key !== key) {
				g = { key, first: item, items: [], open: 0 };
				groups.push(g);
			}
			g.items.push(item);
			if (this.service.status(item).status === "open") g.open++;
		}
		for (const g of groups) {
			const panel = this.listEl.createDiv({ cls: "nb-panel nb-zk-group" });
			subjectVars(panel, notebookColor(g.first.notebookName));
			this.renderGroupHeader(panel, g.first, g.open);
			const rows = panel.createDiv({ cls: "nb-zk-rows" });
			for (const item of g.items) this.renderItem(rows, item);
		}
	}

	private renderGroupHeader(panel: HTMLElement, item: InboxItem, open: number): void {
		const head = panel.createDiv({ cls: "nb-zk-group-head" });
		setIconSafe(head.createDiv({ cls: "nb-icon-square is-small", attr: { "aria-hidden": "true" } }), sourceIcon(item.source));
		const text = head.createDiv({ cls: "nb-zk-group-text" });
		text.createEl("h3", { text: item.notebookName, cls: "nb-zk-group-title notebook-inbox-group" });
		if (sourceLabel(item.source) !== item.notebookName) text.createDiv({ text: sourceLabel(item.source), cls: "nb-zk-group-meta" });
		if (open > 0) {
			const label = t("inbox.summary", { n: String(open) });
			head.createSpan({ text: String(open), cls: "nb-count-pill", attr: { "aria-label": label, title: label } });
		}
	}

	/** Placeholder rows while the first scan runs: shapes only, never controls. */
	private renderSkeleton(): void {
		const box = this.listEl.createDiv({ cls: "nb-panel nb-zk-skeleton", attr: { "aria-hidden": "true" } });
		for (let i = 0; i < 3; i++) {
			const row = box.createDiv({ cls: "nb-zk-skel-row" });
			row.createDiv({ cls: "nb-zk-skel-icon" });
			const lines = row.createDiv({ cls: "nb-zk-skel-lines" });
			lines.createDiv({ cls: "nb-zk-skel-line" });
			lines.createDiv({ cls: "nb-zk-skel-line is-short" });
		}
	}

	/** DESIGN.md §5: an empty inbox teaches what arrives here; a cleared one says so and offers the next step. */
	private renderEmpty(nothingAtAll: boolean): void {
		const refresh: EmptyStateAction = { icon: "refresh-cw", label: t("inbox.refresh"), key: "refresh", onClick: () => void this.scan() };
		const wrap = this.listEl.createDiv({ cls: "nb-zk-empty" });
		if (nothingAtAll) {
			emptyState(wrap, { art: emptyArt("inbox:empty"), icon: "inbox", title: t("inbox.empty.title"), body: t("inbox.empty.body"), primary: refresh });
			return;
		}
		const more: EmptyStateAction[] = [];
		if (!this.showProcessed) {
			more.push({
				icon: "check-check", label: t("inbox.showProcessed"), key: "show-processed",
				onClick: () => {
					this.showProcessed = true;
					this.render();
				},
			});
		}
		if (this.sourceFilter) {
			more.push({
				icon: "layers", label: t("inbox.showAllSources"), key: "all-sources",
				onClick: () => {
					this.sourceFilter = null;
					this.render();
				},
			});
		}
		const [primary, ...rest] = more.length > 0 ? more : [refresh];
		emptyState(wrap, {
			art: emptyArt("inbox:done"), icon: "check-check", title: t("inbox.caughtUp.title"), body: t("inbox.caughtUp.body"),
			primary, secondary: more.length > 0 ? [...rest, refresh] : [],
		});
	}

	private describe(item: InboxItem): string {
		const place = t("inbox.place", { n: String(item.pageIndex + 1) });
		if (item.origin) return `${place} · ${item.origin.pdfName}, ${t("inbox.place", { n: String(item.origin.pdfPage) })}`;
		return place;
	}

	private renderItem(parent: HTMLElement, item: InboxItem): void {
		const status = this.service.status(item);
		const selected = this.selected === item.key;
		const done = status.status !== "open";
		const row = parent.createDiv({ cls: `nb-zk-item notebook-inbox-item${selected ? " is-selected" : ""}${done ? " is-done" : ""}` });
		const head = row.createEl("button", { cls: "nb-zk-item-head notebook-inbox-item-head", attr: { type: "button", "aria-expanded": String(selected) } });
		setIconSafe(head.createSpan({ cls: "nb-icon-square is-small nb-zk-item-icon", attr: { "aria-hidden": "true" } }), done ? "check" : itemIcon(item));
		const body = head.createSpan({ cls: "nb-zk-item-body" });
		const snippet = item.text.replace(/\s+/g, " ").trim();
		body.createSpan({ text: snippet ? (snippet.length > 90 ? `${snippet.slice(0, 90)}…` : snippet) : t(item.kind === "pdf-highlight" ? "inbox.kind.highlight" : "inbox.kind.writing"), cls: "nb-zk-item-text notebook-inbox-item-text" });
		body.createSpan({ text: this.describe(item), cls: "nb-zk-item-meta notebook-inbox-item-place" });
		const badges = head.createSpan({ cls: "nb-zk-item-badges" });
		if (status.status === "open" && status.changed) badges.createSpan({ text: t("inbox.changed"), cls: "nb-pill is-accent notebook-inbox-item-badge" });
		if (done) badges.createSpan({ text: this.stateText(status), cls: "nb-pill is-subject notebook-inbox-item-badge" });
		setIconSafe(head.createSpan({ cls: "nb-chevron nb-zk-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
		head.addEventListener("click", () => {
			this.selected = selected ? null : item.key;
			this.render();
		});
		if (!selected) return;
		const panel = row.createDiv({ cls: "nb-zk-panel notebook-inbox-panel" });
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
		const frame = panel.createDiv({ cls: "nb-zk-preview-frame" });
		const img = frame.createEl("img", { cls: "nb-zk-preview notebook-inbox-preview", attr: { alt: t("zettel.modal.preview") } });
		const side = panel.createDiv({ cls: "nb-zk-panel-side" });
		const textEl = side.createDiv({ cls: "nb-zk-text notebook-inbox-text" });
		const covering = this.service.coveringCards(item);
		if (open && covering.length > 0) {
			const box = side.createDiv({ cls: "nb-zk-covered notebook-inbox-covered" });
			for (const card of covering) {
				const line = box.createDiv({ cls: "nb-zk-covered-line" });
				setIconSafe(line.createSpan({ cls: "nb-zk-covered-icon", attr: { "aria-hidden": "true" } }), "link");
				line.createSpan({ text: t("inbox.covered", { card: card.title ? `${card.id} ${card.title}` : card.id }), cls: "nb-zk-covered-text" });
				const openBtn = line.createEl("button", { text: t("inbox.openCard"), cls: "nb-pill-btn is-small", attr: { type: "button" } });
				openBtn.addEventListener("click", () => this.service.openCard(card.path));
				const mark = line.createEl("button", { text: t("inbox.markCovered"), cls: "nb-pill-btn is-small", attr: { type: "button" } });
				mark.addEventListener("click", () => void this.run(item, () => this.service.markCovered(item, card)));
			}
		}
		const bar = side.createDiv({ cls: "nb-zk-actions notebook-inbox-buttons" });
		const button = (text: string, icon: string, fn: () => void, cta = false) => {
			const b = bar.createEl("button", { cls: `nb-pill-btn${cta ? " mod-cta" : ""}`, attr: { type: "button" } });
			setIconSafe(b.createSpan({ attr: { "aria-hidden": "true" } }), icon);
			b.createSpan({ text });
			b.addEventListener("click", fn);
			return b;
		};
		if (open) {
			const literature = item.cardType === "literature";
			button(t(literature ? "inbox.action.literature" : "inbox.action.permanent"), literature ? "book-open" : "file-text", () => void this.makeCard(item, item.cardType, img.src), true);
			if (literature) button(t("inbox.action.permanent"), "file-text", () => void this.makeCard(item, "permanent", img.src));
			button(t("inbox.action.link"), "link", () => this.linkExisting(item));
			button(t("inbox.action.discard"), "x", () => void this.run(item, () => this.service.discard(item)));
			button(t("inbox.action.skip"), "arrow-right", () => this.advance(item));
		} else {
			button(t("inbox.action.reopen"), "rotate-ccw", () => void this.run(item, () => this.service.reopen(item), false));
			const status = this.service.status(item);
			if (status.status !== "open" && "entry" in status && status.entry.path) button(t("inbox.openCard"), "file-text", () => this.service.openCard(status.entry.path!));
		}
		button(t("inbox.action.open"), "layers", () => this.service.openItem(item));

		const [src, text] = await Promise.all([this.service.preview(item, PREVIEW_WIDTH), this.service.textOf(item)]);
		if (ticket !== this.token || !panel.isConnected) return;
		if (src) img.src = src;
		else frame.remove();
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
