/**
 * The dialog of "Copy to notebook…" with a link back (roadmap #186): which pages, which notebook, where in it, and whether the
 * original gets a "Copied to" chip. It only asks; the run is library/copy-with-link.ts. Built on the modal shell and the
 * styles of the transfer dialogs.
 */
import { Modal, setIcon, type App } from "obsidian";
import { t } from "../i18n";
import { modalShell, shellButton, shellCheck, shellField, shellNote, type ModalShell } from "../ui/components/modal-shell";
import { copyBlocker, positionChoices, positionLabel } from "./copy-with-link-logic";
import type { TransferCandidate, TransferPageItem } from "./transfer-dialog";

export interface CopyLinkDialogData {
	notebook: string;
	pages: readonly TransferPageItem[];
	preselected: readonly string[];
	candidates: readonly TransferCandidate[];
	/** Pages of a candidate (read when it is picked). Null: it cannot be read. */
	inspect(path: string): Promise<{ pages: number } | null>;
	/** The "Copied to" chip on the original starts ticked (the setting). */
	reverse: boolean;
}

export interface CopyLinkAnswer {
	pageIds: string[];
	dest: string;
	/** 0-based index in the destination the copies start at. */
	at: number;
	reverse: boolean;
}

class CopyLinkDialog extends Modal {
	private shell!: ModalShell;
	private selected: Set<string>;
	private dest: string | null = null;
	private destPages: number | null = null;
	private reverse: boolean;
	private count!: HTMLElement;
	private info: HTMLElement | null = null;
	private status!: HTMLElement;
	private primary!: HTMLButtonElement;
	private where!: HTMLSelectElement;
	private picks = new Map<string, HTMLElement>();
	private answered = false;

	constructor(app: App, private readonly data: CopyLinkDialogData, private readonly finish: (a: CopyLinkAnswer | null) => void) {
		super(app);
		this.selected = new Set(data.preselected);
		this.reverse = data.reverse;
	}

	onOpen(): void {
		this.shell = modalShell(this, {
			title: t("copylink.title"), subtitle: t("copylink.subtitle", { name: this.data.notebook }), icon: "copy-plus", size: "wide",
			cls: "nb-xfer nb-xfer-copylink", seed: "copy-with-link",
		});
		const body = this.shell.body;
		this.drawPages(body);
		this.drawNotebooks(body);
		const where = shellField(body, t("copylink.where"), "nb-xfer-copy-at");
		this.where = where.createEl("select", { cls: "nb-modal-input nb-xfer-select", attr: { id: "nb-xfer-copy-at" } });
		this.where.disabled = true;
		shellCheck(body, t("copylink.reverse"), this.reverse, (on) => (this.reverse = on));
		shellNote(body, t("copylink.note"));
		this.status = shellNote(body, "");
		this.status.addClass("nb-xfer-status");
		shellButton(this.shell.foot, "secondary", t("transfer.cancel"), () => this.close());
		this.primary = shellButton(this.shell.foot, "primary", t("copylink.cta"), () => this.submit(), { icon: "copy-plus" });
		this.refresh();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.finish(null);
	}

	private drawPages(body: HTMLElement): void {
		const head = shellField(body, t("transfer.extract.pages"));
		const tools = head.createDiv({ cls: "nb-xfer-tools" });
		this.count = tools.createSpan({ cls: "nb-xfer-count" });
		shellButton(tools, "secondary", t("move.selectAll"), () => this.setAll(true));
		shellButton(tools, "secondary", t("move.selectNone"), () => this.setAll(false));
		const list = head.createDiv({ cls: "nb-xfer-pages", attr: { role: "group", "aria-label": t("transfer.extract.pages") } });
		for (const p of this.data.pages) {
			const row = list.createEl("label", { cls: "nb-xfer-page", attr: { "data-page": p.id } });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = this.selected.has(p.id);
			box.addEventListener("change", () => {
				if (box.checked) this.selected.add(p.id);
				else this.selected.delete(p.id);
				this.refresh();
			});
			row.createSpan({ cls: "nb-xfer-page-num", text: t("move.pageLabel", { n: String(p.number) }) });
			if (p.excerpt) row.createSpan({ cls: "nb-xfer-page-excerpt", text: p.excerpt });
		}
	}

	private setAll(on: boolean): void {
		this.selected = on ? new Set(this.data.pages.map((p) => p.id)) : new Set();
		this.shell.body.querySelectorAll<HTMLInputElement>(".nb-xfer-page input").forEach((box) => (box.checked = on));
		this.refresh();
	}

