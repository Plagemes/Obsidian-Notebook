/**
 * Synchronised PDF <-> notes view (#106), the glue: command, menu entries, the reference picker and the controller
 * that keeps the two sides together.
 *
 * - The PDF (a plain `.pdf`, or another notebook whose pages have PDF backgrounds) is shown in a pane inside the
 *   notebook view (view/pdf-side-pane.ts); the notebook stays the notes side.
 * - Turning the PDF page shows the notes page linked to it; scrolling the notes shows the PDF page its page is linked to.
 *   A slide without a notes page offers "Add notes page for this slide" (one undo step, plus its link).
 * - Links live in a sidecar JSON in `<notebooks folder>/_meta/` (storage/pdf-links-store.ts), written only by explicit link
 *   actions, never by turning pages or scrolling. The notebook format is not touched.
 * - v12 (#226): ink written while a PDF page is in the pane remembers that slide (model/slide-links.ts; the view asks
 *   `referenceSlideKey` when it commits ink). `showSlideRef` shows such a slide again, opening its file when the pane
 *   shows something else or is closed; the slide strip (#417, view/slide-strip-modal.ts) reads the links through
 *   `notesLinksOf`.
 */
import { FuzzySuggestModal, TFile, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import { createPage } from "../model/document";
import { AddPage } from "../model/history";
import { visibleStrokes } from "../model/markers";
import { slideOfStrokes, type SlideKey } from "../model/slide-links";
import type { StripLink } from "../model/slide-strip";
import { ASSETS_DIRNAME } from "../pdf/assets";
import {
	decideFromPdf, insertionIndex, linkOf, linkState, notesPagesFor, type LinksOp, type PdfLink, type PdfRef,
} from "../pdf/sync-links";
import { isNotebookFile } from "../storage/format";
import { LINKS_FILE, linksFolder, LinksBlockedError, PdfLinkStore } from "../storage/pdf-links-store";
import { vaultLinkFileAdapter } from "../storage/vault-io";
import type { NotebookView } from "./notebook-view";
import { openNotebookReference, openPdfReference, type ReferenceSource } from "./pdf-reference";
import { PdfSidePane, type Banner } from "./pdf-side-pane";
import { showNotice } from "./notice";
import { SlideStripModal } from "./slide-strip-modal";

/** What the notebook view tells the controller (NotebookView.syncHooks). */
export interface PageSyncHooks {
	/** The page in view changed (scrolling, page buttons, a jump). */
	page(index: number): void;
	/** A document was loaded into the view (another file, or the same one read again). */
	loaded(): void;
}

export interface PdfSyncServices {
	app: App;
	store: PdfLinkStore;
	/** Notebooks folder (assets of a reference notebook live in its `_assets`). */
	folder(): string;
}

/** Wait this long (ms) after the notes page changed before the PDF side follows, so fast scrolling does not render every page. */
const FOLLOW_DELAY_MS = 120;

let services: PdfSyncServices | null = null;
const controllers = new WeakMap<NotebookView, PdfSyncController>();

function controllerOf(view: NotebookView): PdfSyncController | null {
	if (!services) return null;
	let c = controllers.get(view);
	if (!c) {
		c = new PdfSyncController(view, services);
		controllers.set(view, c);
	}
	return c;
}

/** Files that can be shown beside a notebook: PDFs of the vault and other notebooks (not the content-addressed `_assets`). */
function candidateFiles(app: App, self: TFile | null): TFile[] {
	return app.vault.getFiles()
		.filter((f) => (f.extension.toLowerCase() === "pdf" || isNotebookFile(f)) && f.path !== self?.path && !f.path.split("/").includes(ASSETS_DIRNAME))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
}

class ReferencePickModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly files: TFile[], private readonly chosen: (f: TFile) => void) {
		super(app);
		this.setPlaceholder(t("pdfSide.pick.placeholder"));
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.chosen(f);
	}
}

