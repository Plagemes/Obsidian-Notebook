/**
 * The dialog of "Merge a notebook into this one…", "Split at a page…" and "Extract pages…" (roadmap #77). One dialog on the
 * modal shell with three bodies; it only asks and answers — the run is library/page-transfer.ts. Whatever takes pages out of a
 * notebook says so on its button (the danger look) and in a sentence, and locked pages need their own tick.
 */
import { setIcon, Modal, type App } from "obsidian";
import { t } from "../i18n";
import { chip } from "../ui/components/chip";
import { modalShell, shellButton, shellCheck, shellField, shellNote, setShellButtonLabel, type ModalShell } from "../ui/components/modal-shell";
import {
	blocker, lockedToLeave, splitCounts, splitPossible, type Blocker, type TransferKind, type TransferPageItem, type TransferState,
} from "./transfer-logic";

export type { TransferKind, TransferPageItem };

/** A notebook that can be added to the one in view. */
export interface TransferCandidate {
	path: string;
	/** File name without extension. */
	label: string;
	/** Its folder, shown beside the name. */
	folder: string;
}

export interface TransferDialogData {
	kind: TransferKind;
	/** Name of the notebook the dialog is about. */
	notebook: string;
	pages: readonly TransferPageItem[];
	/** merge: the notebooks that can be added. */
	candidates?: readonly TransferCandidate[];
	/** merge: how many pages and locked pages a candidate has (read when it is picked). Null: it cannot be read. */
	inspect?(path: string): Promise<{ pages: number; locked: number } | null>;
	/** merge: moving the added notebook to the trash is offered. */
	canTrash?: boolean;
	/** extract: ticked at first. */
	preselected?: readonly string[];
	/** split: 0-based index of the first page of the new notebook at first. */
	splitAt?: number;
	/** Suggested name of the new notebook. */
	defaultName?: string;
}

export type TransferAnswer =
	| { kind: "merge"; other: string; after: number | null; trashOther: boolean; allowLocked: boolean }
	| { kind: "split"; at: number; name: string; allowLocked: boolean }
	| { kind: "extract"; pageIds: string[]; mode: "copy" | "move"; name: string; allowLocked: boolean };

const BLOCKER_TEXT: Record<Blocker, Parameters<typeof t>[0] | null> = {
	"no-notebook": "transfer.need.notebook",
	"no-pages": "transfer.need.pages",
	"bad-split": "transfer.need.split",
	"no-name": "transfer.need.name",
	"unconfirmed-locked": null,
	reading: null,
};

const ICON: Record<TransferKind, string> = { merge: "git-merge", split: "scissors", extract: "file-output" };

export class TransferDialog extends Modal {
	private readonly st: TransferState;
	private shell!: ModalShell;
	private primary!: HTMLButtonElement;
	private status!: HTMLElement;
	private summary: HTMLElement | null = null;
	private lockedRow: HTMLElement | null = null;
	private lockedNote: HTMLElement | null = null;
	private lockedBox: HTMLInputElement | null = null;
	private otherInfo: HTMLElement | null = null;
	private count: HTMLElement | null = null;
	private afterSelect: HTMLSelectElement | null = null;
	private modeNote: HTMLElement | null = null;
	private list: HTMLElement | null = null;
	private picks = new Map<string, HTMLElement>();
	private answered = false;

	constructor(app: App, private readonly info: TransferDialogData, private readonly finish: (answer: TransferAnswer | null) => void) {
		super(app);
		const first = Math.min(Math.max(info.splitAt ?? Math.ceil(info.pages.length / 2), 1), Math.max(info.pages.length - 1, 1));
		this.st = {
			kind: info.kind, pages: info.pages, selected: new Set(info.preselected ?? []), extractMode: "copy",
			splitAt: first, other: null, trashOther: false, name: info.defaultName ?? "", confirmedLocked: false,
		};
	}

	onOpen(): void {
		const { kind } = this.info;
		this.shell = modalShell(this, {
			title: t(`transfer.${kind}.title`), subtitle: t(`transfer.${kind}.subtitle`, { name: this.info.notebook }),
			icon: ICON[kind], size: "wide", cls: `nb-xfer nb-xfer-${kind}`, seed: `transfer-${kind}`,
		});
		const body = this.shell.body;
		if (kind === "merge") this.drawMerge(body);
		else if (kind === "split") this.drawSplit(body);
		else this.drawExtract(body);
		this.drawLocked(body);
		this.status = shellNote(body, "");
		this.status.addClass("nb-xfer-status");
		shellButton(this.shell.foot, "secondary", t("transfer.cancel"), () => this.close());
		this.primary = shellButton(this.shell.foot, "primary", "", () => this.submit(), { icon: ICON[kind] });
		this.refresh();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.finish(null);
	}

