/**
 * "Today's page" (0.15, roadmap O12): opens the daily notebook (made the first time, after a confirmation) at the page
 * whose header is today's date, adding that page if there is none, and optionally links it from today's daily note. The
 * page is found by its dated header (library/daily-logic.ts), so running it twice never adds a second page.
 */
import { moment, Modal, normalizePath, type App, type TFile } from "obsidian";
import { stablePageSubpath } from "../integration/page-links";
import { openNotebookAtPage } from "../integration/open";
import { t } from "../i18n";
import { AddPage } from "../model/history";
import { createDocument } from "../model/document";
import { PAGE_SIZES, PAPER_SPACING, type NotebookDocument } from "../model/types";
import type { NotebookSettings } from "../settings";
import { createNotebook } from "../storage/notebooks";
import { ensureFolder } from "../storage/vault-io";
import { modalShell, shellButton, shellNote } from "../ui/components/modal-shell";
import { buildLecturePage } from "../view/lecture-logic";
import { showNotice } from "../view/notice";
import { appendTaskLine } from "../model/selection-task";
import { applyDailyTemplate, dailyNotebookPath, dailyNotePath, findDatedPage, loadDailyTemplate, readDailyConfigFrom, withTodayLink, type DailyNoteConfig } from "./daily-logic";
import { waitForContext, type LooseSheetPlugin } from "./loose-sheet";
import { notebookBaseName, parentFolder } from "./loose-sheet-logic";

/** Cover colour of the daily notebook in the library (blue). */
const DAILY_COVER = "#3b82c4";

export type DailyPlugin = LooseSheetPlugin;

/** The first-use question. Resolves true on "Create", false when cancelled or closed. */
export function confirmCreate(app: App, path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		const shell = modalShell(modal, { title: t("daily.create.title"), icon: "calendar-plus", size: "narrow", cls: "notebook-daily-modal" });
		shellNote(shell.body, t("daily.create.body", { path }));
		shellButton(shell.foot, "secondary", t("lecture.cancel"), () => modal.close());
		shellButton(shell.foot, "primary", t("daily.create.button"), () => {
			finish(true);
			modal.close();
		});
		modal.onClose = () => {
			finish(false);
			modal.contentEl.empty();
		};
		modal.open();
	});
}

/** The daily notebook with today's page as its first page. */
function newDailyDocument(settings: NotebookSettings, date: Date): NotebookDocument {
	const base = PAGE_SIZES[settings.defaultPageSize];
	const size = settings.defaultLandscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
	const doc = createDocument(date, size, { kind: settings.defaultPaper, spacing: PAPER_SPACING[settings.defaultPaper] });
	doc.pages = [buildLecturePage(doc.pages[0], "", date)];
	if (doc.meta) doc.meta.cover = DAILY_COVER;
	return doc;
}

// ------------------------------------------------------------------------ the daily note

/**
 * Folder, format and template of the daily notes (see `readDailyConfigFrom`); anything unexpected gives null (then nothing
 * is linked and the user is told).
 */
export function readDailyConfig(app: App): DailyNoteConfig | null {
	try {
		return readDailyConfigFrom(app);
	} catch (e) {
		console.error("[notebook] daily notes settings", e);
	}
	return null;
}

/** How long a missing daily note is waited for before it is made, so a sync that is about to deliver it can arrive. */
export const DAILY_SETTLE_MS = 1500;

/**
 * The text a new daily note starts with: the Daily notes template (placeholders filled in) when one is configured. Null when
 * a template is configured but cannot be read: then the note is not made at all, because it would come out without it.
 */
async function newNoteText(app: App, cfg: DailyNoteConfig, notePath: string, date: Date): Promise<string | null> {
	if (!cfg.template) return "";
	const text = await loadDailyTemplate<TFile>({
		resolveLink: (link) => app.metadataCache.getFirstLinkpathDest(link, ""),
		byPath: (path) => app.vault.getFileByPath(path),
		read: (file) => app.vault.read(file),
		normalize: normalizePath,
	}, cfg.template);
	if (text === null) return null;
	try {
		const title = notePath.slice(notePath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
		return applyDailyTemplate(text, title, date, cfg.format, (d, pattern) => moment(d).format(pattern));
	} catch {
		return null;
	}
}

/**
 * Adds the link to today's page to the end of today's daily note, if it is not there already. The note is changed with
 * `vault.process` (atomic: nothing else in it is touched). A missing note is created only with `dailyCreateNote`.
 */
export async function linkFromDailyNote(app: App, settings: NotebookSettings, file: TFile, page: number, pageId: string, date: Date, settleMs: number = DAILY_SETTLE_MS): Promise<void> {
	const cfg = readDailyConfig(app);
	if (!cfg) {
		showNotice(t("daily.unavailable"), 7000);
		return;
	}
	const notePath = normalizePath(dailyNotePath(cfg, date, (d, pattern) => moment(d).format(pattern)));
	const iso = moment(date).format("YYYY-MM-DD");
	const make = (): string => app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(page, pageId), t("daily.linkAlias", { date: iso }));
	let note = app.vault.getFileByPath(notePath);
	if (!note) {
		if (!settings.dailyCreateNote) {
			showNotice(t("daily.noteMissing", { path: notePath }), 7000);
			return;
		}
		// The note may be on its way from another device: wait a moment and look again before making a second one.
		if (settleMs > 0) await new Promise<void>((r) => window.setTimeout(r, settleMs));
		note = app.vault.getFileByPath(notePath);
	}
	if (!note) {
		// The user's Daily notes template is applied; if one is set and cannot be read, no note is made without it.
		const start = await newNoteText(app, cfg, notePath, date);
		if (start === null) {
			showNotice(t("daily.templateMissing", { path: notePath }), 7000);
			return;
		}
		const dir = parentFolder(notePath);
		if (dir) await ensureFolder(app, dir);
		try {
			await app.vault.create(notePath, withTodayLink(start, make(), pageId) ?? start);
			showNotice(t("daily.linked", { path: notePath }));
			return;
		} catch {
			// Someone made it meanwhile (a sync, the Daily notes plugin): add to that one instead.
			note = app.vault.getFileByPath(notePath);
			if (!note) throw new Error(notePath);
		}
	}
	let changed = false;
	await app.vault.process(note, (text) => {
		const next = withTodayLink(text, make(), pageId);
		changed = next !== null;
		return next ?? text;
	});
	if (changed) showNotice(t("daily.linked", { path: notePath }));
}