class PdfSyncController implements PageSyncHooks {
	private pane: PdfSidePane | null = null;
	private source: ReferenceSource | null = null;
	/** Reference page in view (0-based). */
	private index = 0;
	private follow = true;
	/** The links file cannot be used (unreadable or newer): links are off, the PDF can still be read. */
	private blocked = false;
	/** The notes view is being moved by us: its page notifications are not the reader's. */
	private applying = false;
	/**
	 * After we moved the notes to page `pinned`, the view may report another page as "in view" (the one at the middle
	 * of the screen, when pages are short). Until the reader moves again, `pinned` is the notes page that counts.
	 */
	private pinned: number | null = null;
	private pinnedObserved = -1;
	private followTimer: number | null = null;
	private reloadTimer: number | null = null;
	private opening = 0;

	constructor(private readonly view: NotebookView, private readonly svc: PdfSyncServices) {
		view.register(() => this.close());
		view.registerEvent(svc.app.vault.on("modify", (f) => {
			if (this.source?.kind === "notebook" && f === this.source.file) this.scheduleReload();
		}));
		view.registerEvent(svc.app.vault.on("delete", (f) => {
			if (this.source && f === this.source.file) this.close();
		}));
		// Another device may have synced a newer links file while the app was in the background.
		view.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.pane) void this.reloadLinks().then(() => this.updateChrome());
		});
	}

	get isOpen(): boolean {
		return this.pane !== null;
	}

	/** 1-based reference page in view, or null when the pane is closed. */
	get slideInView(): number | null {
		return this.pane ? this.index + 1 : null;
	}

	/** The file shown in the pane, or null. */
	get shownFile(): TFile | null {
		return this.source?.file ?? null;
	}

	/**
	 * v12 (#226): the slide in the pane, as ink written now links it; null when the pane is closed or its page is no PDF
	 * page. `path` is the file shown (a plain PDF, or the notebook whose page has that PDF page as background), to open it again.
	 */
	get slideKey(): SlideKey | null {
		const source = this.source;
		const ref = this.pane && source ? source.refAt(this.index) : null;
		if (!ref || !source) return null;
		return { source: ref.source, page: ref.page, path: ref.path ?? source.file.path };
	}

	/** The PDF in the pane (content id and path of a plain PDF), or null. */
	get shownSource(): { source: string; path?: string; index: number } | null {
		const ref = this.pane && this.source ? this.source.refAt(this.index) : null;
		return ref ? { source: ref.source, path: ref.path, index: this.index } : null;
	}

	/**
	 * v12 (#226): shows the slide `ref` in the pane: at once when the pane shows its PDF, else after opening the file it was
	 * written beside (`ref.path`). A slide that is a page of this notebook (its PDF background) is shown there instead.
	 * False when it cannot be found.
	 */
	async showSlideRef(ref: SlideKey): Promise<boolean> {
		if (this.showInPane(ref)) return true;
		const file = ref.path ? this.svc.app.vault.getAbstractFileByPath(ref.path) : null;
		if (file instanceof TFile && file !== this.view.file) {
			await this.open(file);
			if (this.showInPane(ref)) return true;
		}
		const doc = this.view.document;
		const own = doc ? doc.pages.findIndex((p) => p.background?.kind === "pdf" && p.background.asset === ref.source && p.background.page === ref.page) : -1;
		if (own >= 0) {
			this.view.goToRelativePage(own - this.view.currentPage());
			return true;
		}
		return false;
	}

	private showInPane(ref: SlideKey): boolean {
		const source = this.source;
		if (!this.pane || !source) return false;
		const index = source.indexOf({ source: ref.source, page: ref.page, path: ref.path?.toLowerCase().endsWith(".pdf") ? ref.path : undefined });
		if (index < 0) return false;
		this.index = index;
		this.pane.show(index);
		this.updateChrome();
		return true;
	}

	/** v12 (#417): the side-by-side links of the open notebook (read again from the file first). */
	async notesLinks(): Promise<StripLink[]> {
		const doc = this.view.document;
		if (!doc) return [];
		if (!this.pane) {
			try {
				await this.svc.store.load();
			} catch {
				return []; // unreadable or newer: no links, the strip still shows the rest
			}
		}
		return this.svc.store.snapshot().links.filter((l) => l.notebook === doc.id)
			.map((l) => (l.path ? { notesPage: l.notesPage, source: l.source, page: l.page, path: l.path } : { notesPage: l.notesPage, source: l.source, page: l.page }));
	}

	/** Shows a page (1-based) of a PDF in the pane, opening the pane first when it shows something else. */
	async showPage(file: TFile, page: number): Promise<void> {
		if (this.source?.file !== file) await this.open(file);
		const source = this.source;
		if (!this.pane || !source) return;
		const index = Math.min(source.pageCount(), Math.max(1, Math.floor(page))) - 1;
		this.index = index;
		this.pane.show(index);
		this.updateChrome();
	}

	// --- opening and closing ---

	pick(): void {
		const files = candidateFiles(this.svc.app, this.view.file);
		if (files.length === 0) {
			showNotice(t("pdfSide.pick.none"));
			return;
		}
		new ReferencePickModal(this.svc.app, files, (f) => void this.open(f)).open();
	}

	async open(file: TFile): Promise<void> {
		const body = this.view.contentEl.querySelector<HTMLElement>(".notebook-body");
		if (!body) return;
		const ticket = ++this.opening;
		let source: ReferenceSource;
		try {
			source = file.extension.toLowerCase() === "pdf"
				? await openPdfReference(this.svc.app, file)
				: await openNotebookReference(this.svc.app, file, this.svc.folder(), () => this.pane?.refresh());
		} catch (e) {
			showNotice(t("pdfSide.openFailed", { name: file.name, error: (e as Error).message }));
			return;
		}
		if (ticket !== this.opening || !this.view.contentEl.isConnected) {
			source.destroy();
			return;
		}
		this.close();
		await this.reloadLinks();
		this.source = source;
		this.pane = new PdfSidePane(body, {
			turned: (index) => this.onTurned(index),
			toggleLink: () => void this.toggleLink(),
			addNotesPage: () => void this.addNotesPage(),
			showNotes: () => this.showLinkedNotes(),
			toggleFollow: () => this.setFollow(!this.follow),
			close: () => this.close(),
			openStrip: () => void openSlideStripOf(this.view),
		});
		this.pane.setFollow(this.follow);
		this.view.syncHooks = this;
		// Start on the slide the notes page in view is linked to, if it is linked to this PDF.
		const doc = this.view.document;
		const here = doc?.pages[this.notesIndex()];
		const link = doc && here ? linkOf(this.svc.store.snapshot(), doc.id, here.id) : null;
		this.index = Math.max(0, link ? source.indexOf(link) : 0);
		this.pane.setSource(source, this.index);
		this.updateChrome();
		this.view.refreshUi(); // ui redesign: the side-pane contextual bar
	}

	close(): void {
		this.opening++;
		if (this.followTimer !== null) window.clearTimeout(this.followTimer);
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.followTimer = this.reloadTimer = null;
		this.pane?.destroy();
		this.pane = null;
		this.source?.destroy();
		this.source = null;
		this.pinned = null;
		if (this.view.syncHooks === this) this.view.syncHooks = null;
		this.view.refreshUi();
	}

	// --- hooks from the notebook view ---

	page(index: number): void {
		if (!this.pane || this.applying) return;
		if (this.pinned !== null && index === this.pinnedObserved) return;
		this.pinned = null;
		this.updateChrome();
		if (!this.follow || this.blocked) return;
		if (this.followTimer !== null) window.clearTimeout(this.followTimer);
		this.followTimer = window.setTimeout(() => {
			this.followTimer = null;
			this.followNotes();
		}, FOLLOW_DELAY_MS);
	}

	loaded(): void {
		this.pinned = null;
		this.updateChrome();
	}

	// --- following ---

	/** The reader turned the PDF page. */
	private onTurned(index: number): void {
		this.index = index;
		const doc = this.view.document;
		const ref = this.source?.refAt(index);
		if (this.follow && !this.blocked && doc && ref) {
			const d = decideFromPdf(this.svc.store.snapshot(), doc.id, ref, doc.pages.map((p) => p.id), this.notesIndex());
			if (d.kind === "go") this.moveNotes(d.index);
		}
		this.updateChrome();
	}

	/** The reader moved the notes: show the PDF page linked to the notes page in view. */
	private followNotes(): void {
		const doc = this.view.document;
		const source = this.source;
		const page = doc?.pages[this.notesIndex()];
		if (!doc || !source || !page || !this.pane) return;
		const link = linkOf(this.svc.store.snapshot(), doc.id, page.id);
		const target = link ? source.indexOf(link) : -1;
		if (target < 0 || target === this.index) return;
		this.index = target;
		this.pane.show(target);
		this.updateChrome();
	}

	private moveNotes(index: number): void {
		const view = this.view;
		this.applying = true;
		try {
			view.goToRelativePage(index - view.currentPage());
		} finally {
			this.applying = false;
		}
		this.pinned = index;
		this.pinnedObserved = view.currentPage();
	}

	private notesIndex(): number {
		const current = this.view.currentPage();
		return this.pinned !== null && current === this.pinnedObserved ? this.pinned : current;
	}

	private setFollow(on: boolean): void {
		this.follow = on;
		this.pane?.setFollow(on);
		if (on) this.followNotes();
	}

	// --- chrome (link button, strip under the page) ---

	private updateChrome(): void {
		const pane = this.pane;
		const source = this.source;
		if (!pane || !source) return;
		const doc = this.view.document;
		const ref = source.refAt(this.index);
		const page = doc?.pages[this.notesIndex()];
		if (!doc || !page || !ref || this.blocked) {
			pane.setLinkState("disabled");
			pane.setBanner({ kind: "none" });
			return;
		}
		const data = this.svc.store.snapshot();
		pane.setLinkState(linkState(data, doc.id, page.id, ref));
		const linked = notesPagesFor(data, doc.id, ref, doc.pages.map((p) => p.id));
		let banner: Banner = { kind: "none" };
		if (linked.length === 0) banner = { kind: "add" };
		else if (!linked.includes(this.notesIndex())) banner = { kind: "show", label: t("pdfSide.linkedTo", { n: String(linked[0]! + 1) }) };
		pane.setBanner(banner);
	}

	private showLinkedNotes(): void {
		const doc = this.view.document;
		const ref = this.source?.refAt(this.index);
		if (!doc || !ref) return;
		const linked = notesPagesFor(this.svc.store.snapshot(), doc.id, ref, doc.pages.map((p) => p.id));
		if (linked.length > 0) this.moveNotes(linked[0]!);
		this.updateChrome();
	}

	/**
	 * Shows the PDF page linked to the notes page in view (also with Follow off). v12 (#226): the slide the selected ink was
	 * written beside comes first, and a page without a link shows the slide most of its ink was written beside.
	 */
	showSlideOfNotes(): void {
		const doc = this.view.document;
		const page = doc?.pages[this.notesIndex()];
		const selected = this.view.practiceHost().selectedStrokes();
		const inkRef = doc && selected ? slideOfStrokes(doc, selected.strokes) : null;
		if (inkRef) {
			void this.showSlideRef(inkRef).then((ok) => {
				if (!ok) showNotice(t("slides.notFound", { page: String(inkRef.page) }));
			});
			return;
		}
		const link = doc && page ? linkOf(this.svc.store.snapshot(), doc.id, page.id) : null;
		const target = link && this.source ? this.source.indexOf(link) : -1;
		if (target < 0 || !this.pane) {
			const pageRef = doc && page ? slideOfStrokes(doc, page.strokes) : null;
			if (pageRef) {
				void this.showSlideRef(pageRef).then((ok) => {
					if (!ok) showNotice(t("slides.notFound", { page: String(pageRef.page) }));
				});
				return;
			}
			showNotice(t("pdfSide.noSlide"));
			return;
		}
		this.index = target;
		this.pane.show(target);
		this.updateChrome();
	}

	// --- explicit link actions (the only writers of the links file) ---

	private currentLink(): { doc: NonNullable<NotebookView["document"]>; pageId: string; ref: PdfRef; index: number } | null {
		const doc = this.view.document;
		const ref = this.source?.refAt(this.index);
		const index = this.notesIndex();
		const page = doc?.pages[index];
		if (!doc || !page) return null;
		if (!ref) {
			showNotice(t("pdfSide.notAPdfPage"));
			return null;
		}
		return { doc, pageId: page.id, ref, index };
	}

	/** Links the notes page in view to the PDF page in view, or removes that link if it exists. */
	async toggleLink(): Promise<void> {
		const cur = this.currentLink();
		if (!cur || this.blocked) return;
		const state = linkState(this.svc.store.snapshot(), cur.doc.id, cur.pageId, cur.ref);
		if (state === "here") {
			if (await this.write({ type: "remove", notebook: cur.doc.id, notesPage: cur.pageId })) showNotice(t("pdfSide.unlinked"));
		} else if (await this.write({ type: "set", link: this.makeLink(cur.doc.id, cur.pageId, cur.ref) })) {
			showNotice(t("pdfSide.linked", { notes: String(cur.index + 1), slide: String(cur.ref.page) }));
		}
		this.updateChrome();
	}

	async linkCurrent(): Promise<void> {
		const cur = this.currentLink();
		if (!cur || this.blocked) return;
		if (linkState(this.svc.store.snapshot(), cur.doc.id, cur.pageId, cur.ref) !== "here") await this.toggleLink();
	}

	/** Adds a notes page for the PDF page in view (one undo step), placed in slide order, and links it. */
	async addNotesPage(): Promise<void> {
		const cur = this.currentLink();
		if (!cur) return;
		const doc = this.view.editableDocument();
		if (!doc || doc !== cur.doc) {
			showNotice(t("pdfSide.readOnly"));
			return;
		}
		const like = doc.pages[cur.index]!;
		const page = createPage({ width: like.width, height: like.height }, { ...like.paper });
		const data = this.svc.store.snapshot();
		const at = insertionIndex(data, doc.id, cur.ref, doc.pages.map((p) => p.id), cur.index);
		this.applying = true;
		let added = false;
		try {
			added = this.view.applyCommand(new AddPage(page, at), at);
		} finally {
			this.applying = false;
		}
		if (!added) {
			showNotice(t("pdfSide.readOnly"));
			return;
		}
		this.pinned = at;
		this.pinnedObserved = this.view.currentPage();
		if (!this.blocked && (await this.write({ type: "set", link: this.makeLink(doc.id, page.id, cur.ref) }))) {
			showNotice(t("pdfSide.added", { slide: String(cur.ref.page) }));
		}
		this.updateChrome();
	}

	private makeLink(notebook: string, notesPage: string, ref: PdfRef): PdfLink {
		const link: PdfLink = { notebook, notesPage, source: ref.source, page: ref.page };
		if (ref.path) link.path = ref.path;
		return link;
	}

	private async write(op: LinksOp): Promise<boolean> {
		try {
			await this.svc.store.update(op);
			return true;
		} catch (e) {
			if (e instanceof LinksBlockedError) {
				this.blocked = true;
				showNotice(t("pdfSide.linksBlocked", { path: this.svc.store.path }), 10000);
			} else {
				console.error("[notebook] saving the PDF link failed", e);
				showNotice(t("pdfSide.linkSaveFailed", { error: (e as Error).message }));
			}
			return false;
		}
	}

	private async reloadLinks(): Promise<void> {
		try {
			await this.svc.store.load();
			this.blocked = false;
		} catch (e) {
			if (!(e instanceof LinksBlockedError)) console.error("[notebook] reading the PDF links failed", e);
			this.blocked = true;
			showNotice(t("pdfSide.linksBlocked", { path: this.svc.store.path }), 10000);
		}
	}

	private scheduleReload(): void {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			const source = this.source;
			if (!source || !this.pane) return;
			void source.reload().then((changed) => {
				if (changed && this.source === source) {
					this.pane?.setSource(source, Math.min(this.index, source.pageCount() - 1));
					this.updateChrome();
				}
			});
		}, 1000);
	}
}

