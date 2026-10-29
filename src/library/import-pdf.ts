import { createDocument } from "../model/document";
import { createPdfPages } from "../model/pages";
import { serializeChecked } from "../model/serialize";
import { PAPER_SPACING, type Asset, type NotebookDocument } from "../model/types";

/** PDFs at least this big get a progress notice while their pages are measured. */
export const LARGE_PDF_BYTES = 1024 * 1024;

export interface PageSizePt {
	width: number;
	height: number;
}

/** Notebook name for a PDF file name: the name without its ".pdf" extension. */
export function pdfNotebookName(fileName: string): string {
	const base = fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
	return base.replace(/\.pdf$/i, "").trim();
}

/** A notebook with one blank page per PDF page, each page the size of its PDF page. */
export function buildPdfDocument(asset: Asset, sizes: readonly PageSizePt[], now: Date = new Date()): NotebookDocument {
	if (sizes.length === 0) throw new Error("the PDF has no pages");
	const doc = createDocument(now, sizes[0], { kind: "blank", spacing: PAPER_SPACING.blank });
	doc.pages = createPdfPages(asset, sizes);
	doc.assets = { [asset.id]: asset };
	return doc;
}

/** Everything the import needs from the host, injected so the flow is testable without Obsidian. */
export interface ImportDeps<F> {
	pick(): Promise<{ name: string; bytes: ArrayBuffer } | null>;
	store(bytes: ArrayBuffer, name: string): Promise<Asset>;
	pageSizes(assetId: string): Promise<PageSizePt[]>;
	create(folder: string, name: string, doc: NotebookDocument): Promise<F>;
	open(file: F): Promise<void>;
	/** Shows a message that stays until the returned function is called. */
	progress(text: string): () => void;
	notify(text: string): void;
	messages: {
		working(name: string): string;
		failed(error: string): string;
		empty(): string;
	};
}

/** Imports a PDF as a new notebook in `folder`. Never throws: problems are reported with `notify`. */
export async function importPdfAsNotebook<F>(deps: ImportDeps<F>, folder: string): Promise<boolean> {
	let done: (() => void) | null = null;
	try {
		const picked = await deps.pick();
		if (!picked) return false;
		const name = pdfNotebookName(picked.name) || "PDF";
		if (picked.bytes.byteLength >= LARGE_PDF_BYTES) done = deps.progress(deps.messages.working(name));
		const asset = await deps.store(picked.bytes, picked.name);
		const sizes = await deps.pageSizes(asset.id);
		if (sizes.length === 0) {
			deps.notify(deps.messages.empty());
			return false;
		}
		const doc = buildPdfDocument(asset, sizes);
		const checked = serializeChecked(doc);
		if (!checked.ok) throw new Error(checked.message);
		const file = await deps.create(folder, name, doc);
		await deps.open(file);
		return true;
	} catch (e) {
		console.error("[notebook] PDF import", e);
		deps.notify(deps.messages.failed(e instanceof Error ? e.message : String(e)));
		return false;
	} finally {
		done?.();
	}
}
