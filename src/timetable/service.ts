import { Notice, Vault, TFile, TFolder, type App, type Plugin } from "obsidian";
import { t } from "../i18n";
import { openNotebookAtPage, viewsOf } from "../integration/open";
import { writing } from "../ink/writing-guard";
import { createDocument } from "../model/document";
import { PAGE_SIZES, PAPER_SPACING } from "../model/types";
import type { NotebookSettings } from "../settings";
import { createNotebook, listNotebooks } from "../storage/notebooks";
import { isEditContextSource, type EditContext } from "../view/edit-context";
import { addLecturePage } from "../view/lecture";
import { setLectureCourseProvider } from "./current";
import { findLecturePage } from "./lecture-open";
import {
	classesAt, courseForNotebook, emptyTimetable, occurrenceKey, pickTarget, type ClassEntry, type OpenTarget, type Timetable,
} from "./schedule";
import { TimetableStore } from "./store";
import { TimetableModal } from "./timetable-modal";

export interface TimetablePlugin extends Plugin {
	settings: NotebookSettings;
}

/** What the library shows next to the "Now" shortcut. */
export interface NowClass {
	course: string;
	room?: string;
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Class timetable at runtime: keeps the parsed file in memory (reloaded when the file changes, also by sync),
 * answers "which class is on now", offers/opens the class's notebook at a new lecture page, and opens the editor.
 */
export class TimetableService {
	private timetable: Timetable = emptyTimetable();
	private loadError: string | null = null;
	/** The file's text as last read (null: no file), the base of the next edit. */
	private loadedText: string | null = null;
	private readonly store: TimetableStore;
	/** Occurrences already offered in this session, so closing the notice does not bring it back. */
	private readonly offered = new Set<string>();
	private opening = false;

	constructor(private readonly plugin: TimetablePlugin, private readonly open: (file: TFile) => Promise<void>) {
		this.store = new TimetableStore(plugin.app, () => plugin.settings.folder);
	}

	private get app(): App {
		return this.plugin.app;
	}

	/** Loads the file, follows its changes, tells "New lecture" about the current class and offers it once the workspace is ready. */
	start(): void {
		const watch = (f: { path: string }) => {
			if (f.path === this.store.path()) void this.reload();
		};
		this.plugin.registerEvent(this.app.vault.on("create", watch));
		this.plugin.registerEvent(this.app.vault.on("modify", watch));
		this.plugin.registerEvent(this.app.vault.on("delete", watch));
		this.plugin.registerEvent(this.app.vault.on("rename", (f, old) => {
			watch(f);
			watch({ path: old });
		}));
		setLectureCourseProvider((path) => {
			const now = new Date();
			return courseForNotebook(classesAt(this.timetable, now, this.lead()), path, this.timetable.entries);
		});
		void this.reload();
		this.app.workspace.onLayoutReady(() => void this.reload().then(() => this.offer()));
	}

	stop(): void {
		setLectureCourseProvider(null);
	}

	private lead(): number {
		return this.plugin.settings.timetableLeadMinutes;
	}

	async reload(): Promise<void> {
		const r = await this.store.load();
		this.loadedText = r.text;
		if (r.ok) {
			this.timetable = r.timetable;
			this.loadError = null;
		} else {
			// Keep what was in memory; the file itself is never touched.
			this.loadError = r.error;
			console.error("[notebook] timetable unreadable", r.error);
		}
	}

	/** The class in progress (or about to start, see the lead setting). */
	current(now = new Date()): ClassEntry | null {
		return classesAt(this.timetable, now, this.lead())[0] ?? null;
	}

	nowClass(): NowClass | null {
		const c = this.current();
		return c ? { course: c.course, room: c.room } : null;
	}

	/**
	 * 0.13 (Home's Continue card): the class in progress and what tapping it opens: the notebook it is linked to, or the
	 * latest one of the course's linked folder, or (when there is none yet) where a new notebook for the course will be made.
	 * The same choice `openClass` makes, without opening or creating anything.
	 */
	nowTarget(now = new Date()): { course: string; room?: string; target: OpenTarget } | null {
		const c = this.current(now);
		if (!c) return null;
		const folder = this.plugin.settings.folder;
		const books = listNotebooks(this.app, folder).map((f) => ({ path: f.path, basename: f.basename, mtime: f.stat.mtime }));
		return { course: c.course, room: c.room, target: pickTarget(c, books, folder) };
	}

