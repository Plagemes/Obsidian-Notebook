/**
 * wave 0.7: resilience — the Obsidian side of safe mode (#346), the storage-full warning (#347) and the integrity
 * check (#390). The decisions live in storage/safe-mode.ts, storage/write-guard.ts and storage/integrity.ts; this file
 * holds the per-device stores, the banners of an open notebook view, the command and the report dialog.
 *
 * Nothing here restores, overwrites or deletes a notebook by itself: every restore is a button the user presses, and
 * the only automatic write is a backup copy (reason `integrity`) of the version that was open when a suspicious
 * version replaced it on disk.
 */
import { Modal, normalizePath, TFile, type App, type Plugin } from "obsidian";
import { t, type MessageKey } from "../i18n";
import type { HistoryService } from "../integration/history-service";
import { openNotebookAtPage } from "../integration/open";
import { describeMerge, openRepair } from "../integration/reliability";
import type { Command } from "../model/history";
import { planMerge } from "../model/merge";
import { parse } from "../model/serialize";
import type { NotebookDocument } from "../model/types";
import { backupFolder, type NotebookSettings } from "../settings";
import { isNotebookFile, readNotebookText } from "../storage/format";
import { formatSnapshotDate } from "../storage/history";
import {
	assessDisk, checkNotebookText, IntegrityLedger, restoredSince, type IntegrityIssue, type IntegrityVerdict, type NotebookCheck,
} from "../storage/integrity";
import type { JournalStore } from "../storage/journal";
import { listNotebooks } from "../storage/notebooks";
import { markSafeOpen, SafeModeTracker, SETTLE_MS, unmarkSafeOpen, type LocalSlot, type OpenDecision } from "../storage/safe-mode";
import type { DiskContentInfo, ExternalNewerInfo, SessionMode } from "../storage/session";
import { AdapterSpaceProbe, pluginFolder, VaultDocumentIO } from "../storage/vault-io";
import type { SpaceProbe, WriteHealthState } from "../storage/write-guard";
import { resolveAssetFile } from "./media";
import { showNotice } from "./notice";

const SAFE_MODE_KEY = "notebook-safe-mode";
const LEDGER_KEY = "notebook-integrity-ledger";

/** A 1×1 transparent image: the page panel shows no thumbnails in safe mode. */
export const BLANK_THUMBNAIL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Device-local storage of this vault (`app.loadLocalStorage`): never synced. */
function localSlot(app: App, key: string): LocalSlot {
	return {
		load: () => app.loadLocalStorage(key) as unknown,
		save: (data) => app.saveLocalStorage(key, data),
	};
}

/** Plugin-wide services shared by the notebook views. */
export interface ResilienceServices {
	readonly safeMode: SafeModeTracker;
	readonly ledger: IntegrityLedger;
	readonly spaceProbe: SpaceProbe;
	/** True when a version-history restore of `file` happened after `since` (a `before-restore` backup exists). */
	restoredSince(file: TFile, since: number): boolean;
	/** Lists the snapshots of `file` to restore one (version history). */
	chooseVersion(file: TFile): void;
	/** Checks the given notebooks (all of them when omitted) and shows the report. */
	check(files?: TFile[]): Promise<void>;
}

export interface ResiliencePlugin extends Plugin {
	settings: NotebookSettings;
	journal?: JournalStore;
}

