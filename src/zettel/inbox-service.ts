import { Notice, type App, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { hint } from "../ui/hints";
import { openNotebookAtPage } from "../integration/open";
import { findLooseSheet } from "../library/loose-sheet";
import { renderThumbnail } from "../library/thumbnail";
import { backgroundRect } from "../model/margins";
import { parse } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { boxesOnPage } from "../pdf/text-items";
import { textUnderStroke } from "../pdf/annotations";
import type { NotebookSettings } from "../settings";
import { isNotebookFile, readNotebookText } from "../storage/format";
import { listNotebooks } from "../storage/notebooks";
import { sidecarDeviceId, vaultDeviceFileAdapter } from "../storage/vault-io";
import { NotebookMedia } from "../view/media";
import type { CardRecord } from "./card-content";
import {
	coveredBy, itemIdOf, looseSheetSource, pdfAnnotationSource, registeredInboxSources, sortItems, sourceLabel, suggestTitle, transcriptionText,
	type InboxEnv, type InboxItem, type InboxNotebook, type InboxSource,
} from "./inbox-items";
import { statusOf, type InboxEntry, type InboxOp, type ItemStatus } from "./inbox-state";
import { InboxBlockedError, InboxStore, type InboxFileAdapter } from "./inbox-store";
import type { CardAnswer } from "./modals";
import type { ZettelService } from "./service";

export interface InboxHost extends Plugin {
	settings: NotebookSettings;
}

export interface InboxSnapshot {
	items: InboxItem[];
	/** Notebooks the scan could not read are simply not listed; this says how many were looked at. */
	scanned: number;
}

/** Where the Inbox state lives, for a vault. */
function vaultInboxAdapter(app: App): InboxFileAdapter {
	return vaultDeviceFileAdapter(app);
}

/**
 * Processing flow (M15 Z4): finds the items to process, remembers what has been dealt with, and does the actions. Looking
 * never writes; only the explicit actions (discard, card, link, reopen) write, and only this device's Inbox file or a new
 * card note (through the Zettel service, as every other card).
 */
export class InboxService {
	readonly store: InboxStore;
	private items: InboxItem[] = [];
	private scanning: Promise<InboxSnapshot> | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly plugin: InboxHost, private readonly zettel: ZettelService) {
		this.store = new InboxStore(vaultInboxAdapter(plugin.app), () => plugin.settings.folder, sidecarDeviceId(plugin.app));
	}

	private get app(): App {
		return this.plugin.app;
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private changed(): void {
		for (const fn of this.listeners) fn();
	}

	/** The items found by the last scan, in reading order. */
	get all(): readonly InboxItem[] {
		return this.items;
	}

	status(item: InboxItem): ItemStatus {
		return statusOf(item, this.store.snapshot());
	}

	// ------------------------------------------------------------------- scanning

	private env(progress?: (done: number, total: number) => void): InboxEnv {
		const { app, plugin } = this;
		const loose = findLooseSheet(app, plugin.settings);
		const make = (file: TFile, looseSheet: boolean): InboxNotebook => ({
			path: file.path, name: file.basename, looseSheet,
			read: async (prefilter) => {
				try {
					const text = readNotebookText(file.extension, await app.vault.cachedRead(file));
					if (prefilter && !prefilter(text)) return null;
					const result = parse(text);
					return result.ok ? result.doc : null;
				} catch (e) {
					console.error("[notebook] inbox: could not read", file.path, e);
					return null;
				}
			},
		});
		return {
			notebooks: () => {
				const list = loose ? [make(loose, true)] : [];
				for (const f of listNotebooks(app, plugin.settings.folder)) if (f.path !== loose?.path) list.push(make(f, false));
				return list;
			},
			progress: async (done, total) => {
				progress?.(done, total);
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			},
		};
	}

	private sources(): InboxSource[] {
		return [looseSheetSource, pdfAnnotationSource, ...registeredInboxSources()];
	}

	/** Looks through the loose sheet and the notebooks again, and reads the saved state. Nothing is written. */
	refresh(progress?: (done: number, total: number) => void): Promise<InboxSnapshot> {
		this.scanning ??= (async () => {
			try {
				await this.store.load();
				const env = this.env(progress);
				const found: InboxItem[] = [];
				for (const source of this.sources()) {
					try {
						found.push(...(await source.collect(env)));
					} catch (e) {
						console.error("[notebook] inbox source", source.id, e);
					}
				}
				const seen = new Set<string>();
				this.items = sortItems(found.filter((i) => !seen.has(i.key) && !!seen.add(i.key)));
				this.changed();
				if (this.items.length > 0) hint("inbox-item");
				return { items: this.items, scanned: env.notebooks().length };
			} finally {
				this.scanning = null;
			}
		})();
		return this.scanning;
	}

	// ------------------------------------------------------------------- reading an item

	private fileOf(item: InboxItem): TFile | null {
		const f = this.app.vault.getFileByPath(item.notebookPath);
		return f && isNotebookFile(f) ? f : null;
	}

	private async docOf(item: InboxItem): Promise<NotebookDocument | null> {
		const file = this.fileOf(item);
		if (!file) return null;
		try {
			const result = parse(readNotebookText(file.extension, await this.app.vault.cachedRead(file)));
			return result.ok && result.doc.id === item.notebookId ? result.doc : null;
		} catch {
			return null;
		}
	}

	/** The ink of the item as a picture (data URL), or null. */
	async preview(item: InboxItem, width: number): Promise<string | null> {
		const doc = await this.docOf(item);
		const page = doc?.pages.find((p) => p.id === item.pageId);
		if (!page) return null;
		try {
			return renderThumbnail(page, width, item.region ? { region: item.region } : {}) || null;
		} catch {
			return null;
		}
	}

	/** The text of an item: typed text as found; for a PDF highlight, the PDF text under it (read when asked for). */
	async textOf(item: InboxItem): Promise<string> {
		if (item.kind !== "pdf-highlight") return item.text;
		if (item.text) return item.text;
		const doc = await this.docOf(item);
		const page = doc?.pages.find((p) => p.id === item.pageId);
		const bg = page?.background;
		const stroke = page?.strokes.find((s) => s.id === itemIdOf(item.key));
		if (!doc || !page || bg?.kind !== "pdf" || !stroke) return "";
		const media = new NotebookMedia(this.app, () => doc, () => this.plugin.settings.folder, () => undefined);
		try {
			const content = await media.pdf.pageText(bg.asset, bg.page);
			return textUnderStroke(stroke, boxesOnPage(content, backgroundRect(page)));
		} catch (e) {
			console.error("[notebook] inbox: PDF text", e);
			return "";
		} finally {
			media.destroy();
		}
	}

	/** Cards that already cover the item (same notebook and page, whole page or most of its region). */
	coveringCards(item: InboxItem): CardRecord[] {
		return this.zettel.allCards().filter((c) => c.notebookId === item.notebookId && c.pageId === item.pageId && !c.orphaned && coveredBy(item, c.region));
	}

	openItem(item: InboxItem): void {
		const file = this.fileOf(item);
		if (!file) {
			new Notice(t("inbox.notebookGone", { path: item.notebookPath }));
			return;
		}
		void openNotebookAtPage(this.app, file, item.pageIndex + 1);
	}

	// ------------------------------------------------------------------- actions (the only writers)

	private async write(ops: InboxOp | InboxOp[]): Promise<boolean> {
		try {
			await this.store.update(ops);
			this.changed();
			return true;
		} catch (e) {
			if (e instanceof InboxBlockedError) new Notice(t("inbox.blocked", { path: this.store.ownPath, error: e.message }), 10000);
			else new Notice(t("inbox.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
			console.error("[notebook] inbox", e);
			return false;
		}
	}

	private entry(item: InboxItem, state: InboxEntry["state"], extra: Partial<InboxEntry> = {}): InboxOp {
		return { type: "set", entry: { key: item.key, state, at: Date.now(), sig: item.sig, ...extra } };
	}

	/** Discard: the item is marked processed. Nothing is deleted from the notebook. */
	discard(item: InboxItem): Promise<boolean> {
		return this.write(this.entry(item, "discarded"));
	}

	/** Link to an existing card: the item is marked processed and remembers the card. */
	link(item: InboxItem, card: CardRecord): Promise<boolean> {
		return this.write(this.entry(item, "linked", { card: card.id, path: card.path }));
	}

	/** An existing card already covers the item. */
	markCovered(item: InboxItem, card: CardRecord): Promise<boolean> {
		return this.write(this.entry(item, "card", { card: card.id, path: card.path }));
	}

	reopen(item: InboxItem): Promise<boolean> {
		return this.write(this.entry(item, "open"));
	}

	/** Defaults for the card dialog: typed title, type, source (the PDF and page for a literature card). */
	async cardDefaults(item: InboxItem, type: CardAnswer["type"]): Promise<Partial<CardAnswer>> {
		const text = await this.textOf(item);
		return { title: suggestTitle(text), type, source: type === "literature" ? sourceLabel(item) : "" };
	}

	/** Turns the item into a card (the answers come from the card dialog) and marks it processed. */
	async createCard(item: InboxItem, answer: CardAnswer): Promise<boolean> {
		const file = this.fileOf(item);
		const doc = await this.docOf(item);
		if (!file || !doc || !doc.pages.some((p) => p.id === item.pageId)) {
			new Notice(t("inbox.pageGone"));
			return false;
		}
		const text = await this.textOf(item);
		const note = await this.zettel.createCardFor(file, doc, item.pageId, item.region, answer, transcriptionText(item, text));
		if (!note) return false;
		const card = this.zettel.allCards().find((c) => c.path === note.path);
		new Notice(t("zettel.created", { name: note.basename }));
		return this.write(this.entry(item, "card", { card: card?.id ?? answer.title, path: note.path }));
	}

	openCard(path: string): void {
		const card = this.zettel.allCards().find((c) => c.path === path);
		if (card) void this.zettel.openCardNote(card);
		else {
			const f = this.app.vault.getFileByPath(path);
			if (f) void this.app.workspace.getLeaf("tab").openFile(f);
		}
	}

	cards(): CardRecord[] {
		return this.zettel.allCards().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
	}
}