	// ---------------------------------------------------------------------------------------------------------- merge

	private drawMerge(body: HTMLElement): void {
		const candidates = this.info.candidates ?? [];
		const f = shellField(body, t("transfer.merge.which"), "nb-xfer-filter");
		if (candidates.length === 0) {
			shellNote(f, t("transfer.merge.none"));
			return;
		}
		const filter = f.createEl("input", { cls: "nb-modal-input nb-xfer-filter", attr: { id: "nb-xfer-filter", type: "search", placeholder: t("transfer.merge.search"), "aria-label": t("transfer.merge.search") } });
		this.list = f.createDiv({ cls: "nb-xfer-picklist", attr: { role: "listbox", "aria-label": t("transfer.merge.which") } });
		const draw = () => {
			const list = this.list!;
			list.empty();
			this.picks.clear();
			const q = filter.value.trim().toLowerCase();
			const shown = candidates.filter((c) => q === "" || `${c.folder}/${c.label}`.toLowerCase().includes(q));
			if (shown.length === 0) shellNote(list, t("transfer.merge.noMatch"));
			for (const c of shown) {
				const row = list.createEl("button", { cls: "nb-xfer-pick", attr: { type: "button", role: "option", "data-path": c.path, "aria-selected": String(this.st.other?.path === c.path) } });
				row.toggleClass("is-on", this.st.other?.path === c.path);
				setIcon(row.createSpan({ cls: "nb-xfer-pick-icon", attr: { "aria-hidden": "true" } }), "book");
				const text = row.createSpan({ cls: "nb-xfer-pick-text" });
				text.createSpan({ cls: "nb-xfer-pick-label", text: c.label });
				if (c.folder) text.createSpan({ cls: "nb-xfer-pick-detail", text: c.folder });
				row.addEventListener("click", () => this.pickOther(c.path));
				this.picks.set(c.path, row);
			}
		};
		filter.addEventListener("input", draw);
		draw();
		this.otherInfo = shellNote(f, "");
		this.otherInfo.addClass("nb-xfer-info");

		const where = shellField(body, t("transfer.merge.where"), "nb-xfer-after");
		const select = where.createEl("select", { cls: "nb-modal-input nb-xfer-select", attr: { id: "nb-xfer-after" } });
		this.afterSelect = select;
		select.createEl("option", { text: t("transfer.merge.atEnd"), attr: { value: "-1" } });
		for (const p of this.info.pages) {
			select.createEl("option", { text: t("transfer.afterPage", { n: String(p.number), excerpt: p.excerpt ? ` — ${p.excerpt}` : "" }), attr: { value: String(p.number - 1) } });
		}
		select.addEventListener("change", () => this.refresh());

		if (this.info.canTrash) {
			const check = shellCheck(body, t("transfer.merge.trash"), false, (on) => {
				this.st.trashOther = on;
				this.refresh();
			});
			check.closest("label")?.addClass("nb-xfer-trashcheck");
			this.modeNote = shellNote(body, "");
		}
		this.summary = shellNote(body, "");
		this.summary.addClass("nb-xfer-summary");
	}

	private pickOther(path: string): void {
		this.st.other = { path, locked: null };
		this.st.confirmedLocked = false;
		for (const [p, row] of this.picks) {
			row.toggleClass("is-on", p === path);
			row.setAttribute("aria-selected", String(p === path));
		}
		this.otherInfo?.setText(t("transfer.merge.reading"));
		this.refresh();
		void this.info.inspect?.(path).then((r) => {
			if (this.st.other?.path !== path) return;
			if (!r) {
				this.st.other = null;
				this.otherInfo?.setText(t("transfer.merge.unreadable"));
			} else {
				this.st.other = { path, locked: r.locked };
				this.otherInfo?.setText(t(r.locked > 0 ? "transfer.merge.infoLocked" : "transfer.merge.info", { pages: String(r.pages), locked: String(r.locked) }));
			}
			this.refresh();
		});
	}

	// ---------------------------------------------------------------------------------------------------------- split

