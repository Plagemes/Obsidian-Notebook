// The Zettelkasten hygiene report (roadmap Z10): a read-only dialog on the modal shell that lists cards nothing links to,
// likely duplicates and cards without a title, each with "Open". Opening and scanning never write a file. A fixing action
// (add a title, link two cards, move a duplicate to the trash) is a separate button that asks first, then goes through the
// service (the card writer) or `app.fileManager.trashFile`.
import { FuzzySuggestModal, Modal, Notice, type App, type FuzzyMatch } from "obsidian";
import { t } from "../i18n";
import { PromptModal } from "../library/library-modals";
import { confirmDestructive } from "../ui/destructive";
import { modalShell, shellButton, shellNote, shellSection } from "../ui/components/modal-shell";
import type { CardRecord } from "./card-content";
import { scanHygiene, type DuplicateGroup, type DuplicateReason, type HygieneCard, type HygieneReport } from "./hygiene";
import type { ZettelService } from "./service";

/** Rows drawn per section: a big vault never builds thousands of rows on a tablet. */
export const MAX_ROWS = 100;

/** A row button: icon, label, help line (the tooltip), what it does. */
type Action = [icon: string, label: string, help: string, run: () => void];

const REASON_LABEL = {
	title: "hygiene.reason.title",
	page: "hygiene.reason.page",
	text: "hygiene.reason.text",
} as const satisfies Record<DuplicateReason, string>;