/** Creates the services and registers the command and the rename/delete bookkeeping. Called once from onload. */
export function registerResilience(plugin: ResiliencePlugin, history: () => HistoryService | null): ResilienceServices {
	const { app } = plugin;
	const safeMode = new SafeModeTracker(localSlot(app, SAFE_MODE_KEY));
	const ledger = new IntegrityLedger(localSlot(app, LEDGER_KEY), () => Date.now(), (fn, ms) => window.setTimeout(fn, ms));
	plugin.register(() => ledger.flush());
	const services: ResilienceServices = {
		safeMode,
		ledger,
		spaceProbe: new AdapterSpaceProbe(app.vault.adapter, pluginFolder(app, plugin.manifest.id)),
		restoredSince: (file, since) => {
			const folder = app.vault.getFolderByPath(normalizePath(backupFolder(plugin.settings)));
			const names = (folder?.children ?? []).filter((f): f is TFile => f instanceof TFile).map((f) => f.name);
			return restoredSince(names, file.basename, since);
		},
		chooseVersion: (file) => {
			void history()?.chooseVersion(file);
		},
		check: async (files) => {
			const list = files ?? listNotebooks(app, plugin.settings.folder);
			new IntegrityModal(app, plugin, services, list, files !== undefined).open();
			await Promise.resolve();
		},
	};
	plugin.registerEvent(app.vault.on("rename", (f, oldPath) => {
		if (!(f instanceof TFile) || !isNotebookFile(f)) return;
		safeMode.rename(oldPath, f.path);
		ledger.rename(oldPath, f.path);
	}));
	plugin.registerEvent(app.vault.on("delete", (f) => {
		if (!(f instanceof TFile) || !isNotebookFile(f)) return;
		safeMode.forget(f.path);
		ledger.forget(f.path);
	}));
	// The command "Check notebooks integrity" (check-integrity) comes from the action registry (ui/actions.ts) and calls check().
	return services;
}

// ------------------------------------------------------------------ banners of an open view

/** What a view offers to its resilience helper. */
export interface ResilienceViewHost {
	readonly app: App;
	settings(): NotebookSettings;
	journal?: JournalStore;
	file(): TFile | null;
	/** Where the banners go (above the page area). */
	readonly bannerHost: HTMLElement;
	/** Safe mode, progressive rendering: give the renderer the PDF and image backgrounds now. */
	attachMedia(): void;
	/** Safe mode was entered or left: re-apply low-latency ink, prediction, thumbnails. */
	modeChanged(): void;
	/** Reopens the file (after "Open normally"). */
	reopen(): Promise<void>;
	/** Writes now; the "Retry now" button. */
	flush(): Promise<boolean>;
	editableDocument(): NotebookDocument | null;
	applyCommand(cmd: Command): boolean;
}

type BannerKind = "safe" | "storage" | "integrity" | "external";

interface BannerAction {
	label: string;
	cta?: boolean;
	run: () => void;
}

/**
 * Per-view helper: the opening marker of the file in the view, safe mode, the storage warning and the integrity banner.
 * The view calls the hooks at the points named after them; everything else happens here.
 */
export class ViewResilience {
	private decision: OpenDecision | null = null;
	private path: string | null = null;
	/** The open has been recorded as settled, abandoned or not started: nothing pending for this view. */
	private settled = true;
	private settleTimer: number | null = null;
	private paintFrame: number | null = null;
	private mediaShown = false;
	private readonly banners = new Map<BannerKind, HTMLElement>();
	private healthy = true;

	constructor(
		private readonly host: ResilienceViewHost,
		private readonly services: ResilienceServices,
	) {}

	/** Safe mode is on for the notebook in this view. */
	get safe(): boolean {
		return this.decision?.safe === true;
	}

	/** Low-latency ink, prediction and raw pointer updates are off in safe mode. */
	lowLatencyAllowed(): boolean {
		return !this.safe;
	}

	thumbnailsAllowed(): boolean {
		return !this.safe;
	}

	prefetchAllowed(): boolean {
		return !this.safe;
	}

	/** In safe mode the renderer gets the backgrounds only after the first paint (or never, if they crashed it). */
	mediaAtLoad(): boolean {
		return !this.safe || this.mediaShown;
	}

	/** Right before the file is read: sets the opening marker and decides safe mode. */
	begin(file: TFile): void {
		this.end();
		this.path = file.path;
		this.decision = this.services.safeMode.begin(file.path);
		this.settled = false;
		this.mediaShown = false;
		if (this.decision.safe) markSafeOpen(file.path);
		this.host.modeChanged();
		this.renderSafeBanner();
	}