	private drawSplit(body: HTMLElement): void {
		const pages = this.info.pages;
		if (pages.length < 2) {
			shellNote(body, t("transfer.split.tooShort"));
			return;
		}
		const f = shellField(body, t("transfer.split.at"), "nb-xfer-at");
		const select = f.createEl("select", { cls: "nb-modal-input nb-xfer-select", attr: { id: "nb-xfer-at" } });
		for (const p of pages.slice(1)) {
			const opt = select.createEl("option", { text: t("transfer.startsAt", { n: String(p.number), excerpt: p.excerpt ? ` — ${p.excerpt}` : "" }), attr: { value: String(p.number - 1) } });
			opt.selected = p.number - 1 === this.st.splitAt;
		}
		select.addEventListener("change", () => {
			this.st.splitAt = Number(select.value);
			this.st.confirmedLocked = false;
			if (this.lockedBox) this.lockedBox.checked = false;
			this.refresh();
		});
		this.drawName(body);
		this.summary = shellNote(body, "");
		this.summary.addClass("nb-xfer-summary");
	}

	// -------------------------------------------------------------------------------------------------------- extract

	private drawExtract(body: HTMLElement): void {
		const pages = this.info.pages;
		const head = shellField(body, t("transfer.extract.pages"));
		const tools = head.createDiv({ cls: "nb-xfer-tools" });
		this.count = tools.createSpan({ cls: "nb-xfer-count" });
		shellButton(tools, "secondary", t("move.selectAll"), () => this.setAll(true));
		shellButton(tools, "secondary", t("move.selectNone"), () => this.setAll(false));
		const list = head.createDiv({ cls: "nb-xfer-pages", attr: { role: "group", "aria-label": t("transfer.extract.pages") } });
		for (const p of pages) {
			const row = list.createEl("label", { cls: "nb-xfer-page", attr: { "data-page": p.id } });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = this.st.selected.has(p.id);
			box.addEventListener("change", () => {
				const next = new Set(this.st.selected);
				if (box.checked) next.add(p.id);
				else next.delete(p.id);
				this.st.selected = next;
				this.st.confirmedLocked = false;
				if (this.lockedBox) this.lockedBox.checked = false;
				this.refresh();
			});
			row.createSpan({ cls: "nb-xfer-page-num", text: t("move.pageLabel", { n: String(p.number) }) });
			if (p.excerpt) row.createSpan({ cls: "nb-xfer-page-excerpt", text: p.excerpt });
			if (p.locked) setIcon(row.createSpan({ cls: "nb-xfer-page-lock", attr: { "aria-label": t("transfer.locked"), title: t("transfer.locked") } }), "lock");
		}
		const mode = shellField(body, t("transfer.extract.mode"));
		const row = mode.createDiv({ cls: "nb-chips", attr: { role: "radiogroup", "aria-label": t("transfer.extract.mode") } });
		const modes = [{ id: "copy" as const, label: t("transfer.extract.copy"), icon: "copy" }, { id: "move" as const, label: t("transfer.extract.move"), icon: "scissors" }];
		const draw = () => {
			row.empty();
			for (const m of modes) {
				const c = chip(row, { label: m.label, icon: m.icon, active: this.st.extractMode === m.id, key: `mode:${m.id}`, onClick: () => {
					this.st.extractMode = m.id;
					this.st.confirmedLocked = false;
					if (this.lockedBox) this.lockedBox.checked = false;
					draw();
					this.refresh();
				} });
				c.setAttribute("role", "radio");
				c.setAttribute("aria-checked", String(this.st.extractMode === m.id));
			}
		};
		draw();
		this.modeNote = shellNote(mode, "");
		this.drawName(body);
	}

	private setAll(on: boolean): void {
		this.st.selected = on ? new Set(this.info.pages.map((p) => p.id)) : new Set();
		this.st.confirmedLocked = false;
		if (this.lockedBox) this.lockedBox.checked = false;
		this.shell.body.querySelectorAll<HTMLInputElement>(".nb-xfer-page input").forEach((box) => (box.checked = on));
		this.refresh();
	}

	// ------------------------------------------------------------------------------------------------------- shared

