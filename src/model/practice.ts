/**
 * "Redo this exercise" (roadmap #303): practice copies of a page, the link between a copy and the page it came from,
 * the attempts of an exercise and the timer. Pure: no 'obsidian', no DOM.
 *
 * No format change. A practice copy is an ordinary page: its tags `practice` and `attempt/<n>` mark it (and survive
 * moving it to another notebook); the link to the original lives in sidecar files, one per device,
 * `<notebooks folder>/_meta/practice-<device>.json` (storage/practice-store.ts), keyed by the practice page's id: a device
 * only writes its own file, so two devices never write the same file, and reading merges every file (plus the old shared
 * `practice.json` of earlier versions, which is still read and never written again). The files are written only by explicit
 * actions (*Redo this exercise*, the timer's *Stop*).
 *
 * What is hidden is described by a `HideSpec`: no criterion = all the ink; otherwise a stroke is hidden when it matches
 * every criterion given (its colour is one of `colors`, its tool one of `tools`, its id one of `strokes`: the lasso
 * selection). Text boxes and images are never hidden: they are the exercise.
 */
import { isResolvable } from "./markers";
import { duplicatePage } from "./pages";
import { normalizePageTags } from "./page-tags";
import { TOOLS, type Page, type Stroke, type Tool } from "./types";

export const PRACTICE_FORMAT = "obsidian-notebook-practice";
export const PRACTICE_VERSION = 1;
export const PRACTICE_TAG = "practice";
export const ATTEMPT_TAG_PREFIX = "attempt/";
/** Name of the notebook that collects practice copies when the target is "an exercises notebook". */
export const DEFAULT_EXERCISES_NAME = "Exercises";
/** Most stroke ids one record keeps for a region; a bigger selection is refused by the dialog (it would hide a different set). */
export const MAX_REGION_STROKES = 4000;

// --- what to hide ---

export interface HideSpec {
	/** `#rrggbb`, lower case. */
	colors?: string[];
	tools?: Tool[];
	/** Ids of the strokes (a lasso selection) in the page they were chosen on. */
	strokes?: string[];
}

const COLOR_RE = /^#[0-9a-f]{6}$/;

/** A spec with only valid, distinct, sorted-as-given entries; criteria that end up empty are left out (so they cannot hide nothing by accident). */
export function normalizeHideSpec(raw: unknown): HideSpec {
	const out: HideSpec = {};
	if (typeof raw !== "object" || raw === null) return out;
	const r = raw as Record<string, unknown>;
	if (Array.isArray(r.colors)) {
		const colors = [...new Set(r.colors.filter((c): c is string => typeof c === "string").map((c) => c.toLowerCase()).filter((c) => COLOR_RE.test(c)))];
		if (colors.length > 0) out.colors = colors;
	}
	if (Array.isArray(r.tools)) {
		const tools = [...new Set(r.tools.filter((x): x is Tool => typeof x === "string" && (TOOLS as readonly string[]).includes(x)))];
		if (tools.length > 0) out.tools = tools;
	}
	if (Array.isArray(r.strokes)) {
		const ids = [...new Set(r.strokes.filter((s): s is string => typeof s === "string" && s !== ""))].slice(0, MAX_REGION_STROKES);
		if (ids.length > 0) out.strokes = ids;
	}
	return out;
}

/** No criterion: every stroke is hidden. */
export function hidesAll(spec: HideSpec): boolean {
	return !spec.colors?.length && !spec.tools?.length && !spec.strokes?.length;
}

export function strokeMatches(stroke: Stroke, spec: HideSpec, ids: ReadonlySet<string> | null = null): boolean {
	if (spec.colors?.length && !spec.colors.includes(stroke.color.toLowerCase())) return false;
	if (spec.tools?.length && !spec.tools.includes(stroke.tool)) return false;
	if (spec.strokes?.length && !(ids ?? new Set(spec.strokes)).has(stroke.id)) return false;
	return true;
}

/** The strokes the spec hides and the ones it leaves, both in drawing order. */
export function splitInk(strokes: readonly Stroke[], spec: HideSpec): { hidden: Stroke[]; kept: Stroke[] } {
	const ids = spec.strokes?.length ? new Set(spec.strokes) : null;
	const hidden: Stroke[] = [];
	const kept: Stroke[] = [];
	for (const s of strokes) (strokeMatches(s, spec, ids) ? hidden : kept).push(s);
	return { hidden, kept };
}

