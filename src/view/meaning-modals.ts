// 0.22 (#101) Colours with meaning: the dialogs. The legend editor (settings and the notebook's menu) and the "filter by
// meaning" chooser. The legend is plain data; nothing here touches a notebook.
import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import {
	MEANING_LABEL_MAX, MEANING_MAX, cleanMeaningLabel, nearDuplicates, nextFreeColour, parseLegend, withMeaning, withoutMeaning, type Meaning,
} from "../model/colour-meaning";
import { modalShell, shellButton, shellCheck, shellNote, shellRow } from "../ui/components/modal-shell";
import { HIGHLIGHTER_PALETTE, PEN_PALETTE } from "../ui/radial-model";

/** The colours offered as swatches: the pen colours, then the first highlighter ones. */
export const MEANING_SWATCHES: readonly string[] = [...PEN_PALETTE, ...HIGHLIGHTER_PALETTE.slice(0, 8)];

/** The legend a new user can start from: red = definition, blue = example, green = important. */
export function usualMeanings(): Meaning[] {
	return parseLegend([
		{ colour: "#dc2626", label: t("meaning.defaults.definition") },
		{ colour: "#1d4ed8", label: t("meaning.defaults.example") },
		{ colour: "#15803d", label: t("meaning.defaults.important") },
	]);
}

export interface MeaningsEditorHost {
	app: App;
	tolerance(): number;
	globalLegend(): Meaning[];
	setGlobal(legend: Meaning[]): Promise<void>;
	/** Present when opened from a notebook: its own legend, if it has one. */
	notebook?: { title: string; get(): Meaning[] | null; set(legend: Meaning[] | null): Promise<void> };
	/** Runs after every saved change (the view redraws its filter). */
	changed?(): void;
}

/**
 * The legend editor: one row per meaning (label, colour, order, remove). Every change is saved at once. Opened from a notebook it
 * also offers a legend of that notebook only (stored beside the notebooks, see library/meanings.ts); while that is off, the
 * list shows the global legend and cannot be edited here.
 */
export class MeaningsEditorModal extends Modal {
	private list: Meaning[] = [];
	private own = false;
	private rows!: HTMLElement;
	private warn!: HTMLElement;
	private addBtn!: HTMLButtonElement;
	private saving: Promise<void> = Promise.resolve();

	constructor(private readonly host: MeaningsEditorHost) {
		super(host.app);
	}

