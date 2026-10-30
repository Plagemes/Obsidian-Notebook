/**
 * Quick textbook reference (roadmap 208), the part that talks to Obsidian: the textbook commands, the tappable
 * "p. 134" over the typed text, and the opening of the textbook at that page. The logic is in `textbook-ref.ts` (pure),
 * the configuration file in `textbook-store.ts`.
 *
 * - **Tappable reference.** For each page reference in a text box of a visible page, a small transparent DOM element is
 *   placed over the typed text (`notebook-textbook-ref`, like the Zettel card regions): the text itself stays what it is,
 *   nothing is written into the notebook. The element sits only over the reference (a few words), it is hidden while the
 *   text tool is active (a tap there edits the text) and when no textbook applies to the notebook. A tap on it with the pen
 *   or a finger opens the textbook; a long press / right click offers the textbooks and the other way of opening.
 * - **Opening.** In the PDF pane of the notebook view (beside the notes: works on phones, where Obsidian has no split
 *   panes) when that pane is closed or already shows this textbook; when the pane shows something else (the lecture
 *   slides) the slides are not replaced, and Obsidian's own PDF view opens at `#page=N` in a split instead.
 * - **Insert textbook reference** (command): asks for the page number and types "p. N" at the last pen position seen in
 *   the view (the middle of the page in view when there was none), as one undo step.
 */
import { FuzzySuggestModal, Menu, Modal, Notice, Setting, TFile, type App, type Plugin, type FuzzyMatch } from "obsidian";
import { measureText } from "../ink/renderer";
import { t } from "../i18n";
import { PromptModal } from "../library/library-modals";
import { createId } from "../model/document";
import { AddElement } from "../model/history";
import type { TextElement } from "../model/types";
import { sidecarDeviceId, vaultDeviceFileAdapter } from "../storage/vault-io";
import { NotebookView, VIEW_TYPE } from "./notebook-view";
import { referencePane } from "./pdf-sync";
import {
	pdfLinkText, pdfPageFor, placeRefs, referenceText, textbookName, textbooksFor, TEXTBOOKS_FILE,
	type PlacedRef, type Textbook, type TextbookScope,
} from "./textbook-ref";
import { TextbooksBlockedError, TextbookStore } from "./textbook-store";

/** Font size and colour of an inserted reference (link blue). */
const INSERT_FONT_SIZE = 14;
const INSERT_COLOR = "#2563eb";
const INSERT_WIDTH = 90;
/** A pen position older than this is not "where the pen is". */
const PEN_FRESH_MS = 120_000;

interface Services {
	app: App;
	store: TextbookStore;
	folder(): string;
}

let services: Services | null = null;
const overlays = new WeakMap<NotebookView, TextbookOverlay>();

// ---------------------------------------------------------------------------------------------------- opening

/** The PDF file of a textbook: its path, else the one PDF of that name in the vault (it was moved). */
function pdfFile(app: App, book: Textbook): TFile | null {
	const f = app.vault.getFileByPath(book.pdf);
	if (f) return f;
	const name = book.pdf.slice(book.pdf.lastIndexOf("/") + 1).toLowerCase();
	const same = app.vault.getFiles().filter((x) => x.extension.toLowerCase() === "pdf" && x.name.toLowerCase() === name);
	return same.length === 1 ? same[0]! : null;
}

async function openBook(view: NotebookView, book: Textbook, printed: number, how: "auto" | "pane" | "obsidian" = "auto"): Promise<void> {
	if (!services) return;
	const { app } = services;
	const file = pdfFile(app, book);
	if (!file) {
		new Notice(t("textbook.missing", { path: book.pdf }), 8000);
		return;
	}
	const page = pdfPageFor(book, printed);
	const pane = referencePane(view);
	const inPane = how === "pane" || (how === "auto" && !!pane && (!pane.open || pane.file === file));
	if (inPane && pane) {
		await pane.show(file, page);
		return;
	}
	await app.workspace.openLinkText(pdfLinkText(file.path, page), "", "split");
}

// ---------------------------------------------------------------------------------------------------- overlay

interface Chip {
	el: HTMLElement;
}

/** The "p. 134" hot spots over the typed text of one notebook view. */
class TextbookOverlay {
	private readonly root: HTMLElement;
	private readonly chips = new Map<string, Chip>();
	private readonly cache = new Map<string, { sig: string; refs: PlacedRef[] }>();
	private frame: number | null = null;
	private readonly off: Array<() => void> = [];
	private pen: { pageIndex: number; x: number; y: number; at: number } | null = null;
	private stage: HTMLElement | null = null;

