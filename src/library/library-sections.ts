/**
 * 0.12: the dashboard of the library's "All" filter (DESIGN.md §4, docs/design/reference/library.png): subject cards,
 * smart collections, frequent tags, recent and favourite notebooks. Rendering only; the data and actions come from the
 * library view (LibrarySectionsHost).
 */
import { t } from "../i18n";
import { chip } from "../ui/components/chip";
import { favouriteRow, type FavouriteRowOptions } from "../ui/components/favourite-row";
import { listRow, type ListRowOptions } from "../ui/components/list-row";
import { quickAction, type QuickActionOptions } from "../ui/components/quick-action";
import { sectionHeader } from "../ui/components/section-header";
import { subjectCard, type SubjectCardOptions } from "../ui/components/subject-card";

export interface TagChip {
	tag: string;
	count: number;
	/** Subject colour when the tag names a subject; a neutral dot otherwise. */
	color: string | null;
	onClick: () => void;
}

export interface LibrarySectionsHost {
	subjects: SubjectCardOptions[];
	moreSubjects: (() => void) | null;
	collections: QuickActionOptions[];
	tags: TagChip[];
	moreTags: (() => void) | null;
	recent: ListRowOptions[];
	moreRecent: (() => void) | null;
	favourites: FavouriteRowOptions[];
	moreFavourites: (() => void) | null;
}

/** A neutral dot colour for tags that are not subjects. */
export const NEUTRAL_DOT = "#7A8399";

export function renderTagChips(parent: HTMLElement, tags: readonly TagChip[]): HTMLElement {
	const row = parent.createDiv({ cls: "nb-tag-chips" });
	for (const tg of tags) chip(row, { label: tg.tag, dot: tg.color ?? NEUTRAL_DOT, count: tg.count, key: `tagchip:${tg.tag}`, onClick: tg.onClick });
	return row;
}

export function renderLibrarySections(el: HTMLElement, h: LibrarySectionsHost): void {
	if (h.subjects.length > 0) {
		const sec = el.createEl("section", { cls: "nb-section nb-lib-subjects" });
		sectionHeader(sec, { icon: "folder", title: t("home.subjects"), link: h.moreSubjects ? { label: t("home.showAll"), onClick: h.moreSubjects } : undefined });
		const grid = sec.createDiv({ cls: "nb-subject-grid is-tiles" });
		for (const s of h.subjects) subjectCard(grid, s);
	}
	if (h.collections.length > 0) {
		const sec = el.createEl("section", { cls: "nb-section nb-lib-collections" });
		sectionHeader(sec, { icon: "layers", title: t("lib.collections") });
		const grid = sec.createDiv({ cls: "nb-collection-grid" });
		for (const c of h.collections) quickAction(grid, c).addClass("is-collection");
	}
	if (h.tags.length > 0) {
		const sec = el.createEl("section", { cls: "nb-section nb-lib-tags" });
		sectionHeader(sec, { icon: "tag", title: t("lib.tags"), link: h.moreTags ? { label: t("lib.showAll"), onClick: h.moreTags } : undefined });
		renderTagChips(sec, h.tags);
	}
	if (h.recent.length > 0 || h.favourites.length > 0) {
		const row = el.createDiv({ cls: "nb-lib-lists" });
		if (h.recent.length > 0) {
			const panel = row.createEl("section", { cls: "nb-panel nb-lib-recent" });
			sectionHeader(panel, { icon: "file-text", title: t("lib.recent"), link: h.moreRecent ? { label: t("lib.showAll"), onClick: h.moreRecent } : undefined });
			const list = panel.createDiv({ cls: "nb-list" });
			for (const r of h.recent) listRow(list, r);
		}
		if (h.favourites.length > 0) {
			const panel = row.createEl("section", { cls: "nb-panel nb-lib-favourites" });
			sectionHeader(panel, { icon: "star", title: t("lib.favourites"), link: h.moreFavourites ? { label: t("lib.showAll"), onClick: h.moreFavourites } : undefined });
			const list = panel.createDiv({ cls: "nb-list" });
			for (const f of h.favourites) favouriteRow(list, f);
		}
	}
}
