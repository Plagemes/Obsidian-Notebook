/**
 * Automatic snapshot at the end of a lecture (0.19, roadmap 222): pure decisions and names. No Obsidian imports.
 * The vault side is `lectureSnapshot` in src/integration/history-service.ts.
 *
 * A lecture snapshot is an ordinary version-history snapshot (same folder, same text) whose file name carries the
 * `-lecture` suffix: `<YYYYMMDD-HHmm>-lecture.snapshot`. The suffix is what marks it as the plugin's own automatic lecture
 * snapshot, so retention only ever prunes those, and the history list can filter them. The course name is kept in a small
 * lenient sidecar next to them (`lectures.json`), read tolerantly and never overwritten when unreadable.
 */
import { parseSnapshotName, snapshotStamp, SNAPSHOT_EXTENSION, sortSnapshots, type SnapshotName } from "./history";

export const LECTURE_SNAPSHOT_KEEP_DEFAULT = 20;
export const LECTURE_SNAPSHOT_KEEP_MAX = 100;
/** Sidecar with the course of each lecture snapshot, in the notebook's history folder. */
export const LECTURE_LABELS_FILE = "lectures.json";

export function lectureSnapshotFileName(d: Date): string {
	return `${snapshotStamp(d)}-lecture.${SNAPSHOT_EXTENSION}`;
}

/** True for a snapshot file this feature wrote. */
export function isLectureSnapshotName(name: string): boolean {
	return parseSnapshotName(name) !== null && name.endsWith(`-lecture.${SNAPSHOT_EXTENSION}`);
}

/** Lecture snapshots in a listing, newest first. */
export function lectureSnapshots(names: readonly string[]): SnapshotName[] {
	return sortSnapshots(names).filter((s) => isLectureSnapshotName(s.name));
}

/** Names of the lecture snapshots to trash so that only the newest `keep` remain. Never lists any other snapshot. */
export function lectureSnapshotsToPrune(names: readonly string[], keep: number): string[] {
	const n = Math.max(1, Math.floor(Number.isFinite(keep) ? keep : LECTURE_SNAPSHOT_KEEP_DEFAULT));
	return lectureSnapshots(names).slice(n).map((s) => s.name);
}

/** Names of the snapshots the ordinary (interval) retention may prune: every one except the lecture snapshots. */
export function ordinarySnapshotNames(names: readonly string[]): string[] {
	return names.filter((n) => !isLectureSnapshotName(n));
}

/**
 * A cheap content fingerprint of a notebook text that ignores `modifiedAt` (a save without a change must not look like
 * a change). FNV-1a over the text with every `"modifiedAt":"…"` removed, plus the length.
 */
export function contentFingerprint(json: string): string {
	const text = json.replace(/"modifiedAt"\s*:\s*"[^"]*"/g, "");
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${h.toString(16)}-${text.length}`;
}

export type LectureSnapshotSkip = "off" | "nothing-written" | "not-saved" | "unchanged" | "exists";

export interface LectureSnapshotInput {
	/** The setting. */
	enabled: boolean;
	/** The user wrote (or added the lecture page) during the lecture since the last snapshot. */
	wrote: boolean;
	/** The flush finished and the view holds no unsaved state. */
	saved: boolean;
	/** Fingerprint of the saved file's text. */
	fingerprint: string;
	/** Fingerprint of the newest snapshot of this notebook (any kind), or null when there is none. */
	latestFingerprint: string | null;
	/** A snapshot file of the same name (same minute) is already there. */
	nameTaken: boolean;
}

/** Whether a lecture snapshot is taken now; the reason when it is not. */
export function decideLectureSnapshot(i: LectureSnapshotInput): { take: true } | { take: false; why: LectureSnapshotSkip } {
	if (!i.enabled) return { take: false, why: "off" };
	if (!i.wrote) return { take: false, why: "nothing-written" };
	if (!i.saved) return { take: false, why: "not-saved" };
	if (i.latestFingerprint !== null && i.latestFingerprint === i.fingerprint) return { take: false, why: "unchanged" };
	if (i.nameTaken) return { take: false, why: "exists" };
	return { take: true };
}

/** Plain-text course for the label: one line, bounded. */
export function cleanCourse(course: string): string {
	return course.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The label parts the UI composes into "Lecture <course> <date> <hh:mm>". */
export function lectureLabelParts(date: Date): { date: string; time: string } {
	const p = (n: number, w = 2): string => String(n).padStart(w, "0");
	return { date: `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1)}-${p(date.getDate())}`, time: `${p(date.getHours())}:${p(date.getMinutes())}` };
}

// --- the sidecar: course by snapshot file name, read leniently ---

export type LectureLabels = Record<string, { course?: string; [key: string]: unknown }>;

/** The sidecar text as an object, or null when it is not a readable object (then it is never rewritten). Empty text reads as empty. */
export function readLectureLabels(text: string | null): LectureLabels | null {
	if (text === null || text.trim() === "") return {};
	try {
		const v: unknown = JSON.parse(text);
		if (!v || typeof v !== "object" || Array.isArray(v)) return null;
		return v as LectureLabels;
	} catch {
		return null;
	}
}

/** Course recorded for a snapshot name, or null. */
export function courseOf(labels: LectureLabels | null, name: string): string | null {
	const c = labels?.[name]?.course;
	return typeof c === "string" && c.trim() !== "" ? c : null;
}

/** The sidecar with `name` added and the entries of snapshots that no longer exist dropped; unknown entries are kept. */
export function withLectureLabel(labels: LectureLabels, name: string, course: string, existing: readonly string[]): LectureLabels {
	const alive = new Set(existing);
	const out: LectureLabels = {};
	for (const [k, v] of Object.entries(labels)) {
		if (k === name || alive.has(k) || !isLectureSnapshotName(k)) out[k] = v;
	}
	out[name] = { ...(out[name] ?? {}), course: cleanCourse(course) };
	return out;
}
