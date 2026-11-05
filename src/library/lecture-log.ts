/**
 * Lecture log (0.19, roadmap #221): when a lecture session ends, one line about it goes into the daily note of the day, under
 * a configurable heading. The line is found again by its block id (`^nb-lec-<hash>`, one per notebook and class occurrence)
 * and rewritten in place if the session goes on later; nothing else in the note is touched (`vault.process`). The daily note
 * is made only with `dailyCreateNote`; without it the line waits in this device's local storage (bounded) until the note
 * exists. Quiet by design: it never shows a notice, a failure is only logged.
 */
import { moment, normalizePath, type App, type TFile } from "obsidian";
import { stablePageSubpath } from "../integration/page-links";
import { t } from "../i18n";
import type { NotebookSettings } from "../settings";
import { recordPluginWrite } from "../storage/plugin-written";
import { ensureFolder } from "../storage/vault-io";
import { isoDay } from "../timetable/schedule";
import type { LectureClass } from "../timetable/lecture-mode";
import { DAILY_SETTLE_MS, newNoteText, readDailyConfig } from "./daily";
import { dailyNotePath } from "./daily-logic";
import {
	addPending, buildLectureLine, lectureLogId, LECTURE_LOG_PENDING_KEY, mergeLectureLine, normaliseLogHeading, normalisePending,
	removePending, type LectureSnapshot, type PendingLectureLine,
} from "./lecture-log-logic";
import { parentFolder } from "./loose-sheet-logic";

export interface LectureLogHost {
	app: App;
	settings: NotebookSettings;
}

type Outcome = "written" | "waiting";

export class LectureLogService {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly plugin: LectureLogHost, private readonly settleMs: number = DAILY_SETTLE_MS) {}

	/** A lecture session ended or was left: writes (or updates) its line. Runs one at a time, never throws. */
	log(file: TFile, cls: LectureClass, snap: LectureSnapshot): Promise<void> {
		return this.enqueue(async () => {
			if (!this.plugin.settings.lectureLog) return;
			const entry = this.entryFor(file, cls, snap);
			if (!entry) return;
			const outcome = await this.write(entry);
			this.setPending(outcome === "waiting" ? (list, today) => addPending(list, entry, today) : (list) => removePending(list, entry.id));
			await this.flushNow(entry.id);
		});
	}

	/** Writes the lines that were waiting for their daily note, for the notes that exist now (or may be made). */
	flushPending(): Promise<void> {
		return this.enqueue(() => this.flushNow(null));
	}

	/** Paths of the daily notes lines are waiting for (to notice the note being made). */
	waitingPaths(): string[] {
		return this.pending().map((p) => p.notePath);
	}

	private enqueue(job: () => Promise<void>): Promise<void> {
		const run = this.queue.then(job).catch((e) => console.error("[notebook] lecture log", e));
		this.queue = run;
		return run;
	}

	private entryFor(file: TFile, cls: LectureClass, snap: LectureSnapshot): PendingLectureLine | null {
		const { app } = this.plugin;
		const cfg = readDailyConfig(app);
		if (!cfg) return null;
		const date = new Date(cls.startsAt);
		const notePath = normalizePath(dailyNotePath(cfg, date, (d, pattern) => moment(d).format(pattern)));
		const id = lectureLogId(file.path, cls.key);
		const pages = snap.first === snap.last ? t("lectureLog.page", { n: String(snap.first) }) : t("lectureLog.pages", { from: String(snap.first), to: String(snap.last) });
		const link = app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(snap.first, snap.firstId), pages);
		const counts = [snap.pages === 1 ? t("lectureLog.count.page") : t("lectureLog.count.pages", { n: String(snap.pages) })];
		if (snap.openQuestions === 1) counts.push(t("lectureLog.count.question"));
		else if (snap.openQuestions > 1) counts.push(t("lectureLog.count.questions", { n: String(snap.openQuestions) }));
		const line = buildLectureLine({ start: cls.start, end: cls.end, course: cls.course, link, counts }, id);
		return { id, day: isoDay(date), notePath, line };
	}

	private pending(): PendingLectureLine[] {
		try {
			return normalisePending(this.plugin.app.loadLocalStorage(LECTURE_LOG_PENDING_KEY), isoDay(new Date()));
		} catch {
			return [];
		}
	}

	private setPending(change: (list: PendingLectureLine[], today: string) => PendingLectureLine[]): void {
		try {
			const today = isoDay(new Date());
			this.plugin.app.saveLocalStorage(LECTURE_LOG_PENDING_KEY, change(this.pending(), today));
		} catch {
			// A convenience: the line is then simply written the next time the session ends.
		}
	}

	/** Tries every waiting line except `skip` (just handled). Only while the setting is on. */
	private async flushNow(skip: string | null): Promise<void> {
		if (!this.plugin.settings.lectureLog) return;
		for (const p of this.pending()) {
			if (p.id === skip) continue;
			if ((await this.write(p)) === "written") this.setPending((list) => removePending(list, p.id));
		}
	}

	/** Adds or updates the line in its daily note. "waiting": the note does not exist and may not be made (or has no usable template). */
	private async write(entry: PendingLectureLine): Promise<Outcome> {
		const { app, settings } = this.plugin;
		const heading = normaliseLogHeading(settings.lectureLogHeading);
		let note = app.vault.getFileByPath(entry.notePath);
		if (!note) {
			if (!settings.dailyCreateNote) return "waiting";
			// The note may be on its way from another device: wait a moment and look again before making a second one.
			if (this.settleMs > 0) await new Promise<void>((r) => window.setTimeout(r, this.settleMs));
			note = app.vault.getFileByPath(entry.notePath);
		}
		if (!note) {
			const cfg = readDailyConfig(app);
			if (!cfg) return "waiting";
			const [y, m, d] = entry.day.split("-").map(Number) as [number, number, number];
			const start = await newNoteText(app, cfg, entry.notePath, new Date(y, m - 1, d, 12));
			if (start === null) return "waiting";
			const dir = parentFolder(entry.notePath);
			if (dir) await ensureFolder(app, dir);
			try {
				await app.vault.create(entry.notePath, mergeLectureLine(start, heading, entry.line, entry.id) ?? start);
				recordPluginWrite(app, [entry.notePath]);
				return "written";
			} catch {
				note = app.vault.getFileByPath(entry.notePath); // made meanwhile (a sync, the Daily notes plugin): add to that one
				if (!note) throw new Error(entry.notePath);
			}
		}
		await app.vault.process(note, (text) => mergeLectureLine(text, heading, entry.line, entry.id) ?? text);
		return "written";
	}
}