/** Link graph restricted to what the checks need: edges that start or end at a card (notes only, from the metadata cache). */
export function cardLinkGraph(app: App, cards: readonly HygieneCard[]): Map<string, Set<string>> {
	const paths = new Set(cards.map((c) => c.path));
	const out = new Map<string, Set<string>>();
	for (const [from, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
		const fromCard = paths.has(from);
		for (const to of Object.keys(targets)) {
			if (!to.toLowerCase().endsWith(".md") || to === from) continue;
			if (!fromCard && !paths.has(to)) continue;
			const set = out.get(from) ?? new Set<string>();
			set.add(to);
			out.set(from, set);
		}
	}
	return out;
}

class CardPicker extends FuzzySuggestModal<CardRecord> {
	constructor(app: App, private readonly choices: CardRecord[], placeholder: string, private readonly onPick: (card: CardRecord) => void) {
		super(app);
		this.modalEl.addClass("nb-ui", "notebook-card-list");
		this.setPlaceholder(placeholder);
		this.emptyStateText = t("zettel.list.empty");
	}

	getItems(): CardRecord[] {
		return this.choices;
	}

	getItemText(card: CardRecord): string {
		return `${card.id} ${card.title}`;
	}

	renderSuggestion(match: FuzzyMatch<CardRecord>, el: HTMLElement): void {
		el.addClass("nb-zk-card-row");
		el.createSpan({ cls: "nb-zk-card-id", text: match.item.id });
		el.createDiv({ cls: "nb-zk-card-title", text: match.item.title || match.item.id });
	}

	onChooseItem(card: CardRecord): void {
		this.onPick(card);
	}
}

/** A plain yes/no question (not destructive): Cancel and a primary button. */
class AskModal extends Modal {
	constructor(app: App, private readonly opts: { title: string; body: string; confirm: string }, private readonly onYes: () => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: this.opts.title, icon: "link", size: "narrow", cls: "nb-confirm" });
		shell.body.createEl("p", { cls: "nb-modal-text", text: this.opts.body });
		shellButton(shell.foot, "secondary", t("ui.modal.cancel"), () => this.close());
		shellButton(shell.foot, "primary", this.opts.confirm, () => {
			this.close();
			this.onYes();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class HygieneModal extends Modal {
	private report: HygieneReport | null = null;
	private progress = { done: 0, total: 0 };
	private run = 0;
	private shell: ReturnType<typeof modalShell> | null = null;
	private readonly dropped = new Set<string>();
	private failure = "";

	constructor(app: App, private readonly service: ZettelService) {
		super(app);
	}

	onOpen(): void {
		this.shell = modalShell(this, { title: t("hygiene.title"), subtitle: t("hygiene.subtitle"), icon: "list-checks", size: "wide", cls: "nb-hygiene-modal" });
		shellButton(this.shell.foot, "secondary", t("hygiene.rescan"), () => void this.scan(), { icon: "refresh-cw" });
		shellButton(this.shell.foot, "primary", t("hygiene.close"), () => this.close());
		void this.scan();
	}

	onClose(): void {
		this.run++;
		this.contentEl.empty();
	}

	private async scan(): Promise<void> {
		const mine = ++this.run;
		this.report = null;
		this.failure = "";
		this.dropped.clear();
		const cards = this.service.allCards();
		this.progress = { done: 0, total: cards.length };
		this.paint();
		try {
			const report = await scanHygiene({
				cards,
				outgoing: cardLinkGraph(this.app, cards),
				resolve: (card, link) => {
					const m = /^\[\[([^\]|#^]+)/.exec(link.trim());
					const dest = m ? this.app.metadataCache.getFirstLinkpathDest(m[1]!.trim(), card.path) : null;
					return dest?.path ?? null;
				},
				read: async (card) => {
					const file = this.app.vault.getFileByPath(card.path);
					return file ? this.app.vault.cachedRead(file) : null;
				},
				idle: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
				cancelled: () => this.run !== mine,
				progress: (done, total) => {
					this.progress = { done, total };
					if (done % 25 === 0 || done === total) this.paintProgress();
				},
			});
			if (this.run !== mine || !report) return;
			this.report = report;
		} catch (e) {
			if (this.run !== mine) return;
			this.failure = e instanceof Error ? e.message : String(e);
		}
		this.paint();
	}

	private paintProgress(): void {
		const note = this.shell?.body.querySelector(".nb-hyg-progress");
		if (note) note.textContent = t("hygiene.scanning", { done: String(this.progress.done), total: String(this.progress.total) });
	}

	private paint(): void {
		const body = this.shell?.body;
		if (!body) return;
		body.empty();
		if (this.failure) {
			shellNote(body, t("hygiene.failed", { message: this.failure }), "error");
			return;
		}
		const report = this.report;
		if (!report) {
			shellNote(body, t("hygiene.scanning", { done: String(this.progress.done), total: String(this.progress.total) })).addClass("nb-hyg-progress");
			return;
		}
		const keep = (c: HygieneCard) => !this.dropped.has(c.path);
		const unlinked = report.unlinked.filter(keep);
		const untitled = report.untitled.filter(keep);
		const duplicates = report.duplicates
			.map((g): DuplicateGroup => ({ ...g, cards: g.cards.filter(keep) }))
			.filter((g) => g.cards.length > 1);
		shellNote(body, t("hygiene.summary", { n: String(report.scanned) }));
		if (unlinked.length + untitled.length + duplicates.length === 0) {
			shellNote(body, t("hygiene.clean"));
			return;
		}

		this.section(body, t("hygiene.unlinked"), t("hygiene.unlinked.desc"), unlinked, (card) => [
			["link", t("hygiene.link"), t("hygiene.help.link"), () => this.askLink(card)],
		]);
		this.section(body, t("hygiene.untitled"), t("hygiene.untitled.desc"), untitled, (card) => [
			["pencil", t("hygiene.addTitle"), t("hygiene.help.addTitle"), () => this.askTitle(card)],
		]);
		if (duplicates.length > 0) {
			const list = shellSection(body, `${t("hygiene.duplicates")} (${duplicates.length})`, "nb-hyg-section");
			list.parentElement?.insertBefore(createDiv({ cls: "nb-modal-note", text: t("hygiene.duplicates.desc") }), list);
			for (const group of duplicates.slice(0, MAX_ROWS)) {
				const box = list.createDiv({ cls: "nb-hyg-group" });
				box.createDiv({ cls: "nb-hyg-reasons", text: group.reasons.map((r) => t(REASON_LABEL[r])).join(" · ") });
				for (const card of group.cards) this.rowIn(box, card, [["trash-2", t("hygiene.trash"), t("hygiene.help.trash"), () => this.askTrash(card)]]);
			}
			this.more(list, duplicates.length);
		}
	}

	private section(
		body: HTMLElement, title: string, desc: string, cards: readonly HygieneCard[],
		actionsFor: (card: HygieneCard) => Action[],
	): void {
		if (cards.length === 0) return;
		const list = shellSection(body, `${title} (${cards.length})`, "nb-hyg-section");
		list.parentElement?.insertBefore(createDiv({ cls: "nb-modal-note", text: desc }), list);
		for (const card of cards.slice(0, MAX_ROWS)) this.rowIn(list, card, actionsFor(card));
		this.more(list, cards.length);
	}

	private more(list: HTMLElement, total: number): void {
		if (total > MAX_ROWS) list.createDiv({ cls: "nb-modal-note", text: t("hygiene.more", { n: String(total - MAX_ROWS) }) });
	}

	private rowIn(list: HTMLElement, card: HygieneCard, actions: Action[]): void {
		const row = list.createDiv({ cls: "nb-hyg-row" });
		row.createSpan({ cls: "nb-zk-card-id", text: card.id });
		const text = row.createDiv({ cls: "nb-hyg-text" });
		text.createDiv({ cls: "nb-hyg-title", text: card.title || card.id });
		text.createDiv({ cls: "nb-hyg-path", text: card.path });
		const buttons = row.createDiv({ cls: "nb-hyg-actions" });
		const open = shellButton(buttons, "secondary", t("hygiene.open"), () => {
			this.close();
			void this.service.openCardNote(card as CardRecord);
		}, { icon: "external-link" });
		open.title = t("hygiene.help.open");
		open.setAttribute("aria-label", `${t("hygiene.open")}: ${card.title || card.id}`);
		for (const [icon, label, help, run] of actions) {
			const b = shellButton(buttons, icon === "trash-2" ? "danger" : "secondary", label, run, { icon });
			b.title = help;
			b.setAttribute("aria-label", `${label}: ${card.title || card.id}`);
		}
	}

	private askTitle(card: HygieneCard): void {
		new PromptModal(this.app, { title: t("hygiene.titlePrompt", { id: card.id }), label: t("zettel.modal.cardTitle"), value: "", cta: t("zettel.titleModal.save") }, (title) => {
			void this.service.retitleCard(card as CardRecord, title).then(() => {
				this.dropped.add(card.path);
				this.paint();
			});
		}).open();
	}

	private askLink(card: HygieneCard): void {
		const choices = this.service.allCards().filter((c) => c.path !== card.path);
		new CardPicker(this.app, choices, t("hygiene.pick", { id: card.id }), (other) => {
			new AskModal(this.app, {
				title: t("hygiene.link.confirmTitle"),
				body: t("hygiene.link.confirmBody", { a: card.title || card.id, b: other.title || other.id }),
				confirm: t("hygiene.link.confirm"),
			}, () => {
				void this.service.linkCardPair(card as CardRecord, other).then((done) => {
					new Notice(done ? t("hygiene.linked") : t("hygiene.linkNone"));
					this.dropped.add(card.path);
					this.dropped.add(other.path);
					this.paint();
				});
			}).open();
		}).open();
	}

	private askTrash(card: HygieneCard): void {
		const file = this.app.vault.getFileByPath(card.path);
		if (!file) return;
		confirmDestructive(this.app, {
			title: t("hygiene.trash.confirmTitle"),
			body: t("hygiene.trash.confirmBody", { name: file.basename, path: file.path }),
			confirm: t("hygiene.trash"),
			cancel: t("ui.modal.cancel"),
		}, () => {
			void this.app.fileManager.trashFile(file).then(() => {
				new Notice(t("hygiene.trashed", { name: file.basename }));
				this.dropped.add(card.path);
				this.paint();
			});
		});
	}
}

/** Opens the report. Reading only: the scan never writes a file. */
export function openHygiene(app: App, service: ZettelService): void {
	new HygieneModal(app, service).open();
}
