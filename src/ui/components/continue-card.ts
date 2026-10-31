// 0.13: the "Continue" row of Home (DESIGN.md §3): the hero card with a large page thumbnail (the lecture in progress, else
// the notebook you left off in) and the "Quick page" card beside it.
import { applyArt, type ArtSource } from "../art/art-ref";
import { pressable, setIconSafe, subjectVars } from "./dom";
import { iconSquare } from "./icon-square";

/** A page picture that the view fills in (ui/components never render pages): the box carries what to draw. */
export interface PageThumbRef {
	/** Notebook path. */
	path: string;
	/** The page to draw; absent: the first page. */
	pageId?: string;
}

export interface ContinueCardOptions {
	/** Small caps line above the title: "In class now · Room 3", "Continue where you left off". */
	eyebrow: string;
	/** An icon next to the eyebrow. */
	eyebrowIcon: string;
	/** The notebook (or the course, when its notebook is still to be made). */
	title: string;
	/** Meta lines under the title ("Anatomy · 6 pages", "Edited today, 10:24"). */
	lines: readonly string[];
	/** Subject colour of the card. */
	color: string;
	/** The page picture; absent (no notebook yet): a paper placeholder with the icon. */
	thumb: PageThumbRef | null;
	/** Decoration: a generated artwork behind the text (omit with reduced effects). */
	art?: ArtSource;
	/** The one action, also what a tap anywhere on the card does. */
	action: { icon: string; label: string; onRun: () => void };
	key?: string;
}

/** The hero card: large page thumbnail on the left, text and the accent action on the right. */
export function continueCard(parent: HTMLElement, o: ContinueCardOptions): HTMLElement {
	const card = parent.createDiv({ cls: "nb-continue" });
	subjectVars(card, o.color);
	if (o.key) card.dataset.key = o.key;
	pressable(card, o.action.onRun, `${o.title}. ${o.action.label}`);
	if (o.art) applyArt(card.createDiv({ cls: "nb-continue-art", attr: { "aria-hidden": "true" } }), o.art);
	const thumb = card.createDiv({ cls: "nb-continue-thumb", attr: { "aria-hidden": "true" } });
	if (o.thumb) {
		thumb.addClass("nb-page-thumb");
		thumb.dataset.pageThumbPath = o.thumb.path;
		if (o.thumb.pageId) thumb.dataset.pageThumbId = o.thumb.pageId;
		thumb.dataset.pageThumbWidth = "520";
		setIconSafe(thumb.createDiv({ cls: "notebook-lib-page-empty" }), "file-text");
	} else {
		thumb.addClass("is-blank");
		setIconSafe(thumb.createDiv({ cls: "nb-continue-plus" }), "plus");
	}
	const text = card.createDiv({ cls: "nb-continue-text" });
	const eyebrow = text.createDiv({ cls: "nb-continue-eyebrow" });
	setIconSafe(eyebrow.createSpan({ attr: { "aria-hidden": "true" } }), o.eyebrowIcon);
	eyebrow.createSpan({ text: o.eyebrow });
	text.createEl("h2", { cls: "nb-continue-title", text: o.title, attr: { title: o.title } });
	for (const line of o.lines) text.createDiv({ cls: "nb-continue-meta", text: line });
	const go = text.createEl("button", { cls: "nb-pill-btn mod-cta nb-continue-go", attr: { type: "button" } });
	setIconSafe(go.createSpan({ attr: { "aria-hidden": "true" } }), o.action.icon);
	go.createSpan({ text: o.action.label });
	go.addEventListener("click", (e) => {
		e.stopPropagation();
		o.action.onRun();
	});
	return card;
}

export interface QuickPageOptions {
	icon: string;
	color: string;
	title: string;
	/** "A new page in Quick notes" */
	description: string;
	/** Decoration: a faint artwork. */
	art?: ArtSource;
	key?: string;
	onRun: () => void;
}

/** The "Quick page" card (1/3 of the Continue row): one tap opens a new page in Quick notes. */
export function quickPageCard(parent: HTMLElement, o: QuickPageOptions): HTMLElement {
	const card = parent.createDiv({ cls: "nb-quickpage" });
	subjectVars(card, o.color);
	if (o.key) card.dataset.key = o.key;
	pressable(card, o.onRun, `${o.title}. ${o.description}`);
	if (o.art) applyArt(card.createDiv({ cls: "nb-quickpage-art", attr: { "aria-hidden": "true" } }), o.art);
	iconSquare(card, o.icon, o.color);
	const text = card.createDiv({ cls: "nb-quickpage-text" });
	text.createDiv({ cls: "nb-quickpage-title", text: o.title });
	text.createDiv({ cls: "nb-quickpage-desc", text: o.description });
	const add = card.createSpan({ cls: "nb-quickpage-add", attr: { "aria-hidden": "true" } });
	setIconSafe(add, "plus");
	return card;
}
