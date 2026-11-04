import { Modal, setIcon, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { STICKY_MAX_FONT, STICKY_MIN_FONT, STICKY_TEXT_MAX } from "../model/sticky";
import { modalShell, shellButton, shellField } from "../ui/components/modal-shell";
import { SUBJECT_COLORS } from "../ui/palette";

/** What the editor changes on a note. */
export interface StickyDraft {
	text: string;
	color: string;
	fontSize: number;
}

/** Steps of the text size buttons (pt). */
const FONT_STEP = 2;

/**
 * The editor of a sticky note (0.17): the typed text, the colour among the subject palette and the size of the text. Built on
 * the shared modal shell. Nothing is changed until Done; Cancel (or closing) leaves the note as it is. The note shown behind
 * the dialog is not redrawn while it is open: the choices are previewed on the small sample card inside it.
 */
export class StickyModal extends Modal {
	private draft: StickyDraft;
	private done = false;
	private sample!: HTMLElement;

	constructor(app: App, start: StickyDraft, private readonly onDone: (draft: StickyDraft) => void) {
		super(app);
		this.draft = { ...start };
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("sticky.title"), subtitle: t("sticky.subtitle"), icon: "sticky-note", size: "medium", cls: "nb-sticky-editor" });
		this.sample = shell.body.createDiv({ cls: "nb-sticky-sample", attr: { "aria-hidden": "true" } });
		const textField = shellField(shell.body, t("sticky.text"), "nb-sticky-text");
		const area = textField.createEl("textarea", {
			cls: "nb-modal-input nb-sticky-text",
			attr: { id: "nb-sticky-text", rows: "5", maxlength: String(STICKY_TEXT_MAX), placeholder: t("sticky.textPlaceholder"), "data-key": "sticky-text" },
		});
		area.value = this.draft.text;
		area.addEventListener("input", () => {
			this.draft.text = area.value;
			this.paintSample();
		});

		const colours = shellField(shell.body, t("sticky.colour"));
		const row = colours.createDiv({ cls: "nb-sticky-swatches", attr: { role: "radiogroup", "aria-label": t("sticky.colour") } });
		const palette = SUBJECT_COLORS.map((c) => ({ base: c.base.toUpperCase(), name: c.name }));
		// A colour that is not in the palette (a note made another way) stays available as its own swatch.
		const current = this.draft.color.toUpperCase();
		const choices = palette.some((c) => c.base === current) ? palette : [{ base: current, name: "" }, ...palette];
		for (const c of choices) {
			const label = c.name ? t(`create.colorName.${c.name.toLowerCase()}` as MessageKey) : c.base;
			const b = row.createEl("button", { cls: "nb-sticky-swatch", attr: { type: "button", role: "radio", "aria-label": label, title: label, "data-key": `sticky-colour:${c.base}` } });
			b.setCssProps({ "--nb-sw": c.base });
			b.addEventListener("click", () => {
				this.draft.color = c.base;
				for (const el of Array.from(row.children)) el.setAttribute("aria-checked", String(el === b));
				this.paintSample();
			});
			b.setAttribute("aria-checked", String(c.base === current));
		}

		const sizes = shellField(shell.body, t("sticky.size"));
		const stepper = sizes.createDiv({ cls: "nb-sticky-stepper" });
		const less = stepper.createEl("button", { cls: "nb-icon-btn", attr: { type: "button", "aria-label": t("sticky.size.smaller"), title: t("sticky.size.smaller"), "data-key": "sticky-smaller" } });
		setIcon(less, "minus");
		const value = stepper.createSpan({ cls: "nb-sticky-size", attr: { "aria-live": "polite" } });
		const more = stepper.createEl("button", { cls: "nb-icon-btn", attr: { type: "button", "aria-label": t("sticky.size.larger"), title: t("sticky.size.larger"), "data-key": "sticky-larger" } });
		setIcon(more, "plus");
		const setSize = (v: number) => {
			this.draft.fontSize = Math.min(STICKY_MAX_FONT, Math.max(STICKY_MIN_FONT, v));
			value.textContent = t("sticky.size.value", { n: String(Math.round(this.draft.fontSize)) });
			less.disabled = this.draft.fontSize <= STICKY_MIN_FONT;
			more.disabled = this.draft.fontSize >= STICKY_MAX_FONT;
			this.paintSample();
		};
		less.addEventListener("click", () => setSize(this.draft.fontSize - FONT_STEP));
		more.addEventListener("click", () => setSize(this.draft.fontSize + FONT_STEP));

		shellButton(shell.foot, "secondary", t("sticky.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("sticky.done"), () => {
			this.done = true;
			this.close();
		}, { icon: "check" });
		setSize(this.draft.fontSize);
		window.setTimeout(() => area.focus(), 0);
	}

	/** The sample card: the note's paper colour, the text at the chosen size (one line, cut short). */
	private paintSample(): void {
		const d = this.draft;
		this.sample.setCssProps({ "--nb-sw": d.color, "--nb-sticky-fs": `${Math.min(28, d.fontSize)}px` });
		this.sample.textContent = d.text.trim() === "" ? t("sticky.textPlaceholder") : d.text.trim().slice(0, 140);
		this.sample.toggleClass("is-empty", d.text.trim() === "");
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.done) this.onDone({ ...this.draft });
	}
}