	/** The session applied the file. Waits for the first frame, then (after SETTLE_MS) records the open as successful. */
	loaded(mode?: SessionMode): void {
		// A file the sync client has not downloaded yet (sync safety) is not an open: no crash marker for it.
		if (mode === "not-downloaded") return this.hidden();
		if (this.settled || this.paintFrame !== null || this.settleTimer !== null) return;
		this.paintFrame = window.requestAnimationFrame(() => {
			this.paintFrame = window.requestAnimationFrame(() => {
				this.paintFrame = null;
				this.firstPaint();
			});
		});
	}

	/** The view closes or shows another file: an open that did not settle yet is not a failure. */
	end(): void {
		if (this.paintFrame !== null) window.cancelAnimationFrame(this.paintFrame);
		if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
		this.paintFrame = this.settleTimer = null;
		if (this.path !== null && !this.settled) this.services.safeMode.abandoned(this.path);
		if (this.path !== null && this.decision?.safe) unmarkSafeOpen(this.path);
		this.settled = true;
		this.decision = null;
		this.path = null;
		this.healthy = true;
		for (const el of this.banners.values()) el.remove();
		this.banners.clear();
	}

	/** The app went to the background: Android may kill it now, which says nothing about the notebook. */
	hidden(): void {
		if (this.path === null || this.settled) return;
		this.settled = true;
		if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
		this.settleTimer = null;
		this.services.safeMode.abandoned(this.path);
	}

	private firstPaint(): void {
		const path = this.path;
		if (path === null || this.settled) return;
		if (this.safe && !this.decision?.skipMedia) this.showMedia();
		this.settleTimer = window.setTimeout(() => {
			this.settleTimer = null;
			if (this.path !== path || this.settled) return;
			this.settled = true;
			this.services.safeMode.succeeded(path);
		}, SETTLE_MS);
	}

	/** Progressive rendering: the backgrounds after the ink. The marker says so, in case they bring the app down. */
	private showMedia(): void {
		if (this.mediaShown || this.path === null) return;
		this.mediaShown = true;
		if (!this.settled) this.services.safeMode.stage(this.path, "media");
		else {
			// Shown by hand after the open settled: watch this stage like an open of its own.
			this.services.safeMode.begin(this.path);
			this.services.safeMode.stage(this.path, "media");
			this.settled = false;
			this.firstPaintAfterMedia();
		}
		this.host.attachMedia();
		this.renderSafeBanner();
	}

	private firstPaintAfterMedia(): void {
		const path = this.path;
		this.settleTimer = window.setTimeout(() => {
			this.settleTimer = null;
			if (path === null || this.path !== path || this.settled) return;
			this.settled = true;
			this.services.safeMode.succeeded(path);
		}, SETTLE_MS * 3);
	}

	private renderSafeBanner(): void {
		const d = this.decision;
		if (!d?.safe) return this.removeBanner("safe");
		const file = this.host.file();
		const lines = [t("safe.banner.body")];
		if (d.skipMedia && !this.mediaShown) lines.push(t("safe.banner.noMedia"));
		if (d.suggestRepair) lines.push(t("safe.banner.repeated", { count: String(d.failures) }));
		const actions: BannerAction[] = [
			{
				label: t("safe.banner.openNormally"),
				cta: !d.suggestRepair,
				run: () => {
					if (!this.path) return;
					this.services.safeMode.requestNormal(this.path);
					void this.host.reopen();
				},
			},
			{ label: t("safe.banner.repair"), cta: d.suggestRepair, run: () => file && void this.services.check([file]) },
		];
		if (d.skipMedia && !this.mediaShown) actions.push({ label: t("safe.banner.showMedia"), run: () => this.showMedia() });
		this.renderBanner("safe", "is-safe", t("safe.banner.title"), lines, actions);
	}

	// --- #347 storage warning ---

