// Coloured sections (0.30, #52), the view side: make a section at a page, rename, recolour and remove one through the history (one undo
// step each), jump to a section, and the coloured tab strip and dividers of the page panel. The format and the pure rules are in
// model/sections.ts; the dialogs are view/sections-modal.ts.
import { setIcon, type App } from "obsidian";
import { t } from "../i18n";
import type { Command } from "../model/history";
import {
	hiddenSections, makeSection, resolveSections, sectionAtIndex, sectionsOf, sectionStartingAt, setSections, withSectionAdded, withSectionRecoloured, withSectionRemoved,
	withSectionRenamed, type ResolvedSection,
} from "../model/sections";
import { SECTIONS_MAX, type NotebookDocument, type Section } from "../model/types";
import { tintFor } from "../ui/palette";
import { showNotice } from "./notice";
import { nextSectionColor, stepTarget } from "./sections-logic";
import { SectionEditModal, SectionsModal, type SectionsApi } from "./sections-modal";

/** What the tools need from the notebook view. */
export interface SectionsHost {
	app: App;
	/** The document to read (the complete one, or the part read so far), or null. */
	doc(): NotebookDocument | null;
	/** The document can be edited (not read-only mode, not loading). */
	editable(): boolean;
	/** Runs a command as one undo step; false when the history refused it (it says why itself). */
	execute(cmd: Command): boolean;
	/** The page in view (0-based). */
	current(): number;
	goTo(index: number): void;
}

/** What the page panel shows for one page: the colour of its section, and whether a divider with the title goes above it. */
export interface NavSectionMark {
	id: string;
	title: string;
	color: string;
	/** The first page of the section among those listed: a divider with the title goes above it. */
	divider: boolean;
	count: number;
}

/** What the page panel asks the tools (navigator.ts). */
export interface NavigatorSections {
	/** Fills the tab strip (empties it, hides it when there is no section). */
	strip(parent: HTMLElement): void;
	/** Called before the rows are built again: dividers start over. */
	reset(): void;
	/** The section mark of page `index`, or null (no section). */
	mark(index: number): NavSectionMark | null;
}

/** The divider above the first listed page of a section in the page panel: the colour, the title and the page count (a heading, not a control). */
export function sectionDivider(list: HTMLElement, mark: NavSectionMark): HTMLElement {
	const el = list.createDiv({ cls: "nb-ui nb-sections-divider", attr: { role: "heading", "aria-level": "3", "data-section": mark.id } });
	el.setCssProps({ "--nb-section-color": mark.color, "--nb-section-tint": tintFor(mark.color) });
	el.createSpan({ cls: "nb-sections-tab-dot", attr: { "aria-hidden": "true" } });
	el.createSpan({ cls: "nb-sections-divider-title", text: mark.title });
	el.createSpan({ cls: "nb-sections-divider-count", text: t(mark.count === 1 ? "sections.pages.one" : "sections.pages.many", { count: String(mark.count) }) });
	return el;
}

/** Scrolls the tab strip sideways (only the strip, never the page) so the tab of the section in view is shown, once it is laid out. */
function revealTab(row: HTMLElement, tab: HTMLElement): void {
	window.requestAnimationFrame(() => {
		const r = row.getBoundingClientRect();
		const b = tab.getBoundingClientRect();
		if (b.left < r.left || b.right > r.right) row.scrollLeft += b.left - r.left - (r.width - b.width) / 2;
	});
}

export class SectionTools implements SectionsApi, NavigatorSections {
	/** The section of the last row the page panel built (a divider goes above a row whose section differs). */
	private lastRowSection: string | null = null;
	/** The sections as they were when the page panel started building its rows (one lookup for the whole list). */
	private rows: ResolvedSection[] | null = null;
	/** What the tab strip shows now (it is redrawn only when that changes). */
	private stripKey: { el: HTMLElement; list: readonly ResolvedSection[]; key: string } | null = null;
	private cache: { doc: NotebookDocument; pages: readonly unknown[]; sections: readonly Section[] | undefined; resolved: ResolvedSection[] } | null = null;

	constructor(private readonly host: SectionsHost) {}

	/** The sections that show, in page order (cached while the page list and the section list are the same objects with the same length). */
	resolved(): ResolvedSection[] {
		const doc = this.host.doc();
		if (!doc) return [];
		const c = this.cache;
		if (c && c.doc === doc && c.sections === doc.sections && c.pages.length === doc.pages.length && c.pages.every((p, i) => p === doc.pages[i])) return c.resolved;
		const resolved = resolveSections(doc.pages, sectionsOf(doc));
		this.cache = { doc, pages: [...doc.pages], sections: doc.sections, resolved };
		return resolved;
	}

	canEdit(): boolean {
		return this.host.editable();
	}

	currentIndex(): number {
		return this.host.current();
	}

