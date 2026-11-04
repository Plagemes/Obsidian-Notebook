/**
 * 0.18 pdfannot (roadmap O10): "Annotate in Notebook" on a PDF of the vault, on the `doc=annotate` scenario. Checked: a PDF with no
 * notebook on it finds none; after a notebook with PDF background pages is added the search finds it (and only it), opens the
 * notebook page for the PDF page asked, and a notebook on another PDF is ignored; the choice dialog lists "Open existing (page N)"
 * and "New notebook" and is left on screen for the screenshot.
 */
import NotebookPlugin from "../../src/main";
import { ExistingModal, notebooksAnnotating } from "../../src/library/annotate-pdf";
import { buildPdfDocument } from "../../src/library/import-pdf";
import { parse, serialize } from "../../src/model/serialize";
import { assetIdFromHash, sha256Hex } from "../../src/pdf/hash";
import { t } from "../../src/i18n";
import { App, type Plugin as StubPlugin } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface AnnotateCheckApi {
	errors: string[];
	notices: string[];
}

const MANIFEST = { id: "notebook", name: "Notebook", version: "0.0.0-harness", dir: "plugins/notebook" };

export async function checkAnnotate(api: AnnotateCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();
	const plugin = new NotebookPlugin(app as never, MANIFEST as never) as NotebookPlugin & StubPlugin;
	await plugin.onload();
	const vault = app.vault;
	const bytes = new TextEncoder().encode("%PDF-1.4 harness book").buffer;
	const otherBytes = new TextEncoder().encode("%PDF-1.4 another book").buffer;
	const pdf = await vault.createBinary("Books/Book.pdf", bytes);
	const id = assetIdFromHash(await sha256Hex(bytes));
	const otherId = assetIdFromHash(await sha256Hex(otherBytes));
	const sizes = [{ width: 595, height: 842 }, { width: 595, height: 842 }, { width: 595, height: 842 }];
	const make = (assetId: string, name: string) => buildPdfDocument({ id: assetId, kind: "pdf", path: `_assets/${assetId}.pdf`, name, bytes: bytes.byteLength }, sizes);
	const host = {
		folder: () => plugin.settings.folder,
		readNotebook: async (file: { path: string }) => {
			const f = vault.getFileByPath(file.path);
			const parsed = f ? parse(await vault.read(f)) : null;
			return parsed && parsed.ok ? parsed.doc : null;
		},
		importPdfFrom: async () => false,
	};
	const folder = plugin.settings.folder;
	const prefix = folder && folder !== "/" ? `${folder}/` : "";
	const none = await notebooksAnnotating(app as never, host, id, 2);
	add("a PDF nobody annotates finds no notebook", none.length === 0);
	await vault.create(`${prefix}Book notes.notebook`, serialize(make(id, "Book.pdf")));
	await vault.create(`${prefix}Other.notebook`, serialize(make(otherId, "Other.pdf")));
	const found = await notebooksAnnotating(app as never, host, id, 2);
	add("only the notebook on this PDF is found", found.length === 1 && found[0]!.name === "Book notes", JSON.stringify(found));
	add("it opens the notebook page that shows the viewer page", found[0]?.openPage === 2 && found[0]?.pdfPages === 3);
	const unknown = await notebooksAnnotating(app as never, host, id, null);
	add("without a known viewer page it opens page 1", unknown[0]?.openPage === 1);
	void pdf;
	api.errors.splice(0, api.errors.length);

	new ExistingModal(app as never, found, () => undefined).open();
	await sleep(60);
	const modal = document.querySelector<HTMLElement>(".nb-annotate-pdf");
	add("the dialog offers 'Open existing (page 2)'", !!modal && (modal.textContent ?? "").includes(t("annotatePdf.open", { page: "2" })));
	add("…and 'New notebook'", !!modal && (modal.textContent ?? "").includes(t("annotatePdf.new")));
	const box = modal;
	add("the dialog fits the screen", !!box && box.getBoundingClientRect().left >= 0 && box.getBoundingClientRect().right <= window.innerWidth + 1);
	if (box && !box.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(box);
	await sleep(40);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
