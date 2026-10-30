import {
	EditorSuggest, type App, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile,
} from "obsidian";
import { t } from "../i18n";
import { parse } from "../model/serialize";
import type { Page } from "../model/types";
import { isNotebookFile, NOTEBOOK_EXTENSIONS, readNotebookText } from "../storage/format";
import { candidatePaths } from "./links";
import { pageSuggestions, parsePageLinkTrigger, stablePageSubpath, type PageSuggestion } from "./page-links";

/**
 * Suggests the pages of a notebook while typing `[[Physics.notebook#`: the page number and the
 * first text box of the page. Choosing one writes `p3&id=<page id>` (wave 0.8: the id keeps the link on the page).
 */
export class PageLinkSuggest extends EditorSuggest<PageSuggestion> {
	private target: TFile | null = null;
	/** Pages per notebook and modification time, so typing does not parse the notebook on every key. */
	private readonly cache = new Map<string, { mtime: number; pages: Page[] }>();

	constructor(app: App) {
		super(app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		const trigger = parsePageLinkTrigger(editor.getLine(cursor.line).slice(0, cursor.ch));
		if (!trigger) return null;
		const notebook = this.notebookFor(trigger.linkpath, file?.path ?? "");
		if (!notebook) return null;
		this.target = notebook;
		return { start: { line: cursor.line, ch: trigger.queryStart }, end: cursor, query: trigger.query };
	}

	/**
	 * The notebook a typed link path means. `[[Physics#` is claimed only when no other kind of file
	 * (a note with headings) is what that link resolves to.
	 */
	private notebookFor(linkpath: string, sourcePath: string): TFile | null {
		const { metadataCache } = this.app;
		const direct = metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		if (direct) return isNotebookFile(direct) ? direct : null;
		for (const candidate of candidatePaths(linkpath, NOTEBOOK_EXTENSIONS).slice(1)) {
			const file = metadataCache.getFirstLinkpathDest(candidate, sourcePath);
			if (file && isNotebookFile(file)) return file;
		}
		return null;
	}

	async getSuggestions(context: EditorSuggestContext): Promise<PageSuggestion[]> {
		const file = this.target;
		if (!file) return [];
		try {
			let entry = this.cache.get(file.path);
			if (!entry || entry.mtime !== file.stat.mtime) {
				const result = parse(readNotebookText(file.extension, await this.app.vault.cachedRead(file)));
				entry = { mtime: file.stat.mtime, pages: result.ok ? result.doc.pages : [] };
				this.cache.set(file.path, entry);
			}
			return pageSuggestions(entry.pages, context.query);
		} catch (e) {
			console.error("[notebook] page suggestions", e);
			return [];
		}
	}

	renderSuggestion(suggestion: PageSuggestion, el: HTMLElement): void {
		el.addClass("notebook-page-suggestion");
		el.createSpan({ text: `p${suggestion.page}`, cls: "notebook-page-suggestion-number" });
		const label = suggestion.title ?? t(suggestion.hasInk ? "suggest.handwriting" : "suggest.emptyPage");
		el.createSpan({ text: label, cls: suggestion.title ? "notebook-page-suggestion-title" : "notebook-page-suggestion-title is-muted" });
	}

	selectSuggestion(suggestion: PageSuggestion): void {
		const context = this.context;
		if (!context) return;
		const { editor, start, end } = context;
		const text = stablePageSubpath(suggestion.page, suggestion.pageId).slice(1);
		editor.replaceRange(text, start, end);
		// Obsidian closes `[[` automatically: leave the cursor after the `]]` that is already there.
		const after = editor.getLine(start.line).slice(start.ch + text.length, start.ch + text.length + 2);
		editor.setCursor({ line: start.line, ch: start.ch + text.length + (after === "]]" ? 2 : 0) });
		this.close();
	}
}
