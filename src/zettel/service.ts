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
import { existsInsensitive } from "../storage/names";
import { ensureFolder } from "../storage/vault-io";
import { NotebookView, VIEW_TYPE } from "../view/notebook-view";
import { arrowLink, type CardArea } from "./arrows";
import {
	addLinks, CARD_LINKS_KEY, cardProperties, editProperties, newCardText, orphanChanges, readCard, titleChanges,
	type CardRecord, type NewCard,
} from "./card-content";
import { PromptModal } from "../library/library-modals";
import { allTemplates, applyTemplate, findTemplate, templateTags, type CardTemplate } from "./card-templates";
import { cardFileName, idSet, isUntitledCardName, localDate, nameSuffixFor, nextCardId } from "./ids";
import { CardListModal, CardModal, ConfirmCardsModal, type CardAnswer, type CardListItem } from "./modals";
import { goneChosen, linkOutcome, resolveChosen } from "./link-suggest";
import { LocalPages } from "./local-pages";
import { CardOverlay, type OverlaySource } from "./overlay";
import { idsInNames, isSequenceId, neighbours, sequenceCardId, type SequenceKind } from "./sequence";
import { SequenceModal, type SequenceInfo } from "./sequence-view";
import { A6_PAGE } from "./settings";
import { regionFromBounds, type Region } from "./subpath";
import { renderThumbnail } from "../library/thumbnail";

export interface ZettelHost extends Plugin {
	settings: NotebookSettings;
	saveSettings(): Promise<void>;
}

