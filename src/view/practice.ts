/**
 * "Redo this exercise" (roadmap #303, wave 0.9): the plugin-side service and the commands.
 *
 * - *Redo this exercise…* hides some of the ink of a page (all of it, some colours or tools, or the lasso selection) in a
 *   practice copy of the page: right after it, or in an "exercises" notebook. The copy is one undo step in the notebook it
 *   goes to. PDF and image backgrounds, text boxes and images stay.
 * - The copy is tagged `practice` and `attempt/<n>` (page tags: no format change) and linked to the original through
 *   `<notebooks folder>/_meta/practice-<device>.json` (model/practice.ts, storage/practice-store.ts), written only by the actions
 *   here (redo, the timer's stop). A notebook is found again by its document id, so renaming or moving it keeps the link.
 * - On a practice page a small banner (practice-banner.ts) offers *Peek at the solution* (hold), *Original*, *Attempts* and
 *   the optional timer.
 *
 * The rules (what is hidden, numbering, file format) are pure and tested in model/practice.ts; this file is the glue with
 * Obsidian: dialogs, notices, vault files, opening notebooks.
 */
import { Notice, type App, type Plugin, type TFile } from "obsidian";
import { t } from "../i18n";
import { AddPage } from "../model/history";
import {
	attemptsOf, buildPracticePage, elapsedSeconds, insertIndexAfter, MAX_REGION_STROKES, newRecord, nextAttemptNumber,
	peekStrokes, recordOf, type AttemptRecord, type PageRef, type PracticeData,
} from "../model/practice";
import { parse } from "../model/serialize";
import type { NotebookDocument, Page, Stroke } from "../model/types";
import { openNotebookAtPage } from "../integration/open";
import type { NotebookSettings } from "../settings";
import { readNotebookText } from "../storage/format";
import { PracticeBlockedError, PracticeStore } from "../storage/practice-store";
import { sidecarDeviceId, vaultDeviceFileAdapter } from "../storage/vault-io";
import { PracticeBanner } from "./practice-banner";
import { askRedo, attemptRows, loadPracticePrefs, showAttempts } from "./practice-modal";
import { addCopyToExercises, findExercisesNotebook, findNotebookByDocId } from "./practice-target";
import type { PracticeHooks, PracticeProvider, PracticeViewHost } from "./practice-types";
import type { NotebookView } from "./notebook-view";

export interface PracticePlugin extends Plugin {
	settings: NotebookSettings;
}

/** A page found again from a reference: its notebook (null = the document of the view that asked) and its place in it. */
interface Located {
	file: TFile | null;
	index: number;
	page: Page;
	doc: NotebookDocument;
}

interface Timer {
	startedAt: number;
	/** Document the page is in, to stop its timers when its view closes. */
	doc: string;
}

export class PracticeService implements PracticeProvider {
	private readonly store: PracticeStore;
	private readonly timers = new Map<string, Timer>();
	private readonly controllers = new Set<PracticeController>();
	private readonly parsed = new Map<string, { mtime: number; doc: NotebookDocument }>();
	private warned = false;

	constructor(private readonly plugin: PracticePlugin) {
		this.store = new PracticeStore(vaultDeviceFileAdapter(plugin.app), () => plugin.settings.folder, sidecarDeviceId(plugin.app));
	}

	get app(): App {
		return this.plugin.app;
	}

	start(): void {
		const { vault, workspace } = this.app;
		const changed = (file: { path: string }) => {
			if (this.store.watches(file.path)) void this.reload();
		};
		this.plugin.registerEvent(vault.on("modify", changed));
		this.plugin.registerEvent(vault.on("create", changed));
		this.plugin.registerEvent(vault.on("delete", changed));
		workspace.onLayoutReady(() => void this.reload());
	}

	attach(host: PracticeViewHost): PracticeHooks {
		const controller = new PracticeController(this, host, () => this.controllers.delete(controller));
		this.controllers.add(controller);
		return controller;
	}

