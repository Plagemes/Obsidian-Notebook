import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { TABLE_MAX_COLS, TABLE_MAX_ROWS, type TableSpec, type TableStyle } from "../ink/table";
import { modalShell, shellButton, shellCheck, shellField, type ModalShell } from "../ui/components/modal-shell";
import type { ShapeDash } from "../model/types";

/**
 * "Insert table" (0.28, roadmap #41): rows, columns, cell size and the look of the lines. It only asks; the table is made by
 * view/table-tools.ts. Built on the modal shell. The last choice is remembered for the session, so a second table is one tap.
 */
export interface TableChoice {
	spec: TableSpec;
	style: TableStyle;
}

type CellSize = "small" | "medium" | "large";
type LineWidth = "thin" | "medium" | "thick";
type Dash = "solid" | ShapeDash;

const CELL: Record<CellSize, { w: number; h: number }> = { small: { w: 44, h: 24 }, medium: { w: 70, h: 32 }, large: { w: 100, h: 44 } };
const WIDTH: Record<LineWidth, number> = { thin: 1, medium: 1.6, thick: 2.6 };
const COLOURS = ["#1f2430", "#2563eb", "#dc2626", "#16a34a", "#9333ea"] as const;
const SIZE_LABEL: Record<CellSize, MessageKey> = { small: "table.size.small", medium: "table.size.medium", large: "table.size.large" };
const WIDTH_LABEL: Record<LineWidth, MessageKey> = { thin: "table.width.thin", medium: "table.width.medium", thick: "table.width.thick" };
const DASH_LABEL: Record<Dash, MessageKey> = { solid: "shapeStyle.line.solid", dashed: "shapeStyle.line.dashed", dotted: "shapeStyle.line.dotted" };

interface State {
	rows: number;
	cols: number;
	size: CellSize;
	width: LineWidth;
	dash: Dash;
	colour: string;
	header: boolean;
}

let last: State = { rows: 4, cols: 3, size: "medium", width: "medium", dash: "solid", colour: COLOURS[0], header: true };

/** The choice a state stands for. Pure, for the tests. */
export function choiceOf(s: State): TableChoice {
	const width = WIDTH[s.width];
	const style: TableStyle = { color: s.colour, width };
	if (s.dash !== "solid") style.dash = s.dash;
	if (s.header && s.rows >= 2) style.headerWidth = Math.round(width * 2 * 100) / 100;
	return { spec: { rows: s.rows, cols: s.cols, cellW: CELL[s.size].w, cellH: CELL[s.size].h }, style };
}

class TableDialog extends Modal {
	private shell!: ModalShell;
	private s: State;
	private preview!: HTMLElement;
	private answered = false;