	/** Opens the notebook of the class in progress at a new lecture page. */
	openNow(): void {
		const c = this.current();
		if (!c) {
			new Notice(t("timetable.noneNow"));
			return;
		}
		void this.openClass(c);
	}

	/** Offers (or, with the setting, performs) opening the current class; once per class and day in a session. */
	async offer(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.timetableOffer) return;
		const now = new Date();
		const c = this.current(now);
		if (!c) return;
		const key = occurrenceKey(c, now);
		if (this.offered.has(key)) return;
		this.offered.add(key);
		if (s.timetableAutoOpen) {
			await this.openClass(c);
			return;
		}
		const room = c.room ? t("timetable.offer.room", { room: c.room }) : "";
		// Wave 0.8 (374): never while the pen is on the screen; the offer appears at the first pause.
		writing.whenQuiet(() => {
			const notice = new Notice("", 15000);
			notice.messageEl.createSpan({ text: `${t("timetable.offer", { course: c.course, room })} ` });
			const button = notice.messageEl.createEl("button", { text: t("timetable.offer.open"), cls: "mod-cta" });
			button.addEventListener("click", () => {
				notice.hide();
				void this.openClass(c);
			});
		});
	}

	/**
	 * Opens the class's notebook (creating it when there is none) and adds today's lecture page: header with the
	 * course and date, as "New lecture" does. A page that already has this header is shown instead of adding another.
	 */
	async openClass(entry: ClassEntry, now = new Date()): Promise<void> {
		if (this.opening) return;
		this.opening = true;
		try {
			const folder = this.plugin.settings.folder;
			const books = listNotebooks(this.app, folder).map((f) => ({ path: f.path, basename: f.basename, mtime: f.stat.mtime }));
			const target = pickTarget(entry, books, folder);
			const file = target.kind === "open"
				? this.app.vault.getFileByPath(target.path)
				: await createNotebook(this.app, target.folder, target.name, this.newDocument());
			if (!file) throw new Error(target.kind === "open" ? target.path : "no file");
			await this.open(file);
			const ctx = await this.waitForContext(file);
			if (!ctx) throw new Error("the notebook is read-only or could not be opened for editing");
			const existing = findLecturePage(ctx.doc.pages, entry.course, now);
			if (existing >= 0) {
				await openNotebookAtPage(this.app, file, existing + 1);
				new Notice(t("timetable.alreadyThere", { course: entry.course }));
				return;
			}
			addLecturePage(ctx, entry.course, now, entry.course);
			new Notice(t("timetable.opened", { course: entry.course }));
		} catch (e) {
			console.error("[notebook] open class", e);
			new Notice(t("timetable.openFailed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			this.opening = false;
		}
	}

	private newDocument() {
		const s = this.plugin.settings;
		const base = PAGE_SIZES[s.defaultPageSize];
		const size = s.defaultLandscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
		return createDocument(new Date(), size, { kind: s.defaultPaper, spacing: PAPER_SPACING[s.defaultPaper] });
	}

	/** The notebook view loads asynchronously: wait (up to 8 s) for an editable document. */
	private async waitForContext(file: TFile): Promise<EditContext | null> {
		for (let i = 0; i < 80; i++) {
			for (const { view } of viewsOf(this.app, file)) {
				if (isEditContextSource(view)) {
					const ctx = view.editContext();
					if (ctx) return ctx;
				}
			}
			await wait(100);
		}
		return null;
	}

	/** Notebooks and folders of the notebooks folder, as suggestions for the "linked notebook" field. */
	linkChoices(): string[] {
		const root = this.app.vault.getFolderByPath(this.plugin.settings.folder.replace(/\/+$/, "") || "/");
		const out: string[] = [];
		if (root) {
			Vault.recurseChildren(root, (f) => {
				if (f instanceof TFolder && f !== root && !/(^|\/)_(assets|backup)(\/|$)/.test(f.path)) out.push(f.path);
			});
		}
		for (const f of listNotebooks(this.app, this.plugin.settings.folder)) out.push(f.path);
		return out.sort((a, b) => a.localeCompare(b));
	}

	/** The timetable has at least one class (the settings tab opens its group then). */
	hasClasses(): boolean {
		return this.timetable.entries.length > 0;
	}

	path(): string {
		return this.store.path();
	}

	async edit(): Promise<void> {
		await this.reload();
		new TimetableModal(this.app, {
			store: this.store,
			timetable: this.timetable,
			loadError: this.loadError,
			base: this.loadedText,
			choices: this.linkChoices(),
			saved: (tt) => {
				this.timetable = tt;
				this.loadError = null;
			},
		}).open();
	}
}