	// --- the sidecar ---

	data(): PracticeData {
		return this.store.snapshot();
	}

	/** Reads the sidecar again (it may have synced) and tells the open views. A file that cannot be read is reported once. */
	async reload(): Promise<PracticeData | null> {
		try {
			const data = await this.store.load();
			// Files of other devices (or this one) that cannot be read are left as they are; said once.
			if (this.store.unreadable.length > 0) this.reportBlocked(new PracticeBlockedError(this.store.unreadable.join("; "), "format"));
			else this.warned = false;
			for (const c of this.controllers) c.refresh();
			return data;
		} catch (e) {
			this.reportBlocked(e);
			return null;
		}
	}

	private reportBlocked(e: unknown): void {
		if (e instanceof PracticeBlockedError) {
			if (!this.warned) new Notice(t("practice.fileBlocked", { error: e.message }), 10000);
			this.warned = true;
		} else console.error("[notebook] practice file", e);
	}

	/** Applies a change to the sidecar. False (with a notice) when it could not be written. */
	async write(op: Parameters<PracticeStore["update"]>[0]): Promise<boolean> {
		try {
			await this.store.update(op);
			for (const c of this.controllers) c.refresh();
			return true;
		} catch (e) {
			this.reportBlocked(e);
			if (!(e instanceof PracticeBlockedError)) new Notice(t("practice.writeFailed", { error: e instanceof Error ? e.message : String(e) }), 10000);
			return false;
		}
	}

	// --- finding pages ---

	/** The notebook and page a reference points to, or null when either is gone. The view's own document is used as is (it is the live one). */
	async locate(host: PracticeViewHost, ref: PageRef): Promise<Located | null> {
		const own = host.doc();
		if (own && own.id === ref.doc) {
			const index = own.pages.findIndex((p) => p.id === ref.page);
			return index >= 0 ? { file: host.file, index, page: own.pages[index]!, doc: own } : null;
		}
		const file = await findNotebookByDocId(this.app, this.plugin.settings.folder, ref);
		if (!file) return null;
		let entry = this.parsed.get(file.path);
		if (!entry || entry.mtime !== file.stat.mtime) {
			const result = parse(readNotebookText(file.extension, await this.app.vault.cachedRead(file)));
			if (!result.ok) return null;
			entry = { mtime: file.stat.mtime, doc: result.doc };
			this.parsed.set(file.path, entry);
		}
		const index = entry.doc.pages.findIndex((p) => p.id === ref.page);
		return index >= 0 ? { file, index, page: entry.doc.pages[index]!, doc: entry.doc } : null;
	}

	/** Shows a located page: scrolls when it is in the view's own notebook, opens the notebook otherwise. */
	async show(host: PracticeViewHost, where: Located): Promise<void> {
		if (!where.file || where.file === host.file) host.goToPage(where.index);
		else await openNotebookAtPage(this.app, where.file, where.index + 1);
	}

	// --- timer ---

	timerRunning(pageId: string): number | null {
		return this.timers.get(pageId)?.startedAt ?? null;
	}

	startTimer(pageId: string, doc: string): void {
		if (!this.timers.has(pageId)) this.timers.set(pageId, { startedAt: Date.now(), doc });
	}

	/** Stops the timer and adds the time to the attempt's record. */
	async stopTimer(pageId: string): Promise<number> {
		const timer = this.timers.get(pageId);
		if (!timer) return 0;
		this.timers.delete(pageId);
		const seconds = elapsedSeconds(timer.startedAt, Date.now());
		if (seconds > 0) await this.write({ type: "addSeconds", practicePage: pageId, seconds });
		return seconds;
	}

	/** The view of a notebook closes: its running timers stop and are saved. */
	stopTimersOf(doc: string): void {
		for (const [pageId, timer] of this.timers) if (timer.doc === doc) void this.stopTimer(pageId);
	}

	// --- redo ---

