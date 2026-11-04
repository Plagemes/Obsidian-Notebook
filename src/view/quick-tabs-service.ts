/**
 * Quick tabs (roadmap #227): what the strip and the page actions do. The pins are kept by `QuickTabsStore` (one file per
 * device in `_meta`, never in the notebook); this keeps them in step with the vault, pins and unpins, opens a tab (in the
 * same notebook, or in another one) and remembers where the reader was so that "Back" returns there.
 */
import { TFile, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import { openNotebookAtPage } from "../integration/open";
import { NotebookPickerModal } from "../integration/picker";
import { QUICKTABS_MAX, resolveTab, type QuickTab } from "../library/quicktabs";
import { QuickTabsBlockedError, type QuickTabsStore } from "../library/quicktabs-store";
import { PromptModal } from "../library/library-modals";
import type { NavPlace } from "../model/nav-history";
import type { NotebookDocument } from "../model/types";
import { isNotebookFile } from "../storage/format";
import { showNotice } from "./notice";

/** What the service needs of a notebook view (an interface, so the view can be a plain object in tests). */
export interface QuickTabsViewApi {
	/** The id of the notebook in view (the scope of its tabs), or null when none is loaded. */
	docId(): string | null;
	path(): string | null;
	pageIds(): string[];
	/** The page in view as a place (for "Back"). */
	place(): NavPlace | null;
	/** The page in view: its id, 0-based index and bookmark title, if any. */
	current(): { pageId: string; index: number; title: string } | null;
	/** Scrolls to page `index` of this notebook, recording the jump in the back/forward history. */
	jump(index: number): void;
	/** Scrolls to a place of this notebook without recording it. */
	show(place: NavPlace): boolean;
}

export interface QuickTabsDeps {
	app: App;
	store: QuickTabsStore;
	readNotebook(file: TFile): Promise<NotebookDocument | null>;
	notebooksFolder(): string;
	/** Opens a notebook at a page (default: the plugin's own opener). Replaced in the harness. */
	openAt?(file: TFile, page: number, pageId: string): Promise<void>;
}

export class QuickTabsService {
	/** Where the reader was before the last tap on a tab (kept across notebooks: the tap may have opened another one). */
	private backPlace: NavPlace | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly deps: QuickTabsDeps) {
		deps.store.onChange(() => this.changed());
	}

	/** Reads the files at start and follows other devices' files, renames and deletions. */
	register(plugin: Plugin): void {
		const { vault, workspace } = plugin.app;
		const load = () => void this.deps.store.load().catch((e) => console.error("[notebook] quick tabs could not be read", e));
		workspace.onLayoutReady(load);
		const changed = (file: unknown) => {
			if (file instanceof TFile && this.deps.store.watches(file.path)) load();
		};
		plugin.registerEvent(vault.on("create", changed));
		plugin.registerEvent(vault.on("modify", changed));
		plugin.registerEvent(vault.on("delete", changed));
		plugin.registerEvent(vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile && isNotebookFile(file)) {
				void this.deps.store.retarget(oldPath, file.path).catch((e) => console.error("[notebook] quick tabs could not follow a rename", e));
			}
		}));
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	private changed(): void {
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch (e) {
				console.error("[notebook] quick tabs listener failed", e);
			}
		}
	}

	/** The tabs of the notebook `scope`. */
	tabs(scope: string | null): QuickTab[] {
		return scope ? this.deps.store.list(scope) : [];
	}

	/** Whether the page in view of `view` is a tab of its own notebook. */
	isPinned(view: QuickTabsViewApi): boolean {
		const scope = view.docId(), cur = view.current(), path = view.path();
		return !!scope && !!cur && !!path && this.tabs(scope).some((x) => x.path === path && x.pageId === cur.pageId);
	}

	/** Whether page `index` (0-based) of the notebook in view is a tab of that notebook. */
	isPinnedAt(view: QuickTabsViewApi, index: number): boolean {
		const scope = view.docId(), path = view.path(), id = view.pageIds()[index];
		return !!scope && !!path && !!id && this.tabs(scope).some((x) => x.path === path && x.pageId === id);
	}

	/** Pins the page in view (or unpins it when it is a tab already). */
	async togglePin(view: QuickTabsViewApi): Promise<void> {
		const scope = view.docId(), cur = view.current(), path = view.path();
		if (!scope || !cur || !path) return;
		const there = this.tabs(scope).find((x) => x.path === path && x.pageId === cur.pageId);
		try {
			if (there) {
				await this.deps.store.unpin(there.id);
				showNotice(t("quicktabs.unpinned"));
			} else {
				await this.deps.store.pin({ scope, path, pageId: cur.pageId, num: cur.index + 1, label: cur.title });
				showNotice(t("quicktabs.pinned"));
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/** "Pin a page from another notebook…": pick the notebook, then the page number; the tab opens it from this notebook's strip. */
	pinFromOther(view: QuickTabsViewApi): void {
		const scope = view.docId();
		if (!scope) return;
		if (this.tabs(scope).length >= QUICKTABS_MAX) {
			showNotice(t("quicktabs.limit", { n: String(QUICKTABS_MAX) }));
			return;
		}
		new NotebookPickerModal(this.deps.app, this.deps.notebooksFolder(), (file) => {
			void this.deps.readNotebook(file).then((doc) => {
				if (!doc || doc.pages.length === 0) {
					showNotice(t("quicktabs.unreadable", { name: file.basename }));
					return;
				}
				const total = doc.pages.length;
				new PromptModal(this.deps.app, { title: t("quicktabs.otherTitle", { name: file.basename }), label: t("quicktabs.otherLabel", { total: String(total) }), cta: t("quicktabs.pin") }, (value) => {
					const n = Number(value.trim());
					const page = Number.isInteger(n) ? doc.pages[n - 1] : undefined;
					if (!page) {
						showNotice(t("quicktabs.otherInvalid", { total: String(total) }));
						return;
					}
					const title = doc.meta?.bookmarkInfo?.[page.id]?.title?.trim() ?? "";
					void this.deps.store.pin({ scope, path: file.path, pageId: page.id, num: n, label: title || `${file.basename} ${t("quicktabs.page", { n: String(n) })}` })
						.then(() => showNotice(t("quicktabs.pinned")), (e) => this.fail(e));
				}).open();
			});
		}).open();
	}

	unpin(id: string): void {
		void this.deps.store.unpin(id).catch((e) => this.fail(e));
	}

	move(scope: string, id: string, to: number): void {
		void this.deps.store.move(scope, id, to).catch((e) => this.fail(e));
	}

	/** Where "Back" goes, if anywhere. */
	back(): NavPlace | null {
		return this.backPlace;
	}

	/** The reader is on `place`: if that is where "Back" would go, there is nothing to go back to any more. */
	seen(place: NavPlace | null): void {
		const b = this.backPlace;
		if (b && place && b.path === place.path && b.pageId === place.pageId) {
			this.backPlace = null;
			this.changed();
		}
	}

	/** A tap on a tab: shows its page (switching notebook when it is in another one) and remembers where the reader was. */
	async open(view: QuickTabsViewApi, tab: QuickTab): Promise<void> {
		const from = view.place();
		const target = resolveTab(tab, { path: view.path(), pageIds: view.pageIds() });
		if (target.kind === "other") {
			const file = this.deps.app.vault.getFileByPath(tab.path);
			if (!file) {
				showNotice(t("quicktabs.missing", { path: tab.path }), 6000);
				return;
			}
			this.remember(from, { path: tab.path, pageId: tab.pageId });
			await this.openAt(file, tab.num, tab.pageId);
			return;
		}
		if (target.kind === "gone") showNotice(t("quicktabs.gone"), 6000);
		this.remember(from, { path: view.path() ?? "", pageId: view.pageIds()[target.index] ?? "" });
		view.jump(target.index);
	}

	/** "Back": returns to where the reader was before the last tap on a tab. */
	async goBack(view: QuickTabsViewApi): Promise<void> {
		const place = this.backPlace;
		if (!place) return;
		this.backPlace = null;
		this.changed();
		if (view.path() === place.path && view.show(place)) return;
		const file = this.deps.app.vault.getFileByPath(place.path);
		if (!file) {
			showNotice(t("quicktabs.missing", { path: place.path }), 6000);
			return;
		}
		await this.openAt(file, place.page, place.pageId);
	}

	private openAt(file: TFile, page: number, pageId: string): Promise<void> {
		return this.deps.openAt ? this.deps.openAt(file, page, pageId) : openNotebookAtPage(this.deps.app, file, page, null, pageId);
	}

	private remember(from: NavPlace | null, to: { path: string; pageId: string }): void {
		// Tapping the tab of the page you are on leaves "Back" as it was.
		if (!from || (from.path === to.path && from.pageId === to.pageId)) return;
		this.backPlace = from;
		this.changed();
	}

	private fail(e: unknown): void {
		if (e instanceof QuickTabsBlockedError && e.reason === "limit") {
			showNotice(t("quicktabs.limit", { n: String(QUICKTABS_MAX) }));
			return;
		}
		console.error("[notebook] quick tabs", e);
		showNotice(t("quicktabs.saveFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
	}
}
