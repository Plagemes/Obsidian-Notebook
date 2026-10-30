import { getLanguage, Notice, SuggestModal, type App, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { openNotebookAtPage } from "../integration/open";
import { fuzzyScore } from "../library/page-search";
import { nameOf, normalizeText } from "../library/index";
import { ago, RecentLog, RecentRecorder, type RecentItem } from "../library/recent-log";
import type { NotebookDocument } from "../model/types";

const STORAGE_KEY = "notebook-recent-pages";

/**
 * Roadmap 365. The log of recently edited pages lives in the device-local storage of Obsidian (`saveLocalStorage`):
 * per device and vault, never in a synced file, never in a notebook.
 */
export class RecentPagesService {
	private readonly log: RecentLog;
	private readonly recorder: RecentRecorder;

	constructor(private readonly app: App, private readonly readNotebook: (file: TFile) => Promise<NotebookDocument | null>) {
		let raw: unknown = null;
		try {
			raw = this.app.loadLocalStorage(STORAGE_KEY);
		} catch {
			raw = null;
		}
		this.log = RecentLog.parse(raw);
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

	/** A real edit on page `pageId` (the `num`-th, 1-based) of the notebook `nb` at `path`. */
	note(nb: string, path: string, pageId: string, num: number): void {
		this.recorder.touch(nb, path, pageId, num);
	}

	flush(): void {
		this.recorder.flush();
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
		}));
		plugin.registerEvent(this.app.vault.on("delete", (f) => {
			if (this.log.removePath(f.path)) this.save();
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
			new Notice(t("quicknav.pageGone"));
			return;
		}
		await openNotebookAtPage(this.app, target.file, target.page);
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

export function registerRecentPages(plugin: Plugin, service: RecentPagesService): void {
	service.register(plugin);
	plugin.addCommand({ id: "recent-pages", name: t("command.recentPages"), callback: () => openRecentPages(plugin.app, service) });
}
