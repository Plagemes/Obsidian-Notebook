/**
 * 0.12: the Home surface (DESIGN.md §4, docs/design/reference/home.png): subject cards, recent notes, statistics and
 * quick actions. Rendering only: every piece of data and every action comes from the library view (HomeHost).
 */
import { Menu } from "obsidian";
import { t } from "../i18n";
import { setIconSafe } from "../ui/components/dom";
import { kpiTile, type KpiTileOptions } from "../ui/components/kpi-tile";
import { listRow, type ListRowOptions } from "../ui/components/list-row";
import { quickAction, type QuickActionOptions } from "../ui/components/quick-action";
import { sectionHeader } from "../ui/components/section-header";
import { subjectCard, type SubjectCardOptions } from "../ui/components/subject-card";
import { STAT_PERIODS, type StatPeriod } from "./dashboard";

export interface HomeHost {
	/** Subject cards (at most four); `moreSubjects` adds "Show all". */
	subjects: SubjectCardOptions[];
	moreSubjects: (() => void) | null;
	/** Recently edited pages or notebooks (at most five). */
	recent: ListRowOptions[];
	moreRecent: (() => void) | null;
	stats: KpiTileOptions[];
	weeks: StatPeriod;
	setWeeks: (weeks: StatPeriod) => void;
	quick: QuickActionOptions[];
}

function periodLabel(weeks: StatPeriod): string {
	return weeks === 1 ? t("home.stats.week") : t("home.stats.weeks", { n: String(weeks) });
}

export function renderHome(el: HTMLElement, h: HomeHost): void {
	const page = el.createDiv({ cls: "nb-home" });

	if (h.subjects.length > 0) {
		const sec = page.createEl("section", { cls: "nb-section nb-home-subjects" });
		sectionHeader(sec, { icon: "folder", title: t("home.subjects"), link: h.moreSubjects ? { label: t("home.showAll"), onClick: h.moreSubjects } : undefined });
		const grid = sec.createDiv({ cls: "nb-subject-grid is-rows" });
		for (const s of h.subjects) subjectCard(grid, s);
	}

	const middle = page.createDiv({ cls: "nb-home-middle" });
	if (h.recent.length > 0) {
		const panel = middle.createEl("section", { cls: "nb-panel nb-home-recent" });
		sectionHeader(panel, { icon: "file-text", title: t("home.recent"), link: h.moreRecent ? { label: t("home.showAll"), onClick: h.moreRecent } : undefined });
		const list = panel.createDiv({ cls: "nb-list" });
		for (const r of h.recent) listRow(list, r);
	}
	const stats = middle.createEl("section", { cls: "nb-panel nb-home-stats" });
	const head = sectionHeader(stats, { icon: "bar-chart-3", title: t("home.stats") });
	const tools = head.querySelector<HTMLElement>(".nb-section-tools");
	if (tools) {
		const period = tools.createEl("button", { cls: "nb-dropdown", attr: { type: "button", "aria-haspopup": "menu", "aria-label": t("home.stats.period") } });
		period.createSpan({ text: periodLabel(h.weeks) });
		setIconSafe(period.createSpan({ cls: "nb-dropdown-caret", attr: { "aria-hidden": "true" } }), "chevron-down");
		period.addEventListener("click", () => {
			const menu = new Menu();
			for (const w of STAT_PERIODS) menu.addItem((i) => i.setTitle(periodLabel(w)).setChecked(w === h.weeks).onClick(() => h.setWeeks(w)));
			const r = period.getBoundingClientRect();
			menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
		});
	}
	const kpis = stats.createDiv({ cls: "nb-kpi-grid" });
	for (const k of h.stats) kpiTile(kpis, k);

	if (h.quick.length > 0) {
		const sec = page.createEl("section", { cls: "nb-section nb-home-quick" });
		sectionHeader(sec, { icon: "zap", title: t("home.quick") });
		const grid = sec.createDiv({ cls: "nb-quick-grid" });
		for (const q of h.quick) quickAction(grid, q);
	}
}