// --- registration, commands and menu ---

/** Textbook references (roadmap 208): what the PDF pane of a notebook view shows now, and a way to show a page in it. */
export function referencePane(view: NotebookView): { open: boolean; file: TFile | null; show(file: TFile, page: number): Promise<void> } | null {
	const c = controllerOf(view);
	return c ? { open: c.isOpen, file: c.shownFile, show: (file, page) => c.showPage(file, page) } : null;
}

/** Registers the commands. `activeView` is the notebook view that has focus, if any. */
/**
 * Sets up the side-by-side services (link store). The commands are generated from the action registry
 * (ui/actions.ts → view/commands.ts) and run through `runPdfSideAction`.
 */
export function initPdfSync(plugin: Plugin, folder: () => string): void {
	// The links file is a vault file in the notebooks folder's reserved `_meta`; the old file in the plugin's config folder
	// is only read (through the adapter, the one way to reach the config dir) to move it over. See docs/architecture.md.
	const legacy = { adapter: plugin.app.vault.adapter, path: `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/${LINKS_FILE}` };
	services = { app: plugin.app, store: new PdfLinkStore(vaultLinkFileAdapter(plugin.app), () => linksFolder(folder()), legacy), folder };
	plugin.register(() => {
		services = null;
	});
}

// --- v12 (#226, #417): ink linked to slides, the slide strip ---