	constructor(private readonly view: NotebookView) {
		this.root = createDiv({ cls: "notebook-textbook-overlay" });
		this.off.push(view.addOverlayListener(() => this.draw()));
		this.draw();
	}

	detach(): void {
		for (const off of this.off) off();
		this.off.length = 0;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.root.remove();
	}

	/** Draws again on the next frame (the configuration or a text changed). */
	refresh(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.draw();
		});
	}

	/** The last pen position seen over the pages, in page coordinates. */
	lastPen(): { pageIndex: number; x: number; y: number } | null {
		return this.pen && Date.now() - this.pen.at < PEN_FRESH_MS ? this.pen : null;
	}

	private watch(stage: HTMLElement): void {
		if (this.stage === stage) return;
		this.stage = stage;
		const remember = (e: PointerEvent) => this.notePointer(e);
		const after = () => this.refresh();
		stage.addEventListener("pointermove", remember, { capture: true, passive: true });
		stage.addEventListener("pointerdown", remember, { capture: true, passive: true });
		// A text box was edited: its references may have changed.
		stage.addEventListener("pointerup", after, { capture: true, passive: true });
		stage.addEventListener("keyup", after, { capture: true, passive: true });
		this.off.push(() => {
			stage.removeEventListener("pointermove", remember, { capture: true });
			stage.removeEventListener("pointerdown", remember, { capture: true });
			stage.removeEventListener("pointerup", after, { capture: true });
			stage.removeEventListener("keyup", after, { capture: true });
		});
	}

	private notePointer(e: PointerEvent): void {
		if (e.pointerType === "touch") return;
		const geometry = this.view.overlayGeometry();
		if (!geometry) return;
		const rect = geometry.stage.getBoundingClientRect();
		const { scale, offsetX, offsetY } = geometry.viewport;
		const docX = (e.clientX - rect.left - offsetX) / scale;
		const docY = (e.clientY - rect.top - offsetY) / scale;
		const index = geometry.boxes.findIndex((b) => docX >= b.x && docX <= b.x + b.width && docY >= b.y && docY <= b.y + b.height);
		const box = geometry.boxes[index];
		if (box) this.pen = { pageIndex: index, x: docX - box.x, y: docY - box.y, at: Date.now() };
	}

	private hide(): void {
		this.root.toggleClass("notebook-hidden", true);
	}

	draw(): void {
		const geometry = this.view.overlayGeometry();
		const doc = this.view.document;
		const file = this.view.file;
		if (!geometry || !doc || !file || !services) return this.hide();
		this.watch(geometry.stage);
		const books = textbooksFor(services.store.snapshot(), doc.id, file.path);
		if (books.length === 0 || this.view.activeTool() === "text") return this.hide();
		if (this.root.parentElement !== geometry.stage) geometry.stage.appendChild(this.root);
		this.root.toggleClass("notebook-hidden", false);

		const { scale, offsetX, offsetY } = geometry.viewport;
		const stageW = geometry.stage.clientWidth;
		const stageH = geometry.stage.clientHeight;
		const keep = new Set<string>();
		doc.pages.forEach((page, i) => {
			const box = geometry.boxes[i];
			if (!box || !page.elements?.length) return;
			const top = offsetY + box.y * scale;
			if (top > stageH || top + box.height * scale < 0 || offsetX + box.x * scale > stageW || offsetX + (box.x + box.width) * scale < 0) return;
			for (const el of page.elements) {
				if (el.type !== "text") continue;
				for (const ref of this.refsOf(el)) {
					const left = offsetX + (box.x + ref.rect.x) * scale;
					const y = offsetY + (box.y + ref.rect.y) * scale;
					const w = ref.rect.width * scale;
					const h = ref.rect.height * scale;
					if (left > stageW || y > stageH || left + w < 0 || y + h < 0) continue;
					const id = `${el.id}:${ref.start}`;
					keep.add(id);
					let chip = this.chips.get(id);
					if (!chip) {
						chip = this.makeChip();
						this.chips.set(id, chip);
					}
					const printed = ref.page;
					chip.el.dataset.page = String(printed);
					chip.el.setAttribute("aria-label", t("textbook.open", { page: String(printed) }));
					chip.el.setCssProps({
						"--notebook-textbook-x": `${left}px`,
						"--notebook-textbook-y": `${y}px`,
						"--notebook-textbook-w": `${Math.max(w, 28)}px`,
						"--notebook-textbook-h": `${Math.max(h, 24)}px`,
					});
				}
			}
		});
		for (const [id, chip] of this.chips) {
			if (keep.has(id)) continue;
			chip.el.remove();
			this.chips.delete(id);
		}
		if (this.cache.size > 400) this.cache.clear();
	}

	private refsOf(el: TextElement): PlacedRef[] {
		const sig = `${el.x}|${el.y}|${el.width}|${el.fontSize}|${el.text}`;
		const hit = this.cache.get(el.id);
		if (hit?.sig === sig) return hit.refs;
		const refs = placeRefs(el, (s) => measureText(s, el.fontSize));
		this.cache.set(el.id, { sig, refs });
		return refs;
	}

	private makeChip(): Chip {
		const el = this.root.createEl("a", { cls: "notebook-textbook-ref", attr: { role: "link", tabindex: "0" } });
		const printed = () => Number(el.dataset.page);
		const books = () => {
			const doc = this.view.document;
			const file = this.view.file;
			return services && doc && file ? textbooksFor(services.store.snapshot(), doc.id, file.path) : [];
		};
		const activate = (event: MouseEvent | KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			const list = books();
			if (list.length === 0) return;
			if (list.length === 1) void openBook(this.view, list[0]!, printed());
			else this.menu(event instanceof MouseEvent ? event : null, el, list, printed());
		};
		el.addEventListener("click", activate);
		el.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") activate(e);
		});
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const list = books();
			if (list.length > 0) this.menu(e, el, list, printed(), true);
		});
		return { el };
	}

	private menu(event: MouseEvent | null, el: HTMLElement, list: Textbook[], printed: number, withModes = false): void {
		const menu = new Menu();
		for (const book of list) {
			menu.addItem((i) => i.setTitle(t("textbook.menu.open", { name: textbookName(book), page: String(pdfPageFor(book, printed)) })).setIcon("book-open")
				.onClick(() => void openBook(this.view, book, printed)));
		}
		if (withModes) {
			const first = list[0]!;
			menu.addSeparator();
			menu.addItem((i) => i.setTitle(t("textbook.menu.pane")).setIcon("columns-2").onClick(() => void openBook(this.view, first, printed, "pane")));
			menu.addItem((i) => i.setTitle(t("textbook.menu.obsidian")).setIcon("file-text").onClick(() => void openBook(this.view, first, printed, "obsidian")));
		}
		if (event) menu.showAtMouseEvent(event);
		else {
			const r = el.getBoundingClientRect();
			menu.showAtPosition({ x: r.left, y: r.bottom });
		}
	}
}

