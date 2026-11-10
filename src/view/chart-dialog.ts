import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { chartSize, layoutFor, type ChartChoice, type ChartSize } from "../ink/chart";
import { CHART_KINDS, CHART_MAX_SERIES, countNumbers, type ChartData, type ChartKind, type ChartLayout } from "../math/chart-layout";
import { modalShell, shellButton, shellField, shellNote, type ModalShell } from "../ui/components/modal-shell";
import { SUBJECT_COLORS } from "../ui/palette";
import { readNotes } from "./chart-logic";

/**
 * "Chart from table" (0.29, roadmap #244): the type (bars, line, pie), a title, the first colour of the palette and the size. It only asks;
 * the chart is made by view/chart-tools.ts. Built on the modal shell. The picture is the very layout the chart will have (`layoutFor`), drawn
 * small, and a line says what was read from the table; the last choice is remembered for the session.
 */

const KIND_LABEL: Record<ChartKind, MessageKey> = { bar: "chart.kind.bar", line: "chart.kind.line", pie: "chart.kind.pie" };
const SIZES = ["small", "medium", "large"] as const;
const SIZE_LABEL: Record<ChartSize, MessageKey> = { small: "table.size.small", medium: "table.size.medium", large: "table.size.large" };

interface State {
	kind: ChartKind;
	title: string;
	colour: number;
	size: ChartSize;
	trend: boolean;
}

const TREND_LABEL: Record<"off" | "on", MessageKey> = { off: "chart.trend.off", on: "chart.trend.on" };

let last: Omit<State, "title"> = { kind: "bar", colour: 1, size: "medium", trend: false };

class ChartDialog extends Modal {
	private shell!: ModalShell;
	private s: State;
	private preview!: HTMLElement;
	private trendRow!: HTMLElement;
	private notes!: HTMLElement;
	private insertButton!: HTMLButtonElement;
	private answered = false;

	constructor(app: App, private readonly data: ChartData, private readonly finish: (c: ChartChoice | null) => void) {
		super(app);
		this.s = { ...last, title: "" };
	}

	onOpen(): void {
		this.shell = modalShell(this, { title: t("chart.title"), subtitle: t("chart.subtitle"), icon: "bar-chart-3", size: "narrow", cls: "nb-chart-dialog", seed: "chart" });
		const body = this.shell.body;
		this.segmented(body, "chart.kind", CHART_KINDS, KIND_LABEL, () => this.s.kind, (v) => (this.s.kind = v));
		const field = shellField(body, t("chart.titleField"), "nb-chart-title");
		const input = field.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-chart-title", type: "text", maxlength: "80", placeholder: t("chart.titlePlaceholder") } });
		input.addEventListener("input", () => {
			this.s.title = input.value;
			this.draw();
		});
		this.colours(body);
		this.segmented(body, "chart.size", SIZES, SIZE_LABEL, () => this.s.size, (v) => (this.s.size = v));
		// the trend line is for a line chart only; the row is hidden for the other types
		this.trendRow = body.createDiv({ cls: "nb-chart-trend" });
		this.segmented(this.trendRow, "chart.trend", ["off", "on"] as const, TREND_LABEL, () => (this.s.trend ? "on" : "off"), (v) => (this.s.trend = v === "on"));
		this.preview = body.createDiv({ cls: "nb-chart-preview", attr: { role: "img", "aria-label": t("chart.preview") } });
		this.notes = body.createDiv({ cls: "nb-chart-notes" });
		shellButton(this.shell.foot, "secondary", t("transfer.cancel"), () => this.close());
		this.insertButton = shellButton(this.shell.foot, "primary", t("chart.insert"), () => this.submit(), { icon: "bar-chart-3" });
		this.draw();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.finish(null);
	}

	private submit(): void {
		if (countNumbers(this.data, this.s.kind) === 0) return;
		this.answered = true;
		last = { kind: this.s.kind, colour: this.s.colour, size: this.s.size, trend: this.s.trend };
		this.close();
		this.finish({ kind: this.s.kind, title: this.s.title.trim(), colour: this.s.colour, size: this.s.size, trend: this.s.trend && this.s.kind === "line" });
	}

