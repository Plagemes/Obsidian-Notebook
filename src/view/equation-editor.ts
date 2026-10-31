import { setIcon } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { EQUATION_SNIPPETS, insertSnippet, type EquationSnippet } from "../math/layout";
import { EQUATION_LATEX_MAX } from "../model/math-elements";
import { MAX_FONT_SIZE } from "../model/serialize";
import { renderPreview } from "./math-typeset";
import { shellButton, shellCard } from "../ui/components/modal-shell";

/**
 * The in-place editor of an equation (#110): the LaTeX source, a live preview typeset by Obsidian's maths engine, a
 * palette of structures (fraction, roots, powers, matrix, integral, sum, limit, system, aligned), display or inline
 * style, numbering, size and colour. A floating card next to the equation; the view commits it like a text box
 * (Done, Escape cancels, a tap on the page outside it commits).
 */

export interface EquationDraft {
	latex: string;
	inline: boolean;
	numbered: boolean;
	fontSize: number;
	color: string;
}

export interface EquationEditorHandlers {
	done: (draft: EquationDraft) => void;
	cancel: () => void;
	remove?: () => void;
}

/** Events that must not reach the page under the card (they would start strokes, pans or shortcuts). */
const ISOLATED = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "mousedown", "click", "keydown", "keyup"] as const;

const SNIPPET_LABELS: Record<EquationSnippet, [string, MessageKey]> = {
	fraction: ["a⁄b", "math.eq.snippet.fraction"],
	root: ["√", "math.eq.snippet.root"],
	nthRoot: ["ⁿ√", "math.eq.snippet.nthRoot"],
	power: ["xⁿ", "math.eq.snippet.power"],
	index: ["xₙ", "math.eq.snippet.index"],
	matrix: ["[ ]", "math.eq.snippet.matrix"],
	integral: ["∫", "math.eq.snippet.integral"],
	sum: ["Σ", "math.eq.snippet.sum"],
	limit: ["lim", "math.eq.snippet.limit"],
	system: ["{", "math.eq.snippet.system"],
	aligned: ["=", "math.eq.snippet.aligned"],
};

export class EquationEditor {
	readonly el: HTMLElement;
	private readonly area: HTMLTextAreaElement;
	private readonly preview: HTMLElement;
	private readonly error: HTMLElement;
	private readonly size: HTMLInputElement;
	private readonly color: HTMLInputElement;
	private readonly inlineBtn: HTMLButtonElement;
	private readonly numberedBtn: HTMLButtonElement;
	private draft: EquationDraft;
	private timer: number | null = null;
	private closed = false;
	/** Preview runs are numbered so a slow one cannot overwrite a newer one. */
	private run = 0;

