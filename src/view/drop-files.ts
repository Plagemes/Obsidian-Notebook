/**
 * 0.20 (#79): files dragged straight onto a page. Listens on the canvas area only (never the pen or pointer input): pictures
 * become image elements at the drop point, PDFs are offered as pages / pictures / a notebook of their own, and a note dragged
 * from Obsidian's file explorer becomes a link. Everything is stored through the existing asset store and goes through the
 * History as one undo step, so a locked page and a read-only notebook refuse it like any other edit. No format change.
 */
import { Modal, TFile, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { linkMarkup } from "../ink/link-text";
import { AddAsset, AddElement, Batch, type Command } from "../model/history";
import { isLocked } from "../model/page-lock";
import type { Asset, Page, PageElement } from "../model/types";
import { NOTEBOOK_EXTENSIONS } from "../storage/format";
import { carriesFiles, fileSource } from "../library/bulk-drop";
import { PhotoDecodeError, photoSize } from "../scan/decode";
import { isHeic } from "../scan/image-bytes";
import { modalShell, shellButton, shellRow } from "../ui/components/modal-shell";
import {
	cascadeCentres, classifyDrop, imagePageRange, locateDrop, planDrop, skipEntries,
	type DropMeta, type DropPoint, type DropReason,
} from "./drop-files-logic";
import type { EditContext } from "./edit-context";
import type { NotebookMedia } from "./media";
import { storeAsset } from "./media";
import { showNotice } from "./notice";
import { askPdfRange } from "./pdf-range-modal";
import { pastedImageElement, pastedTextElement } from "./paste-logic";
import { stemOf } from "../library/bulk-import-logic";
import type { Layout } from "../ink/layout";
import type { Viewport } from "../ink/viewport";

/** One dropped file: what is known before it is read, and how to read it. */
interface DropSource {
	meta: DropMeta;
	read(): Promise<ArrayBuffer>;
	/** The file as dropped from another app. */
	file?: File;
	/** The file as dragged from Obsidian's explorer. */
	vault?: TFile;
}

/** What the notebook view gives this module. */
export interface DropFilesHost {
	app: App;
	/** The canvas area that takes drops. */
	stage: HTMLElement;
	/** Where the drop indicator is drawn (it covers the stage). */
	overlayParent: HTMLElement;
	/** Adds a DOM listener that goes away with the view. */
	listen<K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, handler: (e: HTMLElementEventMap[K]) => void): void;
	editable(): boolean;
	context(): EditContext | null;
	layout(): Layout | null;
	viewport(): Viewport;
	media(): NotebookMedia | null;
	textStyle(): { fontSize: number; color: string };
	/** Selects the placed elements (and switches to the lasso, so they can be moved at once). */
	select(pageIndex: number, elements: PageElement[]): void;
	/** The existing "insert PDF" path with the bytes already in hand; resolves with the number of pages inserted. */
	insertPdfPages(source: { name: string; bytes: ArrayBuffer }, afterIndex: number): Promise<number>;
	/** "Annotate in a new notebook": the plugin's PDF import for a dropped file or a vault file. Absent: not offered. */
	annotate?(source: File | TFile): void;
}

type PdfChoice = "pages" | "images" | "annotate";

/** What Obsidian's own file explorer is dragging right now (`app.dragManager.draggable`, not public API), as vault files. */
export function internalDragFiles(app: App): TFile[] {
	const manager = (app as unknown as { dragManager?: { draggable?: { type?: string; file?: unknown; files?: unknown } | null } }).dragManager;
	const d = manager?.draggable;
	if (!d) return [];
	if (d.type === "file" && d.file instanceof TFile) return [d.file];
	if (d.type === "files" && Array.isArray(d.files)) return d.files.filter((f): f is TFile => f instanceof TFile);
	return [];
}

