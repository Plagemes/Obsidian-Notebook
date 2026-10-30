/** The status bar item's content (roadmap O15). Pure: no 'obsidian', no strings table. */

/** What the status bar item shows (roadmap O15): the page in view and the save state of the active notebook. */
export interface StatusBarInfo {
	/** Page in view, 1-based. */
	page: number;
	total: number;
	/** The save state as the toolbar words it ("Saved", "Saving…", "Unsaved changes", "Save failed", "Read-only"). */
	save: string;
	kind: "ok" | "pending" | "error";
}

/** The item's text from the page label ("p. 3/12") and the save state: "p. 3/12 · Saved". */
export function statusBarText(pageLabel: string, save: string): string {
	return save ? `${pageLabel} · ${save}` : pageLabel;
}