/** v12 (#417): opens the slide strip of the notebook in `view` (every slide with its notes, exercise page and questions). */
export async function openSlideStripOf(view: NotebookView): Promise<void> {
	const doc = view.document;
	if (!doc || !services) return;
	const links = await notesLinksOf(view);
	if (view.document !== doc) return;
	const shown = controllers.get(view)?.slideKey ?? null;
	new SlideStripModal(services.app, {
		doc,
		name: view.file?.basename ?? "",
		links,
		current: shown,
		visible: (page) => visibleStrokes(page.strokes, view.markerTools?.isRevealed(page) ?? false),
		goToPage: (index) => view.practiceHost().goToPage(index),
		showSlide: (key) => void showSlideRef(view, key),
		openSideBySide: pdfSideState(view).available ? () => runPdfSideAction(view, "pdf-side-open") : null,
	}).open();
}

/** v12 (#226): the slide beside the notes as ink written now links it, or null (no pane, or no PDF page in it). */
export function referenceSlideKey(view: NotebookView): SlideKey | null {
	return controllers.get(view)?.slideKey ?? null;
}

/** v12 (#417): the PDF beside the notes and the index of the page in view, or null. */
export function referenceSource(view: NotebookView): { source: string; path?: string; index: number } | null {
	return controllers.get(view)?.shownSource ?? null;
}

