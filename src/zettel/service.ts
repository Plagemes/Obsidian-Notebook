import { getFrontMatterInfo, normalizePath, Notice, parseYaml, stringifyYaml, TFile, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import { InputWatch } from "../integration/companion";
import { openNotebookAtPage, viewsOf } from "../integration/open";
import type { CompanionTextDeps } from "../model/companion-content";
import { createDocument } from "../model/document";
import { parse } from "../model/serialize";
import { PAPER_SPACING, type NotebookDocument } from "../model/types";
import type { NotebookSettings } from "../settings";
import { isNotebookFile, readNotebookText } from "../storage/format";
import { quickDocId } from "../storage/history";
import { createNotebook } from "../storage/notebooks";
import { ensureFolder } from "../storage/vault-io";
import { NotebookView, VIEW_TYPE } from "../view/notebook-view";
import { arrowLink, type CardArea } from "./arrows";
import {
	addLinks, CARD_LINKS_KEY, cardProperties, editProperties, newCardText, orphanChanges, readCard, titleChanges,
	type CardRecord, type NewCard,
} from "./card-content";
import { PromptModal } from "../library/library-modals";
import { cardFileName, idSet, localDate, nextCardId } from "./ids";
import { CardListModal, CardModal, ConfirmCardsModal, type CardAnswer, type CardListItem } from "./modals";
import { CardOverlay, type OverlaySource } from "./overlay";
import { A6_PAGE } from "./settings";
import { regionFromBounds, type Region } from "./subpath";
import { renderThumbnail } from "../library/thumbnail";

export interface ZettelHost extends Plugin {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
}

/** After this device's own save of an open notebook (new slip-box page, arrow, deleted page). */
const LOCAL_DELAY_MS = 4_000;
/** After any other change (sync, another app): the other device's card writes usually arrive first. */
const REMOTE_DELAY_MS = 30_000;
const INPUT_POLL_MS = 1_000;
/** At most this many slip-box cards are created automatically in one go. */
const MAX_AUTO_CARDS = 20;

const TEXT_DEPS: CompanionTextDeps = {
	frontmatterInfo: (text) => getFrontMatterInfo(text),
	parseFrontmatter: (yaml) => {
		try {
			const data: unknown = parseYaml(yaml);
			if (data === null || data === undefined) return {};
			return typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	},
	stringify: (data) => stringifyYaml(data),
};

/**
 * Zettelkasten core (M15: Z1, Z2, Z3, Z11, Z12).
 *
 * - Cards are Markdown notes; the plugin finds them through the metadata cache (frontmatter `zettel-id`,
 *   `notebook-id`, `page-id`, `region`) and keeps an in-memory index. Nothing about cards is stored in the
 *   notebook file, so the document format does not change and cards follow their page when it moves.
 * - Writes: a card is created only on an explicit action, or (slip-box) after this device's own save that
 *   added a page; afterwards only the `orphaned` flag and the drawn `links` are ever written, with one
 *   `vault.process` and only when the value really changes. The body is never touched after creation and
 *   a card is never deleted.
 * - Automatic work waits until no pointer has been down in a notebook view for a moment (as companion notes)
 *   and listens only to notebook files; changes of `.md` files only update the index (no loops).
 */
export class ZettelService implements OverlaySource {
	private readonly cards = new Map<string, CardRecord>();
	private readonly input = new InputWatch();
	private readonly timers = new Map<string, number>();
	/** Notebooks whose pending check was started by this device's own save. */
	private readonly own = new Set<string>();
	private chain: Promise<unknown> = Promise.resolve();
	private readonly overlays = new Map<NotebookView, CardOverlay>();
	/** Per document id: shape strokes already seen, so only arrows drawn since are linked automatically. */
	private readonly seenShapes = new Map<string, Set<string>>();
	/** `<doc id>/<page id>` of slip-box cards being created (the metadata cache lags behind `vault.create`). */
	private readonly creating = new Set<string>();
	private readonly reported = new Set<string>();
	private disposed = false;

	constructor(private readonly plugin: ZettelHost) {}

	private get app(): App {
		return this.plugin.app;
	}

	private get settings(): NotebookSettings {
		return this.plugin.settings;
	}

	register(): void {
		const { plugin, app } = this;
		this.input.attach(plugin, document);
		plugin.registerEvent(app.workspace.on("window-open", (win) => this.input.attach(plugin, win.doc)));
		app.workspace.onLayoutReady(() => {
			for (const file of app.vault.getMarkdownFiles()) this.indexFile(file);
			plugin.registerEvent(app.metadataCache.on("changed", (file) => {
				if (this.indexFile(file)) this.refreshOverlays();
			}));
			plugin.registerEvent(app.vault.on("delete", (f) => {
				if (this.cards.delete(f.path)) this.refreshOverlays();
			}));
			plugin.registerEvent(app.vault.on("rename", (f, oldPath) => {
				const had = this.cards.delete(oldPath);
				if ((f instanceof TFile && this.indexFile(f)) || had) this.refreshOverlays();
			}));
			this.attachOverlays();
		});
		plugin.registerEvent(app.workspace.on("layout-change", () => this.attachOverlays()));
		plugin.registerEvent(app.workspace.on("active-leaf-change", () => this.refreshOverlays()));
		plugin.registerEvent(app.vault.on("modify", (f) => {
			if (f instanceof TFile && isNotebookFile(f)) void this.afterModify(f);
		}));
		plugin.register(() => this.dispose());
	}

	dispose(): void {
		this.disposed = true;
		for (const handle of this.timers.values()) window.clearTimeout(handle);
		this.timers.clear();
		for (const overlay of this.overlays.values()) overlay.detach();
		this.overlays.clear();
	}

	// ------------------------------------------------------------------- index

	/** Updates the index entry of one note; true when a card was added, changed or removed. */
	private indexFile(file: TFile): boolean {
		if (file.extension !== "md") return false;
		const fm: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const card = readCard(file.path, typeof fm === "object" && fm !== null ? (fm as Record<string, unknown>) : null);
		const before = this.cards.get(file.path);
		if (!card) return this.cards.delete(file.path);
		this.cards.set(file.path, card);
		return JSON.stringify(before) !== JSON.stringify(card);
	}

	/** Cards with this notebook id, sorted by id. */
	cardsOf(docId: string): CardRecord[] {
		return [...this.cards.values()].filter((c) => c.notebookId === docId).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
	}

	/** The notebook a card's `notebook` link resolves to (null when it resolves to none). */
	private linkedNotebook(card: CardRecord): TFile | null {
		const m = /^\[\[([^\]|#]+)/.exec(card.notebookLink);
		if (!m) return null;
		const f = this.app.metadataCache.getFirstLinkpathDest(m[1]!.trim(), card.path);
		return f && isNotebookFile(f) ? f : null;
	}

	/** Whether a card belongs to this notebook file: its link points here, or (moved outside Obsidian) to no notebook. */
	private belongs(card: CardRecord, file: TFile): boolean {
		const linked = this.linkedNotebook(card);
		return linked === null || linked === file;
	}

	private cardsOfFile(file: TFile, docId: string): CardRecord[] {
		return this.cardsOf(docId).filter((c) => this.belongs(c, file));
	}

	// ------------------------------------------------------------------- overlays

	show(): boolean {
		return this.settings.zettelShowRegions;
	}

	visibleCards(view: NotebookView, docId: string): CardRecord[] {
		const file = view.file;
		return file ? this.cardsOfFile(file, docId).filter((c) => !c.orphaned) : [];
	}

	seen(view: NotebookView): void {
		const doc = view.document;
		if (doc && !this.seenShapes.has(doc.id)) this.seenShapes.set(doc.id, shapeIds(doc));
	}

	private attachOverlays(): void {
		if (this.disposed) return;
		const live = new Set<NotebookView>();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (!(leaf.view instanceof NotebookView)) continue;
			live.add(leaf.view);
			if (!this.overlays.has(leaf.view)) this.overlays.set(leaf.view, new CardOverlay(leaf.view, this));
		}
		for (const [view, overlay] of this.overlays) {
			if (live.has(view)) continue;
			overlay.detach();
			this.overlays.delete(view);
		}
	}

	refreshOverlays(): void {
		for (const overlay of this.overlays.values()) overlay.refresh();
	}

	// ------------------------------------------------------------------- triggers

	private async afterModify(file: TFile): Promise<void> {
		if (this.disposed) return;
		const own = await this.isOwnSave(file);
		const path = file.path;
		const old = this.timers.get(path);
		if (old !== undefined) window.clearTimeout(old);
		if (own) this.own.add(path);
		this.timers.set(path, window.setTimeout(() => this.fire(path), this.own.has(path) ? LOCAL_DELAY_MS : REMOTE_DELAY_MS));
	}

	private async isOwnSave(file: TFile): Promise<boolean> {
		const views = viewsOf(this.app, file);
		if (views.length === 0) return false;
		try {
			const text = readNotebookText(file.extension, await this.app.vault.cachedRead(file));
			return views.some(({ view }) => view.isOwnWrite(text));
		} catch {
			return false;
		}
	}

	private fire(path: string): void {
		this.timers.delete(path);
		if (this.disposed) return;
		// Never while writing: wait for a pause of the pen (and finger, and mouse) in every notebook view.
		if (this.input.active()) {
			this.timers.set(path, window.setTimeout(() => this.fire(path), INPUT_POLL_MS));
			return;
		}
		const own = this.own.delete(path);
		const file = this.app.vault.getFileByPath(path);
		if (file && isNotebookFile(file)) void this.enqueue(() => this.check(file, own));
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T | null> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run.catch((e: unknown) => {
			console.error("[notebook] zettel", e);
			this.report(`error:${String(e)}`, t("zettel.failed", { error: e instanceof Error ? e.message : String(e) }));
			return null;
		});
	}

	private report(key: string, message: string): void {
		if (this.reported.has(key)) return;
		this.reported.add(key);
		new Notice(message, 8000);
	}

	/** The document as the open view has it, else as saved; null if it cannot be read. */
	private async readDocument(file: TFile): Promise<NotebookDocument | null> {
		for (const { view } of viewsOf(this.app, file)) {
			if (view.document) return view.document;
		}
		const result = parse(readNotebookText(file.extension, await this.app.vault.cachedRead(file)));
		return result.ok ? result.doc : null;
	}

	/**
	 * After a notebook changed: marks cards whose page is gone as orphaned (and clears the flag when the page is
	 * back, e.g. after undo). After this device's own save also: slip-box pages without a card get one (Z2), and
	 * arrows drawn since the notebook was opened link their two cards (Z3).
	 */
	private async check(file: TFile, own: boolean): Promise<void> {
		if (viewsOf(this.app, file).length === 0) {
			// Not open here (sync, another app): parse the file only if some card or the slip-box list knows its id.
			const id = quickDocId(readNotebookText(file.extension, await this.app.vault.cachedRead(file)));
			if (id && !this.settings.zettelSlipBoxes.includes(id) && this.cardsOf(id).length === 0) return;
		}
		const doc = await this.readDocument(file);
		if (!doc) return;
		const cards = this.cardsOfFile(file, doc.id);
		const pageIds = new Set(doc.pages.map((p) => p.id));
		for (const card of cards) {
			const changes = orphanChanges(card, pageIds);
			if (changes) await this.editCard(card, () => changes);
		}
		if (!own) return;
		if (this.settings.zettelSlipBoxes.includes(doc.id)) await this.fillSlipBox(file, doc, MAX_AUTO_CARDS);
		await this.linkNewArrows(file, doc);
	}

	// ------------------------------------------------------------------- writing

	/** One `vault.process` of a card's frontmatter; nothing is written when the values are already there. */
	private async editCard(card: CardRecord, changes: (current: Record<string, unknown>) => Record<string, unknown> | null): Promise<boolean> {
		const note = this.app.vault.getFileByPath(card.path);
		if (!note) return false;
		/** The new note text, or why there is none ("yaml": invalid frontmatter; null: nothing to change). */
		const plan = (text: string): { text: string } | "yaml" | null => {
			const info = TEXT_DEPS.frontmatterInfo(text);
			const current = info.exists ? TEXT_DEPS.parseFrontmatter(text.slice(info.from, info.to)) : {};
			if (current === null) return "yaml";
			const wanted = changes(current);
			const next = wanted ? editProperties(text, wanted, TEXT_DEPS) : null;
			return next?.kind === "changed" ? { text: next.text } : null;
		};
		// Planned on the note as it is now: nothing is written (no modify, no sync) when the values are already there.
		const text = await this.app.vault.read(note);
		const first = plan(text);
		if (first === "yaml") this.report(`yaml:${note.path}`, t("zettel.badYaml", { path: note.path }));
		if (first === null || first === "yaml") return false;
		let written = false;
		await this.app.vault.process(note, (latest) => {
			// The user may have just typed in the note: apply the change to what it holds at this moment.
			const next = latest === text ? first : plan(latest);
			if (next === null || next === "yaml") return latest;
			written = true;
			return next.text;
		});
		return written;
	}

	/** Creates a card note. Returns the new note. */
	private async writeCard(file: TFile, doc: NotebookDocument, pageIndex: number, region: Region | null, answer: CardAnswer): Promise<TFile> {
		const page = doc.pages[pageIndex];
		if (!page) throw new Error(`page ${pageIndex + 1} not found`);
		const now = new Date();
		const id = nextCardId(this.settings.zettelIdScheme, now, idSet([...this.cards.values()].map((c) => c.id)), answer.parent || null);
		const card: NewCard = {
			id, title: answer.title, type: answer.type, source: answer.source, tags: answer.tags, date: localDate(now),
			notebookPath: file.path, notebookId: doc.id, pageId: page.id, page: pageIndex + 1, region,
		};
		const folder = normalizePath(this.settings.zettelFolder || "/");
		if (folder !== "/") await ensureFolder(this.app, folder);
		const prefix = folder === "/" ? "" : `${folder}/`;
		const base = cardFileName(id, answer.title);
		let path = normalizePath(`${prefix}${base}.md`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${prefix}${base} ${i}.md`);
		const note = await this.app.vault.create(path, newCardText(card, (data) => stringifyYaml(data)));
		// The metadata cache indexes the note a moment later: the id must count as taken right away.
		const record = readCard(path, cardProperties(card));
		if (record) this.cards.set(path, record);
		this.refreshOverlays();
		return note;
	}

	/** Slip-box (Z2): a card for every page that has none yet, at most `limit`. Returns how many were created. */
	private async fillSlipBox(file: TFile, doc: NotebookDocument, limit: number): Promise<number> {
		const have = new Set(this.cardsOfFile(file, doc.id).filter((c) => !c.region).map((c) => c.pageId));
		let made = 0;
		for (let i = 0; i < doc.pages.length && made < limit; i++) {
			const page = doc.pages[i]!;
			const key = `${doc.id}/${page.id}`;
			if (have.has(page.id) || this.creating.has(key)) continue;
			this.creating.add(key);
			try {
				await this.writeCard(file, doc, i, null, { title: "", type: "permanent", source: "", tags: [], parent: "" });
				made++;
			} finally {
				this.creating.delete(key);
			}
		}
		return made;
	}

	/** Two-way link between two cards (Z3): each note's `links` gets the other. Returns true when something was added. */
	private async linkCards(a: CardRecord, b: CardRecord): Promise<boolean> {
		const fa = this.app.vault.getFileByPath(a.path);
		const fb = this.app.vault.getFileByPath(b.path);
		if (!fa || !fb) return false;
		const toB = `[[${this.app.metadataCache.fileToLinktext(fb, fa.path, true)}]]`;
		const toA = `[[${this.app.metadataCache.fileToLinktext(fa, fb.path, true)}]]`;
		const add = (link: string) => (current: Record<string, unknown>) => {
			const links = addLinks(current[CARD_LINKS_KEY], [link]);
			return links ? { [CARD_LINKS_KEY]: links } : null;
		};
		const one = await this.editCard(a, add(toB));
		const two = await this.editCard(b, add(toA));
		return one || two;
	}

	/** Links the cards joined by arrows on the given pages; `only` limits it to strokes not seen before. */
	private async linkArrows(file: TFile, doc: NotebookDocument, pages: readonly number[], only: Set<string> | null): Promise<number> {
		const cards = this.cardsOfFile(file, doc.id).filter((c) => !c.orphaned);
		let linked = 0;
		for (const i of pages) {
			const page = doc.pages[i];
			if (!page) continue;
			const onPage = cards.filter((c) => c.pageId === page.id);
			if (onPage.length < 2) continue;
			const areas: CardArea[] = onPage.map((c) => ({ key: c.path, region: c.region }));
			for (const stroke of page.strokes) {
				if (stroke.tool !== "shape" || (only && only.has(stroke.id))) continue;
				const link = arrowLink(stroke.points, areas);
				if (!link) continue;
				const a = onPage.find((c) => c.path === link.from);
				const b = onPage.find((c) => c.path === link.to);
				if (a && b && (await this.linkCards(a, b))) linked++;
			}
		}
		return linked;
	}

	private async linkNewArrows(file: TFile, doc: NotebookDocument): Promise<void> {
		const seen = this.seenShapes.get(doc.id);
		const now = shapeIds(doc);
		this.seenShapes.set(doc.id, now);
		// First look at this notebook in this session: nothing is "new" yet.
		if (!seen) return;
		await this.linkArrows(file, doc, doc.pages.map((_, i) => i), seen);
	}

	// ------------------------------------------------------------------- actions (commands, menus)

	private doc(view: NotebookView): { file: TFile; doc: NotebookDocument } | null {
		const file = view.file;
		const doc = view.document;
		return file && doc ? { file, doc } : null;
	}

	/** Z1: the lasso selection becomes a card (a region of its page). */
	cardFromSelection(view: NotebookView): void {
		const ctx = this.doc(view);
		const sel = view.selectionRegion();
		if (!ctx || !sel) {
			new Notice(t("zettel.noSelection"));
			return;
		}
		const page = ctx.doc.pages[sel.pageIndex];
		const region = page ? regionFromBounds(sel.bounds, page) : null;
		if (!page || !region) {
			new Notice(t("zettel.noSelection"));
			return;
		}
		this.askAndCreate(ctx.file, ctx.doc, sel.pageIndex, region);
	}

	/** Z1: the page in view becomes a card (an A6 card page, or any page). */
	cardFromPage(view: NotebookView): void {
		const ctx = this.doc(view);
		if (!ctx) return;
		const index = view.currentPage();
		const page = ctx.doc.pages[index];
		if (!page) return;
		const existing = this.cardsOfFile(ctx.file, ctx.doc.id).find((c) => c.pageId === page.id && !c.region);
		if (existing) {
			new Notice(t("zettel.pageIsCard", { id: existing.id }));
			return;
		}
		this.askAndCreate(ctx.file, ctx.doc, index, null);
	}

	private askAndCreate(file: TFile, doc: NotebookDocument, pageIndex: number, region: Region | null): void {
		const page = doc.pages[pageIndex];
		let preview: string | null = null;
		try {
			preview = page ? renderThumbnail(page, 360, region ? { region } : {}) || null : null;
		} catch {
			preview = null;
		}
		new CardModal(this.app, { luhmann: this.settings.zettelIdScheme === "luhmann", preview }, (answer) => {
			if (!answer) return;
			void this.enqueue(async () => {
				const note = await this.writeCard(file, doc, pageIndex, region, answer);
				new Notice(t("zettel.created", { name: note.basename }));
			});
		}).open();
	}

	/** Z3, explicit: links the cards joined by every arrow on the page in view (also arrows drawn before). */
	linkArrowsOnPage(view: NotebookView): void {
		const ctx = this.doc(view);
		if (!ctx) return;
		const index = view.currentPage();
		void this.enqueue(async () => {
			const n = await this.linkArrows(ctx.file, ctx.doc, [index], null);
			new Notice(n > 0 ? t("zettel.linked", { n: String(n) }) : t("zettel.linkedNone"));
		});
	}

	/**
	 * Z11: types the title of a card on the page in view (the page card, or the one region card; with several, a
	 * list to choose from). Sets `title` and `aliases`; a note still named after its id alone is renamed to
	 * `<id> <title>` through the file manager, so links to it follow.
	 */
	setCardTitle(view: NotebookView): void {
		const ctx = this.doc(view);
		const page = ctx?.doc.pages[view.currentPage()];
		if (!ctx || !page) return;
		const onPage = this.cardsOfFile(ctx.file, ctx.doc.id).filter((c) => c.pageId === page.id);
		const ask = (card: CardRecord) => {
			new PromptModal(this.app, { title: t("zettel.titleModal", { id: card.id }), label: t("zettel.modal.cardTitle"), value: card.title, cta: t("zettel.titleModal.save") }, (title) => {
				void this.enqueue(() => this.writeTitle(card, title));
			}).open();
		};
		const pageCard = onPage.find((c) => !c.region);
		if (pageCard) ask(pageCard);
		else if (onPage.length === 1) ask(onPage[0]!);
		else if (onPage.length === 0) new Notice(t("zettel.noCardOnPage"));
		else new CardListModal(this.app, onPage.map((card) => ({ card, where: `p. ${view.currentPage() + 1}`, orphaned: false })), (item) => ask(item.card)).open();
	}

	private async writeTitle(card: CardRecord, title: string): Promise<void> {
		await this.editCard(card, (current) => titleChanges(current, title));
		const note = this.app.vault.getFileByPath(card.path);
		if (!note || note.basename !== cardFileName(card.id, card.title)) return;
		const base = cardFileName(card.id, title);
		const dir = note.parent && note.parent.path !== "/" ? `${note.parent.path}/` : "";
		const target = normalizePath(`${dir}${base}.md`);
		if (target !== note.path && !this.app.vault.getAbstractFileByPath(target)) await this.app.fileManager.renameFile(note, target);
	}

	/** Lists the cards of the notebook in a view; choosing one opens its note. */
	showCards(view: NotebookView): void {
		const ctx = this.doc(view);
		if (!ctx) return;
		const index = new Map(ctx.doc.pages.map((p, i) => [p.id, i]));
		const items: CardListItem[] = this.cardsOfFile(ctx.file, ctx.doc.id).map((card) => {
			const i = index.get(card.pageId);
			const orphaned = i === undefined;
			const where = orphaned ? t("zettel.list.pageDeleted") : `p. ${i + 1}${card.region ? ` · ${t("zettel.list.region")}` : ""}`;
			return { card, where, orphaned };
		});
		new CardListModal(this.app, items, (item) => void this.openCard(item.card)).open();
	}

	/** Lists every orphaned card of the vault: page deleted, or notebook gone. */
	showOrphans(): void {
		const items: CardListItem[] = [];
		for (const card of this.cards.values()) {
			const notebook = this.linkedNotebook(card);
			if (card.orphaned) items.push({ card, where: t("zettel.list.pageDeletedIn", { name: notebook?.basename ?? card.notebookLink }), orphaned: true });
			else if (!notebook) items.push({ card, where: t("zettel.list.notebookMissing"), orphaned: true });
		}
		items.sort((a, b) => a.card.id.localeCompare(b.card.id, undefined, { numeric: true }));
		new CardListModal(this.app, items, (item) => void this.openCard(item.card)).open();
	}

	private async openCard(card: CardRecord): Promise<void> {
		const note = this.app.vault.getFileByPath(card.path);
		if (note) await this.app.workspace.getLeaf("tab").openFile(note);
	}

	isSlipBox(view: NotebookView): boolean {
		const doc = view.document;
		return !!doc && this.settings.zettelSlipBoxes.includes(doc.id);
	}

	/** Z2: turns a notebook into a slip-box (a card for every page, after asking) or back into a normal notebook. */
	toggleSlipBox(view: NotebookView): void {
		const ctx = this.doc(view);
		if (!ctx) return;
		const { file, doc } = ctx;
		if (this.isSlipBox(view)) {
			void this.setSlipBox(doc.id, false).then(() => new Notice(t("zettel.slipBox.off", { name: file.basename })));
			return;
		}
		const have = new Set(this.cardsOfFile(file, doc.id).filter((c) => !c.region).map((c) => c.pageId));
		const missing = doc.pages.filter((p) => !have.has(p.id)).length;
		const enable = () => void this.enqueue(async () => {
			await this.setSlipBox(doc.id, true);
			const made = await this.fillSlipBox(file, doc, Number.POSITIVE_INFINITY);
			new Notice(t("zettel.slipBox.on", { name: file.basename, n: String(made) }));
		});
		if (missing <= 1) enable();
		else new ConfirmCardsModal(this.app, t("zettel.slipBox.confirmBody", { n: String(missing), folder: this.settings.zettelFolder }), enable).open();
	}

	private async setSlipBox(docId: string, on: boolean): Promise<void> {
		const list = this.settings.zettelSlipBoxes.filter((id) => id !== docId);
		if (on) list.push(docId);
		this.settings.zettelSlipBoxes = list;
		await this.plugin.saveSettings();
	}

	/** Z2: a new notebook with A6 card pages that is a slip-box from the start; its first page becomes a card. */
	async newSlipBox(): Promise<void> {
		const paper = { kind: this.settings.defaultPaper, spacing: PAPER_SPACING[this.settings.defaultPaper] };
		const doc = createDocument(new Date(), A6_PAGE, paper);
		const file = await createNotebook(this.app, this.settings.folder, t("zettel.slipBox.defaultName"), doc);
		await this.setSlipBox(doc.id, true);
		await this.enqueue(() => this.fillSlipBox(file, doc, 1));
		await openNotebookAtPage(this.app, file, 1);
	}

	async toggleRegions(): Promise<void> {
		this.settings.zettelShowRegions = !this.settings.zettelShowRegions;
		await this.plugin.saveSettings();
		this.refreshOverlays();
	}
}

/** Ids of the shape strokes of a document (arrows are drawn with the shape tool). */
function shapeIds(doc: NotebookDocument): Set<string> {
	const out = new Set<string>();
	for (const page of doc.pages) for (const s of page.strokes) if (s.tool === "shape") out.add(s.id);
	return out;
}

