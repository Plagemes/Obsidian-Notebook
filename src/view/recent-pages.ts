import { getLanguage, SuggestModal, type App, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { openNotebookAtPage } from "../integration/open";
import { fuzzyScore } from "../library/page-search";
import { nameOf, normalizeText } from "../library/index";
import { ActivityLog, type ActivityRecord } from "../library/activity-log";
import { ago, RecentLog, RecentRecorder, type RecentItem } from "../library/recent-log";
import type { NotebookDocument } from "../model/types";
import { showNotice } from "./notice";

const STORAGE_KEY = "notebook-recent-pages";
/** 0.13: pages and minutes written per day, for Home's greeting and statistics (library/activity-log.ts). */
const ACTIVITY_KEY = "notebook-activity-days";
const ACTIVITY_SAVE_MS = 4000;

/**
 * Roadmap 365. The log of recently edited pages lives in the device-local storage of Obsidian (`saveLocalStorage`):
 * per device and vault, never in a synced file, never in a notebook.
 */
export class RecentPagesService {
	private readonly log: RecentLog;
	private readonly recorder: RecentRecorder;
	private activityLog: ActivityLog;
	private activityTimer = 0;
	private activityDirty = false;

	constructor(private readonly app: App, private readonly readNotebook: (file: TFile) => Promise<NotebookDocument | null>) {
		let raw: unknown = null;
		try {
			raw = this.app.loadLocalStorage(STORAGE_KEY);
		} catch {
			raw = null;
		}
		this.log = RecentLog.parse(raw);
		let activityRaw: unknown = null;
		try {
			activityRaw = this.app.loadLocalStorage(ACTIVITY_KEY);
		} catch {
			activityRaw = null;
		}
		this.activityLog = ActivityLog.parse(activityRaw);
		this.recorder = new RecentRecorder(
			this.log,
			{ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h) },
			() => this.save(),
		);
	}

	private save(): void {
		try {
			this.app.saveLocalStorage(STORAGE_KEY, JSON.stringify(this.log.toJSON()));
		} catch (e) {
			console.error("[notebook] could not save the recent pages", e);
		}
	}

	private saveActivity(): void {
		window.clearTimeout(this.activityTimer);
		this.activityTimer = 0;
		if (!this.activityDirty) return;
		this.activityDirty = false;
		try {
			this.app.saveLocalStorage(ACTIVITY_KEY, JSON.stringify(this.activityLog.toJSON()));
		} catch (e) {
			console.error("[notebook] could not save the writing activity", e);
		}
	}

	/** A real edit on page `pageId` (the `num`-th, 1-based) of the notebook `nb` at `path`. */
	note(nb: string, path: string, pageId: string, num: number): void {
		this.recorder.touch(nb, path, pageId, num);
		if (this.activityLog.touch(nb, path, pageId, Date.now())) {
			this.activityDirty = true;
			if (!this.activityTimer) this.activityTimer = window.setTimeout(() => this.saveActivity(), ACTIVITY_SAVE_MS);
		}
	}

	flush(): void {
		this.recorder.flush();
		this.saveActivity();
	}

	/**
	 * 0.13: writing activity for Home. Pages that the recent pages log remembers (their last edit) are folded in first, so the
	 * days before this log existed still show; minutes (the writing-time estimate) only come from live edits.
	 */
	activity(): { records: ActivityRecord[]; minutes: Record<string, number> } {
		this.recorder.flush();
		let changed = false;
		for (const i of this.log.list()) if (this.activityLog.touch(i.nb, i.path, i.page, i.at, false)) changed = true;
		if (changed) {
			this.activityDirty = true;
			this.saveActivity();
		}
		return { records: this.activityLog.records(), minutes: this.activityLog.minutesByDay() };
	}

	/** When this device last edited page `pageId` of notebook `nb` (ms since epoch), or null when it has no record (page information, 379). */
	pageEditedAt(nb: string, pageId: string): number | null {
		this.recorder.flush();
		return this.log.list().find((i) => i.nb === nb && i.page === pageId)?.at ?? null;
	}

	/** Newest first, only notebooks that still exist. */
	items(): RecentItem[] {
		return this.log.list().filter((i) => this.app.vault.getFileByPath(i.path) !== null);
	}

	/** Follows renames and deletions in the vault. */
	register(plugin: Plugin): void {
		plugin.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
			this.recorder.flush();
			if (this.log.rename(oldPath, f.path)) this.save();
			if (this.activityLog.rename(oldPath, f.path)) {
				this.activityDirty = true;
				this.saveActivity();
			}
		}));
		plugin.registerEvent(this.app.vault.on("delete", (f) => {
			if (this.log.removePath(f.path)) this.save();
			if (this.activityLog.forgetPath(f.path)) {
				this.activityDirty = true;
				this.saveActivity();
			}
		}));
		plugin.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") this.flush();
		});
		plugin.registerDomEvent(window, "pagehide", () => this.flush());
	}

	/** The notebook file and the 1-based page of a log item; the page is found by its id, so it survives reordering. */
	async resolve(item: RecentItem): Promise<{ file: TFile; page: number } | null> {
		const file = this.app.vault.getFileByPath(item.path);
		if (!file) return null;
		const doc = await this.readNotebook(file);
		if (!doc) return { file, page: item.num };
		const i = doc.pages.findIndex((p) => p.id === item.page);
		return i < 0 ? null : { file, page: i + 1 };
	}

	async open(item: RecentItem): Promise<void> {
		const target = await this.resolve(item);
		if (!target) {
			showNotice(t("quicknav.pageGone"));
			return;
		}
		// Wave 0.8 (388): by page id first, the number is only the fallback.
		await openNotebookAtPage(this.app, target.file, target.page, null, item.page);
	}
}

export function formatAgo(at: number, now = Date.now()): string {
	const { value, unit } = ago(now, at);
	try {
		return new Intl.RelativeTimeFormat(getLanguage(), { numeric: "auto" }).format(value, unit);
	} catch {
		return new Date(at).toLocaleString();
	}
}

export class RecentPagesModal extends SuggestModal<RecentItem> {
	constructor(app: App, private readonly service: RecentPagesService) {
		super(app);
		this.setPlaceholder(t("recent.placeholder"));
		this.emptyStateText = t("recent.empty");
	}

	getSuggestions(query: string): RecentItem[] {
		const items = this.service.items();
		const q = normalizeText(query.trim());
		if (!q) return items;
		return items
			.map((i) => ({ i, s: fuzzyScore(q, normalizeText(nameOf(i.path))) }))
			.filter((x): x is { i: RecentItem; s: number } => x.s !== null)
			.sort((a, b) => b.s - a.s || b.i.at - a.i.at)
			.map((x) => x.i);
	}

	renderSuggestion(item: RecentItem, el: HTMLElement): void {
		el.addClass("notebook-recent-row");
		const main = el.createDiv({ cls: "notebook-recent-main" });
		main.createSpan({ cls: "notebook-recent-name", text: nameOf(item.path) });
		main.createSpan({ cls: "notebook-recent-page", text: t("quicknav.page", { n: String(item.num) }) });
		el.createDiv({ cls: "notebook-recent-when", text: t("recent.edited", { when: formatAgo(item.at) }) });
	}

	onChooseSuggestion(item: RecentItem): void {
		void this.service.open(item);
	}
}

export function openRecentPages(app: App, service: RecentPagesService): void {
	new RecentPagesModal(app, service).open();
}
