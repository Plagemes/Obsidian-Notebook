// 0.29 (#248) Figure captions and references, the view side: the numbers of the open notebook (kept current, registered so every
// text shown by the renderer and the exports reads them), the caption dialog and the reference picker. Nothing is stored here: a
// caption and a reference are ordinary text boxes (model/figure-captions.ts), the numbers are worked out from the document.
import { Modal, type App } from "obsidian";
import { t } from "../i18n";
import { addFigureLabelSource } from "../ink/figure-text";
import { numberFigures, numberMapOf, type NumberedFigure } from "../model/figure-captions";
import type { Page } from "../model/types";
import { modalShell, shellButton, shellField, shellNote, shellRow } from "../ui/components/modal-shell";

export interface FigureNumbersHost {
	/** The pages as the view shows them. */
	pages(): readonly Page[];
	/** Changes with every edit of the document. */
	tick(): number;
}

/**
 * The captioned figures of one open notebook, in reading order, with their numbers. One instance per notebook view; it adds itself to
 * the registry of `ink/figure-text.ts` so a caption or a reference shows the current number wherever a text box is drawn or exported.
 * The answer is cached: recomputed after `touch()` (the view calls it after every history change), when the edit tick moves or when
 * the page list is another one.
 */
export class FigureNumbers {
	private key = "";
	private pagesRef: readonly Page[] | null = null;
	private dirty = true;
	private list: NumberedFigure[] = [];
	private map: ReadonlyMap<string, number> = new Map();
	private remove: (() => void) | null = null;

	constructor(private readonly host: FigureNumbersHost) {}

	/** Starts answering for the texts shown anywhere (the view is open). */
	register(): void {
		this.remove ??= addFigureLabelSource({ abbr: () => t("figcap.abbr"), number: (id) => this.numberOf(id) });
	}

	/** Stops answering (the view closed). */
	dispose(): void {
		this.remove?.();
		this.remove = null;
	}

	/** The document changed: the numbers are worked out again at the next question. */
	touch(): void {
		this.dirty = true;
	}

	/** Forgets everything (another document was loaded). */
	reset(): void {
		this.dirty = true;
		this.list = [];
		this.map = new Map();
		this.pagesRef = null;
	}

	/** The captioned figures in reading order. */
	items(): readonly NumberedFigure[] {
		this.refresh();
		return this.list;
	}

	numberOf(figureId: string): number | null {
		this.refresh();
		return this.map.get(figureId) ?? null;
	}

	/** The captioned figure with this element id, or null. */
	forFigure(figureId: string): NumberedFigure | null {
		this.refresh();
		return this.list.find((n) => n.figure.elementId === figureId) ?? null;
	}

	private refresh(): void {
		const pages = this.host.pages();
		const key = `${this.host.tick()}|${pages.length}`;
		if (!this.dirty && key === this.key && pages === this.pagesRef) return;
		this.dirty = false;
		this.key = key;
		this.pagesRef = pages;
		this.list = numberFigures(pages);
		this.map = numberMapOf(this.list);
	}
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface CaptionDialogHost {
	/** The number the figure has now (it is captioned already), or null for a figure without a caption. */
	number: number | null;
	/** The words of the caption now. */
	words: string;
	/** Writes the caption (adds it, or replaces its words). */
	save(words: string): void;
}

/** The dialog that asks for the words of a figure's caption. */
export class FigureCaptionModal extends Modal {
	constructor(app: App, private readonly dialog: CaptionDialogHost) {
		super(app);
	}

	onOpen(): void {
		const edit = this.dialog.number !== null;
		const shell = modalShell(this, {
			title: t(edit ? "figcap.dialog.editTitle" : "figcap.dialog.title"), icon: "quote", size: "narrow", cls: "nb-figcap-modal",
			subtitle: t("figcap.dialog.hint"), seed: "notebook-figure-caption",
		});
		const field = shellField(shell.body, t("figcap.dialog.label"), "nb-figcap-words");
		if (this.dialog.number !== null) field.createDiv({ cls: "nb-figcap-number", text: t("figcap.dialog.numbered", { n: String(this.dialog.number) }) });
		const input = field.createEl("input", {
			cls: "nb-modal-input", attr: { id: "nb-figcap-words", type: "text", maxlength: "300", autocomplete: "off", placeholder: t("figcap.dialog.placeholder") },
		});
		input.value = this.dialog.words;
		const submit = (): void => {
			this.close();
			this.dialog.save(input.value);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				submit();
			}
		});
		shellButton(shell.foot, "secondary", t("figcap.dialog.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t(edit ? "figcap.dialog.save" : "figcap.dialog.add"), submit, { icon: edit ? "check" : "plus" });
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface RefPickerHost {
	/** The captioned figures in reading order. */
	items(): readonly NumberedFigure[];
	/** How many references in the notebook show "Fig. ?" now. */
	broken(): number;
	/** Inserts a reference to this figure (element id). */
	insert(figureId: string): void;
}

/** The picker that chooses the figure a new reference points to. */
export class FigureRefModal extends Modal {
	constructor(app: App, private readonly picker: RefPickerHost) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, {
			title: t("figcap.refs.title"), icon: "link", size: "medium", cls: "nb-figcap-modal", subtitle: t("figcap.refs.subtitle"), seed: "notebook-figure-refs",
		});
		const items = this.picker.items();
		if (items.length === 0) shellNote(shell.body, t("figcap.refs.none"));
		const list = shell.body.createDiv({ cls: "nb-figcap-list", attr: { role: "list" } });
		for (const it of items) {
			const row = shellRow(list, {
				label: `${t("figcap.abbr")} ${it.number}${it.caption === "" ? "" : ` ${"—"} ${it.caption}`}`,
				detail: t("figcap.refs.page", { n: String(it.figure.pageIndex + 1) }),
				cls: "nb-figcap-row",
				onClick: () => {
					this.close();
					this.picker.insert(it.figure.elementId);
				},
			});
			row.setAttribute("role", "listitem");
		}
		const broken = this.picker.broken();
		if (broken > 0) shellNote(shell.body, t("figcap.refs.broken", { n: String(broken) }));
		shellButton(shell.foot, "secondary", t("figcap.dialog.cancel"), () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