/** The dropped files, read from the event (a `DataTransfer` is only valid during it). */
function sourcesOf(app: App, dt: DataTransfer | null): DropSource[] {
	const vault = internalDragFiles(app);
	if (vault.length > 0) {
		return vault.map((f) => ({
			meta: { name: f.name, size: f.stat.size, type: "", origin: "vault" as const },
			read: () => app.vault.readBinary(f),
			vault: f,
		}));
	}
	if (!dt) return [];
	return Array.from(dt.files).map((file) => ({
		meta: { name: file.name, size: file.size, type: file.type, origin: "os" as const },
		read: () => fileSource(file).read(),
		file,
	}));
}

/** The frame, the chip with the target page and the ring on the drop point (decoration: it never takes a pointer). */
class DropIndicator {
	private readonly root: HTMLElement;
	private readonly chip: HTMLElement;
	private readonly ring: HTMLElement;
	private label = "";
	private blocked = false;
	private active = false;
	private timer: number | null = null;

	constructor(parent: HTMLElement) {
		this.root = parent.createDiv({ cls: "nb-ui nb-drop-zone", attr: { "aria-hidden": "true" } });
		this.root.createDiv({ cls: "nb-drop-frame" });
		this.chip = this.root.createDiv({ cls: "nb-drop-chip" });
		this.ring = this.root.createDiv({ cls: "nb-drop-ring" });
	}

	/** Shows the indicator with the ring at (x, y) in the indicator's own pixels. Hides itself if no more drag events come. */
	show(x: number, y: number, label: string, blocked: boolean, icon: string): void {
		if (!this.active) {
			this.active = true;
			this.root.addClass("is-active");
		}
		if (label !== this.label || blocked !== this.blocked) {
			this.label = label;
			this.blocked = blocked;
			this.root.toggleClass("is-blocked", blocked);
			this.chip.empty();
			setIcon(this.chip.createSpan({ cls: "nb-drop-chip-icon" }), blocked ? "lock" : icon);
			this.chip.createSpan({ cls: "nb-drop-chip-text", text: label });
		}
		this.ring.setCssProps({ "--nb-drop-x": `${Math.round(x)}px`, "--nb-drop-y": `${Math.round(y)}px` });
		// A drag that leaves the window may never say so: the indicator goes away on its own.
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.hide(), 450);
	}

	hide(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (!this.active) return;
		this.active = false;
		this.root.removeClass("is-active");
	}

	destroy(): void {
		this.hide();
		this.root.remove();
	}
}

/** The choice for dropped PDFs. Resolves null when dismissed. */
function askPdfDrop(app: App, names: readonly string[], canAnnotate: boolean): Promise<PdfChoice | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (v: PdfChoice | null) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		class PdfDropModal extends Modal {
			onOpen(): void {
				const shell = modalShell(this, {
					title: t("drop.pdf.title"), subtitle: names.length === 1 ? names[0] : t("drop.pdf.many", { n: String(names.length) }),
					icon: "file-input", size: "narrow", cls: "nb-drop-pdf",
				});
				const pick = (c: PdfChoice) => {
					finish(c);
					this.close();
				};
				shellRow(shell.body, { label: t("drop.pdf.pages"), detail: t("drop.pdf.pages.desc"), onClick: () => pick("pages") });
				shellRow(shell.body, { label: t("drop.pdf.images"), detail: t("drop.pdf.images.desc", { n: String(imagePageRange({ from: 1, to: 999 }).to) }), onClick: () => pick("images") });
				if (canAnnotate) shellRow(shell.body, { label: t("drop.pdf.annotate"), detail: t("drop.pdf.annotate.desc"), onClick: () => pick("annotate") });
				shellButton(shell.foot, "secondary", t("library.modal.cancel"), () => this.close());
			}

			onClose(): void {
				this.contentEl.empty();
				finish(null);
			}
		}
		new PdfDropModal(app).open();
	});
}

