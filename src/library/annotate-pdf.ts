// "Annotate in Notebook" for a PDF shown in Obsidian's own viewer (roadmap O10): the file explorer / pane menu entry, a header
// action on the PDF view and a command all end here. If a notebook already annotates this PDF the user chooses between
// opening it and making a new one; otherwise the single-PDF import makes the notebook. The source PDF is only ever read.
import { ItemView, Modal, TFile, type App, type Plugin, type View } from "obsidian";
import { t } from "../i18n";
import { openNotebookAtPage } from "../integration/open";
import { assetIdFromHash, sha256Hex } from "../pdf/hash";
import { listNotebooks } from "../storage/notebooks";
import { modalShell, shellButton, shellNote, shellRow } from "../ui/components/modal-shell";
import type { NotebookDocument } from "../model/types";
import { NotebookView } from "../view/notebook-view";
import { showNotice } from "../view/notice";
import {
	ANNOTATE_PDF_MAX_BYTES, AnnotateCache, fileKey, findAnnotators, notebooksNaming, SCAN_PROGRESS_FROM, summarizeForAnnotate, viewerPageNumber, type Annotator,
} from "./annotate-pdf-logic";

export interface AnnotatePdfHost {
	/** The notebooks folder (settings). */
	folder(): string;
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	/** The existing single-PDF import: stores the asset, builds the notebook, opens it; true when one was made. `bytes`: the file as already read. */
	importPdfFrom(folder: string, file: TFile, bytes?: ArrayBuffer): Promise<boolean>;
}

/** What this session has learned: the id of each PDF looked at and the asset ids each notebook names (re-read only when the file changed). */
const cache = new AnnotateCache();

/** A small window with the progress of a long search and a way to stop it; only shown for a large library. */
class ScanModal extends Modal {
	cancelled = false;
	private line: HTMLElement | null = null;

	onOpen(): void {
		const shell = modalShell(this, { title: t("annotatePdf.title"), icon: "pen-line", size: "narrow", cls: "nb-annotate-pdf" });
		this.line = shell.body.createDiv({ cls: "nb-annotate-progress" });
		shellButton(shell.foot, "secondary", t("library.modal.cancel"), () => {
			this.cancelled = true;
			this.close();
		});
	}

	update(done: number, total: number): void {
		this.line?.setText(t("annotatePdf.scanning", { done: String(done), total: String(total) }));
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
	}
}

/**
 * Notebooks that already annotate the PDF with this asset id. Only notebooks that are new or changed since the last search are
 * read (their asset ids are remembered); a file is parsed only when it names the id. Null when the user stopped a long search.
 */
export async function notebooksAnnotating(app: App, host: AnnotatePdfHost, assetId: string, pdfPage: number | null): Promise<Annotator[] | null> {
	let modal: ScanModal | null = null;
	try {
		const scan = await notebooksNaming(listNotebooks(app, host.folder()), assetId, {
			path: (f) => f.path,
			key: (f) => fileKey(f.stat),
			read: (f) => app.vault.cachedRead(f),
			cache,
			progress: (done, total) => {
				if (total >= SCAN_PROGRESS_FROM && done < total) {
					if (!modal) {
						modal = new ScanModal(app);
						modal.open();
					}
					modal.update(done, total);
				}
			},
			cancelled: () => modal?.cancelled === true,
			yieldNow: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
			failed: (f, e) => console.error("[notebook] annotate PDF: could not read", f.path, e),
		});
		if (scan.cancelled) return null;
		const candidates = [];
		for (const file of scan.matches) {
			try {
				const doc = await host.readNotebook(file);
				if (doc) candidates.push(summarizeForAnnotate(file.path, file.basename, doc));
			} catch (e) {
				console.error("[notebook] annotate PDF: could not read", file.path, e);
			}
		}
		return findAnnotators(candidates, assetId, pdfPage);
	} finally {
		(modal as ScanModal | null)?.close();
	}
}

/** The page the PDF viewer of `pdf` shows now (null: unknown). Best effort: reads the viewer's internals defensively. */
export function currentPdfPage(app: App, pdf: TFile): number | null {
	for (const leaf of app.workspace.getLeavesOfType("pdf")) {
		const view: View = leaf.view;
		if ((view as { file?: TFile | null }).file?.path === pdf.path) return viewerPageNumber(view);
	}
	return null;
}