/** Colours used by the strokes with how many strokes use each, most used first (ties by colour). */
export function inkColours(strokes: readonly Stroke[]): Array<{ color: string; count: number }> {
	const counts = new Map<string, number>();
	for (const s of strokes) {
		const c = s.color.toLowerCase();
		counts.set(c, (counts.get(c) ?? 0) + 1);
	}
	return [...counts].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count || a.color.localeCompare(b.color));
}

/** Tools used by the strokes with how many strokes use each, in the order of `TOOLS`. */
export function inkTools(strokes: readonly Stroke[]): Array<{ tool: Tool; count: number }> {
	return TOOLS.map((tool) => ({ tool, count: strokes.filter((s) => s.tool === tool).length })).filter((x) => x.count > 0);
}

// --- tags ---

export function attemptTag(n: number): string {
	return `${ATTEMPT_TAG_PREFIX}${n}`;
}

export function isPracticeTag(tag: string): boolean {
	const key = tag.toLowerCase();
	return key === PRACTICE_TAG || /^attempt\/\d+$/.test(key);
}

/** Attempt number written in a page's tags, or null. */
export function attemptFromTags(tags: readonly string[] | undefined): number | null {
	for (const tag of tags ?? []) {
		const m = /^attempt\/(\d+)$/i.exec(tag);
		if (m) return Number(m[1]);
	}
	return null;
}

export function hasPracticeTag(tags: readonly string[] | undefined): boolean {
	return (tags ?? []).some((t) => t.toLowerCase() === PRACTICE_TAG);
}

/** `tags` without any practice marker, then `practice` and `attempt/<n>` (so a copy of a copy never piles up markers). */
export function practiceTags(tags: readonly string[] | undefined, n: number): string[] {
	const rest = (tags ?? []).filter((t) => !isPracticeTag(t));
	return normalizePageTags([...rest, PRACTICE_TAG, attemptTag(n)]) ?? [PRACTICE_TAG, attemptTag(n)];
}

// --- the copy ---

export interface PracticeCopy {
	page: Page;
	/** Strokes of the original that the copy does not have. */
	hidden: number;
	/** Gap, question and homework markers of the original that the copy leaves out. */
	markers: number;
}

/**
 * The practice copy of `original`: a duplicate (new page, stroke and element ids; size, paper, background, margins,
 * text boxes and images as they are) without the strokes `spec` hides, tagged `practice` and `attempt/<n>`. Its bookmark
 * is not copied (bookmarks belong to the original's id). v8: gap, question and homework markers are left out too: they are
 * open items of the original (a homework task, a question for the lecturer), and a copy of them on every attempt would
 * repeat the task in the companion note and the open-items count. Importance markers and boxes stay: they are part of
 * the exercise.
 */
export function buildPracticePage(original: Page, spec: HideSpec, attempt: number): PracticeCopy {
	const copy = duplicatePage(original);
	const ids = spec.strokes?.length ? new Set(spec.strokes) : null;
	// duplicatePage keeps the order, so the i-th stroke of the copy is the i-th of the original.
	const keep = original.strokes.map((s) => !strokeMatches(s, spec, ids));
	const kept = copy.strokes.filter((_, i) => keep[i]);
	const hidden = copy.strokes.length - kept.length;
	copy.strokes = kept;
	copy.tags = practiceTags(original.tags, attempt);
	const elements = (copy.elements ?? []).filter((el) => !(el.type === "marker" && isResolvable(el.kind)));
	const markers = (copy.elements?.length ?? 0) - elements.length;
	if (elements.length > 0) copy.elements = elements;
	else delete copy.elements;
	return { page: copy, hidden, markers };
}

/** What the peek shows over a practice copy: the strokes of the original that the spec hides. */
export function peekStrokes(original: Page, spec: HideSpec): Stroke[] {
	return splitInk(original.strokes, spec).hidden;
}

// --- records ---

/** A page of a notebook, by ids (a file can move or be renamed; `path` is only a hint). */
export interface PageRef {
	/** Document id of the notebook. */
	doc: string;
	page: string;
	path?: string;
}

