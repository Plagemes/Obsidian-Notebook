/**
 * Automatic lecture mode (0.14, roadmap 401, extends the timetable of 115): pure rules, no DOM and no 'obsidian'.
 *
 * Lecture mode is a state of one notebook view: while a class of the timetable is in progress and the notebook belongs to
 * that class, the view can switch to the lecture tools (the contextual lecture bar), offered or automatic depending on
 * the `lectureMode` setting, and leaves them when the class ends. The view-side controller (view/lecture-mode.ts) feeds
 * `stepLectureMode` with the facts and carries out the answer; nothing here touches the document.
 */
import {
	classesAt, linkCovers, occurrenceKey, parseTime, pickTarget,
	type ClassEntry, type NotebookRef, type Timetable,
} from "./schedule";

/** `off`: never on its own (the command still works); `ask`: a small banner offers it; `auto`: it starts by itself. */
export const LECTURE_MODE_SETTINGS = ["off", "ask", "auto"] as const;
export type LectureModeSetting = (typeof LECTURE_MODE_SETTINGS)[number];

export interface LectureSettings {
	lectureMode: LectureModeSetting;
}

export const DEFAULT_LECTURE_SETTINGS: Readonly<LectureSettings> = { lectureMode: "ask" };

/** Reads the lecture settings from saved plugin data, ignoring values of the wrong type. */
export function readLectureSettings(d: Record<string, unknown>): LectureSettings {
	const s: LectureSettings = { ...DEFAULT_LECTURE_SETTINGS };
	if (LECTURE_MODE_SETTINGS.includes(d.lectureMode as LectureModeSetting)) s.lectureMode = d.lectureMode as LectureModeSetting;
	return s;
}

/** One occurrence of a class, with everything the view needs to offer lecture mode, fill a page and know when it ends. */
export interface LectureClass {
	/** `occurrenceKey`: the class and the day. */
	key: string;
	course: string;
	room?: string;
	lecturer?: string;
	/** `HH:MM`. */
	start: string;
	end: string;
	/** Epoch ms of the start and end of this occurrence (local wall-clock times). */
	startsAt: number;
	endsAt: number;
}

/** The occurrence of `entry` that falls on the day of `now`. */
export function lectureClassOf(entry: ClassEntry, now: Date): LectureClass {
	const at = (hhmm: string): number => {
		const m = parseTime(hhmm) ?? 0;
		return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(m / 60), m % 60, 0, 0).getTime();
	};
	const out: LectureClass = { key: occurrenceKey(entry, now), course: entry.course, start: entry.start, end: entry.end, startsAt: at(entry.start), endsAt: at(entry.end) };
	if (entry.room) out.room = entry.room;
	if (entry.lecturer) out.lecturer = entry.lecturer;
	return out;
}

/**
 * The class belongs to this notebook: the notebook is the one it links to (or inside the folder it links to), or the class
 * is unlinked and its course resolves to this notebook (the one named like the course). An unlinked class never claims
 * every notebook that happens to be open.
 */
export function classCoversNotebook(entry: ClassEntry, path: string, notebooks: readonly NotebookRef[], root: string): boolean {
	if (entry.notebook) return linkCovers(entry.notebook.replace(/\/+$/, ""), path);
	const target = pickTarget(entry, notebooks, root);
	return target.kind === "open" && target.path === path;
}

/** The class in progress (or about to start, see `leadMinutes`) that belongs to the notebook at `path`, else null. */
export function lectureClassFor(
	tt: Timetable, path: string | null | undefined, notebooks: readonly NotebookRef[], root: string, now: Date, leadMinutes = 0,
): LectureClass | null {
	if (!path) return null;
	const entry = classesAt(tt, now, leadMinutes).find((e) => classCoversNotebook(e, path, notebooks, root));
	return entry ? lectureClassOf(entry, now) : null;
}

/** A lecture mode that is on. `endsAt` is null for one the user switched on with no class in progress: it stays until switched off. */
export interface ActiveLecture {
	key: string | null;
	endsAt: number | null;
	/** Started by the user (command or button), not by the rule: it survives the setting being turned off. */
	manual: boolean;
}

export interface ModeInput {
	setting: LectureModeSetting;
	now: number;
	/** The class in progress for this notebook, or null. */
	match: LectureClass | null;
	active: ActiveLecture | null;
	/** The class the banner is currently asking about, or null. */
	asking: LectureClass | null;
	/** Occurrences the user turned down or left: never offered or entered again. */
	declined: ReadonlySet<string>;
	/** A pen is on the screen (or just was): nothing changes under the pen. */
	busy: boolean;
}

export type ModeStep =
	| { kind: "none" }
	| { kind: "enter"; cls: LectureClass }
	| { kind: "ask"; cls: LectureClass }
	| { kind: "unask" }
	| { kind: "leave" };

/**
 * What to do now. Rules:
 * - A lecture mode on leaves when its class is over, or when the rule that started it is switched off. Never while writing:
 *   it waits for the pause.
 * - A banner for a class that is no longer the one in progress (or the setting turned off) is withdrawn.
 * - With a class in progress for this notebook that was not turned down: `auto` enters, `ask` asks. Neither starts while writing.
 */
export function stepLectureMode(i: ModeInput): ModeStep {
	if (i.active) {
		const over = i.active.endsAt !== null && i.now >= i.active.endsAt;
		const ruleOff = !i.active.manual && i.setting === "off";
		return (over || ruleOff) && !i.busy ? { kind: "leave" } : { kind: "none" };
	}
	if (i.asking) {
		const stale = i.setting !== "ask" || !i.match || i.match.key !== i.asking.key || i.declined.has(i.asking.key);
		return stale ? { kind: "unask" } : { kind: "none" };
	}
	if (i.setting === "off" || !i.match || i.declined.has(i.match.key) || i.busy) return { kind: "none" };
	return i.setting === "auto" ? { kind: "enter", cls: i.match } : { kind: "ask", cls: i.match };
}
