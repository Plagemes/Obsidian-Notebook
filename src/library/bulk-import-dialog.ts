/**
 * Bulk import (0.16, roadmap #80): the dialog that opens when several files are dropped on the library or picked with
 * "Import files…". It lists every file with the notebook it becomes (the name is editable), lets the user choose the folder,
 * whether images share one notebook, the paper and the cover for all of them, then runs the import with progress and a
 * way to stop, and ends with a summary and "Open". Built on the modal shell (DESIGN.md §3).
 */
import { Modal, setIcon, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { depthBelow, folderChoices } from "../view/create-logic";
import { filterChips } from "../ui/components/chip";
import { modalShell, shellButton, shellField, shellNote, type ModalShell } from "../ui/components/modal-shell";
import { SUBJECT_COLORS } from "../ui/palette";
import type { PaperKind } from "../model/types";
import {
	buildEntries, bulkLimitMb, formatSize, planNotebooks, summarize,
	type BulkEntry, type BulkKind, type BulkMode, type BulkOutcome, type BulkSource, type BulkSummary, type PlanItem, type SkipReason,
} from "./bulk-import-logic";
import type { BulkControl, BulkJob, BulkLook, BulkRunResult } from "./bulk-import-run";
import { fileSource, pickManyFiles } from "./bulk-drop";

/** The sentence for a reason a file is left out; "too big" names the limit of its kind (or the size the run found). */
function skipText(reason: SkipReason | null, kind: BulkKind | null, detail?: string): string {
	const r = reason ?? "unsupported";
	if (r === "tooBig") return t("bulk.skip.tooBig", { mb: detail && /^\d+$/.test(detail) ? detail : String(bulkLimitMb(kind ?? "pdf")) });
	return t(`bulk.skip.${r}` as MessageKey);
}

/** What the dialog needs from the plugin. */
export interface BulkImportHost {
	/** The notebooks folder. */
	root(): string;
	/** Every folder path of the vault. */
	allFolders(): string[];
	/** Whether a notebook with this clean name is already in `folder` (case ignored). */
	taken(folder: string, clean: string): boolean;
	/** Runs the jobs (library/bulk-import-run.ts with the vault wired in). */
	run(jobs: readonly BulkJob[], folder: string, look: BulkLook, ctl: BulkControl): Promise<BulkRunResult<unknown>>;
	/** Opens a notebook by vault path. */
	open(path: string): void;
	/** Called once the run ended, with what it made (the Board status of a drop on a column is set here). */
	finished?(outcomes: readonly BulkOutcome[]): void;
	/** A short message that outlives the dialog (used when the dialog was closed during the run). */
	notify(text: string): void;
	/** Today, for the default name of a group of images. */
	today(): string;
}

type Stage = "form" | "running" | "summary";

const PAPERS: readonly PaperKind[] = ["blank", "ruled", "grid", "dotted"];

export class BulkImportDialog extends Modal {
	private shell!: ModalShell;
	private sources: BulkSource[];
	private heads: Array<Uint8Array | null> = [];
	private entries: BulkEntry[] = [];
	private removed = new Set<number>();
	private typed: Record<string, string> = {};
	private folder: string;
	private mode: BulkMode = "per-file";
	private paper: PaperKind = "blank";
	private cover: string | null = null;
	private stage: Stage = "form";
	private stopRequested = false;
	private closed = false;
	private hints = new Map<string, HTMLElement>();
	private progressText!: HTMLElement;
	private progressFile!: HTMLElement;
	private progressBar!: HTMLElement;
	private stopBtn!: HTMLButtonElement;
	private result: { outcomes: BulkOutcome[]; summary: BulkSummary; leftOut: BulkEntry[] } | null = null;
	private listSkipped = 0;
	private leftOut: BulkEntry[] = [];

	constructor(app: App, private readonly host: BulkImportHost, sources: BulkSource[], startFolder: string) {
		super(app);
		this.sources = sources;
		const choices = folderChoices(host.root(), host.allFolders());
		const norm = (p: string) => p.replace(/^\/+|\/+$/g, "");
		this.folder = choices.includes(norm(startFolder)) ? norm(startFolder) : (choices[0] ?? norm(host.root()));
	}

	onOpen(): void {
		this.shell = modalShell(this, { title: t("bulk.title"), subtitle: t("bulk.subtitle"), icon: "files", size: "wide", cls: "nb-bulk" });
		void this.checkFiles().then(() => {
			if (!this.closed && this.stage === "form") this.drawForm();
		});
	}

	onClose(): void {
		this.closed = true;
		// Closing during the run stops it after the file in progress; the result comes as a notice.
		if (this.stage === "running") this.stopRequested = true;
		this.contentEl.empty();
	}

	/** Reads the first bytes of every file not yet checked and builds the list. */
	private async checkFiles(): Promise<void> {
		for (let i = this.heads.length; i < this.sources.length; i++) this.heads[i] = await this.sources[i]!.head();
		// Files that share a name and a size are told apart (or confirmed as copies) by a quick fingerprint of their ends.
		const groups = new Map<string, number[]>();
		this.sources.forEach((s, i) => {
			const key = `${s.name.toLowerCase()}|${s.size}`;
			groups.set(key, [...(groups.get(key) ?? []), i]);
		});
		const prints = new Map<number, string | null>();
		for (const ids of groups.values()) {
			if (ids.length < 2) continue;
			for (const i of ids) prints.set(i, (await this.sources[i]!.fingerprint?.()) ?? null);
		}
		this.entries = buildEntries(this.sources.map((s, i) => ({ name: s.name, size: s.size, type: s.type, head: this.heads[i] ?? null, fingerprint: prints.get(i) ?? null })));
	}

	private live(): BulkEntry[] {
		return this.entries.filter((e) => !this.removed.has(e.id));
	}

	private plan(): PlanItem[] {
		return planNotebooks(this.live(), {
			mode: this.mode,
			typed: this.typed,
			groupName: t("bulk.group.name", { date: this.host.today() }),
			fallbackPdf: "PDF",
			fallbackImage: "Image",
			taken: (clean) => this.host.taken(this.folder, clean),
		});
	}

	// ---------------------------------------------------------------- the form

	private drawForm(): void {
		this.stage = "form";
		const { body, foot } = this.shell;
		body.empty();
		foot.empty();
		this.hints.clear();
		const live = this.live();
		const plan = this.plan();
		const images = live.filter((e) => e.kind === "image" && e.skip === null).length;

		this.folderField(body);
		if (images >= 2) {
			const f = shellField(body, t("bulk.mode"));
			filterChips<BulkMode>(f, [
				{ id: "per-file", label: t("bulk.mode.perFile"), icon: "files" },
				{ id: "images-together", label: t("bulk.mode.imagesTogether"), icon: "images" },
			], this.mode, (id) => {
				this.mode = id;
				this.drawForm();
			}, t("bulk.mode"));
		}
		const paperField = shellField(body, t("bulk.paper"));
		filterChips<PaperKind>(paperField, PAPERS.map((p) => ({ id: p, label: t(`paper.${p}` as MessageKey) })), this.paper, (id) => {
			this.paper = id;
			this.drawForm();
		}, t("bulk.paper"));
		this.coverField(body);

		const list = body.createDiv({ cls: "nb-bulk-section", attr: { role: "group", "aria-label": t("bulk.section.notebooks") } });
		list.createDiv({ cls: "nb-modal-section-title", text: t("bulk.section.notebooks") });
		if (plan.length === 0) shellNote(list, t("bulk.nothing"));
		for (const item of plan) this.planRow(list, item);

		const left = this.entries.filter((e) => e.skip !== null && !this.removed.has(e.id));
		if (left.length > 0) {
			const skipped = body.createDiv({ cls: "nb-bulk-section", attr: { role: "group", "aria-label": t("bulk.section.skipped") } });
			skipped.createDiv({ cls: "nb-modal-section-title", text: t("bulk.section.skipped") });
			for (const e of left) this.skippedRow(skipped, e);
		}

		shellButton(foot, "secondary", t("bulk.add"), () => void this.addFiles(), { icon: "plus" });
		shellButton(foot, "secondary", t("bulk.cancel"), () => this.close());
		this.listSkipped = left.length;
		this.leftOut = left;
		const label = plan.length === 1 ? t("bulk.import.one") : t("bulk.import.many", { count: String(plan.length) });
		shellButton(foot, "primary", label, () => void this.start(), { icon: "download", disabled: plan.length === 0 });
	}

	private folderField(body: HTMLElement): void {
		const f = shellField(body, t("bulk.folder"), "nb-bulk-folder");
		const select = f.createEl("select", { cls: "nb-modal-input nb-bulk-select", attr: { id: "nb-bulk-folder" } });
		const root = this.host.root().replace(/^\/+|\/+$/g, "");
		for (const path of folderChoices(this.host.root(), this.host.allFolders())) {
			const name = path === root ? (root.slice(root.lastIndexOf("/") + 1) || "/") : path.slice(path.lastIndexOf("/") + 1);
			const opt = select.createEl("option", { text: `${" ".repeat(depthBelow(root, path))}${name}`, attr: { value: path } });
			opt.selected = path === this.folder;
		}
		select.addEventListener("change", () => {
			this.folder = select.value;
			this.refreshHints();
		});
	}

	private coverField(body: HTMLElement): void {
		const f = shellField(body, t("bulk.cover"));
		const row = f.createDiv({ cls: "nb-bulk-covers", attr: { role: "radiogroup", "aria-label": t("bulk.cover") } });
		const auto = row.createEl("button", { cls: "nb-bulk-auto", text: t("bulk.cover.auto"), attr: { type: "button", role: "radio", "aria-checked": String(this.cover === null) } });
		auto.toggleClass("is-on", this.cover === null);
		auto.addEventListener("click", () => {
			this.cover = null;
			this.drawForm();
		});
		for (const c of SUBJECT_COLORS) {
			const on = this.cover?.toLowerCase() === c.base.toLowerCase();
			const s = row.createEl("button", { cls: "nb-bulk-swatch", attr: { type: "button", role: "radio", "aria-checked": String(on), "aria-label": c.name, title: c.name } });
			s.setCssProps({ "--nb-sw": c.base });
			s.toggleClass("is-on", on);
			s.addEventListener("click", () => {
				this.cover = c.base;
				this.drawForm();
			});
		}
	}

	private planRow(parent: HTMLElement, item: PlanItem): void {
		const row = parent.createDiv({ cls: "nb-bulk-row", attr: { "data-key": `bulk:${item.key}` } });
		const group = item.key === "images";
		setIcon(row.createSpan({ cls: "nb-bulk-icon", attr: { "aria-hidden": "true" } }), group ? "images" : item.kind === "pdf" ? "file-text" : "image");
		const main = row.createDiv({ cls: "nb-bulk-main" });
		const input = main.createEl("input", {
			cls: "nb-modal-input nb-bulk-name",
			attr: { type: "text", maxlength: "120", "aria-label": t("bulk.name"), placeholder: item.wanted },
		});
		input.value = item.typed;
		input.addEventListener("input", () => {
			this.typed[item.key] = input.value;
			this.refreshHints();
		});
		const first = this.entries[item.entries[0]!]!;
		const detail = group
			? t("bulk.group.images", { count: String(item.entries.length) })
			: t(item.kind === "pdf" ? "bulk.group.pdf" : "bulk.group.image", { size: formatSize(first.size) });
		main.createDiv({ cls: "nb-bulk-detail", text: group ? detail : `${first.fileName} · ${detail}` });
		const hint = main.createDiv({ cls: "nb-bulk-hint" });
		this.hints.set(item.key, hint);
		this.setHint(hint, item);
		const x = row.createEl("button", { cls: "nb-icon-btn nb-bulk-remove", attr: { type: "button", "aria-label": t("bulk.remove"), title: t("bulk.remove") } });
		setIcon(x, "x");
		x.addEventListener("click", () => {
			for (const id of item.entries) this.removed.add(id);
			this.drawForm();
		});
	}

	private setHint(hint: HTMLElement, item: PlanItem): void {
		hint.setText(item.name !== item.wanted ? t("bulk.willBe", { name: item.name }) : "");
		hint.toggleClass("is-empty", hint.getText() === "");
	}

	/** The names depend on each other and on the folder: update the hints under the rows without redrawing the inputs. */
	private refreshHints(): void {
		const plan = this.plan();
		for (const item of plan) {
			const hint = this.hints.get(item.key);
			if (hint) this.setHint(hint, item);
		}
	}

	private skippedRow(parent: HTMLElement, e: BulkEntry): void {
		const row = parent.createDiv({ cls: "nb-bulk-row is-skipped", attr: { "data-reason": e.skip ?? "" } });
		setIcon(row.createSpan({ cls: "nb-bulk-icon", attr: { "aria-hidden": "true" } }), "alert-triangle");
		const main = row.createDiv({ cls: "nb-bulk-main" });
		main.createDiv({ cls: "nb-bulk-skipname", text: e.fileName });
		main.createDiv({ cls: "nb-bulk-detail", text: skipText(e.skip, e.kind) });
	}

	private async addFiles(): Promise<void> {
		const files = await pickManyFiles();
		if (files.length === 0 || this.closed) return;
		this.addSources(files.map(fileSource));
	}

	/** Adds files to the list (the picker, or another drop while the dialog is open). */
	addSources(more: BulkSource[]): void {
		if (this.stage !== "form") return;
		this.sources = [...this.sources, ...more];
		void this.checkFiles().then(() => {
			if (!this.closed && this.stage === "form") this.drawForm();
		});
	}

	// ---------------------------------------------------------------- the run

	private async start(): Promise<void> {
		const plan = this.plan();
		if (plan.length === 0) return;
		const jobs: BulkJob[] = plan.map((p) => ({
			key: p.key,
			kind: p.kind,
			name: p.name,
			files: p.entries.map((id) => ({ fileName: this.entries[id]!.fileName, source: this.sources[id]! })),
		}));
		const listSkipped = this.listSkipped;
		const leftOut = this.leftOut;
		this.stage = "running";
		this.stopRequested = false;
		this.drawProgress(jobs.reduce((n, j) => n + j.files.length, 0));
		let run: BulkRunResult<unknown>;
		try {
			run = await this.host.run(jobs, this.folder, { paper: this.paper, cover: this.cover }, {
				cancelled: () => this.stopRequested,
				onProgress: (p) => {
					if (this.closed) return;
					this.progressText.setText(t("bulk.progress", { done: String(Math.min(p.done + 1, p.total)), total: String(p.total) }));
					this.progressFile.setText(t("bulk.progress.now", { notebook: p.notebook, file: p.file }));
					this.progressBar.setCssProps({ "--nb-bulk-pct": `${Math.round((p.done / Math.max(1, p.total)) * 100)}%` });
				},
			});
		} catch (e) {
			console.error("[notebook] bulk import", e);
			run = { outcomes: [], files: new Map(), notStarted: jobs.length, cancelled: false };
		}
		const summary = summarize(run.outcomes, listSkipped, run.notStarted, run.cancelled);
		this.result = { outcomes: run.outcomes, summary, leftOut };
		this.stage = "summary";
		this.host.finished?.(run.outcomes);
		if (this.closed) this.host.notify(summaryLine(summary));
		else this.drawSummary();
	}

	private drawProgress(total: number): void {
		const { body, foot } = this.shell;
		body.empty();
		foot.empty();
		const box = body.createDiv({ cls: "nb-bulk-progress", attr: { role: "status", "aria-live": "polite" } });
		this.progressText = box.createDiv({ cls: "nb-bulk-progress-title", text: t("bulk.progress", { done: "1", total: String(total) }) });
		this.progressBar = box.createDiv({ cls: "nb-bulk-bar", attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" } });
		this.progressBar.createSpan({ cls: "nb-bulk-bar-fill" });
		this.progressFile = box.createDiv({ cls: "nb-bulk-detail" });
		this.stopBtn = shellButton(foot, "secondary", t("bulk.stop"), () => {
			this.stopRequested = true;
			this.stopBtn.disabled = true;
			this.progressFile.setText(t("bulk.stopping"));
		}, { icon: "square" });
	}

	private drawSummary(): void {
		const r = this.result;
		if (!r) return;
		const { body, foot, title } = this.shell;
		const s = r.summary;
		title.setText(s.cancelled ? t("bulk.summary.stopped") : t("bulk.summary.title"));
		body.empty();
		foot.empty();
		const box = body.createDiv({ cls: "nb-bulk-summary", attr: { role: "status" } });
		box.createDiv({ cls: "nb-bulk-progress-title", text: summaryLine(s) });
		const lines: string[] = [];
		if (s.skipped > 0) lines.push(t("bulk.summary.skipped", { count: String(s.skipped) }));
		if (s.failed > 0) lines.push(t("bulk.summary.failed", { count: String(s.failed) }));
		if (s.notStarted > 0) lines.push(t("bulk.summary.notStarted", { count: String(s.notStarted) }));
		if (lines.length > 0) box.createDiv({ cls: "nb-bulk-detail", text: lines.join(" · ") });

		const problems = body.createDiv({ cls: "nb-bulk-section" });
		let any = false;
		for (const e of r.leftOut) {
			any = true;
			const row = problems.createDiv({ cls: "nb-bulk-row is-skipped", attr: { "data-reason": e.skip ?? "" } });
			setIcon(row.createSpan({ cls: "nb-bulk-icon", attr: { "aria-hidden": "true" } }), "alert-triangle");
			const main = row.createDiv({ cls: "nb-bulk-main" });
			main.createDiv({ cls: "nb-bulk-skipname", text: e.fileName });
			main.createDiv({ cls: "nb-bulk-detail", text: skipText(e.skip, e.kind) });
		}
		for (const o of r.outcomes) {
			if (o.partial) {
				any = true;
				shellNote(problems, t("bulk.summary.partial", { name: o.name }));
			}
			if (o.failed !== null) {
				any = true;
				shellNote(problems, t("bulk.summary.failedItem", { name: o.name, error: o.failed }), "error");
			}
			for (const k of o.skipped) {
				any = true;
				const row = problems.createDiv({ cls: "nb-bulk-row is-skipped" });
				setIcon(row.createSpan({ cls: "nb-bulk-icon", attr: { "aria-hidden": "true" } }), "alert-triangle");
				const main = row.createDiv({ cls: "nb-bulk-main" });
				main.createDiv({ cls: "nb-bulk-skipname", text: k.file });
				main.createDiv({ cls: "nb-bulk-detail", text: skipText(k.reason, null, k.detail) });
			}
		}
		if (!any) problems.remove();
		const first = s.first;
		if (first !== null) {
			shellButton(foot, "secondary", t("bulk.done"), () => this.close());
			shellButton(foot, "primary", t("bulk.open"), () => {
				this.close();
				this.host.open(first);
			}, { icon: "external-link" });
		} else shellButton(foot, "primary", t("bulk.done"), () => this.close());
	}
}

/** "3 notebooks created · 41 pages", or that none was. */
export function summaryLine(s: BulkSummary): string {
	if (s.created === 0) return t("bulk.summary.none");
	return s.created === 1 ? t("bulk.summary.created.one", { pages: String(s.pages) }) : t("bulk.summary.created.many", { count: String(s.created), pages: String(s.pages) });
}
