// 0.26 tidy (#238): the sheet of "Tidy up". Three steps with a switch each (straighten the words, line up the starts of the lines,
// close oversized gaps; the last one with "Keep paragraph breaks"), the number of things each one would change right now, and a
// summary of what the whole tidy-up does. Nothing is touched until "Tidy up"; Cancel (or the close button) leaves the page as it is.
// The choices are remembered on this device.
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { normaliseTidyOptions, type TidyOptions } from "../ink/tidy";
import { modalShell, shellButton, shellCheck, shellNote, shellSection } from "../ui/components/modal-shell";

/** Local-storage key of the remembered choices (per device, never in the notebook or the vault). */
export const TIDY_OPTIONS_KEY = "notebook-tidy-options";

/** The remembered choices, or the defaults (corrupt or absent storage is the defaults). */
export function loadTidyOptions(app: Pick<App, "loadLocalStorage">): TidyOptions {
	try {
		const raw: unknown = app.loadLocalStorage(TIDY_OPTIONS_KEY);
		return normaliseTidyOptions(typeof raw === "string" ? (JSON.parse(raw) as unknown) : null);
	} catch {
		return normaliseTidyOptions(null);
	}
}

export function saveTidyOptions(app: Pick<App, "saveLocalStorage">, options: TidyOptions): void {
	try {
		app.saveLocalStorage(TIDY_OPTIONS_KEY, JSON.stringify(options));
	} catch (e) {
		console.error("[notebook] could not remember the tidy-up choices", e);
	}
}

/** What a tidy-up with some choices would do (the sum over the pages it covers). */
export interface TidySummary {
	words: number;
	aligned: number;
	tightened: number;
	/** Height won by closing gaps, pt. */
	saved: number;
	/** Every page it covers is locked. */
	locked: boolean;
}

export const PT_PER_MM = 72 / 25.4;

/** Whether the summary has anything to do. */
export function hasWork(s: TidySummary): boolean {
	return !s.locked && s.words + s.aligned + s.tightened > 0;
}

export interface TidyModalInput {
	/** What is tidied: the strokes of a selection or the whole page. */
	kind: "selection" | "page";
	/** Strokes in the request (the selection's count, shown in the line under the title). */
	strokes: number;
	options: TidyOptions;
	/** What the tidy-up would do with these choices. */
	preview(options: TidyOptions): TidySummary;
	onApply(options: TidyOptions): void;
}

export class TidyModal extends Modal {
	private options: TidyOptions;
	private counts: Partial<Record<"baseline" | "margin" | "gaps", HTMLElement>> = {};
	private summaryEl: HTMLElement | null = null;
	private applyButton: HTMLButtonElement | null = null;
	private keepRow: HTMLElement | null = null;

	constructor(app: App, private readonly input: TidyModalInput) {
		super(app);
		this.options = { ...input.options };
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("tidy.title"), icon: "align-left", size: "narrow", cls: "notebook-tidy-panel" });
		const body = shell.body;
		shellNote(body, this.input.kind === "page" ? t("tidy.scopePage") : t("tidy.scopeSelection", { n: String(this.input.strokes) })).addClass("notebook-tidy-scope");
		const steps = body.createDiv({ cls: "notebook-tidy-steps" });
		this.step(steps, "baseline", t("tidy.step.baseline"));
		this.step(steps, "margin", t("tidy.step.margin"));
		this.step(steps, "gaps", t("tidy.step.gaps"));
		const keep = shellCheck(steps, t("tidy.step.keep"), this.options.keepParagraphs, (on) => {
			this.options.keepParagraphs = on;
			this.refresh();
		});
		this.keepRow = keep.parentElement;
		this.keepRow?.addClass("notebook-tidy-keep");
		shellNote(steps, t("tidy.keepHint")).addClass("notebook-tidy-keep-hint");
		const preview = shellSection(body, t("tidy.preview"), "notebook-tidy-preview");
		this.summaryEl = preview.createDiv({ cls: "notebook-tidy-summary", attr: { "aria-live": "polite" } });
		shellButton(shell.foot, "secondary", t("ui.modal.cancel"), () => this.close());
		this.applyButton = shellButton(shell.foot, "primary", t("tidy.apply"), (e) => {
			e.preventDefault();
			this.apply();
		}, { icon: "align-left" });
		this.refresh();
	}

	onClose(): void {
		// The choices are remembered whether the page was tidied or not.
		saveTidyOptions(this.app, this.options);
		this.contentEl.empty();
	}

	private step(parent: HTMLElement, key: "baseline" | "margin" | "gaps", label: string): void {
		const box = shellCheck(parent, label, this.options[key], (on) => {
			this.options[key] = on;
			this.refresh();
		});
		const row = box.parentElement;
		row?.addClass("notebook-tidy-step", `notebook-tidy-step-${key}`);
		if (row) this.counts[key] = row.createSpan({ cls: "notebook-tidy-count" });
	}

	private refresh(): void {
		const s = this.input.preview(this.options);
		const word = (n: number, key: "tidy.count.words" | "tidy.count.lines" | "tidy.count.gaps"): string => (n > 0 ? t(key, { n: String(n) }) : t("tidy.count.none"));
		this.counts.baseline?.setText(this.options.baseline ? word(s.words, "tidy.count.words") : "");
		this.counts.margin?.setText(this.options.margin ? word(s.aligned, "tidy.count.lines") : "");
		this.counts.gaps?.setText(this.options.gaps ? word(s.tightened, "tidy.count.gaps") : "");
		this.keepRow?.toggleClass("is-off", !this.options.gaps);
		const summary = this.summaryEl;
		if (summary) {
			summary.empty();
			if (s.locked) {
				summary.createDiv({ cls: "notebook-tidy-line is-warn", text: t("tidy.locked") });
			} else if (!hasWork(s)) {
				summary.createDiv({ cls: "notebook-tidy-line", text: t("tidy.none") });
			} else {
				if (s.words > 0) summary.createDiv({ cls: "notebook-tidy-line", text: t("tidy.count.words", { n: String(s.words) }) });
				if (s.aligned > 0) summary.createDiv({ cls: "notebook-tidy-line", text: t("tidy.count.lines", { n: String(s.aligned) }) });
				if (s.tightened > 0) summary.createDiv({ cls: "notebook-tidy-line", text: t("tidy.count.gaps", { n: String(s.tightened) }) });
				if (s.saved > 0) summary.createDiv({ cls: "notebook-tidy-line", text: t("tidy.saves", { mm: String(Math.round(s.saved / PT_PER_MM)) }) });
				summary.createDiv({ cls: "notebook-tidy-line is-quiet", text: t("tidy.undoHint") });
			}
		}
		if (this.applyButton) this.applyButton.disabled = !hasWork(s);
	}

	private apply(): void {
		if (!hasWork(this.input.preview(this.options))) return;
		this.close();
		this.input.onApply({ ...this.options });
	}
}