	async redo(host: PracticeViewHost, index: number): Promise<void> {
		const ctx = host.editContext();
		if (!ctx) {
			new Notice(t("practice.busy"));
			return;
		}
		const doc = ctx.doc;
		const here = doc.pages[index];
		if (!here) return;
		const data = await this.reload();
		if (!data) return;

		// A practice page is redone from the page it came from, so every attempt of an exercise starts from the same sheet.
		const rec = recordOf(data, here.id, doc.id);
		let original: { page: Page; ref: PageRef } = { page: here, ref: { doc: doc.id, page: here.id, ...(host.file ? { path: host.file.path } : {}) } };
		if (rec) {
			const found = await this.locate(host, rec.original);
			if (found) original = { page: found.page, ref: { ...rec.original, ...(found.file ? { path: found.file.path } : {}) } };
			else new Notice(t("practice.originalGone"), 8000);
		}
		const fromCopy = rec !== null && original.page !== here;

		const selected = host.selectedStrokes();
		const selection = !fromCopy && selected && selected.pageIndex === index && selected.strokes.length > 0
			&& selected.strokes.length <= MAX_REGION_STROKES ? selected.strokes.map((s) => s.id) : null;
		const attempt = nextAttemptNumber(data, original.ref);
		const prefs = loadPracticePrefs(this.app);
		const exercisesFile = findExercisesNotebook(this.app, this.plugin.settings.folder, prefs.exercises);
		const choice = await askRedo(this.app, {
			page: original.page,
			attempt,
			selection,
			canNotebook: !(exercisesFile && host.file && exercisesFile.path === host.file.path),
		});
		if (!choice) return;

		const now = host.editContext();
		if (!now || now.doc !== doc || !now.alive()) {
			new Notice(t("practice.busy"));
			return;
		}
		// The numbering is read again: another device may have added an attempt while the dialog was open.
		const fresh = (await this.reload()) ?? data;
		const n = nextAttemptNumber(fresh, original.ref);
		const copy = buildPracticePage(original.page, choice.spec, n);
		const origin: PageRef = original.ref;
		let target: { file: TFile | null; index: number; docId: string };
		try {
			if (choice.target === "notebook") {
				target = await addCopyToExercises(this.app, this.plugin.settings, doc, copy.page, choice.exercises);
			} else {
				const at = insertIndexAfter(index, doc.pages.length);
				now.execute(new AddPage(copy.page, at), at);
				target = { file: host.file, index: at, docId: doc.id };
			}
		} catch (e) {
			console.error("[notebook] practice copy", e);
			new Notice(t("practice.failed", { error: e instanceof Error ? e.message : String(e) }), 10000);
			return;
		}

		const record = newRecord({
			practice: { doc: target.docId, page: copy.page.id, ...(target.file ? { path: target.file.path } : {}) },
			original: origin,
			n,
			hide: choice.spec,
		});
		const linked = await this.write({ type: "add", record });
		new Notice(t(linked ? "practice.done" : "practice.doneUnlinked", { n: String(n), hidden: String(copy.hidden) }), 8000);
		if (choice.target === "notebook" && target.file) {
			await openNotebookAtPage(this.app, target.file, target.index + 1);
		}
	}

	/** The reference to the exercise a page belongs to: the original of its record, or the page itself. */
	rootOf(host: PracticeViewHost, pageId: string): { ref: PageRef; record: AttemptRecord | null } | null {
		const doc = host.doc();
		if (!doc) return null;
		const record = recordOf(this.data(), pageId, doc.id);
		if (record) return { ref: record.original, record };
		const page = doc.pages.find((p) => p.id === pageId);
		return page ? { ref: { doc: doc.id, page: page.id }, record: null } : null;
	}

	/** Strokes to show over a practice page while peeking: the original's ink that the record hid. Null when the original is gone. */
	async peekFor(host: PracticeViewHost, record: AttemptRecord): Promise<Stroke[] | null> {
		const found = await this.locate(host, record.original);
		return found ? peekStrokes(found.page, record.hide) : null;
	}