	/** The session's write health changed. */
	writeHealth(state: WriteHealthState): void {
		if (!state.failing) {
			this.removeBanner("storage");
			if (!this.healthy) showNotice(t("storage.recovered"), 6000);
			this.healthy = true;
			return;
		}
		this.healthy = false;
		const key: MessageKey = state.kind === "no-space" ? "storage.banner.noSpace"
			: state.kind === "read-only" || state.kind === "permission" ? "storage.banner.readOnly"
				: state.kind === "torn" ? "storage.banner.torn" : "storage.banner.other";
		const lines = [t(key, { error: state.lastError ?? "?" })];
		if (state.diskDamaged) lines.push(t("storage.banner.damaged"));
		if (state.nextRetryAt !== null) lines.push(t("storage.banner.next", { time: new Date(state.nextRetryAt).toLocaleTimeString() }));
		this.renderBanner("storage", "is-error", t("storage.banner.title"), lines, [
			{ label: t("storage.banner.retryNow"), cta: true, run: () => void this.host.flush() },
		]);
	}

	// --- #390 integrity ---

	/** This view's session wrote `text` to the file and read it back. */
	written(text: string): void {
		const file = this.host.file();
		if (file) this.services.ledger.recordWrite(file.path, text);
	}

	/** The session applied text read from the file (first load or a reload): compare it with what this device wrote. */
	diskContent(info: DiskContentInfo): void {
		const file = this.host.file();
		if (!file) return;
		let verdict: IntegrityVerdict;
		try {
			verdict = assessDisk(this.services.ledger.records(file.path), { text: info.content, doc: info.doc, failure: info.failure },
				(since) => this.services.restoredSince(file, since));
		} catch (e) {
			console.error("[notebook] integrity check failed", e);
			return;
		}
		// A reload that makes the notebook unreadable is kept from wiping the version that was open, whoever wrote it.
		const unreadableReload = !info.initial && !info.doc && info.failure !== "future-version";
		if (verdict.kind !== "unreadable" && verdict.kind !== "rolled-back" && verdict.kind !== "altered" && !unreadableReload) {
			this.removeBanner("integrity");
			return;
		}
		// The version that was open is about to be replaced in memory: keep a copy first. Never a restore.
		const previous = !info.initial ? info.previous : null;
		const kept = previous !== null && previous.trim().length > 0 && parse(previous).ok ? this.keepCopy(file, previous) : Promise.resolve(null);
		if (verdict.kind !== "rolled-back" && verdict.kind !== "altered") {
			// The broken page with Repair is shown by the view; just say that the open version was kept.
			void kept.then((path) => path && showNotice(t("integrity.unreadableKept", { path }), 10000));
			return;
		}
		void kept.then((path) => this.renderIntegrityBanner(file, verdict, info.content, previous, path));
	}

	private async keepCopy(file: TFile, text: string): Promise<string | null> {
		try {
			return await new VaultDocumentIO(this.host.app, file, () => backupFolder(this.host.settings())).backup(text, "integrity");
		} catch (e) {
			console.error("[notebook] could not keep the replaced version", e);
			return null;
		}
	}

