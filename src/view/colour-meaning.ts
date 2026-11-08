// 0.22 (#101) Colours with meaning, the view side: the "filter by meaning" state, the pill that says it is on (and clears it),
// and the three entry points (legend editor, filter chooser, digest by colour). The filter is view-only: the renderer is told
// which strokes to draw faint and redraws its static layer once; the document is never touched and nothing is saved.
import { setIcon, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import type { Renderer } from "../ink/renderer";
import { MATCH_TOLERANCE, TOLERANCES, effectiveLegend, meaningCounts, strokeDimmer, type Meaning } from "../model/colour-meaning";
import type { Page } from "../model/types";
import type { NotebookSettings } from "../settings";
import type { MeaningsStore } from "../library/meanings-store";
import { MeaningFilterModal, MeaningsEditorModal } from "./meaning-modals";
import { MeaningDigestModal, meaningDigestCounts, runMeaningDigest } from "./meaning-digest";
import type { PageImageOptions } from "./page-images";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";

/** What the tools need from the notebook view. */
export interface MeaningToolsHost {
	app: App;
	body: HTMLElement;
	settings(): NotebookSettings;
	/** Saves the global legend (the plugin settings). */
	setGlobal(legend: Meaning[]): Promise<void>;
	store(): MeaningsStore | null;
	/** The id of the notebook in view, or null when none is loaded. */
	docId(): string | null;
	file(): TFile | null;
	renderer(): Renderer | null;
	/** The pages as the view shows them (the live views of pages with states). */
	pages(): readonly Page[];
	/**
	 * Review fix (0.26 #285, P6): the pages the digest writes, with the redaction boxes applied; null (after a notice) when nothing may be
	 * written. Absent: `pages()`.
	 */
	digestPages?(): readonly Page[] | null;
	media(): NotebookMedia | null;
	render(): { render: PageImageOptions; prepare?: (pages: readonly Page[]) => Promise<void> };
}

export class MeaningTools {
	private shown: number | null = null;
	private pill: HTMLElement | null = null;
	private pillText: HTMLElement | null = null;
	private stop: (() => void) | null = null;

	constructor(private readonly host: MeaningToolsHost) {
		const pill = host.body.createDiv({ cls: "nb-ui nb-meaning-pill", attr: { role: "status", "aria-live": "polite" } });
		setIcon(pill.createSpan({ cls: "nb-meaning-pill-icon", attr: { "aria-hidden": "true" } }), "filter");
		this.pillText = pill.createSpan({ cls: "nb-meaning-pill-text" });
		const clear = pill.createEl("button", { cls: "nb-meaning-pill-clear", attr: { type: "button", "aria-label": t("meaning.filter.clear"), title: t("meaning.filter.clear") } });
		setIcon(clear, "x");
		for (const type of ["pointerdown", "pointerup", "touchstart", "wheel", "contextmenu", "mousedown"] as const) pill.addEventListener(type, (e) => e.stopPropagation());
		clear.addEventListener("click", (e) => {
			e.preventDefault();
			this.choose(null);
		});
		pill.hide();
		this.pill = pill;
		this.stop = host.store()?.onChange(() => this.refresh()) ?? null;
	}

	destroy(): void {
		this.stop?.();
		this.stop = null;
		this.host.renderer()?.setInkDim(null);
		this.pill?.remove();
		this.pill = null;
		this.pillText = null;
	}

	/** The legend in force for the notebook in view: its own when it has one, else the global one. */
	legend(): readonly Meaning[] {
		const id = this.host.docId();
		const own = id ? this.host.store()?.get(id) ?? null : null;
		return effectiveLegend(this.host.settings().colourMeanings, own);
	}

	private tolerance(): number {
		return TOLERANCES[this.host.settings().meaningTolerance] ?? MATCH_TOLERANCE;
	}

	/** The meaning shown now (an index of `legend()`), or null for everything. */
	current(): number | null {
		return this.shown;
	}

	/** A different notebook was loaded: the filter does not carry over. */
	reset(): void {
		this.shown = null;
		this.apply();
	}

	/** The legend or the matching changed: keep the filter only while its meaning still exists. */
	refresh(): void {
		if (this.shown !== null && this.shown >= this.legend().length) this.shown = null;
		this.apply();
	}

	choose(index: number | null): void {
		this.shown = index !== null && index >= 0 && index < this.legend().length ? index : null;
		this.apply();
	}

	private apply(): void {
		const legend = this.legend();
		this.host.renderer()?.setInkDim(strokeDimmer(legend, this.shown, this.tolerance()));
		const m = this.shown !== null ? legend[this.shown] : undefined;
		if (!this.pill || !this.pillText) return;
		if (m) {
			this.pillText.setText(t("meaning.filter.pill", { label: m.label }));
			this.pill.setCssProps({ "--nb-sw": m.colour });
			this.pill.show();
		} else this.pill.hide();
	}

	openLegend(globalOnly = false): void {
		const h = this.host;
		const id = h.docId();
		const store = h.store();
		new MeaningsEditorModal({
			app: h.app,
			tolerance: () => this.tolerance(),
			globalLegend: () => h.settings().colourMeanings,
			setGlobal: (legend) => h.setGlobal(legend),
			...(id && store && !globalOnly ? { notebook: { title: h.file()?.basename ?? "", get: () => store.get(id), set: (legend: Meaning[] | null) => store.set(id, legend) } } : {}),
			changed: () => this.refresh(),
		}).open();
	}

	openFilter(): void {
		const legend = this.legend();
		new MeaningFilterModal({
			app: this.host.app, legend, counts: meaningCounts(this.host.pages(), legend, this.tolerance()), shown: this.shown,
			choose: (index) => this.choose(index),
			define: () => this.openLegend(true),
		}).open();
	}

	openDigest(): void {
		const h = this.host;
		const file = h.file();
		const legend = this.legend();
		if (!file) return;
		if (legend.length === 0) {
			showNotice(t("meaning.filter.none"), 6000);
			return;
		}
		const chosen = h.digestPages ? h.digestPages() : h.pages();
		if (!chosen) return;
		const pages = [...chosen];
		const tolerance = this.tolerance();
		if (meaningDigestCounts(pages, legend, tolerance).regions === 0) {
			showNotice(t("meaning.digest.none"), 6000);
			return;
		}
		new MeaningDigestModal({
			app: h.app, file, pages, legend, tolerance,
			run: (request) => {
				const options = h.render();
				void runMeaningDigest({ app: h.app, file, pages, legend, tolerance, media: h.media(), render: options.render, ...(options.prepare ? { prepare: options.prepare } : {}) }, request);
			},
		}).open();
	}
}