export interface AttemptRecord {
	practice: PageRef;
	original: PageRef;
	/** 1-based, per original. */
	n: number;
	/** When the copy was made (ISO time). */
	at: string;
	hide: HideSpec;
	/** Time spent, from the timer; absent = never timed. */
	seconds?: number;
}

export interface PracticeData {
	version: number;
	attempts: AttemptRecord[];
	/** Entries this version does not understand: kept and written back as they were. */
	unknown: unknown[];
	/**
	 * Per-device files: practice pages this device removed, so that a record still held by another device's file or by the
	 * old shared file stays removed. Written only when not empty.
	 */
	removed?: Array<{ page: string; at: string }>;
}

export type PracticeParse =
	| { ok: true; data: PracticeData }
	| { ok: false; reason: "json" | "format" | "future" | "empty"; message: string };

export type PracticeOp =
	| { type: "add"; record: AttemptRecord }
	/** Adds to the time already stored for the attempt (so two devices timing the same attempt add up). */
	| { type: "addSeconds"; practicePage: string; seconds: number }
	| { type: "remove"; practicePage: string };

export function emptyPractice(): PracticeData {
	return { version: PRACTICE_VERSION, attempts: [], unknown: [] };
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readRef(v: unknown): PageRef | null {
	if (!isObject(v)) return null;
	if (typeof v.doc !== "string" || v.doc === "" || typeof v.page !== "string" || v.page === "") return null;
	if (v.path !== undefined && typeof v.path !== "string") return null;
	const ref: PageRef = { doc: v.doc, page: v.page };
	if (typeof v.path === "string" && v.path !== "") ref.path = v.path;
	return ref;
}

function readRecord(v: unknown): AttemptRecord | null {
	if (!isObject(v)) return null;
	const practice = readRef(v.practice);
	const original = readRef(v.original);
	if (!practice || !original) return null;
	if (typeof v.n !== "number" || !Number.isInteger(v.n) || v.n < 1) return null;
	if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
	const rec: AttemptRecord = { practice, original, n: v.n, at: v.at, hide: normalizeHideSpec(v.hide) };
	if (typeof v.seconds === "number" && Number.isFinite(v.seconds) && v.seconds > 0) rec.seconds = Math.round(v.seconds);
	return rec;
}

/** Why an existing empty file is not read as "no practice copies": it may not have finished syncing (same text as device-files.ts). */
export const EMPTY_PRACTICE_MESSAGE = "the file is empty: it may not have finished syncing yet. Nothing was changed; try again once it has synced";

/**
 * Reads the sidecar text. A file that is not ours or comes from a newer version is reported, never "fixed". So is an
 * existing empty one (a missing file is the empty set; the store never asks this for one): a sync app that has not
 * finished downloading it leaves exactly that, and reading it as "nothing" would let the next write drop what it held.
 */
export function parsePractice(text: string): PracticeParse {
	if (text.trim() === "") return { ok: false, reason: "empty", message: EMPTY_PRACTICE_MESSAGE };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, reason: "json", message: `invalid JSON: ${(e as Error).message}` };
	}
	if (!isObject(raw) || raw.format !== PRACTICE_FORMAT || typeof raw.version !== "number" || !Array.isArray(raw.attempts)) {
		return { ok: false, reason: "format", message: "not a Notebook practice file" };
	}
	if (raw.version > PRACTICE_VERSION) {
		return { ok: false, reason: "future", message: `practice file version ${raw.version} is newer than this plugin supports` };
	}
	const data = emptyPractice();
	const seen = new Map<string, number>();
	for (const entry of raw.attempts) {
		const rec = readRecord(entry);
		if (!rec) {
			data.unknown.push(entry);
			continue;
		}
		// One record per practice page: a duplicate (a sync conflict that merged two lines) keeps the later one.
		const at = seen.get(rec.practice.page);
		if (at !== undefined) data.attempts[at] = rec;
		else {
			seen.set(rec.practice.page, data.attempts.length);
			data.attempts.push(rec);
		}
	}
	if (Array.isArray(raw.removed)) {
		const removed = new Map<string, string>();
		for (const r of raw.removed) {
			if (isObject(r) && typeof r.page === "string" && r.page !== "" && typeof r.at === "string") removed.set(r.page, r.at);
			else data.unknown.push(r);
		}
		if (removed.size > 0) data.removed = [...removed].map(([page, at]) => ({ page, at }));
	}
	return { ok: true, data };
}

