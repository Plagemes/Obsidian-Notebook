// wave 0.9 (382): "Export as Markdown with page images". Draws every page to a PNG at the chosen resolution and writes
// the PNGs and notebook.md into a vault folder through the vault API. Nothing is ever overwritten: a name that exists gets
// " 2", " 3"… The notebook.md is written last, so it only exists when every image does. The format of the notebook is not
// touched. The page drawing is shared with the PNG export and printing (view/page-images.ts).
import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { t } from "../i18n";
import type { PdfCommentLabels } from "../ink/export-pdf";
import type { FigureLabelSource } from "../ink/figure-text";
import type { BoxLabel } from "../ink/marker-render";
import { metaWithoutRedactedTitles } from "../ink/redact";
import { buildNotebookMarkdown, planMarkdownFiles, type MarkdownDpi } from "../model/export-markdown";
import type { Redactions } from "../model/redact";
import type { NotebookDocument, Page } from "../model/types";
import { ensureFolder } from "../storage/vault-io";
import { recordPluginWrite } from "../storage/plugin-written";
import { announceRedaction, redactionRefused, withRedaction } from "./export-redact";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer } from "./page-images";

export interface MarkdownExportOptions {
	/** Vault folder the files go in (created when missing). */
	folder: string;
	dpi: MarkdownDpi;
	hiddenInk?: (page: Page) => boolean;
	boxLabel?: BoxLabel;
	/** v9: typesets the equations that have no cached outline yet (they are drawn in the page images). */
	prepare?: (pages: readonly Page[]) => Promise<void>;
	/** v9: numbers of the numbered equations over the whole notebook. */
	equationNumbers?: ReadonlyMap<string, number>;
	/** v16: when given (the setting *Include comments in exports* is on), the margin comments are listed below each page's text. */
	comments?: PdfCommentLabels;
	/** 0.26 (#285): redaction boxes by page id: the pages are drawn without what they cover, and so is the text written below them. */
	redact?: Redactions;
	/** Review fix (P4): the boxes could not be read: nothing is written. */
	redactBlocked?: true;
	/** 0.28 (#76): the boxes are stale (a page was turned or cropped after they were drawn): see `ExportOptions.redactStale`. */
	redactStale?: true;
	/** Review fix (P10): boxes kept switched off (a quiet hint says so). */
	redactOff?: number;
	/** 0.29 (#96): leave the struck-out words (and their lines) out of the page pictures: see `ExportOptions.struck`. */
	struck?: true;
	/** 0.29 (#248) review fix (F1): the figure numbers of the notebook, frozen when the export started (the page images and the redaction use them). */
	figures?: FigureLabelSource;
}

/** The folder suggested for the export of `notebook`: next to it, named after it. */
export function defaultMarkdownFolder(notebook: TFile): string {
	return siblingFolder(notebook, "Markdown");
}

/** A folder next to `notebook` named after it, e.g. `Maths (Markdown)` or `Maths (PNG)`. */
export function siblingFolder(notebook: TFile, kind: string): string {
	const dir = notebook.parent && notebook.parent.path !== "/" ? `${notebook.parent.path}/` : "";
	return normalizePath(`${dir}${notebook.basename} (${kind})`);
}

/** Why a folder path cannot be used, or null. */
export function folderProblem(app: App, folder: string): string | null {
	const path = normalizePath(folder.trim());
	if (path === "" || path === "/") return null;
	if (path.split("/").some((part) => part === "." || part === "..")) return t("export.markdown.badFolder");
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) return t("export.markdown.folderIsFile");
	return null;
}

/** Creates the export folder when missing and says whether a file name is taken in it (case-insensitively). */
export async function prepareExportFolder(app: App, folder: string): Promise<{ dir: string; prefix: string; exists: (path: string) => boolean }> {
	const clean = normalizePath(folder.trim() || ".");
	const dir = clean === "." || clean === "/" ? "" : clean;
	if (dir) await ensureFolder(app, dir);
	const target = dir ? app.vault.getAbstractFileByPath(dir) : app.vault.getRoot();
	const present = new Set<string>();
	if (target instanceof TFolder) for (const child of target.children) present.add(child.name.toLowerCase());
	return {
		dir,
		prefix: dir ? `${dir}/` : "",
		exists: (path) => present.has(path.slice(dir ? dir.length + 1 : 0).toLowerCase()) || !!app.vault.getAbstractFileByPath(normalizePath(path)),
	};
}

/**
 * Writes the export and reports the result with a notice. Returns the path of notebook.md, or null when it failed.
 * Pages are rendered one after the other, so memory stays at one page.
 */
export async function exportMarkdown(app: App, notebook: TFile, source: NotebookDocument, media: NotebookMedia | null, options: MarkdownExportOptions): Promise<string | null> {
	if (redactionRefused(options)) return null;
	const working = showNotice(t("export.working"), 0);
	// 0.26 (#285): the text boxes, equations, notes and comments under a box are not written, nor are the bookmark titles of a covered page
	// (nor, review fix P2, an excerpt of a covered region).
	const covered = withRedaction(source.pages, { ...(options.redact ? { redact: options.redact } : {}), ...(options.struck ? { struck: true as const } : {}), ...(options.figures ? { figures: options.figures } : {}) }).pages;
	const doc: NotebookDocument = covered === source.pages ? source : { ...source, pages: [...covered], meta: metaWithoutRedactedTitles(source.meta, covered) ?? source.meta };
	let written = 0;
	const renderer = new PageImageRenderer(media, {
		...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}),
		...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
		...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
		...(options.figures ? { figures: options.figures } : {}),
	});
	try {
		const { dir, prefix, exists } = await prepareExportFolder(app, options.folder);
		const names = planMarkdownFiles(dir, doc.pages.length, exists);
		recordPluginWrite(app, [...names.images.map((n) => normalizePath(`${prefix}${n}`)), normalizePath(`${prefix}${names.markdown}`)]);
		let skipped = 0;
		await options.prepare?.(doc.pages);
		for (let i = 0; i < doc.pages.length; i++) {
			const page = doc.pages[i]!;
			working.setMessage(t("export.progress", { done: String(i), total: String(doc.pages.length) }));
			const image = await renderer.render(page, options.dpi);
			skipped += image.skipped;
			await app.vault.createBinary(normalizePath(`${prefix}${names.images[i]!}`), await image.blob.arrayBuffer());
			written++;
		}
		const text = buildNotebookMarkdown({
			title: notebook.basename, pages: doc.pages, meta: doc.meta, images: names.images, ...(options.figures ? { figures: options.figures } : {}),
			pageLabel: (n) => t("export.markdown.pageHeading", { n: String(n) }),
			// 0.18 review (J6): comments, with the names of the devices that wrote them, leave the vault only when the setting asks for them.
			...(options.comments ? { comments: { heading: t("comments.markdown.heading"), resolved: options.comments.resolved, sketch: options.comments.sketch, when: options.comments.when } } : {}),
		});
		const path = normalizePath(`${prefix}${names.markdown}`);
		await app.vault.create(path, text);
		showNotice(t("export.markdown.done", { n: String(written), path }), 8000);
		announceRedaction(source.pages, options);
		if (skipped > 0) showNotice(t("export.skipped", { n: String(skipped) }), 8000);
		return path;
	} catch (e) {
		showNotice(t("export.markdown.failed", { done: String(written), error: (e as Error).message }), 10000);
		return null;
	} finally {
		renderer.close();
		working.hide();
	}
}