	private drawNotebooks(body: HTMLElement): void {
		const f = shellField(body, t("copylink.which"), "nb-xfer-filter");
		if (this.data.candidates.length === 0) {
			shellNote(f, t("copylink.none"));
			return;
		}
		const filter = f.createEl("input", { cls: "nb-modal-input nb-xfer-filter", attr: { id: "nb-xfer-filter", type: "search", placeholder: t("transfer.merge.search"), "aria-label": t("transfer.merge.search") } });
		const list = f.createDiv({ cls: "nb-xfer-picklist", attr: { role: "listbox", "aria-label": t("copylink.which") } });
		const draw = () => {
			list.empty();
			this.picks.clear();
			const q = filter.value.trim().toLowerCase();
			const shown = this.data.candidates.filter((c) => q === "" || `${c.folder}/${c.label}`.toLowerCase().includes(q));
			if (shown.length === 0) shellNote(list, t("transfer.merge.noMatch"));
			for (const c of shown) {
				const row = list.createEl("button", { cls: "nb-xfer-pick", attr: { type: "button", role: "option", "data-path": c.path, "aria-selected": String(this.dest === c.path) } });
				row.toggleClass("is-on", this.dest === c.path);
				setIcon(row.createSpan({ cls: "nb-xfer-pick-icon", attr: { "aria-hidden": "true" } }), "book");
				const text = row.createSpan({ cls: "nb-xfer-pick-text" });
				text.createSpan({ cls: "nb-xfer-pick-label", text: c.label });
				if (c.folder) text.createSpan({ cls: "nb-xfer-pick-detail", text: c.folder });
				row.addEventListener("click", () => this.pick(c.path));
				this.picks.set(c.path, row);
			}
		};
		filter.addEventListener("input", draw);
		draw();
		this.info = shellNote(f, "");
		this.info.addClass("nb-xfer-info");
	}

	private pick(path: string): void {
		this.dest = path;
		this.destPages = null;
		for (const [p, row] of this.picks) {
			row.toggleClass("is-on", p === path);
			row.setAttribute("aria-selected", String(p === path));
		}
		this.info?.setText(t("transfer.merge.reading"));
		this.fillWhere(0, true);
		this.refresh();
		void this.data.inspect(path).then((r) => {
			if (this.dest !== path) return;
			if (!r) {
				this.dest = null;
				this.info?.setText(t("copylink.unreadable"));
				for (const row of this.picks.values()) {
					row.removeClass("is-on");
					row.setAttribute("aria-selected", "false");
				}
			} else {
				this.destPages = r.pages;
				this.info?.setText(t("copylink.info", { pages: String(r.pages) }));
				this.fillWhere(r.pages, false);
			}
			this.refresh();
		});
	}

	/** The position choices of a destination with `total` pages; the end is chosen at first. */
	private fillWhere(total: number, disabled: boolean): void {
		const select = this.where;
		select.empty();
		for (const at of positionChoices(total)) select.createEl("option", { text: positionLabel(at, total), attr: { value: String(at) } });
		select.value = String(total);
		select.disabled = disabled;
	}

	private refresh(): void {
		this.count.setText(t("transfer.extract.count", { n: String(this.selected.size), total: String(this.data.pages.length) }));
		const why = copyBlocker(this.selected.size, this.dest, this.destPages !== null);
		this.status.setText(why === "no-pages" ? t("transfer.need.pages") : why === "no-notebook" ? t("transfer.need.notebook") : "");
		this.status.toggleClass("is-empty", why === null || why === "reading");
		this.primary.disabled = why !== null;
	}

	private submit(): void {
		if (copyBlocker(this.selected.size, this.dest, this.destPages !== null) !== null || this.dest === null) return;
		const at = Number(this.where.value);
		this.answered = true;
		this.finish({
			pageIds: this.data.pages.filter((p) => this.selected.has(p.id)).map((p) => p.id), dest: this.dest,
			at: Number.isInteger(at) ? at : this.destPages ?? 0, reverse: this.reverse,
		});
		this.close();
	}
}

/** Opens the dialog; resolves to the answer, or null when it was closed without one. */
export function askCopyLink(app: App, data: CopyLinkDialogData): Promise<CopyLinkAnswer | null> {
	return new Promise((resolve) => new CopyLinkDialog(app, data, resolve).open());
}