// ---------------------------------------------------------------------------------------------------- modals

/** PDFs of the vault (not the content-addressed copies in a notebooks folder's `_assets`). */
class PdfPickModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly files: TFile[], private readonly onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder(t("textbook.pick.placeholder"));
		this.emptyStateText = t("textbook.pick.none");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

class TextbookModal extends Modal {
	private chosen: TextbookScope = "notebook";
	private label = "";
	private offset = "0";

	constructor(
		app: App,
		private readonly opts: { pdf: TFile; folder: string; notebookName: string; initial: Partial<Textbook> },
		private readonly onSave: (scope: TextbookScope, label: string, offset: number) => void,
	) {
		super(app);
		this.chosen = opts.initial.scope ?? "notebook";
		this.label = opts.initial.label ?? "";
		this.offset = String(opts.initial.offset ?? 0);
	}

	onOpen(): void {
		this.setTitle(t("textbook.modal.title", { name: this.opts.pdf.basename }));
		const { contentEl } = this;
		new Setting(contentEl)
			.setName(t("textbook.modal.scope"))
			.setDesc(t("textbook.modal.scope.desc"))
			.addDropdown((dd) => dd
				.addOption("notebook", t("textbook.scope.notebook", { name: this.opts.notebookName }))
				.addOption("folder", t("textbook.scope.folder", { folder: this.opts.folder || "/" }))
				.addOption("all", t("textbook.scope.all"))
				.setValue(this.chosen)
				.onChange((v) => {
					if (v === "notebook" || v === "folder" || v === "all") this.chosen = v;
				}));
		new Setting(contentEl)
			.setName(t("textbook.modal.offset"))
			.setDesc(t("textbook.modal.offset.desc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.step = "1";
				text.setValue(this.offset).onChange((v) => (this.offset = v));
			});
		new Setting(contentEl)
			.setName(t("textbook.modal.label"))
			.setDesc(t("textbook.modal.label.desc"))
			.addText((text) => text.setValue(this.label).onChange((v) => (this.label = v)));
		contentEl.createDiv({ cls: "notebook-modal-error notebook-hidden" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("zettel.modal.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("textbook.modal.save")).setCta().onClick(() => this.save()));
	}

	private save(): void {
		const offset = Number(this.offset.replace(",", "."));
		const error = this.contentEl.querySelector<HTMLElement>(".notebook-modal-error");
		if (!Number.isInteger(offset) || Math.abs(offset) > 5000) {
			error?.setText(t("textbook.modal.offsetBad"));
			error?.toggleClass("notebook-hidden", false);
			return;
		}
		this.close();
		this.onSave(this.chosen, this.label.trim(), offset);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class TextbookRemoveModal extends FuzzySuggestModal<Textbook> {
	constructor(app: App, private readonly books: Textbook[], private readonly onPick: (b: Textbook) => void) {
		super(app);
		this.setPlaceholder(t("textbook.remove.placeholder"));
		this.emptyStateText = t("textbook.remove.none");
	}

	getItems(): Textbook[] {
		return this.books;
	}

	getItemText(b: Textbook): string {
		return `${textbookName(b)} ${b.pdf}`;
	}

	renderSuggestion(match: FuzzyMatch<Textbook>, el: HTMLElement): void {
		const b = match.item;
		el.createDiv({ text: textbookName(b) });
		const where = b.scope === "all" ? t("textbook.scope.all") : b.scope === "folder" ? t("textbook.scope.folder", { folder: b.target || "/" }) : t("textbook.remove.notebook");
		el.createDiv({ text: `${where} · ${b.pdf}`, cls: "notebook-picker-path" });
	}

	onChooseItem(b: Textbook): void {
		this.onPick(b);
	}
}

// ---------------------------------------------------------------------------------------------------- commands

function reportBlocked(e: unknown): void {
	if (e instanceof TextbooksBlockedError) new Notice(t("textbook.blocked", { path: services?.store.path ?? TEXTBOOKS_FILE, error: e.message }), 10000);
	else new Notice(t("textbook.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
	console.error("[notebook] textbooks", e);
}

function pdfFiles(app: App): TFile[] {
	return app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pdf" && !/(^|\/)_assets\//.test(f.path)).sort((a, b) => a.path.localeCompare(b.path));
}

export function setTextbook(view: NotebookView): void {
	if (!services) return;
	const { app, store } = services;
	const doc = view.document;
	const file = view.file;
	if (!doc || !file) return;
	new PdfPickModal(app, pdfFiles(app), (pdf) => {
		const folder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
		const existing = store.snapshot().books.find((b) => b.pdf === pdf.path && ((b.scope === "notebook" && b.target === doc.id) || (b.scope === "folder" && b.target === folder)));
		new TextbookModal(app, { pdf, folder, notebookName: file.basename, initial: existing ?? {} }, (scope, label, offset) => {
			const book: Textbook = { scope, target: scope === "notebook" ? doc.id : scope === "folder" ? folder : "", pdf: pdf.path, offset };
			if (label) book.label = label;
			void store.update({ type: "set", book })
				.then(() => {
					new Notice(t("textbook.saved", { name: textbookName(book) }));
					refreshAll();
				})
				.catch(reportBlocked);
		}).open();
	}).open();
}

export function removeTextbook(view: NotebookView): void {
	if (!services) return;
	const { app, store } = services;
	const doc = view.document;
	const file = view.file;
	const books = doc && file ? textbooksFor(store.snapshot(), doc.id, file.path) : store.snapshot().books;
	new TextbookRemoveModal(app, books, (book) => {
		void store.update({ type: "remove", book })
			.then(() => {
				new Notice(t("textbook.removed", { name: textbookName(book) }));
				refreshAll();
			})
			.catch(reportBlocked);
	}).open();
}

/** Opens the first textbook of the notebook at a printed page typed in a dialog. */
export function openPage(view: NotebookView): void {
	if (!services) return;
	const doc = view.document;
	const file = view.file;
	const books = doc && file ? textbooksFor(services.store.snapshot(), doc.id, file.path) : [];
	const book = books[0];
	if (!book) {
		new Notice(t("textbook.none"));
		return;
	}
	new PromptModal(services.app, { title: t("textbook.openPage.title", { name: textbookName(book) }), label: t("textbook.openPage.label"), cta: t("textbook.openPage.cta") }, (value) => {
		const text = referenceText(value);
		const n = text ? Number(text.slice(3)) : 0;
		if (n >= 1) void openBook(view, book, n);
		else new Notice(t("textbook.badPage"));
	}).open();
}

/** *Insert textbook reference*: types "p. N" where the pen was last seen. */
export function insertReference(view: NotebookView): void {
	if (!services) return;
	const doc = view.document;
	if (!doc) return;
	new PromptModal(services.app, { title: t("textbook.insert.title"), label: t("textbook.insert.label"), cta: t("textbook.insert.cta") }, (value) => {
		const text = referenceText(value);
		if (!text) {
			new Notice(t("textbook.badPage"));
			return;
		}
		const ctx = view.editContext();
		if (!ctx) {
			new Notice(t("textbook.insert.busy"));
			return;
		}
		const pen = overlays.get(view)?.lastPen() ?? null;
		const pageIndex = pen && ctx.doc.pages[pen.pageIndex] ? pen.pageIndex : ctx.currentPage();
		const page = ctx.doc.pages[pageIndex];
		if (!page) return;
		let x = pen?.pageIndex === pageIndex ? pen.x : page.width / 2 - INSERT_WIDTH / 2;
		let y: number;
		if (pen?.pageIndex === pageIndex) y = pen.y;
		else {
			const visible = ctx.visibleLocal(pageIndex);
			y = visible ? (visible.minY + visible.maxY) / 2 : page.height / 2;
		}
		x = Math.max(0, Math.min(page.width - INSERT_WIDTH, x));
		y = Math.max(0, Math.min(page.height - INSERT_FONT_SIZE * 1.25, y));
		const element: TextElement = { id: createId(), type: "text", x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, width: INSERT_WIDTH, text, fontSize: INSERT_FONT_SIZE, color: INSERT_COLOR };
		ctx.execute(new AddElement(page.id, element, page.elements?.length ?? 0), pageIndex);
		new Notice(t("textbook.insert.done", { text }));
	}).open();
}

// ---------------------------------------------------------------------------------------------------- registration

function views(app: App): NotebookView[] {
	return app.workspace.getLeavesOfType(VIEW_TYPE).flatMap((leaf) => (leaf.view instanceof NotebookView ? [leaf.view] : []));
}

function refreshAll(): void {
	if (!services) return;
	for (const view of views(services.app)) overlays.get(view)?.refresh();
}

/**
 * Registers the reference overlay and the configuration watcher (roadmap 208). Called once from `onload`. The commands
 * (`textbook-set`, `-remove`, `-open`, `-insert`) are view actions of the action registry (ui/actions.ts, view/view-actions.ts).
 */
export function registerTextbookRefs(plugin: Plugin, folder: () => string): void {
	const { app } = plugin;
	const store = new TextbookStore(vaultDeviceFileAdapter(app), folder, sidecarDeviceId(app));
	services = { app, store, folder };
	plugin.register(() => {
		for (const view of views(app)) overlays.get(view)?.detach();
		services = null;
	});

	const attach = () => {
		if (!services) return;
		const live = new Set<NotebookView>();
		for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (!(view instanceof NotebookView)) continue;
			live.add(view);
			if (!overlays.has(view)) overlays.set(view, new TextbookOverlay(view));
		}
		for (const view of views(app)) {
			if (live.has(view)) continue;
			overlays.get(view)?.detach();
			overlays.delete(view);
		}
	};
	const reload = () => void store.load().then(refreshAll, (e) => console.error("[notebook] textbooks", e));
	app.workspace.onLayoutReady(() => {
		reload();
		attach();
		// The file is read again when it changes (another device, or an explicit action here); looking never writes.
		const changed = (f: { path: string }) => {
			if (store.watches(f.path)) reload();
		};
		plugin.registerEvent(app.vault.on("modify", changed));
		plugin.registerEvent(app.vault.on("create", changed));
		plugin.registerEvent(app.vault.on("delete", changed));
	});
	plugin.registerEvent(app.workspace.on("layout-change", attach));
	plugin.registerEvent(app.workspace.on("active-leaf-change", () => refreshAll()));
}