function hideJson(h: HideSpec): Record<string, unknown> {
	const o: Record<string, unknown> = {};
	if (h.colors?.length) o.colors = h.colors;
	if (h.tools?.length) o.tools = h.tools;
	if (h.strokes?.length) o.strokes = h.strokes;
	return o;
}

function refJson(r: PageRef): Record<string, unknown> {
	return r.path ? { doc: r.doc, page: r.page, path: r.path } : { doc: r.doc, page: r.page };
}

function recordJson(r: AttemptRecord): string {
	const o: Record<string, unknown> = { practice: refJson(r.practice), original: refJson(r.original), n: r.n, at: r.at, hide: hideJson(r.hide) };
	if (r.seconds) o.seconds = r.seconds;
	return JSON.stringify(o);
}

/** Order of the lines: by original, attempt number, time, practice page. The text does not depend on the order things were added in. */
function byOriginal(a: AttemptRecord, b: AttemptRecord): number {
	return a.original.doc.localeCompare(b.original.doc) || a.original.page.localeCompare(b.original.page)
		|| a.n - b.n || a.at.localeCompare(b.at) || a.practice.page.localeCompare(b.practice.page);
}

/** Deterministic text, one attempt per line (small diffs, easy for sync tools to merge). */
export function serializePractice(data: PracticeData): string {
	const lines = [...[...data.attempts].sort(byOriginal).map(recordJson), ...data.unknown.map((u) => JSON.stringify(u))];
	const body = lines.length ? `\n${lines.join(",\n")}\n` : "";
	const removed = [...(data.removed ?? [])].sort((a, b) => a.page.localeCompare(b.page)).map((r) => JSON.stringify({ page: r.page, at: r.at }));
	const tail = removed.length ? `,"removed":[\n${removed.join(",\n")}\n]` : "";
	return `{"format":"${PRACTICE_FORMAT}","version":${PRACTICE_VERSION},"attempts":[${body}]${tail}}\n`;
}

// --- one file per device ---

/**
 * Per-device files (`practice-<device>.json`, storage/practice-store.ts): this device's change applied to its own file.
 * `merged` is what every file says together (mergePractice). Timing an attempt this device's file does not hold yet adds a
 * copy of the record with only the seconds timed here, so that the times of all devices add up; removing one leaves a
 * mark (`removed`) so that the copies other files hold stay removed.
 */
export function applyDeviceOp(own: PracticeData, merged: PracticeData, op: PracticeOp, now: Date = new Date()): PracticeData {
	if (op.type === "add") {
		const next: PracticeData = { ...applyPracticeOp(own, op) };
		const removed = (own.removed ?? []).filter((r) => r.page !== op.record.practice.page);
		delete next.removed;
		if (removed.length > 0) next.removed = removed;
		return next;
	}
	if (op.type === "remove") {
		const next = applyPracticeOp(own, op);
		if (!merged.attempts.some((a) => a.practice.page === op.practicePage) && !own.attempts.some((a) => a.practice.page === op.practicePage)) return next;
		const removed = [...(own.removed ?? []).filter((r) => r.page !== op.practicePage), { page: op.practicePage, at: now.toISOString() }];
		return { ...next, removed };
	}
	if (own.attempts.some((a) => a.practice.page === op.practicePage)) return applyPracticeOp(own, op);
	const seconds = Math.round(op.seconds);
	const record = merged.attempts.find((a) => a.practice.page === op.practicePage);
	if (!(seconds > 0) || !record) return own;
	return { ...own, attempts: [...own.attempts, { ...record, seconds }] };
}

/**
 * Every file together: `files` with this device's first (its record wins when two files describe the same practice page
 * differently) and the old shared `practice.json` last. A page any file marks removed is left out; the seconds of the
 * same attempt in several files add up (each file holds only the time timed on its device).
 */
export function mergePractice(files: readonly PracticeData[]): PracticeData {
	const removed = new Set(files.flatMap((f) => f.removed ?? []).map((r) => r.page));
	const by = new Map<string, AttemptRecord>();
	for (const f of files) {
		for (const a of f.attempts) {
			if (removed.has(a.practice.page)) continue;
			const key = `${a.practice.doc}\u0000${a.practice.page}`;
			const old = by.get(key);
			if (!old) {
				by.set(key, { ...a });
				continue;
			}
			const seconds = (old.seconds ?? 0) + (a.seconds ?? 0);
			if (seconds > 0) old.seconds = seconds;
		}
	}
	return { ...emptyPractice(), attempts: [...by.values()] };
}

