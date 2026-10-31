// 0.13: recent notes grouped by notebook (DESIGN.md §3): a notebook header (subject pill, kebab) and the pages edited in it,
// each with its own page thumbnail on the left.
import { iconButton, pressable, setIconSafe } from "./dom";
import { pills, type Pill } from "./list-row";
import type { PageThumbRef } from "./continue-card";

export interface RecentPageOptions {
	/** "Page 4" or the bookmark's title. */
	title: string;
	/** "Today, 10:24" */
	meta: string;
	thumb: PageThumbRef;
	key?: string;
	menuLabel: string;
	onOpen: () => void;
	onMenu: (anchor: HTMLElement) => void;
}

export interface RecentGroupOptions {
	/** The notebook. */
	title: string;
	subject: Pill | null;
	/** "3 pages edited" */
	summary: string;
	pages: RecentPageOptions[];
	key?: string;
	menuLabel: string;
	onOpen: () => void;
	onMenu: (anchor: HTMLElement) => void;
}

/** One page of a group: thumbnail, title, time, kebab. */
function pageRow(parent: HTMLElement, o: RecentPageOptions): HTMLElement {
	const row = parent.createDiv({ cls: "nb-recent-page" });
	if (o.key) row.dataset.key = o.key;
	pressable(row, o.onOpen, `${o.title}, ${o.meta}`);
	const thumb = row.createDiv({ cls: "nb-page-thumb nb-recent-thumb", attr: { "aria-hidden": "true" } });
	thumb.dataset.pageThumbPath = o.thumb.path;
	if (o.thumb.pageId) thumb.dataset.pageThumbId = o.thumb.pageId;
	thumb.dataset.pageThumbWidth = "200";
	setIconSafe(thumb.createDiv({ cls: "notebook-lib-page-empty" }), "file-text");
	const text = row.createDiv({ cls: "nb-row-text" });
	text.createDiv({ cls: "nb-row-title", text: o.title, attr: { title: o.title } });
	text.createDiv({ cls: "nb-row-meta", text: o.meta });
	iconButton(row, "more-vertical", o.menuLabel, (b) => o.onMenu(b), "nb-kebab");
	return row;
}

/** A group: the notebook's header row, then its pages. */
export function recentGroup(parent: HTMLElement, o: RecentGroupOptions): HTMLElement {
	const group = parent.createDiv({ cls: "nb-recent-group" });
	if (o.key) group.dataset.key = o.key;
	const head = group.createDiv({ cls: "nb-recent-head" });
	pressable(head, o.onOpen, `${o.title}, ${o.summary}`);
	setIconSafe(head.createSpan({ cls: "nb-row-icon", attr: { "aria-hidden": "true" } }), "book-open");
	const text = head.createDiv({ cls: "nb-row-text" });
	text.createDiv({ cls: "nb-row-title", text: o.title, attr: { title: o.title } });
	text.createDiv({ cls: "nb-row-meta", text: o.summary });
	if (o.subject) pills(head, [o.subject]);
	iconButton(head, "more-vertical", o.menuLabel, (b) => o.onMenu(b), "nb-kebab");
	const pagesEl = group.createDiv({ cls: "nb-recent-pages" });
	for (const p of o.pages) pageRow(pagesEl, p);
	return group;
}