export class ExistingModal extends Modal {
	constructor(app: App, private readonly found: readonly Annotator[], private readonly pick: (choice: Annotator | "new") => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("annotatePdf.title"), subtitle: t("annotatePdf.subtitle"), icon: "pen-line", size: "narrow", cls: "nb-annotate-pdf" });
		for (const a of this.found) {
			shellRow(shell.body, {
				label: t("annotatePdf.open", { page: String(a.openPage) }),
				detail: a.name,
				onClick: () => this.choose(a),
			});
		}
		shellNote(shell.body, t("annotatePdf.note"));
		shellButton(shell.foot, "secondary", t("library.modal.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("annotatePdf.new"), () => this.choose("new"), { icon: "file-plus" });
	}

	private choose(choice: Annotator | "new"): void {
		this.close();
		this.pick(choice);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The whole flow for one PDF of the vault. Never throws. */
export async function annotatePdfFlow(app: App, host: AnnotatePdfHost, pdf: TFile): Promise<void> {
	try {
		const mb = (n: number) => String(Math.round(n / (1024 * 1024)));
		if (pdf.stat.size > ANNOTATE_PDF_MAX_BYTES) {
			showNotice(t("annotatePdf.tooLarge", { size: mb(pdf.stat.size), max: mb(ANNOTATE_PDF_MAX_BYTES) }), 10000);
			return;
		}
		const page = currentPdfPage(app, pdf);
		// The same file (path, time, size) is hashed once per session; when it has to be read, the bytes are reused for a new notebook.
		const key = fileKey(pdf.stat);
		let bytes: ArrayBuffer | null = null;
		let assetId = cache.pdfId(pdf.path, key);
		if (assetId === null) {
			bytes = await app.vault.readBinary(pdf);
			if (bytes.byteLength > ANNOTATE_PDF_MAX_BYTES) {
				showNotice(t("annotatePdf.tooLarge", { size: mb(bytes.byteLength), max: mb(ANNOTATE_PDF_MAX_BYTES) }), 10000);
				return;
			}
			assetId = assetIdFromHash(await sha256Hex(bytes));
			cache.setPdfId(pdf.path, key, assetId);
		}
		const found = await notebooksAnnotating(app, host, assetId, page);
		if (found === null) return; // stopped by the user
		const create = async (reuse: ArrayBuffer | null) => {
			if (!(await host.importPdfFrom(host.folder(), pdf, reuse ?? undefined))) return;
			const made = app.workspace.getActiveViewOfType(NotebookView)?.file;
			if (made && page !== null && page > 1) await openNotebookAtPage(app, made, page);
		};
		if (found.length === 0) {
			await create(bytes);
			return;
		}
		bytes = null; // a window stays open: if "New" is chosen the file is read again, instead of holding it in memory meanwhile
		new ExistingModal(app, found, (choice) => {
			if (choice === "new") void create(null);
			else {
				const file = app.vault.getFileByPath(choice.path);
				if (file) void openNotebookAtPage(app, file, choice.openPage);
			}
		}).open();
	} catch (e) {
		console.error("[notebook] annotate PDF", e);
		showNotice(t("import.failed", { error: e instanceof Error ? e.message : String(e) }));
	}
}

const WIRED = new WeakSet<object>();

/** Adds the command and the header action of PDF views. The explorer / pane menu entry is in integration/file-menu.ts. */
export function registerAnnotatePdf(plugin: Plugin, host: AnnotatePdfHost): void {
	const { app } = plugin;
	const run = (pdf: TFile) => void annotatePdfFlow(app, host, pdf);
	const activePdf = (): TFile | null => {
		const leaf = app.workspace.getMostRecentLeaf();
		const file = leaf && leaf.view.getViewType() === "pdf" ? (leaf.view as { file?: TFile | null }).file : null;
		return file instanceof TFile && file.extension.toLowerCase() === "pdf" ? file : null;
	};
	plugin.addCommand({
		id: "annotate-current-pdf",
		name: t("command.annotatePdf"),
		checkCallback: (checking) => {
			const pdf = activePdf();
			if (!pdf) return false;
			if (!checking) run(pdf);
			return true;
		},
	});
	// A header action on every PDF view, added once per view. View.addAction is public API.
	const wire = () => {
		for (const leaf of app.workspace.getLeavesOfType("pdf")) {
			const view = leaf.view;
			if (WIRED.has(view) || !(view instanceof ItemView)) continue;
			WIRED.add(view);
			const button = view.addAction("pen-line", t("menu.annotatePdf"), () => {
				const file = (view as { file?: TFile | null }).file;
				if (file) run(file);
			});
			// The view outlives the plugin on a reload: the button goes with it, or a new one would sit next to this dead one.
			plugin.register(() => {
				button.remove();
				WIRED.delete(view);
			});
		}
	};
	plugin.registerEvent(app.workspace.on("layout-change", wire));
	plugin.registerEvent(app.workspace.on("active-leaf-change", wire));
	app.workspace.onLayoutReady(wire);
}
