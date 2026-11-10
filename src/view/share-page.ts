// 0.20 (#30): "Share page…". The page (or the selection, or some pages) is drawn by the export pipeline (PageImageRenderer for PNG,
// buildPdfBytes for PDF, the clean-copy filter of 0.19) into files held in memory, then handed to the system share sheet with
// navigator.share({ files }) when the device takes them. Where it cannot (desktop, an old WebView) a copy is saved in the vault by the same
// naming rules as the exports and a notice offers to open it or copy the image. Closing the share sheet writes nothing. The document is only read.
import { normalizePath, Modal, Setting, type App, type TFile } from "obsidian";
import { t } from "../i18n";
import { cleanPagesForExport, resolveCleanOptions, STRUCK_ONLY, type CleanExportOptions } from "../model/clean-export";
import { uniqueFileName } from "../model/export-markdown";
import { DEFAULT_PNG_SCALE, planPageImages, scaleDpi } from "../model/export-pages";
import { parsePageRange } from "../model/page-range";
import {
	canShareFiles, classifyShareError, decideShare, formatShareSize, loadShareChoice, planShare, saveShareChoice, shareFileNames, shareMime, shareSuffix,
	sizeVerdict, usableScope, MAX_SHARE_PNG_PAGES, type ShareChoice, type SharePlan,
} from "../model/share-page";
import type { TaskRect } from "../model/selection-task";
import type { Page } from "../model/types";
import { recordPluginWrite } from "../storage/plugin-written";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { buildPdfBytes, freePath, type ExportOptions } from "./export";
import { prepareExportFolder, siblingFolder } from "./export-markdown";
import { announceRedaction, withRedaction } from "./export-redact";
import type { NotebookMedia } from "./media";
import { showNotice } from "./notice";
import { PageImageRenderer } from "./page-images";
import { rangeProblem } from "./range-text";

/** What the share needs from the notebook view. */
export interface ShareHost {
	app: App;
	file: TFile;
	pageCount: number;
	/** 0-based page the dialog was opened for. */
	pageIndex: number;
	/** The selection on `pageIndex`, as the crop of the picture; null when there is none. */
	selection: TaskRect | null;
	/** The pages as an export draws them (states in view, not the stored ones). */
	pages(): readonly Page[];
	media: NotebookMedia | null;
	options(): ExportOptions;
	/** 0.29 (#96): the setting "leave out struck-out words in exports and shares": the shared pictures and PDF do not show them. Absent: off. */
	struck?: boolean;
}

/** A file ready to share, in memory. */
interface Prepared {
	name: string;
	bytes: ArrayBuffer;
	type: string;
}

/** Whether this device offers file sharing at all (probed with a tiny file of each type). */
export function deviceCanShareFiles(): boolean {
	const probe = (name: string, type: string): File => new File([""], name, { type });
	return canShareFiles(navigator, [probe("a.png", shareMime("png"))]) && canShareFiles(navigator, [probe("a.pdf", shareMime("pdf"))]);
}

export class SharePageModal extends Modal {
	private choice: ShareChoice;
	private rangeText = "";
	private rangeSetting: Setting | null = null;
	private formatSetting: Setting | null = null;
	private note: HTMLElement | null = null;
	private problem: HTMLElement | null = null;
	private readonly sheet = deviceCanShareFiles();

	constructor(private readonly host: ShareHost) {
		super(host.app);
		const saved = loadShareChoice(host.app);
		this.choice = { ...saved, scope: usableScope(saved.scope, host.selection !== null, host.pageCount) };
	}

	/** Open on the selection (the selection bar's "Share selection"). */
	startOnSelection(): this {
		if (this.host.selection) this.choice = { ...this.choice, scope: "selection" };
		return this;
	}

