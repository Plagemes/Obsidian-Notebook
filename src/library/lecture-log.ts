/**
 * Lecture log (0.19, roadmap #221): when a lecture session ends, one line about it goes into the daily note of the day, under
 * a configurable heading. The line is found again by its block id (`^nb-lec-<hash>`, one per notebook and class occurrence)
 * and rewritten in place if the session goes on later; nothing else in the note is touched (`vault.process`), and only the part
 * of the line the plugin generated is rewritten (a quote mark, a task box or words the user added stay). The daily note is made
 * only with `dailyCreateNote`; without it the line waits in this device's local storage (bounded) until the note exists.
 *
 * A written line is not forgotten at once: its entry stays in the waiting list until a later read of the note, a few seconds
 * on, shows the line. A template engine that fills a brand new daily note a moment after it was made would otherwise overwrite
 * the line unseen; then the line is written again, but only within two minutes of the write (a line the user deleted or moved
 * hours later, or after a restart, is not put back) and never into a note that is gone. Quiet by design: it never shows a
 * notice, a failure is only logged.
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
	addPending, buildLectureLine, lectureLogId, LECTURE_LOG_MAX_TRIES, LECTURE_LOG_PENDING_KEY, mergeLectureLine, normaliseLogHeading,
	normalisePending, ownLineState, removePending, type LectureSnapshot, type PendingLectureLine,
} from "./lecture-log-logic";
import { parentFolder } from "./loose-sheet-logic";

export interface LectureLogHost {
	app: App;
	settings: NotebookSettings;
}

type Outcome = "written" | "waiting";

/** How long a written line waits before a read of the note may confirm it, when the settle time is on (ms). */
const CONFIRM_MS = 5000;
/**
 * A line is confirmed only this soon after it was written (ms). Later (after a restart, an app suspended for hours) it counts as
 * settled: a line the user deleted or moved since is not written back, and no note is made for it.
 */
export const CONFIRM_WINDOW_MS = 2 * 60 * 1000;

export class LectureLogService {
	private queue: Promise<unknown> = Promise.resolve();
	/** The waiting list, read from local storage once (and again at each flush), so the vault events cost a set lookup. */
	private cache: PendingLectureLine[] | null = null;
	private paths = new Set<string>();
	private timer: number | null = null;
	private readonly confirmMs: number;

	constructor(private readonly plugin: LectureLogHost, private readonly settleMs: number = DAILY_SETTLE_MS) {
		this.confirmMs = settleMs > 0 ? Math.max(settleMs, CONFIRM_MS) : 0;
	}

	/**
	 * A lecture session ended or was left: writes (or updates) its line. Runs one at a time, never throws. `docId`: the
	 * notebook's document id, which keeps the line's identity when the notebook is renamed or moved.
	 */
	log(file: TFile, cls: LectureClass, snap: LectureSnapshot, docId?: string): Promise<void> {
		return this.enqueue(async () => {
			if (!this.plugin.settings.lectureLog) return;
			const entry = this.entryFor(file, cls, snap, docId);
			if (!entry) return;
			const outcome = await this.write(entry, null);
			const kept: PendingLectureLine = outcome === "written" ? { ...entry, wrote: Date.now() } : entry;
			this.setPending((list, today) => addPending(list, kept, today));
			if (outcome === "written") this.schedule(this.confirmMs);
			await this.flushNow(entry.id);
		});
	}

	/** Writes the lines that were waiting for their daily note, and confirms the ones written a while ago. */
	flushPending(): Promise<void> {
		return this.enqueue(async () => {
			this.cache = null;
			await this.flushNow(null);
		});
	}

	/** A note a line may be waiting for was made or changed: looks again once it has settled. Cheap for any other file. */
	noteChanged(path: string): void {
		this.pending();
		if (this.paths.has(path)) this.schedule(this.settleMs);
	}

	/** Paths of the daily notes lines are waiting for (to notice the note being made or changed). */
	waitingPaths(): string[] {
		this.pending();
		return [...this.paths];
	}