	/** The section of page `index` (default: the page in view). */
	at(index: number = this.host.current()): ResolvedSection | null {
		return sectionAtIndex(this.resolved(), index);
	}

	// ------------------------------------------------------------------ actions

	/** The list of sections (jump, and the edits). */
	openList(): void {
		if (!this.host.doc()) return;
		new SectionsModal(this.host.app, this).open();
	}

	/**
	 * Whether the list is full (review S4): every stored section counts, those that show nowhere included, because the file keeps them all.
	 * The *New section* button and `create` use this one count.
	 */
	isFull(): boolean {
		const doc = this.host.doc();
		return !!doc && sectionsOf(doc).length >= SECTIONS_MAX;
	}

	/** How many sections show nowhere (their page is gone, or another section starts at it): they still count toward the limit. */
	hiddenCount(): number {
		const doc = this.host.doc();
		return doc ? hiddenSections(doc.pages, sectionsOf(doc)).length : 0;
	}

	/** Removes every section that shows nowhere, as one undo step (review S4). */
	removeHidden(): boolean {
		const doc = this.edit();
		if (!doc) return false;
		const hidden = new Set(hiddenSections(doc.pages, sectionsOf(doc)));
		if (hidden.size === 0) return false;
		if (!this.run(doc, sectionsOf(doc).filter((s) => !hidden.has(s)), "Remove hidden sections")) return false;
		showNotice(t("sections.notice.hiddenRemoved", { count: String(hidden.size) }), 4000);
		return true;
	}

	/** Starts a new section at page `index` (asks for the title and colour first). */
	create(index: number = this.host.current()): void {
		const doc = this.edit();
		if (!doc) return;
		const page = doc.pages[index];
		if (!page) return;
		const there = sectionStartingAt(sectionsOf(doc), page.id);
		if (there) {
			showNotice(t("sections.notice.already", { title: there.title }), 5000);
			this.editSection(there.id, "title");
			return;
		}
		if (this.isFull()) {
			const hidden = this.hiddenCount();
			showNotice(hidden > 0 ? t("sections.notice.fullHidden", { max: String(SECTIONS_MAX), count: String(hidden) }) : t("sections.notice.full", { max: String(SECTIONS_MAX) }), 6000);
			return;
		}
		const list = sectionsOf(doc);
		// Review S6: the dialog keeps the page id, not its index (the page list may change while it is open).
		const pageId = page.id;
		new SectionEditModal(this.host.app, {
			mode: "new",
			title: t("sections.defaultTitle", { n: String(this.resolved().length + 1) }),
			color: nextSectionColor(list),
			page: index + 1,
			focus: "title",
		}, (title, color) => this.add(pageId, title, color)).open();
	}

	/**
	 * Adds a section at the page with id `pageId` now (the dialog's save). When the notebook no longer has that page (a sync reload, a merge
	 * or a move from another pane while the dialog was open), it says so and makes nothing; true closes the dialog all the same.
	 */
	add(pageId: string, title: string, color: string): boolean {
		const doc = this.edit();
		if (!doc) return false;
		const index = doc.pages.findIndex((p) => p.id === pageId);
		const page = doc.pages[index];
		if (!page) {
			showNotice(t("sections.notice.pageGone"), 5000);
			return true;
		}
		const list = sectionsOf(doc);
		const made = makeSection({ title, color, page: page.id }, new Set(list.map((s) => s.id)));
		if (!made) {
			showNotice(t("sections.notice.failed"), 5000);
			return false;
		}
		const next = withSectionAdded(list, made);
		if (next === list) {
			showNotice(t("sections.notice.failed"), 5000);
			return false;
		}
		if (!this.run(doc, next, "New section")) return false;
		showNotice(t("sections.notice.created", { title: made.title, page: String(index + 1) }), 3000);
		return true;
	}

	/** Opens the dialog to rename and recolour section `id` (`focus`: which part takes the focus). */
	editSection(id: string, focus: "title" | "color"): void {
		const doc = this.edit();
		const found = doc ? sectionsOf(doc).find((s) => s.id === id) : undefined;
		if (!found) return;
		const range = this.resolved().find((r) => r.section.id === id);
		new SectionEditModal(this.host.app, { mode: "edit", title: found.title, color: found.color, page: (range?.start ?? 0) + 1, focus }, (title, color) => this.update(id, title, color)).open();
	}

	/** The section of page `index`: rename (dialog). */
	renameAt(index: number = this.host.current()): void {
		const at = this.atOrSay(index);
		if (at) this.editSection(at.section.id, "title");
	}

	/** The section of page `index`: recolour (dialog). */
	recolourAt(index: number = this.host.current()): void {
		const at = this.atOrSay(index);
		if (at) this.editSection(at.section.id, "color");
	}

