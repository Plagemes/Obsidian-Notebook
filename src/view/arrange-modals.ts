import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { lockedSize } from "../ink/selection-transform";
import type { StyleCatalog, StyleChoice } from "../ink/select-similar";
import type { Tool } from "../model/types";

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
		this.modalEl.addClass("notebook-style-panel");
		this.setTitle(t("select.style.title"));
		const body = this.contentEl;
		body.empty();
		const { tools, colours, combos } = this.catalog;
		if (tools.length === 0 && colours.length === 0) {
			body.createDiv({ cls: "notebook-style-empty", text: t("select.style.empty") });
			return;
		}
		body.createDiv({ cls: "notebook-style-hint", text: t("select.style.hint") });
		this.section(t("select.style.tools"), tools.map((x) => ({ label: t(TOOL_LABEL[x.tool]), count: x.count, choice: { tool: x.tool } })));
		this.section(t("select.style.colours"), colours.map((x) => ({ label: x.colour.toUpperCase(), colour: x.colour, count: x.count, choice: { colour: x.colour } })));
		// A single pair is the same as its tool and its colour: the section only helps when the page mixes.
		if (combos.length > 1 && (tools.length > 1 || colours.length > 1)) {
			this.section(t("select.style.both"), combos.map((x) => ({
				label: `${t(TOOL_LABEL[x.tool])} · ${x.colour.toUpperCase()}`, colour: x.colour, count: x.count, choice: { tool: x.tool, colour: x.colour },
			})));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private section(title: string, rows: Array<{ label: string; colour?: string; count: number; choice: StyleChoice }>): void {
		if (rows.length === 0) return;
		const wrap = this.contentEl.createDiv({ cls: "notebook-style-section", attr: { role: "group", "aria-label": title } });
		wrap.createDiv({ cls: "notebook-style-title", text: title });
		for (const row of rows) {
			const b = wrap.createEl("button", { cls: "notebook-style-row", attr: { type: "button" } });
			if (row.colour) b.createSpan({ cls: "notebook-swatch-dot" }).setCssProps({ "--notebook-swatch-color": row.colour });
			b.createSpan({ cls: "notebook-style-label", text: row.label });
			b.createSpan({ cls: "notebook-style-count", text: String(row.count) });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				this.close();
				this.onPick(row.choice);
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
		this.modalEl.addClass("notebook-resize-panel");
		this.setTitle(t("resize.title"));
		const body = this.contentEl;
		body.empty();
		body.createDiv({ cls: "notebook-resize-now", text: t("resize.now", { w: fmt(this.current.width), h: fmt(this.current.height) }) });

		const widthInput = this.field(body, "notebook-resize-width", t("resize.width"), this.current.width);
		const heightInput = this.field(body, "notebook-resize-height", t("resize.height"), this.current.height);
		const error = body.createDiv({ cls: "notebook-resize-error notebook-hidden", attr: { role: "alert" } });

		const keep = body.createEl("label", { cls: "notebook-resize-lock" });
		const box = keep.createEl("input", { attr: { type: "checkbox" } });
		box.checked = this.lock;
		keep.createSpan({ text: t("resize.lock") });
		box.addEventListener("change", () => {
			this.lock = box.checked;
			if (this.lock) this.follow(widthInput, heightInput, "width");
		});
		widthInput.addEventListener("input", () => this.follow(widthInput, heightInput, "width"));
		heightInput.addEventListener("input", () => this.follow(widthInput, heightInput, "height"));

		body.createDiv({ cls: "notebook-resize-note", text: t("resize.note") });

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
		const actions = body.createDiv({ cls: "notebook-resize-actions" });
		const ok = actions.createEl("button", { cls: "mod-cta", text: t("resize.apply"), attr: { type: "button" } });
		ok.addEventListener("click", (e) => {
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
		const row = parent.createDiv({ cls: "notebook-resize-row" });
		row.createEl("label", { text: label, attr: { for: id } });
		const input = row.createEl("input", { attr: { id, type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false" } });
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