	constructor(app: App, penColour: string, private readonly finish: (c: TableChoice | null) => void) {
		super(app);
		this.s = { ...last };
		if (/^#[0-9a-fA-F]{6}$/.test(penColour) && !COLOURS.some((c) => c === penColour.toLowerCase())) this.extra = penColour.toLowerCase();
	}

	private extra: string | null = null;

	onOpen(): void {
		this.shell = modalShell(this, { title: t("table.title"), subtitle: t("table.subtitle"), icon: "table", size: "narrow", cls: "nb-table-dialog", seed: "table" });
		const body = this.shell.body;
		this.stepper(body, "table.rows", "nb-table-rows", this.s.rows, TABLE_MAX_ROWS, (v) => (this.s.rows = v));
		this.stepper(body, "table.cols", "nb-table-cols", this.s.cols, TABLE_MAX_COLS, (v) => (this.s.cols = v));
		this.segmented(body, "table.size", ["small", "medium", "large"] as const, SIZE_LABEL, () => this.s.size, (v) => (this.s.size = v));
		this.segmented(body, "table.width", ["thin", "medium", "thick"] as const, WIDTH_LABEL, () => this.s.width, (v) => (this.s.width = v));
		this.segmented(body, "table.dash", ["solid", "dashed", "dotted"] as const, DASH_LABEL, () => this.s.dash, (v) => (this.s.dash = v));
		this.colours(body);
		shellCheck(body, t("table.header"), this.s.header, (on) => {
			this.s.header = on;
			this.drawPreview();
		});
		this.preview = body.createDiv({ cls: "nb-table-preview", attr: { "aria-hidden": "true" } });
		this.drawPreview();
		shellButton(this.shell.foot, "secondary", t("transfer.cancel"), () => this.close());
		shellButton(this.shell.foot, "primary", t("table.insert"), () => this.submit(), { icon: "table" });
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.finish(null);
	}

	private submit(): void {
		this.answered = true;
		last = { ...this.s };
		this.close();
		this.finish(choiceOf(this.s));
	}

	private stepper(parent: HTMLElement, label: MessageKey, id: string, value: number, max: number, set: (v: number) => void): void {
		const field = shellField(parent, t(label), id);
		const row = field.createDiv({ cls: "nb-table-stepper" });
		let input: HTMLInputElement | null = null;
		const apply = (v: number): void => {
			const n = Math.min(max, Math.max(1, Math.round(Number.isFinite(v) ? v : 1)));
			if (input) input.value = String(n);
			set(n);
			this.drawPreview();
		};
		const step = (by: number, name: MessageKey, icon: string): void => {
			const b = row.createEl("button", { cls: "nb-table-step", text: icon, attr: { type: "button", "aria-label": `${t(label)}: ${t(name)}` } });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				apply((Number(input?.value) || 1) + by);
			});
		};
		step(-1, "table.less", "−");
		const field2 = row.createEl("input", { cls: "nb-modal-input", attr: { id, type: "number", min: "1", max: String(max), inputmode: "numeric" } });
		input = field2;
		field2.value = String(value);
		field2.addEventListener("change", () => apply(Number(field2.value)));
		step(1, "table.more", "+");
	}

	private segmented<T extends string>(parent: HTMLElement, label: MessageKey, values: readonly T[], names: Record<T, MessageKey>, get: () => T, set: (v: T) => void): void {
		const field = shellField(parent, t(label));
		const seg = field.createDiv({ cls: "nb-segmented nb-table-seg", attr: { role: "group", "aria-label": t(label) } });
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
				this.drawPreview();
			});
			buttons.push([v, b]);
		}
		paint();
	}

	private colours(parent: HTMLElement): void {
		const field = shellField(parent, t("table.colour"));
		const row = field.createDiv({ cls: "nb-table-colours", attr: { role: "group", "aria-label": t("table.colour") } });
		const list = this.extra ? [this.extra, ...COLOURS] : [...COLOURS];
		const buttons: Array<[string, HTMLButtonElement]> = [];
		const paint = (): void => {
			for (const [c, b] of buttons) {
				b.toggleClass("is-active", c === this.s.colour);
				b.setAttribute("aria-pressed", String(c === this.s.colour));
			}
		};
		for (const c of list) {
			const b = row.createEl("button", { cls: "nb-table-swatch", attr: { type: "button", "aria-label": `${t("table.colour")} ${c}`, title: c } });
			b.setCssProps({ "--nb-table-swatch": c });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				this.s.colour = c;
				paint();
				this.drawPreview();
			});
			buttons.push([c, b]);
		}
		if (!list.includes(this.s.colour)) this.s.colour = list[0]!;
		paint();
	}

	/** A small picture of the table to come (decoration: it is not a control). */
	private drawPreview(): void {
		const { spec, style } = choiceOf(this.s);
		this.preview.empty();
		const w = 200, h = 96, pad = 4;
		const k = Math.min((w - 2 * pad) / (spec.cols * spec.cellW), (h - 2 * pad) / (spec.rows * spec.cellH));
		const cw = spec.cellW * k, ch = spec.cellH * k;
		const x0 = (w - cw * spec.cols) / 2, y0 = (h - ch * spec.rows) / 2;
		const svg = this.preview.createSvg("svg", { cls: "nb-table-preview-svg", attr: { viewBox: `0 0 ${w} ${h}` } });
		const line = (x1: number, y1: number, x2: number, y2: number, wd: number): void => {
			const el = svg.createSvg("line", { attr: { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2), stroke: "currentColor", "stroke-width": String(Math.max(0.6, wd * k * 1.4)), "stroke-linecap": "round" } });
			el.setCssProps({ color: style.color });
			if (style.dash) el.setAttribute("stroke-dasharray", style.dash === "dotted" ? "1 3" : "5 3");
		};
		for (let r = 0; r <= spec.rows; r++) line(x0, y0 + r * ch, x0 + cw * spec.cols, y0 + r * ch, r === 1 && style.headerWidth ? style.headerWidth : style.width);
		for (let c = 0; c <= spec.cols; c++) line(x0 + c * cw, y0, x0 + c * cw, y0 + ch * spec.rows, style.width);
	}
}

/** Asks for a table; null when the dialog is closed without inserting. `penColour` is offered as the first colour. */
export function askTable(app: App, penColour: string): Promise<TableChoice | null> {
	return new Promise((resolve) => new TableDialog(app, penColour, resolve).open());
}
