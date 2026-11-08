import type { Page } from "../model/types";

/**
 * 0.24 (#411): how the page tag editor gets its suggested tags. The plugin registers the provider (it owns the setting and
 * the timetable); without one, or with the setting off, there are no suggestions.
 */
export interface PageTagSuggestInput {
	/** Vault path of the open notebook. */
	path: string | null;
	page: Page;
	/** Tags of the notebook (they count as a sibling vote). */
	notebookTags: readonly string[];
	/** Tags the page already has (or has in the field right now). */
	existing: readonly string[];
}

export type PageTagSuggestProvider = (input: PageTagSuggestInput) => string[];

let provider: PageTagSuggestProvider | null = null;

export function setPageTagSuggestProvider(next: PageTagSuggestProvider | null): void {
	provider = next;
}

export function pageTagSuggestions(input: PageTagSuggestInput): string[] {
	try {
		return provider?.(input) ?? [];
	} catch (e) {
		console.error("[notebook] tag suggestions", e);
		return [];
	}
}