	/** The section of page `index`: remove (its pages stay; undo brings it back). */
	removeAt(index: number = this.host.current()): void {
		const at = this.atOrSay(index);
		if (at) this.remove(at.section.id);
	}

	/** Renames and recolours section `id` as one undo step (nothing when neither changes). */
	update(id: string, title: string, color: string): boolean {
		const doc = this.edit();
		if (!doc) return false;
		const list = sectionsOf(doc);
		const next = withSectionRecoloured(withSectionRenamed(list, id, title), id, color);
		if (next === list) return true;
		const renamed = next.find((s) => s.id === id)?.title !== list.find((s) => s.id === id)?.title;
		return this.run(doc, next, renamed ? "Rename section" : "Recolour section");
	}

	remove(id: string): boolean {
		const doc = this.edit();
		if (!doc) return false;
		const found = sectionsOf(doc).find((s) => s.id === id);
		if (!found || !this.run(doc, withSectionRemoved(sectionsOf(doc), id), "Delete section")) return false;
		showNotice(t("sections.notice.removed", { title: found.title }), 4000);
		return true;
	}

	/** Shows the first page of section `id`. */
	go(id: string): boolean {
		const r = this.resolved().find((x) => x.section.id === id);
		if (!r) return false;
		this.host.goTo(r.start);
		return true;
	}

	/** Goes to the next (+1) or previous (-1) section; says so when there is none that way. */
	step(by: 1 | -1): void {
		const all = this.resolved();
		if (all.length === 0) {
			showNotice(t("sections.notice.none"), 4000);
			return;
		}
		const go = stepTarget(all, this.host.current(), by);
		if (!go) {
			showNotice(t(by > 0 ? "sections.notice.last" : "sections.notice.first"), 3000);
			return;
		}
		this.host.goTo(go.start);
	}

	// ------------------------------------------------------------------ the page panel

	reset(): void {
		this.lastRowSection = null;
		this.rows = this.resolved();
	}

	mark(index: number): NavSectionMark | null {
		const r = sectionAtIndex(this.rows ?? this.resolved(), index);
		if (!r) {
			this.lastRowSection = null;
			return null;
		}
		const divider = this.lastRowSection !== r.section.id;
		this.lastRowSection = r.section.id;
		return { id: r.section.id, title: r.section.title, color: r.section.color, divider, count: r.count };
	}

	strip(parent: HTMLElement): void {
		const all = this.resolved();
		const current = this.at();
		// The same sections with the same one in view: nothing to redraw (this runs on every page change).
		const key = current?.section.id ?? "";
		if (this.stripKey?.el === parent && this.stripKey.list === all && this.stripKey.key === key) return;
		this.stripKey = { el: parent, list: all, key };
		parent.empty();
		parent.toggleClass("notebook-hidden", all.length === 0);
		if (all.length === 0) return;
		const row = parent.createDiv({ cls: "nb-sections-tabs", attr: { role: "tablist", "aria-label": t("sections.strip.aria") } });
		for (const r of all) {
			const on = current?.section.id === r.section.id;
			const tab = row.createEl("button", {
				cls: "nb-sections-tab",
				attr: { type: "button", role: "tab", "aria-selected": String(on), "aria-label": t("sections.tab.aria", { title: r.section.title, count: String(r.count) }), title: r.section.title },
			});
			tab.toggleClass("is-current", on);
			tab.setCssProps({ "--nb-section-color": r.section.color, "--nb-section-tint": tintFor(r.section.color) });
			tab.createSpan({ cls: "nb-sections-tab-dot", attr: { "aria-hidden": "true" } });
			tab.createSpan({ cls: "nb-sections-tab-label", text: r.section.title });
			tab.addEventListener("click", () => this.host.goTo(r.start));
			if (on) revealTab(row, tab);
		}
		const list = parent.createEl("button", { cls: "nb-sections-more clickable-icon", attr: { type: "button", "aria-label": t("sections.action.list"), title: t("sections.action.list") } });
		setIcon(list, "layers");
		list.dataset.help = "sections.help.list";
		list.addEventListener("click", () => this.openList());
	}

	// ------------------------------------------------------------------ internals

	private atOrSay(index: number): ResolvedSection | null {
		const at = this.at(index);
		if (!at) showNotice(t("sections.notice.noneHere"), 4000);
		return at;
	}

	/** The document, when the notebook can be changed; else says so. */
	private edit(): NotebookDocument | null {
		const doc = this.host.doc();
		if (!doc || !this.host.editable()) {
			showNotice(t("sections.notice.readOnly"), 5000);
			return null;
		}
		return doc;
	}

	private run(doc: NotebookDocument, next: readonly Section[], label: string): boolean {
		const cmd = setSections(doc, next, label);
		if (!cmd) return false;
		this.cache = null;
		return this.host.execute(cmd);
	}
}