// ------------------------------------------------------------------------ the command

let running: Promise<void> | null = null;

/**
 * "Today's page": opens the daily notebook at today's page, adding the page when it is missing. If the notebook cannot be
 * edited here (read-only, still loading) it is simply opened. Never throws: problems are reported in a notice.
 */
export function openTodaysPage(plugin: DailyPlugin, open: (file: TFile) => Promise<void>, now: Date = new Date()): Promise<void> {
	running ??= (async () => {
		const { app, settings } = plugin;
		try {
			const path = normalizePath(dailyNotebookPath(settings.folder, settings.dailyNotebookPath));
			let file = app.vault.getFileByPath(path);
			if (!file) {
				if (app.vault.getAbstractFileByPath(path)) throw new Error(t("daily.pathTaken", { path }));
				if (!(await confirmCreate(app, path))) return;
				const folder = parentFolder(path);
				if (folder) await ensureFolder(app, folder);
				file = await createNotebook(app, folder, notebookBaseName(path), newDailyDocument(settings, now));
			}
			await open(file);
			const ctx = await waitForContext(app, file);
			if (!ctx) return;
			let index = findDatedPage(ctx.doc.pages, now);
			if (index < 0) {
				const pages = ctx.doc.pages;
				ctx.execute(new AddPage(buildLecturePage(pages[pages.length - 1], "", now), pages.length), pages.length);
				index = findDatedPage(ctx.doc.pages, now);
			}
			if (index < 0) return;
			await openNotebookAtPage(app, file, index + 1);
			const page = ctx.doc.pages[index];
			if (settings.dailyLink && page) await linkFromDailyNote(app, settings, file, index + 1, page.id, now);
		} catch (e) {
			console.error("[notebook] today's page", e);
			showNotice(t("daily.failed", { error: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			running = null;
		}
	})();
	return running;
}

// ------------------------------------------------------------------------ 0.17 (#57): a task in the daily note

/**
 * Adds a task line to the end of the daily note of `date` and returns the note's path and whether the line was added (false:
 * that very line was already there, nothing was written); null when nothing was written (the reason is shown). Same rules as the page link: the note is changed with `vault.process` (the rest is untouched), and a missing
 * note is made only with `dailyCreateNote`, from the Daily notes template, after a moment's wait for a sync to deliver it.
 * `prepare` runs once the note is certain to be written (it stores the task's picture, which must not be left behind when
 * the note cannot be written) and returns the final line, or null to stop.
 */
export async function appendToDailyNote(
	app: App, settings: NotebookSettings, date: Date, prepare: (notePath: string) => Promise<string | null>, settleMs: number = DAILY_SETTLE_MS,
): Promise<{ path: string; added: boolean } | null> {
	const cfg = readDailyConfig(app);
	if (!cfg) {
		showNotice(t("daily.unavailable"), 7000);
		return null;
	}
	const notePath = normalizePath(dailyNotePath(cfg, date, (d, pattern) => moment(d).format(pattern)));
	let note = app.vault.getFileByPath(notePath);
	if (!note) {
		if (!settings.dailyCreateNote) {
			showNotice(t("daily.noteMissing", { path: notePath }), 7000);
			return null;
		}
		if (settleMs > 0) await new Promise<void>((r) => window.setTimeout(r, settleMs));
		note = app.vault.getFileByPath(notePath);
	}
	let start = "";
	if (!note) {
		const text = await newNoteText(app, cfg, notePath, date);
		if (text === null) {
			showNotice(t("daily.templateMissing", { path: notePath }), 7000);
			return null;
		}
		start = text;
	}
	const line = await prepare(notePath);
	if (line === null) return null;
	if (!note) {
		const dir = parentFolder(notePath);
		if (dir) await ensureFolder(app, dir);
		try {
			const created = appendTaskLine(start, line);
			await app.vault.create(notePath, created ?? start);
			return { path: notePath, added: created !== null };
		} catch {
			note = app.vault.getFileByPath(notePath); // made meanwhile (a sync, the Daily notes plugin): add to that one
			if (!note) throw new Error(notePath);
		}
	}
	let added = false;
	await app.vault.process(note, (text) => {
		const next = appendTaskLine(text, line);
		added = next !== null;
		return next ?? text;
	});
	return { path: notePath, added };
}
