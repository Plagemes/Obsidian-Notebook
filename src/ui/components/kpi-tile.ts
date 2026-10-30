import { pressable, setIconSafe } from "./dom";
import { iconSquare } from "./icon-square";

export interface KpiTileOptions {
	icon: string;
	color: string;
	value: string;
	label: string;
	/** "+24%" and its direction; null hides it (no exact comparison available). */
	delta: { text: string; up: boolean; label: string } | null;
	/** Bars of the sparkline, oldest first. */
	series: readonly number[];
	key?: string;
	onOpen: () => void;
}

/** KPI tile (DESIGN.md §3): icon, big number, label, delta, mini bar sparkline. Tapping opens the detail. */
export function kpiTile(parent: HTMLElement, o: KpiTileOptions): HTMLElement {
	const tile = parent.createDiv({ cls: "nb-kpi" });
	if (o.key) tile.dataset.key = o.key;
	pressable(tile, o.onOpen, `${o.value} ${o.label}`);
	const top = tile.createDiv({ cls: "nb-kpi-top" });
	iconSquare(top, o.icon, o.color, "is-round");
	const text = top.createDiv({ cls: "nb-kpi-text" });
	text.createDiv({ cls: "nb-kpi-value", text: o.value });
	text.createDiv({ cls: "nb-kpi-label", text: o.label });
	const bottom = tile.createDiv({ cls: "nb-kpi-bottom" });
	if (o.delta) {
		const d = bottom.createDiv({ cls: `nb-kpi-delta ${o.delta.up ? "is-up" : "is-down"}`, attr: { title: o.delta.label } });
		setIconSafe(d.createSpan({ attr: { "aria-hidden": "true" } }), o.delta.up ? "arrow-up" : "arrow-down");
		d.createSpan({ text: o.delta.text });
	} else {
		bottom.createDiv({ cls: "nb-kpi-delta is-none" });
	}
	const spark = bottom.createDiv({ cls: "nb-spark", attr: { "aria-hidden": "true" } });
	const max = Math.max(1, ...o.series);
	for (const v of o.series) {
		const bar = spark.createSpan({ cls: "nb-spark-bar" });
		bar.toggleClass("is-zero", v === 0);
		bar.setCssProps({ "--nb-h": `${Math.max(8, Math.round((v / max) * 100))}%` });
	}
	return tile;
}