/** v12 (#226): shows a slide ink was written beside (see PdfSyncController.showSlideRef); a notice when it is not found. */
export async function showSlideRef(view: NotebookView, ref: SlideKey): Promise<boolean> {
	const c = controllerOf(view);
	const ok = c ? await c.showSlideRef(ref) : false;
	if (!ok) showNotice(t("slides.notFound", { page: String(ref.page) }));
	return ok;
}

/** v12 (#417): the side-by-side links of the notebook open in `view`. */
export async function notesLinksOf(view: NotebookView): Promise<StripLink[]> {
	return (await controllerOf(view)?.notesLinks()) ?? [];
}

/** v8 gap markers: the 1-based page of the reference beside the notes, or null when none is open. */
export function referenceSlideOf(view: NotebookView): number | null {
	return controllerOf(view)?.slideInView ?? null;
}

/** ui redesign: whether side by side is available for this view and whether its pane is open (creates nothing). */
export function pdfSideState(view: NotebookView): { available: boolean; open: boolean } {
	return { available: services !== null, open: controllers.get(view)?.isOpen ?? false };
}

export type PdfSideAction = "pdf-side-open" | "pdf-side-close" | "pdf-side-link" | "pdf-side-add-page" | "pdf-side-show-slide";

/** ui redesign: runs a side-by-side action of the registry on this view; false when it does not apply now. */
export function runPdfSideAction(view: NotebookView, id: PdfSideAction): boolean {
	const c = controllerOf(view);
	if (!c || (id !== "pdf-side-open" && !c.isOpen)) return false;
	if (id === "pdf-side-open") c.pick();
	else if (id === "pdf-side-close") c.close();
	else if (id === "pdf-side-link") void c.linkCurrent();
	else if (id === "pdf-side-add-page") void c.addNotesPage();
	else c.showSlideOfNotes();
	return true;
}

