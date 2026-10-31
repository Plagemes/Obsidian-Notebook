// 0.13: the widgets of Home's Statistics panel (DESIGN.md §3). Drawn with CSS only (bars are boxes, the split is a row of
// coloured segments), in token colours, with accessible names. Rendering only: the numbers come from library/home-stats.ts.
import { pressable, setIconSafe, subjectVars } from "./dom";
import { iconSquare } from "./icon-square";

export interface BarDatum {
	/** Short label under the bar ("M", "28"). */
	label: string;
	value: number;
	/** The bar's tooltip and its share of the chart's accessible description ("Mon 28 Oct: 5 pages"). */
	tip: string;
	today?: boolean;
}

export interface RangeOption {
	value: number;
	label: string;
}

export interface PagesChartOptions {
	title: string;
	/** "34 pages · 4.9 a day" */
	summary: string;
	bars: readonly BarDatum[];
	/** The accessible description of the whole chart. */
	description: string;
	range: { value: number; options: readonly RangeOption[]; label: string; onChange: (value: number) => void };
	/** Shown in place of the bars when nothing was written in the period: says what to do. */
	empty?: { text: string; action?: { label: string; onRun: () => void } };
	key?: string;
}

/** Pages written per day: a bar chart with a 7 / 14 day switch. */
export function pagesChart(parent: HTMLElement, o: PagesChartOptions): HTMLElement {
	const card = parent.createDiv({ cls: "nb-stat-chart" });
	if (o.key) card.dataset.key = o.key;
	const head = card.createDiv({ cls: "nb-stat-chart-head" });
	const titles = head.createDiv({ cls: "nb-stat-chart-titles" });
	titles.createDiv({ cls: "nb-stat-title", text: o.title });
	titles.createDiv({ cls: "nb-stat-sub", text: o.summary });
	const seg = head.createDiv({ cls: "nb-segmented", attr: { role: "group", "aria-label": o.range.label } });
	for (const opt of o.range.options) {
		const b = seg.createEl("button", { cls: "nb-segment", text: opt.label, attr: { type: "button", "aria-pressed": String(opt.value === o.range.value) } });
		b.toggleClass("is-active", opt.value === o.range.value);
		b.dataset.key = `range:${opt.value}`;
		b.addEventListener("click", () => o.range.onChange(opt.value));
	}
	if (o.empty) {
		const empty = card.createDiv({ cls: "nb-stat-empty" });
		setIconSafe(empty.createSpan({ attr: { "aria-hidden": "true" } }), "pencil-line");
		empty.createSpan({ cls: "nb-stat-empty-text", text: o.empty.text });
		if (o.empty.action) {
			const a = o.empty.action;
			const b = empty.createEl("button", { cls: "nb-link", attr: { type: "button" } });
			b.createSpan({ text: a.label });
			setIconSafe(b.createSpan({ cls: "nb-link-arrow", attr: { "aria-hidden": "true" } }), "arrow-right");
			b.addEventListener("click", a.onRun);
		}
		return card;
	}
	const max = Math.max(1, ...o.bars.map((b) => b.value));
	const chart = card.createDiv({ cls: "nb-bars", attr: { role: "img", "aria-label": o.description } });
	chart.setCssProps({ "--nb-bar-count": String(o.bars.length) });
	for (const b of o.bars) {
		const col = chart.createDiv({ cls: "nb-bar-col", attr: { title: b.tip } });
		col.toggleClass("is-today", !!b.today);
		col.createDiv({ cls: "nb-bar-value", text: b.value > 0 ? String(b.value) : "" });
		const track = col.createDiv({ cls: "nb-bar-track" });
		const bar = track.createDiv({ cls: "nb-bar" });
		bar.toggleClass("is-zero", b.value === 0);
		bar.setCssProps({ "--nb-h": `${b.value === 0 ? 4 : Math.max(10, Math.round((b.value / max) * 100))}%` });
		col.createDiv({ cls: "nb-bar-label", text: b.label });
	}
	return card;
}

export interface StatTileOptions {
	icon: string;
	color: string;
	/** The big number ("5", "3 h 20 min"). Absent on a hint tile. */
	value?: string;
	label: string;
	/** A line under the label ("Best: 9 days"). */
	hint?: string;
	/** A hint tile: says what to do next and does it. */
	action?: { label: string; onRun: () => void };
	key?: string;
}

/** A small tile (streak, writing time) or, with an `action`, a hint that teaches the next step and runs it. */
export function statTile(parent: HTMLElement, o: StatTileOptions): HTMLElement {
	const tile = parent.createDiv({ cls: "nb-stat-tile" });
	if (o.key) tile.dataset.key = o.key;
	tile.toggleClass("is-hint", !!o.action);
	if (o.action) pressable(tile, o.action.onRun, `${o.label}. ${o.action.label}`);
	else tile.setAttrs({ role: "group", "aria-label": `${o.value ?? ""} ${o.label}`.trim() });
	iconSquare(tile, o.icon, o.color, "is-round");
	const text = tile.createDiv({ cls: "nb-stat-tile-text" });
	if (o.value !== undefined) text.createDiv({ cls: "nb-stat-value", text: o.value });
	text.createDiv({ cls: "nb-stat-label", text: o.label });
	if (o.hint) text.createDiv({ cls: "nb-stat-hint", text: o.hint });
	if (o.action) {
		const a = text.createDiv({ cls: "nb-stat-action" });
		a.createSpan({ text: o.action.label });
		setIconSafe(a.createSpan({ attr: { "aria-hidden": "true" } }), "arrow-right");
	}
	return tile;
}

export interface SplitSegment {
	label: string;
	color: string;
	pages: number;
	/** 0–1 */
	share: number;
}

export interface SubjectSplitOptions {
	title: string;
	/** "Anatomy · 14 pages" — the most active subject. */
	headline: string;
	headlineColor: string;
	segments: readonly SplitSegment[];
	/** Accessible description of the bar. */
	description: string;
	key?: string;
}

/** The most active subject and a bar split by subject colour, with a legend. */
export function subjectSplit(parent: HTMLElement, o: SubjectSplitOptions): HTMLElement {
	const card = parent.createDiv({ cls: "nb-stat-split" });
	if (o.key) card.dataset.key = o.key;
	card.createDiv({ cls: "nb-stat-title", text: o.title });
	const head = card.createDiv({ cls: "nb-stat-split-head" });
	const dot = head.createSpan({ cls: "nb-stat-dot", attr: { "aria-hidden": "true" } });
	subjectVars(dot, o.headlineColor);
	head.createSpan({ cls: "nb-stat-split-name", text: o.headline });
	const bar = card.createDiv({ cls: "nb-split-bar", attr: { role: "img", "aria-label": o.description } });
	for (const s of o.segments) {
		const seg = bar.createDiv({ cls: "nb-split-seg", attr: { title: `${s.label}: ${s.pages}` } });
		subjectVars(seg, s.color);
		seg.setCssProps({ "--nb-w": String(Math.max(0.02, s.share)) });
	}
	const legend = card.createDiv({ cls: "nb-split-legend" });
	for (const s of o.segments) {
		const item = legend.createDiv({ cls: "nb-split-item" });
		const d = item.createSpan({ cls: "nb-stat-dot", attr: { "aria-hidden": "true" } });
		subjectVars(d, s.color);
		item.createSpan({ cls: "nb-split-name", text: s.label });
		item.createSpan({ cls: "nb-split-count", text: String(s.pages) });
	}
	return card;
}
