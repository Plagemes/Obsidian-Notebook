/**
 * 0.12: the dashboard of the library's "All" filter (DESIGN.md §4, docs/design/reference/library.png): subject cards,
 * smart collections, frequent tags, recent and favourite notebooks. Rendering only; the data and actions come from the
 * library view (LibrarySectionsHost).
 */
import { t } from "../i18n";
import { chip } from "../ui/components/chip";
import { createTile, type CreateTileOptions } from "../ui/components/create-tile";
import { drawSafely } from "../ui/components/error-card";
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

/** 0.14: a dynamic section (Now, To complete, Changed on another device): drawn only when it has rows. */
export interface DynamicPanel {
	id: string;
	icon: string;
	title: string;
	count: number;
	rows: ListRowOptions[];
	more: (() => void) | null;
	/** A real action of the section (e.g. "Mark as seen"). */
	action: { label: string; onRun: () => void } | null;
}

export interface LibrarySectionsHost {
	/** 0.14: dynamic sections, above the subjects; empty ones are not passed. */
	dynamic: DynamicPanel[];
	subjects: SubjectCardOptions[];
	moreSubjects: (() => void) | null;
	/** 0.12.2: the dashed "Create a folder" tile shown in place of the subject cards when there are none. */
	createSubject: CreateTileOptions;
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
	// 0.12.3: each section on its own: one that throws shows an error card in its place and the others are still drawn.
	const part = (name: string, label: string, draw: () => void) => drawSafely(el, `Library: the ${name} section`, label, draw);
	// 0.14: Now / To complete / Changed on another device come first; each hides when it has nothing.
	if (h.dynamic.length > 0) {
		const wrap = el.createDiv({ cls: "nb-lib-dynamic" });
		for (const d of h.dynamic) {
			part(`dynamic ${d.id}`, d.title, () => {
				const panel = wrap.createEl("section", { cls: `nb-panel nb-lib-dyn nb-lib-dyn-${d.id}` });
				const head = sectionHeader(panel, { icon: d.icon, title: d.title, link: d.more ? { label: t("lib.showAll"), onClick: d.more } : undefined });
				head.createSpan({ cls: "nb-dyn-count", text: String(d.count) });
				if (d.action) {
					const run = d.action.onRun;
					const b = head.querySelector(".nb-section-tools")?.createEl("button", { cls: "nb-link nb-dyn-action", text: d.action.label, attr: { type: "button" } });
					b?.addEventListener("click", run);
				}
				const list = panel.createDiv({ cls: "nb-list" });
				for (const r of d.rows) listRow(list, r);
			});
		}
	}
	// Subject folders can be created: with none yet, a dashed tile takes the place of the cards (DESIGN.md §5).
	part("subjects", t("home.subjects"), () => {
		const sec = el.createEl("section", { cls: "nb-section nb-lib-subjects" });
		sectionHeader(sec, { icon: "folder", title: t("home.subjects"), link: h.moreSubjects ? { label: t("home.showAll"), onClick: h.moreSubjects } : undefined });
		const grid = sec.createDiv({ cls: "nb-subject-grid is-tiles" });
		if (h.subjects.length === 0) createTile(grid, h.createSubject);
		for (const s of h.subjects) subjectCard(grid, s);
	});
	if (h.collections.length > 0) {
		part("collections", t("lib.collections"), () => {
			const sec = el.createEl("section", { cls: "nb-section nb-lib-collections" });
			sectionHeader(sec, { icon: "layers", title: t("lib.collections") });
			const grid = sec.createDiv({ cls: "nb-collection-grid" });
			for (const c of h.collections) quickAction(grid, c).addClass("is-collection");
		});
	}
	if (h.tags.length > 0) {
		part("tags", t("lib.tags"), () => {
			const sec = el.createEl("section", { cls: "nb-section nb-lib-tags" });
			sectionHeader(sec, { icon: "tag", title: t("lib.tags"), link: h.moreTags ? { label: t("lib.showAll"), onClick: h.moreTags } : undefined });
			renderTagChips(sec, h.tags);
		});
	}
	if (h.recent.length > 0 || h.favourites.length > 0) {
		const row = el.createDiv({ cls: "nb-lib-lists" });
		if (h.recent.length > 0) {
			part("recent", t("lib.recent"), () => {
				const panel = row.createEl("section", { cls: "nb-panel nb-lib-recent" });
				sectionHeader(panel, { icon: "file-text", title: t("lib.recent"), link: h.moreRecent ? { label: t("lib.showAll"), onClick: h.moreRecent } : undefined });
				const list = panel.createDiv({ cls: "nb-list" });
				for (const r of h.recent) listRow(list, r);
			});
		}
		if (h.favourites.length > 0) {
			part("favourites", t("lib.favourites"), () => {
				const panel = row.createEl("section", { cls: "nb-panel nb-lib-favourites" });
				sectionHeader(panel, { icon: "star", title: t("lib.favourites"), link: h.moreFavourites ? { label: t("lib.showAll"), onClick: h.moreFavourites } : undefined });
				const list = panel.createDiv({ cls: "nb-list" });
				for (const f of h.favourites) favouriteRow(list, f);
			});
		}
	}
}
