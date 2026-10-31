// The shared shell of every dialog, prompt and floating card of the plugin (DESIGN.md §3 "Creation dialog", §4 "Every other
// surface"; wave 0.13). One header (an icon square, a title, an optional line under it, a close button, and a faint band of
// generated line art behind them), a scrolling body, and a footer with a secondary and a primary button. The creation
// dialog (view/create-dialog.ts) is the model: same tokens, same radii, same button look. Behaviour stays with the dialog;
// the shell only draws the chrome and a few building blocks (field, note, list row, buttons) in the `.nb-ui` scope.
import { setIcon, type Modal } from "obsidian";
import { t } from "../../i18n";
import { applyArt, artRef } from "../art/art-ref";
import { artStyleFor } from "../art/generative-art";
import { decorate, subjectVars } from "./dom";
import { iconSquare } from "./icon-square";
import { shellButtonClasses, shellClasses, shellColour, type ShellButtonKind, type ShellOptions, type ShellSize } from "./modal-shell-model";

export { shellButtonClasses, shellClasses, shellColour };
export type { ShellButtonKind, ShellOptions, ShellSize };

/** The three areas of a dialog; the caller fills `body` and `foot`. */
export interface ModalShell {
	head: HTMLElement;
	body: HTMLElement;
	foot: HTMLElement;
	/** The title element (a dialog that changes its title while open sets its text). */
	title: HTMLElement;
}

const surface = (): "light" | "dark" => (activeDocument.body.hasClass("theme-light") ? "light" : "dark");

/** A button for a shell footer or body. */
export function shellButton(
	parent: HTMLElement, kind: ShellButtonKind, label: string, onClick: (e: MouseEvent) => void, opts: { icon?: string; disabled?: boolean } = {},
): HTMLButtonElement {
	const b = parent.createEl("button", { cls: shellButtonClasses(kind).join(" "), attr: { type: "button" } });
	if (opts.icon) setIcon(b.createSpan({ cls: "nb-modal-btn-icon", attr: { "aria-hidden": "true" } }), opts.icon);
	b.createSpan({ cls: "nb-modal-btn-label", text: label });
	b.disabled = !!opts.disabled;
	b.addEventListener("click", onClick);
	return b;
}

/** Sets the label of a button made by `shellButton`. */
export function setShellButtonLabel(b: HTMLButtonElement, label: string): void {
	const span = b.querySelector(".nb-modal-btn-label");
	if (span) span.textContent = label;
	else b.textContent = label;
}

/**
 * Builds the header: the controls first (icon square, title, close), the art band after them (decoration: a picture that
 * cannot be made is left out and never breaks the header, 0.12.3), then moves the band behind them.
 */
function buildHead(parent: HTMLElement, o: ShellOptions, close: () => void): { head: HTMLElement; title: HTMLElement } {
	const head = parent.createDiv({ cls: "nb-modal-head" });
	const color = shellColour(o);
	if (o.icon) iconSquare(head, o.icon, color, "nb-modal-icon");
	const text = head.createDiv({ cls: "nb-modal-headtext" });
	const title = text.createDiv({ cls: "nb-modal-title", text: o.title, attr: { role: "heading", "aria-level": "2" } });
	if (o.subtitle) text.createDiv({ cls: "nb-modal-subtitle", text: o.subtitle });
	if (o.closeable !== false) {
		const x = head.createEl("button", { cls: "nb-modal-close", attr: { type: "button", "aria-label": t("create.close"), title: t("create.close") } });
		setIcon(x, "x");
		x.addEventListener("click", close);
	}
	if (o.art !== false) {
		decorate(undefined, () => {
			const seed = o.seed ?? o.title;
			const band = createDiv({ cls: "nb-modal-band", attr: { "aria-hidden": "true" } });
			head.prepend(band);
			applyArt(band, artRef("art", { seed, color, style: artStyleFor(seed), density: 0.4, intensity: 0.35, surface: surface() }, 480, 64), { prop: "--nb-modal-band", onNone: () => band.remove() });
		});
	}
	return { head, title };
}

/**
 * Turns an Obsidian `Modal` into a design-system dialog: scopes it under `.nb-ui`, hides Obsidian's own title bar and ×
 * (the shell draws its own header), and returns the header, body and footer to fill. Call it first in `onOpen()`.
 */
export function modalShell(modal: Modal, o: ShellOptions): ModalShell {
	modal.modalEl.addClass(...shellClasses(o.size, o.cls));
	modal.modalEl.setAttribute("aria-label", o.title);
	// Keep Obsidian's title in step (it is hidden by the shell's CSS) so anything that reads it still finds the name.
	modal.setTitle(o.title);
	const root = modal.contentEl;
	root.empty();
	root.addClass("nb-modal-content");
	const { head, title } = buildHead(root, o, () => modal.close());
	const body = root.createDiv({ cls: "nb-modal-body" });
	const foot = root.createDiv({ cls: "nb-modal-foot" });
	if (o.footer === false) foot.addClass("is-empty");
	return { head, body, foot, title };
}

