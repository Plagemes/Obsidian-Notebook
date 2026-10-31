import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { lockedSize } from "../ink/selection-transform";
import type { StyleCatalog, StyleChoice } from "../ink/select-similar";
import type { Tool } from "../model/types";
import { modalShell, shellButton, shellCheck, shellField, shellNote, shellRow, shellSection } from "../ui/components/modal-shell";

const TOOL_LABEL: Record<Tool, MessageKey> = {
	pen: "tool.pen",
	highlighter: "tool.highlighter",
	shape: "tool.shape",
};

/**
 * Roadmap 64: the picker of "Select by colour or tool". Lists what is on the page, with how many strokes each choice would
 * select: tools, colours, and tool-and-colour pairs. A tap selects at once and closes the panel.
 */
export class StyleModal extends Modal {
	constructor(app: App, private readonly catalog: StyleCatalog, private readonly onPick: (choice: StyleChoice) => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("select.style.title"), icon: "palette", size: "narrow", footer: false, cls: "notebook-style-panel" });
		const body = shell.body;
		const { tools, colours, combos } = this.catalog;
		if (tools.length === 0 && colours.length === 0) {
			shellNote(body, t("select.style.empty")).addClass("notebook-style-empty");
			return;
		}
		shellNote(body, t("select.style.hint")).addClass("notebook-style-hint");
		this.section(body, t("select.style.tools"), tools.map((x) => ({ label: t(TOOL_LABEL[x.tool]), count: x.count, choice: { tool: x.tool } })));
		this.section(body, t("select.style.colours"), colours.map((x) => ({ label: x.colour.toUpperCase(), colour: x.colour, count: x.count, choice: { colour: x.colour } })));
		// A single pair is the same as its tool and its colour: the section only helps when the page mixes.
		if (combos.length > 1 && (tools.length > 1 || colours.length > 1)) {
			this.section(body, t("select.style.both"), combos.map((x) => ({
				label: `${t(TOOL_LABEL[x.tool])} · ${x.colour.toUpperCase()}`, colour: x.colour, count: x.count, choice: { tool: x.tool, colour: x.colour },
			})));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private section(parent: HTMLElement, title: string, rows: Array<{ label: string; colour?: string; count: number; choice: StyleChoice }>): void {
		if (rows.length === 0) return;
		const list = shellSection(parent, title, "notebook-style-section");
		for (const row of rows) {
			shellRow(list, {
				label: row.label, count: row.count, cls: "notebook-style-row", ...(row.colour ? { dot: row.colour } : {}),
				onClick: () => {
					this.close();
					this.onPick(row.choice);
				},
			});
		}
	}
}

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

/** Parses a typed length: a plain number, with a comma or a point as the decimal mark. */
export function parseLength(text: string): number {
	const n = Number(text.trim().replace(",", "."));
	return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Roadmap 65: the exact size of the selection, width and height in pt (stroke thickness included) with "Keep
 * proportions" on by default: typing one side sets the other. Apply (or Enter) gives the size back; nothing is touched
 * until then.
 */
export class ResizeModal extends Modal {
	private lock = true;

	constructor(
		app: App,
		private readonly current: { width: number; height: number },
		private readonly onApply: (size: { width: number; height: number }) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("resize.title"), subtitle: t("resize.now", { w: fmt(this.current.width), h: fmt(this.current.height) }), icon: "scaling", size: "narrow", cls: "notebook-resize-panel" });
		const body = shell.body;
		const widthInput = this.field(body, "notebook-resize-width", t("resize.width"), this.current.width);
		const heightInput = this.field(body, "notebook-resize-height", t("resize.height"), this.current.height);
		const error = shellNote(body, "", "error");
		error.addClass("notebook-resize-error", "notebook-hidden");

		const box = shellCheck(body, t("resize.lock"), this.lock, (on) => {
			this.lock = on;
			if (on) this.follow(widthInput, heightInput, "width");
		});
		box.parentElement?.addClass("notebook-resize-lock");
		widthInput.addEventListener("input", () => this.follow(widthInput, heightInput, "width"));
		heightInput.addEventListener("input", () => this.follow(widthInput, heightInput, "height"));

		shellNote(body, t("resize.note")).addClass("notebook-resize-note");

		const apply = (): void => {
			const width = parseLength(widthInput.value), height = parseLength(heightInput.value);
			if (!(width > 0) || !(height > 0)) {
				error.setText(t("resize.invalid"));
				error.removeClass("notebook-hidden");
				return;
			}
			this.close();
			this.onApply({ width, height });
		};
		for (const input of [widthInput, heightInput]) {
			input.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" || e.isComposing) return;
				e.preventDefault();
				apply();
			});
		}
		shellButton(shell.foot, "secondary", t("ui.modal.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t("resize.apply"), (e) => {
			e.preventDefault();
			apply();
		});
		widthInput.focus();
		widthInput.select();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private field(parent: HTMLElement, id: string, label: string, value: number): HTMLInputElement {
		const field = shellField(parent, label, id);
		const row = field.createDiv({ cls: "nb-modal-inputrow notebook-resize-row" });
		const input = row.createEl("input", { cls: "nb-modal-input", attr: { id, type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false" } });
		input.value = fmt(value);
		row.createSpan({ cls: "notebook-resize-unit", text: t("resize.unit") });
		return input;
	}

	/** With the lock on, the side that was not typed follows the one that was. */
	private follow(widthInput: HTMLInputElement, heightInput: HTMLInputElement, edited: "width" | "height"): void {
		if (!this.lock) return;
		const typed = parseLength((edited === "width" ? widthInput : heightInput).value);
		if (!(typed > 0)) return;
		const next = lockedSize(this.current, edited, typed);
		if (edited === "width") heightInput.value = fmt(next.height);
		else widthInput.value = fmt(next.width);
	}
}