	private renderIntegrityBanner(file: TFile, verdict: IntegrityVerdict, diskText: string, previous: string | null, keptPath: string | null): void {
		if (this.host.file() !== file) return;
		const lines: string[] = [];
		if (verdict.kind === "rolled-back") {
			lines.push(t("integrity.banner.rolledBack", { old: formatSnapshotDate(new Date(verdict.version.at)), last: formatSnapshotDate(new Date(verdict.lastWrite.at)) }));
			// It may be a restore made on purpose on another device (by an older version of the plugin): no action is the default.
			lines.push(t("integrity.banner.rolledBackHint"));
		} else if (verdict.kind === "altered") {
			lines.push(t("integrity.banner.altered", { last: formatSnapshotDate(new Date(verdict.lastWrite.at)) }));
		} else return;
		if (keptPath) lines.push(t("integrity.banner.kept", { path: keptPath }));
		const actions: BannerAction[] = [];
		const newer = previous !== null ? parse(previous) : null;
		if (newer?.ok) {
			actions.push({
				label: t("integrity.banner.restoreNewer"),
				// Review: never the primary action for "rolled back", which may be a deliberate restore elsewhere.
				cta: verdict.kind === "altered",
				run: () => {
					const doc = this.host.editableDocument();
					if (!doc) return void showNotice(t("merge.notEditable"));
					const plan = planMerge(doc, newer.doc);
					if (!plan.command) return void showNotice(t("integrity.nothingToRestore"));
					if (this.host.applyCommand(plan.command)) {
						showNotice(t("integrity.restoredNewer"), 8000);
						this.removeBanner("integrity");
					}
				},
			});
		}
		actions.push({ label: t("integrity.restore"), cta: !newer?.ok && verdict.kind === "altered", run: () => this.services.chooseVersion(file) });
		actions.push({
			label: t("integrity.keep"),
			run: () => {
				this.services.ledger.accept(file.path, diskText);
				this.removeBanner("integrity");
			},
		});
		this.renderBanner("integrity", "is-warning", t("integrity.banner.title"), lines, actions);
	}

	// --- #347 review: a newer version found after a failing streak ---

	/**
	 * Saving failed for a while and meanwhile a newer version was saved elsewhere: offer to merge it into the open notebook
	 * (one undo step, as for conflicted copies) or to keep this version. Saving waits for the choice.
	 */
	externalNewer(info: ExternalNewerInfo): void {
		const doc = this.host.editableDocument();
		const plan = doc ? planMerge(doc, info.doc) : null;
		const lines = [t("external.banner.body", { date: formatSnapshotDate(new Date(info.doc.modifiedAt)) })];
		if (plan) lines.push(...describeMerge(plan.summary));
		if (info.backup) lines.push(t("integrity.banner.kept", { path: info.backup }));
		this.renderBanner("external", "is-warning", t("external.banner.title"), lines, [
			{
				label: t("external.banner.merge"),
				cta: true,
				run: () => {
					const current = this.host.editableDocument();
					if (!current) return void showNotice(t("merge.notEditable"));
					const merge = planMerge(current, info.doc);
					if (merge.command && !this.host.applyCommand(merge.command)) return;
					this.removeBanner("external");
					info.accept();
				},
			},
			{
				label: t("external.banner.keepMine"),
				run: () => {
					this.removeBanner("external");
					info.accept();
				},
			},
		]);
	}

	// --- banners ---

	private renderBanner(kind: BannerKind, cls: string, title: string, lines: string[], actions: BannerAction[]): void {
		this.removeBanner(kind);
		const el = this.host.bannerHost.createDiv({ cls: `notebook-resilience-banner ${cls}`, attr: { role: kind === "storage" ? "alert" : "status" } });
		el.createDiv({ cls: "notebook-resilience-banner-title", text: title });
		for (const line of lines) el.createDiv({ cls: "notebook-resilience-banner-text", text: line });
		const row = el.createDiv({ cls: "notebook-resilience-banner-actions" });
		for (const a of actions) {
			const button = row.createEl("button", { text: a.label, cls: a.cta ? "mod-cta" : "" });
			button.addEventListener("click", () => a.run());
		}
		this.banners.set(kind, el);
	}

	private removeBanner(kind: BannerKind): void {
		this.banners.get(kind)?.remove();
		this.banners.delete(kind);
	}
}

// ------------------------------------------------------------------ "Check notebooks integrity"

interface CheckedFile {
	file: TFile;
	text: string | null;
	result: NotebookCheck;
}

function issueText(issue: IntegrityIssue): string {
	const when = issue.detail && (issue.kind === "rolled-back" || issue.kind === "altered") ? formatSnapshotDate(new Date(issue.detail)) : issue.detail ?? "";
	return t(`integrity.issue.${issue.kind}`, { detail: when });
}