	onOpen(): void {
		const nb = this.host.notebook;
		const mine = nb?.get() ?? null;
		this.own = mine !== null;
		this.list = (mine ?? this.host.globalLegend()).map((m) => ({ ...m }));
		const shell = modalShell(this, { title: t("meaning.editor.title"), subtitle: nb ? nb.title : t("meaning.editor.subtitle"), icon: "tags", size: "medium", cls: "nb-board-editor nb-meaning-editor" });
		if (nb) {
			shellCheck(shell.body, t("meaning.editor.notebook"), this.own, (on) => {
				this.own = on;
				// Turning it on starts from a copy of the global legend; turning it off shows the global one again (the override is removed).
				this.list = this.host.globalLegend().map((m) => ({ ...m }));
				this.save();
				this.draw();
			});
			shellNote(shell.body, t("meaning.editor.notebook.desc"));
		}
		this.rows = shell.body.createDiv({ cls: "nb-colrows", attr: { role: "list" } });
		this.warn = shell.body.createDiv();
		shellNote(shell.body, t("meaning.editor.note"));
		this.addBtn = shellButton(shell.foot, "secondary", t("meaning.editor.add"), () => {
			this.list = withMeaning(this.list, this.list.length, { colour: nextFreeColour(this.list, MEANING_SWATCHES, this.host.tolerance()), label: this.freshLabel() });
			this.changed();
		}, { icon: "plus" });
		shellButton(shell.foot, "primary", t("meaning.editor.close"), () => this.close());
		this.draw();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** The legend can be edited here (always from settings; from a notebook only with its own legend on). */
	private editable(): boolean {
		return !this.host.notebook || this.own;
	}

	private freshLabel(): string {
		const used = new Set(this.list.map((m) => m.label));
		for (let n = this.list.length + 1; n < 100; n++) {
			const label = `${t("meaning.editor.label")} ${n}`;
			if (!used.has(label)) return label;
		}
		return t("meaning.editor.label");
	}

	/** Saves in order, then redraws. */
	private changed(): void {
		this.save();
		this.draw();
	}

	private save(): void {
		const snapshot = this.list.map((m) => ({ ...m }));
		const own = this.own;
		const nb = this.host.notebook;
		this.saving = this.saving
			.then(() => (nb ? nb.set(own ? snapshot : null) : this.host.setGlobal(snapshot)))
			.then(() => this.host.changed?.())
			.catch((e) => console.error("[notebook] colour meanings not saved", e));
	}

	private draw(): void {
		this.rows.empty();
		this.warn.empty();
		const editable = this.editable();
		this.addBtn.disabled = !editable || this.list.length >= MEANING_MAX;
		if (this.list.length === 0 && editable) {
			shellNote(this.rows, t("meaning.editor.empty"));
			shellButton(this.rows, "secondary", t("meaning.editor.usual"), () => {
				this.list = usualMeanings();
				this.changed();
			}, { icon: "wand-2" });
		}
		if (!editable) shellNote(this.rows, t("meaning.editor.global"));
		this.list.forEach((m, i) => this.row(m, i, editable));
		const dup = nearDuplicates(this.list, this.host.tolerance())[0];
		if (dup && editable) shellNote(this.warn, t("meaning.editor.dup", { a: this.list[dup[0]]!.label, b: this.list[dup[1]]!.label }), "error");
	}

	private row(m: Meaning, i: number, editable: boolean): void {
		const row = this.rows.createDiv({ cls: "nb-colrow", attr: { role: "listitem" } });
		const input = row.createEl("input", {
			cls: "nb-colrow-name",
			attr: { type: "text", maxlength: String(MEANING_LABEL_MAX), placeholder: t("meaning.editor.placeholder"), "aria-label": t("meaning.editor.label"), "data-key": `meaning-label:${i}` },
		});
		input.value = m.label;
		input.disabled = !editable;
		input.addEventListener("change", () => {
			const label = cleanMeaningLabel(input.value);
			if (!label) {
				input.value = m.label;
				return;
			}
			this.list = withMeaning(this.list, i, { colour: m.colour, label });
			this.changed();
		});
		const swatches = row.createDiv({ cls: "nb-colrow-colors", attr: { role: "radiogroup", "aria-label": t("meaning.editor.color") } });
		const palette = MEANING_SWATCHES.map((c) => c.toLowerCase());
		const offered = palette.includes(m.colour) ? palette : [m.colour, ...palette];
		for (const colour of offered) {
			const on = colour === m.colour;
			const s = swatches.createEl("button", { cls: "nb-colrow-swatch", attr: { type: "button", role: "radio", "aria-checked": String(on), "aria-label": colour, "data-colour": colour } });
			s.setCssProps({ "--nb-sw": colour });
			s.toggleClass("is-on", on);
			s.disabled = !editable;
			s.addEventListener("click", () => {
				this.list = withMeaning(this.list, i, { colour, label: m.label });
				this.changed();
			});
		}
		const other = swatches.createEl("input", { cls: "nb-meaning-other", attr: { type: "color", "aria-label": t("meaning.editor.custom"), title: t("meaning.editor.custom"), "data-key": `meaning-colour:${i}` } });
		other.value = m.colour;
		other.disabled = !editable;
		other.addEventListener("change", () => {
			this.list = withMeaning(this.list, i, { colour: other.value, label: m.label });
			this.changed();
		});
		const tools = row.createDiv({ cls: "nb-colrow-tools" });
		const tool = (icon: string, label: string, disabled: boolean, run: () => void) => {
			const b = tools.createEl("button", { cls: "nb-icon-btn", attr: { type: "button", "aria-label": label, title: label } });
			setIcon(b, icon);
			b.disabled = disabled || !editable;
			b.addEventListener("click", run);
		};
		tool("arrow-up", t("meaning.editor.up"), i === 0, () => this.swap(i, i - 1));
		tool("arrow-down", t("meaning.editor.down"), i === this.list.length - 1, () => this.swap(i, i + 1));
		tool("trash-2", t("meaning.editor.remove"), false, () => {
			this.list = withoutMeaning(this.list, i);
			this.changed();
		});
	}

	private swap(a: number, b: number): void {
		const x = this.list[a], y = this.list[b];
		if (!x || !y) return;
		const next = this.list.map((m) => ({ ...m }));
		next[a] = { ...y };
		next[b] = { ...x };
		this.list = next;
		this.changed();
	}
}

export interface MeaningFilterHost {
	app: App;
	legend: readonly Meaning[];
	/** Strokes of each legend entry now in the notebook, and the strokes of no meaning. */
	counts: { perMeaning: readonly number[]; none: number };
	/** The meaning shown now (null: everything). */
	shown: number | null;
	choose(index: number | null): void;
	/** Opens the legend editor (when there is no legend yet). */
	define(): void;
}

/** "Filter by meaning": pick the meaning to show; the rest of the ink is drawn faint (view only). */
export class MeaningFilterModal extends Modal {
	constructor(private readonly host: MeaningFilterHost) {
		super(host.app);
	}

	onOpen(): void {
		const h = this.host;
		const shell = modalShell(this, { title: t("meaning.filter.title"), subtitle: t("meaning.filter.desc"), icon: "filter", size: "narrow", cls: "nb-meaning-filter" });
		if (h.legend.length === 0) {
			shellNote(shell.body, t("meaning.filter.none"));
			shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
			shellButton(shell.foot, "primary", t("meaning.filter.define"), () => {
				this.close();
				h.define();
			}, { icon: "tags" });
			return;
		}
		const list = shell.body.createDiv({ cls: "nb-modal-list", attr: { role: "list" } });
		const all = shellRow(list, { label: t("meaning.filter.all"), onClick: () => this.pick(null), cls: h.shown === null ? "is-current" : "" });
		all.setAttribute("data-key", "meaning-all");
		h.legend.forEach((m, i) => {
			const row = shellRow(list, { label: m.label, detail: t("meaning.filter.count", { n: String(h.counts.perMeaning[i] ?? 0) }), dot: m.colour, onClick: () => this.pick(i), cls: h.shown === i ? "is-current" : "" });
			row.setAttribute("data-key", `meaning-${i}`);
		});
		if (h.counts.none > 0) shellNote(shell.body, t("meaning.filter.other", { n: String(h.counts.none) }));
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
	}

	private pick(index: number | null): void {
		this.close();
		this.host.choose(index);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
