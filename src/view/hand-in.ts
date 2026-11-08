// 0.24 handin (#334): the "Hand in…" dialog and the export it runs. The dialog collects the pages, the cover fields and shows the
// pre-flight (blank pages, open placeholders) live; the PDF is the ordinary export with a generated cover page in front, written
// next to the notebook under a free name (never over a file), recorded as plugin-written, and optionally offered to the share sheet.
import { Modal, Setting, type App, type TFile } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { renderThumbnail } from "../library/thumbnail";
import { allPages, cleanCoverField, coverPage, defaultHandInPages, handInCheck, withoutPages, type CoverFields, type OpenKind } from "../model/hand-in";
import type { Page } from "../model/types";
import { recordPluginWrite } from "../storage/plugin-written";
import { modalShell, shellButton, shellNote, shellRow, shellSection, setShellButtonLabel } from "../ui/components/modal-shell";
import { buildPdfBytes, freePath, type ExportOptions } from "./export";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { deviceCanShareFiles } from "./share-page";

/** Local-storage key of the student's name (per device, never in the notebook or the vault). */
export const HAND_IN_NAME_KEY = "notebook-hand-in-name";

export interface HandInHost {
	app: App;
	file: TFile;
	/** The pages as an export draws them. */
	pages(): readonly Page[];
	/** Pages picked in the page panel (0-based); empty when none. */
	picked: readonly number[];
	/** 0-based page in view. */
	current: number;
	/** The course of the class linked to this notebook (timetable), or "". */
	course: string;
	media: NotebookMedia | null;
	options(): ExportOptions;
	/** Scrolls the notebook to a page (the dialog closes first). */
	goToPage(index: number): void;
}

export interface HandInRequest {
	pages: readonly number[];
	fields: CoverFields;
	share: boolean;
}

/** The remembered name, or "" (corrupt or absent storage is an empty name). */
export function loadHandInName(app: Pick<App, "loadLocalStorage">): string {
	try {
		const v: unknown = app.loadLocalStorage(HAND_IN_NAME_KEY);
		return typeof v === "string" ? cleanCoverField(v) : "";
	} catch {
		return "";
	}
}

export function saveHandInName(app: Pick<App, "saveLocalStorage">, name: string): void {
	try {
		app.saveLocalStorage(HAND_IN_NAME_KEY, cleanCoverField(name) || null);
	} catch (e) {
		console.error("[notebook] could not remember the name", e);
	}
}