	constructor(parent: HTMLElement, initial: EquationDraft, private readonly handlers: EquationEditorHandlers) {
		this.draft = { ...initial };
		this.el = parent.createDiv({ cls: "notebook-math-panel notebook-eq-editor", attr: { role: "dialog", "aria-label": t("math.eq.title") } });
		shellCard(this.el, "nb-eq-card");
		for (const type of ISOLATED) this.el.addEventListener(type, (e) => e.stopPropagation());
		this.el.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.cancel();
			} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.done();
			}
		});
		const palette = this.el.createDiv({ cls: "notebook-eq-palette", attr: { role: "toolbar", "aria-label": t("math.eq.palette") } });
		for (const key of Object.keys(EQUATION_SNIPPETS) as EquationSnippet[]) {
			const [glyph, label] = SNIPPET_LABELS[key];
			const b = palette.createEl("button", { cls: "notebook-eq-snippet", text: glyph, attr: { type: "button", "aria-label": t(label), title: t(label) } });
			b.addEventListener("click", () => this.insert(EQUATION_SNIPPETS[key]));
		}
		this.area = this.el.createEl("textarea", {
			cls: "notebook-eq-source",
			attr: { "aria-label": t("math.eq.latex"), placeholder: t("math.eq.placeholder"), rows: "3", spellcheck: "false", maxlength: String(EQUATION_LATEX_MAX) },
		});
		this.area.value = initial.latex;
		this.area.addEventListener("input", () => {
			this.draft.latex = this.area.value;
			this.schedulePreview();
		});
		this.preview = this.el.createDiv({ cls: "notebook-eq-preview", attr: { "aria-live": "polite", "aria-label": t("math.eq.preview") } });
		this.error = this.el.createDiv({ cls: "notebook-eq-error notebook-hidden" });
		const options = this.el.createDiv({ cls: "notebook-eq-options" });
		this.inlineBtn = this.toggle(options, "math.eq.inline", () => {
			this.draft.inline = !this.draft.inline;
			this.syncToggles();
			this.schedulePreview();
		});
		this.numberedBtn = this.toggle(options, "math.eq.numbered", () => {
			this.draft.numbered = !this.draft.numbered;
			this.syncToggles();
		});
		const sizeLabel = options.createEl("label", { cls: "notebook-eq-field", text: t("math.eq.size") });
		this.size = sizeLabel.createEl("input", { attr: { type: "number", min: "4", max: String(MAX_FONT_SIZE), step: "0.5", "aria-label": t("math.eq.size") } });
		this.size.value = String(initial.fontSize);
		this.size.addEventListener("change", () => {
			const v = Number(this.size.value);
			if (Number.isFinite(v) && v >= 4 && v <= MAX_FONT_SIZE) this.draft.fontSize = v;
			else this.size.value = String(this.draft.fontSize);
		});
		const colorLabel = options.createEl("label", { cls: "notebook-eq-field", text: t("math.eq.color") });
		this.color = colorLabel.createEl("input", { attr: { type: "color", "aria-label": t("math.eq.color") } });
		this.color.value = initial.color;
		this.color.addEventListener("input", () => {
			if (/^#[0-9a-f]{6}$/i.test(this.color.value)) this.draft.color = this.color.value.toLowerCase();
		});
		const actions = this.el.createDiv({ cls: "notebook-eq-actions" });
		if (handlers.remove) {
			const del = actions.createEl("button", { cls: "nb-modal-btn is-danger is-icon notebook-eq-delete mod-warning", attr: { type: "button", "aria-label": t("math.eq.delete"), title: t("math.eq.delete") } });
			setIcon(del, "trash-2");
			del.addEventListener("click", () => {
				if (this.closed) return;
				this.closed = true;
				this.destroy();
				handlers.remove?.();
			});
		}
		shellButton(actions, "secondary", t("math.eq.cancel"), () => this.cancel());
		shellButton(actions, "primary", t("math.eq.done"), () => this.done());
		this.syncToggles();
		this.schedulePreview(0);
	}

	/** What is in the editor now (for a commit forced by the view: saving, closing). */
	current(): EquationDraft {
		return { ...this.draft, latex: this.area.value };
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Positions the card (stage px) with its top-left corner near (x, y), kept inside the stage. */
	place(x: number, y: number): void {
		const parent = this.el.parentElement;
		const pw = parent?.clientWidth ?? 0;
		const ph = parent?.clientHeight ?? 0;
		const w = this.el.offsetWidth || 320;
		const h = this.el.offsetHeight || 260;
		const left = Math.max(8, Math.min(x, pw - w - 8));
		const top = Math.max(8, Math.min(y, ph - h - 8));
		this.el.setCssProps({ "--notebook-math-x": `${left}px`, "--notebook-math-y": `${top}px` });
	}

	focus(): void {
		this.area.focus({ preventScroll: true });
		const end = this.area.value.length;
		this.area.setSelectionRange(end, end);
	}

	destroy(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.el.remove();
	}

	private toggle(parent: HTMLElement, label: MessageKey, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "notebook-eq-toggle", text: t(label), attr: { type: "button", "aria-pressed": "false" } });
		b.addEventListener("click", onClick);
		return b;
	}

	private syncToggles(): void {
		this.inlineBtn.setAttribute("aria-pressed", String(this.draft.inline));
		this.inlineBtn.toggleClass("is-active", this.draft.inline);
		this.numberedBtn.setAttribute("aria-pressed", String(this.draft.numbered));
		this.numberedBtn.toggleClass("is-active", this.draft.numbered);
		this.numberedBtn.disabled = this.draft.inline;
	}

	private insert(snippet: string): void {
		const r = insertSnippet(this.area.value, this.area.selectionStart, this.area.selectionEnd, snippet);
		this.area.value = r.text;
		this.draft.latex = r.text;
		this.area.focus({ preventScroll: true });
		this.area.setSelectionRange(r.caret, r.caret);
		this.schedulePreview();
	}

	private schedulePreview(delay = 150): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			const run = ++this.run;
			renderPreview(this.preview, this.draft.latex, this.draft.inline).then((err) => {
				if (run !== this.run) return;
				this.error.toggleClass("notebook-hidden", !err);
				this.error.setText(err ? t("math.eq.error", { message: err }) : "");
			}).catch((e) => {
				if (run !== this.run) return;
				console.error("[notebook] equation preview", e);
				this.error.removeClass("notebook-hidden");
				this.error.setText(t("math.eq.noEngine"));
			});
		}, delay);
	}

	private done(): void {
		if (this.closed) return;
		this.closed = true;
		const d = this.current();
		this.destroy();
		this.handlers.done(d);
	}

	private cancel(): void {
		if (this.closed) return;
		this.closed = true;
		this.destroy();
		this.handlers.cancel();
	}
}
