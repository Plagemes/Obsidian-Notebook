import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { BOARD_COLUMNS_MAX, columnLabel, COLUMN_NAME_MAX, DEFAULT_BOARD_COLUMNS, newColumnId, nextColumnColor, type BoardColumn } from "../library/board-logic";
import { emitBoardColumnsChanged } from "../library/board-events";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { SUBJECT_COLORS } from "../ui/palette";

/** What the columns editor needs from the plugin: the columns as saved, and a way to save them (validated by `readSettings`). */
export interface BoardColumnsHost {
	app: App;
	get(): BoardColumn[];
	set(columns: BoardColumn[]): Promise<void>;
}

const clone = (c: BoardColumn): BoardColumn => ({ ...c });

/**
 * The Board's columns (0.15): rename, recolour, reorder, add and remove. Every change is saved at once (there is no Save
 * button to forget). Removing a column deletes nothing: its notebooks show in the first column, and a column added back with
 * the same id (Reset to defaults) takes them back.
 */
export class BoardColumnsModal extends Modal {
	private cols: BoardColumn[] = [];
	private list!: HTMLElement;
	private addBtn!: HTMLButtonElement;
	private saving: Promise<void> = Promise.resolve();

	constructor(private readonly host: BoardColumnsHost) {
		super(host.app);
	}

	onOpen(): void {
		this.cols = this.host.get().map(clone);
		const shell = modalShell(this, { title: t("board.editor.title"), subtitle: t("board.editor.subtitle"), icon: "kanban", size: "medium", cls: "nb-board-editor" });
		this.list = shell.body.createDiv({ cls: "nb-colrows", attr: { role: "list" } });
		shellNote(shell.body, t("board.editor.note"));
		shellButton(shell.foot, "secondary", t("board.editor.reset"), () => {
			this.cols = DEFAULT_BOARD_COLUMNS.map(clone);
			this.changed();
		}, { icon: "rotate-ccw" });
		this.addBtn = shellButton(shell.foot, "secondary", t("board.editor.add"), () => {
			this.cols.push({ id: newColumnId(this.cols), name: "", color: nextColumnColor(this.cols) });
			this.changed();
		}, { icon: "plus" });
		shellButton(shell.foot, "primary", t("board.editor.close"), () => this.close());
		this.draw();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Saves (in order) and draws again. */
	private changed(): void {
		const snapshot = this.cols.map(clone);
		this.saving = this.saving.then(() => this.host.set(snapshot)).then(() => emitBoardColumnsChanged()).catch((e) => console.error("[notebook] board columns not saved", e));
		this.draw();
	}

	private draw(): void {
		this.list.empty();
		this.addBtn.disabled = this.cols.length >= BOARD_COLUMNS_MAX;
		this.cols.forEach((col, i) => this.row(col, i));
	}

	private row(col: BoardColumn, i: number): void {
		const row = this.list.createDiv({ cls: "nb-colrow", attr: { role: "listitem" } });
		const name = row.createEl("input", {
			cls: "nb-colrow-name",
			attr: { type: "text", maxlength: String(COLUMN_NAME_MAX), placeholder: columnLabel({ ...col, name: "" }, t), "aria-label": t("board.editor.name"), "data-key": `board-col-name:${i}` },
		});
		name.value = col.name;
		name.addEventListener("change", () => {
			col.name = name.value.trim();
			this.changed();
		});
		const swatches = row.createDiv({ cls: "nb-colrow-colors", attr: { role: "radiogroup", "aria-label": t("board.editor.color") } });
		const palette = SUBJECT_COLORS.map((c) => c.base.toUpperCase());
		for (const color of palette.includes(col.color.toUpperCase()) ? palette : [col.color.toUpperCase(), ...palette]) {
			const on = color === col.color.toUpperCase();
			const s = swatches.createEl("button", { cls: "nb-colrow-swatch", attr: { type: "button", role: "radio", "aria-checked": String(on), "aria-label": color } });
			s.setCssProps({ "--nb-sw": color });
			s.toggleClass("is-on", on);
			s.addEventListener("click", () => {
				col.color = color;
				this.changed();
			});
		}
		const tools = row.createDiv({ cls: "nb-colrow-tools" });
		const tool = (icon: string, label: string, disabled: boolean, run: () => void) => {
			const b = tools.createEl("button", { cls: "nb-icon-btn", attr: { type: "button", "aria-label": label, title: label } });
			setIcon(b, icon);
			b.disabled = disabled;
			b.addEventListener("click", run);
		};
		tool("arrow-up", t("board.editor.up"), i === 0, () => this.swap(i, i - 1));
		tool("arrow-down", t("board.editor.down"), i === this.cols.length - 1, () => this.swap(i, i + 1));
		tool("trash-2", t("board.editor.remove"), this.cols.length <= 1, () => {
			this.cols.splice(i, 1);
			this.changed();
		});
	}

	private swap(a: number, b: number): void {
		const x = this.cols[a];
		const y = this.cols[b];
		if (!x || !y) return;
		this.cols[a] = y;
		this.cols[b] = x;
		this.changed();
	}
}
