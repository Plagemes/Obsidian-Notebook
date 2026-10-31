/**
 * The Home surface (DESIGN.md §4, docs/design/reference/home.png), 0.13 structure, top to bottom: the Continue row (the
 * lecture in progress or the notebook you left off in, and the Quick page card), the quick actions, the subject folders (a
 * three-column grid ending in the dashed "New folder" tile), then Recent notes (grouped by notebook) next to Statistics.
 * Rendering only: every piece of data and every action comes from the library view (HomeHost).
 * 0.12.2/0.12.3 rules stay: creation is always reachable, an empty vault gets an empty state that teaches the first step, and
 * each section is drawn on its own, so one that fails shows an error card and never takes the others (or creation) with it.
 */
import { t } from "../i18n";
import { chip } from "../ui/components/chip";
import { continueCard, quickPageCard, type ContinueCardOptions, type QuickPageOptions } from "../ui/components/continue-card";
import { createTile, type CreateTileOptions } from "../ui/components/create-tile";
import { drawSafely } from "../ui/components/error-card";
import { emptyState, type EmptyStateOptions } from "../ui/components/empty-state";
import { quickAction, type QuickActionOptions } from "../ui/components/quick-action";
import { recentGroup, type RecentGroupOptions } from "../ui/components/recent-group";
import { sectionHeader } from "../ui/components/section-header";
import { pagesChart, statTile, subjectSplit, type PagesChartOptions, type StatTileOptions, type SubjectSplitOptions } from "../ui/components/stat-widgets";
import { subjectCard, type SubjectCardOptions } from "../ui/components/subject-card";

export interface RecentSection {
	/** Subject filter chips ("All" first); fewer than two means no filter row. */
	chips: Array<{ id: string | null; label: string; color?: string }>;
	activeChip: string | null;
	onChip: (id: string | null) => void;
	groups: RecentGroupOptions[];
	/** Said when the filter leaves nothing. */
	none: string;
	more: (() => void) | null;
}

export interface StatsSection {
	chart: PagesChartOptions;
	tiles: StatTileOptions[];
	split: SubjectSplitOptions | null;
}

export interface HomeHost {
	/** The Continue card, or null with `empty` set: nothing to continue yet (an empty vault). */
	continue: ContinueCardOptions | null;
	/** 0.12.2: the empty state of a vault with no notebooks yet; shown in the Continue slot. */
	empty: EmptyStateOptions | null;
	/** The Quick page card; null when the host cannot open Quick notes. */
	quickPage: QuickPageOptions | null;
	quick: QuickActionOptions[];
	/** Subject cards, already limited to what fits the width; `moreSubjects` adds "Show all". */
	subjects: SubjectCardOptions[];
	moreSubjects: (() => void) | null;
	/** The dashed "New folder" card: the last cell of the grid (and the only one without folders). */
	createSubject: CreateTileOptions;
	recent: RecentSection | null;
	stats: StatsSection | null;
}

/**
 * Draws one section; a failure is logged and leaves the rest of Home (and creation) in place. 0.12.3: it is also shown
 * as an error card (message and first stack frame) where the section would be, so a screenshot names the cause.
 */
function part(page: HTMLElement, name: string, label: string, draw: () => void): void {
	drawSafely(page, `Home: the ${name} section`, label, draw);
}

export function renderHome(el: HTMLElement, h: HomeHost): void {
	const page = el.createDiv({ cls: "nb-home" });

	part(page, "continue", t("home.continue"), () => {
		const row = page.createDiv({ cls: "nb-home-continue" });
		row.toggleClass("has-quickpage", !!h.quickPage);
		if (h.continue) continueCard(row, h.continue);
		else if (h.empty) emptyState(row.createDiv({ cls: "nb-continue is-empty" }), h.empty);
		if (h.quickPage) quickPageCard(row, h.quickPage);
	});

	part(page, "quick actions", t("home.quick"), () => {
		const sec = page.createEl("section", { cls: "nb-section nb-home-quick" });
		sectionHeader(sec, { icon: "zap", title: t("home.quick") });
		const grid = sec.createDiv({ cls: "nb-quick-grid is-compact" });
		for (const q of h.quick) quickAction(grid, { ...q, compact: true });
	});

	part(page, "subjects", t("home.subjects"), () => {
		const sec = page.createEl("section", { cls: "nb-section nb-home-subjects" });
		sectionHeader(sec, { icon: "folder", title: t("home.subjects"), link: h.moreSubjects ? { label: t("home.showAll"), onClick: h.moreSubjects } : undefined });
		const grid = sec.createDiv({ cls: "nb-subject-grid is-cols" });
		for (const s of h.subjects) subjectCard(grid, { ...s, compact: true });
		// The last cell of the grid: no gap, and the way to the next folder is always there.
		createTile(grid, { ...h.createSubject, compact: true });
	});

	if (h.recent || h.stats) {
		const middle = page.createDiv({ cls: "nb-home-middle" });
		const recent = h.recent;
		if (recent) part(middle, "recent notes", t("home.recent"), () => renderRecent(middle, recent));
		const stats = h.stats;
		if (stats) part(middle, "statistics", t("home.stats"), () => renderStats(middle, stats));
	}
}

function renderRecent(middle: HTMLElement, r: RecentSection): void {
	const panel = middle.createEl("section", { cls: "nb-panel nb-home-recent" });
	sectionHeader(panel, { icon: "file-text", title: t("home.recent"), link: r.more ? { label: t("home.showAll"), onClick: r.more } : undefined });
	if (r.chips.length > 1) {
		const row = panel.createDiv({ cls: "nb-chips nb-recent-filter", attr: { role: "toolbar", "aria-label": t("home.recent.filter") } });
		for (const c of r.chips) chip(row, { label: c.label, dot: c.color, active: c.id === r.activeChip, key: `recentchip:${c.id ?? "all"}`, onClick: () => r.onChip(c.id) });
	}
	const list = panel.createDiv({ cls: "nb-recent-groups" });
	if (r.groups.length === 0) list.createDiv({ cls: "nb-hint nb-recent-none", text: r.none });
	for (const g of r.groups) recentGroup(list, g);
}

function renderStats(middle: HTMLElement, s: StatsSection): void {
	const stats = middle.createEl("section", { cls: "nb-panel nb-home-stats" });
	sectionHeader(stats, { icon: "bar-chart-3", title: t("home.stats") });
	const body = stats.createDiv({ cls: "nb-stat-body" });
	pagesChart(body, s.chart);
	if (s.tiles.length > 0) {
		const tiles = body.createDiv({ cls: "nb-stat-tiles" });
		for (const tile of s.tiles) statTile(tiles, tile);
	}
	if (s.split) subjectSplit(body, s.split);
}