/**
 * The same chrome for a prompt (a SuggestModal): scopes it, hides nothing of Obsidian's input and results, and puts a slim
 * header with an icon and the title above them. Call it in the constructor, after `super()`.
 */
export function promptShell(modal: { modalEl: HTMLElement }, o: Pick<ShellOptions, "title" | "icon" | "color" | "seed" | "art" | "cls">): HTMLElement {
	modal.modalEl.addClass(...shellClasses("wide", `nb-prompt ${o.cls ?? ""}`));
	const { head } = buildHead(modal.modalEl, { ...o, closeable: false }, () => undefined);
	head.addClass("is-prompt");
	// Above Obsidian's input row, whichever of its children came first.
	modal.modalEl.prepend(head);
	return head;
}

/** Marks a floating card (a picker or an editor that sits over the page, not in a modal) as a design-system surface. */
export function shellCard(el: HTMLElement, cls = ""): void {
	el.addClass("nb-ui", "nb-card");
	if (cls) el.addClass(...cls.split(/\s+/).filter(Boolean));
}

/** A labelled field of a shell body: the label above, the control below. Returns the field element. */
export function shellField(parent: HTMLElement, label: string, forId?: string): HTMLElement {
	const f = parent.createDiv({ cls: "nb-modal-field" });
	f.createEl("label", { cls: "nb-modal-label", text: label, attr: forId ? { for: forId } : {} });
	return f;
}

/** A quiet paragraph (muted) or, with `kind: "error"`, an inline problem in the danger colour. */
export function shellNote(parent: HTMLElement, text: string, kind: "note" | "error" = "note"): HTMLElement {
	const el = parent.createDiv({ cls: kind === "error" ? "nb-modal-error" : "nb-modal-note", text });
	if (kind === "error") el.setAttribute("role", "alert");
	return el;
}

export interface ShellRowOptions {
	label: string;
	/** A second line, muted. */
	detail?: string;
	/** A count bubble on the right. */
	count?: number;
	/** A colour dot before the label. */
	dot?: string;
	/** An extra class on the row (hooks kept from before the shell). */
	cls?: string;
	onClick: () => void;
}

/** A tappable list row (label, optional detail and count) for a choice list in a shell body. */
export function shellRow(parent: HTMLElement, o: ShellRowOptions): HTMLButtonElement {
	const b = parent.createEl("button", { cls: `nb-modal-row ${o.cls ?? ""}`.trim(), attr: { type: "button" } });
	if (o.dot) {
		const dot = b.createSpan({ cls: "nb-modal-dot", attr: { "aria-hidden": "true" } });
		subjectVars(dot, o.dot);
	}
	const text = b.createSpan({ cls: "nb-modal-row-text" });
	text.createSpan({ cls: "nb-modal-row-label", text: o.label });
	if (o.detail) text.createSpan({ cls: "nb-modal-row-detail", text: o.detail });
	if (o.count !== undefined) b.createSpan({ cls: "nb-modal-row-count", text: String(o.count) });
	setIcon(b.createSpan({ cls: "nb-modal-row-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
	b.addEventListener("click", (e) => {
		e.preventDefault();
		o.onClick();
	});
	return b;
}

/** A titled group of a shell body (a section label over its content); returns the content element. */
export function shellSection(parent: HTMLElement, title: string, cls = ""): HTMLElement {
	const wrap = parent.createDiv({ cls: `nb-modal-section ${cls}`.trim(), attr: { role: "group", "aria-label": title } });
	wrap.createDiv({ cls: "nb-modal-section-title", text: title });
	return wrap.createDiv({ cls: "nb-modal-list" });
}

/** A labelled checkbox (a real input, a 44 px target) for a shell body. */
export function shellCheck(parent: HTMLElement, label: string, checked: boolean, onChange: (on: boolean) => void): HTMLInputElement {
	const wrap = parent.createEl("label", { cls: "nb-modal-check" });
	const box = wrap.createEl("input", { attr: { type: "checkbox" } });
	box.checked = checked;
	wrap.createSpan({ text: label });
	box.addEventListener("change", () => onChange(box.checked));
	return box;
}

/** A round 40 px icon button for the head or the actions of a floating card (labelled, titled, a real target). */
export function shellIconButton(parent: HTMLElement, icon: string, label: string, cls = ""): HTMLButtonElement {
	const b = parent.createEl("button", { cls: `nb-card-btn ${cls}`.trim(), attr: { type: "button", "aria-label": label, title: label } });
	setIcon(b, icon);
	return b;
}