	onOpen(): void {
		const shell = modalShell(this, { title: t("share.title"), icon: "share-2", size: "medium", cls: "notebook-share-modal" });
		const body = shell.body;
		new Setting(body).setName(t("share.scope")).addDropdown((dd) => {
			dd.addOption("page", t("share.scope.page", { n: String(this.host.pageIndex + 1) }));
			if (this.host.selection) dd.addOption("selection", t("share.scope.selection", { n: String(this.host.pageIndex + 1) }));
			if (this.host.pageCount > 1) dd.addOption("range", t("share.scope.range"));
			dd.setValue(this.choice.scope).onChange((v) => {
				this.choice = { ...this.choice, scope: usableScope(v === "selection" || v === "range" ? v : "page", this.host.selection !== null, this.host.pageCount) };
				this.refresh();
			});
		});
		this.rangeSetting = new Setting(body).setName(t("export.dialog.range")).setDesc(t("export.dialog.range.desc", { n: String(this.host.pageCount) }));
		this.rangeSetting.addText((tx) => {
			tx.setPlaceholder("1-3, 5, 8-").setValue(this.rangeText).onChange((v) => {
				this.rangeText = v;
				this.problem?.setText("");
				this.describe();
			});
		});
		this.formatSetting = new Setting(body).setName(t("share.format"));
		this.formatSetting.addDropdown((dd) => {
			dd.addOption("png", t("share.format.png")).addOption("pdf", t("share.format.pdf"));
			dd.setValue(this.choice.format).onChange((v) => {
				this.choice = { ...this.choice, format: v === "pdf" ? "pdf" : "png" };
				this.problem?.setText("");
				this.describe();
			});
		});
		new Setting(body).setName(t("export.clean")).setDesc(t("export.clean.desc")).addToggle((tg) => tg.setValue(this.choice.clean).onChange((v) => {
			this.choice = { ...this.choice, clean: v };
		}));
		this.note = shellNote(body, "");
		this.note.addClass("notebook-export-note");
		this.problem = shellNote(body, "", "error");
		this.problem.addClass("notebook-export-problem");
		shellButton(shell.foot, "secondary", t("export.dialog.cancel"), () => this.close());
		shellButton(shell.foot, "primary", t(this.sheet ? "share.button.share" : "share.button.save"), () => this.submit(), { icon: this.sheet ? "share-2" : "save" });
		this.refresh();
	}

	private refresh(): void {
		this.rangeSetting?.settingEl.toggle(this.choice.scope === "range");
		this.formatSetting?.settingEl.toggle(this.choice.scope !== "selection");
		this.problem?.setText("");
		this.describe();
	}

	private describe(): void {
		const where = t(this.sheet ? "share.note.sheet" : "share.note.save");
		this.note?.setText(this.choice.scope === "selection" ? `${t("share.note.selection")} ${where}` : where);
	}

	/** The plan of the dialog's choice, or the sentence that says what is wrong with it. */
	private plan(): { plan: SharePlan; problem: string | null } {
		let range: number[] | undefined;
		if (this.choice.scope === "range") {
			const parsed = parsePageRange(this.rangeText, this.host.pageCount);
			const problem = rangeProblem(parsed, this.host.pageCount);
			if (problem || !parsed.ok) return { plan: { ok: false, problem: "no-pages" }, problem: problem ?? "" };
			range = parsed.pages;
		}
		const plan = planShare({ choice: this.choice, pageCount: this.host.pageCount, pageIndex: this.host.pageIndex, hasSelection: this.host.selection !== null, ...(range ? { range } : {}) });
		if (plan.ok) return { plan, problem: null };
		const text = plan.problem === "too-many-png" ? t("share.problem.tooManyPng", { max: String(MAX_SHARE_PNG_PAGES) })
			: plan.problem === "no-selection" ? t("share.problem.noSelection") : t("share.problem.noPages");
		return { plan, problem: text };
	}