/** One notice for everything that was left out. */
function skippedNotice(skipped: Record<DropReason, number>): void {
	const parts = skipEntries(skipped).map(({ reason, n }) => t(`drop.skip.${reason}`, { n: String(n) }));
	if (parts.length > 0) showNotice(t("drop.skipped", { what: parts.join(", ") }), 9000);
}

/** Makes the canvas area take files dropped on it. Returns a function that removes the indicator. */
export function attachDropFiles(host: DropFilesHost): () => void {
	const indicator = new DropIndicator(host.overlayParent);
	let rect: DOMRect | null = null;
	let busy = false;
	const accepts = (dt: DataTransfer | null) => carriesFiles(dt) || internalDragFiles(host.app).length > 0;

	const where = (e: DragEvent): { point: DropPoint | null; label: string; blocked: boolean } => {
		const point = host.layout() ? locateDrop(host.layout(), host.viewport(), rect ?? host.stage.getBoundingClientRect(), e.clientX, e.clientY) : null;
		if (!host.editable()) return { point, label: t("drop.readOnly"), blocked: true };
		if (!point) return { point, label: t("drop.here"), blocked: false };
		const page = host.context()?.doc.pages[point.pageIndex] ?? null;
		if (isLocked(page)) return { point, label: t("lock.pageIs", { n: String(point.pageIndex + 1) }), blocked: true };
		return { point, label: t("drop.onPage", { n: String(point.pageIndex + 1) }), blocked: false };
	};

	host.listen(host.stage, "dragenter", (e) => {
		if (!accepts(e.dataTransfer)) return;
		e.preventDefault();
		rect = host.stage.getBoundingClientRect();
	});
	host.listen(host.stage, "dragover", (e) => {
		if (!accepts(e.dataTransfer)) return;
		// Without this the app would copy the files into the vault as attachments, or the drop would be refused.
		e.preventDefault();
		e.stopPropagation();
		rect ??= host.stage.getBoundingClientRect();
		const { label, blocked } = where(e);
		if (e.dataTransfer) e.dataTransfer.dropEffect = blocked ? "none" : "copy";
		indicator.show(e.clientX - rect.left, e.clientY - rect.top, label, blocked, "image-plus");
	});
	host.listen(host.stage, "dragleave", (e) => {
		if (e.relatedTarget instanceof Node && host.stage.contains(e.relatedTarget)) return;
		indicator.hide();
		rect = null;
	});
	host.listen(host.stage, "drop", (e) => {
		indicator.hide();
		rect = null;
		if (!accepts(e.dataTransfer)) return;
		e.preventDefault();
		e.stopPropagation();
		const sources = sourcesOf(host.app, e.dataTransfer);
		if (sources.length === 0) return;
		if (busy) {
			showNotice(t("drop.busy"));
			return;
		}
		const at = locateDrop(host.layout(), host.viewport(), host.stage.getBoundingClientRect(), e.clientX, e.clientY);
		busy = true;
		void handleDrop(host, sources, at).finally(() => (busy = false));
	});
	return () => indicator.destroy();
}