/** Reads and checks the notebooks one at a time, then lists the ones with problems and what can be done. */
class IntegrityModal extends Modal {
	private cancelled = false;
	private readonly results: CheckedFile[] = [];

	constructor(
		app: App,
		private readonly plugin: ResiliencePlugin,
		private readonly services: ResilienceServices,
		private readonly files: TFile[],
		private readonly single: boolean,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t("integrity.title"));
		void this.run();
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
	}

	private async run(): Promise<void> {
		const status = this.contentEl.createEl("p");
		const folder = this.plugin.settings.folder;
		for (let i = 0; i < this.files.length && !this.cancelled; i++) {
			const file = this.files[i]!;
			status.setText(t("integrity.checking", { done: String(i + 1), total: String(this.files.length) }));
			let text: string | null = null;
			let result: NotebookCheck;
			try {
				text = readNotebookText(file.extension, await this.app.vault.read(file));
				result = checkNotebookText(text, {
					records: this.services.ledger.records(file.path),
					assetFile: (asset) => {
						const f = resolveAssetFile(this.app, asset, folder);
						return f ? { size: f.stat.size } : null;
					},
					explainedByRestore: (since) => this.services.restoredSince(file, since),
				});
			} catch (e) {
				result = { docId: null, pages: 0, issues: [{ kind: "unreadable", detail: (e as Error).message }] };
			}
			this.results.push({ file, text, result });
			// Let the UI breathe between big files.
			await new Promise<void>((r) => window.setTimeout(r, 0));
		}
		if (!this.cancelled) this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const bad = this.results.filter((r) => r.result.issues.length > 0);
		contentEl.createEl("p", {
			text: this.single && this.results[0]
				? t("integrity.summaryOne", { name: this.results[0].file.path })
				: t("integrity.summary", { total: String(this.results.length), bad: String(bad.length) }),
		});
		if (bad.length === 0) contentEl.createEl("p", { text: t("integrity.allGood") });
		const list = contentEl.createDiv({ cls: "notebook-integrity-list" });
		const shown = this.single ? this.results : bad;
		for (const r of shown) this.renderRow(list, r);
	}

	private renderRow(list: HTMLElement, r: CheckedFile): void {
		const row = list.createDiv({ cls: "notebook-integrity-row" });
		row.createDiv({ cls: "notebook-integrity-name", text: r.file.path });
		for (const issue of r.result.issues) row.createDiv({ cls: "notebook-integrity-issue", text: issueText(issue) });
		const actions = row.createDiv({ cls: "notebook-integrity-actions" });
		const kinds = new Set(r.result.issues.map((i) => i.kind));
		const button = (label: string, run: () => void, cta = false) => {
			const b = actions.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
			b.addEventListener("click", run);
		};
		button(t("integrity.open"), () => {
			this.close();
			void openNotebookAtPage(this.app, r.file, null);
		});
		if (kinds.has("unreadable") || kinds.has("not-downloaded")) {
			// An empty file is usually still to be downloaded: Repair asks first (and is not the primary action).
			button(t("integrity.repair"), () => {
				this.close();
				void openRepair({ app: this.app, settings: this.plugin.settings, journal: this.plugin.journal }, r.file,
					{ docId: this.services.ledger.records(r.file.path)[0]?.id ?? null });
			}, kinds.has("unreadable"));
		}
		if (r.result.docId !== null && !kinds.has("future-version")) {
			button(t("integrity.restore"), () => {
				this.close();
				this.services.chooseVersion(r.file);
			}, kinds.has("rolled-back") || kinds.has("altered") || kinds.has("invalid"));
		}
		if ((kinds.has("rolled-back") || kinds.has("altered")) && r.text !== null) {
			const text = r.text;
			button(t("integrity.keep"), () => {
				this.services.ledger.accept(r.file.path, text);
				r.result = { ...r.result, issues: r.result.issues.filter((i) => i.kind !== "rolled-back" && i.kind !== "altered") };
				showNotice(t("integrity.kept"));
				this.render();
			});
		}
	}
}