/** Z7: a card that continues another one: `kind` says how (the next card after it, or a branch of it). */
interface SequenceRequest {
	kind: SequenceKind;
	origin: CardRecord;
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
 *   `zettel-notebook-id`, `page-id`, `region`) and keeps an in-memory index. Nothing about cards is stored in the
 *   notebook file, so the document format does not change and cards follow their page when it moves.
 * - Writes: a card is created only on an explicit action, or (slip-box) after this device's own save that
 *   added a page on this device in this session; afterwards only the `orphaned` flag and the drawn `links` are
 *   ever written (and the title, on request), with one `vault.process`, only when the value really changes and
 *   only after this device's own save: changes that arrive through sync are shown, never written back (two
 *   devices writing the same note make conflicted copies). Only the lines of the changed keys are rewritten. The body is never touched after creation and
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
	/** Pages not made on this device in this session: slip-boxes never fill them by themselves. */
	private readonly localPages = new LocalPages();
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

	/** The notebook a card's `zettel-notebook` link resolves to (null when it resolves to none). */
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
		if (doc && !this.localPages.seen(doc.id)) this.localPages.know(doc.id, doc.pages.map((p) => p.id));
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
		if (!own) await this.notePages(file);
		if (this.disposed) return;
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
	 * After this device's own save of a notebook: marks cards whose page is gone as orphaned (and clears the flag when
	 * the page is back, e.g. after undo), gives slip-box pages made here a card (Z2), and links the two cards of
	 * arrows drawn since the notebook was opened (Z3). Any other change only redraws the overlays.
	 */
	private async check(file: TFile, own: boolean): Promise<void> {
		// A change made elsewhere (sync, another app) is only shown: the device that made it writes the card notes,
		// and if every device wrote the same flag the sync service would make conflicted copies of the note.
		if (!own) {
			this.refreshOverlays();
			return;
		}
		const doc = await this.readDocument(file);
		if (!doc) return;
		const cards = this.cardsOfFile(file, doc.id);
		const pageIds = new Set(doc.pages.map((p) => p.id));
		for (const card of cards) {
			const changes = orphanChanges(card, pageIds);
			if (changes) await this.editCard(card, () => changes);
		}
		if (this.settings.zettelSlipBoxes.includes(doc.id)) {
			const fresh = this.localPages.fresh(doc.id, doc.pages.map((p) => p.id));
			if (fresh.size > 0) await this.fillSlipBox(file, doc, MAX_AUTO_CARDS, fresh);
			// A page that still has no card (limit reached, write failed) is tried again at the next save.
			const carded = new Set(this.cardsOfFile(file, doc.id).map((c) => c.pageId));
			this.localPages.know(doc.id, [...fresh].filter((id) => carded.has(id)));
		}
		await this.linkNewArrows(file, doc);
	}

	// ------------------------------------------------------------------- pages made on this device

	/** After a change this device did not make: its pages count as known (they were not made here). */
	private async notePages(file: TFile): Promise<void> {
		try {
			const text = readNotebookText(file.extension, await this.app.vault.cachedRead(file));
			const id = quickDocId(text);
			if (!id || !this.settings.zettelSlipBoxes.includes(id)) return;
			const result = parse(text);
			if (result.ok) this.localPages.know(result.doc.id, result.doc.pages.map((p) => p.id));
		} catch (e) {
			console.error("[notebook] zettel: could not read", file.path, e);
		}
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
	private async writeCard(file: TFile, doc: NotebookDocument, pageIndex: number, region: Region | null, answer: CardAnswer, transcription?: string, sequence?: SequenceRequest): Promise<TFile> {
		const page = doc.pages[pageIndex];
		if (!page) throw new Error(`page ${pageIndex + 1} not found`);
		const now = new Date();
		const scheme = this.settings.zettelIdScheme;
		const taken = idSet([...this.cards.values()].map((c) => c.id));
		// Z7: a follow-up or branch card takes the next free id after the card it continues (a note named like it counts as taken).
		const planned = sequence && scheme === "luhmann" ? sequenceCardId(sequence.kind, sequence.origin.id, taken, idsInNames(this.noteNamesInFolder())) : null;
		const id = planned ?? nextCardId(scheme, now, taken, answer.parent || null);
		const template = findTemplate(this.cardTemplates(), answer.template);
		const card: NewCard = {
			id, title: answer.title, type: answer.type, source: answer.source, tags: templateTags(answer.tags, template), date: localDate(now),
			notebookPath: file.path, notebookId: doc.id, pageId: page.id, page: pageIndex + 1, region, transcription,
		};
		const folder = normalizePath(this.settings.zettelFolder || "/");
		if (folder !== "/") await ensureFolder(this.app, folder);
		const prefix = folder === "/" ? "" : `${folder}/`;
		const base = cardFileName(id, answer.title, nameSuffixFor(scheme, answer.title));
		let path = normalizePath(`${prefix}${base}.md`);
		// Case-insensitive (review Z6): `1a Energy.md` next to `1A energy.md` would be one file on Windows and Android.
		for (let i = 2; existsInsensitive(this.app.vault, path); i++) path = normalizePath(`${prefix}${base} ${i}.md`);
		const note = await this.app.vault.create(path, applyTemplate(newCardText(card, (data) => stringifyYaml(data)), template, TEXT_DEPS, now));
		// The metadata cache indexes the note a moment later: the id must count as taken right away.
		const record = readCard(path, cardProperties(card));
		if (record) this.cards.set(path, record);
		this.refreshOverlays();
		return note;
	}

	/**
	 * Slip-box (Z2): a card for every page that has none yet (only the pages in `only`, when given), at most `limit`.
	 * Returns how many were created.
	 */
	private async fillSlipBox(file: TFile, doc: NotebookDocument, limit: number, only: ReadonlySet<string> | null = null): Promise<number> {
		const have = new Set(this.cardsOfFile(file, doc.id).filter((c) => !c.region).map((c) => c.pageId));
		let made = 0;
		for (let i = 0; i < doc.pages.length && made < limit; i++) {
			const page = doc.pages[i]!;
			const key = `${doc.id}/${page.id}`;
			if ((only && !only.has(page.id)) || have.has(page.id) || this.creating.has(key)) continue;
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

	/**
	 * The card dialog, then the card. `newPageIn`: the card goes on a NEW page added right after the page at `pageIndex` of that
	 * view (a follow-up / branch of a card that is the whole page itself, review Z3); the page is added only when the dialog is
	 * answered, so cancelling leaves the notebook as it was.
	 */
	private askAndCreate(file: TFile, doc: NotebookDocument, pageIndex: number, region: Region | null, sequence?: SequenceRequest, newPageIn?: NotebookView): void {
		const page = doc.pages[pageIndex];
		let preview: string | null = null;
		try {
			preview = page && !newPageIn ? renderThumbnail(page, 360, region ? { region } : {}) || null : null;
		} catch {
			preview = null;
		}
		// Review Z2: while the dialog is open the page counts as being made, so the slip-box does not give it a card of its own.
		const pageKey = page && !region && !newPageIn ? `${doc.id}/${page.id}` : null;
		// Held only when no other dialog or write already holds it (that one releases it).
		const held = pageKey !== null && !this.creating.has(pageKey) ? pageKey : null;
		if (held) this.creating.add(held);
		// Z7: the id of a follow-up / branch card follows from the card it continues, so the dialog does not ask for a parent.
		const luhmann = this.settings.zettelIdScheme === "luhmann" && !sequence;
		new CardModal(this.app, { luhmann, preview, templates: this.cardTemplates() }, (answer) => {
			if (!answer) {
				if (held) this.creating.delete(held);
				return;
			}
			let targetDoc = doc;
			let pageId = page?.id;
			let key: string | null = held;
			let addedId: string | null = null;
			if (newPageIn) {
				const added = this.addPageForCard(newPageIn, doc, page);
				if (!added) {
					new Notice(t("sequence.cannotAddPage"));
					return;
				}
				targetDoc = added.doc;
				pageId = addedId = added.pageId;
				key = `${added.doc.id}/${added.pageId}`;
				this.creating.add(key);
			}
			void this.enqueue(async () => {
				try {
					// Review R5, T7: the page is found by its id when the task runs, in the document as it is now (the pages may have
					// moved, and the view may have reloaded the notebook, while the dialog was open or the task waited in the queue).
					const current = await this.readDocument(file).catch(() => null);
					const docNow = current ?? targetDoc;
					const index = pageId === undefined || docNow.id !== targetDoc.id ? -1 : docNow.pages.findIndex((p) => p.id === pageId);
					const pageNow = docNow.pages[index];
					if (!pageNow) {
						new Notice(t("zettel.pageGone"));
						return;
					}
					// Review Z2: the page may have got its card while the dialog was open (sync, another dialog).
					const existing = !region ? this.cardsOfFile(file, docNow.id).find((c) => c.pageId === pageNow.id && !c.region) : undefined;
					if (existing) {
						new Notice(t("sequence.pageHasCard", { id: existing.id }));
						return;
					}
					let note: TFile;
					try {
						note = await this.writeCard(file, docNow, index, region, answer, undefined, sequence);
					} catch (e) {
						if (addedId === null) throw e;
						// Review R5: the page added for the card stays (nothing is deleted behind the person's back) and stays "new", so in a
						// slip-box notebook the next save gives it a card of its own (review T6: the notice says so); Undo removes it. Said
						// once, with the reason.
						const kept = this.settings.zettelSlipBoxes.includes(docNow.id) ? "sequence.pageKeptSlipBox" : "sequence.pageKept";
						new Notice(t(kept, { error: e instanceof Error ? e.message : String(e) }), 8000);
						return;
					}
					// Only now is the added page done: the slip-box leaves it alone from here on.
					if (addedId !== null) this.localPages.know(docNow.id, [addedId]);
					if (!sequence) {
						new Notice(t("zettel.created", { name: note.basename }));
						await this.linkChosen(note, answer.links);
						return;
					}
					const made = this.cards.get(note.path);
					const linked = await this.linkSequence(sequence, made ?? null);
					new Notice(t("sequence.created", { id: made?.id ?? note.basename, origin: sequence.origin.id, kind: t(sequence.kind === "branch" ? "sequence.kind.branch" : "sequence.kind.followUp") }));
					if (!linked) new Notice(t("sequence.linkFailed", { origin: sequence.origin.id }));
					await this.linkChosen(note, answer.links);
				} finally {
					if (key) this.creating.delete(key);
				}
			});
		}).open();
	}

	/**
	 * Adds a page right after `after` in the view (same size and paper) for a new card. The caller marks it as being made (the
	 * `creating` key) so the slip-box leaves it alone, and marks it known only once the card is written (review R5). Null when the
	 * notebook could not be changed.
	 */
	private addPageForCard(view: NotebookView, doc: NotebookDocument, after: NotebookDocument["pages"][number] | undefined): { doc: NotebookDocument; pageId: string } | null {
		const before = view.document;
		const index = before && after ? before.pages.findIndex((p) => p.id === after.id) : -1;
		if (!before || before.id !== doc.id || index < 0) return null;
		const count = before.pages.length;
		view.addPageAfter(index);
		const now = view.document;
		const added = now && now.id === doc.id && now.pages.length === count + 1 ? now.pages[index + 1] : undefined;
		if (!now || !added) return null;
		return { doc: now, pageId: added.id };
	}

	/**
	 * Z5 (review Z1): links the note just made to the cards chosen in its dialog. Called inside the queued task that wrote
	 * the note, with the exact note `writeCard` returned, so the links can never land on another card. Says what happened.
	 */
	private async linkChosen(note: TFile, chosen: readonly CardRecord[] | undefined): Promise<void> {
		if (!chosen || chosen.length === 0) return;
		const made = this.cards.get(note.path);
		if (!made) {
			new Notice(t("zettel.suggest.linkFailed"));
			return;
		}
		let linked = 0;
		let failed = 0;
		// The chosen card may have been renamed or moved since the dialog opened: its id still finds it. Review R6: a card that
		// cannot be found, or whose file is gone, is counted as gone, not as already linked.
		const byId = this.cardsById();
		let gone = goneChosen(chosen, this.cards, byId, made.path);
		let already = 0;
		for (const other of resolveChosen(chosen, this.cards, byId, made.path)) {
			if (!this.app.vault.getFileByPath(other.path)) {
				gone++;
				continue;
			}
			try {
				if (await this.linkCards(made, other)) linked++;
				else already++;
			} catch (e) {
				failed++;
				console.error("[notebook] zettel: link", e);
			}
		}
		const outcome = linkOutcome(linked, failed, gone, already);
		const goneText = gone === 1 ? t("zettel.suggest.goneOne") : t("zettel.suggest.gone", { n: String(gone) });
		if (outcome === "gone") {
			new Notice(goneText);
			return;
		}
		new Notice(outcome === "failed" ? t("zettel.suggest.linkFailed") : outcome === "none" ? t("zettel.suggest.linkedNone") : outcome === "one" ? t("zettel.suggest.linkedOne") : t("zettel.suggest.linked", { n: String(linked) }));
		if (gone > 0) new Notice(goneText);
	}

	// ------------------------------------------------------------------- sequences (Z7)

	/** Whether the sequence commands are on: they exist only with Luhmann numbering. */
	sequenceOn(): boolean {
		return this.settings.zettelIdScheme === "luhmann";
	}

	/** What the sequence commands act on: the numbered cards of the page in view, or the card note that is open. */
	private sequenceContext(): { cards: CardRecord[]; view: NotebookView | null } {
		const view = this.app.workspace.getActiveViewOfType(NotebookView);
		const ctx = view ? this.doc(view) : null;
		if (view && ctx) {
			const page = ctx.doc.pages[view.currentPage()];
			const cards = page ? this.cardsOfFile(ctx.file, ctx.doc.id).filter((c) => c.pageId === page.id && isSequenceId(c.id)) : [];
			return { cards, view };
		}
		const file = this.app.workspace.getActiveFile();
		const card = file ? this.cards.get(file.path) : undefined;
		return { cards: card && isSequenceId(card.id) ? [card] : [], view: null };
	}

	/** Whether a sequence command can run now: `needs` is "card" (a numbered card is in view) or "notebook" (a notebook page is in view). */
	sequenceAvailable(needs: "card" | "notebook"): boolean {
		if (!this.sequenceOn()) return false;
		const ctx = this.sequenceContext();
		return needs === "card" ? ctx.cards.length > 0 : ctx.view !== null;
	}

	/** Cards by lower-case id; of two cards with the same id the one still on its page, then the first by path. */
	private cardsById(): Map<string, CardRecord> {
		const out = new Map<string, CardRecord>();
		for (const card of [...this.cards.values()].sort((a, b) => a.path.localeCompare(b.path))) {
			const key = card.id.toLowerCase();
			const have = out.get(key);
			if (!have || (have.orphaned && !card.orphaned)) out.set(key, card);
		}
		return out;
	}

	/** The cards around a card in the numbering. */
	sequenceInfo(card: CardRecord): SequenceInfo {
		const byId = this.cardsById();
		const near = neighbours(card.id, byId.keys());
		const get = (id: string | null) => (id ? byId.get(id) ?? null : null);
		return {
			card, parent: get(near.parent), previous: get(near.previous), next: get(near.next),
			children: near.children.map((id) => byId.get(id)).filter((c): c is CardRecord => !!c),
		};
	}

	/** Names of the notes in the card folder: a new card must not take an id such a note already uses. */
	private noteNamesInFolder(): string[] {
		const folder = normalizePath(this.settings.zettelFolder || "/");
		return this.app.vault.getMarkdownFiles().filter((f) => (f.parent?.path ?? "/") === folder).map((f) => f.basename);
	}

	/** The card to act on: the only one, or the one chosen from a list. */
	private chooseCard(cards: readonly CardRecord[], then: (card: CardRecord) => void): void {
		if (cards.length === 1) {
			then(cards[0]!);
			return;
		}
		const items: CardListItem[] = cards.map((card) => ({ card, where: card.path, orphaned: false }));
		new CardListModal(this.app, items, (item) => then(item.card)).open();
	}

	/** Goes to a card related to the one in view: previous / next sibling, parent, or a child (a list when there are several). */
	goSequence(to: "previous" | "next" | "parent" | "children"): void {
		if (!this.sequenceOn()) return;
		const { cards } = this.sequenceContext();
		if (cards.length === 0) {
			new Notice(t("sequence.noCard"));
			return;
		}
		this.chooseCard(cards, (card) => {
			const info = this.sequenceInfo(card);
			if (to === "children") {
				if (info.children.length === 0) new Notice(t("sequence.noChildren", { id: card.id }));
				else if (info.children.length === 1) void this.openCard(info.children[0]!);
				else new CardListModal(this.app, info.children.map((c) => ({ card: c, where: card.id, orphaned: false })), (item) => void this.openCard(item.card)).open();
				return;
			}
			const target = info[to];
			if (target) void this.openCard(target);
			else new Notice(t(to === "parent" ? "sequence.noParent" : to === "previous" ? "sequence.noPrevious" : "sequence.noNext", { id: card.id }));
		});
	}

	/** Shows the sequence dialog of the card in view. */
	showSequence(): void {
		if (!this.sequenceOn()) return;
		const { cards, view } = this.sequenceContext();
		if (cards.length === 0) {
			new Notice(t("sequence.noCard"));
			return;
		}
		this.chooseCard(cards, (card) => {
			new SequenceModal(this.app, this.sequenceInfo(card), {
				open: (target) => void this.openCard(target),
				create: view ? (kind) => this.newSequenceCard(view, kind, card) : undefined,
			}).open();
		});
	}

	/**
	 * Z7: a follow-up (the next card after one) or a branch (a card that continues one in its own line) in the notebook in view:
	 * made from the lasso selection, else from the page in view when it is not a card yet. The card it continues is the one given,
	 * else the numbered card on the page, else one of the notebook's numbered cards (a list when there are several).
	 */
	newSequenceCard(view: NotebookView, kind: SequenceKind, origin?: CardRecord): void {
		if (!this.sequenceOn()) return;
		const ctx = this.doc(view);
		if (!ctx) return;
		let pageIndex = view.currentPage();
		let region: Region | null = null;
		const sel = view.selectionRegion();
		const selPage = sel ? ctx.doc.pages[sel.pageIndex] : undefined;
		const selRegion = sel && selPage ? regionFromBounds(sel.bounds, selPage) : null;
		if (sel && selRegion) {
			pageIndex = sel.pageIndex;
			region = selRegion;
		}
		const page = ctx.doc.pages[pageIndex];
		if (!page) return;
		const mine = this.cardsOfFile(ctx.file, ctx.doc.id);
		const pageCard = region ? undefined : mine.find((c) => c.pageId === page.id && !c.region);
		const numbered = (cards: CardRecord[]) => cards.filter((c) => isSequenceId(c.id) && !c.orphaned);
		const onPage = numbered(mine.filter((c) => c.pageId === page.id));
		const pool = origin ? [origin] : onPage.length > 0 ? onPage : numbered(mine);
		if (pool.length === 0) {
			new Notice(t("sequence.noOrigin"));
			return;
		}
		// Review Z3: the page in view is already a card (every page of a slip-box is), so the new card gets a new page after it.
		const newPage = pageCard ? view : undefined;
		this.chooseCard(pool, (from) => this.askAndCreate(ctx.file, ctx.doc, pageIndex, region, { kind, origin: from }, newPage));
	}

	/**
	 * Links a new follow-up / branch card with the card it continues (both notes get the link), when the setting is on.
	 * False only when the link was wanted and could not be made (the card is kept; the hygiene report offers the link).
	 */
	private async linkSequence(sequence: SequenceRequest, made: CardRecord | null): Promise<boolean> {
		if (!this.settings.zettelSequenceLink) return true;
		if (!made) return false;
		// The card it continues may have been renamed or moved while the dialog was open: its id still finds it.
		const origin = this.cards.get(sequence.origin.path) ?? this.cardsById().get(sequence.origin.id.toLowerCase());
		if (!origin) return false;
		try {
			await this.linkCards(origin, made);
			return true;
		} catch (e) {
			console.error("[notebook] zettel: could not link the sequence", e);
			return false;
		}
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
		// Renamed only while it still has the name the plugin gave it (the user's own name is kept).
		const named = card.title ? note?.basename === cardFileName(card.id, card.title) : !!note && isUntitledCardName(note.basename, card.id);
		if (!note || !named) return;
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

	// wave 0.8: processing — what the Inbox (inbox-service.ts) uses

	/** Every card of the vault (a copy; orphaned ones included). */
	allCards(): CardRecord[] {
		return [...this.cards.values()];
	}

	/**
	 * Z4: creates a card for a page (and region) of a notebook, with the answers of the card dialog and an optional text
	 * for the Transcription section. Goes through the same queue and writer as every other card. Null when it failed
	 * (a notice says why) or the page is gone.
	 */
	createCardFor(file: TFile, doc: NotebookDocument, pageId: string, region: Region | null, answer: CardAnswer, transcription?: string): Promise<TFile | null> {
		const index = doc.pages.findIndex((p) => p.id === pageId);
		if (index < 0) return Promise.resolve(null);
		return this.enqueue(async () => {
			const note = await this.writeCard(file, doc, index, region, answer, transcription);
			// Review Z1: the links chosen in the dialog go to this very note, in this very task (nothing is linked when no note is made).
			await this.linkChosen(note, answer.links);
			return note;
		});
	}

	/** Z9: the card templates on offer (built-in, then the person's own), in the plugin language. */
	cardTemplates(): CardTemplate[] {
		return allTemplates((k) => t(k), this.settings.zettelCardTemplates);
	}

	/** Opens a card's note in a tab. */
	openCardNote(card: CardRecord): Promise<void> {
		return this.openCard(card);
	}

	async toggleRegions(): Promise<void> {
		this.settings.zettelShowRegions = !this.settings.zettelShowRegions;
		await this.plugin.saveSettings();
		this.refreshOverlays();
	}

	// 0.29 hygiene (Z10): the fixing actions of the hygiene report. The report asks first; these only run after a confirmation.

	/** Sets a card's typed title through the same writer as "Set card title" (the note is renamed only while it has the plugin's own name). */
	retitleCard(card: CardRecord, title: string): Promise<unknown> {
		return this.enqueue(() => this.writeTitle(card, title));
	}

	/** Adds a link between two cards in both notes. True when something was added. */
	async linkCardPair(a: CardRecord, b: CardRecord): Promise<boolean> {
		return (await this.enqueue(() => this.linkCards(a, b))) === true;
	}
}

/** Ids of the shape strokes of a document (arrows are drawn with the shape tool). */
function shapeIds(doc: NotebookDocument): Set<string> {
	const out = new Set<string>();
	for (const page of doc.pages) for (const s of page.strokes) if (s.tool === "shape") out.add(s.id);
	return out;
}

