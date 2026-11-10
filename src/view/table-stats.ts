import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { showNotice } from "./notice";
import { modalShell, shellButton, shellField, shellNote, type ModalShell } from "../ui/components/modal-shell";
import {
	lineText, modelOf, regressionRows, reportOf, reportText, summaryRows, type ReportWords, type TableStatsModel,
} from "../ink/table-report";

/**
 * The statistics card of a selected table (0.29, roadmap #295): the numbers of one column (count, mean, median, deviation, extremes) and,
 * with a second column chosen, the least-squares line. "Insert as text" and "Copy" hand the text out; this file only shows and asks. The
 * numbers come from the text boxes written in the cells (ink/table-numbers.ts), never from handwriting.
 */
export interface StatsCardOptions {
	cells: string[][];
	cols: number;
	/** Called with the report text when "Insert as text" is pressed; true when the text box was added. */
	insert(text: string): boolean;
}

export const reportWords = (): ReportWords => ({
	column: (name, i) => (name !== "" ? name : t("tableStats.colN", { n: String(i + 1) })),
	title: (col) => t("tableStats.reportTitle", { col }),
	count: (n, skipped) => (skipped > 0 ? t("tableStats.countSkipped", { n: String(n), skipped: String(skipped) }) : t("tableStats.count", { n: String(n) })),
	mean: t("tableStats.mean"),
	median: t("tableStats.median"),
	sd: t("tableStats.sd"),
	min: t("tableStats.min"),
	max: t("tableStats.max"),
	sum: t("tableStats.sum"),
	regressionTitle: (y, x) => t("tableStats.regTitle", { y, x }),
	line: t("tableStats.line"),
	notEnough: t("tableStats.notEnough"),
	noNumbers: t("tableStats.noNumbers"),
});

export const regressionLabels = (): { slope: string; intercept: string; r2: string } => ({
	slope: t("tableStats.slope"),
	intercept: t("tableStats.intercept"),
	r2: t("tableStats.r2"),
});

class TableStatsCard extends Modal {
	private shell!: ModalShell;
	private readonly model: TableStatsModel;
	private column: number;
	private against: number | null = null;
	private results!: HTMLElement;

	constructor(app: App, private readonly o: StatsCardOptions) {
		super(app);
		this.model = modelOf(o.cells, o.cols);
		this.column = this.model.numeric[0] ?? 0;
	}

	onOpen(): void {
		this.shell = modalShell(this, { title: t("tableStats.title"), subtitle: t("tableStats.subtitle"), icon: "sigma", size: "narrow", cls: "nb-table-stats", seed: "table-stats" });
		const body = this.shell.body;
		if (this.model.numeric.length === 0) {
			shellNote(body, t("tableStats.nothing"));
			shellButton(this.shell.foot, "secondary", t("tableStats.close"), () => this.close());
			return;
		}
		this.picker(body, "tableStats.column", "nb-stats-column", false);
		this.picker(body, "tableStats.against", "nb-stats-against", true);
		this.results = body.createDiv({ cls: "nb-stats-results", attr: { "aria-live": "polite" } });
		this.draw();
		shellButton(this.shell.foot, "secondary", t("tableStats.close"), () => this.close());
		shellButton(this.shell.foot, "secondary", t("tableStats.copy"), () => void this.copy(), { icon: "copy" });
		shellButton(this.shell.foot, "primary", t("tableStats.insert"), () => this.insert(), { icon: "text" });
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private colName(c: number): string {
		return reportWords().column(this.model.names[c] ?? "", c);
	}

	private picker(parent: HTMLElement, label: Parameters<typeof t>[0], id: string, optional: boolean): void {
		const field = shellField(parent, t(label), id);
		const select = field.createEl("select", { cls: "dropdown nb-modal-input", attr: { id } });
		if (optional) select.createEl("option", { text: t("tableStats.none"), attr: { value: "-1" } });
		for (const c of this.model.numeric) select.createEl("option", { text: this.colName(c), attr: { value: String(c) } });
		select.value = optional ? "-1" : String(this.column);
		select.addEventListener("change", () => {
			const v = Number(select.value);
			if (optional) this.against = v < 0 ? null : v;
			else this.column = v;
			this.draw();
		});
	}

	private draw(): void {
		const r = reportOf(this.model, this.column, this.against);
		const w = reportWords();
		this.results.empty();
		const table = (title: string, rows: Array<[string, string]>): void => {
			this.results.createDiv({ cls: "nb-stats-heading", text: title });
			const list = this.results.createEl("dl", { cls: "nb-stats-list" });
			for (const [k, v] of rows) {
				if (v === "") {
					list.createEl("dt", { cls: "nb-stats-count", text: k });
					list.createEl("dd", { cls: "nb-stats-count" });
				} else {
					list.createEl("dt", { text: k });
					list.createEl("dd", { text: v });
				}
			}
		};
		if (r.summary) table(w.title(this.colName(this.column)), summaryRows(r, w));
		else shellNote(this.results, w.noNumbers);
		if (r.against !== null) {
			if (!r.regression) shellNote(this.results, w.notEnough);
			else {
				this.results.createDiv({ cls: "nb-stats-heading", text: w.regressionTitle(this.colName(r.against), this.colName(this.column)) });
				this.results.createDiv({ cls: "nb-stats-line", text: lineText(r.regression) });
				const rows = regressionRows(r, regressionLabels());
				const list = this.results.createEl("dl", { cls: "nb-stats-list" });
				for (const [k, v] of rows) {
					list.createEl("dt", { text: k });
					list.createEl("dd", { text: v });
				}
				if (r.regression.skipped > 0) shellNote(this.results, w.count(r.regression.count, r.regression.skipped));
			}
		}
	}

	private text(): string {
		return reportText(this.model, reportOf(this.model, this.column, this.against), reportWords(), regressionLabels());
	}

	private async copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.text());
			showNotice(t("tableStats.copied"), 2200);
		} catch {
			showNotice(t("tableStats.copyFailed"), 2200);
		}
	}

	private insert(): void {
		if (this.o.insert(this.text())) this.close();
	}
}

/** Opens the statistics card for the cells of a table. */
export function openTableStats(app: App, o: StatsCardOptions): void {
	new TableStatsCard(app, o).open();
}