	private submit(): void {
		const { plan, problem } = this.plan();
		if (!plan.ok) {
			this.problem?.setText(problem ?? "");
			return;
		}
		saveShareChoice(this.host.app, this.choice);
		const choice = { ...this.choice };
		this.close();
		void runShare(this.host, choice, plan);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Draws the files: PNG images (one per page, or the crop of a selection) or one PDF, through the export pipeline. */
async function prepareFiles(host: ShareHost, choice: ShareChoice, plan: Extract<SharePlan, { ok: true }>): Promise<{ files: Prepared[]; skipped: number }> {
	// 0.19 (#239): a clean copy draws filtered copies of the pages; the document is untouched.
	// 0.29 (#96): the struck-out words setting works with or without the clean copy (without it, the study layers stay in).
	const struck = host.struck === true;
	// Round-2 review (H3): struck words alone keep the study tapes too, like every other writer (`STRUCK_ONLY`).
	const clean: CleanExportOptions | null = choice.clean ? { struck } : struck ? STRUCK_ONLY : null;
	const all = host.pages();
	const cleaned = clean ? cleanPagesForExport(all, clean) : all;
	const base: ExportOptions = { ...host.options(), layers: "both" };
	if (clean && resolveCleanOptions(clean).comments) delete base.comments;
	delete base.struck; // handled above with the clean copy (host.struck), so the writer does not look for it twice
	// 0.26 (#285): the pages with the redaction boxes applied; the PDF, the page images and the crop of a selection all draw the copies.
	const { pages, options } = withRedaction(cleaned, base);
	const chosen = plan.pages.map((i) => pages[i]).filter((p): p is Page => p !== undefined);
	if (chosen.length > 0) announceRedaction(plan.pages.map((i) => cleaned[i]).filter((p): p is Page => p !== undefined), base);
	const names = shareFileNames(host.file.basename, plan.format, plan.scope, plan.pages);
	if (chosen.length === 0) throw new Error("no page");
	if (plan.format === "pdf") {
		const { bytes, skipped } = await buildPdfBytes(host.file.basename, chosen, host.media, options);
		const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		return { files: [{ name: names[0]!, bytes: copy, type: shareMime("pdf") }], skipped };
	}
	await options.prepare?.(chosen);
	const renderer = new PageImageRenderer(host.media, {
		...(options.hiddenInk ? { hiddenInk: options.hiddenInk } : {}),
		...(options.boxLabel ? { boxLabel: options.boxLabel } : {}),
		...(options.equationNumbers ? { equationNumbers: options.equationNumbers } : {}),
		...(options.header ? { header: options.header } : {}),
	});
	const files: Prepared[] = [];
	let skipped = 0;
	try {
		for (let k = 0; k < chosen.length; k++) {
			const page = chosen[k]!;
			let blob: Blob | null;
			if (plan.scope === "selection" && host.selection) {
				const parts = await renderer.renderRegions(page, scaleDpi(DEFAULT_PNG_SCALE), [host.selection]);
				skipped += parts.skipped;
				blob = parts.blobs[0] ?? null;
			} else {
				const image = await renderer.render(page, scaleDpi(DEFAULT_PNG_SCALE));
				skipped += image.skipped;
				blob = image.blob;
			}
			if (!blob) throw new Error("could not encode PNG");
			files.push({ name: names[k]!, bytes: await blob.arrayBuffer(), type: shareMime("png") });
		}
	} finally {
		renderer.close();
	}
	return { files, skipped };
}

const toFile = (p: Prepared): File => new File([p.bytes], p.name, { type: p.type });

/** Renders, then shares or saves. Never throws: a failure is a notice. */
export async function runShare(host: ShareHost, choice: ShareChoice, plan: Extract<SharePlan, { ok: true }>): Promise<void> {
	const working = showNotice(t("export.working"), 0);
	let prepared: { files: Prepared[]; skipped: number };
	try {
		prepared = await prepareFiles(host, choice, plan);
	} catch (e) {
		working.hide();
		showNotice(t("share.failed", { error: (e as Error).message }), 10000);
		return;
	}
	working.hide();
	if (prepared.skipped > 0) showNotice(t("export.skipped", { n: String(prepared.skipped) }), 8000);
	const total = prepared.files.reduce((n, f) => n + f.bytes.byteLength, 0);
	if (sizeVerdict(total) === "warn") showNotice(t("share.tooBig", { size: formatShareSize(total) }), 10000);
	const files = prepared.files.map(toFile);
	if (decideShare(canShareFiles(navigator, files)) === "save") {
		await saveCopy(host, plan, prepared.files, t("share.unavailable"));
		return;
	}
	await shareNow(host, plan, prepared.files, files, false);
}

/** Opens the share sheet. `retried`: this call came from the notice's own button, so another "needs a tap" cannot be answered with the same notice. */
async function shareNow(host: ShareHost, plan: Extract<SharePlan, { ok: true }>, prepared: Prepared[], files: File[], retried: boolean): Promise<void> {
	try {
		await navigator.share({ files, title: host.file.basename });
		return;
	} catch (e) {
		const outcome = classifyShareError(e);
		// The user closed the share sheet: nothing was asked for beyond that, so nothing is written and nothing is said.
		if (outcome === "cancelled") return;
		if (outcome === "needs-tap" && !retried) {
			offerShare(host, plan, prepared, files);
			return;
		}
		if (outcome === "failed") console.error("[notebook] share", e);
		await saveCopy(host, plan, prepared, outcome === "unsupported" ? t("share.unavailable") : t("share.failedSaved"));
	}
}

/** The browser wants a new tap before it opens the share sheet (the files took a while to draw): a notice with the button, files kept in memory. */
function offerShare(host: ShareHost, plan: Extract<SharePlan, { ok: true }>, prepared: Prepared[], files: File[]): void {
	let handle: { hide(): void } | null = null;
	const fragment = createFragment((f) => {
		const box = f.createDiv({ cls: "nb-ui nb-share-notice" });
		box.createDiv({ cls: "nb-share-notice-text", text: t("share.ready") });
		const row = box.createDiv({ cls: "nb-share-notice-row" });
		row.createEl("button", { cls: "nb-share-notice-btn mod-cta", text: t("share.button.share"), attr: { type: "button" } }).addEventListener("click", () => {
			handle?.hide();
			void shareNow(host, plan, prepared, files, true);
		});
	});
	handle = showNotice(fragment, 20000);
}

/** The vault copy where the share sheet is not available: same folder and names as the exports; then a notice to open it or copy the image. */
async function saveCopy(host: ShareHost, plan: Extract<SharePlan, { ok: true }>, prepared: Prepared[], reason: string): Promise<void> {
	const { app, file } = host;
	const paths: string[] = [];
	try {
		if (plan.format === "pdf") {
			const path = freePath(app, file, shareSuffix(plan.scope, plan.pages), "pdf");
			recordPluginWrite(app, [path]);
			await app.vault.createBinary(path, prepared[0]!.bytes);
			paths.push(path);
		} else {
			const { dir, prefix, exists } = await prepareExportFolder(app, siblingFolder(file, "PNG"));
			let names: string[];
			if (plan.scope === "selection") {
				names = [uniqueFileName(`${planPageImages(dir, plan.pages, host.pageCount, () => false)[0]!.replace(/\.png$/i, "")} selection.png`, (n) => exists(`${prefix}${n}`))];
			} else {
				names = planPageImages(dir, plan.pages, host.pageCount, exists);
			}
			const written = names.map((n) => normalizePath(`${prefix}${n}`));
			recordPluginWrite(app, written);
			for (let i = 0; i < prepared.length; i++) {
				await app.vault.createBinary(written[i]!, prepared[i]!.bytes);
				paths.push(written[i]!);
			}
		}
	} catch (e) {
		showNotice(t("share.saveFailed", { done: String(paths.length), error: (e as Error).message }), 10000);
		return;
	}
	const place = paths.length === 1 ? paths[0]! : paths[0]!.replace(/\/[^/]*$/, "") || "/";
	const message = paths.length === 1 ? t("share.saved", { reason, path: place }) : t("share.savedMany", { reason, n: String(paths.length), path: place });
	let handle: { hide(): void } | null = null;
	const fragment = createFragment((f) => {
		const box = f.createDiv({ cls: "nb-ui nb-share-notice" });
		box.createDiv({ cls: "nb-share-notice-text", text: message });
		const row = box.createDiv({ cls: "nb-share-notice-row" });
		row.createEl("button", { cls: "nb-share-notice-btn", text: t("share.open"), attr: { type: "button" } }).addEventListener("click", () => {
			handle?.hide();
			const target = app.vault.getFileByPath(paths[0]!);
			if (target) void app.workspace.getLeaf("tab").openFile(target);
		});
		if (plan.format === "png" && prepared.length === 1 && clipboardImageAvailable()) {
			row.createEl("button", { cls: "nb-share-notice-btn", text: t("share.copyImage"), attr: { type: "button" } }).addEventListener("click", () => {
				handle?.hide();
				void copyImage(prepared[0]!);
			});
		}
	});
	handle = showNotice(fragment, 12000);
}

function clipboardImageAvailable(): boolean {
	return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

async function copyImage(p: Prepared): Promise<void> {
	try {
		await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([p.bytes], { type: "image/png" }) })]);
		showNotice(t("share.imageCopied"));
	} catch (e) {
		console.error("[notebook] copy shared image", e);
		showNotice(t("share.imageCopyFailed"), 8000);
	}
}