/** What to do with a drop: the pictures and notes are placed at once, then each PDF follows the user's choice. */
async function handleDrop(host: DropFilesHost, sources: DropSource[], at: DropPoint | null): Promise<void> {
	try {
		const plan = planDrop(sources.map((s) => s.meta), NOTEBOOK_EXTENSIONS);
		const skipped = plan.skipped;
		const taken = plan.items.map((i) => ({ ...i, source: sources[i.index]! }));
		if (taken.length === 0) {
			skippedNotice(skipped);
			return;
		}
		if (!host.editable()) {
			showNotice(t("drop.readOnly"));
			return;
		}
		const ctx = host.context();
		if (!ctx) {
			showNotice(t("drop.cannot"));
			return;
		}
		const point = at ?? { pageIndex: ctx.currentPage(), x: 0, y: 0 };
		const page = ctx.doc.pages[point.pageIndex];
		if (!page) return;
		if (isLocked(page)) {
			showNotice(t("lock.pageIs", { n: String(point.pageIndex + 1) }));
			return;
		}
		const centre = at ? { x: point.x, y: point.y } : { x: page.width / 2, y: page.height / 2 };

		const flat = taken.filter((i) => i.kind !== "pdf");
		if (flat.length > 0) await placeFlat(host, ctx, page, centre, flat.map((i) => i.source), skipped);
		const pdfs = taken.filter((i) => i.kind === "pdf").map((i) => i.source);
		skippedNotice(skipped);
		if (pdfs.length > 0) await handlePdfs(host, page.id, centre, pdfs);
	} catch (e) {
		console.error("[notebook] drop files", e);
		showNotice(t("insert.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
	}
}

/** The page with this id and its index, if the same document is still open and editable. */
function findPage(host: DropFilesHost, pageId: string): { ctx: EditContext; page: Page; index: number } | null {
	const ctx = host.context();
	if (!ctx) return null;
	const index = ctx.doc.pages.findIndex((p) => p.id === pageId);
	const page = ctx.doc.pages[index];
	return page ? { ctx, page, index } : null;
}

/** Pictures become image elements and notes become links, all in one undo step, in a cascade from the drop point. */
async function placeFlat(
	host: DropFilesHost, ctx: EditContext, page: Page, centre: { x: number; y: number }, sources: DropSource[], skipped: Record<DropReason, number>,
): Promise<void> {
	const assets: Asset[] = [];
	const elements: PageElement[] = [];
	const centres = cascadeCentres(sources.length, centre.x, centre.y, page);
	try {
		for (const [i, source] of sources.entries()) {
			const [cx, cy] = centres[i] ?? [centre.x, centre.y];
			try {
				const kind = classifyDrop(source.meta, NOTEBOOK_EXTENSIONS).kind;
				if (kind === "note" && source.vault) {
					const linktext = host.app.metadataCache.fileToLinktext(source.vault, ctx.file?.path ?? "");
					const style = host.textStyle();
					elements.push(pastedTextElement(linkMarkup(linktext), page, cx, cy, style.fontSize, style.color));
					continue;
				}
				const bytes = await source.read();
				if (isHeic(bytes)) {
					skipped.heic++;
					continue;
				}
				const dims = await photoSize(bytes, source.meta.name, source.meta.type);
				const asset = await storeAsset(host.app, ctx.folder, bytes, source.meta.name, "image");
				ctx.addPending(asset);
				assets.push(asset);
				elements.push(pastedImageElement(asset.id, dims, page, cx, cy));
			} catch (e) {
				console.error("[notebook] dropped file", source.meta.name, e);
				if (e instanceof PhotoDecodeError && e.reason === "heic") skipped.heic++;
				else skipped.unreadable++;
			}
		}
		if (elements.length === 0) return;
		const here = findPage(host, page.id);
		if (!here || here.ctx.doc !== ctx.doc || !here.ctx.alive()) return;
		const base = here.page.elements?.length ?? 0;
		const commands: Command[] = [...assets.map((a) => new AddAsset(a)), ...elements.map((el, i) => new AddElement(here.page.id, el, base + i))];
		// Refused (the page was locked meanwhile): the history said so.
		if (!here.ctx.execute(new Batch("Drop files", commands))) return;
		host.select(here.index, elements);
		showNotice(t(elements.length === 1 ? "drop.done.one" : "drop.done.many", { n: String(elements.length) }));
	} finally {
		for (const a of assets) ctx.removePending(a.id);
	}
}

/** PDFs: one question for all of them, then the existing import paths. */
async function handlePdfs(host: DropFilesHost, pageId: string, centre: { x: number; y: number }, pdfs: DropSource[]): Promise<void> {
	const choice = await askPdfDrop(host.app, pdfs.map((p) => p.meta.name), host.annotate !== undefined);
	if (!choice) return;
	if (choice === "annotate") {
		for (const pdf of pdfs) {
			const src = pdf.vault ?? pdf.file;
			if (src) host.annotate?.(src);
		}
		return;
	}
	let after = findPage(host, pageId)?.index ?? -1;
	if (after < 0) {
		showNotice(t("drop.cannot"));
		return;
	}
	for (const pdf of pdfs) {
		if (choice === "pages") {
			const bytes = await pdf.read();
			const inserted = await host.insertPdfPages({ name: pdf.meta.name, bytes }, after);
			if (inserted <= 0) return;
			after += inserted;
		} else if (!(await pdfAsImages(host, pageId, centre, pdf))) {
			return;
		}
	}
}

/** The first pages of a PDF as pictures on the page the file was dropped on. True when they were placed. */
async function pdfAsImages(host: DropFilesHost, pageId: string, centre: { x: number; y: number }, pdf: DropSource): Promise<boolean> {
	const media = host.media();
	const first = findPage(host, pageId);
	if (!media || !first) return false;
	const { ctx } = first;
	const assets: Asset[] = [];
	const elements: PageElement[] = [];
	let working: ReturnType<typeof showNotice> | null = null;
	try {
		const bytes = await pdf.read();
		const pdfAsset = await storeAsset(host.app, ctx.folder, bytes, pdf.meta.name, "pdf");
		ctx.addPending(pdfAsset);
		assets.push(pdfAsset);
		const sizes = await media.pdf.pageSizes(pdfAsset.id);
		if (sizes.length === 0) {
			showNotice(t("import.empty"));
			return false;
		}
		const chosen = sizes.length === 1 ? { from: 1, to: 1 } : await askPdfRange(host.app, sizes.length);
		if (!chosen) return false;
		const range = imagePageRange(chosen);
		if (range.cut) showNotice(t("drop.pdf.cut", { n: String(range.to - range.from + 1) }), 7000);
		working = showNotice(t("insert.working"), 0);
		const stem = stemOf(pdf.meta.name) || "pdf";
		const count = range.to - range.from + 1;
		const here0 = findPage(host, pageId);
		if (!here0) return false;
		const centres = cascadeCentres(count, centre.x, centre.y, here0.page);
		for (let n = range.from; n <= range.to; n++) {
			const shot = await media.pdfPageJpeg(pdfAsset.id, n, 150);
			const jpeg = shot.jpeg.buffer.slice(shot.jpeg.byteOffset, shot.jpeg.byteOffset + shot.jpeg.byteLength) as ArrayBuffer;
			const asset = await storeAsset(host.app, ctx.folder, jpeg, `${stem}-p${n}.jpg`, "image");
			ctx.addPending(asset);
			assets.push(asset);
			const [cx, cy] = centres[n - range.from] ?? [centre.x, centre.y];
			elements.push(pastedImageElement(asset.id, { width: shot.pixelWidth, height: shot.pixelHeight }, here0.page, cx, cy));
		}
		const here = findPage(host, pageId);
		if (!here || here.ctx.doc !== ctx.doc || !here.ctx.alive()) return false;
		const base = here.page.elements?.length ?? 0;
		// The PDF file itself is not added to the notebook: only the pictures are. The file stays in the assets folder.
		const keep = assets.filter((a) => a.id !== pdfAsset.id);
		const commands: Command[] = [...keep.map((a) => new AddAsset(a)), ...elements.map((el, i) => new AddElement(here.page.id, el, base + i))];
		if (!here.ctx.execute(new Batch("Drop PDF as images", commands))) return false;
		host.select(here.index, elements);
		showNotice(t(elements.length === 1 ? "drop.done.one" : "drop.done.many", { n: String(elements.length) }));
		return true;
	} catch (e) {
		console.error("[notebook] drop PDF as images", e);
		showNotice(t("insert.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		return false;
	} finally {
		working?.hide();
		for (const a of assets) ctx.removePending(a.id);
	}
}