export function applyPracticeOp(data: PracticeData, op: PracticeOp): PracticeData {
	if (op.type === "add") {
		const rest = data.attempts.filter((a) => a.practice.page !== op.record.practice.page);
		return { ...data, attempts: [...rest, op.record] };
	}
	if (op.type === "remove") return { ...data, attempts: data.attempts.filter((a) => a.practice.page !== op.practicePage) };
	const seconds = Math.round(op.seconds);
	if (!(seconds > 0)) return data;
	return {
		...data,
		attempts: data.attempts.map((a) => (a.practice.page === op.practicePage ? { ...a, seconds: (a.seconds ?? 0) + seconds } : a)),
	};
}

// --- queries ---

/** The record of a practice page (page ids are unique; `doc` narrows it when a copied notebook repeats an id). */
export function recordOf(data: PracticeData, pageId: string, doc?: string): AttemptRecord | null {
	const hits = data.attempts.filter((a) => a.practice.page === pageId);
	return hits.find((a) => doc === undefined || a.practice.doc === doc) ?? hits[0] ?? null;
}

/** Attempts of one original page, oldest first. */
export function attemptsOf(data: PracticeData, original: { doc?: string; page: string }): AttemptRecord[] {
	return data.attempts
		.filter((a) => a.original.page === original.page && (original.doc === undefined || a.original.doc === original.doc))
		.sort((a, b) => a.n - b.n || a.at.localeCompare(b.at) || a.practice.page.localeCompare(b.practice.page));
}

/** Number for the next attempt of the original: one more than the highest so far. */
export function nextAttemptNumber(data: PracticeData, original: { doc?: string; page: string }): number {
	return attemptsOf(data, original).reduce((m, a) => Math.max(m, a.n), 0) + 1;
}

/** Total time on an original across its attempts, seconds. */
export function totalSeconds(attempts: readonly AttemptRecord[]): number {
	return attempts.reduce((s, a) => s + (a.seconds ?? 0), 0);
}

export function newRecord(args: {
	practice: PageRef; original: PageRef; n: number; hide: HideSpec; now?: Date;
}): AttemptRecord {
	return { practice: args.practice, original: args.original, n: args.n, at: (args.now ?? new Date()).toISOString(), hide: normalizeHideSpec(args.hide) };
}

// --- text ---

const pad = (n: number) => String(n).padStart(2, "0");

/** "1:05" under an hour, "1:02:03" above; whole seconds. */
export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** "2026-10-30 14:05" in local time; the text as is for an unreadable date. */
export function formatAttemptDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whole seconds between two instants (ms), never negative. */
export function elapsedSeconds(startedAtMs: number, nowMs: number): number {
	return Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
}

/** Name of the exercises notebook as configured: trimmed, without characters a file name cannot have; the default when nothing is left. */
export function exercisesName(raw: string | null | undefined): string {
	const cleaned = (raw ?? "").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
	return cleaned || DEFAULT_EXERCISES_NAME;
}

/** Where a copy of a page that is already a practice page goes in its notebook: right after it (the attempts stay together). */
export function insertIndexAfter(pageIndex: number, pageCount: number): number {
	return Math.max(0, Math.min(pageIndex + 1, pageCount));
}

// --- remembered choices ---

export type PracticeTarget = "after" | "notebook";

/** What the dialog remembers on this device between uses. */
export interface PracticePrefs {
	target: PracticeTarget;
	/** Name of the exercises notebook. */
	exercises: string;
}

export const DEFAULT_PRACTICE_PREFS: Readonly<PracticePrefs> = { target: "after", exercises: DEFAULT_EXERCISES_NAME };

/** Stored preferences (anything: a missing key, an older shape) as valid ones. */
export function parsePracticePrefs(raw: unknown): PracticePrefs {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_PRACTICE_PREFS };
	const r = raw as Record<string, unknown>;
	return { target: r.target === "notebook" ? "notebook" : "after", exercises: exercisesName(typeof r.exercises === "string" ? r.exercises : null) };
}