	private drawName(body: HTMLElement): void {
		const f = shellField(body, t("transfer.name"), "nb-xfer-name");
		const input = f.createEl("input", { cls: "nb-modal-input nb-xfer-name", attr: { id: "nb-xfer-name", type: "text", maxlength: "120", placeholder: t("transfer.name.placeholder") } });
		input.value = this.st.name;
		input.addEventListener("input", () => {
			this.st.name = input.value;
			this.refresh();
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
	}

	private drawLocked(body: HTMLElement): void {
		this.lockedRow = body.createDiv({ cls: "nb-xfer-locked" });
		this.lockedNote = shellNote(this.lockedRow, "");
		this.lockedBox = shellCheck(this.lockedRow, t("transfer.locked.confirm"), false, (on) => {
			this.st.confirmedLocked = on;
			this.refresh();
		});
	}

	private afterIndex(): number | null {
		const v = Number(this.afterSelect?.value ?? "-1");
		return Number.isInteger(v) && v >= 0 ? v : null;
	}

	/** Brings every dynamic part in step with the state: sentences, the locked tick, the button. */
	private refresh(): void {
		const s = this.st;
		const total = this.info.pages.length;
		if (this.count) this.count.setText(t("transfer.extract.count", { n: String(s.selected.size), total: String(total) }));
		if (s.kind === "split" && this.summary && splitPossible(total, s.splitAt)) {
			const { stay, go } = splitCounts(total, s.splitAt);
			this.summary.setText(t("transfer.split.summary", { name: this.info.notebook, stay: String(stay), from: String(stay + 1), to: String(total), go: String(go) }));
		}
		if (s.kind === "merge" && this.summary) {
			const after = this.afterIndex();
			this.summary.setText(s.other ? t(after === null ? "transfer.merge.summaryEnd" : "transfer.merge.summaryAfter", { name: this.info.notebook, n: String((after ?? 0) + 1) }) : "");
		}
		if (this.modeNote) {
			if (s.kind === "extract") this.modeNote.setText(t(s.extractMode === "move" ? "transfer.extract.moveNote" : "transfer.extract.copyNote", { name: this.info.notebook }));
			else this.modeNote.setText(s.trashOther ? t("transfer.merge.trashNote") : t("transfer.merge.copyNote"));
		}
		const locked = lockedToLeave(s);
		this.lockedRow?.toggleClass("is-on", locked > 0);
		if (this.lockedNote) this.lockedNote.setText(locked > 0 ? t("transfer.locked.note", { n: String(locked) }) : "");
		const why = blocker(s);
		const hint = why ? BLOCKER_TEXT[why] : null;
		this.status.setText(hint ? t(hint) : "");
		this.status.toggleClass("is-empty", !hint);
		const leaves = (s.kind === "extract" && s.extractMode === "move") || s.kind === "split" || (s.kind === "merge" && s.trashOther);
		setShellButtonLabel(this.primary, t(`transfer.${s.kind}.cta${s.kind === "extract" && s.extractMode === "move" ? ".move" : s.kind === "merge" && s.trashOther ? ".trash" : ""}` as Parameters<typeof t>[0]));
		this.primary.disabled = why !== null;
		// What takes pages out of a notebook looks like the other destructive buttons.
		for (const c of ["is-primary", "mod-cta"]) this.primary.toggleClass(c, !leaves);
		for (const c of ["is-danger", "mod-warning"]) this.primary.toggleClass(c, leaves);
	}

	private submit(): void {
		const s = this.st;
		if (blocker(s) !== null) return;
		const allowLocked = lockedToLeave(s) > 0 && s.confirmedLocked;
		let answer: TransferAnswer;
		if (s.kind === "merge") answer = { kind: "merge", other: s.other!.path, after: this.afterIndex(), trashOther: s.trashOther, allowLocked };
		else if (s.kind === "split") answer = { kind: "split", at: s.splitAt, name: s.name.trim(), allowLocked };
		else answer = { kind: "extract", pageIds: this.info.pages.filter((p) => s.selected.has(p.id)).map((p) => p.id), mode: s.extractMode, name: s.name.trim(), allowLocked };
		this.answered = true;
		this.finish(answer);
		this.close();
	}
}

/** Opens the dialog; resolves to the answer, or null when it was closed without one. */
export function askTransfer(app: App, info: TransferDialogData): Promise<TransferAnswer | null> {
	return new Promise((resolve) => new TransferDialog(app, info, resolve).open());
}

/** After pages left a notebook: offers to review the links in the user's notes that name them. Nothing changes until the list is accepted. */
class LinksOfferModal extends Modal {
	constructor(app: App, private readonly count: number, private readonly onReview: () => void) {
		super(app);
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("transfer.links.title"), icon: "link", size: "narrow", cls: "nb-xfer-links", seed: "transfer-links" });
		shellNote(shell.body, t("transfer.links.body", { n: String(this.count) }));
		shellButton(shell.foot, "secondary", t("transfer.links.later"), () => this.close());
		shellButton(shell.foot, "primary", t("transfer.links.review"), () => {
			this.close();
			this.onReview();
		}, { icon: "link" });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function offerLinkReview(app: App, count: number, onReview: () => void): void {
	new LinksOfferModal(app, count, onReview).open();
}