	/** Stops the timer (the plugin is unloading). */
	dispose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private schedule(ms: number): void {
		// Without a settle time (tests) nothing runs by itself: the caller flushes.
		if (this.settleMs <= 0 || this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flushPending();
		}, ms + 50);
	}

	private enqueue(job: () => Promise<void>): Promise<void> {
		const run = this.queue.then(job).catch((e) => console.error("[notebook] lecture log", e));
		this.queue = run;
		return run;
	}

	private entryFor(file: TFile, cls: LectureClass, snap: LectureSnapshot, docId?: string): PendingLectureLine | null {
		const { app } = this.plugin;
		const cfg = readDailyConfig(app);
		if (!cfg) return null;
		const date = new Date(cls.startsAt);
		const notePath = normalizePath(dailyNotePath(cfg, date, (d, pattern) => moment(d).format(pattern)));
		const id = lectureLogId(docId || file.path, cls.key);
		const pages = snap.first === snap.last ? t("lectureLog.page", { n: String(snap.first) }) : t("lectureLog.pages", { from: String(snap.first), to: String(snap.last) });
		const link = app.fileManager.generateMarkdownLink(file, notePath, stablePageSubpath(snap.first, snap.firstId), pages);
		const counts = [snap.pages === 1 ? t("lectureLog.count.page") : t("lectureLog.count.pages", { n: String(snap.pages) })];
		if (snap.openQuestions === 1) counts.push(t("lectureLog.count.question"));
		else if (snap.openQuestions > 1) counts.push(t("lectureLog.count.questions", { n: String(snap.openQuestions) }));
		const line = buildLectureLine({ start: cls.start, end: cls.end, course: cls.course, link, counts }, id);
		return { id, day: isoDay(date), notePath, line };
	}

	private pending(): PendingLectureLine[] {
		if (this.cache) return this.cache;
		let list: PendingLectureLine[] = [];
		try {
			list = normalisePending(this.plugin.app.loadLocalStorage(LECTURE_LOG_PENDING_KEY), isoDay(new Date()));
		} catch {
			list = [];
		}
		this.hold(list);
		return list;
	}

	private hold(list: PendingLectureLine[]): void {
		this.cache = list;
		this.paths = new Set(list.map((p) => p.notePath));
	}

	private setPending(change: (list: PendingLectureLine[], today: string) => PendingLectureLine[]): void {
		const next = change(this.pending(), isoDay(new Date()));
		this.hold(next);
		try {
			this.plugin.app.saveLocalStorage(LECTURE_LOG_PENDING_KEY, next);
		} catch {
			// A convenience: the line is then simply written the next time the session ends.
		}
	}

	/** Settles every waiting line except `skip` (just handled). Only while the setting is on. */
	private async flushNow(skip: string | null): Promise<void> {
		if (!this.plugin.settings.lectureLog) return;
		const today = isoDay(new Date());
		let again = false;
		for (const p of [...this.pending()]) {
			if (p.id === skip) {
				if (p.wrote !== undefined) again = true;
				continue;
			}
			if (p.wrote !== undefined) {
				if (await this.confirm(p, today)) again = true;
			} else if ((await this.write(p, today)) === "written") {
				this.setPending((list, now) => addPending(list, { ...p, wrote: Date.now() }, now));
				again = true;
			}
		}
		if (again) this.schedule(this.confirmMs);
	}

	/**
	 * A line written earlier: once it has had time to settle, a read of the note must show it. Removed from the list then; written
	 * again when the note lost it (a template overwrote the note) within CONFIRM_WINDOW_MS of the write, never later, and never into
	 * a note that is not there (a confirm makes no note). True while it still has to be looked at again.
	 */
	private async confirm(p: PendingLectureLine, today: string): Promise<boolean> {
		const age = Date.now() - (p.wrote ?? 0);
		if (age < this.confirmMs) return true;
		if (age > CONFIRM_WINDOW_MS) {
			// Too long ago to tell a template that overwrote the note from a line the user removed: settled, left as it is.
			this.setPending((list) => removePending(list, p.id));
			return false;
		}
		const note = this.plugin.app.vault.getFileByPath(p.notePath);
		if (!note) {
			this.setPending((list) => removePending(list, p.id));
			return false;
		}
		let seen = false;
		try {
			seen = ownLineState(await this.plugin.app.vault.read(note), p.id) !== "none";
		} catch {
			return true; // unreadable now: look again later
		}
		if (seen) {
			this.setPending((list) => removePending(list, p.id));
			return false;
		}
		const tries = (p.tries ?? 0) + 1;
		if (tries > LECTURE_LOG_MAX_TRIES) {
			console.warn("[notebook] lecture log: the line keeps disappearing from its daily note; giving up", p.notePath);
			this.setPending((list) => removePending(list, p.id));
			return false;
		}
		const outcome = await this.write(p, today, false);
		if (outcome !== "written") {
			this.setPending((list) => removePending(list, p.id)); // the note went away meanwhile: nothing to write into, nothing is made
			return false;
		}
		const next: PendingLectureLine = { id: p.id, day: p.day, notePath: p.notePath, line: p.line, tries, wrote: Date.now() };
		this.setPending((list, now) => addPending(list, next, now));
		return true;
	}

	/**
	 * Adds or updates the line in its daily note. "waiting": the note does not exist and may not be made (or has no usable
	 * template). `onlyDay`: a missing note is made only for that day (waiting lines of past days do not create notes the user
	 * never opened); null: any day.
	 */
	private async write(entry: PendingLectureLine, onlyDay: string | null, create = true): Promise<Outcome> {
		const { app, settings } = this.plugin;
		const heading = normaliseLogHeading(settings.lectureLogHeading);
		let note = app.vault.getFileByPath(entry.notePath);
		if (!note) {
			// (`create` false, for a line written again by a confirm: a missing note is never made)
			if (!create || !settings.dailyCreateNote || (onlyDay !== null && entry.day !== onlyDay)) return "waiting";
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
		let altered = false;
		await app.vault.process(note, (text) => {
			if (ownLineState(text, entry.id) === "altered") {
				altered = true;
				return text; // the user turned the line into something else: nothing is rewritten and nothing is added
			}
			return mergeLectureLine(text, heading, entry.line, entry.id) ?? text;
		});
		if (altered) console.warn("[notebook] lecture log: the line was changed by hand, left as it is", entry.notePath);
		return "written";
	}
}