/** Today as `YYYY-MM-DD` in local time. */
export function todayIso(now = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** `2026-11-08` written the way the reader reads dates; anything else is returned as typed. */
export function longDate(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return iso;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/** Builds and writes the PDF. Resolves to the path written, or null (a notice says why). Never throws. */
export async function runHandIn(host: Pick<HandInHost, "app" | "file" | "pages" | "media" | "options">, request: HandInRequest): Promise<string | null> {
	const all = host.pages();
	const chosen = request.pages.filter((i) => i >= 0 && i < all.length).map((i) => all[i]!);
	if (chosen.length === 0) {
		showNotice(t("handIn.check.none"));
		return null;
	}
	const working = showNotice(t("export.working"), 0);
	try {
		const first = chosen[0]!;
		const cover = coverPage(
			{ ...request.fields, footer: request.fields.footer ?? t("handIn.coverPages", { n: String(chosen.length) }) },
			{ name: t("handIn.coverLabel.name"), course: t("handIn.coverLabel.course"), date: t("handIn.coverLabel.date") },
			{ width: first.width, height: first.height, ...(first.infinite ? { infinite: true } : {}) },
		);
		const options = host.options();
		const header = options.header;
		const { bytes, skipped } = await buildPdfBytes(host.file.basename, [cover, ...chosen], host.media, {
			...options,
			// The cover is not a notebook page: no automatic header on it.
			...(header ? { header: (p: Page) => (p === cover ? null : header(p)) } : {}),
		});
		const path = freePath(host.app, host.file, " hand-in", "pdf");
		recordPluginWrite(host.app, [path]);
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		await host.app.vault.createBinary(path, buffer);
		showNotice(t("export.done", { path }));
		if (skipped > 0) showNotice(t("export.skipped", { n: String(skipped) }), 8000);
		if (request.share) await offerToShare(path, buffer, host.file.basename);
		return path;
	} catch (e) {
		showNotice(t("export.failed", { error: e instanceof Error ? e.message : String(e) }));
		return null;
	} finally {
		working.hide();
	}
}

/** The share sheet, when this device has one; the file is already saved, so a refusal or a cancel says nothing. */
async function offerToShare(path: string, buffer: ArrayBuffer, title: string): Promise<void> {
	if (!deviceCanShareFiles()) return;
	try {
		const name = path.slice(path.lastIndexOf("/") + 1);
		await navigator.share({ files: [new File([buffer], name, { type: "application/pdf" })], title });
	} catch {
		// Cancelled, or the browser wants a new tap: the PDF is in the vault either way.
	}
}

/** The words of each kind of open thing. */
const OPEN_KIND_KEYS: Record<OpenKind, MessageKey> = {
	gap: "handIn.open.gap", question: "handIn.open.question", homework: "handIn.open.homework",
	checkbox: "handIn.open.checkbox", todo: "handIn.open.todo", emptyBox: "handIn.open.emptyBox",
};

const THUMB_WIDTH = 84;
const THUMBS_PER_SLICE = 3;

export class HandInModal extends Modal {
	private chosen: number[];
	private name: string;
	private course: string;
	private assignment: string;
	private date = todayIso();
	private share = false;
	private checkEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private exportButton: HTMLButtonElement | null = null;
	private readonly boxes = new Map<number, HTMLInputElement>();
	private thumbTimer = 0;
	private closed = false;

	constructor(private readonly host: HandInHost) {
		super(host.app);
		this.chosen = defaultHandInPages(host.pages().length, host.current, host.picked);
		this.name = loadHandInName(host.app);
		this.course = host.course;
		this.assignment = host.file.basename;
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("handIn.title"), subtitle: t("handIn.subtitle"), icon: "graduation-cap", size: "medium", cls: "notebook-handin-modal" });
		const body = shell.body;

		const pagesBox = shellSection(body, t("handIn.pages"), "nb-handin-pages");
		const tools = pagesBox.createDiv({ cls: "nb-handin-tools" });
		this.countEl = tools.createSpan({ cls: "nb-handin-count" });
		shellButton(tools, "secondary", t("handIn.pages.all"), () => this.setChosen(allPages(this.host.pages().length)));
		shellButton(tools, "secondary", t("handIn.pages.none"), () => this.setChosen([]));
		this.buildGrid(pagesBox);

		const cover = shellSection(body, t("handIn.cover"), "nb-handin-cover");
		const field = (name: string, desc: string | null, value: string, onChange: (v: string) => void, type = "text"): void => {
			const s = new Setting(cover).setName(name);
			if (desc) s.setDesc(desc);
			s.addText((tx) => {
				tx.inputEl.type = type;
				tx.setValue(value).onChange(onChange);
			});
		};
		field(t("handIn.name"), t("handIn.name.desc"), this.name, (v) => { this.name = v; });
		field(t("handIn.course"), null, this.course, (v) => { this.course = v; });
		field(t("handIn.assignment"), null, this.assignment, (v) => { this.assignment = v; });
		field(t("handIn.date"), null, this.date, (v) => { this.date = v; }, "date");

		this.checkEl = shellSection(body, t("handIn.check"), "nb-handin-check");

		if (deviceCanShareFiles()) {
			new Setting(body).setName(t("handIn.share")).addToggle((tg) => tg.setValue(this.share).onChange((v) => { this.share = v; }));
		}

		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		this.exportButton = shellButton(shell.foot, "primary", t("handIn.export"), () => void this.submit(), { icon: "file-output" });
		this.refresh();
	}

	onClose(): void {
		this.closed = true;
		window.clearTimeout(this.thumbTimer);
	}

	private buildGrid(parent: HTMLElement): void {
		const grid = parent.createDiv({ cls: "nb-handin-grid", attr: { role: "group", "aria-label": t("handIn.pages") } });
		const pages = this.host.pages();
		const cells: { page: Page; img: HTMLImageElement }[] = [];
		pages.forEach((page, i) => {
			const cell = grid.createEl("label", { cls: "nb-handin-cell", attr: { title: t("handIn.page", { n: String(i + 1) }) } });
			const box = cell.createEl("input", { attr: { type: "checkbox", "aria-label": t("handIn.page", { n: String(i + 1) }) } });
			box.checked = this.chosen.includes(i);
			box.addEventListener("change", () => {
				this.chosen = box.checked ? [...new Set([...this.chosen, i])].sort((a, b) => a - b) : this.chosen.filter((x) => x !== i);
				this.refresh();
			});
			this.boxes.set(i, box);
			const frame = cell.createDiv({ cls: "nb-handin-thumb" });
			const img = frame.createEl("img", { attr: { alt: "" } });
			cell.createSpan({ cls: "nb-handin-num", text: String(i + 1) });
			cells.push({ page, img });
		});
		// The pictures are drawn a few at a time, so a long notebook does not hold the dialog up.
		let next = 0;
		const slice = (): void => {
			if (this.closed) return;
			const stop = Math.min(cells.length, next + THUMBS_PER_SLICE);
			for (; next < stop; next++) {
				const c = cells[next]!;
				try {
					const url = renderThumbnail(c.page, THUMB_WIDTH * 2, { mime: "image/jpeg", quality: 0.7 });
					if (url) c.img.src = url;
				} catch {
					// A page that cannot be drawn is still choosable by its number.
				}
			}
			if (next < cells.length) this.thumbTimer = window.setTimeout(slice, 16);
		};
		this.thumbTimer = window.setTimeout(slice, 0);
	}

	private setChosen(pages: number[]): void {
		this.chosen = pages;
		for (const [i, box] of this.boxes) box.checked = pages.includes(i);
		this.refresh();
	}

	/** The count, the pre-flight rows and the label of the main button, from the pages chosen now. */
	private refresh(): void {
		const pages = this.host.pages();
		this.countEl?.setText(t("handIn.pages.count", { n: String(this.chosen.length), total: String(pages.length) }));
		const box = this.checkEl;
		if (!box) return;
		box.empty();
		const list = box;
		if (this.chosen.length === 0) {
			shellNote(box, t("handIn.check.none"));
			this.setExport(t("handIn.export"), true);
			return;
		}

		const check = handInCheck(pages, this.chosen);
		if (check.clean) {
			shellNote(box, t("handIn.check.clean"));
			this.setExport(t("handIn.export"), false);
			return;
		}
		for (const i of check.blank) {
			shellRow(list, { label: t("handIn.check.blank"), detail: t("handIn.check.blank.detail", { n: String(i + 1) }), cls: "nb-handin-finding is-blank", onClick: () => this.fix(i) });
		}
		for (const f of check.open) {
			const key = OPEN_KIND_KEYS[f.kind];
			const detail = t("handIn.open.detail", { n: String(f.page + 1) }) + (f.sample ? ` “${f.sample}”` : "");
			shellRow(list, { label: t(key, { n: String(f.count) }), detail, cls: `nb-handin-finding is-${f.kind}`, onClick: () => this.fix(f.page) });
		}
		if (check.blank.length > 0) {
			const leave = box.createDiv({ cls: "nb-handin-leave" });
			shellButton(leave, "secondary", t("handIn.check.leaveOut"), () => this.setChosen(withoutPages(this.chosen, check.blank)));
		}
		shellNote(box, t("handIn.fixHint"));
		this.setExport(t("handIn.exportAnyway"), false);
	}

	private setExport(label: string, disabled: boolean): void {
		const b = this.exportButton;
		if (!b) return;
		setShellButtonLabel(b, label);
		b.disabled = disabled;
	}

	private fix(page: number): void {
		this.close();
		this.host.goToPage(page);
	}

	private async submit(): Promise<void> {
		if (this.chosen.length === 0) return;
		saveHandInName(this.host.app, this.name);
		const fields: CoverFields = { name: this.name, course: this.course, title: this.assignment, date: longDate(this.date) };
		const path = await runHandIn(this.host, { pages: this.chosen, fields, share: this.share });
		if (path) this.close();
	}
}