	async goToOriginal(host: PracticeViewHost): Promise<void> {
		const doc = host.doc();
		const page = doc?.pages[host.currentPage()];
		if (!doc || !page) return;
		await this.reload();
		const record = recordOf(this.data(), page.id, doc.id);
		if (!record) {
			new Notice(t("practice.notPractice"));
			return;
		}
		const found = await this.locate(host, record.original);
		if (!found) {
			new Notice(t("practice.originalGone"), 8000);
			return;
		}
		await this.show(host, found);
	}

	async attempts(host: PracticeViewHost): Promise<void> {
		const doc = host.doc();
		const page = doc?.pages[host.currentPage()];
		if (!doc || !page) return;
		await this.reload();
		const root = this.rootOf(host, page.id);
		if (!root) return;
		const list = attemptsOf(this.data(), root.ref);
		if (list.length === 0) {
			new Notice(t("practice.noAttempts"));
			return;
		}
		const go = async (ref: PageRef): Promise<void> => {
			const found = await this.locate(host, ref);
			if (found) await this.show(host, found);
			else new Notice(t("practice.pageGone"), 8000);
		};
		showAttempts(this.app, t("practice.attempts.title"), attemptRows(list, page.id, (target) => void go(target === "original" ? root.ref : target.practice)));
	}
}

/** Per view: the banner, the peek and the commands' entry points. */
class PracticeController implements PracticeHooks {
	private readonly banner: PracticeBanner;
	private lastKey = "";
	/** Document of the view as last seen: the session is already closed when the view calls `destroy`. */
	private docId: string | null = null;

	constructor(private readonly service: PracticeService, private readonly host: PracticeViewHost, private readonly onDestroy: () => void) {
		this.banner = new PracticeBanner(service, host);
	}

	page(): void {
		const doc = this.host.doc();
		if (doc) this.docId = doc.id;
		const page = doc?.pages[this.host.currentPage()];
		// Called on every scroll frame: nothing to do while the page, its tags and the sidecar are the ones already shown.
		const key = page ? `${page.id}|${(page.tags ?? []).join(",")}|${this.service.data().attempts.length}` : "";
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.banner.show(page ?? null);
	}

	loaded(): void {
		this.lastKey = "";
		this.page();
	}

	refresh(): void {
		this.lastKey = "";
		this.page();
	}

	redo(index = this.host.currentPage()): Promise<void> {
		return this.service.redo(this.host, index);
	}

	goToOriginal(): Promise<void> {
		return this.service.goToOriginal(this.host);
	}

	attempts(): Promise<void> {
		return this.service.attempts(this.host);
	}

	togglePeek(): void {
		this.banner.togglePeek();
	}

	toggleTimer(): void {
		this.banner.toggleTimer();
	}

	destroy(): void {
		this.banner.destroy();
		if (this.docId) this.service.stopTimersOf(this.docId);
		this.onDestroy();
	}
}

type WithView = (checking: boolean, run: (view: NotebookView) => void) => boolean;

/** Commands of the practice feature; they work on the active notebook view. */
export function registerPracticeCommands(plugin: Plugin, withView: WithView): void {
	const add = (id: string, name: Parameters<typeof t>[0], run: (hooks: PracticeHooks) => void): void => {
		plugin.addCommand({
			id,
			name: t(name),
			checkCallback: (checking) => withView(checking, (view) => {
				const hooks = view.practiceHooks;
				if (hooks) run(hooks);
			}),
		});
	};
	add("practice-redo", "command.practiceRedo", (h) => void h.redo());
	add("practice-peek", "command.practicePeek", (h) => h.togglePeek());
	add("practice-original", "command.practiceOriginal", (h) => void h.goToOriginal());
	add("practice-attempts", "command.practiceAttempts", (h) => void h.attempts());
	add("practice-timer", "command.practiceTimer", (h) => h.toggleTimer());
}
