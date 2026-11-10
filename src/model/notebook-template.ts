/**
 * Notebook templates (roadmap #19). Pure, no Obsidian.
 *
 * A notebook template is an ordinary notebook document stored in the notebook templates folder (no format change). Saving
 * one copies the notebook with fresh ids; using one makes a new notebook, again with fresh ids, either with the pages only
 * (paper, size, background, margins: the ink and elements are left out) or with the content too. Assets the kept pages use
 * and the slide links their ink carries come along, and so do the coloured sections (v28, re-anchored to the copies of their pages: they
 * are the structure of the notebook); nothing else of the source (bookmarks, tags, position) does.
 * `{{date}}` and friends in text boxes, the title and the description are filled in when a notebook is made from a template.
 */
import { elementAssetId } from "./excerpts";
import { cloneMeta, createId, createPage } from "./document";
import { clearChecklist } from "./checklist";
import { duplicatePages } from "./pages";
import { freezeElement } from "./serialize";
import { sectionsForCopy, sectionsOf } from "./sections";
import { CURRENT_VERSION, DEFAULT_META, FORMAT_ID, type Asset, type NotebookDocument, type Page, type SlideRef } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Fills the placeholders `{{date}}` (2026-11-04), `{{time}}` (14:30), `{{year}}`, `{{month}}` (11) and `{{day}}` (04) with the
 * local time `now`. Spaces inside the braces and the case are ignored; anything else in braces is left as it is.
 */
export function expandPlaceholders(text: string, now: Date = new Date()): string {
	if (!text.includes("{{")) return text;
	const values: Record<string, string> = {
		date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
		time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
		year: String(now.getFullYear()),
		month: pad(now.getMonth() + 1),
		day: pad(now.getDate()),
	};
	return text.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (whole, key: string) => values[key.toLowerCase()] ?? whole);
}

/** Asset records the pages use (backgrounds, images, excerpt snapshots), copied. */
function assetsOfPages(pages: readonly Page[], doc: NotebookDocument): Record<string, Asset> {
	const out: Record<string, Asset> = {};
	const add = (id: string | null) => {
		const a = id === null ? undefined : doc.assets?.[id];
		if (a && !Object.prototype.hasOwnProperty.call(out, a.id)) out[a.id] = { ...a };
	};
	for (const p of pages) {
		if (p.background) add(p.background.asset);
		for (const el of p.elements ?? []) add(elementAssetId(el));
	}
	return out;
}

/** The slide table entries the strokes of `pages` refer to, copied (the strokes keep their ids). */
function slidesOfPages(pages: readonly Page[], doc: NotebookDocument): SlideRef[] {
	const used = new Set<string>();
	for (const p of pages) for (const s of p.strokes) if (s.slide !== undefined) used.add(s.slide);
	return (doc.slides ?? []).filter((r) => used.has(r.id)).map((r) => ({ ...r }));
}

function documentOf(source: NotebookDocument, pages: Page[], now: Date): NotebookDocument {
	const iso = now.toISOString();
	const doc: NotebookDocument = {
		format: FORMAT_ID, version: CURRENT_VERSION, id: createId(), createdAt: iso, modifiedAt: iso,
		pages, meta: cloneMeta(DEFAULT_META), assets: assetsOfPages(pages, source),
	};
	const slides = slidesOfPages(pages, source);
	if (slides.length > 0) doc.slides = slides;
	return doc;
}

/**
 * The copy of a notebook that goes to the templates folder: new document id, new page, stroke and element ids, the assets
 * and slide links its pages use, and the cover (colour, description, art) so a template card looks like the notebook.
 * Bookmarks, tags, favourite and reading position are not copied (they belong to the original).
 */
export function templateFromNotebook(source: NotebookDocument, now: Date = new Date()): NotebookDocument {
	// v17: checkboxes are unticked and linked to no task in a template (a form to fill in again).
	const pages = duplicatePages(source.pages).map((p) => clearChecklist(p)); // 0.29 (#248) review fix (F2)
	const doc = documentOf(source, pages, now);
	copySections(source, pages, doc);
	// Tags and comments belong to the notebook that was written in, not to a template made from it.
	for (const p of pages) {
		delete p.tags;
		delete p.comments;
	}
	const meta = source.meta;
	if (meta) {
		doc.meta!.cover = meta.cover;
		if (meta.description !== undefined) doc.meta!.description = meta.description;
		if (meta.coverArt && meta.coverArt.kind === "art") doc.meta!.coverArt = { ...meta.coverArt };
	}
	if (doc.pages.length === 0) doc.pages = [createPage()];
	return doc;
}

export interface FromTemplateOptions {
	/** Keep the ink and elements of the template's pages (default true); false: empty pages with the same paper and size. */
	content?: boolean;
	now?: Date;
}

/**
 * A new notebook document made from a template: new document id, new ids everywhere, `{{date}}`-style placeholders of text
 * boxes filled in. With `content: false` only the pages stay (paper, size, background, margins, infinite flag); the
 * assets and slide links of what is kept come along. The result has default metadata: the caller sets the cover.
 */
export function notebookFromTemplate(template: NotebookDocument, options: FromTemplateOptions = {}): NotebookDocument {
	const now = options.now ?? new Date();
	const content = options.content !== false;
	const copies = duplicatePages(template.pages); // 0.29 (#248) review fix (F2): captions follow the copies of their pictures
	const pages = template.pages.map((_src, i) => {
		const page = clearChecklist(copies[i]!);
		delete page.tags;
		delete page.comments; // v16: review comments are not template content
		if (!content) {
			page.strokes = [];
			delete page.elements;
			delete page.states; // v13: the parts name strokes, and there are none left
			return page;
		}
		if (page.elements) {
			page.elements = page.elements.map((el) => (el.type === "text" && el.text.includes("{{") ? freezeElement({ ...el, text: expandPlaceholders(el.text, now) }) : el));
		}
		return page;
	});
	if (pages.length === 0) return documentOf(template, [createPage()], now);
	const doc = documentOf(template, pages, now);
	copySections(template, pages, doc);
	return doc;
}

/** v28: the sections of `source`, re-anchored to the copies of their pages (`copies[i]` is the copy of `source.pages[i]`), with new ids. */
function copySections(source: NotebookDocument, copies: readonly Page[], doc: NotebookDocument): void {
	const map = new Map<string, string>();
	source.pages.forEach((p, i) => {
		const copy = copies[i];
		if (copy) map.set(p.id, copy.id);
	});
	const sections = sectionsForCopy(sectionsOf(source), map);
	if (sections.length > 0) doc.sections = sections;
}
