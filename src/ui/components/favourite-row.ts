import { iconButton, pressable, setIconSafe, subjectVars } from "./dom";

export interface FavouriteRowOptions {
	/** Notebook path: the thumbnail element carries it (`data-thumb-path`) so the view can fill it from the cache. */
	path: string;
	title: string;
	subject: { label: string; color: string } | null;
	count: string;
	updated: string;
	starred: boolean;
	starLabel: string;
	menuLabel: string;
	key?: string;
	onOpen: () => void;
	onStar: () => void;
	onMenu: (anchor: HTMLElement) => void;
}

/** Favourite row (DESIGN.md §3): page thumbnail, title, subject · count, updated, amber star, kebab. */
export function favouriteRow(parent: HTMLElement, o: FavouriteRowOptions): HTMLElement {
	const row = parent.createDiv({ cls: "nb-fav-row" });
	if (o.key) row.dataset.key = o.key;
	pressable(row, o.onOpen, `${o.title}, ${o.updated}`);
	const thumb = row.createDiv({ cls: "nb-fav-thumb notebook-lib-page", attr: { "data-thumb-path": o.path, "aria-hidden": "true" } });
	setIconSafe(thumb.createDiv({ cls: "notebook-lib-page-empty" }), "file-text");
	const text = row.createDiv({ cls: "nb-row-text" });
	text.createDiv({ cls: "nb-row-title", text: o.title, attr: { title: o.title } });
	const line = text.createDiv({ cls: "nb-fav-line" });
	if (o.subject) {
		const s = line.createSpan({ cls: "nb-fav-subject", text: o.subject.label });
		subjectVars(s, o.subject.color);
		line.createSpan({ cls: "nb-fav-sep", text: "•", attr: { "aria-hidden": "true" } });
	}
	line.createSpan({ text: o.count });
	text.createDiv({ cls: "nb-row-meta", text: o.updated });
	const star = iconButton(row, "star", o.starLabel, () => o.onStar(), "nb-star");
	star.setAttribute("aria-pressed", String(o.starred));
	star.toggleClass("is-on", o.starred);
	iconButton(row, "more-vertical", o.menuLabel, (b) => o.onMenu(b), "nb-kebab");
	return row;
}