	private segmented<T extends string>(parent: HTMLElement, label: MessageKey, values: readonly T[], names: Record<T, MessageKey>, get: () => T, set: (v: T) => void): void {
		const field = shellField(parent, t(label));
		const seg = field.createDiv({ cls: "nb-segmented nb-chart-seg", attr: { role: "group", "aria-label": t(label) } });
		const buttons: Array<[T, HTMLButtonElement]> = [];
		const paint = (): void => {
			for (const [v, b] of buttons) {
				b.toggleClass("is-active", v === get());
				b.setAttribute("aria-pressed", String(v === get()));
			}
		};
		for (const v of values) {
			const b = seg.createEl("button", { cls: "nb-segment", text: t(names[v]), attr: { type: "button" } });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				set(v);
				paint();
				this.draw();
			});
			buttons.push([v, b]);
		}
		paint();
	}

	private colours(parent: HTMLElement): void {
		const field = shellField(parent, t("chart.colours"));
		const row = field.createDiv({ cls: "nb-chart-colours", attr: { role: "group", "aria-label": t("chart.colours") } });
		const buttons: HTMLButtonElement[] = [];
		const paint = (): void => {
			buttons.forEach((b, i) => {
				b.toggleClass("is-active", i === this.s.colour);
				b.setAttribute("aria-pressed", String(i === this.s.colour));
			});
		};
		SUBJECT_COLORS.forEach((c, i) => {
			const b = row.createEl("button", { cls: "nb-chart-swatch", attr: { type: "button", "aria-label": `${t("chart.colours")} ${c.name}`, title: c.name } });
			b.setCssProps({ "--nb-chart-swatch": c.base });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				this.s.colour = i;
				paint();
				this.draw();
			});
			buttons.push(b);
		});
		paint();
	}

	/** The picture and the lines under it (decoration and information: neither is a control). */
	private draw(): void {
		const size = chartSize(this.s.size, 595);
		const box = { x: 0, y: 0, width: size.width, height: size.height };
		this.trendRow.hidden = this.s.kind !== "line";
		const layout = layoutFor({ kind: this.s.kind, colour: this.s.colour, trend: this.s.trend }, this.data, this.s.title.trim(), box, t("chart.other"));
		this.preview.empty();
		paintLayout(this.preview, layout, box.width, box.height);
		this.notes.empty();
		const numbers = countNumbers(this.data, this.s.kind);
		if (numbers > 0) {
			const rows = String(this.data.labels.length);
			const cols = String(this.s.kind === "pie" ? 1 : this.data.series.length);
			shellNote(this.notes, t("chart.read", { numbers: String(numbers), rows, series: cols }));
		}
		for (const key of readNotes(this.data, this.s.kind)) {
			shellNote(this.notes, t(key, { n: String(key === "chart.read.dropped" ? CHART_MAX_SERIES : this.data.skipped) }), key === "chart.read.none" ? "error" : "note");
		}
		this.insertButton.disabled = numbers === 0;
	}
}

/** A layout as a small SVG in `parent` (a picture of the chart to come, not of the page: the page's own paper stays behind it). */
export function paintLayout(parent: HTMLElement, layout: ChartLayout, width: number, height: number): void {
	const svg = parent.createSvg("svg", { cls: "nb-chart-preview-svg", attr: { viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" } });
	const num = (v: number): string => String(Math.round(v * 100) / 100);
	for (const s of layout.shapes) {
		const common: Record<string, string> = { fill: s.fill ?? "none", stroke: s.color, "stroke-width": num(s.width), "stroke-linejoin": "round", "stroke-linecap": "round" };
		if (s.opacity !== undefined) common["stroke-opacity"] = num(s.opacity);
		if (s.type === "circle") svg.createSvg("circle", { attr: { cx: num(s.cx), cy: num(s.cy), r: num(s.r), ...common } });
		else {
			const points = s.vertices.map((v) => `${num(v[0])},${num(v[1])}`).join(" ");
			svg.createSvg(s.closed ? "polygon" : "polyline", { attr: { points, ...common } });
		}
	}
	for (const tx of layout.texts) {
		const el = svg.createSvg("text", { attr: { x: num(tx.x), y: num(tx.y + tx.size * 0.95), fill: tx.color, "font-size": num(tx.size), "font-family": "sans-serif" } });
		el.textContent = tx.text;
	}
}

/** Asks for a chart of `data`; null when the dialog is closed without inserting. */
export function askChart(app: App, data: ChartData): Promise<ChartChoice | null> {
	return new Promise((resolve) => new ChartDialog(app, data, resolve).open());
}
